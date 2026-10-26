// Parts 3 + 6 end to end, through the University Hub (Part 7): real Hub, Tutor and UI server processes. Forms appear only because the Tutor
// decided, from a chat message, to send one. The browser is stood in for by the event-stream reader
// and HTTP calls; actions are built exactly as the renderer emits them (see a2ui-render.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import {
  startStack, signedStudent, waitFor, openStream, post, put, find, findAll, formVia, formAction, lifecycleOf, lastLifecycle, waitLifecycle, actionResults,
} from './support/harness.js';
import { askTutor, sendFormAction } from '../src/student-agent.js';
import { TUTORING_ACK } from '../src/tutor-agent.js';
import { addDays, todayIn } from '../src/forms.js';

// A weekday a few days ahead (tutoring runs Monday–Friday).
const weekday = (() => {
  for (let n = 2; ; n++) {
    const d = addDays(todayIn(), n);
    if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) return d;
  }
})();
const ALEX = { firstName: 'Alex', lastName: 'Student', email: 'alex@example.com', preferredDate: weekday, period: ['afternoon'], specificTime: '14:30', notes: 'Chain rule practice.\nSecond line.' };
const ASK = 'I want to arrange in-person help with calculus';
const submit = (ui, formId, context = ALEX, operationId) => formAction(ui, formId, 'submitTutoringRequest', 'submit_button', context, operationId);
const countIn = (text, needle) => text.split(needle).length - 1;

// Content is shown in the Hub's telemetry here so the tests can compare received values.
const SHOW = { HUB_TELEMETRY_SHOW_CONTENT: '1' };
let stack, tutor, ui;
before(async () => {
  stack = await startStack({ library: false, hubEnv: { ...SHOW, HUB_STUDENTS: 'student-alex,student-sam' } });
  ({ tutor, ui } = stack);
});
after(() => stack?.kill());

test('no request-form shortcut: no button in the page, no endpoint that creates a form', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /request-form|Request form/);
  assert.equal((await post(`${ui.url}/api/forms`, {})).status, 404, 'POST /api/forms no longer exists');
  const s = await openStream(ui.url);
  await waitFor(() => s.replayed, { what: 'replay marker' });
  assert.equal(findAll(s.events, 'student', 'form_received').length, 0, 'opening the page creates nothing');
  s.close();
});

test('natural language decides: request → form (with stated preferences only); questions → answers; vague → clarification', async () => {
  const stream = await openStream(ui.url);
  const a = await formVia(ui, stream, 'Can I meet a tutor about derivatives tomorrow afternoon?');
  assert.ok(a.form, 'the Tutor sent the form');
  assert.equal(a.form.workflowId, 'tutoring-request');
  assert.equal(a.form.agentId, 'tutor');
  assert.equal(a.form.lifecycle, 'editing');
  const model = a.form.a2uiMessages.find((m) => m.updateDataModel).updateDataModel.value.form;
  assert.deepEqual(model.period, ['afternoon'], 'stated preference prefilled');
  assert.equal(model.firstName, '', 'names never prefilled');
  assert.equal(model.email, '', 'email never prefilled');
  assert.equal(model.notes, '', 'notes not invented');
  const tomorrowIsWeekday = ![0, 6].includes(new Date(`${addDays(todayIn(), 1)}T12:00:00Z`).getUTCDay());
  assert.equal(model.preferredDate, tomorrowIsWeekday ? addDays(todayIn(), 1) : '', '“tomorrow” → that date, only if tutoring runs then');

  for (const [question, outcome] of [['Explain derivatives', null], ['How does in-person tutoring work?', /request form/], ['I want tutoring', /explain a calculus topic here, or to request an in-person/]]) {
    const r = await formVia(ui, stream, question);
    assert.equal(r.form, null, `${question}: no form`);
    if (outcome) assert.match(r.reply.text, outcome, question);
  }
  stream.close();
});

test('valid round trip: editable form removed at once → pending → read-only receipt; Tutor records exactly once', async () => {
  const stream = await openStream(ui.url);
  const { form } = await formVia(ui, stream, ASK);
  const operationId = randomUUID();
  assert.equal((await submit(ui, form.formId, ALEX, operationId)).status, 202);
  await waitLifecycle(stream, form.formId, ['accepted']);
  assert.deepEqual(lifecycleOf(stream.events, form.formId), ['submitting', 'accepted'], 'pending state shown before the receipt');

  const receipt = lastLifecycle(stream.events, form.formId).receipt;
  assert.match(receipt.requestId, /^TR-/);
  assert.equal(receipt.status, 'Received — awaiting scheduling');
  assert.deepEqual(receipt.preferences, { preferredDate: weekday, period: 'afternoon', specificTime: '14:30', notes: ALEX.notes });
  assert.equal(receipt.demo, true);
  const result = actionResults(stream.events, form.formId, 'submitTutoringRequest').at(-1).data;
  assert.equal(result.text, TUTORING_ACK);
  assert.doesNotMatch(JSON.stringify(stream.events), /appointment booked/i, 'never claims an appointment');
  assert.ok(result.a2uiUpdate.some((m) => m.deleteSurface?.surfaceId === form.formId), 'the agent also closes the surface (standard deleteSurface)');

  await waitFor(() => findAll(stream.events, 'tutor', 'form_action_result').some((e) => e.data.formId === form.formId), { what: 'tutor event' });
  const received = findAll(stream.events, 'tutor', 'form_action_received').find((e) => e.data.formId === form.formId).data;
  assert.deepEqual(received.receivedValues, ALEX, 'Tutor received exactly the submitted values');
  assert.equal(received.resumedTask, true, 'the Hub resumed the Tutor’s own form task');
  assert.notEqual(received.contextId, form.contextId, 'the Tutor sees the Hub’s downstream context, not the Student’s');
  assert.match(form.formRef, /^hf-/, 'the Student holds an opaque Hub form reference');
  assert.equal(countIn(tutor.output(), `requestId: '${receipt.requestId}'`), 1, 'recorded once');
  // After acceptance nothing can be submitted again.
  assert.equal((await submit(ui, form.formId)).status, 409);
  stream.close();
});

test('invalid input: nothing is sent, the form stays editable', async () => {
  const stream = await openStream(ui.url);
  const { form } = await formVia(ui, stream, ASK);
  for (const [patch, field] of [
    [{ firstName: '   ' }, 'firstName'], [{ email: 'alex@' }, 'email'], [{ preferredDate: addDays(todayIn(), -1) }, 'preferredDate'],
    [{ period: [] }, 'period'], [{ period: ['morning'], specificTime: '14:30' }, 'specificTime'], [{ notes: '' }, 'notes'], [{ admin: true }, '_form'],
  ]) {
    const res = await submit(ui, form.formId, { ...ALEX, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.ok((await res.json()).errors[field], field);
  }
  assert.equal((await formAction(ui, form.formId, 'deleteEverything', 'submit_button', ALEX)).status, 400, 'unknown action');
  assert.equal((await formAction(ui, form.formId, 'submitTutoringRequest', 'cancel_button', ALEX)).status, 400, 'wrong button');
  const extra = await post(`${ui.url}/api/forms/${form.formId}/actions`, { operationId: randomUUID(), action: { name: 'submitTutoringRequest', surfaceId: form.formId, sourceComponentId: 'submit_button', context: ALEX, url: 'https://example.com' } });
  assert.equal(extra.status, 400, 'unexpected action key');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(lifecycleOf(stream.events, form.formId), [], 'still editing');
  assert.equal(findAll(stream.events, 'tutor', 'form_action_received').filter((e) => e.data.formId === form.formId).length, 0, 'Tutor received nothing');
  stream.close();
});

test('the Tutor validates independently over A2A: invalid, forged, wrong-form and stale actions are rejected', async () => {
  const { form } = await askTutor(tutor.url, ASK, {});
  const direct = (context, extra = {}) => sendFormAction(tutor.url, { form: { ...form, ...extra.form }, operationId: extra.operationId ?? randomUUID(), action: { name: extra.name ?? 'submitTutoringRequest', surfaceId: extra.surfaceId ?? form.formId, sourceComponentId: extra.button ?? 'submit_button', timestamp: new Date().toISOString(), context } });
  for (const [label, context, extra, pattern] of [
    ['blank name', { ...ALEX, firstName: ' ' }, {}, /First name/],
    ['bad email', { ...ALEX, email: 'nope' }, {}, /email/],
    ['extra field', { ...ALEX, role: 'admin' }, {}, /Unexpected field/],
    ['unknown action', ALEX, { name: 'deleteEverything' }, /Unknown action/],
    ['forged button', ALEX, { button: 'cancel_button' }, /own button/],
    ['stale form version', ALEX, { form: { formVersion: 7 } }, /out of date/],
    ['other surface', ALEX, { surfaceId: 'tutoring-request-forged' }, /Unknown form/],
  ]) {
    const r = await direct(context, extra);
    assert.equal(r.body.status, 'rejected', label);
    assert.match(JSON.stringify(r.body.errors), pattern, label);
  }
  // Correlation: an action from a different conversation that doesn't reference the task.
  const other = await sendFormAction(tutor.url, { form: { ...form, contextId: randomUUID(), taskId: randomUUID() }, operationId: randomUUID(), action: { name: 'submitTutoringRequest', surfaceId: form.formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: ALEX } }).catch((e) => ({ body: { status: 'rejected', errors: { _form: e.message } } }));
  assert.equal(other.body.status, 'rejected', 'uncorrelated action rejected');
  const ok = await direct(ALEX);
  assert.equal(ok.body.status, 'accepted');
});

test('duplicate operations: double-click sends once; an identical retry returns the stored receipt; reuse with other values is refused', async () => {
  const stream = await openStream(ui.url);
  const { form } = await formVia(ui, stream, ASK);
  const operationId = randomUUID();
  const [a, b] = await Promise.all([submit(ui, form.formId, ALEX, operationId), submit(ui, form.formId, ALEX, operationId)]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  await waitLifecycle(stream, form.formId, ['accepted']);
  const first = lastLifecycle(stream.events, form.formId).receipt;

  assert.equal(countIn(tutor.output(), `requestId: '${first.requestId}'`), 1, 'recorded once');

  // The identical retry goes where the Student's retries go: to the Hub, which returns its stored result.
  // (Part 9: direct Hub calls are signed, so this part uses a test student's own form and session.)
  const sam = await signedStudent(stack.hub.url, 'student-sam');
  const own = (await askTutor(stack.hub.url, ASK, sam)).form;
  const act = (context) => ({ name: 'submitTutoringRequest', surfaceId: own.formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context });
  const ownOp = randomUUID();
  const firstSam = await sendFormAction(stack.hub.url, { form: own, operationId: ownOp, action: act(ALEX), ...sam });
  assert.equal(firstSam.body.status, 'accepted');
  const again = await sendFormAction(stack.hub.url, { form: own, operationId: ownOp, action: act(ALEX), ...sam });
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.body.receipt, firstSam.body.receipt, 'same receipt, nothing re-executed');
  assert.equal(again.taskId, null, 'the completed task was not resumed (new message referencing it)');
  const different = await sendFormAction(stack.hub.url, { form: own, operationId: ownOp, action: act({ ...ALEX, firstName: 'Sam' }), ...sam });
  assert.match(JSON.stringify(different.body.errors), /already used with different values/);
  assert.equal(countIn(tutor.output(), `requestId: '${firstSam.body.receipt.requestId}'`), 1, 'recorded once');
  stream.close();
});

test('one editable form per workflow per conversation: repeats ask first; explicit replacement supersedes the old form', async () => {
  const stream = await openStream(ui.url);
  const first = await formVia(ui, stream, ASK);
  const repeat = await formVia(ui, stream, 'Can I book an in-person tutoring session?', first.contextId);
  assert.equal(repeat.form, null, 'no second form stacked');
  assert.match(repeat.reply.text, /already have an open tutoring request form/);
  assert.deepEqual(lifecycleOf(stream.events, first.form.formId), [], 'the draft form is untouched');

  const replaced = await formVia(ui, stream, 'Please replace the form, I want in-person tutoring on a different day', first.contextId);
  assert.ok(replaced.form, 'new form after an explicit request');
  assert.equal(replaced.form.supersedes, first.form.formId);
  assert.equal(lastLifecycle(stream.events, first.form.formId).state, 'superseded');
  assert.equal((await submit(ui, first.form.formId)).status, 409, 'a superseded form accepts nothing');
  // A genuinely new request after completion gets a new form with new identifiers.
  await submit(ui, replaced.form.formId);
  await waitLifecycle(stream, replaced.form.formId, ['accepted']);
  const fresh = await formVia(ui, stream, ASK, first.contextId);
  assert.ok(fresh.form && fresh.form.formId !== replaced.form.formId);
  stream.close();
});

test('reconnect / history replay reconstructs current state and never resubmits or resurrects a form', async () => {
  const stream = await openStream(ui.url);
  const { form } = await formVia(ui, stream, ASK);
  await submit(ui, form.formId);
  await waitLifecycle(stream, form.formId, ['accepted']);
  stream.close();
  const before = countIn(tutor.output(), 'received form action');
  for (let i = 0; i < 3; i++) {
    const again = await openStream(ui.url);
    await waitFor(() => again.replayed, { what: 'replay marker' });
    assert.ok(find(again.events, 'student', 'form_received'), 'creation event replayed…');
    assert.equal(lastLifecycle(again.events, form.formId).state, 'accepted', '…followed by its current state, so the browser shows only the receipt');
    again.close();
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(countIn(tutor.output(), 'received form action'), before, 'Tutor received nothing new');
});

test('Cancel removes the form without calling the handler; New conversation closes open forms', async () => {
  const stream = await openStream(ui.url);
  const { form } = await formVia(ui, stream, ASK);
  assert.equal((await formAction(ui, form.formId, 'cancelForm', 'cancel_button')).status, 202);
  await waitFor(() => actionResults(stream.events, form.formId, 'cancelForm').length, { what: 'cancel result' });
  assert.deepEqual(lifecycleOf(stream.events, form.formId), ['cancelled']);
  assert.equal(actionResults(stream.events, form.formId, 'cancelForm')[0].data.body.status, 'cancelled');
  assert.equal((await submit(ui, form.formId)).status, 409);
  assert.doesNotMatch(tutor.output().split(form.formId).slice(1).join(''), /recorded tutoring request/, 'no request recorded for a cancelled form');

  const open = await formVia(ui, stream, ASK);
  assert.equal((await post(`${ui.url}/api/conversation/new`, {})).status, 202);
  await waitLifecycle(stream, open.form.formId, ['cancelled']);
  assert.equal(lastLifecycle(stream.events, open.form.formId).reason, 'new_conversation');
  stream.close();
});

test('a disabled workflow can neither send nor accept forms', async () => {
  const own = await startStack({ library: false });
  const u = own.ui;
  try {
    const stream = await openStream(u.url);
    const { form } = await formVia(u, stream, ASK);
    const cfg = await (await fetch(`${u.url}/api/agents/tutor/skills`)).json();
    cfg.config.skills.find((s) => s.id === 'in-person-tutoring-request').enabled = false;
    assert.equal((await put(`${u.url}/api/agents/tutor/skills`, { config: cfg.config, baseRevision: cfg.revision })).status, 200);
    await submit(u, form.formId);
    await waitLifecycle(stream, form.formId, ['rejected']);
    assert.match(JSON.stringify(lastLifecycle(stream.events, form.formId).errors), /no longer offered/);
    const r = await formVia(u, stream, ASK);
    assert.equal(r.form, null);
    assert.match(r.reply.text, /aren’t offered/);
    stream.close();
  } finally {
    own.kill();
  }
});

test('known failure → explicit “Edit and retry” restores the values; an unavailable Tutor is reported, never claimed', async () => {
  const own = await startStack({ library: false });
  const { tutor: t, ui: u } = own;
  try {
    const stream = await openStream(u.url);
    const { form } = await formVia(u, stream, ASK);
    t.proc.kill();
    await new Promise((r) => t.proc.once('exit', r));
    await submit(u, form.formId);
    await waitLifecycle(stream, form.formId, ['rejected']);
    const failed = lastLifecycle(stream.events, form.formId);
    assert.equal(failed.notDelivered, true);
    assert.ok(!findAll(stream.events, 'system', 'form_lifecycle').some((e) => e.data.state === 'accepted'));
    const edit = await post(`${u.url}/api/forms/${form.formId}/edit`, {});
    assert.equal(edit.status, 200);
    assert.deepEqual((await edit.json()).values, ALEX, 'saved values restored');
    await waitLifecycle(stream, form.formId, ['editing']);
    assert.deepEqual(lastLifecycle(stream.events, form.formId).values, ALEX, 'the reopen event itself carries the values (reload/other tabs)');
    assert.equal(lastLifecycle(stream.events, form.formId).restored, true);
    // With the Tutor gone (it signed out), the Hub says so for a new request instead of dispatching it.
    const r = await post(`${u.url}/api/runs`, { text: ASK });
    const { runId } = await r.json();
    const reply = await waitFor(() => find(stream.events.filter((e) => e.runId === runId), 'student', 'reply_received'), { what: 'unavailable reply' });
    assert.equal(reply.data.hub.decision, 'unavailable');
    stream.close();
  } finally {
    own.kill();
  }
});

test('unknown outcome → “Confirmation pending”: no blind resubmission; reconcile with the same operation ID records once', async () => {
  // A Tutor that takes 1.2 s on its first form action, and a Student that gives up after 400 ms.
  // The Student↔Hub leg times out; the Hub (patient) still gets the Tutor's result and stores it.
  const own = await startStack({ library: false, hubEnv: SHOW, tutorEnv: { TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS: '1200' }, uiEnv: { SUBMIT_TIMEOUT_MS: '400' } });
  const { tutor: slow, ui: impatient } = own;
  try {
    const stream = await openStream(impatient.url);
    const { form } = await formVia(impatient, stream, ASK);
    const operationId = randomUUID();
    await submit(impatient, form.formId, ALEX, operationId);
    await waitLifecycle(stream, form.formId, ['confirmation_pending']);
    // Meanwhile the Tutor did record it — which is exactly why "pending", not "failed", is honest.
    await waitFor(() => findAll(stream.events, 'tutor', 'form_action_result').some((e) => e.data.formId === form.formId && e.data.status === 'accepted'), { timeout: 4000, what: 'late acceptance' });
    assert.equal(lastLifecycle(stream.events, form.formId).state, 'confirmation_pending', 'no silent retry');
    assert.equal((await submit(impatient, form.formId, ALEX, randomUUID())).status, 409, 'no new submission while pending');
    assert.equal((await post(`${impatient.url}/api/forms/${form.formId}/edit`, {})).status, 409, 'no edit-and-retry while pending');

    assert.equal((await post(`${impatient.url}/api/forms/${form.formId}/reconcile`, {})).status, 202);
    await waitLifecycle(stream, form.formId, ['accepted']);
    const final = lastLifecycle(stream.events, form.formId);
    assert.equal(final.duplicate, true, 'the stored result came back');
    const sends = findAll(stream.events, 'student', 'form_action_sent').filter((e) => e.data.formId === form.formId);
    assert.deepEqual(sends.map((e) => e.data.operationId), [operationId, operationId], 'same operation ID');
    assert.equal(sends[1].data.mode, 'new-message-referencing-task', 'did not try to resume the completed task');
    assert.equal(countIn(slow.output(), 'recorded tutoring request'), 1, 'recorded once');
    stream.close();
  } finally {
    own.kill();
  }
});

test('review: a flagged submission comes back unrecorded; “Send anyway” records it; changed values are reviewed again', async () => {
  const stream = await openStream(ui.url);
  const { form } = await formVia(ui, stream, ASK);
  const typo = { ...ALEX, email: 'alex@gmial.com' };
  const recorded = () => countIn(tutor.output(), 'recorded tutoring request');
  const before = recorded();
  // Claiming "send anyway" without any earlier review doesn't skip the review.
  await post(`${ui.url}/api/forms/${form.formId}/actions`, { operationId: randomUUID(), acknowledgeReview: true, action: { name: 'submitTutoringRequest', surfaceId: form.formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: typo } });
  await waitFor(() => lastLifecycle(stream.events, form.formId)?.review, { what: 'flagged' });
  const flagged = lastLifecycle(stream.events, form.formId);
  assert.equal(flagged.state, 'editing');
  assert.match(flagged.flags[0].message, /typo/);
  assert.deepEqual(flagged.values, typo, 'the submitted values come back for editing');
  assert.equal(recorded(), before, 'nothing recorded');
  const reply = actionResults(stream.events, form.formId, 'submitTutoringRequest').at(-1).data;
  assert.equal(reply.body.status, 'needs_review');

  // Edited values are reviewed again (and pass).
  await submit(ui, form.formId, { ...typo, email: 'alex@example.com', notes: 'Related rates.' });
  await waitLifecycle(stream, form.formId, ['accepted']);
  assert.equal(recorded(), before + 1);

  // "Send anyway" for exactly the flagged values records them without another review.
  const other = (await formVia(ui, stream, ASK)).form;
  await submit(ui, other.formId, typo);
  await waitFor(() => lastLifecycle(stream.events, other.formId)?.review, { what: 'flagged again' });
  await post(`${ui.url}/api/forms/${other.formId}/actions`, { operationId: randomUUID(), acknowledgeReview: true, action: { name: 'submitTutoringRequest', surfaceId: other.formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: typo } });
  await waitLifecycle(stream, other.formId, ['accepted']);
  assert.ok(stream.events.some((e) => e.source === 'tutor' && e.type === 'form_review' && e.data.formId === other.formId && e.data.acknowledged));
  assert.equal((await post(`${ui.url}/api/forms/${other.formId}/actions`, { operationId: randomUUID(), acknowledgeReview: 'yes', action: {} })).status, 400, 'acknowledgeReview must be a boolean');
  stream.close();
});

test('privacy: contact details stay out of Tutor logs; drafts never leave the browser before submit', async () => {
  const stream = await openStream(ui.url);
  const { form } = await formVia(ui, stream, ASK);
  const marker = `privacy-${randomUUID().slice(0, 8)}@example.com`;
  await submit(ui, form.formId, { ...ALEX, email: marker });
  await waitLifecycle(stream, form.formId, ['accepted']);
  assert.ok(!tutor.output().includes(marker), 'email not logged by the Tutor');
  assert.ok(!ui.output().includes(marker), 'email not logged by the UI server');
  assert.ok(!stack.hub.output().includes(marker), 'email not logged by the Hub');
  stream.close();
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
  assert.equal(await statusWithHost(stack.hub.url, '/.well-known/agent-card.json', 'attacker.example'), 421);
  assert.equal(await statusWithHost(stack.hub.url, '/viz/events', 'attacker.example'), 421);
  const crossOrigin = await post(`${ui.url}/api/runs`, { text: ASK }, { Origin: 'http://attacker.example' });
  assert.equal(crossOrigin.status, 403);
  const sameOrigin = await fetch(`${ui.url}/api/status`, { headers: { Origin: ui.url } });
  assert.equal(sameOrigin.status, 200);
});
