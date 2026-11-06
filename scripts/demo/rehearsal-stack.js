// Rehearsal stack for the live walkthrough: the ten demo processes on their own ports with temp data
// files, so a rehearsal never touches the user's running demo (ports 4444, 41241-41249) or data/*.json.
//   node scripts/demo/rehearsal-stack.js --ui 5444 --base 52240 [--mock] [--now 2026-11-04T20:00:00Z]
// --now pins "today" for the Faculty agent, the UI server and Canvas (test hooks), for browser checks of the quiz; never for the demo.
// Tutor base+1, Library base+2, Hub base+3, Professor base+4, HR base+5 (staff only), PeopleSoft
// base+6 (demo stand-in MCP server; a random per-start token given only to HR and PeopleSoft, never printed), Canvas LMS base+7 (the same for
// Faculty and Canvas), student records base+8 (PeopleSoft student records stand-in; a random token given only to CHRS and it), CHRS base+9 (staff only), UI --ui. Live models by default (paid; the
// children are launched WITHOUT ANTHROPIC_BASE_URL so Claude Code's local proxy cannot answer); --mock = free.
// Prints "rehearsal ready http://127.0.0.1:<ui>" once the UI is listening and the Student session is registered.
// SIGTERM / SIGINT stops all ten. Never prints key values.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const mock = args.includes('--mock');
const ui = Number(arg('ui'));
const now = arg('now'); // ISO date-time; pins the quiz desk's clock (PROFESSOR_NOW / CANVAS_NOW) for browser checks
if (now !== undefined && Number.isNaN(Date.parse(now))) { console.error('--now must be an ISO date-time such as 2026-11-04T20:00:00Z'); process.exit(2); }
const pinProf = now ? { PROFESSOR_TEST_HOOKS: '1', PROFESSOR_NOW: now } : {};
const pinCanvas = now ? { CANVAS_TEST_HOOKS: '1', CANVAS_NOW: now } : {};
const base = Number(arg('base'));
if (!Number.isInteger(ui) || !Number.isInteger(base)) {
  console.error('usage: node scripts/demo/rehearsal-stack.js --ui <port> --base <port> [--mock] [--now <ISO>]');
  process.exit(2);
}
const forbidden = (p) => p === 4444 || (p >= 41241 && p <= 41249);
const ports = { tutor: base + 1, library: base + 2, hub: base + 3, professor: base + 4, hr: base + 5, peoplesoft: base + 6, canvas: base + 7, records: base + 8, chrs: base + 9, ui };
for (const p of Object.values(ports)) {
  if (forbidden(p)) { console.error(`refusing port ${p}: it belongs to the user's demo`); process.exit(2); }
}

const dir = mkdtempSync(join(tmpdir(), 'rehearsal-'));
const files = {
  HUB_LESSON_FILE: join(dir, 'hub-lessons.json'),
  STUDENT_INBOX_FILE: join(dir, 'inbox.json'),
  PROFESSOR_OUTBOX_FILE: join(dir, 'outbox.json'),
};
// Empty starts; the stores create their own defaults when the file is missing. Loans are in the Library's
// memory and always start from the sample loans.

const url = (p) => `http://127.0.0.1:${p}`;
const mode = mock ? 'mock' : 'live';
const baseEnv = { ...process.env, ...files };
delete baseEnv.ANTHROPIC_BASE_URL; // the Claude Code shell sets a local proxy that answers with fake 429s
const specialist = { HUB_URL: url(ports.hub) };
const psToken = randomBytes(24).toString('hex'); // HR ↔ PeopleSoft only; never printed
const canvasToken = randomBytes(24).toString('hex'); // Faculty ↔ Canvas only; never printed
const recordsToken = randomBytes(24).toString('hex'); // CHRS ↔ student records only; never printed
let peoplesoftUp = false;
let canvasUp = false;
let recordsUp = false;
const procs = [
  ['hub', 'src/hub-agent.js', { PORT: String(ports.hub), ROUTER_MODE: mode, TUTOR_URL: url(ports.tutor), LIBRARY_URL: url(ports.library), PROFESSOR_URL: url(ports.professor), HR_URL: url(ports.hr), CHRS_URL: url(ports.chrs), STUDENT_URL: url(ports.ui) }],
  ['tutor', 'src/tutor-agent.js', { ...specialist, PORT: String(ports.tutor), TUTOR_MODE: mode }],
  ['library', 'src/library-agent.js', { ...specialist, PORT: String(ports.library), LIBRARY_MODE: mode }],
  ['ps', 'src/peoplesoft-mcp.js', { PORT: String(ports.peoplesoft), PEOPLESOFT_MODE: mode, PEOPLESOFT_TOKEN: psToken }],
  ['canvas', 'src/canvas-mcp.js', { PORT: String(ports.canvas), CANVAS_MODE: mode, CANVAS_TOKEN: canvasToken, ...pinCanvas }],
  ['prof', 'src/professor-agent.js', { ...specialist, PORT: String(ports.professor), PROFESSOR_MODE: mode, CANVAS_URL: url(ports.canvas), CANVAS_TOKEN: canvasToken, ...pinProf }],
  ['hr', 'src/hr-agent.js', { ...specialist, PORT: String(ports.hr), HR_MODE: mode, PEOPLESOFT_URL: url(ports.peoplesoft), PEOPLESOFT_TOKEN: psToken }],
  ['records', 'src/student-records-mcp.js', { PORT: String(ports.records), STUDENT_RECORDS_MODE: mode, STUDENT_RECORDS_TOKEN: recordsToken }],
  ['chrs', 'src/chrs-agent.js', { ...specialist, PORT: String(ports.chrs), CHRS_MODE: mode, STUDENT_RECORDS_URL: url(ports.records), STUDENT_RECORDS_TOKEN: recordsToken }],
  ['ui', 'src/ui-server.js', { HUB_URL: url(ports.hub), UI_PORT: String(ports.ui), STUDENT_MODE: mode, ...pinProf }],
].map(([name, script, env]) => {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (stream) => stream.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line) continue;
      if (name === 'ps' && /PeopleSoft CHRS \(HR\) MCP server \(demo stand-in\) listening on/.test(line)) peoplesoftUp = true;
      if (name === 'records' && /PeopleSoft Campus Solutions MCP server \(demo stand-in\) listening on/.test(line)) recordsUp = true;
      if (name === 'canvas' && /Canvas LMS MCP server \(demo stand-in\) listening on/.test(line)) canvasUp = true;
      console.log(`${name.padEnd(7)} | ${line}`);
    }
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
// specialist is 'ready' at the Hub, and PeopleSoft, Canvas and the student records server are listening (same signals test/support/harness.js startStack waits for).
const getJson = async (u) => (await fetch(u)).json();
const deadline = Date.now() + 60000;
for (;;) {
  try {
    const s = await getJson(`${url(ui)}/api/status`);
    const t = await getJson(`${url(ports.hub)}/viz/topology`);
    const ok = (id) => t.specialists.find((x) => x.agentId === id)?.status === 'ready' && t.feeds[id];
    if (s.hubFeedConnected && s.university?.cardValid && s.student?.session === 'registered' && ['tutor', 'library', 'professor', 'hr', 'chrs'].every(ok) && peoplesoftUp && canvasUp && recordsUp) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) { console.error('rehearsal stack did not become ready in 60 s'); stop(); await new Promise(() => {}); }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`rehearsal ready ${url(ui)}  (mode: ${mode}; temp data: ${dir})`);
