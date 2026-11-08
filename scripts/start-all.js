// Starts the ten local processes (Hub, Tutor, Library, Marketing 351 Faculty, HR Agent, PeopleSoft stand-in, Canvas LMS stand-in, student records stand-in, CHRS, Student UI) and
// prefixes their output. DEMO_MODE=live runs the Student's model, the Hub router, Tutor, Library, Professor
// HR, PeopleSoft's and Canvas's planners live (default Claude Haiku 5.5 each; <ROLE>_MODEL picks another per agent — paid); the API key is
// read by those processes from the environment or .env — never printed. Ctrl+C stops all of them.
// HR is staff only: the Faculty view reaches it through the Hub's signed staff path; students never do.
// Part 15: HR reaches the PeopleSoft stand-in (:41246) over MCP. A random token, made here on every start, is
// given to those two processes only (never printed, never in the other processes' environment).
// Part 16: the Faculty agent reaches the Canvas LMS stand-in (:41247) over MCP the same way, with its own random
// CANVAS_TOKEN given to `canvas` and `prof` only.
// Part 17: CHRS (staff only, :41248) reaches the PeopleSoft student records stand-in (:41249) over MCP the same way, with its
// own random STUDENT_RECORDS_TOKEN given to `records` and `chrs` only (records starts before chrs).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const live = process.env.DEMO_MODE === 'live';
const peoplesoftToken = randomBytes(24).toString('hex');
const canvasToken = randomBytes(24).toString('hex');
const recordsToken = randomBytes(24).toString('hex');
const { PEOPLESOFT_TOKEN: _ignored, CANVAS_TOKEN: _ignoredCanvas, STUDENT_RECORDS_TOKEN: _ignoredRecords, ...baseEnv } = process.env;
const procs = [
  ['hub', 'src/hub-agent.js', { ROUTER_MODE: live ? 'live' : 'mock' }],
  ['tutor', 'src/tutor-agent.js', { TUTOR_MODE: live ? 'live' : 'mock' }],
  ['library', 'src/library-agent.js', { LIBRARY_MODE: live ? 'live' : 'mock' }],
  ['psoft', 'src/peoplesoft-mcp.js', { PEOPLESOFT_MODE: live ? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken }],
  ['canvas', 'src/canvas-mcp.js', { CANVAS_MODE: live ? 'live' : 'mock', CANVAS_TOKEN: canvasToken }],
  ['prof', 'src/professor-agent.js', { PROFESSOR_MODE: live ? 'live' : 'mock', CANVAS_URL: 'http://127.0.0.1:41247', CANVAS_TOKEN: canvasToken }],
  ['hr', 'src/hr-agent.js', { HR_MODE: live ? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken }],
  ['records', 'src/student-records-mcp.js', { STUDENT_RECORDS_MODE: live ? 'live' : 'mock', STUDENT_RECORDS_TOKEN: recordsToken }],
  ['chrs', 'src/chrs-agent.js', { CHRS_MODE: live ? 'live' : 'mock', STUDENT_RECORDS_TOKEN: recordsToken }],
  ['ui', 'src/ui-server.js', { STUDENT_MODE: live ? 'live' : 'mock' }],
].map(([name, script, env]) => {
  const child = spawn(process.execPath, [script], { env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (stream) => stream.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line) console.log(`${name.padEnd(7)} | ${line}`);
  });
  out(child.stdout);
  out(child.stderr);
  child.on('exit', (code) => {
    console.log(`${name.padEnd(7)} | exited (${code})`);
    // Under a process manager (pm2: STOP_ALL_ON_EXIT=1) one crashed process takes the set down, so all ten
    // restart together instead of leaving a half-working demo. Locally the others keep running, as before.
    if (process.env.STOP_ALL_ON_EXIT === '1' && !stopping) { console.log(`${name} stopped — stopping all so they restart together`); stop(1); }
  });
  return child;
});
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
console.log(`Starting ten processes: the University Hub, Tutor, Library, Marketing 351 Faculty, HR Agent and CHRS (staff only), PeopleSoft, Canvas LMS and PeopleSoft student records (demo stand-ins, MCP) and Student UI (${live ? 'LIVE models — paid' : 'mock models, no network'}). Open http://127.0.0.1:4444`);
