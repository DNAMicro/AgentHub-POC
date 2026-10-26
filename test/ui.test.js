import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { openStream, startStack, startUi, unusedPort, waitFor } from './support/harness.js';

// Part 2 behaviour, now through the University Hub (Part 7): Student → Hub → Tutor → Hub → Student.
// The Hub runs in direct mode (no router), so every chat goes to tutoring.
const EXPECTED_REPLY = 'Hello Student Agent. Yes, I can help you with calculus.';

const postRun = (baseUrl, text) =>
  fetch(`${baseUrl}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });

const forRun = (events, runId) => events.filter((e) => e.runId === runId);
const find = (events, source, type) => events.find((e) => e.source === source && e.type === type);
const terminal = (events, runId) =>
  forRun(events, runId).find((e) => e.type === 'state' && (e.data.state === 'completed' || e.data.state === 'failed'));

// The A2A reply and the agents' telemetry travel on independent connections, so Tutor events may
// arrive after the run completes. Wait for both.
async function runToEnd(baseUrl, stream, text, { expectTutorEvents = true } = {}) {
  const res = await postRun(baseUrl, text);
  assert.equal(res.status, 202);
  const { runId } = await res.json();
  await waitFor(() => terminal(stream.events, runId), { what: `run ${runId} to finish` });
  if (expectTutorEvents) {
    await waitFor(() => find(forRun(stream.events, runId), 'tutor', 'reply_published') && find(forRun(stream.events, runId), 'hub', 'relay_sent'), { what: `tutor events for ${runId}` });
  }
  return runId;
}

// ---- fixtures: Hub + Tutor + UI (no Library), content shown in telemetry for these checks ----

let stack, tutor, uiUrl;

before(async () => {
  stack = await startStack({ library: false, hubEnv: { HUB_TELEMETRY_SHOW_CONTENT: '1' } });
  tutor = stack.tutor;
  uiUrl = stack.ui.url;
});

after(() => stack?.kill());

// ---- tests ------------------------------------------------------------------

test('typed message round-trips through A2A and every step is observed', async () => {
  const stream = await openStream(uiUrl);
  const typed = 'What is the derivative of x^2?';
  const runId = await runToEnd(uiUrl, stream, typed);
  const events = forRun(stream.events, runId);

  const sent = find(events, 'student', 'request_sent');
  const hubIn = find(events, 'hub', 'message_received');
  const forward = find(events, 'hub', 'forward_attempted');
  const received = find(events, 'tutor', 'message_received');
  const published = find(events, 'tutor', 'reply_published');
  const reply = find(events, 'student', 'reply_received');

  assert.equal(sent.data.text, typed);
  assert.equal(hubIn.data.messageId, sent.data.messageId, 'the Hub received the message the Student sent');
  assert.equal(received.data.text, typed, 'Tutor process saw the exact typed text');
  // Two A2A legs with their own IDs: the Hub's downstream message is a different message.
  assert.equal(received.data.messageId, forward.data.downstreamMessageId, 'Tutor received the message the Hub forwarded');
  assert.notEqual(forward.data.downstreamMessageId, sent.data.messageId);
  assert.notEqual(forward.data.downstreamContextId, sent.data.contextId, 'separate Student↔Hub and Hub↔Tutor contexts');
  assert.equal(published.data.inReplyTo, forward.data.downstreamMessageId);
  assert.equal(reply.data.text, EXPECTED_REPLY);
  assert.equal(reply.data.servedBy, 'tutor', 'attribution: the Hub says which service answered');
  assert.equal(reply.data.runId, runId, 'runId round-tripped in A2A reply metadata');

  // Causal order, judged by each process's own clock (same machine):
  const t = (e) => Date.parse(e.at);
  assert.ok(t(sent) <= t(hubIn) && t(hubIn) <= t(received) && t(received) <= t(published) && t(published) <= t(reply), 'steps happened in order');
  // Every hop is labelled for the topology graph, in the right direction.
  assert.deepEqual([sent, hubIn, forward, received, published, reply].map((e) => `${e.topo.from}>${e.topo.to}:${e.topo.phase}`),
    ['student>hub:attempted', 'student>hub:accepted', 'hub>tutor:attempted', 'hub>tutor:accepted', 'tutor>hub:attempted', 'hub>student:completed']);

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
    const sentId = find(events, 'hub', 'forward_attempted').data.downstreamMessageId;
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
  const sentId = find(forRun(first.events, runId), 'hub', 'forward_attempted').data.downstreamMessageId;
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

test('unavailable university Hub: real error is shown and no successful response is emitted', async () => {
  const deadHub = `http://127.0.0.1:${await unusedPort()}`;
  const lonelyUi = await startUi(deadHub);
  try {
    const url = lonelyUi.url;
    const stream = await openStream(url);
    await waitFor(() => stream.hello, { what: 'hello' });
    assert.equal(stream.hello.hubFeedConnected, false);

    const runId = await runToEnd(url, stream, 'anyone there?', { expectTutorEvents: false });
    const events = forRun(stream.events, runId);
    const failure = find(events, 'student', 'request_failed');
    assert.ok(failure, 'request_failed event emitted');
    assert.equal(failure.data.outcome, 'not_delivered');
    assert.match(failure.data.error, /not reachable/);
    assert.equal(terminal(stream.events, runId).data.state, 'failed');
    assert.equal(find(events, 'student', 'reply_received'), undefined, 'no reply shown');
    assert.equal(events.filter((e) => e.source === 'tutor' || e.source === 'hub').length, 0, 'no agent events invented');
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

test('each tab has its own address that serves the page; other paths do not', async () => {
  const home = await (await fetch(`${uiUrl}/`)).text();
  for (const slug of ['conversation', 'activity', 'topology']) {
    const res = await fetch(`${uiUrl}/${slug}`);
    assert.equal(res.status, 200, slug);
    assert.equal(await res.text(), home, `${slug} serves the same page`);
    assert.match(home, new RegExp(`<a href="/${slug}" role="tab"`), `${slug} tab is a real link`);
  }
  assert.equal((await fetch(`${uiUrl}/nope`)).status, 404);
});
