// HR Agent: a small, isolated DEMO staff service. SYNTHETIC records only (one fictional professor,
// sample campus holidays) — not a real HR system. Server side only.
//
// The backend is the authority for hours and balances: the model and the browser never supply them.
// Forecast = the Time Off Forecast shown on the card: the hours the absence needs and the balance
// before and after (the name's credit type, if it uses one). Dates and hours come only from here.
//
// Demo policy:
//   - Workdays are Monday-Friday minus the sample campus holidays; hours = workdays x standard hours.
//   - A partial plan ({ mode: 'start_day_only', hours }) shortens only the first workday.
//   - An absence can't begin or end on a campus holiday, must include a workday, and can't use more
//     credit hours than the balance.
//   - Submitting only records the request as sent to the manager; it deducts nothing.
//
// In memory only — nothing is written to disk. Every new store (every HR start) seeds the same staff;
// a retried operation ID can't file twice while the process runs, and a restart forgets requests.
import { addDays, CREDIT_OF } from './forms.js';

export const HOLIDAYS = ['2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25']; // sample campus holidays
const CREDIT_WORDS = { vacation: 'vacation', sick: 'sick', personalHoliday: 'personal holiday' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 400; // keeps workdays() bounded

// "Wed, Nov 11" — fixed English short form for a YYYY-MM-DD date (not locale dependent).
export function shortDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const seedStaff = () => [{ staffId: 'staff-amir', name: 'Professor Amir', standardHours: 8, balances: { vacation: 96, sick: 120, personalHoliday: 8 }, synthetic: true }];

export function createHrStore({ now = () => new Date() } = {}) {
  const state = { staff: seedStaff(), requests: [], operations: new Map() }; // Map: any operation id string is a plain key
  const find = (staffId) => state.staff.find((s) => s.staffId === staffId) ?? null;
  const viewOf = (s) => ({ staffId: s.staffId, name: s.name, standardHours: s.standardHours, balances: { ...s.balances } });
  const fail = (code, reason) => ({ ok: false, code, reason });

  function workdays(begin, end) {
    const out = [];
    if (!DATE.test(begin) || !DATE.test(end) || end < begin) return out;
    for (let d = begin, i = 0; d <= end && i <= MAX_SPAN_DAYS; d = addDays(d, 1), i += 1) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6 && !HOLIDAYS.includes(d)) out.push(d);
    }
    return out;
  }

  function plan(staffId, { absenceName, beginDate, endDate, partial = null } = {}) {
    const person = find(staffId);
    if (!person) return fail('unknown_staff', 'Unknown staff member.');
    if (DATE.test(beginDate) && DATE.test(endDate) && addDays(beginDate, MAX_SPAN_DAYS) < endDate) return fail('too_long', `An absence request can cover at most ${MAX_SPAN_DAYS} days.`);
    const holiday = [beginDate, endDate].find((d) => HOLIDAYS.includes(d));
    if (holiday) return fail('holiday_boundary', `An absence can't begin or end on a campus holiday (${shortDate(holiday)}).`);
    const days = workdays(beginDate, endDate);
    if (!days.length) return fail('no_workdays', 'That range has no workdays.');
    if (partial && !(Number.isFinite(partial.hours) && partial.hours > 0 && partial.hours <= person.standardHours)) return fail('bad_hours', `Partial-day hours must be more than 0 and at most ${person.standardHours}.`);
    const first = partial?.mode === 'start_day_only' ? partial.hours : person.standardHours;
    const hours = first + (days.length - 1) * person.standardHours;
    const type = CREDIT_OF[absenceName] ?? null;
    if (!type) return { ok: true, hours, days: days.length, credit: null };
    const balance = person.balances[type];
    if (hours > balance) return { ...fail('not_enough', `Not enough ${CREDIT_WORDS[type]} hours: ${hours} needed, ${balance} left.`), hours, days: days.length, credit: { type, now: balance, after: balance - hours } };
    return { ok: true, hours, days: days.length, credit: { type, now: balance, after: balance - hours } };
  }

  return {
    staff: (staffId) => { const s = find(staffId); return s ? viewOf(s) : null; },
    workdays,
    plan,
    // Synchronous check-and-write (no await between the plan and the record). Idempotent by operationId:
    // the same values return the stored receipt; the same ID with different values is refused.
    submit(staffId, values, operationId) {
      const request = JSON.stringify([staffId, values?.absenceName, values?.beginDate, values?.endDate, values?.partial ?? null]);
      const previous = state.operations.get(operationId);
      if (previous) return previous.request === request ? previous.result : fail('operation_reused', 'This operation ID was already used for a different request.');
      const p = plan(staffId, values);
      if (!p.ok) return fail(p.code, p.reason);
      const receipt = { requestId: `TO-${String(operationId).replace(/[^0-9a-f]/gi, '').slice(0, 8).toUpperCase()}`, absenceName: values.absenceName, beginDate: values.beginDate, endDate: values.endDate, hours: p.hours, status: 'sent_to_manager' };
      const result = { ok: true, receipt };
      state.requests.push({ ...receipt, staffId, operationId, at: now().toISOString() });
      state.operations.set(operationId, { request, result });
      return result;
    },
    // Demo reset (New conversation, through the Hub): back to the starting sample.
    reset() {
      state.staff = seedStaff();
      state.requests = [];
      state.operations = new Map();
    },
    _records: () => structuredClone(state.requests),
  };
}
