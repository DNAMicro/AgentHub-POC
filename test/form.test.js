// Part 3 end-to-end: real Tutor + UI server processes. The browser is stood in for by
// the event stream reader and HTTP calls; the A2UI action is built exactly as the
// renderer emits it (shape verified in a2ui-render.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  startTutor, startUi, waitFor, openStream, unusedPort, post, forRun, find, findAll, stateOf,
} from './support/harness.js';
import { requestForm, submitForm } from '../src/student-agent.js';
import { SUBMIT_ACTION } from '../src/student-form.js';

const ALEX = { firstName: 'Alex', lastName: 'Student', email: 'alex@example.com', notes: 'Prefers morning sessions.\nSecond line.' };

let tutor, ui;
before(async () => {
  tutor = await startTutor();
  ui = await startUi(tutor.url);
  await waitFor(async () => (await (await fetch(`${ui.url}/api/status`)).json()).tutorFeedConnected, { what: 'tutor feed' });
});
after(() => {
  ui?.proc.kill();
  tutor?.proc.kill();
});

const actionFor = (formId, context, name = SUBMIT_ACTION) => ({
  name, surfaceId: formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context,
});

// Request a form through the UI server and wait until it's awaiting input.
async function openForm(uiUrl, stream) {
  const res = await post(`${uiUrl}/api/forms`, {});
  assert.equal(res.status, 202);
  const { runId } = await res.json();
  await waitFor(() => ['awaiting_input', 'failed'].includes(stateOf(stream.events, runId)), { what: 'form' });
  const received = find(forRun(stream.events, runId), 'student', 'form_received');
  return { runId, formId: received?.data.formId, received };
}

const submit = (uiUrl, formId, body) => post(`${uiUrl}/api/forms/${formId}/submissions`, body);
const settled = (stream, runId, states) => waitFor(() => states.includes(stateOf(stream.events, runId)), { what: `state in ${states}` });
const countIn = (text, needle) => text.split(needle).length - 1;

test('valid round trip: Tutor receives all four values exactly, accepts, and the Student gets the acknowledgment', async () => {
  const stream = await openStream(ui.url);
  const { runId, formId, received } = await openForm(ui.url, stream);
  assert.ok(received.data.a2uiMessages.length >= 3, 'browser was delivered the A2UI messages');

  const submissionId = randomUUID();
  const res = await submit(ui.url, formId, { submissionId, action: actionFor(formId, ALEX) });
  assert.equal(res.status, 202);
  await settled(stream, runId, ['accepted']);
  await waitFor(() => find(forRun(stream.events, runId), 'tutor', 'submission_accepted'), { what: 'tutor accepted event' });

  const events = forRun(stream.events, runId);
  assert.deepEqual(find(events, 'tutor', 'submission_received').data.receivedValues, ALEX, 'Tutor received exactly the four values');
  assert.deepEqual(find(events, 'tutor', 'submission_accepted').data.values, ALEX);
  const ack = find(events, 'student', 'ack_received').data;
  assert.equal(ack.ack.status, 'accepted');
  assert.equal(ack.submissionId, submissionId);
  assert.equal(ack.ack.ackId, find(events, 'tutor', 'submission_accepted').data.ackId);

  // Correlation: same conversation and task end to end; submission resumed the form's task.
  const formTask = received.data;
  const sent = find(events, 'student', 'submission_sent').data;
  assert.equal(sent.mode, 'resume-task');
  assert.equal(sent.taskId, formTask.taskId);
  assert.equal(find(events, 'tutor', 'submission_received').data.contextId, formTask.contextId);
  assert.equal(ack.contextId, formTask.contextId);

  // The eight visible steps all come from real events, in causal order.
  const order = [
    ['student', 'form_requested'], ['tutor', 'form_request_received'], ['tutor', 'form_sent'], ['student', 'form_received'],
    ['system', 'state:awaiting_input'], ['student', 'submission_sent'], ['tutor', 'submission_accepted'], ['student', 'ack_received'],
  ].map(([source, type]) => (type.startsWith('state:')
    ? events.find((e) => e.type === 'state' && e.data.state === type.slice(6))
    : find(events, source, type)));
  assert.ok(order.every(Boolean), 'all eight steps observed');
  const t = order.map((e) => Date.parse(e.at));
  assert.ok(t.every((v, i) => i === 0 || t[i - 1] <= v), `steps in causal order: ${order.map((e) => e.type)}`);
  stream.close();
});

test('UI server refuses invalid data and never forwards it to the Tutor', async () => {
  const stream = await openStream(ui.url);
  const { runId, formId } = await openForm(ui.url, stream);
  const cases = [
    [{ ...ALEX, firstName: '' }, 'firstName'],
    [{ ...ALEX, lastName: '   ' }, 'lastName'],
    [{ ...ALEX, email: 'alex@' }, 'email'],
    [{ ...ALEX, notes: 'x'.repeat(1001) }, 'notes'],
    [{ ...ALEX, firstName: 'x'.repeat(101) }, 'firstName'],
    [{ ...ALEX, admin: true }, '_form'], // unexpected field
  ];
  for (const [context, field] of cases) {
    const res = await submit(ui.url, formId, { submissionId: randomUUID(), action: actionFor(formId, context) });
    assert.equal(res.status, 400, JSON.stringify(context).slice(0, 60));
    assert.ok((await res.json()).errors[field], `error reported for ${field}`);
  }
  const unknownAction = await submit(ui.url, formId, { submissionId: randomUUID(), action: actionFor(formId, ALEX, 'deleteEverything') });
  assert.equal(unknownAction.status, 400);
  const extraActionKey = await submit(ui.url, formId, { submissionId: randomUUID(), action: { ...actionFor(formId, ALEX), url: 'https://example.com' } });
  assert.equal(extraActionKey.status, 400);
  const extraBodyKey = await submit(ui.url, formId, { submissionId: randomUUID(), action: actionFor(formId, ALEX), script: 'alert(1)' });
  assert.equal(extraBodyKey.status, 400);

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(findAll(forRun(stream.events, runId), 'tutor', 'submission_received').length, 0, 'Tutor received nothing');
  assert.equal(stateOf(stream.events, runId), 'awaiting_input');
  stream.close();
});

test('Tutor independently rejects invalid submissions sent straight over A2A, then accepts a corrected one on the same task', async () => {
  const form = await requestForm(tutor.url, { runId: 'direct' });
  const direct = (context, name) => submitForm(tutor.url, { form, action: actionFor(form.formId, context, name), submissionId: randomUUID(), runId: 'direct' });

  for (const [context, name, field] of [
    [{ ...ALEX, firstName: '  ' }, SUBMIT_ACTION, 'firstName'],
    [{ ...ALEX, lastName: '' }, SUBMIT_ACTION, 'lastName'],
    [{ ...ALEX, email: 'nope' }, SUBMIT_ACTION, 'email'],
    [{ ...ALEX, role: 'admin' }, SUBMIT_ACTION, '_form'],
    [ALEX, 'deleteEverything', '_form'],
  ]) {
    const result = await direct(context, name);
    assert.equal(result.body.status, 'rejected', `${name} ${JSON.stringify(context).slice(0, 50)}`);
    assert.ok(result.body.errors[field]);
    assert.equal(result.taskId, form.taskId, 'rejection keeps the same task open (input-required)');
  }
  const ok = await direct(ALEX, SUBMIT_ACTION);
  assert.equal(ok.body.status, 'accepted');
  assert.equal(ok.taskId, form.taskId);
});

test('duplicate submission is processed once and returns the identical acknowledgment', async () => {
  const stream = await openStream(ui.url);
  const { runId, formId } = await openForm(ui.url, stream);
  const submissionId = randomUUID();

  // Double click: two concurrent submits → only one is accepted by the UI server.
  const [a, b] = await Promise.all([
    submit(ui.url, formId, { submissionId, action: actionFor(formId, ALEX) }),
    submit(ui.url, formId, { submissionId, action: actionFor(formId, ALEX) }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  await settled(stream, runId, ['accepted']);
  // After acceptance the UI server refuses further submits.
  assert.equal((await submit(ui.url, formId, { submissionId, action: actionFor(formId, ALEX) })).status, 409);

  // A duplicate that reaches the Tutor anyway (straight over A2A, same submissionId).
  const form = { ...find(forRun(stream.events, runId), 'student', 'form_received').data };
  const first = find(forRun(stream.events, runId), 'student', 'ack_received').data.ack;
  const again = await submitForm(tutor.url, { form, action: actionFor(formId, ALEX), submissionId, runId });
  assert.equal(again.duplicate, true);
  assert.equal(again.body.ackId, first.ackId, 'same acknowledgment');
  assert.equal(again.body.recordedAt, first.recordedAt);
  const recordLines = tutor.output().split('[Tutor Agent]').filter((block) => block.startsWith(' recorded submission') && block.includes(submissionId));
  assert.equal(recordLines.length, 1, 'Tutor log shows the submission recorded exactly once');
  assert.equal(findAll(forRun(stream.events, runId), 'tutor', 'submission_accepted').length, 1);
  await waitFor(() => find(forRun(stream.events, runId), 'tutor', 'submission_duplicate'), { what: 'duplicate event' });

  // Same submissionId with different content is refused, not silently merged.
  const conflict = await submitForm(tutor.url, { form, action: actionFor(formId, { ...ALEX, firstName: 'Sam' }), submissionId, runId });
  assert.equal(conflict.body.status, 'rejected');
  stream.close();
});

test('browser reconnect replays events but never resubmits', async () => {
  const stream = await openStream(ui.url);
  const { runId, formId } = await openForm(ui.url, stream);
  await submit(ui.url, formId, { submissionId: randomUUID(), action: actionFor(formId, ALEX) });
  await settled(stream, runId, ['accepted']);
  stream.close();
  const receivedBefore = countIn(tutor.output(), 'received submission');

  for (let i = 0; i < 3; i++) {
    const again = await openStream(ui.url);
    await waitFor(() => stateOf(again.events, runId) === 'accepted', { what: 'replay' });
    assert.equal(findAll(forRun(again.events, runId), 'student', 'submission_sent').length, 1, 'still one submission');
    assert.ok(find(forRun(again.events, runId), 'student', 'form_received').data.a2uiMessages, 'form replayed for rendering');
    again.close();
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(countIn(tutor.output(), 'received submission'), receivedBefore, 'Tutor received nothing new');
});

test('unavailable Tutor: form request fails visibly; a submission is reported not delivered and the form stays editable', async () => {
  const lonelyTutor = await startTutor();
  const lonelyUi = await startUi(lonelyTutor.url);
  try {
    const stream = await openStream(lonelyUi.url);
    const { runId, formId } = await openForm(lonelyUi.url, stream);
    lonelyTutor.proc.kill();
    await new Promise((r) => lonelyTutor.proc.once('exit', r));

    const res = await submit(lonelyUi.url, formId, { submissionId: randomUUID(), action: actionFor(formId, ALEX) });
    assert.equal(res.status, 202);
    await waitFor(() => find(forRun(stream.events, runId), 'student', 'submission_failed'), { what: 'failure' });
    const failure = find(forRun(stream.events, runId), 'student', 'submission_failed').data;
    assert.equal(failure.outcome, 'not_delivered');
    assert.equal(failure.code, 'ECONNREFUSED');
    await settled(stream, runId, ['awaiting_input']);
    const last = forRun(stream.events, runId).filter((e) => e.type === 'state').at(-1).data;
    assert.equal(last.notDelivered, true, 'browser is told: not delivered, draft kept');
    assert.equal(find(forRun(stream.events, runId), 'student', 'ack_received'), undefined);

    // With no Tutor at all, requesting a form fails and says so.
    const second = await post(`${lonelyUi.url}/api/forms`, {});
    const { runId: run2 } = await second.json();
    await settled(stream, run2, ['failed']);
    assert.equal(find(forRun(stream.events, run2), 'student', 'form_request_failed').data.code, 'ECONNREFUSED');
    stream.close();
  } finally {
    lonelyUi.proc.kill();
  }
});

test('uncertain delivery is reported honestly; an explicit retry with the same submissionId is deduplicated', async () => {
  // A Tutor that takes 1.2s to process its first submission, and a Student that gives up after 400ms.
  const slowTutor = await startTutor({ TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS: '1200' });
  const impatientUi = await startUi(slowTutor.url, { SUBMIT_TIMEOUT_MS: '400' });
  try {
    await waitFor(async () => (await (await fetch(`${impatientUi.url}/api/status`)).json()).tutorFeedConnected, { what: 'feed' });
    const stream = await openStream(impatientUi.url);
    const { runId, formId } = await openForm(impatientUi.url, stream);
    const submissionId = randomUUID();
    await submit(impatientUi.url, formId, { submissionId, action: actionFor(formId, ALEX) });

    await settled(stream, runId, ['uncertain']);
    assert.equal(find(forRun(stream.events, runId), 'student', 'submission_failed').data.outcome, 'uncertain');
    assert.equal(find(forRun(stream.events, runId), 'student', 'ack_received'), undefined, 'no success claimed');

    // Meanwhile the Tutor did get it — which is exactly why "uncertain" was the honest answer.
    await waitFor(() => find(forRun(stream.events, runId), 'tutor', 'submission_accepted'), { timeout: 4000, what: 'late tutor acceptance' });
    assert.equal(stateOf(stream.events, runId), 'uncertain', 'no silent retry happened');

    // A retry must reuse the submissionId.
    assert.equal((await submit(impatientUi.url, formId, { submissionId: randomUUID(), action: actionFor(formId, ALEX) })).status, 409);
    // Explicit retry (the browser's "Retry submission" button), same submissionId.
    assert.equal((await submit(impatientUi.url, formId, { submissionId, action: actionFor(formId, ALEX) })).status, 202);
    await settled(stream, runId, ['accepted']);
    const events = forRun(stream.events, runId);
    const [, retry] = findAll(events, 'student', 'submission_sent');
    assert.equal(retry.data.mode, 'new-message-referencing-task', 'did not try to resume the completed task');
    assert.equal(retry.data.submissionId, submissionId);
    assert.equal(find(events, 'student', 'ack_received').data.duplicate, true);
    assert.equal(find(events, 'student', 'ack_received').data.ack.ackId, find(events, 'tutor', 'submission_accepted').data.ackId);
    assert.equal(findAll(events, 'tutor', 'submission_accepted').length, 1, 'recorded once');
    stream.close();
  } finally {
    impatientUi.proc.kill();
    slowTutor.proc.kill();
  }
});

// fetch() silently drops a custom Host header, so forge it with node:http.
const statusWithHost = (baseUrl, path, host) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(baseUrl);
  http.get({ hostname, port, path, headers: { Host: host } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  }).on('error', reject);
});

test('localhost guards: foreign Host headers (DNS rebinding) and cross-origin POSTs are refused', async () => {
  assert.equal(await statusWithHost(ui.url, '/api/events', 'attacker.example:3000'), 421);
  assert.equal(await statusWithHost(tutor.url, '/.well-known/agent-card.json', 'attacker.example'), 421);
  assert.equal(await statusWithHost(tutor.url, '/viz/events', 'attacker.example'), 421);
  const crossOrigin = await post(`${ui.url}/api/forms`, {}, { Origin: 'http://attacker.example' });
  assert.equal(crossOrigin.status, 403);
  const sameOrigin = await fetch(`${ui.url}/api/status`, { headers: { Origin: ui.url } });
  assert.equal(sameOrigin.status, 200);
});
