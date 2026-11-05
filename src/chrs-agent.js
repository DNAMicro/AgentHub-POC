// CHRS — a separate A2A service for university STAFF (a DEMO with synthetic records). It answers two typed data
// parts from the Hub (src/staff.js) and nothing else:
//   roster request  { type: 'roster_request', kind: 'roster', courseId? } with the Hub's STAFF signature (the same
//                   one HR verifies: hubLink.verifiedStaff) -> data part { roster } or { text } (a plain failure).
//   roster lookup   { type: 'roster_lookup', courseId, instructorStaffId } signed by the HUB ITSELF
//                   (hubLink.verifiedRosterLookup) -> data part { studentIds, names, count } or { error, text }.
//                   Names are "First Last" for the Hub's delivery labels; the Hub gets only roster student IDs and names, never emails or CWIDs.
// Anything else (a text message, an unsigned or wrongly signed part) gets "CHRS serves university staff only."
//
// CHRS keeps no student records: it reaches the PeopleSoft student records stand-in (src/student-records-mcp.js)
// over MCP (src/chrs-records.js). Its AI chooses the tool, code checks the pick and builds the arguments; the
// instructor's staff id comes only from the Hub's signature, never from the words or the model.
//
// Telemetry carries ids, outcomes and counts (rosterCount) only; never a name, email or student ID.
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
import { apiHost, keyEnvName, useModel } from './llm.js';
import { createRecordsLink } from './chrs-records.js';
import { chrsStatus } from './chrs-model.js';
import { CHRS_REFUSED_TEXT, ROSTER_FAILED_TEXT, ROSTER_LOOKUP_MEDIA_TYPE, ROSTER_REQUEST_MEDIA_TYPE } from './staff.js';
import { COURSE_ID } from './student-records-store.js';
import { TIMEOUTS } from './timeouts.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const VIZ_PATH = '/viz/events';
const CONFIG = loadSpecialistConfig('chrs');
useModel(CONFIG.model); // CHRS's own model and key variable (live mode: the tool choice only)
let hubLink = null;
let skillService = null;

const log = (...args) => console.log('[CHRS]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'chrs', type, runId, at: new Date().toISOString(), data });

const STUDENT_RECORDS_URL = process.env.STUDENT_RECORDS_URL ?? 'http://127.0.0.1:41249';
const records = createRecordsLink({ url: STUDENT_RECORDS_URL, token: process.env.STUDENT_RECORDS_TOKEN, emit: emitViz, timeoutMs: Number(process.env.STUDENT_RECORDS_TIMEOUT_MS ?? TIMEOUTS.chrsRecordsCallMs) });

export const CHRS_DEFAULT_SKILLS = {
  skills: [{
    id: 'class-roster', kind: 'answer', enabled: true, name: 'Class roster',
    description: 'Gives a course\'s own instructor the class roster (demo, synthetic records) from PeopleSoft student records, and tells the Hub who is enrolled so it can send class notices. University staff only.',
    tags: ['roster', 'class list', 'enrolled students'],
    examples: ['Who is in my class?', 'Show me my class roster'],
    scope: { allowed: ['class rosters for the course\'s own instructor'], excluded: ['students', 'grades', 'changing records'] },
    knowledge: '',
  }],
};
const CHRS_RULES = { answer: { knowledge: 'optional' } };

// One typed data part (the Hub reads data parts) or, for a plain text message, one text part.
const reply = (ctx, { value, text }, metadata) => ({
  messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT,
  parts: [value
    ? { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' }
    : { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata, extensions: [], referenceTaskIds: [],
});

const ID = /^[\w-]{1,64}$/;
// "Lastname,Firstname" (the records' own form) -> "Firstname Lastname".
const displayName = (row) => {
  const [last = '', first = ''] = String(row.name ?? '').split(',');
  return `${first.trim()} ${last.trim()}`.trim();
};

const chrsExecutor = {
  async execute(ctx, bus) {
    const incoming = ctx.userMessage;
    const runId = incoming.metadata?.runId ?? null;
    const part = incoming.parts.find((p) => p.content?.$case === 'data' && [ROSTER_REQUEST_MEDIA_TYPE, ROSTER_LOOKUP_MEDIA_TYPE].includes(p.mediaType));
    const value = part?.content.value ?? null;
    const kind = !part ? 'text' : part.mediaType === ROSTER_LOOKUP_MEDIA_TYPE ? 'roster_lookup' : 'roster_request';
    const received = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId };
    log('received message', { ...received, kind });
    emitViz('message_received', runId, { ...received, kind });
    const send = (out, outcome, extra = {}) => {
      const message = reply(ctx, out, { ...(runId ? { runId } : {}), agentId: 'chrs', chrs: { outcome } });
      bus.publish(AgentEvent.message(message));
      bus.finished();
      log('sending reply', { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, outcome, ...extra });
      emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, outcome, chrsOutcome: outcome, ...extra });
    };
    const refuse = () => send(kind === 'text' ? { text: CHRS_REFUSED_TEXT } : { value: { text: CHRS_REFUSED_TEXT, error: 'refused' } }, 'refused');

    // Who may ask is decided by the Hub's signature on THIS request. Nothing else counts.
    if (kind === 'roster_lookup') {
      const checked = hubLink.verifiedRosterLookup(value, incoming.metadata);
      if (!checked) return refuse();
      const r = await records.roster(checked.courseId, checked.instructorStaffId, { runId });
      if (!r.ok) return send({ value: { error: 'roster_unavailable', text: ROSTER_FAILED_TEXT } }, r.outcome === 'refused' ? 'refused_by_records' : r.outcome);
      const rows = r.value.roster.rows;
      const names = Object.fromEntries(rows.map((row) => [row.studentId, displayName(row)]));
      return send({ value: { studentIds: rows.map((row) => row.studentId), names, count: rows.length } }, 'lookup', { rosterCount: rows.length });
    }
    if (kind === 'roster_request') {
      const staffId = hubLink.verifiedStaff(incoming.metadata, ctx.contextId);
      if (!staffId || value?.kind !== 'roster') return refuse();
      const courseId = typeof value.courseId === 'string' && ID.test(value.courseId) ? value.courseId : COURSE_ID;
      const r = await records.roster(courseId, staffId, { runId });
      if (!r.ok) return send({ value: { text: ROSTER_FAILED_TEXT } }, r.outcome === 'refused' ? 'refused_by_records' : r.outcome);
      return send({ value: { roster: r.value.roster } }, 'roster', { rosterCount: r.value.roster.rows.length });
    }
    return refuse();
  },
  async cancelTask() {},
};

function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ source: 'chrs', type: 'status', runId: null, at: new Date().toISOString(), data: { ...chrsStatus(), skills: skillService?.describe() ?? null } })}\n\n`);
  // A follower that connects after the link's startup warm-up still learns the session's current state.
  const session = records.sessionStatus();
  if (session) res.write(`data: ${JSON.stringify({ source: 'chrs', type: 'studentdb_session', runId: null, at: session.at, data: (({ at, ...d }) => d)(session) })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

function buildAgentCard(port) {
  return {
    name: 'CHRS',
    description: 'Staff services (demo, synthetic records): the class roster for a course\'s own instructor, from PeopleSoft student records. University staff only.',
    version: '0.1.0',
    supportedInterfaces: [{ url: `http://${HOST}:${port}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }],
    provider: undefined,
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [],
    signatures: [],
  };
}

export function startChrsServer({ port = 41248 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      const baseUrl = `http://${HOST}:${actualPort}`;
      const card = buildAgentCard(actualPort);
      skillService = createSkillService({
        agentId: 'chrs', agentName: card.name, defaults: CHRS_DEFAULT_SKILLS, rules: CHRS_RULES, card,
        emit: (type, data) => emitViz(type, null, data), log, notify: (n) => hubLink.notifyCardChanged(n),
      });
      hubLink = createHubLink({
        agentId: CONFIG.agentId, hubUrl: CONFIG.hub.url, endpoint: `${baseUrl}${JSONRPC_PATH}`, cardUrl: `${baseUrl}/${AGENT_CARD_PATH}`,
        enabled: CONFIG.enabled, heartbeatIntervalMs: CONFIG.heartbeatIntervalMs, log,
        emit: (type, data) => emitViz(type, null, data),
      });
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), chrsExecutor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get(VIZ_PATH, serveVizEvents);
      app.use(skillService.router());
      // Test hook only: the records server's own state (its test hook).
      if (process.env.CHRS_TEST_HOOKS === '1') {
        app.get('/test/records', async (req, res) => {
          try {
            res.json(await records.state());
          } catch {
            res.status(502).json({ error: 'student_records_unavailable' });
          }
        });
      }
      skillService.started(actualPort, `${baseUrl}/${AGENT_CARD_PATH}`);
      hubLink.start(); // retries until the Hub accepts the registration
      resolve({ server, baseUrl, hubLink });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41248 : Number(process.env.PORT);
  const { baseUrl } = await startChrsServer({ port });
  // Sign out from the Hub on shutdown (best effort; the Hub's heartbeat expiry covers a crash).
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await Promise.race([Promise.allSettled([hubLink?.stop(), records.close()]), new Promise((r) => setTimeout(r, 800))]);
      process.exit(0);
    });
  }
  log(`listening on ${baseUrl}`);
  records.warm(); // open the MCP session now (no tool call) so the pill is right after a restart
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = chrsStatus();
  log(`mode: ${s.mode} (${s.model})${s.mode === 'live' ? `, API key (${keyEnvName()}): ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}, staff only, synthetic records`);
  log(`Student records (demo stand-in, MCP): ${STUDENT_RECORDS_URL}/mcp, token (STUDENT_RECORDS_TOKEN): ${process.env.STUDENT_RECORDS_TOKEN ? 'configured' : 'NOT SET'}`);
}
