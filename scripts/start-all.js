// Starts the eight local processes (Hub, Tutor, Library, Marketing 351 Faculty, HR Agent, PeopleSoft stand-in, Canvas LMS stand-in, Student UI) and
// prefixes their output. DEMO_MODE=live runs the Student's model, the Hub router, Tutor, Library, Professor
// HR, PeopleSoft's and Canvas's planners live (default Claude Haiku 5.5 each; <ROLE>_MODEL picks another per agent — paid); the API key is
// read by those processes from the environment or .env — never printed. Ctrl+C stops all of them.
// HR is staff only: the Faculty view reaches it through the Hub's signed staff path; students never do.
// Part 15: HR reaches the PeopleSoft stand-in (:41246) over MCP. A random token, made here on every start, is
// given to those two processes only (never printed, never in the other processes' environment).
// Part 16: the Faculty agent reaches the Canvas LMS stand-in (:41247) over MCP the same way, with its own random
// CANVAS_TOKEN given to `canvas` and `prof` only.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const live = process.env.DEMO_MODE === 'live';
const peoplesoftToken = randomBytes(24).toString('hex');
const canvasToken = randomBytes(24).toString('hex');
const { PEOPLESOFT_TOKEN: _ignored, CANVAS_TOKEN: _ignoredCanvas, ...baseEnv } = process.env;
const procs = [
  ['hub', 'src/hub-agent.js', { ROUTER_MODE: live ? 'live' : 'mock' }],
  ['tutor', 'src/tutor-agent.js', { TUTOR_MODE: live ? 'live' : 'mock' }],
  ['library', 'src/library-agent.js', { LIBRARY_MODE: live ? 'live' : 'mock' }],
  ['prof', 'src/professor-agent.js', { PROFESSOR_MODE: live ? 'live' : 'mock', CANVAS_URL: 'http://127.0.0.1:41247', CANVAS_TOKEN: canvasToken }],
  ['hr', 'src/hr-agent.js', { HR_MODE: live ? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken }],
  ['psoft', 'src/peoplesoft-mcp.js', { PEOPLESOFT_MODE: live ? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken }],
  ['canvas', 'src/canvas-mcp.js', { CANVAS_MODE: live ? 'live' : 'mock', CANVAS_TOKEN: canvasToken }],
  ['ui', 'src/ui-server.js', { STUDENT_MODE: live ? 'live' : 'mock' }],
].map(([name, script, env]) => {
  const child = spawn(process.execPath, [script], { env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (stream) => stream.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line) console.log(`${name.padEnd(7)} | ${line}`);
  });
  out(child.stdout);
  out(child.stderr);
  child.on('exit', (code) => console.log(`${name.padEnd(7)} | exited (${code})`));
  return child;
});
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`Starting eight processes: the University Hub, Tutor, Library, Marketing 351 Faculty, HR Agent (staff only), PeopleSoft and Canvas LMS (demo stand-ins, MCP) and Student UI (${live ? 'LIVE models — paid' : 'mock models, no network'}). Open http://127.0.0.1:4444`);
