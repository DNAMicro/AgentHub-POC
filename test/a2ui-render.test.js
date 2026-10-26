// The A2UI payload the Tutor actually sends over A2A is (1) valid against the official
// A2UI v0.9 JSON Schemas and (2) what drives the form drawn by the official Lit renderer.
// Runs in its own file/process because jsdom installs browser globals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTutor } from './support/harness.js';
import { validateServerToClientList, validateClientToServerList } from './support/a2ui-schema.js';
import { setupDom, settle, queryAllDeep } from './support/render-form.js';
import { requestForm } from '../src/student-agent.js';
import { A2UI_VERSION, SUBMIT_ACTION } from '../src/student-form.js';

let tutor, form, renderer;

before(async () => {
  tutor = await startTutor();
  form = await requestForm(tutor.url, { runId: 'render-test' }); // real A2A round trip
  renderer = await setupDom();
});
after(() => tutor?.proc.kill());

function mount(messages) {
  const actions = [];
  const processor = new renderer.MessageProcessor([renderer.basicCatalog], (a) => actions.push(a));
  // Copy: the renderer adopts updateDataModel values by reference and mutates them as the user types.
  processor.processMessages(structuredClone(messages));
  const surface = processor.model.getSurface(form.formId);
  const el = document.createElement('a2ui-surface');
  el.surface = surface;
  document.body.replaceChildren(el);
  return { actions, surface, root: el };
}

const typeInto = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

test('received A2UI payload validates against the official v0.9 schemas', () => {
  assert.equal(validateServerToClientList(form.a2uiMessages), null);
  // Negative control: the validator really rejects non-catalog components.
  const tampered = structuredClone(form.a2uiMessages);
  tampered[1].updateComponents.components.push({ id: 'x', component: 'Blink' });
  assert.notEqual(validateServerToClientList(tampered), null);
});

test('the rendered form is driven by the received description', async () => {
  const { root } = mount(form.a2uiMessages);
  await settle();
  assert.deepEqual(queryAllDeep(root, 'label').map((l) => l.textContent.trim()), ['First name', 'Last name', 'Email', 'Notes (optional)']);
  assert.equal(queryAllDeep(root, 'input').length, 3);
  assert.equal(queryAllDeep(root, 'textarea').length, 1, 'Notes is multiline (longText)');
  assert.deepEqual(queryAllDeep(root, 'button').map((b) => b.textContent.trim()), ['Submit']);

  // Change the description → the rendering changes. Nothing is hardcoded in the page.
  const altered = structuredClone(form.a2uiMessages);
  altered[1].updateComponents.components.find((c) => c.id === 'email').label = 'School email';
  const second = mount(altered);
  await settle();
  assert.ok(queryAllDeep(second.root, 'label').some((l) => l.textContent.trim() === 'School email'));
});

test('editing fields only changes local draft state: no action, nothing sent to the Tutor', async () => {
  const { actions, surface, root } = mount(form.a2uiMessages);
  await settle();
  const [first, last, email] = queryAllDeep(root, 'input');
  typeInto(first, 'Alex');
  typeInto(last, 'Student');
  typeInto(email, 'alex@example.com');
  typeInto(queryAllDeep(root, 'textarea')[0], 'Draft notes');
  await settle();

  assert.deepEqual(surface.dataModel.get('/form'), { firstName: 'Alex', lastName: 'Student', email: 'alex@example.com', notes: 'Draft notes' });
  assert.equal(actions.length, 0, 'typing emits no A2UI action');
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotMatch(tutor.output(), /received submission/, 'Tutor received no submission');
  assert.doesNotMatch(tutor.output(), /Draft notes/, 'draft text never reached the Tutor process');
});

test('Submit emits a schema-valid A2UI action with the bound values; inline errors appear after a submit attempt', async () => {
  const { actions, surface, root } = mount(form.a2uiMessages);
  await settle();
  assert.equal(queryAllDeep(root, '.a2ui-error-message').length, 0, 'untouched form shows no errors');

  typeInto(queryAllDeep(root, 'input')[0], '   ');
  typeInto(queryAllDeep(root, 'input')[2], 'not-an-email');
  queryAllDeep(root, 'button')[0].click();
  await settle();

  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.name, SUBMIT_ACTION);
  assert.equal(action.surfaceId, form.formId);
  assert.equal(action.sourceComponentId, 'submit_button');
  assert.deepEqual(action.context, { firstName: '   ', lastName: '', email: 'not-an-email', notes: '' });
  const { name, surfaceId, sourceComponentId, timestamp, context } = action;
  assert.equal(validateClientToServerList([{ version: A2UI_VERSION, action: { name, surfaceId, sourceComponentId, timestamp, context } }]), null);

  // What the browser does on Submit: reveal the renderer's own inline errors.
  surface.dataModel.set('/ui/submitAttempted', true);
  await settle();
  const errors = queryAllDeep(root, '.a2ui-error-message').map((e) => e.textContent.trim());
  assert.ok(errors.includes('First name is required.'), 'whitespace-only name rejected');
  assert.ok(errors.includes('Last name is required.'));
  assert.ok(errors.includes('Enter a valid email format, like alex@example.com.'));
});

test('the Submit button is disabled by the form’s own check while locked', async () => {
  const { surface, root } = mount(form.a2uiMessages);
  await settle();
  assert.equal(queryAllDeep(root, 'button')[0].disabled, false);
  surface.dataModel.set('/ui/submitLocked', true);
  await settle();
  assert.equal(queryAllDeep(root, 'button')[0].disabled, true);
});
