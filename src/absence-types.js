// Shared absence list (51 CHRS type/reason pairs) and time-off arithmetic.
// No imports: the browser loads this file from /shared/absence-types.js. Rows are copied verbatim from
// docs/superpowers/specs/2026-11-03-absence-types.psv (TYPE|Name|REASON|Reason).
export const ABSENCE_TYPES = [
  { type: "ADM", name: "Administrative Leave Paid", code: "MPA", reason: "MPP Paid Admin Leave - 42729a" },
  { type: "ADM", name: "Administrative Leave Paid", code: "MPB", reason: "MPP Paid Admin Leave - 42729b" },
  { type: "BNM", name: "Bone Marrow", code: "BNM", reason: "Bonemarrow" },
  { type: "BRV", name: "Bereavement", code: "AGC", reason: "Grandchild" },
  { type: "BRV", name: "Bereavement", code: "ASD", reason: "Child" },
  { type: "BRV", name: "Bereavement", code: "AUN", reason: "Aunt/Uncle" },
  { type: "BRV", name: "Bereavement", code: "CIL", reason: "Son-in-law/Daughter-in-law" },
  { type: "BRV", name: "Bereavement", code: "GGP", reason: "Grandparent/Great Grandparent" },
  { type: "BRV", name: "Bereavement", code: "OTH", reason: "Other" },
  { type: "BRV", name: "Bereavement", code: "PIL", reason: "Parent-/Step-Parent-in-law" },
  { type: "BRV", name: "Bereavement", code: "PSP", reason: "Parent/Step Parent" },
  { type: "BRV", name: "Bereavement", code: "SBS", reason: "Sibling/Sibling-In-Law" },
  { type: "BRV", name: "Bereavement", code: "SDP", reason: "Spouse/Domestic Partner" },
  { type: "CAT", name: "Catastrophic Leave", code: "10", reason: "Catastrophic Leave" },
  { type: "CFR", name: "California Family Rights Act", code: "NON", reason: "None" },
  { type: "CIT", name: "Citizens Necessity", code: "CIT", reason: "Citizens Necessity" },
  { type: "CPD", name: "Pregnancy Disability", code: "NON", reason: "None" },
  { type: "DCK", name: "Dock", code: "DCK", reason: "Dock" },
  { type: "DCK", name: "Dock", code: "WTS", reason: "Witness for Non CSU" },
  { type: "ECL", name: "Ed Code Maternity Leave", code: "NON", reason: "None" },
  { type: "EMR", name: "Emergency Leave", code: "10", reason: "Emergency Leave" },
  { type: "FML", name: "Family Medical Leave", code: "NON", reason: "None" },
  { type: "HCD", name: "Holiday Credit Leave", code: "10", reason: "Holiday Credit Leave" },
  { type: "HTO", name: "Holiday Time off Leave", code: "10", reason: "Holiday Time off Leave" },
  { type: "JRY", name: "Jury Duty", code: "JRY", reason: "Jury Duty" },
  { type: "MAT", name: "Maternity Leave", code: "10", reason: "Maternity Leave" },
  { type: "MIL", name: "Family Medical Leave Military", code: "NON", reason: "None" },
  { type: "MLA", name: "Military leave - Employee", code: "MLA", reason: "Military leave - Employee" },
  { type: "MLD", name: "Military Spouse/Dom Leave", code: "MLD", reason: "Military Spouse/Dom Leave" },
  { type: "MPA", name: "Maternity/Paternity/Adoption", code: "MPA", reason: "Maternity/Paternity/Adoption" },
  { type: "ODL", name: "Organ Donor Leave", code: "ODL", reason: "Organ Donor Leave" },
  { type: "OTH", name: "Other", code: "10", reason: "Other" },
  { type: "OTH", name: "Other", code: "20", reason: "Compassionate Leave" },
  { type: "OTH", name: "Other", code: "30", reason: "Relative Passed Away" },
  { type: "OTH", name: "Other", code: "40", reason: "Bereavement" },
  { type: "PDL", name: "Professional Development", code: "PDL", reason: "Professional Development" },
  { type: "PHL", name: "Personal Holiday", code: "PHL", reason: "Personal Holiday" },
  { type: "PTO", name: "Personal Time off days", code: "10", reason: "Personal Time off days" },
  { type: "RPP", name: "Reproductive Loss Leave", code: "10", reason: "Reproductive Loss Leave" },
  { type: "SCK", name: "Sick Leave", code: "BRV", reason: "Bereavement" },
  { type: "SCK", name: "Sick Leave", code: "FAM", reason: "Family Care" },
  { type: "SCK", name: "Sick Leave", code: "SCK", reason: "Sick Personal" },
  { type: "SVR", name: "Service Member Care", code: "NON", reason: "None" },
  { type: "TMP", name: "Temp Suspension Leave", code: "10", reason: "Temp Suspension Leave" },
  { type: "UBR", name: "Union Business Release Time", code: "UBR", reason: "Union Business Release Time" },
  { type: "UNL", name: "Union Leave", code: "UNL", reason: "Union Leave" },
  { type: "VAC", name: "Vacation", code: "VAC", reason: "Vacation" },
  { type: "VAC", name: "Vacation", code: "WTS", reason: "Witness for Non CSU" },
  { type: "VCT", name: "Victim Leave", code: "10", reason: "Victim Leave" },
  { type: "VOT", name: "Voting", code: "VOT", reason: "Voting" },
  { type: "WTS", name: "Witness", code: "WTS", reason: "Witness for CSU" },
];

const byType = (type) => ABSENCE_TYPES.filter((r) => r.type === type);

export function absenceNames() {
  const seen = new Set();
  const out = [];
  for (const r of ABSENCE_TYPES) if (!seen.has(r.type)) { seen.add(r.type); out.push({ type: r.type, name: r.name }); }
  return out;
}
export const reasonsOf = (type) => byType(type).map((r) => ({ ...r }));
export const isPair = (type, code) => byType(type).some((r) => r.code === code);
export const nameOf = (type) => byType(type)[0]?.name ?? null;

// The reason to use without asking: the type's only reason, or its only reason whose text equals the name.
export function defaultReason(type) {
  const rows = byType(type);
  if (rows.length === 1) return rows[0].code;
  const same = rows.filter((r) => r.reason === r.name);
  return same.length === 1 ? same[0].code : null;
}

export function titleOf(type, code) {
  const row = byType(type).find((r) => r.code === code);
  const title = nameOf(type) ?? '';
  if (!row || row.reason === row.name || /^none$/i.test(row.reason)) return { title, subtitle: null };
  return { title, subtitle: row.reason };
}

export const CREDIT_OF_TYPE = { VAC: 'vacation', SCK: 'sick', PHL: 'personalHoliday' };
export const CREDIT_LABEL = { vacation: 'vacation', sick: 'sick leave', personalHoliday: 'personal holiday' };

export const PROOF = {
  JRY: 'Your manager will need a copy of your jury summons or certificate of service.',
  WTS: 'Your manager will need a copy of the subpoena.',
  MLA: 'Your manager will need a copy of your military orders.',
};
export const NOTE_PRIVACY = 'Your manager, your timekeeper and Payroll Services can read this note. For anything confidential, talk to your manager directly.';

export const HOLIDAYS = ['2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25']; // sample campus holidays
export const STANDARD_DAY = 8;
export const MAX_SPAN_DAYS = 400; // keeps workdays() bounded

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (d) => {
  if (typeof d !== 'string' || !DATE.test(d)) return false;
  const t = new Date(`${d}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "Thu, Nov 5" — fixed English short form for a YYYY-MM-DD date (not locale dependent).
export function shortDate(date) {
  if (!isRealDate(date)) return '';
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Mon-Fri minus campus holidays, inclusive.
export function workdays(begin, end) {
  const out = [];
  if (!isRealDate(begin) || !isRealDate(end) || end < begin) return out;
  for (let d = begin, i = 0; d <= end && i <= MAX_SPAN_DAYS; d = addDays(d, 1), i += 1) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.includes(d)) out.push(d);
  }
  return out;
}

// Which part of the working days the hours cover. Rules: spec section 12 "Partial days".
export function spreadOf(days, hours, words = null) {
  const invalid = { mode: 'invalid' };
  if (!Number.isInteger(days) || !Number.isFinite(hours) || days < 1 || hours <= 0) return invalid;
  const full = STANDARD_DAY * days;
  if (hours > full) return invalid;
  if (hours === full) return { mode: 'full' };
  if (days === 1) return { mode: 'one_day', first: hours };
  const startFits = hours > STANDARD_DAY * (days - 1) && hours < full;
  const perDay = (hours / days) * 4; // same hours each day only when that is whole quarter hours
  const allFits = hours / days < STANDARD_DAY && Math.abs(perDay - Math.round(perDay)) < 1e-9;
  if (startFits && allFits) {
    if (words === 'start_day_only') return { mode: 'start_day_only', first: hours - STANDARD_DAY * (days - 1) };
    if (words === 'all_days') return { mode: 'all_days', each: hours / days };
    return { mode: 'ask' };
  }
  if (startFits) return { mode: 'start_day_only', first: hours - STANDARD_DAY * (days - 1) };
  if (allFits) return { mode: 'all_days', each: hours / days };
  return invalid;
}

const trim = (n) => String(Number(n.toFixed(2)));
const QUARTER = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
const hoursText = (h) => `${trim(h)} ${h === 1 ? 'hour' : 'hours'}`;

// Whole and quarter days read as days (“14½ days”); anything else reads as hours (“107 hours”, up to 2
// decimals) — “13.38 days” can't be read in 3 seconds (owner rule).
export function daysText(hours) {
  if (!Number.isFinite(hours) || hours < 0) return '';
  const quarters = (hours * 4) / STANDARD_DAY;
  if (Math.abs(quarters - Math.round(quarters)) > 1e-9) return hoursText(hours);
  const days = hours / STANDARD_DAY;
  const whole = Math.floor(days + 1e-9);
  const frac = Math.round((days - whole) * 100) / 100;
  if (frac === 0) return `${whole} ${whole === 1 ? 'day' : 'days'}`;
  if (QUARTER[frac]) return whole === 0 ? `${QUARTER[frac]} day` : `${whole}${QUARTER[frac]} days`;
  return `${trim(days)} days`;
}


export function whenText({ beginDate, endDate, hours, spread, startAt = null, side = null }) {
  const b = shortDate(beginDate);
  const range = beginDate === endDate ? b : `${b} to ${shortDate(endDate)}`;
  const mode = spread?.mode;
  if (mode === 'full') return `${range}, ${daysText(hours)}`;
  if (mode === 'one_day') {
    const clock = startAt ? (side === 'arrive' ? `, until ${startAt}` : `, from ${startAt}`) : '';
    return `${b}, ${hoursText(spread.first)}${clock}`;
  }
  if (mode === 'start_day_only') {
    const days = workdays(beginDate, endDate); // the partial day is the first workday
    const day = shortDate(days[0] ?? beginDate);
    const first = startAt ? `${day} from ${startAt} (${hoursText(spread.first)})` : `${day}, ${hoursText(spread.first)}`;
    const rest = days.length - 1;
    if (rest < 1) return first;
    return `${first}, then ${rest === 1 ? `${shortDate(days[1])} in full` : `the next ${rest} days in full`}`;
  }
  if (mode === 'all_days') return `${range}, ${hoursText(spread.each)} each day`;
  return `${range}, ${hoursText(hours)}`;
}
