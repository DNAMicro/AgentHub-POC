// Process and event-stream helpers for the integration tests.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function startProcess(script, env, readyPattern) {
  // HUB_URL defaults to a closed port so a test specialist never registers with a real local Hub.
  const proc = spawn(process.execPath, [script], { env: { HUB_URL: 'http://127.0.0.1:9', ...process.env, ...env } });
  let output = '';
  proc.stdout.on('data', (c) => (output += c));
  proc.stderr.on('data', (c) => (output += c));
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on('data', () => {
      const m = output.match(readyPattern);
      if (m) resolve(m[1]);
    });
    proc.on('exit', (code) => reject(new Error(`${script} exited early (${code}):\n${output}`)));
  });
  return { proc, ready, output: () => output };
}

export const TUTOR_READY = /listening on (http:\/\/127\.0\.0\.1:\d+)/;
export const UI_READY = /\[UI\] listening on (http:\/\/127\.0\.0\.1:\d+)/;

export async function startTutor(env = {}) {
  const tutor = startProcess('src/tutor-agent.js', { PORT: '0', ...env }, TUTOR_READY);
  tutor.url = await tutor.ready;
  return tutor;
}

// Part 7: the Student UI connects only to the university Hub.
// Part 9: every test process gets its own data files (never the demo's data/*.json).
const tempFile = (name) => join(mkdtempSync(join(tmpdir(), 'a2a-')), name);
export async function startUi(hubUrl, env = {}) {
  const ui = startProcess('src/ui-server.js', { UI_PORT: '0', HUB_URL: hubUrl, STUDENT_INBOX_FILE: tempFile('inbox.json'), ...env }, UI_READY);
  ui.url = await ui.ready;
  return ui;
}

export const HUB_READY = /\[Hub\] listening on (http:\/\/127\.0\.0\.1:\d+)/;
export async function startHub(env = {}) {
  // CHRS_URL defaults to a closed port, so a test Hub never follows a real CHRS on 41248.
  const hub = startProcess('src/hub-agent.js', { PORT: '0', CHRS_URL: 'http://127.0.0.1:9', HUB_LESSON_FILE: tempFile('hub-lessons.json'), HUB_TEST_STUDENTS_WITHOUT_ENDPOINT: '1', ...env }, HUB_READY);
  hub.url = await hub.ready;
  return hub;
}

export async function waitFor(check, { timeout = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Minimal SSE reader for the browser-facing /api/events stream.
// headers: e.g. { 'Last-Event-ID': '<bootId>:<seq>' } to resume like a reconnecting EventSource.
export async function openStream(baseUrl, headers = {}) {
  const abort = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, { signal: abort.signal, headers });
  const stream = { events: [], hello: null, truncated: null, close: () => abort.abort() };
  (async () => {
    let buffer = '';
    try {
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, end).split('\n');
          buffer = buffer.slice(end + 2);
          const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
          if (!data) continue;
          if (lines.includes('event: hello')) stream.hello = JSON.parse(data);
          else if (lines.includes('event: replayed')) stream.replayed = (stream.replayed ?? 0) + 1;
          else if (lines.includes('event: truncated')) stream.truncated = JSON.parse(data);
          else stream.events.push(JSON.parse(data));
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return stream;
}

export async function unusedPort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

export const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

export const forRun = (events, runId) => events.filter((e) => e.runId === runId);
export const find = (events, source, type) => events.find((e) => e.source === source && e.type === type);
export const findAll = (events, source, type) => events.filter((e) => e.source === source && e.type === type);
export const stateOf = (events, runId) => forRun(events, runId).filter((e) => e.type === 'state').at(-1)?.data.state;

export const LIBRARY_READY = /\[Library Agent\] listening on (http:\/\/127\.0\.0\.1:\d+)/;

export const PROFESSOR_READY = /\[Marketing 351 Faculty\] listening on (http:\/\/127\.0\.0\.1:\d+)/;
export async function startProfessor(env = {}) {
  const professor = startProcess('src/professor-agent.js', { PORT: '0', PROFESSOR_OUTBOX_FILE: tempFile('outbox.json'), ...env }, PROFESSOR_READY);
  professor.url = await professor.ready;
  return professor;
}

// Loans (Part 8) live in the Library's memory: every test Library starts from the same fresh sample loans.
export async function startLibrary(env = {}) {
  const library = startProcess('src/library-agent.js', { PORT: '0', ...env }, LIBRARY_READY);
  library.url = await library.ready;
  return library;
}

// HR (staff only): time-off requests; its records live in memory, so every test HR starts fresh.
export const HR_READY = /\[HR Agent\] listening on (http:\/\/127\.0\.0\.1:\d+)/;
// PEOPLESOFT_URL defaults to a closed port, so a test HR never reaches a real PeopleSoft on 41246.
export async function startHr(env = {}) {
  const hr = startProcess('src/hr-agent.js', { PORT: '0', PEOPLESOFT_URL: 'http://127.0.0.1:9', ...env }, HR_READY);
  hr.url = await hr.ready;
  return hr;
}

// CHRS (staff only, Part 17): class rosters; no records of its own. STUDENT_RECORDS_URL defaults to a closed port, so a
// test CHRS never reaches a real student-records server on 41249.
export const CHRS_READY = /\[Campus Agent\] listening on (http:\/\/127\.0\.0\.1:\d+)/;
export async function startChrs(env = {}) {
  const chrs = startProcess('src/chrs-agent.js', { PORT: '0', STUDENT_RECORDS_URL: 'http://127.0.0.1:9', ...env }, CHRS_READY);
  chrs.url = await chrs.ready;
  return chrs;
}

// PeopleSoft stand-in MCP server (Part 15): token required; records in memory.
export const PEOPLESOFT_READY = /PeopleSoft CHRS \(HR\) MCP server \(demo stand-in\) listening on (http:\/\/127\.0\.0\.1:\d+)/;
export async function startPeopleSoft(env = {}) {
  const ps = startProcess('src/peoplesoft-mcp.js', { PORT: '0', ...env }, PEOPLESOFT_READY);
  ps.url = await ps.ready;
  return ps;
}

// PeopleSoft student records stand-in MCP server (Part 17): token required; roster in memory.
export const STUDENT_RECORDS_READY = /PeopleSoft Campus Solutions MCP server \(demo stand-in\) listening on (http:\/\/127\.0\.0\.1:\d+)/;
export async function startStudentRecords(env = {}) {
  const sr = startProcess('src/student-records-mcp.js', { PORT: '0', ...env }, STUDENT_RECORDS_READY);
  sr.url = await sr.ready;
  return sr;
}

// Canvas LMS stand-in MCP server (Part 16): token required; quizzes in memory.
export const CANVAS_READY = /Canvas LMS MCP server \(demo stand-in\) listening on (http:\/\/127\.0\.0\.1:\d+)/;
export async function startCanvas(env = {}) {
  const canvas = startProcess('src/canvas-mcp.js', { PORT: '0', ...env }, CANVAS_READY);
  canvas.url = await canvas.ready;
  return canvas;
}

// Stop a test process and wait until it is gone. A process that already exited (or was killed by a
// signal: exitCode stays null, signalCode is set) is not awaited again.
export async function stopProcess(p) {
  if (!p || p.proc.exitCode !== null || p.proc.signalCode !== null) return;
  const gone = once(p.proc, 'exit');
  p.proc.kill();
  await gone;
}

// Part 7: the whole stack — Hub, Tutor, Library and the Student UI. The specialists' ports are picked
// first so the Hub's configuration (its trusted endpoints) can name them; the specialists then register
// with the Hub. Pass tutorPort/libraryPort to restart a specialist on the same trusted endpoint.
// library: false starts only the Tutor (the Library stays registered-but-absent, i.e. disconnected).
// readyAgents: which specialists must be 'ready' before returning (e.g. ['tutor'] when the Library is disabled).
// Part 9: professor: true also starts the Marketing 351 Faculty. The UI (Student) port is pre-picked
// too, so the Hub's configuration names the Student's inbound endpoint before it starts.
// HR: hr: true also starts the HR Agent (with HR_TEST_HOOKS=1). Its port is always pre-picked, so a test
// Hub never follows a real HR on the default port.
// Part 15: hr: true also starts the PeopleSoft stand-in first, on its own pre-picked port with a random token
// given to both PeopleSoft and HR (HR never points at the real 41246). It is killed with the stack.
export async function startStack({ tutorEnv = {}, libraryEnv = {}, hubEnv = {}, uiEnv = {}, professorEnv = {}, hrEnv = {}, peoplesoftEnv = {}, canvasEnv = {}, chrsEnv = {}, studentRecordsEnv = {}, library = true, professor = false, hr = false, canvas = false, chrs: chrsOpt, now = null, tutorPort, libraryPort, professorPort, hrPort, chrsPort, uiPort, waitReady = true, readyAgents } = {}) {
  // Part 17: a post to the class is addressed from CHRS's roster, so a stack with the Faculty agent starts CHRS (and the
  // student-records stand-in) too, unless chrs: false (a test of the roster_unavailable refusal).
  const chrs = chrsOpt ?? professor;
  const tPort = tutorPort ?? (await unusedPort());
  const lPort = libraryPort ?? (await unusedPort());
  const pPort = professorPort ?? (await unusedPort());
  const hPort = hrPort ?? (await unusedPort());
  const cPort = chrsPort ?? (await unusedPort());
  const uPort = uiPort ?? (await unusedPort());
  const hub = await startHub({ TUTOR_URL: `http://127.0.0.1:${tPort}`, LIBRARY_URL: `http://127.0.0.1:${lPort}`, PROFESSOR_URL: `http://127.0.0.1:${pPort}`, HR_URL: `http://127.0.0.1:${hPort}`, CHRS_URL: `http://127.0.0.1:${cPort}`, STUDENT_URL: `http://127.0.0.1:${uPort}`, HEARTBEAT_EXPIRY_MS: '3000', HUB_DELIVER_RETRY_MS: '500', ...hubEnv });
  const specialistEnv = { HUB_URL: hub.url, HEARTBEAT_INTERVAL_MS: '500' };
  const tutor = await startTutor({ ...specialistEnv, PORT: String(tPort), ...tutorEnv });
  const lib = library ? await startLibrary({ ...specialistEnv, PORT: String(lPort), ...libraryEnv }) : null;
  // Part 16: canvas: true starts the Canvas stand-in first, on its own pre-picked port with a random token (both given to
  // the Faculty agent). Without it the Faculty agent points at the closed port 9, never a real Canvas on 41247.
  // now: an ISO instant that pins the Faculty agent's clock, the UI server's quiz check and Canvas's clock together.
  const canvasToken = canvas ? (await import('node:crypto')).randomBytes(24).toString('base64url') : null;
  const clockEnv = now ? { PROFESSOR_TEST_HOOKS: '1', PROFESSOR_NOW: now } : {};
  const canvasProc = canvas ? await startCanvas({ PORT: String(await unusedPort()), CANVAS_TOKEN: canvasToken, CANVAS_TEST_HOOKS: '1', ...(now ? { CANVAS_NOW: now } : {}), ...canvasEnv }) : null;
  const prof = professor ? await startProfessor({ ...specialistEnv, PORT: String(pPort), CANVAS_URL: canvasProc ? canvasProc.url : 'http://127.0.0.1:9', ...(canvasToken ? { CANVAS_TOKEN: canvasToken } : {}), ...clockEnv, ...professorEnv }) : null;
  const psToken = hr ? (await import('node:crypto')).randomBytes(24).toString('base64url') : null;
  const ps = hr ? await startPeopleSoft({ PORT: String(await unusedPort()), PEOPLESOFT_TOKEN: psToken, PEOPLESOFT_TEST_HOOKS: '1', ...peoplesoftEnv }) : null;
  const hrAgent = hr ? await startHr({ ...specialistEnv, PORT: String(hPort), HR_TEST_HOOKS: '1', PEOPLESOFT_URL: ps.url, PEOPLESOFT_TOKEN: psToken, ...hrEnv }) : null;
  // Part 17: chrs: true starts the student-records stand-in first (own pre-picked port, random token given to it and CHRS only),
  // then CHRS. Without it the Hub still names CHRS's pre-picked port (nothing listens there; it never follows a real CHRS).
  const srToken = chrs ? (await import('node:crypto')).randomBytes(24).toString('base64url') : null;
  const sr = chrs ? await startStudentRecords({ PORT: String(await unusedPort()), STUDENT_RECORDS_TOKEN: srToken, STUDENT_RECORDS_TEST_HOOKS: '1', ...studentRecordsEnv }) : null;
  const chrsAgent = chrs ? await startChrs({ ...specialistEnv, PORT: String(cPort), CHRS_TEST_HOOKS: '1', STUDENT_RECORDS_URL: sr.url, STUDENT_RECORDS_TOKEN: srToken, ...chrsEnv }) : null;
  const ui = await startUi(hub.url, { UI_PORT: String(uPort), ...clockEnv, ...uiEnv });
  const stack = {
    hub, tutor, library: lib, professor: prof, hr: hrAgent, peoplesoft: ps, peoplesoftToken: psToken, chrs: chrsAgent, studentRecords: sr, studentRecordsToken: srToken, canvas: canvasProc, canvasToken, ui, tutorPort: tPort, libraryPort: lPort, professorPort: pPort, hrPort: hPort, chrsPort: cPort, uiPort: uPort, specialistEnv,
    // Uses the stack's current processes, so a test that restarts one (stack.library = …) still cleans up.
    // kill() on a process that already exited (e.g. PeopleSoft stopped by a test) does nothing.
    kill() { [this.ui, this.tutor, this.library, this.professor, this.hr, this.peoplesoft, this.chrs, this.studentRecords, this.canvas, this.hub].filter(Boolean).forEach((p) => p.proc.kill()); },
  };
  const mustBeReady = readyAgents ?? [...(library ? ['tutor', 'library'] : ['tutor']), ...(professor ? ['professor'] : []), ...(hr ? ['hr'] : []), ...(chrs ? ['chrs'] : [])];
  if (waitReady) {
    await waitFor(async () => {
      const s = await status(ui);
      const ready = (id) => s.topology?.specialists?.find((x) => x.agentId === id)?.status === 'ready';
      // The UI learns state from the Hub's telemetry snapshot (sent on connect); poll the Hub directly too.
      const t = await (await fetch(`${hub.url}/viz/topology`)).json();
      const hubReady = (id) => t.specialists.find((x) => x.agentId === id)?.status === 'ready';
      // …and the Hub must be following each specialist's telemetry, or early events would be missed.
      return s.hubFeedConnected && s.university.cardValid && s.student?.session === 'registered' && mustBeReady.every((id) => hubReady(id) && t.feeds[id]) && (!library || t.feeds.library) && (ready('tutor') || hubReady('tutor'));
    }, { what: 'stack ready', timeout: 8000 }).catch((err) => {
      stack.kill(); // never leave processes behind (they would keep the test runner alive)
      throw err;
    });
  }
  return stack;
}
export const startTrio = startStack;

export const status = async (ui) => (await fetch(`${ui.url}/api/status`)).json();
// The Hub's private registry view (developer telemetry endpoint).
export const hubEntry = async (hub, agentId) => (await (await fetch(`${hub.url}/viz/topology`)).json()).specialists.find((s) => s.agentId === agentId);
export const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Ask through the browser-facing API and wait for the run to finish.
export async function chatVia(ui, stream, text, contextId) {
  const res = await post(`${ui.url}/api/runs`, { text, contextId });
  if (res.status !== 202) throw new Error(`POST /api/runs → ${res.status}`);
  const { runId, contextId: ctx } = await res.json();
  await waitFor(() => ['completed', 'failed', 'uncertain'].includes(stateOf(stream.events, runId)), { what: `run ${runId}` });
  // Agents' feed events travel separately from the A2A reply; wait for the destination's own reply event.
  const routed = find(forRun(stream.events, runId), 'hub', 'route_decided')?.data;
  const target = routed?.decision === 'route' ? routed.agentId : null;
  if (target) await waitFor(() => find(forRun(stream.events, runId), target, 'reply_published') || find(forRun(stream.events, runId), target, 'form_sent') || stateOf(stream.events, runId) !== 'completed', { what: 'agent reply event' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 40));
  const events = forRun(stream.events, runId);
  return {
    runId, contextId: ctx, events,
    decision: find(events, 'hub', 'route_decided')?.data,
    reply: find(events, 'student', 'reply_received')?.data,
    destinations: ['tutor', 'library', 'professor'].filter((a) => find(events, a, 'message_received')),
  };
}

// ---- Part 6: forms the agents send ---------------------------------------------------------

// Ask in chat; resolves with the form_received event data (or null if the reply wasn't a form).
export async function formVia(ui, stream, text, contextId) {
  const r = await chatVia(ui, stream, text, contextId);
  return { ...r, form: find(r.events, 'student', 'form_received')?.data ?? null };
}

export const formAction = (ui, formId, name, button, context = {}, operationId = crypto.randomUUID()) =>
  post(`${ui.url}/api/forms/${formId}/actions`, { operationId, action: { name, surfaceId: formId, sourceComponentId: button, timestamp: new Date().toISOString(), context } });

export const lifecycleOf = (events, formId) => events.filter((e) => e.type === 'form_lifecycle' && e.data.formId === formId).map((e) => e.data.state);
export const lastLifecycle = (events, formId) => events.filter((e) => e.type === 'form_lifecycle' && e.data.formId === formId).at(-1)?.data;
export const waitLifecycle = (stream, formId, states, timeout = 5000) =>
  waitFor(() => states.includes(lastLifecycle(stream.events, formId)?.state), { timeout, what: `form ${formId} in ${states}` });
export const actionResults = (events, formId, name) => events.filter((e) => e.source === 'student' && e.type === 'form_action_result' && e.data.formId === formId && (!name || e.data.actionName === name));

// Part 9: a test student that talks to the Hub directly with its own signed session. Only for students
// WITHOUT a configured inbound endpoint (the demo student's endpoint is the UI, which holds its session).
export async function signedStudent(hubUrl, studentId) {
  const { randomBytes, randomUUID: uuid } = await import('node:crypto');
  const { sendData } = await import('../../src/a2a-data.js');
  const { sign, STUDENT_SESSION_MEDIA_TYPE } = await import('../../src/lessons.js');
  const callKey = randomBytes(32).toString('base64url');
  const r = await sendData(hubUrl, { mediaType: STUDENT_SESSION_MEDIA_TYPE, value: { type: 'student_session', studentId, instanceId: uuid(), endpoint: null, callKey } });
  if (r.value?.status !== 'registered') throw new Error(`test student ${studentId} not registered: ${JSON.stringify(r)}`);
  return { metadata: { studentId }, signer: ({ contextId, messageId }) => sign(callKey, [studentId, contextId, messageId]) };
}

// HR (staff path): a test stand-in for the Professor agent's Hub link. It serves a minimal valid card on
// the Professor's trusted port (stack.professorPort, already in the Hub's configuration) and REGISTERS
// with the Hub through the real createHubLink, so it legitimately owns the callKey the Hub verifies its
// signed staff parts with — no key is faked and no production route is added. Use it with
// startStack({ professor: false }) (the real Professor would hold that identity). The card has no
// skills, so the Hub keeps it 'disabled' and never dispatches student questions or course notices to it.
export async function professorStandIn(stack) {
  const { default: express } = await import('express');
  const { createHubLink } = await import('../../src/hub-link.js');
  const base = `http://127.0.0.1:${stack.professorPort}`;
  const app = express();
  app.get('/.well-known/agent-card.json', (req, res) => res.json({
    name: 'Marketing 351 Faculty', description: 'Test stand-in (registers and signs staff requests only).', version: '0.0.0',
    supportedInterfaces: [{ url: `${base}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    capabilities: { streaming: false, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [], signatures: [],
  }));
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(stack.professorPort, '127.0.0.1', (err) => (err ? reject(err) : resolve(s)));
  });
  const link = createHubLink({ agentId: 'professor', hubUrl: stack.hub.url, endpoint: `${base}/a2a/jsonrpc`, cardUrl: `${base}/.well-known/agent-card.json`, enabled: true, heartbeatIntervalMs: 500 });
  await link.start();
  if (!link.state.registered) {
    server.close();
    throw new Error(`professor stand-in not registered: ${link.state.lastError}`);
  }
  return { link, close: async () => { await link.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); } };
}

// Part 17: a stand-in Hub (a real A2A server) whose only job is to accept a specialist's registration and keep the
// per-process key it gave, so a test can sign exactly what the real Hub would (staff parts, roster lookups).
// keyOf(agentId) -> the callKey, or null before it registered.
export async function standInHub() {
  const { randomUUID: uuid } = await import('node:crypto');
  const { default: express } = await import('express');
  const { Role } = await import('@a2a-js/sdk');
  const { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } = await import('@a2a-js/sdk');
  const { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } = await import('@a2a-js/sdk/server');
  const { agentCardHandler, jsonRpcHandler, UserBuilder } = await import('@a2a-js/sdk/server/express');
  const keys = new Map();
  const executor = {
    async execute(ctx, bus) {
      const v = ctx.userMessage.parts.find((p) => p.content?.$case === 'data')?.content.value;
      if (v?.callKey) keys.set(v.agentId, v.callKey);
      const status = v?.type === 'agent_register' ? 'registered' : 'ok';
      bus.publish(AgentEvent.message({ messageId: uuid(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [{ content: { $case: 'data', value: { status } }, metadata: undefined, filename: '', mediaType: 'application/json' }], metadata: undefined, extensions: [], referenceTaskIds: [] }));
      bus.finished();
    },
    async cancelTask() {},
  };
  const app = express();
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve(s))); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const card = { name: 'Stand-in Hub', description: 'test', version: '0', supportedInterfaces: [{ url: `${url}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }], capabilities: { streaming: false, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [], signatures: [] };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 0 } }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return { url, keyOf: (agentId) => keys.get(agentId) ?? null, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}
