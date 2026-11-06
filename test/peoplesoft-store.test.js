// PeopleSoft store: in-memory staff, holidays, hours and Forecast. Nothing is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPeopleSoftStore } from '../src/peoplesoft-store.js';
import { planAbsence } from '../src/leave-rules.js';
import { HOLIDAYS } from '../src/absence-types.js';

const fresh = () => createPeopleSoftStore({ now: () => new Date('2026-11-02T18:00:00Z') });

test('staff fixture and holidays', () => {
  const s = fresh();
  assert.deepEqual(s.staff('staff-dabirian'), { staffId: 'staff-dabirian', name: 'Dr. Dabirian', standardHours: 8, role: 'Department chair', appointment: '12-month', balances: { vacation: 96, sick: 120, personalHoliday: 8 } });
  assert.equal(s.staff('nobody'), null);
  assert.deepEqual(HOLIDAYS, ['2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25']);
});

test('workdays skip weekends and holidays', () => {
  const s = fresh();
  assert.deepEqual(s.workdays('2026-11-06', '2026-11-09'), ['2026-11-06', '2026-11-09']);
  assert.deepEqual(s.workdays('2026-11-10', '2026-11-12'), ['2026-11-10', '2026-11-12']);
});

test('plan: holiday boundary, counts, not enough, no credits, partial', () => {
  const s = fresh();
  const p = (v) => s.plan('staff-dabirian', v);
  const b = p({ absenceType: 'VAC', beginDate: '2026-11-11', endDate: '2026-11-12', partial: null });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'holiday_boundary');
  assert.equal(b.reason, "An absence can't begin or end on a campus holiday (Wed, Nov 11).");
  const e = p({ absenceType: 'VAC', beginDate: '2026-11-10', endDate: '2026-11-11', partial: null });
  assert.equal(e.code, 'holiday_boundary');
  const v = p({ absenceType: 'VAC', beginDate: '2026-11-10', endDate: '2026-11-12', partial: null });
  assert.equal(v.ok, true); assert.equal(v.days, 2); assert.equal(v.hours, 16);
  assert.deepEqual(v.credit, { type: 'vacation', now: 96, after: 80 });
  assert.equal(p({ absenceType: 'VAC', beginDate: '2026-11-06', endDate: '2026-11-09', partial: null }).days, 2);
  const ne = p({ absenceType: 'VAC', beginDate: '2027-01-04', endDate: '2027-01-20', partial: null });
  assert.equal(ne.code, 'not_enough');
  assert.equal(ne.reason, 'Not enough vacation: 104 hours needed, 96 left.');
  const be = p({ absenceType: 'BRV', beginDate: '2026-11-10', endDate: '2026-11-10', partial: null });
  assert.equal(be.ok, true); assert.equal(be.credit, null);
  const sk = p({ absenceType: 'SCK', beginDate: '2026-11-10', endDate: '2026-11-10', partial: { mode: 'start_day_only', hours: 4 } });
  assert.deepEqual(sk.credit, { type: 'sick', now: 120, after: 116 });
  assert.equal(sk.hours, 4);
  const multi = p({ absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-10', partial: { mode: 'start_day_only', hours: 4 } });
  assert.equal(multi.hours, 12);
  assert.equal(p({ absenceType: 'VAC', beginDate: '2026-11-07', endDate: '2026-11-08', partial: null }).code, 'no_workdays');
  assert.equal(s.plan('nobody', {}).code, 'unknown_staff');
});

test('submit is idempotent by operationId, refuses reuse, reset clears', () => {
  const s = fresh();
  const v = { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-10', endDate: '2026-11-12', partial: null };
  const a = s.file('staff-dabirian', v, 'abcdef0123456789', ['store_record']);
  assert.equal(a.ok, true);
  assert.deepEqual(a.receipt, { requestId: '4310288', recordId: '00482131', absenceType: 'VAC', absenceReason: 'VAC', absenceName: 'Vacation', reasonText: 'Vacation', beginDate: '2026-11-10', endDate: '2026-11-12', hours: 16, status: 'recorded', steps: ['store_record'] });
  assert.deepEqual(s.file('staff-dabirian', v, 'abcdef0123456789', ['store_record']).receipt, a.receipt);
  assert.equal(s._records().length, 1);
  assert.equal(s.file('staff-dabirian', { ...v, endDate: '2026-11-10' }, 'abcdef0123456789', ['store_record']).code, 'operation_reused');
  assert.equal(s.file('staff-dabirian', { ...v, beginDate: '2026-11-11' }, 'ffffffff00000000', ['store_record']).code, 'holiday_boundary');
  assert.equal(s.staff('staff-dabirian').balances.vacation, 96); // deducts nothing
  s.reset();
  assert.equal(s._records().length, 0);
});

test('nothing is written to disk', () => {
  assert.doesNotMatch(readFileSync('src/peoplesoft-store.js', 'utf8'), /node:fs|writeFile/);
});

test('plan refuses bad partial hours and over-long ranges; submit refuses the same way', () => {
  const s = fresh();
  const base = { absenceType: 'SCK', absenceReason: 'SCK', beginDate: '2026-11-10', endDate: '2026-11-10' };
  const msg = 'Partial-day hours must be more than 0 and less than 8.';
  for (const hours of [-50, 0, NaN, '4', 9, Infinity, undefined]) {
    const r = s.plan('staff-dabirian', { ...base, partial: { mode: 'start_day_only', hours } });
    assert.equal(r.ok, false); assert.equal(r.code, 'bad_hours'); assert.equal(r.reason, msg);
  }
  assert.equal(s.plan('staff-dabirian', { ...base, partial: { mode: 'start_day_only', hours: 8 } }).code, 'bad_hours');
  assert.equal(s.plan('staff-dabirian', { ...base, partial: { mode: 'all_days', hours: 7.5 } }).hours, 7.5);
  assert.equal(s.file('staff-dabirian', { ...base, partial: { mode: 'start_day_only', hours: -50 } }, 'aaaaaaaa11111111', ['store_record']).code, 'bad_hours');
  const long = s.plan('staff-dabirian', { absenceType: 'DCK', beginDate: '2026-11-10', endDate: '2027-12-20', partial: null });
  assert.equal(long.ok, false); assert.equal(long.code, 'too_long');
  assert.equal(long.reason, 'An absence request can cover at most 400 days.');
  assert.equal(s.plan('staff-dabirian', { absenceType: 'DCK', beginDate: '2026-11-10', endDate: '2027-12-14', partial: null }).ok, true); // exactly 400 days
  assert.equal(s.file('staff-dabirian', { absenceType: 'DCK', absenceReason: 'DCK', beginDate: '2026-11-10', endDate: '2027-12-20', partial: null }, 'bbbbbbbb22222222', ['store_record']).code, 'too_long');
  assert.equal(s._records().length, 0);
});

test('final fix 5: operation ids like __proto__ and constructor behave like any other id', () => {
  const s = fresh();
  for (const [i, id] of ['__proto__', 'constructor', 'toString'].entries()) {
    const d = ['2026-11-02', '2026-11-03', '2026-11-04'][i]; // distinct days: a shared workday would be an overlap
    const v = { absenceType: 'VAC', absenceReason: 'VAC', beginDate: d, endDate: d, partial: null };
    const r = s.file('staff-dabirian', v, id, ['store_record']);
    assert.equal(r.ok, true, id);
    assert.deepEqual(s.file('staff-dabirian', v, id, ['store_record']), r, `${id}: a repeat returns the stored receipt`);
    assert.equal(s.file('staff-dabirian', { ...v, beginDate: '2026-11-09', endDate: '2026-11-09' }, id, ['store_record']).code, 'operation_reused', id);
  }
  assert.equal(s._records().length, 3);
});

test('all_days partial spreads hours over every workday', () => {
  const s = fresh();
  const r = s.plan('staff-dabirian', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-12', partial: { mode: 'all_days', hours: 4 } });
  assert.equal(r.hours, 12); // Nov 11 holiday is skipped: 3 workdays x 4
  assert.equal(s.plan('staff-dabirian', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-11', partial: { mode: 'all_days', hours: 4 } }).code, 'holiday_boundary');
});

test('reasons, balances and requests', () => {
  const s = fresh();
  const r = s.plan('staff-dabirian', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-10', partial: { mode: 'all_days', hours: 4 } });
  assert.equal(r.hours, 8);
  assert.equal(s.file('staff-dabirian', { absenceType: 'VAC', absenceReason: 'GGP', beginDate: '2026-11-06', endDate: '2026-11-06' }, 'op1', ['store_record']).code, 'bad_reason'); // reason from another type is refused
  assert.equal(s.plan('staff-dabirian', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-10', partial: { mode: 'all_days', hours: 8 } }).code, 'bad_hours');
  assert.equal(s.plan('staff-dabirian', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-10', partial: { mode: 'bogus', hours: 4 } }).code, 'bad_hours');
  const sick = s.plan('staff-dabirian', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-12-10', partial: null });
  assert.equal(sick.reason, 'Not enough sick leave: 160 hours needed, 120 left.'.replace('160', String(sick.hours)));
  assert.deepEqual(s.balances('staff-dabirian'), { vacation: 96, sick: 120, personalHoliday: 8 });
  assert.equal(s.balances('nobody'), null);
  const v = { absenceType: 'BRV', absenceReason: 'GGP', beginDate: '2026-11-06', endDate: '2026-11-06' };
  const a = s.file('staff-dabirian', v, 'aaaaaaaa11111111', ['store_record']);
  assert.equal(a.receipt.absenceName, 'Bereavement'); assert.equal(a.receipt.reasonText, 'Grandparent/Great Grandparent');
  assert.equal(s.file('staff-dabirian', { ...v, absenceReason: 'OTH' }, 'aaaaaaaa11111111', ['store_record']).code, 'operation_reused');
  const b = s.file('staff-dabirian', { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-09', endDate: '2026-11-09' }, 'bbbbbbbb22222222', ['store_record']);
  assert.deepEqual(s.requests('staff-dabirian').map((x) => x.requestId), [b.receipt.requestId, a.receipt.requestId]);
  assert.equal('operationId' in s.requests('staff-dabirian')[0], false);
  assert.deepEqual(s.requests('nobody'), []);
});

test('overlap: a request sharing a workday with a filed one is refused', () => {
  const s = createPeopleSoftStore();
  const v = { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-05', endDate: '2026-11-06', partial: null };
  assert.equal(s.file('staff-dabirian', v, 'op-1', ['store_record']).ok, true);
  const r = s.file('staff-dabirian', { ...v, beginDate: '2026-11-06', endDate: '2026-11-09' }, 'op-2', ['store_record']);
  assert.deepEqual([r.ok, r.code], [false, 'overlap']);
  // The professor reads this sentence on the card: plain dates, never ISO (live run 2026-11-03 showed “2026-11-06 to 2026-11-06”).
  assert.equal(r.reason, 'That overlaps time off already filed for Thu, Nov 5 to Fri, Nov 6.');
  const one = s.file('staff-dabirian', { ...v, beginDate: '2026-11-05', endDate: '2026-11-05' }, 'op-3', ['store_record']);
  assert.equal(one.reason, 'That overlaps time off already filed for Thu, Nov 5 to Fri, Nov 6.');
  assert.equal(s.file('staff-dabirian', { ...v, beginDate: '2026-11-13', endDate: '2026-11-13' }, 'op-4', ['store_record']).ok, true);
  assert.equal(s.file('staff-dabirian', { ...v, beginDate: '2026-11-13', endDate: '2026-11-13' }, 'op-5', ['store_record']).reason, 'That overlaps time off already filed for Fri, Nov 13.');
});
test('receipt carries a PeopleSoft record id and the steps run', () => {
  const r = createPeopleSoftStore().file('staff-dabirian', { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-06', endDate: '2026-11-06', partial: null }, 'op-1', ['check_balance', 'store_record']);
  assert.match(r.receipt.recordId, /^\d{8}$/);
  assert.deepEqual(r.receipt.steps, ['check_balance', 'store_record']);
  assert.equal(r.receipt.status, 'recorded');
});
test('planAbsence is the same rule HR uses', () => {
  assert.deepEqual(planAbsence({ standardHours: 8, balances: { vacation: 96, sick: 120, personalHoliday: 8 } }, { absenceType: 'VAC', beginDate: '2026-11-06', endDate: '2026-11-06' }), { ok: true, hours: 8, days: 1, credit: { type: 'vacation', now: 96, after: 88 } });
});

test('record ids, reset, other staff, weekend adjacency, stored()', () => {
  const s = fresh();
  const v = (b, e) => ({ absenceType: 'VAC', absenceReason: 'VAC', beginDate: b, endDate: e, partial: null });
  assert.equal(s.stored('op-1'), null);
  const a = s.file('staff-dabirian', v('2026-11-10', '2026-11-10'), 'aaaa1111', ['store_record']);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.receipt.recordId, '00482131');
  assert.deepEqual(s.stored('aaaa1111'), a);
  const b = s.file('staff-dabirian', v('2026-11-16', '2026-11-16'), 'bbbb2222', []);
  assert.equal(b.receipt.recordId, '00482132');
  // Fri Nov 6 filed; a Sat-Sun-adjacent request on Mon Nov 9 is not an overlap
  assert.equal(s.file('staff-dabirian', v('2026-11-06', '2026-11-06'), 'cccc3333', []).ok, true);
  assert.equal(s.file('staff-dabirian', v('2026-11-09', '2026-11-09'), 'dddd4444', []).ok, true);
  assert.equal(s.file('staff-dabirian', v('2026-11-10', '2026-11-10'), 'eeee5555', []).code, 'overlap');
  s.reset();
  assert.equal(s.stored('aaaa1111'), null);
  assert.equal(s.file('staff-dabirian', v('2026-11-10', '2026-11-10'), 'ffff6666', []).receipt.recordId, '00482131');
  // The seed has one staff member, so "a different staff member on the same day" cannot be tested.
});

test('REFUSAL_CODES is the fixed set of ten', async () => {
  const { REFUSAL_CODES } = await import('../src/peoplesoft-store.js');
  assert.equal(REFUSAL_CODES.length, 10);
  assert.ok(REFUSAL_CODES.includes('bad_hours'));
  assert.ok(REFUSAL_CODES.includes('reset_during_call'));
});

test('final-review I1: a filing that started before a reset is refused after it (reset generation)', () => {
  const s = fresh();
  const v = { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-10', endDate: '2026-11-10', partial: null };
  const before = s.generation();
  assert.equal(typeof before, 'number');
  s.reset(); // New conversation while the planner was thinking
  assert.notEqual(s.generation(), before);
  const late = s.file('staff-dabirian', v, 'aaaa1111', ['store_record'], { generation: before });
  assert.deepEqual(late, { ok: false, code: 'reset_during_call', reason: 'The HR records were reset while this request was being filed, so nothing was filed.' });
  assert.deepEqual(s.requests('staff-dabirian'), [], 'nothing written into the fresh records');
  assert.equal(s.stored('aaaa1111'), null, 'the refusal is not kept under the operation ID');
  // The current generation (or none, for a caller with no await in between) files as before.
  assert.equal(s.file('staff-dabirian', v, 'aaaa1111', ['store_record'], { generation: s.generation() }).ok, true);
});
