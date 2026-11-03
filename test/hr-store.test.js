// HR store: in-memory staff, holidays, hours and Forecast. Nothing is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHrStore, HOLIDAYS } from '../src/hr-store.js';

const fresh = () => createHrStore({ now: () => new Date('2026-11-02T18:00:00Z') });

test('staff fixture and holidays', () => {
  const s = fresh();
  assert.deepEqual(s.staff('staff-amir'), { staffId: 'staff-amir', name: 'Professor Amir', standardHours: 8, role: 'Department chair', appointment: '12-month', balances: { vacation: 96, sick: 120, personalHoliday: 8 } });
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
  const p = (v) => s.plan('staff-amir', v);
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
  const a = s.submit('staff-amir', v, 'abcdef0123456789');
  assert.equal(a.ok, true);
  assert.deepEqual(a.receipt, { requestId: 'TO-ABCDEF01', absenceType: 'VAC', absenceReason: 'VAC', absenceName: 'Vacation', reasonText: 'Vacation', beginDate: '2026-11-10', endDate: '2026-11-12', hours: 16, status: 'sent_to_manager' });
  assert.deepEqual(s.submit('staff-amir', v, 'abcdef0123456789').receipt, a.receipt);
  assert.equal(s._records().length, 1);
  assert.equal(s.submit('staff-amir', { ...v, endDate: '2026-11-10' }, 'abcdef0123456789').code, 'operation_reused');
  assert.equal(s.submit('staff-amir', { ...v, beginDate: '2026-11-11' }, 'ffffffff00000000').code, 'holiday_boundary');
  assert.equal(s.staff('staff-amir').balances.vacation, 96); // deducts nothing
  s.reset();
  assert.equal(s._records().length, 0);
});

test('nothing is written to disk', () => {
  assert.doesNotMatch(readFileSync('src/hr-store.js', 'utf8'), /node:fs|writeFile/);
});

test('plan refuses bad partial hours and over-long ranges; submit refuses the same way', () => {
  const s = fresh();
  const base = { absenceType: 'SCK', absenceReason: 'SCK', beginDate: '2026-11-10', endDate: '2026-11-10' };
  const msg = 'Partial-day hours must be more than 0 and less than 8.';
  for (const hours of [-50, 0, NaN, '4', 9, Infinity, undefined]) {
    const r = s.plan('staff-amir', { ...base, partial: { mode: 'start_day_only', hours } });
    assert.equal(r.ok, false); assert.equal(r.code, 'bad_hours'); assert.equal(r.reason, msg);
  }
  assert.equal(s.plan('staff-amir', { ...base, partial: { mode: 'start_day_only', hours: 8 } }).code, 'bad_hours');
  assert.equal(s.plan('staff-amir', { ...base, partial: { mode: 'all_days', hours: 7.5 } }).hours, 7.5);
  assert.equal(s.submit('staff-amir', { ...base, partial: { mode: 'start_day_only', hours: -50 } }, 'aaaaaaaa11111111').code, 'bad_hours');
  const long = s.plan('staff-amir', { absenceType: 'DCK', beginDate: '2026-11-10', endDate: '2027-12-20', partial: null });
  assert.equal(long.ok, false); assert.equal(long.code, 'too_long');
  assert.equal(long.reason, 'An absence request can cover at most 400 days.');
  assert.equal(s.plan('staff-amir', { absenceType: 'DCK', beginDate: '2026-11-10', endDate: '2027-12-14', partial: null }).ok, true); // exactly 400 days
  assert.equal(s.submit('staff-amir', { absenceType: 'DCK', absenceReason: 'DCK', beginDate: '2026-11-10', endDate: '2027-12-20', partial: null }, 'bbbbbbbb22222222').code, 'too_long');
  assert.equal(s._records().length, 0);
});

test('final fix 5: operation ids like __proto__ and constructor behave like any other id', () => {
  const s = fresh();
  const v = { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-06', endDate: '2026-11-06', partial: null };
  for (const id of ['__proto__', 'constructor', 'toString']) {
    const r = s.submit('staff-amir', v, id);
    assert.equal(r.ok, true, id);
    assert.deepEqual(s.submit('staff-amir', v, id), r, `${id}: a repeat returns the stored receipt`);
    assert.equal(s.submit('staff-amir', { ...v, beginDate: '2026-11-09', endDate: '2026-11-09' }, id).code, 'operation_reused', id);
  }
  assert.equal(s._records().length, 3);
});

test('all_days partial spreads hours over every workday', () => {
  const s = fresh();
  const r = s.plan('staff-amir', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-12', partial: { mode: 'all_days', hours: 4 } });
  assert.equal(r.hours, 12); // Nov 11 holiday is skipped: 3 workdays x 4
  assert.equal(s.plan('staff-amir', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-11', partial: { mode: 'all_days', hours: 4 } }).code, 'holiday_boundary');
});

test('reasons, balances and requests', () => {
  const s = fresh();
  const r = s.plan('staff-amir', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-10', partial: { mode: 'all_days', hours: 4 } });
  assert.equal(r.hours, 8);
  assert.equal(s.submit('staff-amir', { absenceType: 'VAC', absenceReason: 'GGP', beginDate: '2026-11-06', endDate: '2026-11-06' }, 'op1').code, 'bad_reason'); // reason from another type is refused
  assert.equal(s.plan('staff-amir', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-10', partial: { mode: 'all_days', hours: 8 } }).code, 'bad_hours');
  assert.equal(s.plan('staff-amir', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-10', partial: { mode: 'bogus', hours: 4 } }).code, 'bad_hours');
  const sick = s.plan('staff-amir', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-12-10', partial: null });
  assert.equal(sick.reason, 'Not enough sick leave: 160 hours needed, 120 left.'.replace('160', String(sick.hours)));
  assert.deepEqual(s.balances('staff-amir'), { vacation: 96, sick: 120, personalHoliday: 8 });
  assert.equal(s.balances('nobody'), null);
  const v = { absenceType: 'BRV', absenceReason: 'GGP', beginDate: '2026-11-06', endDate: '2026-11-06' };
  const a = s.submit('staff-amir', v, 'aaaaaaaa11111111');
  assert.equal(a.receipt.absenceName, 'Bereavement'); assert.equal(a.receipt.reasonText, 'Grandparent/Great Grandparent');
  assert.equal(s.submit('staff-amir', { ...v, absenceReason: 'OTH' }, 'aaaaaaaa11111111').code, 'operation_reused');
  const b = s.submit('staff-amir', { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-09', endDate: '2026-11-09' }, 'bbbbbbbb22222222');
  assert.deepEqual(s.requests('staff-amir').map((x) => x.requestId), [b.receipt.requestId, a.receipt.requestId]);
  assert.equal('operationId' in s.requests('staff-amir')[0], false);
  assert.deepEqual(s.requests('nobody'), []);
});
