import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ABSENCE_TYPES, shortDate, absenceNames, reasonsOf, isPair, nameOf, defaultReason, titleOf, workdays, spreadOf, daysText, whenText,
  CREDIT_OF_TYPE, CREDIT_LABEL, PROOF, NOTE_PRIVACY, HOLIDAYS, STANDARD_DAY, MAX_SPAN_DAYS,
} from '../src/absence-types.js';

test('the list matches the .psv file row for row', () => {
  const psv = readFileSync(new URL('../docs/superpowers/specs/2026-11-03-absence-types.psv', import.meta.url), 'utf8').split('\n').filter(Boolean);
  assert.equal(ABSENCE_TYPES.length, 51);
  assert.deepEqual(ABSENCE_TYPES.map((r) => `${r.type}|${r.name}|${r.code}|${r.reason}`), psv);
  assert.equal(absenceNames().length, 34);
  assert.equal(nameOf('ZZZ'), null);
});

test('reasons, defaults and titles', () => {
  assert.deepEqual(reasonsOf('SCK').map((r) => r.code), ['BRV', 'FAM', 'SCK']);
  assert.equal(defaultReason('VAC'), 'VAC'); assert.equal(defaultReason('JRY'), 'JRY'); assert.equal(defaultReason('OTH'), '10');
  assert.equal(defaultReason('BRV'), null); assert.equal(defaultReason('SCK'), null);
  assert.deepEqual(titleOf('BRV', 'GGP'), { title: 'Bereavement', subtitle: 'Grandparent/Great Grandparent' });
  assert.deepEqual(titleOf('CFR', 'NON'), { title: 'California Family Rights Act', subtitle: null });
  assert.equal(isPair('VAC', 'GGP'), false); assert.equal(isPair('BRV', 'GGP'), true);
});

test('constants', () => {
  assert.deepEqual(CREDIT_OF_TYPE, { VAC: 'vacation', SCK: 'sick', PHL: 'personalHoliday' });
  assert.equal(CREDIT_LABEL.sick, 'sick leave');
  assert.deepEqual(Object.keys(PROOF), ['JRY', 'WTS', 'MLA']);
  assert.match(NOTE_PRIVACY, /^Your manager, your timekeeper/);
  assert.deepEqual(HOLIDAYS, ['2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25']);
  assert.equal(STANDARD_DAY, 8); assert.equal(MAX_SPAN_DAYS, 400);
});

test('workdays skips weekends and holidays', () => {
  assert.deepEqual(workdays('2026-11-10', '2026-11-12'), ['2026-11-10', '2026-11-12']);
  assert.deepEqual(workdays('2026-11-07', '2026-11-08'), []);
  assert.deepEqual(workdays('2026-11-12', '2026-11-10'), []);
  assert.deepEqual(workdays('bad', '2026-11-10'), []);
});

test('spreadOf', () => {
  assert.deepEqual(spreadOf(2, 16, null), { mode: 'full' });
  assert.deepEqual(spreadOf(1, 2, null), { mode: 'one_day', first: 2 });
  assert.deepEqual(spreadOf(2, 12, null), { mode: 'ask' }); // ambiguous spread is ask
  assert.deepEqual(spreadOf(2, 12, 'start_day_only'), { mode: 'start_day_only', first: 4 });
  assert.deepEqual(spreadOf(2, 12, 'all_days'), { mode: 'all_days', each: 6 });
  assert.deepEqual(spreadOf(3, 12, null), { mode: 'all_days', each: 4 });
  assert.deepEqual(spreadOf(3, 12, 'start_day_only'), { mode: 'all_days', each: 4 }); // words name a mode that does not fit
  assert.equal(spreadOf(2, 20, null).mode, 'invalid');
  assert.equal(spreadOf(2, 0, null).mode, 'invalid');
  assert.equal(spreadOf(0, 4, null).mode, 'invalid');
  assert.equal(spreadOf(NaN, 4, null).mode, 'invalid');
});

test('daysText', () => {
  assert.equal(daysText(116), '14½ days'); assert.equal(daysText(2), '¼ day'); assert.equal(daysText(8), '1 day');
  assert.equal(daysText(16), '2 days'); assert.equal(daysText(4), '½ day'); assert.equal(daysText(6), '¾ day');
  assert.equal(daysText(0), '0 days'); assert.equal(daysText(118), '14¾ days'); assert.equal(daysText(108), '13½ days');
  assert.equal(daysText(11.2), '11.2 hours');
  assert.equal(daysText(107), '107 hours'); assert.equal(daysText(13), '13 hours'); assert.equal(daysText(116), '14½ days');
  assert.equal(daysText(1), '1 hour'); assert.equal(daysText(0.5), '0.5 hours');
});

test('whenText shapes', () => {
  const d = { beginDate: '2026-11-05', endDate: '2026-11-06' };
  assert.equal(whenText({ ...d, hours: 16, spread: { mode: 'full' } }), 'Thu, Nov 5 to Fri, Nov 6, 2 days');
  assert.equal(whenText({ beginDate: '2026-11-06', endDate: '2026-11-06', hours: 2, spread: { mode: 'one_day', first: 2 }, startAt: '15:00' }), 'Fri, Nov 6, 2 hours, from 15:00');
  assert.equal(whenText({ beginDate: '2026-11-06', endDate: '2026-11-06', hours: 2, spread: { mode: 'one_day', first: 2 }, startAt: '10:00', side: 'arrive' }), 'Fri, Nov 6, 2 hours, until 10:00');
  assert.equal(whenText({ beginDate: '2026-11-06', endDate: '2026-11-06', hours: 1, spread: { mode: 'one_day', first: 1 } }), 'Fri, Nov 6, 1 hour');
  assert.equal(whenText({ ...d, hours: 12, spread: { mode: 'start_day_only', first: 4 }, startAt: '12:00' }), 'Thu, Nov 5 from 12:00 (4 hours), then Fri, Nov 6 in full');
  assert.equal(whenText({ beginDate: '2026-11-05', endDate: '2026-11-09', hours: 20, spread: { mode: 'start_day_only', first: 4 }, startAt: '12:00' }), 'Thu, Nov 5 from 12:00 (4 hours), then the next 2 days in full');
  assert.equal(whenText({ beginDate: '2026-11-09', endDate: '2026-11-11', hours: 12, spread: { mode: 'all_days', each: 4 } }), 'Mon, Nov 9 to Wed, Nov 11, 4 hours each day');
  assert.equal(whenText({ ...d, hours: 12, spread: { mode: 'ask' } }), 'Thu, Nov 5 to Fri, Nov 6, 12 hours');
  assert.equal(whenText({ ...d, hours: 2.5, spread: { mode: 'ask' } }), 'Thu, Nov 5 to Fri, Nov 6, 2.5 hours');
});

test('fix round 1: impossible dates, quarter-hour all_days, odd inputs, first workday', () => {
  assert.deepEqual(workdays('2026-02-30', '2026-03-02'), []);
  assert.deepEqual(workdays('2026-13-45', '2026-14-01'), []);
  assert.equal(shortDate('2026-02-30'), ''); assert.equal(shortDate('x'), '');
  assert.deepEqual(spreadOf(3, 20, null), { mode: 'start_day_only', first: 4 });
  assert.deepEqual(spreadOf(3, 20, 'all_days'), { mode: 'start_day_only', first: 4 });
  assert.equal(spreadOf(3, 7, null).mode, 'invalid');
  assert.equal(spreadOf(1.5, 8, null).mode, 'invalid');
  assert.equal(daysText(NaN), ''); assert.equal(daysText(-8), ''); assert.equal(daysText(Infinity), '');
  assert.equal(
    whenText({ beginDate: '2026-11-07', endDate: '2026-11-12', hours: 20, spread: { mode: 'start_day_only', first: 4 }, startAt: '12:00' }),
    'Mon, Nov 9 from 12:00 (4 hours), then the next 2 days in full',
  );
});
