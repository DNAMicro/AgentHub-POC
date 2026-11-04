// Starts the seven local processes (Hub, Tutor, Library, Marketing 101 Professor, HR Agent, PeopleSoft stand-in, Student UI) and
// prefixes their output. DEMO_MODE=live runs the Student's model, the Hub router, Tutor, Library, Professor
// HR and PeopleSoft's planner live (default Claude Haiku 5.5 each; <ROLE>_MODEL picks another per agent — paid); the API key is
// read by those processes from the environment or .env — never printed. Ctrl+C stops all of them.
// HR is staff only: the Professor view reaches it through the Hub's signed staff path; students never do.
// Part 15: HR reaches the PeopleSoft stand-in (:41246) over MCP. A random token, made here on every start, is
// given to those two processes only (never printed, never in the other processes' environment).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const live = process.env.DEMO_MODE === 'live';
const peoplesoftToken = randomBytes(24).toString('hex');
const { PEOPLESOFT_TOKEN: _ignored, ...baseEnv } = process.env;
const procs = [
  ['hub', 'src/hub-agent.js', { ROUTER_MODE: live ? 'live' : 'mock' }],
  ['tutor', 'src/tutor-agent.js', { TUTOR_MODE: live ? 'live' : 'mock' }],
  ['library', 'src/library-agent.js', { LIBRARY_MODE: live ? 'live' : 'mock' }],
  ['prof', 'src/professor-agent.js', { PROFESSOR_MODE: live ? 'live' : 'mock' }],
  ['hr', 'src/hr-agent.js', { HR_MODE: live ? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken }],
  ['psoft', 'src/peoplesoft-mcp.js', { PEOPLESOFT_MODE: live ? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken }],
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
console.log(`Starting seven processes: the University Hub, Tutor, Library, Marketing 101 Professor, HR Agent (staff only), PeopleSoft (demo stand-in, MCP) and Student UI (${live ? 'LIVE models — paid' : 'mock models, no network'}). Open http://127.0.0.1:4444`);
