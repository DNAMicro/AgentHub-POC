// Process and event-stream helpers for the integration tests.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

export function startProcess(script, env, readyPattern) {
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
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

export async function startUi(tutorUrl, env = {}) {
  const ui = startProcess('src/ui-server.js', { UI_PORT: '0', TUTOR_URL: tutorUrl, ...env }, UI_READY);
  ui.url = await ui.ready;
  return ui;
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
export async function openStream(baseUrl) {
  const abort = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, { signal: abort.signal });
  const stream = { events: [], hello: null, close: () => abort.abort() };
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

export async function startLibrary(env = {}) {
  const library = startProcess('src/library-agent.js', { PORT: '0', ...env }, LIBRARY_READY);
  library.url = await library.ready;
  return library;
}

// Tutor + Library + UI (Student) wired together with a known Student A2A endpoint port.
// Agents notify that endpoint; pass studentPort to reuse a port across restarts.
export async function startTrio({ tutorEnv = {}, libraryEnv = {}, uiEnv = {}, studentPort } = {}) {
  const port = studentPort ?? (await unusedPort());
  const studentUrl = `http://127.0.0.1:${port}`;
  const tutor = await startTutor({ STUDENT_A2A_URL: studentUrl, ...tutorEnv });
  const library = await startLibrary({ STUDENT_A2A_URL: studentUrl, ...libraryEnv });
  const ui = await startUi(tutor.url, { LIBRARY_URL: library.url, STUDENT_A2A_PORT: String(port), ...uiEnv });
  await waitFor(async () => {
    const s = await (await fetch(`${ui.url}/api/status`)).json();
    return s.registry.every((r) => r.status === 'ok') && s.agents.tutor.feedConnected && s.agents.library.feedConnected;
  }, { what: 'registry ready' });
  return { tutor, library, ui, studentUrl, kill: () => [ui, tutor, library].forEach((p) => p.proc.kill()) };
}

export const status = async (ui) => (await fetch(`${ui.url}/api/status`)).json();
export const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Ask through the browser-facing API and wait for the run to finish.
export async function chatVia(ui, stream, text, contextId) {
  const res = await post(`${ui.url}/api/runs`, { text, contextId });
  if (res.status !== 202) throw new Error(`POST /api/runs → ${res.status}`);
  const { runId, contextId: ctx } = await res.json();
  await waitFor(() => ['completed', 'failed', 'uncertain'].includes(stateOf(stream.events, runId)), { what: `run ${runId}` });
  // Agents' feed events travel separately from the A2A reply; wait for the destination's own reply event.
  const routed = find(forRun(stream.events, runId), 'student', 'route_decided')?.data;
  const target = routed?.decision === 'route' ? routed.agentId : null;
  if (target) await waitFor(() => find(forRun(stream.events, runId), target, 'reply_published') || find(forRun(stream.events, runId), target, 'form_sent') || stateOf(stream.events, runId) !== 'completed', { what: 'agent reply event' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 40));
  const events = forRun(stream.events, runId);
  return {
    runId, contextId: ctx, events,
    decision: find(events, 'student', 'route_decided')?.data,
    reply: find(events, 'student', 'reply_received')?.data,
    destinations: ['tutor', 'library'].filter((a) => find(events, a, 'message_received')),
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
