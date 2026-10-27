// Rehearsal stack for the live walkthrough: the five demo processes on their own ports with temp data
// files, so a rehearsal never touches the user's running demo (ports 4444, 41241-41244) or data/*.json.
//   node scripts/demo/rehearsal-stack.js --ui 5444 --base 52240 [--mock]
// Tutor base+1, Library base+2, Hub base+3, Professor base+4, UI --ui. Live models by default (paid; the
// children are launched WITHOUT ANTHROPIC_BASE_URL so Claude Code's local proxy cannot answer); --mock = free.
// Prints "rehearsal ready http://127.0.0.1:<ui>" once the UI is listening and the Student session is registered.
// SIGTERM / SIGINT stops all five. Never prints key values.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const mock = args.includes('--mock');
const ui = Number(arg('ui'));
const base = Number(arg('base'));
if (!Number.isInteger(ui) || !Number.isInteger(base)) {
  console.error('usage: node scripts/demo/rehearsal-stack.js --ui <port> --base <port> [--mock]');
  process.exit(2);
}
const forbidden = (p) => p === 4444 || (p >= 41241 && p <= 41244);
const ports = { tutor: base + 1, library: base + 2, hub: base + 3, professor: base + 4, ui };
for (const p of Object.values(ports)) {
  if (forbidden(p)) { console.error(`refusing port ${p}: it belongs to the user's demo`); process.exit(2); }
}

const dir = mkdtempSync(join(tmpdir(), 'rehearsal-'));
const files = {
  LOAN_STORE_FILE: join(dir, 'loans.json'),
  HUB_LESSON_FILE: join(dir, 'hub-lessons.json'),
  STUDENT_INBOX_FILE: join(dir, 'inbox.json'),
  PROFESSOR_OUTBOX_FILE: join(dir, 'outbox.json'),
};
copyFileSync(join(root, 'data/library-loans.before-e2e.json'), files.LOAN_STORE_FILE);
// Empty starts; the stores create their own defaults when the file is missing, so only the loans are copied.

const url = (p) => `http://127.0.0.1:${p}`;
const mode = mock ? 'mock' : 'live';
const baseEnv = { ...process.env, ...files };
delete baseEnv.ANTHROPIC_BASE_URL; // the Claude Code shell sets a local proxy that answers with fake 429s
const specialist = { HUB_URL: url(ports.hub) };
const procs = [
  ['hub', 'src/hub-agent.js', { PORT: String(ports.hub), ROUTER_MODE: mode, TUTOR_URL: url(ports.tutor), LIBRARY_URL: url(ports.library), PROFESSOR_URL: url(ports.professor), STUDENT_URL: url(ports.ui) }],
  ['tutor', 'src/tutor-agent.js', { ...specialist, PORT: String(ports.tutor), TUTOR_MODE: mode }],
  ['library', 'src/library-agent.js', { ...specialist, PORT: String(ports.library), LIBRARY_MODE: mode }],
  ['prof', 'src/professor-agent.js', { ...specialist, PORT: String(ports.professor), PROFESSOR_MODE: mode }],
  ['ui', 'src/ui-server.js', { HUB_URL: url(ports.hub), UI_PORT: String(ports.ui), STUDENT_MODE: mode }],
].map(([name, script, env]) => {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (stream) => stream.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line) console.log(`${name.padEnd(7)} | ${line}`);
  });
  out(child.stdout);
  out(child.stderr);
  child.on('exit', (code, sig) => console.log(`${name.padEnd(7)} | exited (${code ?? sig})`));
  return child;
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Ready = the UI follows the Hub, the university card is valid, the Student session is registered and every
// specialist is 'ready' at the Hub (same signals test/support/harness.js startStack waits for).
const getJson = async (u) => (await fetch(u)).json();
const deadline = Date.now() + 60000;
for (;;) {
  try {
    const s = await getJson(`${url(ui)}/api/status`);
    const t = await getJson(`${url(ports.hub)}/viz/topology`);
    const ok = (id) => t.specialists.find((x) => x.agentId === id)?.status === 'ready' && t.feeds[id];
    if (s.hubFeedConnected && s.university?.cardValid && s.student?.session === 'registered' && ['tutor', 'library', 'professor'].every(ok)) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) { console.error('rehearsal stack did not become ready in 60 s'); stop(); await new Promise(() => {}); }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`rehearsal ready ${url(ui)}  (mode: ${mode}; temp data: ${dir})`);
