// Leave rules shared by the HR Agent (forecast on the card) and the PeopleSoft stand-in (what it enforces).
// Pure: no state, no I/O. The person is { standardHours, balances }.
import { addDays } from './forms.js';
import { HOLIDAYS, MAX_SPAN_DAYS, workdays, shortDate, CREDIT_OF_TYPE, CREDIT_LABEL } from './absence-types.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (code, reason) => ({ ok: false, code, reason });

export function planAbsence(person, { absenceType, beginDate, endDate, partial = null } = {}) {
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
