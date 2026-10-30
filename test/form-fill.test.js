// Part 11: filling an open form from the chat. The Student agent fills fields on the student's side only —
// nothing goes to the university until the student presses the form's own button. Live-mode tests use the
// fake Messages API with scripted output: they prove the plumbing and the code checks, not model judgment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack, waitFor, openStream, post, find, forRun, stateOf, formAction, waitLifecycle } from './support/harness.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import { formFields, codeFills, checkFills, fillUpdates, inReview, maskPersonal, decideFill } from '../src/form-fill.js';
import { buildReviewUpdate, buildEditUpdate, addDays, todayIn } from '../src/forms.js';

const NOW = new Date('2026-10-29T18:00:00Z'); // a Thursday (Pacific)
const TODAY = todayIn(NOW);
const tutoring = { formId: 'f-tutor', workflowId: 'tutoring-request', a2uiMessages: [], updates: [] };
const booking = { formId: 'f-room', workflowId: 'study-room-booking', a2uiMessages: [], updates: [] };
// A generated loan surface (Part 8 shape): each renew button binds a literal loan id to a date picker's path.
const loanSurface = (loans) => ({
  formId: 'f-loan', workflowId: 'loan-renewal', updates: [],
  a2uiMessages: [{ version: 'v0.9', updateComponents: { surfaceId: 'f-loan', components: [
    { id: 'root', component: 'Column', children: loans.map((l) => `card_${l.id}`) },
    ...loans.flatMap((l) => [
      { id: `card_${l.id}`, component: 'Column', children: [`title_${l.id}`, `pick_${l.id}`, `renew_${l.id}`] },
      { id: `title_${l.id}`, component: 'Text', text: l.title },
      { id: `pick_${l.id}`, component: 'DateTimeInput', label: 'New return date', enableDate: true, enableTime: false, min: l.min, max: l.max, value: { path: `/form/${l.id}` } },
      { id: `renew_${l.id}`, component: 'Button', child: `renew_${l.id}_t`, action: { event: { name: 'renewLoan', context: { loanId: l.id, returnDate: { path: `/form/${l.id}` } } } } },
    ]),
  ] } }],
});
const calculus = { id: 'L-1001', title: 'Calculus: Early Transcendentals', min: '2026-11-03', max: '2026-11-23' };
const marketing = { id: 'L-1002', title: 'Principles of Marketing', min: '2026-11-10', max: '2026-11-30' };

test('fields come from the form itself (known workflows, and a generated loan surface’s pickers)', () => {
  assert.deepEqual(formFields(tutoring, { now: NOW }).map((f) => f.field), ['firstName', 'lastName', 'email', 'preferredDate', 'period', 'specificTime', 'notes']);
  assert.deepEqual(formFields(booking, { now: NOW }).map((f) => f.field), ['firstName', 'lastName', 'email', 'date', 'room', 'duration', 'groupSize'], 'no start time until the times are shown');
  const loan = formFields(loanSurface([calculus]), { now: NOW });
  assert.deepEqual(loan.map((f) => [f.field, f.path, f.min, f.max]), [['returnDate:L-1001', '/form/L-1001', '2026-11-03', '2026-11-23']]);
  assert.match(loan[0].words, /calculus/);
});

test('code reads values from the student’s words; names and emails are masked for the model', () => {
  const t = formFields(tutoring, { now: NOW });
  assert.deepEqual(codeFills('I’m Alex Student, alex@example.com, next Friday mornings, I need help with the chain rule.', t, { now: NOW }),
    { email: 'alex@example.com', firstName: 'Alex', lastName: 'Student', preferredDate: '2026-10-30', period: ['morning'], notes: 'the chain rule' });
  const b = formFields(booking, { now: NOW });
  assert.deepEqual(codeFills('room B, 2 hours, 4 people, tomorrow', b, { now: NOW }), { date: addDays(TODAY, 1), room: ['room-b'], duration: ['120'], groupSize: '4' });
  assert.deepEqual(codeFills('November 20', formFields(loanSurface([calculus]), { now: NOW }), { now: NOW }), { 'returnDate:L-1001': '2026-11-20' });
  assert.equal(maskPersonal('My name is Alex Student, alex@example.com'), 'My name is [name] [name], [email]');
  assert.equal(maskPersonal('Alex Student, alex@example.com'), '[name] [name], [email]');
});

test('only values the form accepts are filled; the reason comes back with the allowed range', () => {
  const t = formFields(tutoring, { now: NOW });
  const weekend = checkFills(tutoring, t, { preferredDate: '2026-10-31', period: ['morning'] }, {}, { now: NOW });
  assert.deepEqual(Object.keys(weekend.accepted), ['period']);
  assert.match(weekend.rejected[0].reason, /Monday–Friday/);
  const late = checkFills(tutoring, t, { specificTime: '18:00' }, {}, { now: NOW });
  assert.match(late.rejected[0].reason, /09:00–17:00/);
  const b = formFields(booking, { now: NOW });
  const big = checkFills(booking, b, { room: ['room-a'], groupSize: '8' }, {}, { now: NOW });
  assert.deepEqual(Object.keys(big.accepted), ['room']);
  assert.match(big.rejected[0].reason, /holds up to 4/);
  const loan = loanSurface([calculus]);
  const lf = formFields(loan, { now: NOW });
  assert.match(checkFills(loan, lf, { 'returnDate:L-1001': '2026-10-10' }, {}, { now: NOW }).rejected[0].reason, /outside the permitted range 2026-11-03 to 2026-11-23/);
  assert.deepEqual(checkFills(loan, lf, { 'returnDate:L-1001': '2026-11-20' }, {}, { now: NOW }).accepted, { 'returnDate:L-1001': '2026-11-20' });
});

test('a fill is A2UI updateDataModel; changing a booking’s criteria clears the picked time', () => {
  const b = formFields(booking, { now: NOW });
  const updates = fillUpdates(booking, b, { room: ['room-b'] }, { slot: ['slot-1234'] });
  assert.deepEqual(updates.map((u) => [u.updateDataModel.path, u.updateDataModel.value]), [['/form/room', ['room-b']], ['/form/slot', []]]);
  assert.ok(updates.every((u) => u.version === 'v0.9' && u.updateDataModel.surfaceId === 'f-room'));
});

test('never fill a booking in review; ask which loan when several could take the date', async () => {
  const review = { ...booking, updates: buildReviewUpdate('f-room', ['Name: Alex']) };
  assert.equal(inReview(review), true);
  assert.equal(inReview({ ...booking, updates: [...buildReviewUpdate('f-room', ['x']), ...buildEditUpdate('f-room')] }), false, 'back to edit');
  const r = await decideFill({ text: 'room C', forms: [review], now: NOW });
  assert.equal(r.action, 'fill');
  assert.deepEqual(r.results[0].updates, []);
  assert.match(r.results[0].note, /in review.*Back to edit/);
  const two = loanSurface([calculus, marketing]);
  const unclear = await decideFill({ text: 'November 20', forms: [two], now: NOW });
  assert.match(unclear.results[0].note, /Which loan/);
  const named = await decideFill({ text: 'calculus book to November 20', forms: [two], now: NOW });
  assert.deepEqual(named.results[0].accepted, { 'returnDate:L-1001': '2026-11-20' });
});

test('heuristic (mock/off): a question is chat; values without a question fill', async () => {
  assert.equal((await decideFill({ text: 'When is the library open?', forms: [booking], now: NOW })).action, 'chat');
  assert.equal((await decideFill({ text: 'thanks!', forms: [booking], now: NOW })).action, 'chat', 'nothing to fill');
  const fill = await decideFill({ text: 'room B, 2 hours, 4 people', forms: [booking], now: NOW });
  assert.equal(fill.action, 'fill');
  assert.deepEqual(Object.keys(fill.results[0].accepted).sort(), ['duration', 'groupSize', 'room']);
});

test('live (fake Messages API, scripted): fill_and_chat, invented values dropped, names/emails never sent, failure falls back', async () => {
  const stub = await startFakeAnthropic();
  process.env.ANTHROPIC_API_KEY = `sk-ant-test-${randomUUID()}`;
  process.env.ANTHROPIC_BASE_URL = stub.url;
  try {
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'fill_and_chat', fills: [{ field: 'room', value: 'Room B' }, { field: 'date', value: 'December 25' }], question: 'when is the library open?' })));
    const r = await decideFill({ text: 'Room B please, and when is the library open? I am Alex Student, alex@example.com', forms: [booking], mode: 'live', now: NOW });
    assert.equal(r.action, 'fill_and_chat');
    assert.equal(r.question, 'when is the library open?');
    assert.deepEqual(r.results[0].accepted.room, ['room-b']);
    assert.equal(r.results[0].accepted.date, undefined, 'a date the student never said is dropped');
    assert.equal(r.results[0].accepted.email, 'alex@example.com', 'personal fields come from code');
    const prompt = JSON.stringify(stub.requests.at(-1).body.messages);
    assert.ok(!prompt.includes('alex@example.com') && !prompt.includes('Alex Student'), 'names and emails are masked');
    assert.ok(prompt.includes('[email]') && prompt.includes('[name]'));
    // A plain fill: the model skipped the date, but the code read it — the whole message is about the form.
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'fill', fills: [{ field: 'room', value: 'room B' }], question: '' })));
    const skipped = await decideFill({ text: 'room B tomorrow', forms: [booking], mode: 'live', now: NOW });
    assert.equal(skipped.results[0].accepted.date, addDays(TODAY, 1));
    // fill_and_chat: a date in the QUESTION ("…open on Sunday?") is not filled unless the model named it.
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'fill_and_chat', fills: [{ field: 'duration', value: '2 hours' }], question: 'is the library open on Sunday?' })));
    const scoped = await decideFill({ text: '2 hours — and is the library open on Sunday?', forms: [booking], mode: 'live', now: NOW });
    assert.deepEqual(scoped.results[0].accepted, { duration: ['120'] });
    stub.respondWith(() => ({ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } }));
    const failed = await decideFill({ text: 'room B, 2 hours', forms: [booking], mode: 'live', now: NOW });
    assert.equal(failed.by, 'model_failed');
    assert.equal(failed.action, 'fill', 'fails open to the code heuristic');
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    await stub.close();
  }
});

// ---- end to end (mock stack): nothing reaches the university for a fill --------------------------------
let stack;
let stream;
before(async () => {
  stack = await startStack({ hubEnv: { ROUTER_MODE: 'mock' } });
  stream = await openStream(stack.ui.url);
});
after(() => { stream?.close(); stack?.kill(); });

async function chat(text, contextId, formValues) {
  const res = await post(`${stack.ui.url}/api/runs`, { text, contextId, ...(formValues ? { formValues } : {}) });
  const { runId, contextId: ctx } = await res.json();
  await waitFor(() => ['completed', 'failed', 'uncertain'].includes(stateOf(stream.events, runId)), { what: `run ${runId}`, timeout: 10000 });
  await new Promise((r) => setTimeout(r, 300));
  return { runId, contextId: ctx, events: forRun(stream.events, runId) };
}

test('end to end: a tutoring form filled from the chat, nothing sent; then the student’s own click submits it', async () => {
  const asked = await chat('I want to arrange in-person help with calculus');
  const form = find(asked.events, 'student', 'form_received').data;
  const fill = await chat('I’m Alex Student, alex@example.com, next Monday mornings, I need help with the chain rule', asked.contextId, { [form.formId]: { firstName: '', lastName: '', email: '', preferredDate: '', period: [], specificTime: '', notes: '' } });
  const filled = find(fill.events, 'student', 'form_filled').data;
  assert.deepEqual(filled.fields.sort(), ['email', 'firstName', 'lastName', 'notes', 'period', 'preferredDate']);
  assert.ok(filled.updates.every((u) => u.updateDataModel.surfaceId === form.formId));
  assert.equal(find(fill.events, 'student', 'request_planned').data.action, 'fill');
  assert.ok(!find(fill.events, 'student', 'request_sent') && !find(fill.events, 'hub', 'message_received'), 'nothing went to the university');
  assert.equal(fill.events.find((e) => e.type === 'state' && e.data.state === 'completed').data.decision, 'student_fill');
  // The student's own click, with the filled values: accepted as usual.
  const values = Object.fromEntries(filled.updates.map((u) => [u.updateDataModel.path.slice(6), u.updateDataModel.value]));
  await formAction(stack.ui, form.formId, 'submitTutoringRequest', 'submit_button', { firstName: '', lastName: '', email: '', preferredDate: '', period: [], specificTime: '', notes: '', ...values });
  await waitLifecycle(stream, form.formId, ['accepted', 'editing'], 8000);
});

test('end to end: a booking fill keeps what fits and explains what doesn’t; a question while the form is open is sent', async () => {
  const asked = await chat('I want to reserve a group study room');
  const form = find(asked.events, 'student', 'form_received').data;
  const fill = await chat('room A, 2 hours, 8 people, tomorrow', asked.contextId, { [form.formId]: { firstName: '', lastName: '', email: '', groupSize: '', date: '', room: [], duration: [], slot: [] } });
  const filled = find(fill.events, 'student', 'form_filled').data;
  assert.deepEqual(filled.fields.sort(), ['date', 'duration', 'room']);
  assert.deepEqual(filled.rejected.map((r) => r.field), ['groupSize']);
  assert.match(filled.note, /holds up to 4/);
  const question = await chat('What are the library hours on Sunday?', asked.contextId);
  assert.ok(!find(question.events, 'student', 'form_filled'), 'a question is not a fill');
  assert.ok(find(question.events, 'student', 'request_sent'), 'it goes to the university');
});
