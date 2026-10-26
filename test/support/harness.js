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
  const hub = startProcess('src/hub-agent.js', { PORT: '0', HUB_LESSON_FILE: tempFile('hub-lessons.json'), ...env }, HUB_READY);
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

export const PROFESSOR_READY = /\[Marketing 101 Professor\] listening on (http:\/\/127\.0\.0\.1:\d+)/;
export async function startProfessor(env = {}) {
  const professor = startProcess('src/professor-agent.js', { PORT: '0', PROFESSOR_OUTBOX_FILE: tempFile('outbox.json'), ...env }, PROFESSOR_READY);
  professor.url = await professor.ready;
  return professor;
}

// Each test Library gets its own fresh loan store (Part 8), never the demo's data/library-loans.json.
export const freshLoanStore = () => join(mkdtempSync(join(tmpdir(), 'a2a-loans-')), 'loans.json');
export async function startLibrary(env = {}) {
  const library = startProcess('src/library-agent.js', { PORT: '0', LOAN_STORE_FILE: freshLoanStore(), ...env }, LIBRARY_READY);
  library.url = await library.ready;
  return library;
}

// Part 7: the whole stack — Hub, Tutor, Library and the Student UI. The specialists' ports are picked
// first so the Hub's configuration (its trusted endpoints) can name them; the specialists then register
// with the Hub. Pass tutorPort/libraryPort to restart a specialist on the same trusted endpoint.
// library: false starts only the Tutor (the Library stays registered-but-absent, i.e. disconnected).
// readyAgents: which specialists must be 'ready' before returning (e.g. ['tutor'] when the Library is disabled).
// Part 9: professor: true also starts the Marketing 101 Professor. The UI (Student) port is pre-picked
// too, so the Hub's configuration names the Student's inbound endpoint before it starts.
export async function startStack({ tutorEnv = {}, libraryEnv = {}, hubEnv = {}, uiEnv = {}, professorEnv = {}, library = true, professor = false, tutorPort, libraryPort, professorPort, uiPort, waitReady = true, readyAgents } = {}) {
  const tPort = tutorPort ?? (await unusedPort());
  const lPort = libraryPort ?? (await unusedPort());
  const pPort = professorPort ?? (await unusedPort());
  const uPort = uiPort ?? (await unusedPort());
  const hub = await startHub({ TUTOR_URL: `http://127.0.0.1:${tPort}`, LIBRARY_URL: `http://127.0.0.1:${lPort}`, PROFESSOR_URL: `http://127.0.0.1:${pPort}`, STUDENT_URL: `http://127.0.0.1:${uPort}`, HEARTBEAT_EXPIRY_MS: '3000', HUB_DELIVER_RETRY_MS: '500', ...hubEnv });
  const specialistEnv = { HUB_URL: hub.url, HEARTBEAT_INTERVAL_MS: '500' };
  const tutor = await startTutor({ ...specialistEnv, PORT: String(tPort), ...tutorEnv });
  const lib = library ? await startLibrary({ ...specialistEnv, PORT: String(lPort), ...libraryEnv }) : null;
  const prof = professor ? await startProfessor({ ...specialistEnv, PORT: String(pPort), ...professorEnv }) : null;
  const ui = await startUi(hub.url, { UI_PORT: String(uPort), ...uiEnv });
  const stack = {
    hub, tutor, library: lib, professor: prof, ui, tutorPort: tPort, libraryPort: lPort, professorPort: pPort, uiPort: uPort, specialistEnv,
    // Uses the stack's current processes, so a test that restarts one (stack.library = …) still cleans up.
    kill() { [this.ui, this.tutor, this.library, this.professor, this.hub].filter(Boolean).forEach((p) => p.proc.kill()); },
  };
  const mustBeReady = readyAgents ?? [...(library ? ['tutor', 'library'] : ['tutor']), ...(professor ? ['professor'] : [])];
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
