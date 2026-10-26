import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { askTutor, STUDENT_MESSAGE } from '../src/student-agent.js';
import { TUTOR_REPLY } from '../src/tutor-agent.js';

const run = promisify(execFile);
const EXPECTED_REPLY = 'Hello Student Agent. Yes, I can help you with calculus.';

// Start the Tutor as its own process on a free port and wait for its "listening" line.
async function startTutorProcess() {
  const proc = spawn(process.execPath, ['src/tutor-agent.js'], { env: { ...process.env, PORT: '0' } });
  let output = '';
  proc.stdout.on('data', (chunk) => (output += chunk));
  proc.stderr.on('data', (chunk) => (output += chunk));
  const baseUrl = await new Promise((resolve, reject) => {
    proc.stdout.on('data', () => {
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    });
    proc.on('exit', (code) => reject(new Error(`Tutor exited early (${code}):\n${output}`)));
  });
  return { proc, baseUrl, output: () => output };
}

async function unusedPort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

const tutor = await startTutorProcess();
after(() => tutor.proc.kill());

test('Agent Card is discoverable and advertises the A2A JSON-RPC interface', async () => {
  const res = await fetch(`${tutor.baseUrl}/.well-known/agent-card.json`);
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.name, 'Tutor Agent');
  assert.deepEqual(card.supportedInterfaces, [
    { url: `${tutor.baseUrl}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
  ]);
});

test('Student sends via the A2A client and receives the exact Tutor reply', async () => {
  assert.equal(TUTOR_REPLY, EXPECTED_REPLY); // guard: the test's expectation is independent of the server constant
  const reply = await askTutor(tutor.baseUrl);
  assert.equal(reply.text, EXPECTED_REPLY);
  assert.ok(reply.messageId, 'reply has a messageId');
  assert.ok(reply.contextId, 'reply has a contextId assigned by the server');
});

test('Student Agent process ↔ Tutor Agent process exchange is traceable in both logs', async () => {
  const { stdout } = await run(process.execPath, ['src/student-agent.js'], {
    env: { ...process.env, TUTOR_URL: tutor.baseUrl },
  });
  assert.match(stdout, new RegExp(`Tutor Agent replied: ${EXPECTED_REPLY}`));

  // The student's outgoing messageId must show up in the tutor's "received message" log.
  const sentId = stdout.match(/sending message \{\s*messageId: '([^']+)'/)[1];
  const tutorLog = tutor.output();
  assert.ok(tutorLog.includes(`messageId: '${sentId}'`), `Tutor log should contain student messageId ${sentId}`);
  assert.ok(tutorLog.includes(STUDENT_MESSAGE), 'Tutor log should contain the student text');

  console.log('\n----- Student Agent process output -----\n' + stdout);
  console.log('----- Tutor Agent process output -----\n' + tutorLog);
});

test('negative: unavailable Tutor yields a clear connection failure, not a fake reply', async () => {
  const deadUrl = `http://127.0.0.1:${await unusedPort()}`;

  await assert.rejects(askTutor(deadUrl), (err) => {
    assert.equal(err.cause?.code, 'ECONNREFUSED');
    return true;
  });

  const result = await run(process.execPath, ['src/student-agent.js'], {
    env: { ...process.env, TUTOR_URL: deadUrl },
  }).then(
    () => assert.fail('student process should exit non-zero'),
    (err) => err,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FAILED to reach Tutor Agent .*ECONNREFUSED/);
  assert.doesNotMatch(result.stdout, /Tutor Agent replied/);
  console.log('\n----- Student Agent output with Tutor down -----\n' + result.stdout + result.stderr);
});
