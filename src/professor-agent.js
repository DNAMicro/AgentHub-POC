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
import { PROFESSOR_MODE, professorReply, professorStatus } from './professor-model.js';
import { createJsonStore } from './json-store.js';
import { ID, LESSON_PUBLISH_MEDIA_TYPE, LESSON_STATUS_MEDIA_TYPE, contentHash, validateLesson } from './lessons.js';

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
const outbox = createJsonStore(process.env.PROFESSOR_OUTBOX_FILE ?? 'data/professor-outbox.json', { lessons: {}, operations: {} });
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
  const lesson = stored && stored.recipient === student ? stored : null;
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
  emitViz('lesson_posted', null, { lessonId: record.lessonId, revision: record.revision, operationId: record.operationId });
  const ack = await hubLink.sendSigned(LESSON_PUBLISH_MEDIA_TYPE,
    { type: 'lesson_publish', operationId: record.operationId, lessonId: record.lessonId, revision: record.revision, courseId: record.courseId, recipient: record.recipient, title: record.title, text: record.text },
    ['publish', record.operationId, record.lessonId, record.revision, record.courseId, record.recipient, contentHash(record.title, record.text)]);
  outbox.update((s) => {
    Object.assign(s.lessons[lessonKey(record.lessonId, record.revision)], {
      hubStatus: ack.status, hubReason: ack.reason ?? null, hubAccepted: Boolean(ack.deliveryId) || Boolean(s.lessons[lessonKey(record.lessonId, record.revision)].hubAccepted), deliveryId: ack.deliveryId ?? s.lessons[lessonKey(record.lessonId, record.revision)].deliveryId ?? null, updatedAt: new Date().toISOString(),
    });
  });
  emitViz('lesson_publish_result', null, { lessonId: record.lessonId, revision: record.revision, status: ack.status, reason: ack.reason ?? null, duplicate: Boolean(ack.duplicate) });
  return ack;
}

async function hubView() {
  const nonce = randomUUID();
  const r = await hubLink.sendSigned(LESSON_STATUS_MEDIA_TYPE, { type: 'lesson_status', nonce }, ['status', nonce]).catch(() => null);
  return r?.status === 'ok' ? r : null;
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
    const deliveries = new Map((hub?.deliveries ?? []).map((d) => [`${d.lessonId}#${d.revision}`, d]));
    const lessons = Object.values(outbox.get().lessons).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((l) => {
      const d = deliveries.get(lessonKey(l.lessonId, l.revision));
      return { ...l, delivery: d ? { state: d.state, opened: Boolean(d.openedAt), openedAt: d.openedAt, deliveredAt: d.deliveredAt, lastError: d.lastError, attempts: d.attempts } : null };
    });
    res.json({ course: COURSE, roster: hub?.courses?.find((c) => c.courseId === COURSE.courseId) ?? null, hubReachable: Boolean(hub), seeds: SEED_LESSONS, lessons });
  });
  // Post one lesson (only when the professor pressed “Post lesson”). Stable operation id per press.
  router.post('/author/lessons', async (req, res) => {
    const { operationId, title = '', text, recipient, courseId = COURSE.courseId, lessonId = null } = req.body ?? {};
    if (typeof operationId !== 'string' || !ID.test(operationId)) return res.status(400).json({ errors: { _form: 'Missing or malformed operation id.' } });
    if (typeof recipient !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(recipient)) return res.status(400).json({ errors: { recipient: 'Choose an enrolled student.' } });
    const v = validateLesson({ title, text });
    if (!v.ok) return res.status(400).json({ errors: v.errors });
    const prior = outbox.get().operations[operationId];
    if (prior) {
      // A repeated press/request: the same lesson — never a second one. Different content → refused.
      const l = outbox.get().lessons[prior];
      if (l.title !== v.values.title || l.text !== v.values.text || l.recipient !== recipient) return res.status(409).json({ errors: { _form: 'This post was already sent with different content.' } });
      return res.json({ lesson: l, duplicate: true });
    }
    if (lessonId !== null && (typeof lessonId !== 'string' || !ID.test(lessonId))) return res.status(400).json({ errors: { _form: 'Malformed lesson id.' } });
    const previous = lessonId ? Object.values(outbox.get().lessons).filter((l) => l.lessonId === lessonId) : [];
    if (lessonId && !previous.length) return res.status(404).json({ errors: { _form: 'Unknown lesson to revise.' } });
    const record = {
      lessonId: lessonId ?? `ls-${randomUUID().slice(0, 12)}`, revision: previous.length + 1, operationId, courseId, recipient,
      title: v.values.title, text: v.values.text, createdAt: new Date().toISOString(), hubStatus: 'sending', hubReason: null, deliveryId: null,
    };
    outbox.update((s) => {
      s.lessons[lessonKey(record.lessonId, record.revision)] = record;
      s.operations[operationId] = lessonKey(record.lessonId, record.revision);
    });
    const ack = await publish(record);
    res.status(ack.status === 'rejected' ? 422 : 200).json({ lesson: outbox.get().lessons[lessonKey(record.lessonId, record.revision)], ack: { status: ack.status, reason: ack.reason ?? null, accepted: Boolean(ack.deliveryId) } });
  });
  return router;
}

// ---- server ----------------------------------------------------------------------------------------------
function buildAgentCard(port) {
  return {
    name: 'Marketing 101 Professor',
    description: 'The professor of Marketing 101, a fictional introductory course (not an official CSUF course): explains introductory marketing concepts, discusses course lessons, works through examples, and helps students check their understanding. Posts lessons to enrolled students through the university.',
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
