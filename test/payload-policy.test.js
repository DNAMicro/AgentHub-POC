// The Student's allowlist for received A2UI payloads (checkFormPayloadPolicy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStudentDetailsForm, checkFormPayloadPolicy } from '../src/student-form.js';

const form = () => buildStudentDetailsForm('student-details-test');
const components = (payload) => payload[1].updateComponents.components;
const byId = (payload, id) => components(payload).find((c) => c.id === id);
const openUrl = { call: 'openUrl', args: { url: 'https://attacker.example' } };

test('the Tutor’s real form passes', () => {
  assert.equal(checkFormPayloadPolicy(form()), null);
});

test('rejects disallowed function calls hidden anywhere in the payload', () => {
  const cases = {
    'inside a check condition': (p) => byId(p, 'email').checks.push({ condition: { call: 'or', args: { values: [openUrl, true] } }, message: 'x' }),
    'as a bound text value': (p) => { byId(p, 'title').text = openUrl; },
    'inside an action context': (p) => { byId(p, 'submit_button').action.event.context.firstName = openUrl; },
    'a formatter that isn’t on the list': (p) => { byId(p, 'title').text = { call: 'formatString', args: { value: 'x' } }; },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const payload = form();
    tamper(payload);
    assert.match(checkFormPayloadPolicy(payload) ?? '', /not allowed/, name);
  }
});

test('rejects actions that are not exactly a server event', () => {
  const both = form();
  byId(both, 'submit_button').action.functionCall = openUrl;
  assert.ok(checkFormPayloadPolicy(both), 'event + functionCall');

  const local = form();
  byId(local, 'submit_button').action = { functionCall: openUrl };
  assert.ok(checkFormPayloadPolicy(local), 'functionCall only');
});

test('rejects other components, catalogs, and surface shapes', () => {
  const image = form();
  components(image).push({ id: 'img', component: 'Image', url: 'https://attacker.example/x.png' });
  assert.match(checkFormPayloadPolicy(image), /Image/);

  const catalog = form();
  catalog[0].createSurface.catalogId = 'https://attacker.example/catalog.json';
  assert.match(checkFormPayloadPolicy(catalog), /basic catalog/);

  const twoSurfaces = [...form(), ...buildStudentDetailsForm('second-surface')];
  assert.match(checkFormPayloadPolicy(twoSurfaces), /exactly one createSurface/);

  const mismatched = form();
  mismatched[2].updateDataModel.surfaceId = 'other-surface';
  assert.match(checkFormPayloadPolicy(mismatched), /same surface/);

  const deletion = [...form(), { version: 'v0.9', deleteSurface: { surfaceId: 'student-details-test' } }];
  assert.match(checkFormPayloadPolicy(deletion), /Unsupported A2UI message/);

  assert.ok(checkFormPayloadPolicy([]), 'empty');
  assert.ok(checkFormPayloadPolicy({ not: 'an array' }), 'not an array');
});
