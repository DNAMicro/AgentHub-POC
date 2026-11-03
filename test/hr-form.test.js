// Time-off form contract (shared, dependency-free): absence names, A2UI card, validation, action check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateServerToClientList } from './support/a2ui-schema.js';
import {
  ABSENCE_NAMES, CREDIT_OF, RELATIONSHIP_LABEL, RELATIONSHIP_REQUIRED, WORKFLOWS, buildTimeOffForm, checkTimeOffValues, validateFinal, checkAction, checkFormPayloadPolicy,
} from '../src/forms.js';

const ids = (msgs) => msgs.find((m) => m.updateComponents).updateComponents.components.map((c) => c.id);
const comp = (msgs, id) => msgs.find((m) => m.updateComponents).updateComponents.components.find((c) => c.id === id);
const good = { absenceName: 'Sick – Self', beginDate: '2026-11-05', endDate: '2026-11-05', hours: '4', relationship: '', note: '' };

test('constants match the CHRS contract', () => {
  assert.equal(ABSENCE_NAMES.length, 10);
  assert.ok(ABSENCE_NAMES.includes('Sick – Self') && 'Sick – Self'.includes('–'));
  assert.equal(CREDIT_OF['Sick – Family Care'], 'sick');
  assert.equal(CREDIT_OF.Jury, undefined);
  assert.ok(RELATIONSHIP_REQUIRED.has('Bereavement/Funeral') && !RELATIONSHIP_REQUIRED.has('Vacation'));
  assert.equal(WORKFLOWS['staff-time-off'].finalAction, 'submitTimeOff');
});

test('the card passes the A2UI schema and the fixed-form policy', () => {
  for (const prefill of [{}, { absenceName: 'Bereavement/Funeral' }]) {
    const msgs = buildTimeOffForm('s-1', { prefill });
    assert.equal(validateServerToClientList(structuredClone(msgs)), null);
    assert.equal(checkFormPayloadPolicy(msgs, { workflowId: 'staff-time-off' }), null);
  }
});

test('final fix 1: the relationship row is always on the card; its star follows the name', () => {
  // A card made for "I need Friday off" (no name yet) still has the row, so picking Bereavement/Funeral on
  // the card is never a dead end.
  for (const opts of [{ prefill: { absenceName: 'Vacation' } }, { prefill: {} }, { prefill: { absenceName: 'Bereavement/Funeral' } }, { missing: ['relationship'] }]) {
    assert.ok(ids(buildTimeOffForm('s', opts)).includes('relationship_row'), JSON.stringify(opts));
  }
  const ui = (msgs) => msgs.find((m) => m.updateDataModel).updateDataModel.value.ui;
  const plain = buildTimeOffForm('s', { prefill: { absenceName: 'Vacation' } });
  assert.deepEqual(comp(plain, 'relationship').label, { path: '/ui/relationshipLabel' });
  assert.equal(ui(plain).relationshipLabel, RELATIONSHIP_LABEL.optional);
  assert.equal(ui(plain).relationshipNeeded, '');
  const family = buildTimeOffForm('s', { prefill: { absenceName: 'Sick – Family Care' } });
  assert.equal(ui(family).relationshipLabel, RELATIONSHIP_LABEL.required);
  assert.equal(ui(family).relationshipNeeded, 'yes');
  assert.match(RELATIONSHIP_LABEL.required, / \*$/);
  assert.doesNotMatch(RELATIONSHIP_LABEL.optional, /\*/);
  assert.match(RELATIONSHIP_LABEL.optional, /bereavement or family care/);
  assert.equal(comp(family, 'absenceName').label, 'Absence name *');
  assert.equal(comp(family, 'note').label, 'Note for manager');
  // Submit with Bereavement/Funeral + a relationship on a card made for "I need Friday off" passes.
  assert.equal(validateFinal('staff-time-off', { ...good, absenceName: ['Bereavement/Funeral'], relationship: 'uncle' }).ok, true);
  assert.ok(validateFinal('staff-time-off', { ...good, absenceName: ['Bereavement/Funeral'] }).errors.relationship, 'still required for that name');
});

test('final fix 2: checkTimeOffValues keeps the valid fields of a half-filled card, drops the rest', () => {
  assert.deepEqual(checkTimeOffValues({ absenceName: ['Vacation'], beginDate: '2026-11-12', endDate: '', hours: '', relationship: '', note: '' }),
    { ok: true, values: { absenceName: 'Vacation', beginDate: '2026-11-12' }, errors: {} });
  const bad = checkTimeOffValues({ absenceName: ['Made up'], beginDate: '2026-13-40', hours: 'abc', relationship: 'x'.repeat(101), note: 'Back Monday' });
  assert.deepEqual(bad.values, { note: 'Back Monday' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['absenceName', 'beginDate', 'hours', 'relationship']);
  assert.equal(checkTimeOffValues({ surprise: 'x' }).ok, false, 'unknown keys are refused outright');
  assert.equal(checkTimeOffValues(['x']).ok, false);
  assert.equal(checkTimeOffValues(null).ok, false);
  assert.deepEqual(checkTimeOffValues({ hours: 12 }).values, { hours: '12' });
});

test('validateFinal', () => {
  const v = (o) => validateFinal('staff-time-off', { ...good, ...o });
  assert.equal(v({ absenceName: '' }).errors.absenceName !== undefined, true);
  assert.ok(v({ beginDate: '2026-11-06', endDate: '2026-11-05' }).errors.endDate);
  assert.ok(v({ absenceName: 'Bereavement/Funeral' }).errors.relationship);
  assert.ok(v({ hours: '0' }).errors.hours);
  assert.ok(v({ hours: '25' }).errors.hours);
  assert.ok(v({ beginDate: '2026-13-01' }).errors.beginDate);
  assert.equal(v({ hours: '24' }).ok, true);
  assert.deepEqual(validateFinal('staff-time-off', good), { ok: true, errors: {} });
});

test('checkAction accepts the submit button with the six fields', () => {
  const message = { version: 'v0.9', action: { name: 'submitTimeOff', surfaceId: 's', sourceComponentId: 'submit_button', context: { ...good } } };
  assert.equal(checkAction(message, { workflowId: 'staff-time-off', surfaceId: 's' }).ok, true);
});

test('validateFinal: limits, unknown keys, array-valued absenceName', () => {
  const v = (o) => validateFinal('staff-time-off', { ...good, ...o });
  assert.ok(v({ note: 'x'.repeat(1001) }).errors.note);
  assert.equal(v({ note: 'x'.repeat(1000) }).ok, true);
  assert.ok(v({ absenceName: 'Bereavement/Funeral', relationship: 'x'.repeat(101) }).errors.relationship);
  assert.ok(v({ absenceName: 'Bereavement/Funeral', relationship: 'x'.repeat(100) }).ok);
  const extra = v({ surprise: 'x' });
  assert.equal(extra.ok, false);
  assert.match(extra.errors._form, /Unexpected field\(s\): surprise/);
  assert.equal(validateFinal('staff-time-off', null).ok, false);
  assert.equal(v({ absenceName: ['Vacation'] }).ok, true);
  assert.ok(v({ absenceName: ['Vacation', 'Dock'] }).errors.absenceName);
});
