// Time-off form contract (shared, dependency-free): A2UI card, validation, action check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateServerToClientList } from './support/a2ui-schema.js';
import {
  WORKFLOWS, buildTimeOffForm, reasonPicker, checkTimeOffValues, validateFinal, checkAction, checkFormPayloadPolicy,
} from '../src/forms.js';

const ids = (msgs) => msgs.find((m) => m.updateComponents).updateComponents.components.map((c) => c.id);
const comp = (msgs, id) => msgs.find((m) => m.updateComponents).updateComponents.components.find((c) => c.id === id);
const good = { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-05', endDate: '2026-11-05', hours: '4', note: '' };

test('the workflow names the six fields', () => {
  assert.equal(WORKFLOWS['staff-time-off'].finalAction, 'submitTimeOff');
  assert.deepEqual(WORKFLOWS['staff-time-off'].actions.submitTimeOff.fields, ['absenceType', 'absenceReason', 'beginDate', 'endDate', 'hours', 'note']);
});

test('the card passes the A2UI schema and the fixed-form policy', () => {
  for (const prefill of [{}, { absenceType: 'BRV' }, { absenceType: 'BRV', absenceReason: 'GGP' }]) {
    const msgs = buildTimeOffForm('s-1', { prefill });
    assert.equal(validateServerToClientList(structuredClone(msgs)), null);
    assert.equal(checkFormPayloadPolicy(msgs, { workflowId: 'staff-time-off' }), null);
  }
});

test('two filterable chip pickers, no relationship row', () => {
  const msgs = buildTimeOffForm('s', { prefill: {} });
  const type = comp(msgs, 'absenceType');
  assert.equal(type.options.length, 34);
  assert.equal(type.filterable, true);
  assert.equal(type.displayStyle, 'chips');
  assert.equal(type.variant, 'mutuallyExclusive');
  assert.equal(type.label, 'Absence name');
  const reason = comp(msgs, 'absenceReason');
  assert.equal(reason.filterable, true);
  assert.equal(reason.label, 'Reason');
  assert.deepEqual(reason.options, []);
  assert.ok(!ids(msgs).some((i) => i.startsWith('relationship')));
  assert.equal(comp(msgs, 'note').label, 'Note (optional)');
  const data = msgs.find((m) => m.updateDataModel).updateDataModel.value;
  assert.deepEqual([data.absenceType, data.absenceReason], [[], []]);
  assert.equal(data.ui.relationshipLabel, undefined);
});

test('prefill sets both pickers as one-element arrays; the reason options follow the name', () => {
  const msgs = buildTimeOffForm('s', { prefill: { absenceType: 'SCK', absenceReason: 'FAM' }, missing: ['hours'] });
  const data = msgs.find((m) => m.updateDataModel).updateDataModel.value;
  assert.deepEqual([data.absenceType, data.absenceReason], [['SCK'], ['FAM']]);
  assert.deepEqual(comp(msgs, 'absenceReason').options.map((o) => o.value), ['BRV', 'FAM', 'SCK']);
  assert.deepEqual(reasonPicker('SCK').options.map((o) => o.value), ['BRV', 'FAM', 'SCK']);
  assert.deepEqual(reasonPicker(null).options, []);
  assert.equal(data.hours, '', 'missing fields are not reported as prefilled');
});

test('Submit is checked on both pickers being non-empty', () => {
  const submit = comp(buildTimeOffForm('s', {}), 'submit_button');
  assert.ok(submit.checks.some((c) => JSON.stringify(c).includes('/absenceType') && JSON.stringify(c).includes('/absenceReason')));
  assert.ok(submit.checks.some((c) => JSON.stringify(c).includes('/ui/submitLocked')));
});

test('checkTimeOffValues keeps the valid fields of a half-filled card, drops the rest', () => {
  assert.deepEqual(checkTimeOffValues({ absenceType: ['VAC'], absenceReason: [], beginDate: '2026-11-12', endDate: '', hours: '', note: '' }),
    { ok: true, values: { absenceType: 'VAC', beginDate: '2026-11-12' }, errors: {} });
  const bad = checkTimeOffValues({ absenceType: ['Made up'], beginDate: '2026-13-40', hours: 'abc', note: 'x'.repeat(1001) });
  assert.deepEqual(bad.values, {});
  assert.deepEqual(Object.keys(bad.errors).sort(), ['absenceType', 'beginDate', 'hours', 'note']);
  assert.equal(checkTimeOffValues({ relationship: 'x' }).ok, false, 'unknown keys are refused outright');
  assert.equal(checkTimeOffValues(['x']).ok, false);
  assert.equal(checkTimeOffValues(null).ok, false);
  assert.deepEqual(checkTimeOffValues({ hours: 12 }).values, { hours: '12' });
  assert.equal(checkTimeOffValues({ absenceType: ['VAC'], absenceReason: ['GGP'] }).errors.absenceReason, 'Choose a reason.');
});

test('validateFinal', () => {
  const v = (o) => validateFinal('staff-time-off', { ...good, ...o });
  assert.equal(v({ absenceType: '' }).errors.absenceType, 'Choose an absence name.');
  assert.equal(v({ absenceReason: [] }).errors.absenceReason, 'Choose a reason.');
  assert.equal(v({ absenceType: ['VAC'], absenceReason: ['GGP'] }).errors.absenceReason, 'Choose a reason.');
  assert.ok(v({ beginDate: '2026-11-06', endDate: '2026-11-05' }).errors.endDate);
  assert.ok(v({ hours: '0' }).errors.hours);
  assert.ok(v({ beginDate: '2026-13-01' }).errors.beginDate);
  assert.equal(v({ hours: '8' }).ok, true);
  assert.deepEqual(validateFinal('staff-time-off', good), { ok: true, errors: {} });
});

test('hours: the spread question is HR\'s, impossible hours are refused', () => {
  const v = (o) => validateFinal('staff-time-off', { ...good, beginDate: '2026-11-05', endDate: '2026-11-06', ...o });
  assert.equal(v({ hours: '12' }).ok, true);
  assert.equal(v({ hours: '20' }).errors.hours, 'These hours don’t fit the dates.');
});

test('dates: a range with no workdays and a holiday begin/end get a date error, not the hours error', () => {
  const v = (o) => validateFinal('staff-time-off', { ...good, hours: '8', ...o });
  const weekend = v({ beginDate: '2026-11-07', endDate: '2026-11-08' }); // Sat–Sun
  assert.equal(weekend.errors.endDate, 'That range has no workdays.');
  assert.equal(weekend.errors.hours, undefined);
  const holiday = "An absence can't begin or end on a campus holiday.";
  const begin = v({ beginDate: '2026-11-11', endDate: '2026-11-12' }); // Nov 11 is a campus holiday
  assert.equal(begin.errors.beginDate, holiday);
  assert.equal(begin.errors.hours, undefined);
  const end = v({ beginDate: '2026-11-10', endDate: '2026-11-11' });
  assert.equal(end.errors.endDate, holiday);
  assert.equal(end.errors.hours, undefined);
  assert.equal(v({ beginDate: '2026-11-11', endDate: '2026-11-11' }).errors.beginDate, holiday);
  assert.equal(v({ beginDate: '2026-11-10', endDate: '2026-11-12', hours: '16' }).ok, true, 'a holiday inside the range is fine');
});

test('checkAction accepts the submit button with the six fields', () => {
  const message = { version: 'v0.9', action: { name: 'submitTimeOff', surfaceId: 's', sourceComponentId: 'submit_button', context: { ...good } } };
  assert.equal(checkAction(message, { workflowId: 'staff-time-off', surfaceId: 's' }).ok, true);
});

test('validateFinal: limits, unknown keys, array-valued pickers', () => {
  const v = (o) => validateFinal('staff-time-off', { ...good, ...o });
  assert.ok(v({ note: 'x'.repeat(1001) }).errors.note);
  assert.equal(v({ note: 'x'.repeat(1000) }).ok, true);
  const extra = v({ relationship: 'x' });
  assert.equal(extra.ok, false);
  assert.match(extra.errors._form, /Unexpected field\(s\): relationship/);
  assert.equal(validateFinal('staff-time-off', null).ok, false);
  assert.ok(v({ absenceType: ['VAC', 'DCK'] }).errors.absenceType);
});
