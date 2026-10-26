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
