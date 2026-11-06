// Part 9: the Marketing 351 Faculty — one private specialist behind the University Hub that works in
// both directions:
//   * students ask questions:       Student → Hub → Professor → Hub → Student (normal chat over A2A)
//   * the professor posts lessons:  Professor → Hub → Student (a NEW A2A interaction the professor starts)
//
// Answers come from the course pack (src/course-pack.js, its editable answer skills) and, for a question
// about a delivered lesson, that lesson (src/professor-model.js). Posting a lesson happens only through the
// authoring API below, which the Faculty view calls when the professor presses “Post lesson”. The outbox
// is persisted (PROFESSOR_OUTBOX_FILE, default data/professor-outbox.json); every post carries a stable
// operation id so retries and double-clicks never make a second lesson.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { createSkillService } from './agent-settings.js';
import { loadSpecialistConfig } from './config.js';
import { createHubLink } from './hub-link.js';
import { LlmError, apiHost, keyEnvName, useModel } from './llm.js';
import { COURSE, PROFESSOR_DEFAULT_SKILLS, SEED_LESSONS } from './course-pack.js';
import { PROFESSOR_MODE, classifyPost, interpretProfessor, professorReply, professorStatus, readRosterQuery, tagsIn } from './professor-model.js';
import { datesIn } from './a2ui-catalog.js';
import { slotsIn } from './meeting-times.js';
import { createJsonStore } from './json-store.js';
import { AUDIENCE, ID, LESSON_PUBLISH_MEDIA_TYPE, LESSON_STATUS_MEDIA_TYPE, contentHash, validQuizNotice, validateLesson } from './lessons.js';
import { answersCancelOffer, cancellationText, checkClassPost, classDetailsOf, isThanks, privateLeaveWords, rearmStaff, tellGoesToCard, resetStaff, staffAction, staffConversation, staffHolding, staffTurn, staffView } from './professor-staff.js';
import { cardValues, ROSTER_POST_FAILED_TEXT, ROSTER_UNAVAILABLE_CODE } from './staff.js';
import { ROSTER_GONE, ROSTER_QUESTION_TEXT, TELL_DROPPED, asksAboutRoster, asksRoster, asksRosterExport, asksRosterQuestion, createRosterDesk, dropsTell, notInClassText, notifyEveryone, notifyIsNew, resolveTags, rosterFact, rosterFilter, tagFor, tellText, whichStudentText } from './professor-roster.js';
import { createCanvasLink } from './professor-canvas.js';
import { createQuizDesk, chipTopicOf } from './professor-quiz.js';
import { validExisting } from './quiz-rules.js';
import { topicFromWords, countFromWords, coveredText } from './course-schedule.js';
import { TIMEOUTS } from './timeouts.js';
import { deliveredText } from './delivery-text.js';
import { nowFn } from './test-clock.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const CONFIG = loadSpecialistConfig('professor');
useModel(CONFIG.model); // the Professor's own model and key variable
let hubLink = null;
let skillService = null;
const RULES = { answer: { knowledge: 'required' } };

const log = (...args) => console.log('[Marketing 351 Faculty]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'professor', type, runId, at: new Date().toISOString(), data });
const textOf = (message) => message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');
const textPart = (value) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });

// Outbox: lessons the professor posted (every revision kept) and post operations (for dedupe).
// Also the professor's chat with this console (Faculty view), and its operations (for dedupe).
// Also meeting offers and their bookings, and a meeting waiting for the professor's times.
const outbox = createJsonStore(process.env.PROFESSOR_OUTBOX_FILE ?? 'data/professor-outbox.json', { lessons: {}, operations: {}, chat: [], chatOps: {}, meetings: {}, pendingMeeting: null });
const lessonKey = (lessonId, revision) => `${lessonId}#${revision}`;
const recent = new Map(); // contextId → last few { question, answer }

// ---- answering students ------------------------------------------------------------------------------
const policy = () => ({ skills: skillService.policy().skills.filter((s) => s.kind === 'answer') });
// What this professor posted to this (Hub-verified) student, newest first, latest revision of each — so
// a question like "can I hand in the homework late?" is answered from its own message even when the
// student didn't open it with "Ask about this message".
const postedTo = (student) => (student ? Object.values(outbox.get().lessons)
  .filter((l) => l.recipients?.includes(student))
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.revision - a.revision)
  .filter((l, i, all) => all.findIndex((x) => x.lessonId === l.lessonId) === i)
  .slice(0, 5) : []);
const NEEDS_PROFESSOR_TEXT = `I’ve passed this on to ${COURSE.professorName}, who will get back to you.`;
// Asking for the professor with nothing else: “ask the professor”, “please ask Dr. Dabirian”, “Dabirian”.
const PROF = `(?:the\\s+|my\\s+)?(?:professor|prof\\.?|faculty(?:\\s+member)?|instructor|dr\\.?|doctor|${COURSE.professorName.split(/\s+/).at(-1)})(?:\\s+${COURSE.professorName.split(/\s+/).at(-1)})?`;
const ASK_PROFESSOR = new RegExp(`^\\s*(?:(?:please|can you|could you|i(?:['’]d| would) like to|i want to|let['’]s)\\s+)*(?:(?:ask|tell|check with|talk to|speak to|(?:pass|send|forward) (?:it|this|that|the question) (?:on )?to)\\s+)?${PROF}\\s*[.!?]*\\s*$`, 'i');
const NOT_PASSED_TEXT = `I couldn’t pass this on to ${COURSE.professorName} because the university couldn’t verify your request.`;
async function handleChat(ctx, bus, runId) {
  const incoming = ctx.userMessage;
  const question = textOf(incoming).slice(0, 2000);
  emitViz('message_received', runId, { messageId: incoming.messageId, contextId: ctx.contextId, text: question });
  // The lesson context comes from the Hub's routing (its delivery record), and only for the signed student
  // that lesson was delivered to.
  const student = hubLink.verifiedStudent(incoming.metadata, ctx.contextId);
  const stored = incoming.metadata?.lessonId ? outbox.get().lessons[lessonKey(incoming.metadata.lessonId, incoming.metadata.lessonRevision)] : null;
  const lesson = stored && stored.recipients?.includes(student) ? stored : null;
  const metadata = { ...(runId ? { runId } : {}), agentId: 'professor' };
  // A reply to a post (the Hub attached it from its delivery record) is part of the professor's chat. Who
  // answers depends on who wrote the post: the professor's own MESSAGE → the professor, in person (no
  // model; it waits in their chat); the assistant's message → the assistant, on the professor's behalf;
  // a lesson → answered from the lesson, as before. The professor sees every one of these exchanges.
  const author = lesson?.author ?? 'professor';
  const about = lesson ? { lessonId: lesson.lessonId, revision: lesson.revision, kind: lesson.kind, title: lesson.title } : null;
  // A time picked from a meeting offer (the Hub passes the slot only for this student's own offer).
  if (lesson?.meeting && typeof incoming.metadata?.meetingSlot === 'string') {
    const r = bookSlot(lesson.meeting.meetingId, incoming.metadata.meetingSlot, student);
    recordReply(incoming.messageId, { studentId: student, text: question, about, relayed: false }, { text: r.text, model: null, needsProfessor: r.needsProfessor, onBehalf: true, meeting: { status: r.status, label: r.slot?.label ?? null } });
    emitViz('meeting_choice', runId, { meetingId: lesson.meeting.meetingId, slotId: incoming.metadata.meetingSlot, status: r.status });
    metadata.professor = { name: COURSE.professorName, outcome: 'meeting', onBehalf: true, mode: PROFESSOR_MODE, model: null, usage: null, lessonId: lesson.lessonId, topics: [], meeting: { meetingId: lesson.meeting.meetingId, status: r.status, slotId: r.slot?.slotId ?? null } };
    return publishReply(ctx, bus, runId, incoming, r.text, metadata);
  }
  if (lesson && lesson.kind === 'message' && author === 'professor') {
    recordReply(incoming.messageId, { studentId: student, text: question, about, relayed: true });
    emitViz('student_reply', runId, { lessonId: lesson.lessonId, relayed: true });
    const text = `${COURSE.professorName} will get back to you.`;
    metadata.professor = { name: COURSE.professorName, outcome: 'relayed', mode: PROFESSOR_MODE, model: null, usage: null, lessonId: lesson.lessonId, topics: [] };
    return publishReply(ctx, bus, runId, incoming, text, metadata);
  }
  // “ask the professor” / “ask Dr. Dabirian” / just “Dabirian”: the student means the question they asked
  // before. Done in code (no model): that earlier question goes to the professor's chat.
  if (ASK_PROFESSOR.test(question)) {
    // Earlier hand-over requests (“ask the professor”, “Dabirian”) are never the question to pass on: skip them.
    const earlier = (recent.get(ctx.contextId) ?? []).findLast((t) => !t.handoverRequest);
    if (!earlier) return publishReply(ctx, bus, runId, incoming, `What would you like to ask ${COURSE.professorName}? Tell me your question and I’ll pass it on.`, { ...metadata, professor: { name: COURSE.professorName, outcome: 'clarify', mode: PROFESSOR_MODE, model: null, usage: null, lessonId: null, topics: [] } }, question, { handoverRequest: true });
    const handOver = Boolean(student);
    const already = handOver && earlier.handedOver;
    const text = !handOver ? NOT_PASSED_TEXT : already ? `I’ve already passed “${earlier.question.slice(0, 120)}” on to ${COURSE.professorName}, who will get back to you.` : NEEDS_PROFESSOR_TEXT;
    metadata.professor = { name: COURSE.professorName, outcome: handOver ? 'needs_professor' : 'out_of_scope', mode: PROFESSOR_MODE, model: null, usage: null, lessonId: lesson?.lessonId ?? null, topics: [], ...(handOver ? { onBehalf: true } : {}) };
    if (handOver && !already) {
      earlier.handedOver = true; // the real question, so a later “Dabirian” finds it already passed on
      recordReply(incoming.messageId, { studentId: student, text: earlier.question, about, relayed: true }, { text, model: null, needsProfessor: true, onBehalf: false });
      emitViz('student_reply', runId, { lessonId: lesson?.lessonId ?? null, relayed: false, needsProfessor: true });
    }
    return publishReply(ctx, bus, runId, incoming, text, metadata, question, { handoverRequest: true });
  }
  const onBehalf = Boolean(lesson && lesson.kind === 'message' && author === 'assistant');
  let text;
  try {
    const r = await professorReply({ question, policy: policy(), lesson, posts: lesson ? [] : postedTo(student), recent: recent.get(ctx.contextId) ?? [], onBehalf, emit: (type, data) => emitViz(type, runId, data) });
    // Not answerable here → the professor's chat. The student is told so in fixed words (on the professor's
    // behalf the assistant's own sentence already says it was passed on).
    // Only a student the Hub signed can be put in the professor's chat (an unsigned caller isn't anyone).
    const handOver = r.kind === 'needs_professor' && Boolean(student);
    text = handOver && !onBehalf ? NEEDS_PROFESSOR_TEXT : r.kind === 'needs_professor' && !student ? NOT_PASSED_TEXT : r.text;
    // A hand-over is the course assistant speaking for the professor (the chat labels it so).
    metadata.professor = { name: COURSE.professorName, outcome: r.kind, mode: PROFESSOR_MODE, model: r.model, usage: r.usage, lessonId: lesson?.lessonId ?? null, topics: r.topicIds, ...(onBehalf || handOver ? { onBehalf: true } : {}) };
    if (lesson || handOver) {
      recordReply(incoming.messageId, { studentId: student, text: question, about, relayed: handOver && !onBehalf }, { text, model: r.model, needsProfessor: handOver, onBehalf });
      emitViz('student_reply', runId, { lessonId: lesson?.lessonId ?? null, relayed: false, needsProfessor: handOver });
    }
  } catch (err) {
    const failure = err instanceof LlmError ? err : new LlmError('internal_error');
    text = `The Marketing 351 Faculty could not answer: ${failure.message}`;
    metadata.serviceError = { code: failure.code, message: failure.message, requestId: failure.requestId };
    // The professor still sees what the student wrote — and that nobody answered it.
    if (lesson) recordReply(incoming.messageId, { studentId: student, text: question, about, relayed: false }, { text: `Not answered: ${failure.message}`, model: null, needsProfessor: true, onBehalf, failed: true });
  }
  return publishReply(ctx, bus, runId, incoming, text, metadata, question, { handedOver: metadata.professor?.outcome === 'needs_professor' && metadata.professor?.onBehalf === true });
}
// A student's reply in the professor's chat (and the assistant's answer to it, when it gave one). Keyed by
// the incoming message id, so a repeated delivery of the same request is recorded once.
function recordReply(messageId, student, answer = null) {
  if (!student?.studentId) return; // never an entry without a Hub-verified student
  const at = new Date().toISOString();
  outbox.update((s) => {
    if (s.chat.some((m) => m.id === `${messageId}:s`)) return;
    s.chat.push({ id: `${messageId}:s`, role: 'student', at, ...student });
    if (answer) s.chat.push({ id: `${messageId}:r`, role: 'assistant', at, to: student.studentId, about: student.about, ...answer, action: 'answer_student' });
    s.chat = s.chat.slice(-200);
  });
}
// A hand-over = a student's message (`<id>:s`) whose assistant entry (`<id>:r`) has needsProfessor. The
// professor's reply marks it answered (answeredAt on the assistant entry); never another student's.
function markAnswered(s, studentId, entryId, at) {
  const waiting = (m) => m.role === 'assistant' && m.needsProfessor && !m.answeredAt && m.to === studentId;
  const chosen = entryId && s.chat.find((m) => m.id === entryId.replace(/:s$/, ':r') && waiting(m));
  const target = chosen ?? s.chat.findLast(waiting);
  if (target) target.answeredAt = at;
}
// One booking per student per meeting, one student per time: a synchronous check-and-set (no await
// between the check and the write). A repeat of the same choice returns the same booking.
function bookSlot(meetingId, slotId, student) {
  let r;
  const at = new Date().toISOString();
  outbox.update((s) => {
    const m = s.meetings?.[meetingId];
    const slot = m?.slots.find((x) => x.slotId === slotId);
    if (!m || !slot) { r = { status: 'unknown', text: `That isn’t one of the times ${COURSE.professorName} offered.` }; return; }
    const mine = m.byStudent[student];
    if (mine) {
      const booked = m.slots.find((x) => x.slotId === mine);
      r = mine === slotId ? { status: 'booked', slot: booked, duplicate: true } : { status: 'already', slot: booked, text: `You’re already booked for ${booked.label}. If you need a different time, reply here and ${COURSE.professorName} will sort it out.` };
      return;
    }
    if (m.bookings[slotId]) {
      const open = m.slots.filter((x) => !m.bookings[x.slotId]);
      r = { status: 'taken', slot, needsProfessor: !open.length, text: open.length ? `Sorry — ${slot.label} was just taken. Still open: ${open.map((x) => x.label).join('; ')}.` : `Sorry — ${slot.label} was just taken, and every offered time is gone. I’ve let ${COURSE.professorName} know.` };
      return;
    }
    m.bookings[slotId] = { studentId: student, at };
    m.byStudent[student] = slotId;
    r = { status: 'booked', slot };
  });
  if (r.status === 'booked') r.text = `Booked: ${r.slot.label} (Pacific Time) with ${COURSE.professorName}. Demo booking — no calendar invite is sent.`;
  return { needsProfessor: false, ...r };
}
function publishReply(ctx, bus, runId, incoming, text, metadata, question = null, extra = {}) {
  const message = { messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [textPart(text)], metadata, extensions: [], referenceTaskIds: [] };
  bus.publish(AgentEvent.message(message));
  bus.finished();
  emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, text, professor: metadata.professor });
  if (question !== null) recent.set(ctx.contextId, [...(recent.get(ctx.contextId) ?? []), { question, answer: text, ...extra }].slice(-4));
}

const executor = {
  async execute(ctx, bus) {
    return handleChat(ctx, bus, ctx.userMessage.metadata?.runId ?? null);
  },
  async cancelTask() {},
};

// ---- posting lessons (Professor → Hub) -----------------------------------------------------------------
// Delivery state as the professor sees it: draft → queued at Hub → delivered to the student's inbox →
// opened in the student's UI; or failed / uncertain with the reason. From the Hub's own records.
async function publish(record) {
  emitViz('lesson_posted', null, { lessonId: record.lessonId, revision: record.revision, operationId: record.operationId, kind: record.kind, audience: record.audience === 'all' ? 'all' : 'one' });
  const ack = await hubLink.sendSigned(LESSON_PUBLISH_MEDIA_TYPE,
    { type: 'lesson_publish', operationId: record.operationId, lessonId: record.lessonId, revision: record.revision, courseId: record.courseId, kind: record.kind, author: record.author ?? 'professor', ...(record.meeting ? { meeting: record.meeting } : {}), ...(record.quiz ? { quiz: record.quiz } : {}), audience: record.audience, title: record.title, text: record.text },
    ['publish', record.operationId, record.lessonId, record.revision, record.courseId, record.kind, record.audience, contentHash(record.title, record.text, record.kind, record.author ?? 'professor', record.meeting ?? null, record.quiz ?? null)],
    { timeoutMs: Number(process.env.PROFESSOR_PUBLISH_TIMEOUT_MS ?? TIMEOUTS.professorPublishMs) }); // > the Hub's roster lookup + delivery (src/timeouts.js)
  // Accepted = the Hub recorded the post and made a delivery per recipient; delivering is then its job.
  const accepted = Array.isArray(ack.deliveries) && ack.deliveries.length > 0;
  outbox.update((s) => {
    const l = s.lessons[lessonKey(record.lessonId, record.revision)];
    Object.assign(l, {
      hubStatus: ack.status, hubReason: ack.reason ?? null, hubAccepted: accepted || Boolean(l.hubAccepted),
      recipients: accepted ? ack.deliveries.map((d) => d.studentId) : l.recipients ?? [], updatedAt: new Date().toISOString(),
    });
  });
  emitViz('lesson_publish_result', null, { lessonId: record.lessonId, revision: record.revision, status: ack.status, reason: ack.reason ?? null, duplicate: Boolean(ack.duplicate), recipients: ack.deliveries?.length ?? 0 });
  return ack;
}

// Every post, newest first, with one delivery per recipient (a post to "all" has one per enrolled student). Student ids
// only: classmates' names never go into /author/state (it is pushed to every page's stream); the Faculty view maps ids to
// names from GET /author/roster (`names`), like the quiz key (owner Ruling 5, final review finding 6).
function postsView(hub) {
  const byPost = new Map();
  for (const d of hub?.deliveries ?? []) byPost.set(`${d.lessonId}#${d.revision}`, [...(byPost.get(`${d.lessonId}#${d.revision}`) ?? []), d]);
  return Object.values(outbox.get().lessons).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((l) => ({
    ...l,
    key: lessonKey(l.lessonId, l.revision),
    meetingState: l.meeting ? l.meeting.slots.map((x) => ({ label: x.label, bookedBy: outbox.get().meetings?.[l.meeting.meetingId]?.bookings[x.slotId]?.studentId ?? null })) : null,
    deliveries: (byPost.get(lessonKey(l.lessonId, l.revision)) ?? []).map((d) => ({ studentId: d.studentId, state: d.state, opened: Boolean(d.openedAt), openedAt: d.openedAt, deliveredAt: d.deliveredAt, lastError: d.lastError, attempts: d.attempts, ...(d.emailed ? { emailed: true } : {}), ...(d.emailFailed ? { emailFailed: true } : {}) })),
  }));
}

const republishing = new Set(); // lessonKey of posts being re-sent right now
function republish(l) {
  const key = lessonKey(l.lessonId, l.revision);
  if (republishing.has(key)) return;
  republishing.add(key);
  publish(l).catch(() => {}).finally(() => republishing.delete(key)); // a reset meanwhile drops the record: nothing to update
}

async function hubView() {
  const nonce = randomUUID();
  const r = await hubLink.sendSigned(LESSON_STATUS_MEDIA_TYPE, { type: 'lesson_status', nonce }, ['status', nonce]).catch(() => null);
  return r?.status === 'ok' ? r : null;
}

// What the faculty member reads when the Hub refused a post. A post to the class that couldn't be addressed (the class
// list wasn't available) gets one plain sentence; nothing technical shows.
function notSentText(r) {
  if (r.body.ack?.reason === ROSTER_UNAVAILABLE_CODE) return ROSTER_POST_FAILED_TEXT;
  return `Nothing was sent: ${r.body.ack?.reason ?? Object.values(r.body.errors ?? {})[0] ?? 'refused'}.`;
}

// ---- posting (shared by the typed API and the chat) -------------------------------------------------------
async function createPost({ operationId, kind = 'lesson', title = '', text, audience, courseId = COURSE.courseId, lessonId = null, source = 'api', verbatim = true, seedId = null, author = 'professor', meeting = null, quiz = null }) {
  if (!validQuizNotice(quiz) || (quiz && kind !== 'message')) return { http: 400, body: { errors: { _form: 'Malformed quiz notice.' } } };
  if (typeof operationId !== 'string' || !ID.test(operationId)) return { http: 400, body: { errors: { _form: 'Missing or malformed operation id.' } } };
  if (typeof audience !== 'string' || !AUDIENCE.test(audience)) return { http: 400, body: { errors: { audience: 'Choose all students or one enrolled student.' } } };
  const v = validateLesson({ kind, title, text });
  if (!v.ok) return { http: 400, body: { errors: v.errors } };
  const prior = outbox.get().operations[operationId];
  if (prior) {
    // A repeat of the same operation: the same post — never a second one. Different content → refused.
    const l = outbox.get().lessons[prior];
    if (l.title !== v.values.title || l.text !== v.values.text || l.kind !== v.values.kind || l.audience !== audience || JSON.stringify(l.quiz ?? null) !== JSON.stringify(quiz ?? null)) return { http: 409, body: { errors: { _form: 'This post was already sent with different content.' } } };
    // The Hub refused it without keeping anything (e.g. the class list wasn't available): sending the SAME operation
    // again is the retry, not a "duplicate" that pretends it went out.
    if (l.hubStatus === 'rejected' && !l.hubAccepted) return postResult(l, await publish(l));
    return { http: 200, body: { lesson: l, duplicate: true } };
  }
  if (lessonId !== null && (typeof lessonId !== 'string' || !ID.test(lessonId))) return { http: 400, body: { errors: { _form: 'Malformed lesson id.' } } };
  const previous = lessonId ? Object.values(outbox.get().lessons).filter((l) => l.lessonId === lessonId) : [];
  if (lessonId && !previous.length) return { http: 404, body: { errors: { _form: 'Unknown lesson to revise.' } } };
  const record = {
    lessonId: lessonId ?? `ls-${randomUUID().slice(0, 12)}`, revision: previous.length + 1, operationId, courseId, kind: v.values.kind, audience,
    title: v.values.title, text: v.values.text, createdAt: new Date().toISOString(), hubStatus: 'sending', hubReason: null, recipients: [], source, verbatim, seedId,
    author: author === 'assistant' ? 'assistant' : 'professor',
    ...(meeting ? { meeting } : {}),
    ...(quiz ? { quiz } : {}),
  };
  outbox.update((s) => {
    s.lessons[lessonKey(record.lessonId, record.revision)] = record;
    s.operations[operationId] = lessonKey(record.lessonId, record.revision);
  });
  return postResult(record, await publish(record));
}
// Review A4: the faculty member's confirmation after a post — real counts from the Hub's ack (src/delivery-text.js), never
// a bare "Sent". null when the Hub didn't confirm any delivery (nothing to count, no claim). `confirmFor`: the one student
// a single-recipient confirmation is about (the Faculty view shows their name; the stored text never names them).
function confirmOf(r, audience) {
  const text = deliveredText(r.body?.ack?.deliveries ?? [], { audience });
  if (!text) return {};
  return { confirm: text, ...(audience !== 'all' && !String(audience).includes(',') ? { confirmFor: audience } : {}) };
}
function postResult(record, ack) {
  const deliveries = (ack.deliveries ?? []).map(({ name: _name, ...d }) => d); // ids only: names reach only the Faculty view's roster fetch
  return { http: ack.status === 'rejected' ? 422 : 200, body: { lesson: outbox.get().lessons[lessonKey(record.lessonId, record.revision)], ack: { status: ack.status, reason: ack.reason ?? null, accepted: deliveries.length > 0, deliveries } } };
}

// ---- Canvas quiz desk (Part 16) -------------------------------------------------------------------------------
// The Faculty agent's own MCP link to the Canvas stand-in. No CANVAS_TOKEN: the link answers not_configured and the
// agent still starts. Without CANVAS_URL it uses the closed port 9, never a real :41247. Drafts and the Canvas card are
// in memory only (Canvas forgets its quizzes on every start); the outbox chat keeps outcome text only.
const CANVAS_URL = process.env.CANVAS_URL ?? 'http://127.0.0.1:9';
const canvasLink = createCanvasLink({ url: CANVAS_URL, token: process.env.CANVAS_TOKEN, emit: (type, runId, data) => emitViz(type, runId, data), timeoutMs: Number(process.env.CANVAS_TIMEOUT_MS ?? TIMEOUTS.professorCanvasCallMs) });
// Part 17: the class roster (CHRS) lives in this process's memory only; the outbox keeps the chat line.
const rosterDesk = createRosterDesk({ hubLink: { sendSigned: (...a) => hubLink.sendSigned(...a) }, conversationId: () => staffConversation(), emit: (type, data) => emitViz(type, null, data), readQuery: readRosterQuery });
// roster: review C15 — after Approve the desk compares Canvas's course list with a FRESH class roster (the roster desk's
// signed CHRS request through the Hub; names stay in memory and reach only the Faculty view).
const quizDesk = createQuizDesk({ canvas: canvasLink, createPost: (a) => createPost({ ...a, source: 'chat', author: 'professor' }), now: nowFn(), emit: (type, runId, data) => emitViz(type, runId, data), classCount: () => rosterDesk.counts()?.count ?? null, roster: () => rosterDesk.names({ operationId: `quiz-roster-${randomUUID().slice(0, 12)}`, fresh: true, purpose: 'membership' }) });

// ---- the professor's chat ---------------------------------------------------------------------------------
// Every decision the model makes is checked here before anything is sent:
//   * a single recipient must be enrolled AND tagged (@sam) or named in the professor's words; a tag the
//     professor wrote wins over the model's choice;
//   * “verbatim” text must really appear in what the professor wrote (otherwise it's labelled as written
//     from the professor's instruction);
//   * no date may appear in the text that the professor didn't write (or that isn't in a course lesson).
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let chatBusy = false;
let resetGeneration = 0; // bumped by a classroom reset, so a chat turn in flight can tell it happened
// The professor talks to students directly: a message without @assistant goes out as written — to the
// tagged student(s), or to the whole class when nobody is tagged — and appears as the professor's own
// message with each student's delivery state (no assistant reply). The model only names it (lesson or
// message, and a title). With @assistant the professor asks the course assistant for help: it decides
// post / answer / clarify and code checks its decision (checkPost) before anything is sent.
const ASSISTANT_TAG = /(^|\s)@assistant\b[\s,:]*/i;
// replyTo: a student id — the professor answering that student's reply (the reply icon in the Professor
// view). It goes to that student only, as the professor's own message. answers: the chat id of the
// student's message being answered; a sent reply marks that hand-over (or else the student's newest
// waiting one) answered.
// formRef + formValues (HR, optional): the open time-off card's current values in the browser; sent to HR
// with a follow-up so what the professor changed on the card isn't lost.
// quizTopic (optional): a topic chip tapped in the Faculty view. It is handled only by the quiz desk, never as a staff
// request or a post, and it ignores replyTo (a chip is never a reply to one student).
async function professorChat({ operationId, text, replyTo: replyToIn = null, answers = null, formRef, formValues, quizTopic = null }) {
  if (typeof operationId !== 'string' || !ID.test(operationId)) return { http: 400, body: { error: 'Missing or malformed operation id.' } };
  const card = cardValues({ formRef, formValues });
  if (card.error) return { http: 400, body: { error: card.error } };
  const said = typeof text === 'string' ? text.trim() : '';
  if (!said) return { http: 400, body: { error: 'Write something first.' } };
  if (quizTopic !== null && (!Number.isInteger(quizTopic) || chipTopicOf(said) !== quizTopic)) return { http: 400, body: { error: 'Malformed topic pick.' } };
  // A chip's text is claimed by the quiz desk whether or not the page sent it structured (a stale chip, a restart, a reply chip).
  const chip = quizTopic ?? chipTopicOf(said);
  const replyTo = chip === null ? replyToIn : null;
  if (said.length > 4000) return { http: 400, body: { error: 'Keep it under 4000 characters.' } };
  const done = outbox.get().chatOps[operationId];
  if (done) return { http: 200, body: { ...done, duplicate: true } }; // a repeated send: the stored outcome
  if (chatBusy) return { http: 409, body: { error: 'Still working on your previous message.' } };
  chatBusy = true;
  try {
    const at = new Date().toISOString();
    const generation = resetGeneration;
    const toAssistant = ASSISTANT_TAG.test(said);
    const hub = await hubView();
    const roster = (hub?.courses?.find((c) => c.courseId === COURSE.courseId)?.enrolled ?? []).map((st) => ({ studentId: st.studentId, name: st.name ?? st.studentId, online: st.online }));
    if (replyTo !== null && !roster.some((x) => x.studentId === replyTo)) return { http: 400, body: { error: 'That student isn’t in this class.' } };
    const reply = toAssistant || chip !== null ? null : replyTo; // "@assistant …" is a request to the assistant, whoever is being replied to
    const ownId = `${operationId}:p`;
    const entry = { id: ownId, role: 'professor', text: said, at, toAssistant, ...(reply ? { replyTo: reply } : {}) };
    outbox.update((s) => { s.chat.push(entry); });
    // Canvas quiz desk (Part 16): runs BEFORE the staff desk for every message of the professor's own (with or without
    // @assistant, even while an HR card is open). A match is answered here: no staff classifier, no HR, no direct post.
    if (!reply || chip !== null) {
      let quiz = null;
      try { quiz = await quizDesk.turn(said, { operationId, ...(chip === null ? {} : { quizTopic: chip }) }); } catch { quiz = { action: 'quiz_error', reply: 'The quiz desk hit an error, so nothing was drafted or sent.' }; }
      if (quiz) return quizAnswer({ operationId, ownId, entry, generation, quiz });
    }
    // HR (staff only): is this a request for the professor himself as staff? (src/professor-staff.js)
    // @assistant messages and replies to one student are never staff turns. While an HR card is open, any
    // other message goes to HR as a follow-up that fills the card — even one that reads like a class message.
    // Its events (incl. the live staff classifier's model call) belong to the staff run the Hub also uses
    // (`staff-<operationId>`), so the UI server relays them and Topology draws the Professor → model hop.
    // Part 17 (CHRS): the roster desk sits between the quiz desk and the staff desk. "Show my roster" asks CHRS (the
    // roster stays in memory); "notify everyone that …" posts the rest to the whole class, after the privacy guard
    // (a statement about himself with a leave word is asked about, never posted). Neither runs for @assistant messages
    // or replies to one student, nor while the staff desk is waiting for an answer (that reply belongs to it).
    let notify = null;
    let tellReply = false;
    let staff;
    const held = staffHolding();
    const free = !toAssistant && !reply && !held.question;
    // A waiting class cancellation offer blocks neither desk: “notify everyone that …” with something to say is its own
    // message (the offer stays open for its yes or no); a bare “notify everyone” / “yes” is the offer's answer (staff desk).
    const offerFree = (n) => !held.offer || (held.offer === 'cancel' && n);
    // Round 2 (R5): while the HR / class / both question waits, a notify-everyone message WITH something to say is a new
    // message (a bare “tell the class” is still read as the answer): handled normally, and the question keeps waiting.
    const notifyWords = !toAssistant && !reply ? notifyEveryone(said) : null;
    const announced = free ? notifyWords : held.question && notifyIsNew(said) ? notifyWords : null;
    const classCheck = (text, heldText = said, opts = {}) => checkClassPost({ text, held: heldText, entryId: ownId, forClass: true, emit: (type, data) => emitViz(type, `staff-${operationId}`, data), ...opts });
    // Roster requests and roster facts (F3: a count, “is X in my class?”, a student's email / ID / major / year), and since
    // round 2 a level / major filter (R4: “who are my seniors?”) and an email / export ask (R3) are read by code and answered
    // from a fresh roster lookup. They run even while the HR / class / both question waits (F4, R5): that question keeps
    // waiting, unchanged, and they never count as its answer. R1: they also run for “@assistant …” (the tag removed), so the
    // assistant's model never answers “how many students are in my class?” from anything else.
    const asked = toAssistant ? said.replace(ASSISTANT_TAG, ' ').trim() : said;
    // Review A5: “yes …” to a waiting cancellation offer is its answer (perhaps with a note for the students), never a roster question.
    const cancelYes = held.offer === 'cancel' && !toAssistant && !reply && (held.noteAsked || /^\s*(?:yes|yeah|yep|sure|ok|okay)\b/i.test(said));
    const rosterOk = !reply && !cancelYes && (toAssistant || offerFree(true));
    const exporting = rosterOk && asksRosterExport(asked);
    const filter = rosterOk && !exporting ? rosterFilter(asked) : null;
    const fact = rosterOk && !exporting && !filter ? rosterFact(asked) : null;
    if (rosterOk && (exporting || filter || fact || asksRoster(asked))) {
      staff = exporting ? await rosterDesk.exportAsk({ operationId, hub })
        : filter ? await rosterDesk.filter({ operationId, hub, filter })
          : fact ? await rosterDesk.fact({ operationId, hub, fact }) : await rosterDesk.request({ operationId, hub });
    } else if (rosterOk && asksRosterQuestion(asked) && !privateLeaveWords(asked)) {
      // Any other question about the roster (owner, 2026-11-05: “anyone not a business major?” was posted to all 25): the
      // model reads it into a query only (never an answer, never a row), code checks and runs it on a fresh lookup. Never
      // posted; a waiting HR / class / both question keeps waiting; an open HR card is not edited.
      staff = await rosterDesk.question({ operationId, hub, question: asked, emitRun: (type, data) => emitViz(type, `prof-${operationId}`, data) });
    } else if (rosterOk && !toAssistant && asksAboutRoster(said) && !privateLeaveWords(said)) {
      // R3: any other question about the roster or “my students” is for the assistant, never a post (and never the HR /
      // class / both question): one plain sentence, nothing sent. A waiting question keeps waiting.
      staff = { action: 'clarify', check: 'roster_question', reply: ROSTER_QUESTION_TEXT, classSafe: true, entries: [{ role: 'assistant', text: ROSTER_QUESTION_TEXT, action: 'clarify' }] };
    } else if (!toAssistant && !reply && (held.question || !held.offer || !/^\s*ok/i.test(said)) && isThanks(said)) {
      // F4: “Thanks” while the held question waits is not its answer (and never counts toward the re-ask): the question keeps waiting.
      // Live run Z24: “Thanks” with nothing waiting is answered too (it was asked “HR, the class, or both?”).
      // Live check 2026-11-05: a plain “Thanks” while an offer waits is thanks too (it was re-asked “Should I post that note
      // to the class? Reply yes or no.”); the offer keeps waiting. Only “ok, thanks” is left to the offer (it may mean yes).
      staff = { action: 'clarify', check: 'ack', reply: "You're welcome.", classSafe: true, entries: [{ role: 'assistant', text: "You're welcome.", action: 'clarify' }] };
    } else if (announced && offerFree(Boolean(announced.rest || announced.about))) {
      notify = announced;
      rosterDesk.clearTell();
      // Only a subject (“… about the midterm review”) is never sent as a fragment, and a bare “notify everyone” has nothing
      // to send: ask what to say (F5: both wait 15 minutes), and his next plain reply goes to the whole class.
      if (notify.about || !notify.rest) { staff = rosterDesk.askTell(notify.about ?? null); notify = null; }
      else staff = await classCheck(notify.rest, said, { keepHeld: Boolean(held.question) }); // the same check a plain class message gets (illness/leave/relative words, the open card, the classifier); a waiting question is kept
      if (staff) notify = null;
      else staff = null; // safe to post: the staff desk is not asked
    } else if (free && offerFree(!answersCancelOffer(said)) && !/^\s*@/.test(said) && rosterDesk.waitingTell() && !tellGoesToCard(said)) {
      // The answer to “What should I tell your class (about X)?”: it goes to the class, not to the staff desk — after the same
      // check a plain class message gets, unless he drops it. With an HR card open, only a clear card edit (“make it Dec 7
      // instead”, hours, an absence name, a leave / illness / relative word) goes to HR (F2: tellGoesToCard; a day or a time
      // alone is not enough) and the question keeps waiting. F6: “About X: <reply>.” unless the reply already names X.
      const about = rosterDesk.waitingTell().about ?? null;
      rosterDesk.clearTell();
      tellReply = { about };
      if (dropsTell(said)) staff = { action: 'clarify', check: 'notify_dropped', reply: TELL_DROPPED, classSafe: true, entries: [{ role: 'assistant', text: TELL_DROPPED, action: 'clarify' }] };
      else {
        notify = { rest: tellText(about, said) };
        staff = await classCheck(notify.rest, notify.rest);
        if (staff) notify = null;
        else staff = null;
      }
    }
    if (staff === undefined) staff = await staffTurn({ operationId, text: said, entryId: ownId, hubLink, bypass: toAssistant || Boolean(reply), card: card.fields, emit: (type, data) => emitViz(type, `staff-${operationId}`, data) });
    // The professor answered “class” to the unsure question: the HELD message goes out as today (a held “notify everyone …” as the class post it was).
    if (staff?.continueWith) { const n = notifyEveryone(staff.continueWith); if (n?.rest) notify = n; }
    const sendText = staff?.continueWith ?? said;
    const target = staff?.continueWith ? staff.entryId : ownId;
    let result;
    let viaAssistant = toAssistant;
    if (staff?.note) result = await postNote({ operationId, text: staff.note, days: staff.days, studentNote: staff.studentNote ?? null });
    else if (staff && !staff.continueWith) result = staff;
    else {
      // The assistant asked "when can Alex come?": the professor's next untagged message with times answers it.
      const waiting = outbox.get().pendingMeeting;
      const times = !staff && !notify && !toAssistant && !reply && waiting && Date.now() - waiting.at < 15 * 60_000 && !/^\s*@/.test(said) ? slotsIn(said) : [];
      viaAssistant = toAssistant || times.length > 0;
      result = times.length ? await offerMeeting({ operationId, audience: waiting.audience, slots: times, roster })
        : toAssistant ? await assistantTurn({ operationId, said, roster, hub }) : notify ? await notifyPost({ operationId, text: notify.rest }) : await directPost({ operationId, said: sendText, roster, to: reply, hub, guard: !staff?.continueWith });
    }
    // The class list wasn't available, so nothing went out: whatever the yes / “class” / reply took off the desk is waiting again.
    if (result.action === 'error' && result.reply === ROSTER_POST_FAILED_TEXT) {
      rearmStaff(staff?.rearm);
      if (tellReply && notify) rosterDesk.rearmTell(tellReply.about);
    }
    const { entries = null, continueWith, entryId, note, notice: _n, classSafe = false, confirm = null, confirmFor = null, ...stored } = result;
    // Review A4: one confirmation entry with the real counts (a single student's is shown with their name on the page).
    const sentEntry = (text) => ({ id: `${operationId}:sent`, role: 'assistant', text, at: new Date().toISOString(), action: 'sent', staff: false, ...(confirmFor ? { sentTo: confirmFor } : {}) });
    // A reply to a pending question that also carried NEW content: the answer was acted on, the new part was not
    // sent (src/professor-staff.js, NOT_SENT) — say so in the chat and keep the professor's message private.
    const notice = staff?.notice ?? null;
    if (notice) stored.notice = notice;
    outbox.update((s) => {
      // A reset while this was worked on cleared the chat: keep the professor's message.
      if (generation !== resetGeneration && !s.chat.some((m) => m.id === ownId)) s.chat.push(entry);
      const own = s.chat.find((m) => m.id === ownId);
      own.toAssistant = viaAssistant;
      if (entries) {
        // A staff turn (HR's reply, the unsure question, the note): each as its own chat entry, text only.
        own.staff = !classSafe; // the roster desk's answers are the professor's own business, not an HR secret
        const now = new Date().toISOString();
        const used = new Set();
        entries.forEach((e, i) => {
          let id = `${operationId}:${e.role === 'hr' ? 'h' : 'a'}`;
          if (used.has(id)) id = `${id}${i}`; // two assistant entries in one turn (a roster fact's sentence, then its card)
          used.add(id);
          s.chat.push({ id, at: now, staff: !classSafe, ...e });
        });
      } else if (!viaAssistant) {
        // A held message the professor chose to send to the class is no longer private (staff: false).
        Object.assign(s.chat.find((m) => m.id === target) ?? own, { postKey: result.post?.key ?? null, problem: result.post ? null : result.reply, ...(staff?.continueWith ? { staff: false } : {}) });
        // Every post (a plain one, “notify everyone”, the held message he chose to send to the class): the real counts.
        if (confirm && result.post) s.chat.push(sentEntry(confirm));
      } else {
        s.chat.push({ id: `${operationId}:a`, role: 'assistant', text: result.reply, at: new Date().toISOString(), action: result.action, postKey: result.post?.key ?? null, model: result.model ?? null, ...(result.topics ? { quizTopics: { topics: result.topics, highlight: result.highlight ?? null } } : {}) });
        if (confirm && result.post) s.chat.push(sentEntry(confirm)); // an @assistant post or a meeting offer: the counts too
      }
      if (notice) {
        own.staff = true;
        s.chat.push({ id: `${operationId}:n`, role: 'assistant', text: notice, at: new Date().toISOString(), action: 'clarify', staff: true });
      }
      if (reply && result.post) markAnswered(s, reply, typeof answers === 'string' ? answers : null, own.at);
      s.chat = s.chat.slice(-200);
      s.chatOps[operationId] = stored;
    });
    emitViz('professor_chat', null, { action: stored.action, check: stored.check ?? null, kind: stored.kind ?? null, viaAssistant });
    return { http: 200, body: stored };
  } finally {
    chatBusy = false;
  }
}

// A quiz turn's answer: the professor's message stays his (addressed to the assistant), and the assistant's
// reply is one chat entry. A drafted quiz carries only the draft id (the questions are fetched by the Faculty view).
function quizAnswer({ operationId, ownId, entry, generation, quiz, extra = {} }) {
  const stored = { action: quiz.action, reply: quiz.reply, post: null, check: null, kind: null, ...(quiz.draftId ? { draftId: quiz.draftId } : {}), ...(quiz.topics ? { topics: quiz.topics, highlight: quiz.highlight ?? null } : {}), ...extra };
  outbox.update((s) => {
    if (generation !== resetGeneration && !s.chat.some((m) => m.id === ownId)) s.chat.push(entry);
    const own = s.chat.find((m) => m.id === ownId);
    if (own) own.toAssistant = true;
    s.chat.push({ id: `${operationId}:a`, role: 'assistant', text: quiz.reply, at: new Date().toISOString(), action: quiz.action, postKey: null, model: null, ...(quiz.draftId ? { quiz: { draftId: quiz.draftId } } : {}), ...(quiz.topics ? { quizTopics: { topics: quiz.topics, highlight: quiz.highlight ?? null } } : {}) });
    s.chat = s.chat.slice(-200);
    s.chatOps[operationId] = stored;
  });
  emitViz('professor_chat', null, { action: stored.action, check: null, kind: null, viaAssistant: true });
  return { http: 200, body: stored };
}

// Approve / Publish / Keep / Discard / Draft-one-more on the quiz card (Faculty view → Hub proxy → here). The desk
// checks the quiz again (authoritative) and dedupes by operationId for definite outcomes only. The card's state is
// in memory; the chat gets outcome text only, once (a replayed duplicate never adds a second entry).
const QUIZ_ID = /^[\w-]{6,80}$/;
const QUIZ_ACTIONS = new Set(['approve', 'publish', 'keep_draft', 'discard', 'one_more']);
async function quizAction(body) {
  const keys = Object.keys(body ?? {});
  if (!body || typeof body !== 'object' || Array.isArray(body) || keys.some((k) => !['draftId', 'operationId', 'action', 'quiz', 'existing'].includes(k))) return { http: 400, body: { error: 'Unexpected request fields.' } };
  const { draftId, operationId, action, quiz, existing } = body;
  if (typeof operationId !== 'string' || !ID.test(operationId)) return { http: 400, body: { error: 'Missing or malformed operation id.' } };
  if (typeof draftId !== 'string' || !QUIZ_ID.test(draftId)) return { http: 400, body: { error: 'Missing or malformed draft id.' } };
  if (!QUIZ_ACTIONS.has(action)) return { http: 400, body: { error: 'Unknown quiz action.' } };
  if (quiz !== undefined && (action !== 'approve' || !quiz || typeof quiz !== 'object' || Array.isArray(quiz))) return { http: 400, body: { error: 'Only Approve carries a quiz.' } };
  if (action === 'approve' && quiz === undefined) return { http: 400, body: { error: 'Approve needs the quiz.' } };
  if (existing !== undefined && (action !== 'one_more' || !validExisting(existing))) return { http: 400, body: { error: 'Only Draft one more carries the list of questions (20 at most, 300 characters each).' } };
  const generation = resetGeneration;
  const r = await quizDesk.action({ draftId, operationId, action, ...(quiz ? { quiz } : {}), ...(existing ? { existing } : {}) });
  const { entries, duplicate, ...rest } = r;
  if (entries?.length && !duplicate && generation === resetGeneration) {
    outbox.update((s) => {
      const at = new Date().toISOString();
      entries.forEach((e, i) => { const id = `${operationId}:q${i}`; s.chat = s.chat.filter((m) => m.id !== id); s.chat.push({ id, at, ...e }); });
      s.chat = s.chat.slice(-200);
    });
  }
  emitViz('professor_chat', null, { action: `quiz_${action}`, status: r.ok ? 'ok' : (r.code ?? r.outcome ?? 'not_done'), viaAssistant: false });
  // 503 only for a retryable / unknown outcome; any other not-done result is a normal answer the card shows.
  return { http: r.ok ? 200 : (r.retryable || r.unknownOutcome) ? 503 : r.closed ? 409 : r.refused ? 422 : r.busy ? 409 : 200, body: rest };
}

// The professor said yes to the class cancellation (code-built from HR's receipt dates, no reason) — sent to
// the whole class as a message. Review C12: the class's time and room are read FRESH from CHRS right now and put in the
// sentence; without them nothing is sent (the same refusal as an unavailable class list: no guessed details, and the
// offer waits again). Review A5: his note, if he added one, as its own paragraph.
async function postNote({ operationId, text, days = null, studentNote = null }) {
  let body = text;
  if (Array.isArray(days) && days.length) {
    const info = classDetailsOf(await rosterDesk.classRecord({ operationId: `${operationId}-class` }).catch(() => null));
    if (!info) return { action: 'error', reply: ROSTER_POST_FAILED_TEXT, post: null, entries: [{ role: 'assistant', text: ROSTER_POST_FAILED_TEXT, action: 'error' }] };
    body = cancellationText(days, info, studentNote);
  }
  const r = await createPost({ operationId, kind: 'message', title: 'Class cancelled', text: body, audience: 'all', source: 'chat', verbatim: false });
  if (!r.body.lesson || r.body.ack?.status === 'rejected') {
    const problem = notSentText(r);
    return { action: 'error', reply: problem, post: null, entries: [{ role: 'assistant', text: problem, action: 'error' }] };
  }
  const post = { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) };
  // Review A4: the real counts (the post card under it shows the cancellation itself).
  const said = deliveredText(r.body.ack?.deliveries ?? [], { audience: 'all' }) ?? NOT_CONFIRMED_TEXT;
  return { action: 'post', kind: 'message', reply: said, post, entries: [{ role: 'assistant', text: said, action: 'post', postKey: post.key }] };
}
// The Hub hasn't confirmed the deliveries yet (it didn't answer in time): no count to claim.
const NOT_CONFIRMED_TEXT = "Your cancellation is on its way, but delivery isn't confirmed yet. I'll keep trying.";

// The professor pressed Submit or Cancel on the open HR card (Professor → Hub → HR, signed). One at a
// time with the chat; a repeat of the same operation gets its stored (definite) outcome.
async function hrAction({ operationId, formRef, action }) {
  if (typeof operationId !== 'string' || !ID.test(operationId)) return { http: 400, body: { error: 'Missing or malformed operation id.' } };
  if (typeof formRef !== 'string' || !formRef || formRef.length > 120) return { http: 400, body: { error: 'Missing card reference.' } };
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.name !== 'string') return { http: 400, body: { error: 'Missing card action.' } };
  const done = outbox.get().chatOps[`hr:${operationId}`];
  if (done) return { http: 200, body: { ...done, duplicate: true } };
  if (chatBusy) return { http: 409, body: { error: 'Still working on your previous message.' } };
  chatBusy = true;
  try {
    const generation = resetGeneration;
    const r = await staffAction({ operationId, formRef, action, hubLink, emit: (type, data) => emitViz(type, `staff-${operationId}`, data), classInfo: async () => classDetailsOf(await rosterDesk.classRecord({ operationId: `${operationId}-class` })) }); // the Hub's run for this action
    if (r.entries && generation === resetGeneration) {
      outbox.update((s) => {
        const now = new Date().toISOString();
        for (const e of r.entries) {
          const id = `${operationId}:${e.role === 'hr' ? 'h' : 'a'}`;
          s.chat = s.chat.filter((m) => m.id !== id); // a retried unknown outcome replaces its earlier entry
          s.chat.push({ id, at: now, staff: true, ...e });
        }
        s.chat = s.chat.slice(-200);
        if (r.definite) s.chatOps[`hr:${operationId}`] = r.body;
      });
    }
    emitViz('professor_chat', null, { action: 'hr_action', status: r.body?.status ?? null, viaAssistant: false });
    return { http: r.http, body: r.body };
  } finally {
    chatBusy = false;
  }
}

// No @assistant: send the professor's words as written. Tags pick the students; no tag = the whole class.
// `to`: a reply to one student's message — a message to that student only (no naming call needed).
async function directPost({ operationId, said, roster, to = null, hub = null, guard = true }) {
  const text = said.replace(/^\s*(@[\w-]+[\s,:]*)+/, '').trim();
  if (!text) return { action: 'error', reply: 'Write the message after the tag — nothing was sent.', post: null };
  if (to) {
    const title = `Reply: ${text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]}`.slice(0, 60);
    const r = await createPost({ operationId, kind: 'message', title, text, audience: to, source: 'chat', verbatim: true });
    if (!r.body.lesson || r.body.ack?.status === 'rejected') return { action: 'error', reply: notSentText(r), post: null };
    return { action: 'post', reply: null, post: { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) }, kind: 'message', ...confirmOf(r, to) };
  }
  // R3 (round 2): a question about the roster or “my students” is for the assistant — never posted to the class.
  if (guard && (asksAboutRoster(said) || asksRosterQuestion(said))) return { action: 'error', reply: ROSTER_QUESTION_TEXT, post: null };
  // R2 (round 2): tags resolve against the class roster (@first, @last, @first-last), not the two Student-agent sessions. A
  // tag starts the message or follows a space — the @ inside an email address (alex@example.com) isn't one.
  const found = await classPeople({ said, roster, operationId, hub });
  if (found.problem) return { action: 'error', reply: found.problem, post: null };
  const audience = found.tagged.length ? found.tagged.map((x) => x.studentId).join(',') : 'all';
  // Its model call belongs to this chat turn's run (`prof-<operationId>`), so Topology shows the hop.
  const named = await classifyPost({ text, emit: (type, data) => emitViz(type, `prof-${operationId}`, data) });
  const r = await createPost({ operationId, kind: named.kind, title: named.title, text, audience, source: 'chat', verbatim: true });
  if (!r.body.lesson || r.body.ack?.status === 'rejected') return { action: 'error', reply: notSentText(r), post: null };
  return { action: 'post', reply: null, post: { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) }, kind: named.kind, ...confirmOf(r, audience) };
}

// R2 (round 2): who the @-tags name. The class's names come from the roster desk (the last roster lookup, memory only) plus
// the Student-agent sessions; a tag none of them settles (unknown, or two students) asks CHRS once more before answering.
// → { people, tagged } or { problem } (nothing is sent: the question names students by name only).
const mergePeople = (roster, known) => [...new Map([...roster.map((x) => [x.studentId, { studentId: x.studentId, name: x.name }]), ...(known ?? []).map((x) => [x.studentId, x])]).values()];
async function classPeople({ said, roster, operationId, hub }) {
  let people = mergePeople(roster, rosterDesk.known());
  let r = resolveTags(said, people);
  if (r.unknown.length || r.ambiguous.length) {
    const fresh = await rosterDesk.names({ operationId: `${operationId}-tags`, hub, fresh: true });
    if (!fresh) return { people, problem: ROSTER_POST_FAILED_TEXT };
    people = mergePeople(roster, fresh);
    r = resolveTags(said, people);
  }
  if (r.ambiguous.length) return { people, problem: whichStudentText(r.ambiguous[0].names) };
  if (r.unknown.length) return { people, problem: notInClassText(r.unknown[0]) };
  return { people, tagged: r.tagged };
}

// "Notify everyone that …" (Part 17): the rest of his sentence goes to the whole class as his own message. The Hub
// addresses it from the class list (CHRS); the reply counts the deliveries it actually made.
async function notifyPost({ operationId, text }) {
  const named = await classifyPost({ text, emit: (type, data) => emitViz(type, `prof-${operationId}`, data) });
  const r = await createPost({ operationId, kind: named.kind, title: named.title, text, audience: 'all', source: 'chat', verbatim: true });
  if (!r.body.lesson || r.body.ack?.status === 'rejected') return { action: 'error', reply: notSentText(r), post: null };
  const post = { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) };
  // Not accepted by the Hub yet (uncertain): the post's own row says so; no count to claim.
  return { action: 'post', reply: null, post: { ...post, audience: 'all' }, kind: named.kind, ...confirmOf(r, 'all') };
}

// @assistant: the course assistant decides (post / answer / clarify); code checks a post before it's sent.
async function assistantTurn({ operationId, said, roster: sessions, hub }) {
  const request = said.replace(ASSISTANT_TAG, ' ').trim();
  // R1/R2 (round 2): code addresses students from the class roster's names; the model sees the class size and, for
  // addressing, the roster's names and tags only (never the two Student-agent sessions as “the class”, never an email or ID).
  const found = await classPeople({ said: request, roster: sessions, operationId, hub });
  if (found.problem) return { reply: found.problem, action: 'clarify', post: null, check: 'tag', model: null, kind: null };
  const roster = found.people;
  const known = rosterDesk.known();
  const students = known ? known.map((p) => ({ name: p.name, tag: tagFor(p, known) })) : [];
  const classSize = rosterDesk.counts()?.count ?? null;
  const nameOf = (id) => id.split(',').map((x) => roster.find((r) => r.studentId === x)?.name ?? 'a student').join(', ');
  const posts = postsView(hub).map((l) => ({ title: l.title, kind: l.kind, audience: l.audience === 'all' ? 'all' : nameOf(l.audience), sentAt: l.createdAt, deliveries: l.deliveries.map((d) => ({ name: nameOf(d.studentId), state: d.state, opened: d.opened })) }));
  // HR (staff only): the professor's staff messages and HR's replies are private — the model sees only that
  // they exist, marked private (never their text), and checkPost never counts them as words for students.
  const recentChat = outbox.get().chat.slice(-8, -1).map((m) => (m.staff ? { role: m.role, text: PRIVATE_STAFF_TEXT, staff: true } : m));
  let decision;
  try {
    decision = await interpretProfessor({ text: request, roster, students, classSize, seeds: SEED_LESSONS, posts, recent: recentChat, progress: coveredText(nowFn()()), emit: (type, data) => emitViz(type, `prof-${operationId}`, data) });
  } catch (err) {
    decision = { action: 'error', reply: `I couldn't work that out right now (${err.message ?? 'model error'}). Nothing was sent.` };
  }
  const result = { reply: decision.reply, action: decision.action, post: null, check: null, model: decision.model ?? null, kind: decision.kind ?? null };
  if (decision.action === 'quiz') {
    // The topic list only (never a draft in the same turn); the topic named, if any, is highlighted.
    const named = pickQuizTopic(decision.topic || request);
    const t = quizDesk.topics(named, countFromWords(request) ?? 5);
    return { ...result, action: t.action, reply: t.reply, ...(t.topics ? { topics: t.topics, highlight: t.highlight } : {}), post: null };
  }
  if (decision.action === 'schedule') {
    const aud = resolveAudience(decision, request, roster);
    if (aud.problem) return { ...result, action: 'clarify', reply: aud.problem, check: aud.code };
    const slots = slotsIn(request);
    if (slots.length) return { ...(await offerMeeting({ operationId, audience: aud.audience, slots, roster })), model: result.model };
    // No times in the professor's words: ask for them (never guess), and wait for the answer.
    outbox.update((s) => { s.pendingMeeting = { audience: aud.audience, at: Date.now() }; });
    const who = aud.audience === 'all' ? 'the class' : aud.audience.split(',').map((id) => roster.find((x) => x.studentId === id)?.name.split(' ')[0] ?? id).join(' and ');
    return { ...result, action: 'clarify', check: 'needs_times', reply: `When can ${who} come? Give me a few times — for example “Tue 2pm, Wed 10:30am” — and I’ll send them to choose from. Just write the times; no need to tag me.` };
  }
  if (decision.action === 'post') {
    const checked = checkPost(decision, request, roster, recentChat, privateStaffWords(request));
    if (checked.problem) return { ...result, action: 'clarify', reply: checked.problem, check: checked.code };
    const r = await createPost({ operationId, ...checked.post, source: 'chat', author: 'assistant' });
    if (r.body.lesson && r.body.ack?.status !== 'rejected') {
      result.post = { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) };
      if (checked.corrected) result.reply = `${result.reply} (${checked.corrected})`;
      Object.assign(result, confirmOf(r, checked.post.audience));
    } else {
      Object.assign(result, { action: 'error', reply: notSentText(r) });
    }
  }
  return result;
}

function pickQuizTopic(text) {
  const bare = /^\s*#?\s*(\d{1,2})\s*$/.exec(String(text ?? ''));
  const n = bare ? Number(bare[1]) : topicFromWords(String(text ?? ''));
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

// Who a post or a meeting is for: a tag the professor wrote wins; a single student the model picked must
// be tagged or named by the professor.
function resolveAudience(d, said, roster) {
  const tags = resolveTags(said, roster);
  if (tags.ambiguous.length) return { problem: whichStudentText(tags.ambiguous[0].names), code: 'ambiguous_tag' };
  if (tags.unknown.length) return { problem: notInClassText(tags.unknown[0]), code: 'unknown_tag' };
  const { tagged } = tags;
  const { named } = tagsIn(said, roster);
  const allWords = /\b(everyone|everybody|all students|the class|whole class|all of you)\b/i.test(said);
  // The model names one student by tag (“@mariana”), by name, or by id; code maps it to the roster's student.
  const one = (a) => {
    if (typeof a !== 'string' || !a.trim()) return null;
    if (roster.some((x) => x.studentId === a)) return a;
    const r = resolveTags(`@${a.trim().replace(/^@/, '').toLowerCase().replace(/\s+/g, '-')}`, roster);
    return r.tagged.length === 1 && !r.ambiguous.length ? r.tagged[0].studentId : null;
  };
  let audience = d.audience === 'all' ? 'all' : one(d.audience);
  let corrected = null;
  if (tagged.length === 1 && !allWords && audience !== tagged[0].studentId) { audience = tagged[0].studentId; corrected = `sent to ${tagged[0].name}, whom you tagged`; }
  if (tagged.length > 1 && !allWords) { audience = tagged.map((x) => x.studentId).join(','); corrected = `sent to ${tagged.map((x) => x.name).join(' and ')}, whom you tagged`; }
  if (!audience) return { problem: 'Who should get it — one student (tag them, like @alex) or the whole class?', code: 'unknown_audience' };
  if (audience !== 'all' && !audience.includes(',') && ![...tagged, ...named].some((x) => x.studentId === audience)) return { problem: `Should this go to ${roster.find((x) => x.studentId === audience)?.name ?? audience} only? Tag them (@${(roster.find((x) => x.studentId === audience)?.name ?? '').split(' ')[0].toLowerCase()}) or say “everyone”.`, code: 'untagged_student' };
  return { audience, corrected };
}

// A meeting offer: the times (read from the professor's words by code) go to the student(s) as the
// assistant's message; each student picks one in their chat and the Professor books it (bookSlot).
async function offerMeeting({ operationId, audience, slots, roster }) {
  const meeting = { meetingId: `mt-${randomUUID().slice(0, 12)}`, slots };
  const who = audience === 'all' ? 'the class' : audience.split(',').map((id) => roster.find((x) => x.studentId === id)?.name ?? id).join(' and ');
  const text = `${COURSE.professorName} would like to meet with you. Pick the time that works for you:\n${slots.map((x) => `• ${x.label}`).join('\n')}\n(Pacific Time.)`;
  outbox.update((s) => { s.meetings ??= {}; s.meetings[meeting.meetingId] = { meetingId: meeting.meetingId, slots, audience, bookings: {}, byStudent: {}, createdAt: new Date().toISOString() }; s.pendingMeeting = null; });
  const r = await createPost({ operationId, kind: 'message', title: `Meeting with ${COURSE.professorName}`, text, audience, source: 'chat', verbatim: false, author: 'assistant', meeting });
  if (!r.body.lesson || r.body.ack?.status === 'rejected') return { action: 'error', reply: notSentText(r), post: null };
  return { action: 'post', kind: 'message', post: { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) }, reply: `Sent ${who} ${slots.length === 1 ? 'this time' : `${slots.length} times to choose from`}: ${slots.map((x) => x.label).join('; ')}. You’ll see the choice here.`, ...confirmOf(r, audience) };
}

// HR (staff only): words from the professor's private staff messages (to HR) that the current @assistant
// request doesn't itself contain — e.g. “grandmother”, “passed away”. A draft using any of them would share
// the private request with students, so checkPost refuses it (code guard, whatever the model was told).
const PRIVATE_STAFF_TEXT = '[private: the faculty member’s own HR matter — never post, quote or repeat it to students]';
const COMMON = new Set('about after again also because before being class could course every first friday monday need please really saturday should since students sunday their there these thing think thursday today tomorrow tuesday wednesday which while would'.split(' '));
const wordsOf = (t) => norm(t).split(' ').filter((w) => w.length >= 5 && !COMMON.has(w));
// Leave words are private whatever their length (the 5-letter rule above would miss “sick”, “died”, “flu”).
const LEAVE_WORDS = new Set(['sick', 'ill', 'died', 'flu', 'leave', 'funeral', 'passed', 'death', 'grief', 'surgery', 'doctor', 'hospital']);
const privateOf = (t) => [...wordsOf(t), ...norm(t).split(' ').filter((w) => LEAVE_WORDS.has(w))];
function privateStaffWords(request) {
  const allowed = new Set(norm(request).split(' '));
  return [...new Set(outbox.get().chat.filter((m) => m.staff && m.role === 'professor').flatMap((m) => privateOf(m.text)))].filter((w) => !allowed.has(w));
}
function checkPost(d, said, roster, recentChat, privateWords = []) {
  // Only messages the professor wrote for the class count as the professor's words (never staff ones).
  const professorWords = [said, ...recentChat.filter((t) => t.role === 'professor' && !t.staff).map((t) => t.text)];
  const aud = resolveAudience(d, said, roster);
  if (aud.problem) return aud;
  const { audience, corrected } = aud;
  // Content: a course lesson, the professor's own words, or text written from their instruction.
  let text = d.content;
  let verbatim = d.verbatim;
  let title = d.title;
  let kind = d.kind === 'message' ? 'message' : 'lesson';
  const seed = d.seedId ? SEED_LESSONS.find((x) => x.seedId === d.seedId) : null;
  if (d.seedId && !seed) return { problem: 'I couldn’t find that course lesson. Which one do you mean?', code: 'unknown_seed' };
  if (seed) {
    text = [seed.objective, seed.explanation, seed.example, `Check your understanding: ${seed.check}`].join('\n\n');
    title = seed.title;
    kind = 'lesson';
    verbatim = true;
  }
  text = String(text ?? '').trim();
  if (!text) return { problem: 'What should it say?', code: 'empty' };
  const leaked = !seed && norm(`${title ?? ''} ${text}`).split(' ').filter((w) => privateWords.includes(w));
  if (leaked?.length) return { problem: 'That would share part of your private HR request with students, so I didn’t send it. Write the message the way you want the class to read it.', code: 'private_staff' };
  if (!seed && verbatim && !professorWords.some((w) => norm(w).includes(norm(text)))) verbatim = false;
  const allowedDates = new Set([...professorWords.flatMap((w) => datesIn(w)), ...(seed ? datesIn(text) : [])]);
  const invented = datesIn(text).filter((x) => !allowedDates.has(x));
  if (invented.length) return { problem: 'I’d have had to add a date you didn’t give, so I didn’t send it. Could you include the date, or write the message the way you want it?', code: 'invented_date' };
  if (!title) title = text.split(/[.!?\n]/)[0].slice(0, 60);
  return { post: { kind, audience, title: title.slice(0, 120), text, verbatim, seedId: seed?.seedId ?? null }, corrected };
}

function authorRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  // The professor's console state: course, roster (from the Hub's trusted data), seeded lessons, and every
  // posted lesson with its delivery state from the Hub.
  router.get('/author/state', async (req, res) => {
    // Re-send anything whose outcome at the Hub is unknown — with its SAME operation id (the Hub dedupes).
    // Only posts the Hub never confirmed receiving; once accepted, delivery to the student is the Hub's job.
    // In the background (a publish can wait 40 s for the class list): the 3-second poll never waits on it, and one post
    // is never re-sent twice at once.
    for (const l of Object.values(outbox.get().lessons)) if (!l.hubAccepted && ['uncertain', 'not_delivered'].includes(l.hubStatus)) republish(l);
    const hub = await hubView();
    // The Hub's counts are empty until it has asked CHRS (and again after its 60 s cache): keep the last known ones so the
    // header can read "25 students · 1 online". `rosterCard` is a reference only ({ rosterId, count, at }) — the rows
    // are served by GET /author/roster to the Faculty view, never by the state or the streams.
    const course = hub?.courses?.find((c) => c.courseId === COURSE.courseId) ?? null;
    rosterDesk.noteCourse(course);
    const counts = rosterDesk.counts();
    res.json({ course: COURSE, roster: course || counts ? { ...(course ?? {}), count: counts?.count ?? null, online: counts?.online ?? null } : null, rosterCard: rosterDesk.state(), hubReachable: Boolean(hub), seeds: SEED_LESSONS, lessons: postsView(hub), chat: outbox.get().chat, hrCard: staffView(), quizCard: quizDesk.card(), quizAsking: quizDesk.pending() });
  });
  // The full class roster (names, IDs, emails, program) for the Faculty view only — like the quiz draft, never in the state,
  // the streams or the telemetry. Gone after a restart: the chat line stays, the rows don't.
  // `names` (studentId → "First Last") is what the Faculty view uses to label delivery rows: from the Hub's delivery
  // records (it remembers the names of students it delivered to). Never in /author/state.
  const deliveryNames = (hub) => {
    const names = {};
    for (const d of hub?.deliveries ?? []) if (typeof d.name === 'string' && typeof d.studentId === 'string') names[d.studentId] = d.name;
    return names;
  };
  // The names alone (no roster card needed): the Faculty view labels delivery rows with them.
  // Also the names of students a Canvas-vs-roster comparison flagged (review C15), from the quiz desk's memory.
  router.get('/author/roster/names', async (req, res) => res.json({ names: { ...deliveryNames(await hubView()), ...quizDesk.memberNames() } }));
  // R2 (round 2): the class's names and tags for the Faculty view's @-suggestions — names only (no email, no ID, no level,
  // no major), from the last roster lookup in memory or one lookup when there is none. Fetched by the Faculty view only.
  router.get('/author/roster/people', async (req, res) => {
    const people = await rosterDesk.names({ hub: null }).catch(() => null);
    if (!people) return res.status(503).json({ error: ROSTER_GONE, people: [] });
    return res.json({ people: people.map((p) => ({ name: p.name, tag: tagFor(p, people) })) });
  });
  router.get('/author/roster', async (req, res) => {
    const hub = await hubView();
    const names = deliveryNames(hub);
    const v = rosterDesk.view(hub, null);
    if (!v) return res.status(404).json({ error: ROSTER_GONE, names });
    return res.json({ ...v, names });
  });
  // Demo reset (requested through the Hub when the Student starts a new conversation): the posted list
  // and the remembered conversations go; the professor sends again. (The browser keeps any unsent draft.)
  router.post('/author/reset', async (req, res) => {
    quizDesk.reset(); // the quiz card closes first, so a call in flight sees isClosed() and Canvas's reset generation (review D17: no "closed" line in the chat)
    outbox.update((s) => {
      s.lessons = {}; s.operations = {}; s.chat = []; s.chatOps = {}; s.meetings = {}; s.pendingMeeting = null;
    });
    resetGeneration += 1;
    recent.clear();
    rosterDesk.reset(); // the class roster card is forgotten with the classroom
    resetStaff(); // HR: the open card, a held question or note offer; a new HR conversation
    emitViz('lessons_reset', null, {});
    // Canvas forgets its quizzes too (best effort, bounded): a failure here never blocks the classroom reset.
    let canvas = 'not_configured';
    if (process.env.CANVAS_TOKEN) {
      try {
        const r = await fetch(`${CANVAS_URL.replace(/\/+$/, '')}/dev/reset`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.CANVAS_TOKEN}` }, signal: AbortSignal.timeout(2500) });
        canvas = r.ok ? 'reset' : `HTTP ${r.status}`;
      } catch { canvas = 'unreachable'; }
    }
    res.json({ status: 'reset', canvas });
  });
  // Post one lesson or message to one student or to all enrolled students ('all' is resolved by the Hub
  // from its enrollment data). The typed API the chat below also uses; stable operation id per post.
  router.post('/author/lessons', async (req, res) => {
    const r = await createPost(req.body ?? {});
    res.status(r.http).json(r.body);
  });
  // The professor's chat: natural language in; the model decides post / answer / clarify; code checks it.
  router.post('/author/chat', async (req, res) => {
    const r = await professorChat(req.body ?? {});
    res.status(r.http).json(r.body);
  });
  // HR (staff only): Submit / Cancel on the open time-off card → Hub → HR (origin-guarded like every
  // non-GET /author route).
  router.post('/author/hr-action', async (req, res) => {
    const r = await hrAction(req.body ?? {});
    res.status(r.http).json(r.body);
  });
  // Canvas quiz card (Part 16): Approve / Publish / Keep / Discard / Draft one more.
  router.post('/author/quiz-action', async (req, res) => {
    const r = await quizAction(req.body ?? {});
    res.status(r.http).json(r.body);
  });
  // The full draft WITH the answer key: only the Faculty view fetches it (the state and the streams never carry it).
  router.get('/author/quiz/:draftId', (req, res) => {
    const d = QUIZ_ID.test(req.params.draftId) ? quizDesk.draft(req.params.draftId) : null;
    if (!d) return res.status(404).json({ error: 'That draft is closed or unknown.' });
    return res.json(d);
  });
  return router;
}

// ---- server ----------------------------------------------------------------------------------------------
function buildAgentCard(port) {
  return {
    name: 'Marketing 351 Faculty',
    description: 'The faculty member who teaches Marketing 351, a fictional introductory course (not an official CSUF course): explains introductory marketing concepts, discusses course lessons, works through examples, and helps students check their understanding. Posts lessons and course messages to one enrolled student or the whole class through the university.',
    version: '0.1.0',
    supportedInterfaces: [{ url: `http://${HOST}:${port}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }],
    provider: undefined,
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [], // filled from the skill configuration (the course topics)
    signatures: [],
  };
}

function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ source: 'professor', type: 'status', runId: null, at: new Date().toISOString(), data: { ...professorStatus(), skills: skillService?.describe() ?? null } })}\n\n`);
  // A follower that connects after the link's startup warm-up still learns the session's current state.
  const session = canvasLink.sessionStatus();
  if (session) res.write(`data: ${JSON.stringify({ source: 'professor', type: 'canvas_session', runId: null, at: session.at, data: (({ at, ...d }) => d)(session) })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

export function startProfessorServer({ port = 41244 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err);
      const actualPort = server.address().port;
      const baseUrl = `http://${HOST}:${actualPort}`;
      const card = buildAgentCard(actualPort);
      skillService = createSkillService({
        agentId: 'professor', agentName: card.name, defaults: PROFESSOR_DEFAULT_SKILLS, rules: RULES, card,
        emit: (type, data) => emitViz(type, null, data), log, notify: (n) => hubLink.notifyCardChanged(n),
      });
      hubLink = createHubLink({
        agentId: CONFIG.agentId, hubUrl: CONFIG.hub.url, endpoint: `${baseUrl}${JSONRPC_PATH}`, cardUrl: `${baseUrl}/${AGENT_CARD_PATH}`,
        enabled: CONFIG.enabled, heartbeatIntervalMs: CONFIG.heartbeatIntervalMs, log, emit: (type, data) => emitViz(type, null, data),
      });
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get('/viz/events', serveVizEvents);
      app.use(skillService.router());
      // The authoring routes are called by the Hub (no Origin header); a cross-site browser POST is refused.
      const guardOrigin = sameOriginGuard(actualPort);
      app.use('/author', (req, res, next) => (req.method === 'GET' ? next() : guardOrigin(req, res, next)));
      app.use(authorRouter());
      skillService.started(actualPort, `${baseUrl}/${AGENT_CARD_PATH}`);
      hubLink.start();
      resolve({ server, baseUrl, hubLink });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41244 : Number(process.env.PORT);
  const { baseUrl } = await startProfessorServer({ port });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await Promise.race([Promise.all([hubLink?.stop(), canvasLink.close()]), new Promise((r) => setTimeout(r, 800))]);
      process.exit(0);
    });
  }
  log(`listening on ${baseUrl}`);
  canvasLink.warm(); // open the MCP session now (no tool call) so the pill is right after a restart
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = professorStatus();
  log(`mode: ${s.mode} (${s.model})${s.mode === 'live' ? `, API key (${keyEnvName()}): ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}`);
}
