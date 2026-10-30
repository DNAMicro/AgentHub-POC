// Part 9: the Marketing 101 Professor — one private specialist behind the University Hub that works in
// both directions:
//   * students ask questions:       Student → Hub → Professor → Hub → Student (normal chat over A2A)
//   * the professor posts lessons:  Professor → Hub → Student (a NEW A2A interaction the professor starts)
//
// Answers come from the course pack (src/course-pack.js, its editable answer skills) and, for a question
// about a delivered lesson, that lesson (src/professor-model.js). Posting a lesson happens only through the
// authoring API below, which the Professor view calls when the professor presses “Post lesson”. The outbox
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
import { PROFESSOR_MODE, classifyPost, interpretProfessor, professorReply, professorStatus, tagsIn } from './professor-model.js';
import { datesIn } from './a2ui-catalog.js';
import { slotsIn } from './meeting-times.js';
import { createJsonStore } from './json-store.js';
import { AUDIENCE, ID, LESSON_PUBLISH_MEDIA_TYPE, LESSON_STATUS_MEDIA_TYPE, contentHash, validateLesson } from './lessons.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const CONFIG = loadSpecialistConfig('professor');
useModel(CONFIG.model); // the Professor's own model and key variable
let hubLink = null;
let skillService = null;
const RULES = { answer: { knowledge: 'required' } };

const log = (...args) => console.log('[Marketing 101 Professor]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'professor', type, runId, at: new Date().toISOString(), data });
const textOf = (message) => message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');
const textPart = (value) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });

// Outbox: lessons the professor posted (every revision kept) and post operations (for dedupe).
// Also the professor's chat with this console (Professor view), and its operations (for dedupe).
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
const NEEDS_PROFESSOR_TEXT = `I don’t have that answer here, so I’ve sent your question to ${COURSE.professorName}. Their reply will appear here in your chat.`;
const NOT_PASSED_TEXT = 'I don’t have that answer here, and I couldn’t pass your question on because your request wasn’t verified by the university.';
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
    const text = 'Sent to your professor. Their answer will appear here in your chat.';
    metadata.professor = { name: COURSE.professorName, outcome: 'relayed', mode: PROFESSOR_MODE, model: null, usage: null, lessonId: lesson.lessonId, topics: [] };
    return publishReply(ctx, bus, runId, incoming, text, metadata);
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
    text = `The Marketing 101 Professor could not answer: ${failure.message}`;
    metadata.serviceError = { code: failure.code, message: failure.message, requestId: failure.requestId };
    // The professor still sees what the student wrote — and that nobody answered it.
    if (lesson) recordReply(incoming.messageId, { studentId: student, text: question, about, relayed: false }, { text: `Not answered: ${failure.message}`, model: null, needsProfessor: true, onBehalf, failed: true });
  }
  return publishReply(ctx, bus, runId, incoming, text, metadata, question);
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
// One booking per student per meeting, one student per time: a synchronous check-and-set (no await
// between the check and the write). A repeat of the same choice returns the same booking.
function bookSlot(meetingId, slotId, student) {
  let r;
  const at = new Date().toISOString();
  outbox.update((s) => {
    const m = s.meetings?.[meetingId];
    const slot = m?.slots.find((x) => x.slotId === slotId);
    if (!m || !slot) { r = { status: 'unknown', text: 'That isn’t one of the times the professor offered.' }; return; }
    const mine = m.byStudent[student];
    if (mine) {
      const booked = m.slots.find((x) => x.slotId === mine);
      r = mine === slotId ? { status: 'booked', slot: booked, duplicate: true } : { status: 'already', slot: booked, text: `You’re already booked for ${booked.label}. If you need a different time, reply here and the professor will sort it out.` };
      return;
    }
    if (m.bookings[slotId]) {
      const open = m.slots.filter((x) => !m.bookings[x.slotId]);
      r = { status: 'taken', slot, needsProfessor: !open.length, text: open.length ? `Sorry — ${slot.label} was just taken. Still open: ${open.map((x) => x.label).join('; ')}.` : `Sorry — ${slot.label} was just taken, and every offered time is gone. I’ve let the professor know.` };
      return;
    }
    m.bookings[slotId] = { studentId: student, at };
    m.byStudent[student] = slotId;
    r = { status: 'booked', slot };
  });
  if (r.status === 'booked') r.text = `Booked: ${r.slot.label} (Pacific Time) with the professor. Demo booking — no calendar invite is sent.`;
  return { needsProfessor: false, ...r };
}
function publishReply(ctx, bus, runId, incoming, text, metadata, question = null) {
  const message = { messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [textPart(text)], metadata, extensions: [], referenceTaskIds: [] };
  bus.publish(AgentEvent.message(message));
  bus.finished();
  emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, text, professor: metadata.professor });
  if (question !== null) recent.set(ctx.contextId, [...(recent.get(ctx.contextId) ?? []), { question, answer: text }].slice(-4));
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
    { type: 'lesson_publish', operationId: record.operationId, lessonId: record.lessonId, revision: record.revision, courseId: record.courseId, kind: record.kind, author: record.author ?? 'professor', ...(record.meeting ? { meeting: record.meeting } : {}), audience: record.audience, title: record.title, text: record.text },
    ['publish', record.operationId, record.lessonId, record.revision, record.courseId, record.kind, record.audience, contentHash(record.title, record.text, record.kind, record.author ?? 'professor', record.meeting ?? null)]);
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

// Every post, newest first, with one delivery per recipient (a post to "all" has one per enrolled student).
function postsView(hub) {
  const byPost = new Map();
  for (const d of hub?.deliveries ?? []) byPost.set(`${d.lessonId}#${d.revision}`, [...(byPost.get(`${d.lessonId}#${d.revision}`) ?? []), d]);
  return Object.values(outbox.get().lessons).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((l) => ({
    ...l,
    key: lessonKey(l.lessonId, l.revision),
    meetingState: l.meeting ? l.meeting.slots.map((x) => ({ label: x.label, bookedBy: outbox.get().meetings?.[l.meeting.meetingId]?.bookings[x.slotId]?.studentId ?? null })) : null,
    deliveries: (byPost.get(lessonKey(l.lessonId, l.revision)) ?? []).map((d) => ({ studentId: d.studentId, state: d.state, opened: Boolean(d.openedAt), openedAt: d.openedAt, deliveredAt: d.deliveredAt, lastError: d.lastError, attempts: d.attempts })),
  }));
}

async function hubView() {
  const nonce = randomUUID();
  const r = await hubLink.sendSigned(LESSON_STATUS_MEDIA_TYPE, { type: 'lesson_status', nonce }, ['status', nonce]).catch(() => null);
  return r?.status === 'ok' ? r : null;
}

// ---- posting (shared by the typed API and the chat) -------------------------------------------------------
async function createPost({ operationId, kind = 'lesson', title = '', text, audience, courseId = COURSE.courseId, lessonId = null, source = 'api', verbatim = true, seedId = null, author = 'professor', meeting = null }) {
  if (typeof operationId !== 'string' || !ID.test(operationId)) return { http: 400, body: { errors: { _form: 'Missing or malformed operation id.' } } };
  if (typeof audience !== 'string' || !AUDIENCE.test(audience)) return { http: 400, body: { errors: { audience: 'Choose all students or one enrolled student.' } } };
  const v = validateLesson({ kind, title, text });
  if (!v.ok) return { http: 400, body: { errors: v.errors } };
  const prior = outbox.get().operations[operationId];
  if (prior) {
    // A repeat of the same operation: the same post — never a second one. Different content → refused.
    const l = outbox.get().lessons[prior];
    if (l.title !== v.values.title || l.text !== v.values.text || l.kind !== v.values.kind || l.audience !== audience) return { http: 409, body: { errors: { _form: 'This post was already sent with different content.' } } };
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
  };
  outbox.update((s) => {
    s.lessons[lessonKey(record.lessonId, record.revision)] = record;
    s.operations[operationId] = lessonKey(record.lessonId, record.revision);
  });
  const ack = await publish(record);
  return { http: ack.status === 'rejected' ? 422 : 200, body: { lesson: outbox.get().lessons[lessonKey(record.lessonId, record.revision)], ack: { status: ack.status, reason: ack.reason ?? null, accepted: Array.isArray(ack.deliveries) && ack.deliveries.length > 0, deliveries: ack.deliveries ?? [] } } };
}

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
// view). It goes to that student only, as the professor's own message.
async function professorChat({ operationId, text, replyTo = null }) {
  if (typeof operationId !== 'string' || !ID.test(operationId)) return { http: 400, body: { error: 'Missing or malformed operation id.' } };
  const said = typeof text === 'string' ? text.trim() : '';
  if (!said) return { http: 400, body: { error: 'Write something first.' } };
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
    const reply = toAssistant ? null : replyTo; // "@assistant …" is a request to the assistant, whoever is being replied to
    // The assistant asked "when can Alex come?": the professor's next untagged message with times answers it.
    const waiting = outbox.get().pendingMeeting;
    const times = !toAssistant && !reply && waiting && Date.now() - waiting.at < 15 * 60_000 && !/^\s*@/.test(said) ? slotsIn(said) : [];
    const viaAssistant = toAssistant || times.length > 0;
    const entry = { id: `${operationId}:p`, role: 'professor', text: said, at, toAssistant: viaAssistant, ...(reply ? { replyTo: reply } : {}) };
    outbox.update((s) => { s.chat.push(entry); });
    const result = times.length ? await offerMeeting({ operationId, audience: waiting.audience, slots: times, roster })
      : toAssistant ? await assistantTurn({ operationId, said, roster, hub }) : await directPost({ operationId, said, roster, to: reply });
    outbox.update((s) => {
      // A reset while this was worked on cleared the chat: keep the professor's message.
      if (generation !== resetGeneration && !s.chat.some((m) => m.id === `${operationId}:p`)) s.chat.push(entry);
      const own = s.chat.find((m) => m.id === `${operationId}:p`);
      if (!viaAssistant) Object.assign(own, { postKey: result.post?.key ?? null, problem: result.post ? null : result.reply });
      else s.chat.push({ id: `${operationId}:a`, role: 'assistant', text: result.reply, at: new Date().toISOString(), action: result.action, postKey: result.post?.key ?? null, model: result.model ?? null });
      s.chat = s.chat.slice(-200);
      s.chatOps[operationId] = result;
    });
    emitViz('professor_chat', null, { action: result.action, check: result.check ?? null, kind: result.kind ?? null, viaAssistant });
    return { http: 200, body: result };
  } finally {
    chatBusy = false;
  }
}

// No @assistant: send the professor's words as written. Tags pick the students; no tag = the whole class.
// `to`: a reply to one student's message — a message to that student only (no naming call needed).
async function directPost({ operationId, said, roster, to = null }) {
  const { tagged } = tagsIn(said, roster);
  const text = said.replace(/^\s*(@[\w-]+[\s,:]*)+/, '').trim();
  if (!text) return { action: 'error', reply: 'Write the message after the tag — nothing was sent.', post: null };
  if (to) {
    const title = `Reply: ${text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]}`.slice(0, 60);
    const r = await createPost({ operationId, kind: 'message', title, text, audience: to, source: 'chat', verbatim: true });
    if (!r.body.lesson || r.body.ack?.status === 'rejected') return { action: 'error', reply: `Nothing was sent: ${r.body.ack?.reason ?? Object.values(r.body.errors ?? {})[0] ?? 'refused'}.`, post: null };
    return { action: 'post', reply: null, post: { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) }, kind: 'message' };
  }
  // A tag starts the message or follows a space — the @ inside an email address (alex@example.com) isn't one.
  const unknownTag = [...said.matchAll(/(?:^|\s)@([\w-]+)/g)].map((m) => m[1].toLowerCase()).find((h) => !roster.some((x) => [x.studentId, x.name.split(' ')[0].toLowerCase()].includes(h)));
  if (unknownTag && /^\s*@/.test(said)) return { action: 'error', reply: `There's no @${unknownTag} in Marketing 101, so nothing was sent.`, post: null };
  const audience = tagged.length ? tagged.map((x) => x.studentId).join(',') : 'all';
  const named = await classifyPost({ text, emit: (type, data) => emitViz(type, null, data) });
  const r = await createPost({ operationId, kind: named.kind, title: named.title, text, audience, source: 'chat', verbatim: true });
  if (!r.body.lesson || r.body.ack?.status === 'rejected') return { action: 'error', reply: `Nothing was sent: ${r.body.ack?.reason ?? Object.values(r.body.errors ?? {})[0] ?? 'refused'}.`, post: null };
  return { action: 'post', reply: null, post: { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) }, kind: named.kind };
}

// @assistant: the course assistant decides (post / answer / clarify); code checks a post before it's sent.
async function assistantTurn({ operationId, said, roster, hub }) {
  const nameOf = (id) => id.split(',').map((x) => roster.find((r) => r.studentId === x)?.name ?? x).join(', ');
  const posts = postsView(hub).map((l) => ({ title: l.title, kind: l.kind, audience: l.audience === 'all' ? 'all' : nameOf(l.audience), sentAt: l.createdAt, deliveries: l.deliveries.map((d) => ({ name: nameOf(d.studentId), state: d.state, opened: d.opened })) }));
  const recentChat = outbox.get().chat.slice(-8, -1);
  const request = said.replace(ASSISTANT_TAG, ' ').trim();
  let decision;
  try {
    decision = await interpretProfessor({ text: request, roster, seeds: SEED_LESSONS, posts, recent: recentChat, emit: (type, data) => emitViz(type, null, data) });
  } catch (err) {
    decision = { action: 'error', reply: `I couldn't work that out right now (${err.message ?? 'model error'}). Nothing was sent.` };
  }
  const result = { reply: decision.reply, action: decision.action, post: null, check: null, model: decision.model ?? null, kind: decision.kind ?? null };
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
    const checked = checkPost(decision, request, roster, recentChat);
    if (checked.problem) return { ...result, action: 'clarify', reply: checked.problem, check: checked.code };
    const r = await createPost({ operationId, ...checked.post, source: 'chat', author: 'assistant' });
    if (r.body.lesson && r.body.ack?.status !== 'rejected') {
      result.post = { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) };
      if (checked.corrected) result.reply = `${result.reply} (${checked.corrected})`;
    } else {
      Object.assign(result, { action: 'error', reply: `Nothing was sent: ${r.body.ack?.reason ?? Object.values(r.body.errors ?? {})[0] ?? 'refused'}.` });
    }
  }
  return result;
}

// Who a post or a meeting is for: a tag the professor wrote wins; a single student the model picked must
// be tagged or named by the professor.
function resolveAudience(d, said, roster) {
  const { tagged, named } = tagsIn(said, roster);
  const allWords = /\b(everyone|everybody|all students|the class|whole class|all of you)\b/i.test(said);
  let audience = d.audience === 'all' || roster.some((x) => x.studentId === d.audience) ? d.audience : null;
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
  const text = `The professor would like to meet with you. Pick the time that works for you:\n${slots.map((x) => `• ${x.label}`).join('\n')}\n(Pacific Time.)`;
  outbox.update((s) => { s.meetings ??= {}; s.meetings[meeting.meetingId] = { meetingId: meeting.meetingId, slots, audience, bookings: {}, byStudent: {}, createdAt: new Date().toISOString() }; s.pendingMeeting = null; });
  const r = await createPost({ operationId, kind: 'message', title: 'Meeting with the professor', text, audience, source: 'chat', verbatim: false, author: 'assistant', meeting });
  if (!r.body.lesson || r.body.ack?.status === 'rejected') return { action: 'error', reply: `Nothing was sent: ${r.body.ack?.reason ?? Object.values(r.body.errors ?? {})[0] ?? 'refused'}.`, post: null };
  return { action: 'post', kind: 'message', post: { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) }, reply: `Sent ${who} ${slots.length === 1 ? 'this time' : `${slots.length} times to choose from`}: ${slots.map((x) => x.label).join('; ')}. You’ll see the choice here.` };
}

function checkPost(d, said, roster, recentChat) {
  const professorWords = [said, ...recentChat.filter((t) => t.role === 'professor').map((t) => t.text)];
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
  if (!seed && verbatim && !professorWords.some((w) => norm(w).includes(norm(text)))) verbatim = false;
  const allowedDates = new Set([...professorWords.flatMap((w) => datesIn(w)), ...(seed ? datesIn(text) : [])]);
  const invented = datesIn(text).filter((x) => !allowedDates.has(x));
  if (invented.length) return { problem: 'I’d have had to add a date you didn’t give, so I didn’t send it. Could you include the date, or write the message the way you want it?', code: 'invented_date' };
  if (!title) title = text.split(/[.!?\n]/)[0].slice(0, 60);
  return { post: { kind, audience, title: title.slice(0, 120), text, verbatim, seedId: seed?.seedId ?? null }, corrected };
}

function authorRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  // The professor's console state: course, roster (from the Hub's trusted data), seeded lessons, and every
  // posted lesson with its delivery state from the Hub.
  router.get('/author/state', async (req, res) => {
    // Re-send anything whose outcome at the Hub is unknown — with its SAME operation id (the Hub dedupes).
    // Only posts the Hub never confirmed receiving; once accepted, delivery to the student is the Hub's job.
    for (const l of Object.values(outbox.get().lessons)) if (!l.hubAccepted && ['uncertain', 'not_delivered'].includes(l.hubStatus)) await publish(l);
    const hub = await hubView();
    res.json({ course: COURSE, roster: hub?.courses?.find((c) => c.courseId === COURSE.courseId) ?? null, hubReachable: Boolean(hub), seeds: SEED_LESSONS, lessons: postsView(hub), chat: outbox.get().chat });
  });
  // Demo reset (requested through the Hub when the Student starts a new conversation): the posted list
  // and the remembered conversations go; the professor sends again. (The browser keeps any unsent draft.)
  router.post('/author/reset', (req, res) => {
    outbox.update((s) => { s.lessons = {}; s.operations = {}; s.chat = []; s.chatOps = {}; s.meetings = {}; s.pendingMeeting = null; });
    resetGeneration += 1;
    recent.clear();
    emitViz('lessons_reset', null, {});
    res.json({ status: 'reset' });
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
  return router;
}

// ---- server ----------------------------------------------------------------------------------------------
function buildAgentCard(port) {
  return {
    name: 'Marketing 101 Professor',
    description: 'The professor of Marketing 101, a fictional introductory course (not an official CSUF course): explains introductory marketing concepts, discusses course lessons, works through examples, and helps students check their understanding. Posts lessons and course messages to one enrolled student or the whole class through the university.',
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
      await Promise.race([hubLink?.stop(), new Promise((r) => setTimeout(r, 800))]);
      process.exit(0);
    });
  }
  log(`listening on ${baseUrl}`);
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = professorStatus();
  log(`mode: ${s.mode} (${s.model})${s.mode === 'live' ? `, API key (${keyEnvName()}): ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}`);
}
