// Starts the five local processes (Hub, Tutor, Library, Marketing 101 Professor, Student UI) and prefixes
// their output. DEMO_MODE=live runs the Student's model, the Hub router, Tutor, Library and Professor live (default Claude Haiku
// 5.5 each; <ROLE>_MODEL picks another per agent — paid); the API key is
// read by those processes from the environment or .env — never printed. Ctrl+C stops all of them.
import { spawn } from 'node:child_process';

const live = process.env.DEMO_MODE === 'live';
const procs = [
  ['hub', 'src/hub-agent.js', { ROUTER_MODE: live ? 'live' : 'mock' }],
  ['tutor', 'src/tutor-agent.js', { TUTOR_MODE: live ? 'live' : 'mock' }],
  ['library', 'src/library-agent.js', { LIBRARY_MODE: live ? 'live' : 'mock' }],
  ['prof', 'src/professor-agent.js', { PROFESSOR_MODE: live ? 'live' : 'mock' }],
  ['ui', 'src/ui-server.js', { STUDENT_MODE: live ? 'live' : 'mock' }],
].map(([name, script, env]) => {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
console.log(`Starting the University Hub, Tutor, Library, Marketing 101 Professor and Student UI (${live ? 'LIVE models — paid' : 'mock models, no network'}). Open http://127.0.0.1:4444`);
