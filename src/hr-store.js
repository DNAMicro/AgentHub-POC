// HR Agent: a small, isolated DEMO staff service. SYNTHETIC records only (one fictional professor,
// sample campus holidays) — not a real HR system. Server side only.
//
// The backend is the authority for hours and balances: the model and the browser never supply them.
// Forecast = the Time Off Forecast shown on the card: the hours the absence needs and the balance
// before and after (the name's credit type, if it uses one). Dates and hours come only from here.
//
// Demo policy:
//   - Workdays are Monday-Friday minus the sample campus holidays; hours = workdays x standard hours.
//   - A partial plan is { mode: 'start_day_only', hours } (first workday only) or { mode: 'all_days', hours }
//     (every workday); hours must be more than 0 and less than the standard day.
//   - An absence can't begin or end on a campus holiday, must include a workday, and can't use more
//     credit hours than the balance.
//   - Submitting only records the request as sent to the manager; it deducts nothing.
//
// In memory only — nothing is written to disk. Every new store (every HR start) seeds the same staff;
// a retried operation ID can't file twice while the process runs, and a restart forgets requests.
import { addDays } from './forms.js';
import { HOLIDAYS, MAX_SPAN_DAYS, workdays, shortDate, CREDIT_OF_TYPE, CREDIT_LABEL, isPair, nameOf, reasonsOf } from './absence-types.js';

export { HOLIDAYS }; // existing importers keep using hr-store

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const seedStaff = () => [{ staffId: 'staff-amir', name: 'Professor Amir', standardHours: 8, balances: { vacation: 96, sick: 120, personalHoliday: 8 }, role: 'Department chair', appointment: '12-month', synthetic: true }];

export function createHrStore({ now = () => new Date() } = {}) {
  const state = { staff: seedStaff(), requests: [], operations: new Map() }; // Map: any operation id string is a plain key
  const find = (staffId) => state.staff.find((s) => s.staffId === staffId) ?? null;
  const viewOf = (s) => ({ staffId: s.staffId, name: s.name, standardHours: s.standardHours, role: s.role, appointment: s.appointment, balances: { ...s.balances } });
  const fail = (code, reason) => ({ ok: false, code, reason });

  function plan(staffId, { absenceType, beginDate, endDate, partial = null } = {}) {
    const person = find(staffId);
    if (!person) return fail('unknown_staff', 'Unknown staff member.');
    if (DATE.test(beginDate) && DATE.test(endDate) && addDays(beginDate, MAX_SPAN_DAYS) < endDate) return fail('too_long', `An absence request can cover at most ${MAX_SPAN_DAYS} days.`);
    const holiday = [beginDate, endDate].find((d) => HOLIDAYS.includes(d));
    if (holiday) return fail('holiday_boundary', `An absence can't begin or end on a campus holiday (${shortDate(holiday)}).`);
    const days = workdays(beginDate, endDate);
    if (!days.length) return fail('no_workdays', 'That range has no workdays.');
    const std = person.standardHours;
    if (partial && !(Number.isFinite(partial.hours) && partial.hours > 0 && partial.hours < std && (partial.mode === 'start_day_only' || partial.mode === 'all_days'))) return fail('bad_hours', `Partial-day hours must be more than 0 and less than ${std}.`);
    let hours = days.length * std;
    if (partial?.mode === 'start_day_only') hours = partial.hours + (days.length - 1) * std;
    else if (partial?.mode === 'all_days') hours = partial.hours * days.length;
    const type = CREDIT_OF_TYPE[absenceType] ?? null;
    if (!type) return { ok: true, hours, days: days.length, credit: null };
    const balance = person.balances[type];
    if (hours > balance) return { ...fail('not_enough', `Not enough ${CREDIT_LABEL[type]}: ${hours} hours needed, ${balance} left.`), hours, days: days.length, credit: { type, now: balance, after: balance - hours } };
    return { ok: true, hours, days: days.length, credit: { type, now: balance, after: balance - hours } };
  }

  return {
    staff: (staffId) => { const s = find(staffId); return s ? viewOf(s) : null; },
    workdays,
    plan,
    // Synchronous check-and-write (no await between the plan and the record). Idempotent by operationId:
    // the same values return the stored receipt; the same ID with different values is refused.
    submit(staffId, values, operationId) {
      const request = JSON.stringify([staffId, values?.absenceType, values?.absenceReason, values?.beginDate, values?.endDate, values?.partial ?? null]);
      const previous = state.operations.get(operationId);
      if (previous) return previous.request === request ? previous.result : fail('operation_reused', 'This operation ID was already used for a different request.');
      if (!isPair(values?.absenceType, values?.absenceReason)) return fail('bad_reason', 'That reason does not belong to this absence type.');
      const p = plan(staffId, values);
      if (!p.ok) return fail(p.code, p.reason);
      const receipt = { requestId: `TO-${String(operationId).replace(/[^0-9a-f]/gi, '').slice(0, 8).toUpperCase()}`, absenceType: values.absenceType, absenceReason: values.absenceReason, absenceName: nameOf(values.absenceType), reasonText: reasonsOf(values.absenceType).find((r) => r.code === values.absenceReason)?.reason ?? null, beginDate: values.beginDate, endDate: values.endDate, hours: p.hours, status: 'sent_to_manager' };
      const result = { ok: true, receipt };
      state.requests.push({ ...receipt, staffId, operationId, at: now().toISOString() });
      state.operations.set(operationId, { request, result });
      return result;
    },
    balances: (staffId) => { const s = find(staffId); return s ? { ...s.balances } : null; },
    // Receipts for one person, newest first.
    requests: (staffId) => state.requests.filter((r) => r.staffId === staffId).map((r) => ({
      requestId: r.requestId, absenceType: r.absenceType, absenceReason: r.absenceReason, absenceName: r.absenceName, reasonText: r.reasonText,
      beginDate: r.beginDate, endDate: r.endDate, hours: r.hours, status: r.status,
    })).reverse(),
    // Demo reset (New conversation, through the Hub): back to the starting sample.
    reset() {
      state.staff = seedStaff();
      state.requests = [];
      state.operations = new Map();
    },
    _records: () => structuredClone(state.requests),
  };
}
