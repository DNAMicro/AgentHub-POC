// CHRS — a separate A2A service for university STAFF (a DEMO with synthetic records). It answers two typed data
// parts from the Hub (src/staff.js) and nothing else:
//   roster request  { type: 'roster_request', kind: 'roster', courseId?, purpose } with the Hub's STAFF signature (the same
//                   one HR verifies: hubLink.verifiedStaff, plus the signed purpose) -> data part { roster } (minimal: no
//                   email, no pronouns, IDs masked to the last 4 — review #5) or { text } (a plain failure).
//   roster lookup   { type: 'roster_lookup', courseId, instructorStaffId, purpose } signed by the HUB ITSELF
//                   (hubLink.verifiedRosterLookup) -> data part { studentIds, names, count } or { error, text }.
//                   Names are "First Last" for the Hub's delivery labels; the Hub gets only roster student IDs and names, never emails or CWIDs.
//   email notice    { type: 'email_notice', courseId, instructorStaffId, studentIds, title, text } signed by the HUB ITSELF
//                   (hubLink.verifiedEmailNotice; review C16) -> data part { results: { studentId: 'emailed' | 'failed' },
//                   emailed, failed } or { error, text }. CHRS reads each student's campus email on file from Campus
//                   Solutions (a fresh get_class_roster) and "sends" through the campus mail DEMO STAND-IN: an in-memory
//                   outbox in this process. No real email is ever sent; the addresses never leave CHRS.
// Anything else (a text message, an unsigned or wrongly signed part) gets "Campus Agent serves university staff only."
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
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { createSkillService } from './agent-settings.js';
import { loadSpecialistConfig } from './config.js';
import { createHubLink } from './hub-link.js';
import { apiHost, keyEnvName, useModel } from './llm.js';
import { createRecordsLink } from './chrs-records.js';
import { chrsStatus } from './chrs-model.js';
import { CHRS_REFUSED_TEXT, EMAIL_NOTICE_MEDIA_TYPE, ROSTER_FAILED_TEXT, ROSTER_LOOKUP_MEDIA_TYPE, ROSTER_REQUEST_MEDIA_TYPE, STAFF_ROSTER_PURPOSES } from './staff.js';
import { COURSE_ID } from './student-records-store.js';
import { TIMEOUTS } from './timeouts.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const VIZ_PATH = '/viz/events';
const CONFIG = loadSpecialistConfig('chrs');
useModel(CONFIG.model); // CHRS's own model and key variable (live mode: the tool choice only)
let hubLink = null;
let skillService = null;

const log = (...args) => console.log('[Campus Agent]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'chrs', type, runId, at: new Date().toISOString(), data });

const STUDENT_RECORDS_URL = process.env.STUDENT_RECORDS_URL ?? 'http://127.0.0.1:41249';
const records = createRecordsLink({ url: STUDENT_RECORDS_URL, token: process.env.STUDENT_RECORDS_TOKEN, emit: emitViz, timeoutMs: Number(process.env.STUDENT_RECORDS_TIMEOUT_MS ?? TIMEOUTS.chrsRecordsCallMs) });

export const CHRS_DEFAULT_SKILLS = {
  skills: [{
    id: 'class-roster', kind: 'answer', enabled: true, name: 'Class roster',
    description: 'Gives a course\'s own instructor the class roster (demo, synthetic records) from PeopleSoft Campus Solutions, and tells the Hub who is enrolled so it can send class notices. University staff only.',
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

// ---- campus mail: a DEMO STAND-IN (review C16) --------------------------------------------------------------------
// An in-memory outbox; nothing is ever sent anywhere. One email per (Hub operation, student): a re-sent notice never
// emails anyone twice. Cleared by the classroom reset (POST /dev/chrs/reset). Readable only by tests (GET /test/mail).
// CHRS_TEST_MAIL_FAIL (tests only, with CHRS_TEST_HOOKS=1): comma-separated student ids whose email "bounces".
const mail = { outbox: [], sent: new Map() }; // sent: `${operationId}|${studentId}` -> outbox entry
const bounces = () => (process.env.CHRS_TEST_HOOKS === '1' ? new Set(String(process.env.CHRS_TEST_MAIL_FAIL ?? '').split(',').filter(Boolean)) : new Set());
function sendCampusMail({ operationId, studentIds, rows, klass, title, text }) {
  const byId = new Map(rows.map((r) => [r.studentId, r]));
  const bounced = bounces();
  const results = {};
  const course = String(klass?.code ?? '').split(' - ')[0] || 'Your class';
  for (const studentId of studentIds) {
    const key = `${operationId}|${studentId}`;
    if (mail.sent.has(key)) { results[studentId] = 'emailed'; continue; }
    const row = byId.get(studentId);
    if (!row || typeof row.email !== 'string' || !row.email.includes('@') || bounced.has(studentId)) { results[studentId] = 'failed'; continue; }
    const entry = {
      id: `mail-${randomUUID().slice(0, 12)}`, operationId, studentId, to: row.email, subject: `${course}: ${title}`.slice(0, 200),
      body: `${text}\n\n${klass?.instructor ?? 'Your instructor'}, ${klass?.code ?? course}\n(You weren't online in the campus app, so this notice was emailed. It will also be in the app when you sign in.)`,
      at: new Date().toISOString(),
    };
    mail.outbox.push(entry);
    mail.sent.set(key, entry);
    results[studentId] = 'emailed';
  }
  return results;
}

// ---- review #5: data minimisation -------------------------------------------------------------------------------
// The roster that leaves this agent (toward the Hub and the Faculty agent) carries only what the faculty member's tasks
// need: the student id the app addresses, the name, the ID masked to its last 4 digits, units, program, plan, degree and
// academic level. Never an email, a full campus ID or pronouns: the records server already masks them
// (mask_private_fields), and this whitelist makes sure of it whatever came back. The email stays here, read fresh
// (includeEmail) only for the campus mail stand-in.
const LAST4 = (id) => { const d = String(id ?? '').replace(/\D/g, ''); return d.length >= 4 ? `•••••${d.slice(-4)}` : ''; };
const SAFE_MASK = /^•{5}\d{4}$/;
export function minimalRoster(roster) {
  return {
    class: roster.class,
    rows: roster.rows.map((r) => ({
      studentId: r.studentId,
      maskedId: typeof r.maskedId === 'string' && SAFE_MASK.test(r.maskedId) ? r.maskedId : LAST4(r.id),
      name: r.name, units: r.units, program: r.program, plan: r.plan, degree: r.degree, level: r.level,
    })),
  };
}

// Owner, 2026-11-06: what a student may learn about classmates — name, academic level, plan (major) and campus email.
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,128}$/;
export function classmatesRoster(roster) {
  return {
    class: roster.class,
    rows: roster.rows.map((r) => ({ studentId: r.studentId, name: r.name, level: r.level, plan: r.plan, ...(typeof r.email === 'string' && EMAIL_SHAPE.test(r.email) ? { email: r.email } : {}) })),
  };
}

// ---- review #7: the roster-read audit log --------------------------------------------------------------------------
// Every read of the class roster / class record records who (the staff id from the Hub's signature), which course and
// section, why (a purpose from a fixed set, signed with the request) and how many rows. In this process's memory only
// (cleared by the classroom reset, POST /dev/chrs/reset); never a name, email or ID. Tests read it at GET /test/audit.
const AUDIT_LIMIT = 1000;
const audit = [];
function logRead({ staffId, courseId, klass, purpose, rowCount, runId }) {
  const entry = { at: new Date().toISOString(), staffId, courseId, section: typeof klass?.code === 'string' ? klass.code : null, purpose, rowCount };
  audit.push(entry);
  if (audit.length > AUDIT_LIMIT) audit.splice(0, audit.length - AUDIT_LIMIT);
  log(`roster read logged: ${staffId} ${courseId} purpose=${purpose} rows=${rowCount}`);
  emitViz('roster_read_logged', runId, { purpose, rowCount, courseId });
}

// "Lastname,Firstname" (the records' own form) -> "Firstname Lastname".
const displayName = (row) => {
  const [last = '', first = ''] = String(row.name ?? '').split(',');
  return `${first.trim()} ${last.trim()}`.trim();
};

const chrsExecutor = {
  async execute(ctx, bus) {
    const incoming = ctx.userMessage;
    const runId = incoming.metadata?.runId ?? null;
    const part = incoming.parts.find((p) => p.content?.$case === 'data' && [ROSTER_REQUEST_MEDIA_TYPE, ROSTER_LOOKUP_MEDIA_TYPE, EMAIL_NOTICE_MEDIA_TYPE].includes(p.mediaType));
    const value = part?.content.value ?? null;
    const kind = !part ? 'text' : part.mediaType === ROSTER_LOOKUP_MEDIA_TYPE ? 'roster_lookup' : part.mediaType === EMAIL_NOTICE_MEDIA_TYPE ? 'email_notice' : 'roster_request';
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
      logRead({ staffId: checked.instructorStaffId, courseId: checked.courseId, klass: r.value.roster.class, purpose: checked.purpose, rowCount: rows.length, runId });
      const names = Object.fromEntries(rows.map((row) => [row.studentId, displayName(row)]));
      return send({ value: { studentIds: rows.map((row) => row.studentId), names, count: rows.length } }, 'lookup', { rosterCount: rows.length });
    }
    if (kind === 'email_notice') {
      // Review C16: only the Hub's own signature over exactly these students and this text counts.
      const checked = hubLink.verifiedEmailNotice(value, incoming.metadata);
      if (!checked || checked.title.length > 200 || checked.text.length > 8000) return refuse();
      const r = await records.roster(checked.courseId, checked.instructorStaffId, { runId, moment: 'email' });
      if (!r.ok) return send({ value: { error: 'roster_unavailable', text: ROSTER_FAILED_TEXT } }, r.outcome === 'refused' ? 'refused_by_records' : r.outcome);
      logRead({ staffId: checked.instructorStaffId, courseId: checked.courseId, klass: r.value.roster.class, purpose: 'email', rowCount: r.value.roster.rows.length, runId });
      const results = sendCampusMail({ ...checked, rows: r.value.roster.rows, klass: r.value.roster.class });
      const emailed = Object.values(results).filter((x) => x === 'emailed').length;
      const failed = checked.studentIds.length - emailed;
      emitViz('email_notice_sent', runId, { emailedCount: emailed, emailFailedCount: failed });
      return send({ value: { results, emailed, failed } }, 'emailed', { emailedCount: emailed, emailFailedCount: failed });
    }
    if (kind === 'roster_request') {
      // Review #7: the purpose is required and must be what the Hub signed (an unknown or missing one is refused).
      const purpose = value?.purpose;
      const staffId = STAFF_ROSTER_PURPOSES.includes(purpose) ? hubLink.verifiedStaff(incoming.metadata, ctx.contextId, purpose) : null;
      if (!staffId || value?.kind !== 'roster') return refuse();
      const courseId = COURSE_ID; // the request's courseId is not signed, so it is ignored: the configured course only
      // Owner, 2026-11-06: purpose 'classmates' (a student's question about classmates) reads the campus emails too
      // (moment 'email', includeEmail) and returns only name, year, major and email — never the ID, units or degree.
      const classmates = purpose === 'classmates';
      const r = await records.roster(courseId, staffId, { runId, ...(classmates ? { moment: 'email' } : {}) });
      if (!r.ok) return send({ value: { text: ROSTER_FAILED_TEXT } }, r.outcome === 'refused' ? 'refused_by_records' : r.outcome);
      logRead({ staffId, courseId, klass: r.value.roster.class, purpose, rowCount: r.value.roster.rows.length, runId });
      return send({ value: { roster: classmates ? classmatesRoster(r.value.roster) : minimalRoster(r.value.roster) } }, 'roster', { rosterCount: r.value.roster.rows.length });
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
    name: 'Campus Agent',
    description: 'Staff services (demo, synthetic records): the class roster for a course\'s own instructor, from PeopleSoft Campus Solutions. University staff only.',
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
      // Demo reset (the classroom reset, asked by the Hub): the campus mail stand-in's outbox is forgotten. Server callers only.
      app.post('/dev/chrs/reset', sameOriginGuard(actualPort), (req, res) => {
        mail.outbox = [];
        mail.sent.clear();
        audit.length = 0; // review #7: the roster-read audit log goes with the classroom
        log('campus mail stand-in outbox cleared');
        res.json({ status: 'reset' });
      });
      // Test hook only: the records server's own state (its test hook).
      if (process.env.CHRS_TEST_HOOKS === '1') {
        // Review C16: what the campus mail stand-in "sent" (tests only; never logged, never relayed).
        app.get('/test/mail', (req, res) => res.json({ mail: mail.outbox }));
        app.get('/test/audit', (req, res) => res.json({ audit })); // review #7: the roster-read audit log
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
  log(`PeopleSoft Campus Solutions (demo stand-in, MCP): ${STUDENT_RECORDS_URL}/mcp, token (STUDENT_RECORDS_TOKEN): ${process.env.STUDENT_RECORDS_TOKEN ? 'configured' : 'NOT SET'}`);
  log('campus mail: demo stand-in (an in-memory outbox in this process; no real email is ever sent)');
}
