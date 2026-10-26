// Part 6: the Library's group study-room booking workflow — routed chat → form → demo availability
// from the fixture → review → atomic confirmation → receipt. Real processes, mock router (no paid calls).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTrio, startLibrary, openStream, waitFor, findAll, formVia, formAction, lifecycleOf, lastLifecycle, waitLifecycle, actionResults } from './support/harness.js';
import { askTutor, sendFormAction } from '../src/student-agent.js';
import { addDays, todayIn } from '../src/forms.js';

const DATE = addDays(todayIn(), 2);
const CRIT = { date: DATE, room: ['room-b'], duration: ['60'], groupSize: '4' };
const SAM = { firstName: 'Sam', lastName: 'Student', email: 'sam@example.com' };
const ASK = 'I want to reserve a group study room';

let trio, stream;
before(async () => {
  trio = await startTrio({ uiEnv: { ROUTER_MODE: 'mock' } });
  stream = await openStream(trio.ui.url);
});
after(() => {
  stream?.close();
  trio?.kill();
});

// Run one non-final action and wait for its result event.
async function act(formId, name, button, context) {
  const before = actionResults(stream.events, formId, name).length;
  const res = await formAction(trio.ui, formId, name, button, context);
  if (res.status !== 202) return { http: res.status, ...(await res.json()) };
  await waitFor(() => actionResults(stream.events, formId, name).length > before, { what: name });
  return actionResults(stream.events, formId, name).at(-1).data;
}
const slotOptions = (result) => result.a2uiUpdate.find((m) => m.updateComponents?.components?.[0]?.id === 'slot').updateComponents.components[0].options;
const slotFor = (result, label) => slotOptions(result).find((o) => o.label === label)?.value;
// Each test starts its own conversation (which also closes forms left open by earlier tests).
async function newForm(question = ASK) {
  await fetch(`${trio.ui.url}/api/conversation/new`, { method: 'POST', headers: { Origin: trio.ui.url } });
  await new Promise((r) => setTimeout(r, 50));
  return (await formVia(trio.ui, stream, question)).form;
}

test('a room request is routed to the Library, which sends its form; an informational question gets an answer', async () => {
  const r = await formVia(trio.ui, stream, 'I want to reserve a group study room for 5 people');
  assert.equal(r.decision.agentId, 'library');
  assert.equal(r.form.workflowId, 'study-room-booking');
  assert.equal(r.form.agentId, 'library');
  assert.deepEqual(r.form.prefilled, ['groupSize']);
  const hours = await formVia(trio.ui, stream, 'What are the library opening hours?', r.contextId);
  assert.equal(hours.form, null);
  assert.match(hours.reply.text, /Monday/);
});

test('availability comes only from the fixture, for scheduling fields only; changing criteria refreshes and clears the slot', async () => {
  const form = await newForm();
  const first = await act(form.formId, 'checkAvailability', 'check_button', CRIT);
  const labels = slotOptions(first).map((o) => o.label);
  assert.ok(labels.includes('09:00–10:00') && !labels.includes('10:00–11:00'), 'fixture-booked hour not offered');
  assert.ok(first.a2uiUpdate.some((m) => m.updateDataModel?.path === '/form/slot' && m.updateDataModel.value.length === 0), 'selection cleared');
  const seen = findAll(stream.events, 'library', 'form_action_received').filter((e) => e.data.formId === form.formId).at(-1).data;
  assert.deepEqual(Object.keys(seen.criteria).sort(), ['date', 'duration', 'groupSize', 'room'], 'the Library saw scheduling fields only');
  assert.equal(seen.receivedValues, null);

  const twoHours = await act(form.formId, 'checkAvailability', 'check_button', { ...CRIT, duration: ['120'] });
  assert.ok(slotOptions(twoHours).every((o) => /^\d\d:00–\d\d:00$/.test(o.label) && Number(o.label.slice(6, 8)) - Number(o.label.slice(0, 2)) === 2));
  assert.ok(!slotOptions(twoHours).some((o) => o.label === '09:00–11:00'), 'overlaps the 10:00 booking');
  // A lookup with contact details is refused before anything is sent.
  assert.equal((await formAction(trio.ui, form.formId, 'checkAvailability', 'check_button', { ...CRIT, ...SAM })).status, 400);
  assert.equal((await formAction(trio.ui, form.formId, 'checkAvailability', 'check_button', { ...CRIT, groupSize: '9' })).status, 400, 'over capacity');
});

test('review is required; forged, stale and mismatched slots are rejected without substitution', async () => {
  const form = await newForm();
  const avail = await act(form.formId, 'checkAvailability', 'check_button', CRIT);
  const slot = slotFor(avail, '13:00–14:00');
  const full = { ...SAM, ...CRIT, slot: [slot] };
  const forged = await act(form.formId, 'reviewBooking', 'review_button', { ...full, slot: ['slot-deadbeef'] });
  assert.equal(forged.body.status, 'rejected');
  assert.match(forged.body.errors.slot, /wasn’t offered/);
  const mismatched = await act(form.formId, 'reviewBooking', 'review_button', { ...full, room: ['room-c'] });
  assert.match(mismatched.body.errors.slot, /doesn’t match/);
  const review = await act(form.formId, 'reviewBooking', 'review_button', full);
  assert.equal(review.body.status, 'updated');
  const lines = review.a2uiUpdate[0].updateComponents.components.filter((c) => c.id.startsWith('review_line')).map((c) => c.text);
  assert.ok(lines.includes('Time: 13:00–14:00 (Pacific Time (America/Los_Angeles))') && lines.includes('Room: Room B — Floor 2'), lines.join(' / '));
  assert.ok(review.a2uiUpdate[0].updateComponents.components.some((c) => c.id === 'confirm_button_label' && c.text === 'Confirm demo booking'));
  assert.equal(lifecycleOf(stream.events, form.formId).length, 0, 'reviewing reserves nothing and keeps the form editable');

  const confirmRes = await formAction(trio.ui, form.formId, 'confirmStudyRoomBooking', 'confirm_button', full);
  assert.equal(confirmRes.status, 202);
  await waitLifecycle(stream, form.formId, ['accepted']);
  assert.deepEqual(lifecycleOf(stream.events, form.formId), ['submitting', 'accepted']);
  const receipt = lastLifecycle(stream.events, form.formId).receipt;
  assert.match(receipt.bookingId, /^BK-/);
  assert.deepEqual([receipt.room, receipt.date, receipt.start, receipt.end, receipt.demo], ['Room B — Floor 2', DATE, '13:00', '14:00', true]);
  assert.match(receipt.timezone, /America\/Los_Angeles/);
  const text = actionResults(stream.events, form.formId, 'confirmStudyRoomBooking').at(-1).data.text;
  assert.equal(text, 'Your group study room is booked.');
  await waitFor(() => findAll(stream.events, 'library', 'form_action_result').some((e) => e.data.formId === form.formId && e.data.status === 'accepted'), { what: 'library receipt' });
  // The Library visibly sends the confirmation back (after recording it), not only records it.
  await waitFor(() => findAll(stream.events, 'library', 'form_reply_sent').some((e) => e.data.formId === form.formId && e.data.status === 'accepted'), { what: 'library reply sent' });
  const libEvents = stream.events.filter((e) => e.source === 'library' && e.data?.formId === form.formId).map((e) => e.type);
  assert.ok(libEvents.lastIndexOf('form_action_result') < libEvents.lastIndexOf('form_reply_sent'), 'result recorded, then the reply sent');
  const sent = findAll(stream.events, 'library', 'form_reply_sent').filter((e) => e.data.formId === form.formId).at(-1).data;
  assert.equal(sent.text, 'Your group study room is booked.');
  assert.equal(sent.receipt.bookingId, receipt.bookingId);
  assert.equal(sent.taskState, 'completed');

  // The booked time is gone from availability for everyone.
  const next = await newForm();
  const after = await act(next.formId, 'checkAvailability', 'check_button', CRIT);
  assert.ok(!slotOptions(after).some((o) => o.label === '13:00–14:00'));
  // A stale slot ID from another form is not accepted here.
  const stale = await act(next.formId, 'reviewBooking', 'review_button', { ...full });
  assert.match(stale.body.errors.slot, /wasn’t offered/);
});

test('confirming without review is refused by the Library; the form becomes recoverable', async () => {
  const form = await newForm();
  const avail = await act(form.formId, 'checkAvailability', 'check_button', CRIT);
  await formAction(trio.ui, form.formId, 'confirmStudyRoomBooking', 'confirm_button', { ...SAM, ...CRIT, slot: [slotFor(avail, '15:00–16:00')] });
  await waitLifecycle(stream, form.formId, ['rejected']);
  assert.match(JSON.stringify(lastLifecycle(stream.events, form.formId).errors), /Review the booking/);
  const edit = await fetch(`${trio.ui.url}/api/forms/${form.formId}/edit`, { method: 'POST', headers: { Origin: trio.ui.url } });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).values.firstName, 'Sam');
  await waitLifecycle(stream, form.formId, ['editing']);
  const reopened = lastLifecycle(stream.events, form.formId).values;
  assert.equal(reopened.email, 'sam@example.com', 'values come back with the reopened form');
  assert.deepEqual(reopened.slot, [slotFor(avail, '15:00–16:00')], 'not a conflict, so the chosen time is kept');
});

test('an unclear request gets a question first; “yes” then opens the form (the Library remembers its own question)', async () => {
  const library = await startLibrary({ STUDENT_A2A_URL: 'http://127.0.0.1:9' });
  try {
    const contextId = randomUUID();
    const q = await askTutor(library.url, 'I need a room', { contextId });
    assert.equal(q.form ?? null, null);
    assert.match(q.text, /book a group study room\?/);
    const yes = await askTutor(library.url, 'yes please', { contextId });
    assert.equal(yes.form?.workflowId, 'study-room-booking');
    const other = await askTutor(library.url, 'yes please', { contextId: randomUUID() });
    assert.equal(other.form ?? null, null, 'a bare “yes” in another conversation means nothing');
  } finally {
    library.proc.kill();
  }
});

test('concurrent confirmations for the same slot: exactly one booking; the other gets a conflict and fresh alternatives', async () => {
  const library = await startLibrary({ STUDENT_A2A_URL: 'http://127.0.0.1:9' });
  try {
    const crit = { date: addDays(todayIn(), 3), room: ['room-c'], duration: ['120'], groupSize: '8' };
    const action = (form, name, button, context) => ({ name, surfaceId: form.formId, sourceComponentId: button, timestamp: new Date().toISOString(), context });
    const contenders = [];
    for (const who of ['Alex', 'Sam']) {
      const { form } = await askTutor(library.url, ASK, {}); // separate conversations
      const avail = await sendFormAction(library.url, { form, operationId: randomUUID(), action: action(form, 'checkAvailability', 'check_button', crit) });
      const slot = slotFor(avail, '15:00–17:00');
      const full = { firstName: who, lastName: 'Student', email: `${who.toLowerCase()}@example.com`, ...crit, slot: [slot] };
      assert.equal((await sendFormAction(library.url, { form, operationId: randomUUID(), action: action(form, 'reviewBooking', 'review_button', full) })).body.status, 'updated');
      contenders.push({ form, full });
    }
    assert.notEqual(contenders[0].full.slot[0], contenders[1].full.slot[0], 'slot IDs are per form');
    const results = await Promise.all(contenders.map(({ form, full }) => sendFormAction(library.url, { form, operationId: randomUUID(), action: action(form, 'confirmStudyRoomBooking', 'confirm_button', full) })));
    assert.deepEqual(results.map((r) => r.body.status).sort(), ['accepted', 'conflict']);
    const loser = results.find((r) => r.body.status === 'conflict');
    assert.match(loser.body.errors.slot, /just taken/);
    assert.ok(!slotOptions(loser).some((o) => o.label === '15:00–17:00'), 'alternatives exclude the taken time');
    assert.ok(!loser.body.receipt, 'no substitute booking was made');
    assert.equal((library.output().match(/recorded demo booking/g) ?? []).length, 1, 'one booking in the store');
  } finally {
    library.proc.kill();
  }
});

test('form actions always go to the issuing agent, whatever the conversation is about now', async () => {
  const form = await newForm();
  const r = await formVia(trio.ui, stream, 'Explain the derivative of x squared'); // conversation moves to the Tutor
  assert.equal(r.decision.agentId, 'tutor');
  const tutorBefore = findAll(stream.events, 'tutor', 'form_action_received').length;
  await act(form.formId, 'checkAvailability', 'check_button', CRIT);
  assert.equal(findAll(stream.events, 'library', 'form_action_received').at(-1).data.formId, form.formId);
  assert.equal(findAll(stream.events, 'tutor', 'form_action_received').length, tutorBefore, 'nothing reached the Tutor');
});
