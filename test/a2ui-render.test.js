// The A2UI payloads the agents actually send over A2A — in reply to ordinary chat messages — are
// (1) valid against the official A2UI v0.9 JSON Schemas and (2) what drives the forms drawn by the
// official Lit renderer. Runs in its own file/process because jsdom installs browser globals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTutor, startLibrary } from './support/harness.js';
import { validateServerToClientList, validateClientToServerList } from './support/a2ui-schema.js';
import { setupDom, settle, queryAllDeep } from './support/render-form.js';
import { askTutor, sendFormAction } from '../src/student-agent.js';
import { A2UI_VERSION, addDays, todayIn } from '../src/forms.js';

let tutor, library, tutoringForm, roomForm, slotUpdate, renderer;

before(async () => {
  tutor = await startTutor({ STUDENT_A2A_URL: 'http://127.0.0.1:9' });
  library = await startLibrary({ STUDENT_A2A_URL: 'http://127.0.0.1:9' });
  // Real A2A round trips, triggered by natural language — there is no "request form" call.
  tutoringForm = (await askTutor(tutor.url, 'I want to arrange in-person help with calculus', {})).form;
  roomForm = (await askTutor(library.url, 'I want to reserve a group study room', {})).form;
  const context = { date: addDays(todayIn(), 2), room: ['room-b'], duration: ['60'], groupSize: '4' };
  slotUpdate = (await sendFormAction(library.url, { form: roomForm, operationId: randomUUID(), action: { name: 'checkAvailability', surfaceId: roomForm.formId, sourceComponentId: 'check_button', timestamp: new Date().toISOString(), context } })).a2uiUpdate;
  renderer = await setupDom();
});
after(() => {
  tutor?.proc.kill();
  library?.proc.kill();
});

function mount(messages, formId) {
  const actions = [];
  const processor = new renderer.MessageProcessor([renderer.basicCatalog], (a) => actions.push(a));
  // Copy: the renderer adopts updateDataModel values by reference and mutates them as the user types.
  processor.processMessages(structuredClone(messages));
  const surface = processor.model.getSurface(formId);
  const el = document.createElement('a2ui-surface');
  el.surface = surface;
  document.body.replaceChildren(el);
  return { actions, surface, root: el, processor };
}
const text = (root) => queryAllDeep(root, '*').map((n) => (n.children.length ? '' : n.textContent.trim())).filter(Boolean);
const typeInto = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const button = (root, label) => queryAllDeep(root, 'button').find((b) => b.textContent.trim() === label);

test('both forms and the availability update validate against the official v0.9 schemas', () => {
  assert.equal(validateServerToClientList(tutoringForm.a2uiMessages), null);
  assert.equal(validateServerToClientList(roomForm.a2uiMessages), null);
  assert.equal(validateServerToClientList(slotUpdate), null);
  assert.equal(validateServerToClientList([{ version: A2UI_VERSION, deleteSurface: { surfaceId: roomForm.formId } }]), null, 'removal is a standard message');
  // Negative control: the validator really rejects non-catalog components.
  const tampered = structuredClone(tutoringForm.a2uiMessages);
  tampered[1].updateComponents.components.push({ id: 'x', component: 'Blink' });
  assert.notEqual(validateServerToClientList(tampered), null);
});

test('the tutoring form is drawn from the received description', async () => {
  const { root } = mount(tutoringForm.a2uiMessages, tutoringForm.formId);
  await settle();
  const shown = text(root).join(' | ');
  for (const label of ['Request an in-person calculus tutoring session', 'Tell us your preferences. This submits a request; it does not book a time.',
    'First name', 'Last name', 'Email', 'Preferred date', 'Preferred time of day', 'Morning', 'Afternoon', 'Preferred specific time (optional)',
    'Describe what you’d like help with.', 'Send tutoring request', 'Cancel']) {
    assert.ok(shown.includes(label), `shows “${label}”`);
  }
  assert.match(shown, /Pacific Time/, 'timezone shown');
  assert.match(shown, /Morning = 09:00–12:00, afternoon = 12:00–17:00/, 'period boundaries shown');
  assert.ok(queryAllDeep(root, 'input[type="date"]').length === 1 && queryAllDeep(root, 'input[type="time"]').length === 1);
  assert.equal(queryAllDeep(root, 'textarea').length, 1, 'notes are multiline');

  // Change the description → the rendering changes. Nothing is hardcoded in the page.
  const altered = structuredClone(tutoringForm.a2uiMessages);
  altered[1].updateComponents.components.find((c) => c.id === 'email').label = 'School email';
  const second = mount(altered, tutoringForm.formId);
  await settle();
  assert.ok(text(second.root).includes('School email'));
});

test('editing fields only changes local draft state: no action, nothing sent', async () => {
  const { actions, surface, root } = mount(tutoringForm.a2uiMessages, tutoringForm.formId);
  await settle();
  const [first] = queryAllDeep(root, 'input');
  typeInto(first, 'Alex');
  typeInto(queryAllDeep(root, 'textarea')[0], 'Draft notes');
  await settle();
  assert.equal(surface.dataModel.get('/form/firstName'), 'Alex');
  assert.equal(actions.length, 0, 'typing emits no A2UI action');
  await new Promise((r) => setTimeout(r, 150));
  assert.doesNotMatch(tutor.output(), /form action/, 'Tutor received no action');
  assert.doesNotMatch(tutor.output(), /Draft notes/);
});

test('Send emits a schema-valid action with the bound values; inline errors appear after a submit attempt', async () => {
  const { actions, surface, root } = mount(tutoringForm.a2uiMessages, tutoringForm.formId);
  await settle();
  assert.equal(queryAllDeep(root, '.a2ui-error-message').length, 0, 'untouched form shows no errors');
  typeInto(queryAllDeep(root, 'input')[0], '   ');
  button(root, 'Send tutoring request').click();
  await settle();
  assert.equal(actions.length, 1);
  const { name, surfaceId, sourceComponentId, timestamp, context } = actions[0];
  assert.equal(name, 'submitTutoringRequest');
  assert.equal(surfaceId, tutoringForm.formId);
  assert.equal(sourceComponentId, 'submit_button');
  assert.deepEqual(Object.keys(context).sort(), ['email', 'firstName', 'lastName', 'notes', 'period', 'preferredDate', 'specificTime']);
  assert.equal(validateClientToServerList([{ version: A2UI_VERSION, action: { name, surfaceId, sourceComponentId, timestamp, context } }]), null);
  surface.dataModel.set('/ui/submitAttempted', true);
  await settle();
  const errors = queryAllDeep(root, '.a2ui-error-message').map((e) => e.textContent.trim());
  assert.ok(errors.includes('First name is required.'), 'whitespace-only name rejected');
  assert.ok(errors.includes('Describe what you’d like help with.') || errors.includes('A description is required.'));
});

test('room form: the Library’s availability update replaces the slot options in place', async () => {
  const { root, processor, surface } = mount(roomForm.a2uiMessages, roomForm.formId);
  await settle();
  assert.ok(text(root).includes('Choose group size, date, room and duration to see demo availability.'));
  surface.dataModel.set('/form/slot', ['stale-choice']);
  processor.processMessages(structuredClone(slotUpdate));
  await settle();
  const slots = queryAllDeep(root, 'button').map((b) => b.textContent.trim()).filter((t) => /^\d\d:\d\d–\d\d:\d\d$/.test(t));
  assert.ok(slots.length > 3, `slots shown: ${slots}`);
  assert.ok(!slots.includes('10:00–11:00'), 'a fixture-booked hour is not offered');
  assert.deepEqual(surface.dataModel.get('/form/slot'), [], 'a stale selection is cleared');
  assert.ok(text(root).some((t) => t.includes('Demo availability')));
});

test('deleteSurface (the standard removal) unmounts the form and its handlers', async () => {
  const { processor, root, actions } = mount(tutoringForm.a2uiMessages, tutoringForm.formId);
  await settle();
  const submit = button(root, 'Send tutoring request');
  let deleted = null;
  processor.model.onSurfaceDeleted.subscribe((id) => (deleted = id));
  processor.processMessages([{ version: A2UI_VERSION, deleteSurface: { surfaceId: tutoringForm.formId } }]);
  await settle();
  assert.equal(deleted, tutoringForm.formId);
  assert.equal(processor.model.getSurface(tutoringForm.formId), undefined, 'surface gone from the renderer’s model');
  submit.click(); // a stale click on the detached button
  await settle();
  assert.equal(actions.length, 0, 'a removed form emits no further actions');
});

test('the Send button is disabled by the form’s own check while locked', async () => {
  const { surface, root } = mount(tutoringForm.a2uiMessages, tutoringForm.formId);
  await settle();
  assert.equal(button(root, 'Send tutoring request').disabled, false);
  surface.dataModel.set('/ui/submitLocked', true);
  await settle();
  assert.equal(button(root, 'Send tutoring request').disabled, true);
});
