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
import { hostGuard } from './local-guard.js';
import { createSkillService } from './agent-settings.js';
import { loadSpecialistConfig } from './config.js';
import { createHubLink } from './hub-link.js';
import { LlmError, apiHost, keyEnvName, useModel } from './llm.js';
import { COURSE, PROFESSOR_DEFAULT_SKILLS, SEED_LESSONS } from './course-pack.js';
import { PROFESSOR_MODE, interpretProfessor, professorReply, professorStatus, tagsIn } from './professor-model.js';
import { datesIn } from './a2ui-catalog.js';
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
const outbox = createJsonStore(process.env.PROFESSOR_OUTBOX_FILE ?? 'data/professor-outbox.json', { lessons: {}, operations: {}, chat: [], chatOps: {} });
const lessonKey = (lessonId, revision) => `${lessonId}#${revision}`;
const recent = new Map(); // contextId → last few { question, answer }

// ---- answering students ------------------------------------------------------------------------------
const policy = () => ({ skills: skillService.policy().skills.filter((s) => s.kind === 'answer') });
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
  let text;
  try {
    const r = await professorReply({ question, policy: policy(), lesson, recent: recent.get(ctx.contextId) ?? [], emit: (type, data) => emitViz(type, runId, data) });
    text = r.text;
    metadata.professor = { outcome: r.kind, mode: PROFESSOR_MODE, model: r.model, usage: r.usage, lessonId: lesson?.lessonId ?? null, topics: r.topicIds };
  } catch (err) {
    const failure = err instanceof LlmError ? err : new LlmError('internal_error');
    text = `The Marketing 101 Professor could not answer: ${failure.message}`;
    metadata.serviceError = { code: failure.code, message: failure.message, requestId: failure.requestId };
  }
  const message = { messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [textPart(text)], metadata, extensions: [], referenceTaskIds: [] };
  bus.publish(AgentEvent.message(message));
  bus.finished();
  emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, text, professor: metadata.professor });
  recent.set(ctx.contextId, [...(recent.get(ctx.contextId) ?? []), { question, answer: text }].slice(-4));
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
    { type: 'lesson_publish', operationId: record.operationId, lessonId: record.lessonId, revision: record.revision, courseId: record.courseId, kind: record.kind, audience: record.audience, title: record.title, text: record.text },
    ['publish', record.operationId, record.lessonId, record.revision, record.courseId, record.kind, record.audience, contentHash(record.title, record.text, record.kind)]);
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
    deliveries: (byPost.get(lessonKey(l.lessonId, l.revision)) ?? []).map((d) => ({ studentId: d.studentId, state: d.state, opened: Boolean(d.openedAt), openedAt: d.openedAt, deliveredAt: d.deliveredAt, lastError: d.lastError, attempts: d.attempts })),
  }));
}

async function hubView() {
  const nonce = randomUUID();
  const r = await hubLink.sendSigned(LESSON_STATUS_MEDIA_TYPE, { type: 'lesson_status', nonce }, ['status', nonce]).catch(() => null);
  return r?.status === 'ok' ? r : null;
}

// ---- posting (shared by the typed API and the chat) -------------------------------------------------------
async function createPost({ operationId, kind = 'lesson', title = '', text, audience, courseId = COURSE.courseId, lessonId = null, source = 'api', verbatim = true, seedId = null }) {
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
async function professorChat({ operationId, text }) {
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
    outbox.update((s) => { s.chat.push({ id: `${operationId}:p`, role: 'professor', text: said, at }); });
    const hub = await hubView();
    const roster = (hub?.courses?.find((c) => c.courseId === COURSE.courseId)?.enrolled ?? []).map((st) => ({ studentId: st.studentId, name: st.name ?? st.studentId, online: st.online }));
    const nameOf = (id) => roster.find((x) => x.studentId === id)?.name ?? id;
    const posts = postsView(hub).map((l) => ({ title: l.title, kind: l.kind, audience: l.audience === 'all' ? 'all' : nameOf(l.audience), sentAt: l.createdAt, deliveries: l.deliveries.map((d) => ({ name: nameOf(d.studentId), state: d.state, opened: d.opened })) }));
    const recentChat = outbox.get().chat.slice(-8, -1);
    let decision;
    try {
      decision = await interpretProfessor({ text: said, roster, seeds: SEED_LESSONS, posts, recent: recentChat, emit: (type, data) => emitViz(type, null, data) });
    } catch (err) {
      decision = { action: 'error', reply: `I couldn't work that out right now (${err.message ?? 'model error'}). Nothing was sent.` };
    }
    const result = { reply: decision.reply, action: decision.action, post: null, check: null };
    if (decision.action === 'post') {
      const checked = checkPost(decision, said, roster, recentChat);
      if (checked.problem) {
        Object.assign(result, { action: 'clarify', reply: checked.problem, check: checked.code });
      } else {
        const r = await createPost({ operationId, ...checked.post, source: 'chat' });
        if (r.body.lesson && r.body.ack?.status !== 'rejected') {
          result.post = { key: lessonKey(r.body.lesson.lessonId, r.body.lesson.revision) };
          if (checked.corrected) result.reply = `${result.reply} (${checked.corrected})`;
        } else {
          Object.assign(result, { action: 'error', reply: `Nothing was sent: ${r.body.ack?.reason ?? Object.values(r.body.errors ?? {})[0] ?? 'refused'}.` });
        }
      }
    }
    outbox.update((s) => {
      s.chat.push({ id: `${operationId}:a`, role: 'assistant', text: result.reply, at: new Date().toISOString(), action: result.action, postKey: result.post?.key ?? null, model: decision.model ?? null });
      s.chat = s.chat.slice(-200);
      s.chatOps[operationId] = result;
    });
    emitViz('professor_chat', null, { action: result.action, check: result.check, kind: result.post ? decision.kind : null });
    return { http: 200, body: result };
  } finally {
    chatBusy = false;
  }
}

function checkPost(d, said, roster, recentChat) {
  const professorWords = [said, ...recentChat.filter((t) => t.role === 'professor').map((t) => t.text)];
  const { tagged, named } = tagsIn(said, roster);
  const allWords = /\b(everyone|everybody|all students|the class|whole class|all of you)\b/i.test(said);
  let audience = d.audience === 'all' || roster.some((x) => x.studentId === d.audience) ? d.audience : null;
  let corrected = null;
  // A tag the professor wrote is authoritative.
  if (tagged.length === 1 && !allWords && audience !== tagged[0].studentId) { audience = tagged[0].studentId; corrected = `sent to ${tagged[0].name}, whom you tagged`; }
  if (tagged.length > 1 && !allWords) return { problem: `You tagged ${tagged.map((x) => x.name).join(' and ')} — I can send to one student or the whole class. Which should it be?`, code: 'several_tagged' };
  if (!audience) return { problem: 'Who should get it — one student (tag them, like @alex) or the whole class?', code: 'unknown_audience' };
  if (audience !== 'all' && ![...tagged, ...named].some((x) => x.studentId === audience)) return { problem: `Should this go to ${roster.find((x) => x.studentId === audience)?.name ?? audience} only? Tag them (@${(roster.find((x) => x.studentId === audience)?.name ?? '').split(' ')[0].toLowerCase()}) or say “everyone”.`, code: 'untagged_student' };
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
    outbox.update((s) => { s.lessons = {}; s.operations = {}; s.chat = []; s.chatOps = {}; });
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
