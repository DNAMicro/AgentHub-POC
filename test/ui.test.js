import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

const EXPECTED_REPLY = 'Hello Student Agent. Yes, I can help you with calculus.';

// ---- helpers --------------------------------------------------------------

function startProcess(script, env, readyPattern) {
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

async function waitFor(check, { timeout = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Minimal SSE reader for the browser-facing /api/events stream.
async function openStream(baseUrl) {
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

const postRun = (baseUrl, text) =>
  fetch(`${baseUrl}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });

const forRun = (events, runId) => events.filter((e) => e.runId === runId);
const find = (events, source, type) => events.find((e) => e.source === source && e.type === type);
const terminal = (events, runId) =>
  forRun(events, runId).find((e) => e.type === 'state' && (e.data.state === 'completed' || e.data.state === 'failed'));

// The A2A reply and the Tutor's visualization feed travel on independent connections,
// so Tutor events may arrive after the run completes. Wait for both.
async function runToEnd(baseUrl, stream, text, { expectTutorEvents = true } = {}) {
  const res = await postRun(baseUrl, text);
  assert.equal(res.status, 202);
  const { runId } = await res.json();
  await waitFor(() => terminal(stream.events, runId), { what: `run ${runId} to finish` });
  if (expectTutorEvents) {
    await waitFor(() => find(forRun(stream.events, runId), 'tutor', 'reply_published'), { what: `tutor events for ${runId}` });
  }
  return runId;
}

async function unusedPort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

// ---- fixtures: Tutor process + UI server process ----------------------------

let tutor, ui, tutorUrl, uiUrl;

before(async () => {
  tutor = startProcess('src/tutor-agent.js', { PORT: '0' }, /listening on (http:\/\/127\.0\.0\.1:\d+)/);
  tutorUrl = await tutor.ready;
  ui = startProcess('src/ui-server.js', { UI_PORT: '0', TUTOR_URL: tutorUrl }, /\[UI\] listening on (http:\/\/127\.0\.0\.1:\d+)/);
  uiUrl = await ui.ready;
  await waitFor(async () => (await (await fetch(`${uiUrl}/api/status`)).json()).tutorFeedConnected, { what: 'tutor feed' });
});

after(() => {
  ui?.proc.kill();
  tutor?.proc.kill();
});

// ---- tests ------------------------------------------------------------------

test('typed message round-trips through A2A and every step is observed', async () => {
  const stream = await openStream(uiUrl);
  const typed = 'What is the derivative of x^2?';
  const runId = await runToEnd(uiUrl, stream, typed);
  const events = forRun(stream.events, runId);

  const sent = find(events, 'student', 'request_sent');
  const received = find(events, 'tutor', 'message_received');
  const published = find(events, 'tutor', 'reply_published');
  const reply = find(events, 'student', 'reply_received');

  assert.equal(sent.data.text, typed);
  assert.equal(received.data.text, typed, 'Tutor process saw the exact typed text');
  assert.equal(received.data.messageId, sent.data.messageId, 'Tutor received the message the Student sent');
  assert.equal(published.data.inReplyTo, sent.data.messageId);
  assert.equal(reply.data.text, EXPECTED_REPLY);
  assert.equal(reply.data.messageId, published.data.messageId, 'Student received the message the Tutor published');
  assert.equal(reply.data.runId, runId, 'runId round-tripped in A2A reply metadata');

  // Causal order, judged by each process's own clock (same machine):
  const t = (e) => Date.parse(e.at);
  assert.ok(t(sent) <= t(received) && t(received) <= t(published) && t(published) <= t(reply), 'steps happened in order');

  // 'waiting' appears only if the Tutor's receipt event reached the UI before the A2A reply did.
  const states = events.filter((e) => e.type === 'state').map((e) => e.data.state);
  assert.ok(
    ['sending,waiting,completed', 'sending,completed'].includes(states.join(',')),
    `unexpected state sequence: ${states}`,
  );
  assert.ok(tutor.output().includes(typed), 'Tutor process log contains the typed text');
  stream.close();
});

test('events from separate runs are correlated by runId and never mixed', async () => {
  const stream = await openStream(uiUrl);
  const runA = await runToEnd(uiUrl, stream, 'first question');
  const runB = await runToEnd(uiUrl, stream, 'second question');
  assert.notEqual(runA, runB);

  for (const [runId, text] of [[runA, 'first question'], [runB, 'second question']]) {
    const events = forRun(stream.events, runId);
    const sentId = find(events, 'student', 'request_sent').data.messageId;
    const tutorEvents = events.filter((e) => e.source === 'tutor');
    assert.equal(tutorEvents.length, 2, 'one receive + one publish per run');
    assert.equal(find(events, 'tutor', 'message_received').data.text, text);
    assert.equal(find(events, 'tutor', 'message_received').data.messageId, sentId);
    assert.equal(find(events, 'tutor', 'reply_published').data.inReplyTo, sentId);
  }
  stream.close();
});

test('a second submission while a run is in progress is rejected', async () => {
  const stream = await openStream(uiUrl);
  const [first, second] = await Promise.all([postRun(uiUrl, 'one'), postRun(uiUrl, 'two')]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [202, 409]);
  const accepted = await (first.status === 202 ? first : second).json();
  await waitFor(() => terminal(stream.events, accepted.runId), { what: 'accepted run' });
  await waitFor(() => find(forRun(stream.events, accepted.runId), 'tutor', 'reply_published'), { what: 'tutor events' });
  const started = stream.events.filter((e) => e.type === 'run_started' && ['one', 'two'].includes(e.data.text));
  assert.equal(started.length, 1, 'only one run started');
  stream.close();
});

test('browser reconnect replays history but never resends the A2A request', async () => {
  const first = await openStream(uiUrl);
  const runId = await runToEnd(uiUrl, first, 'reconnect check');
  const sentId = find(forRun(first.events, runId), 'student', 'request_sent').data.messageId;
  first.close();

  // Simulate the browser reconnecting several times.
  for (let i = 0; i < 3; i++) {
    const again = await openStream(uiUrl);
    await waitFor(() => terminal(again.events, runId), { what: 'replayed history' });
    const replayed = forRun(again.events, runId);
    assert.equal(replayed.filter((e) => e.type === 'run_started').length, 1);
    assert.equal(replayed.filter((e) => e.type === 'request_sent').length, 1);
    again.close();
  }
  await new Promise((r) => setTimeout(r, 200)); // give any (wrong) resend time to reach the Tutor

  // Ground truth from the Tutor process itself: it received this message exactly once.
  const occurrences = tutor.output().split(`messageId: '${sentId}'`).length - 1;
  assert.equal(occurrences, 1, 'Tutor process logged the message exactly once');
  const status = await (await fetch(`${uiUrl}/api/status`)).json();
  assert.equal(status.activeRunId, null, 'no request was started by reconnecting');
});

test('unavailable Tutor: real error is shown and no successful response is emitted', async () => {
  const deadTutor = `http://127.0.0.1:${await unusedPort()}`;
  const lonelyUi = startProcess('src/ui-server.js', { UI_PORT: '0', TUTOR_URL: deadTutor }, /\[UI\] listening on (http:\/\/127\.0\.0\.1:\d+)/);
  try {
    const url = await lonelyUi.ready;
    const stream = await openStream(url);
    await waitFor(() => stream.hello, { what: 'hello' });
    assert.equal(stream.hello.tutorFeedConnected, false);

    const runId = await runToEnd(url, stream, 'anyone there?', { expectTutorEvents: false });
    const events = forRun(stream.events, runId);
    const failure = find(events, 'student', 'request_failed');
    assert.ok(failure, 'request_failed event emitted');
    assert.equal(failure.data.code, 'ECONNREFUSED');
    assert.equal(terminal(stream.events, runId).data.state, 'failed');
    assert.equal(find(events, 'student', 'reply_received'), undefined, 'no reply shown');
    assert.equal(events.filter((e) => e.source === 'tutor').length, 0, 'no tutor events invented');
    assert.ok(!events.some((e) => e.type === 'state' && e.data.state === 'completed'));
    stream.close();
  } finally {
    lonelyUi.proc.kill();
  }
});

test('input validation: empty and oversized messages are rejected without starting a run', async () => {
  assert.equal((await postRun(uiUrl, '   ')).status, 400);
  assert.equal((await postRun(uiUrl, 'x'.repeat(2001))).status, 400);
});
