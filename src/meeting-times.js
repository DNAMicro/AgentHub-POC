// Part 9: meeting times the professor offers a student, read from the PROFESSOR'S OWN WORDS by code —
// never invented by a model (the same rule as form prefill from a student's words). Dependency-free.
//
//   slotsIn('Tuesday 2pm or Wed at 10:30am', { now })  →  [{ slotId: 's1', start: '2026-10-27T14:00', label: 'Tue, Oct 27, 2:00 PM' }, …]
//
// Understands weekdays (“Tue”, “Tuesday”, the next one from today), “today”, “tomorrow”, “Oct 28”,
// “10/28”, and times “2pm”, “2:30 pm”, “14:00”, “noon”. A day carries over to later times in the same
// sentence (“Tuesday at 2pm or 4pm”). Times are Pacific (the demo's campus time zone); past times and
// duplicates are dropped; at most 6 slots.
export const MEETING_TZ = 'America/Los_Angeles';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

// Today's date and time in the campus time zone, as plain numbers.
function campusNow(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: MEETING_TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
// Date-only arithmetic in UTC (no time zone involved): add days, weekday of a date.
const addDays = ({ y, m, d }, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekday = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const key = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

const DAY_RE = /\b(today|tomorrow|(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?\.?|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})\/(\d{1,2}))\b/gi;
const TIME_RE = /\b(noon|(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)|([01]?\d|2[0-3]):([0-5]\d))(?![\d/])/gi;

function dayFrom(match, today) {
  const word = match[1].toLowerCase();
  if (word === 'today') return today;
  if (word === 'tomorrow') return addDays(today, 1);
  if (match[2]) { // a month name and day
    const m = MONTHS.indexOf(match[2].toLowerCase().slice(0, 3)) + 1;
    const d = Number(match[3]);
    let y = today.y;
    if (m < today.m || (m === today.m && d < today.d)) y += 1;
    return d >= 1 && d <= 31 ? { y, m, d } : null;
  }
  if (match[4]) { // m/d
    const m = Number(match[4]);
    const d = Number(match[5]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y: m < today.m || (m === today.m && d < today.d) ? today.y + 1 : today.y, m, d };
  }
  const target = DAYS.indexOf(word.slice(0, 3));
  return target < 0 ? null : { ...addDays(today, (target - weekday(today) + 7) % 7), named: true };
}
function minutesFrom(match) {
  if (match[1].toLowerCase() === 'noon') return 12 * 60;
  if (match[2]) {
    let h = Number(match[2]);
    if (h < 1 || h > 12) return null;
    const pm = match[4].toLowerCase().startsWith('p');
    if (h === 12) h = 0;
    return (h + (pm ? 12 : 0)) * 60 + Number(match[3] ?? 0);
  }
  return Number(match[5]) * 60 + Number(match[6]);
}
export function labelOf(start) {
  const [date, time] = start.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  return `${day}, ${((h + 11) % 12) + 1}:${pad(min)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function slotsIn(text, { now = new Date(), max = 6 } = {}) {
  const today = campusNow(now);
  const found = [];
  // Sentence-ish pieces; a day named in a piece applies to the times after it in that piece (and before it,
  // for “2pm on Tuesday”); with no day at all, a time is not a slot (we don't guess the day).
  for (const piece of String(text ?? '').split(/[.;\n]+/)) {
    const marks = [];
    for (const m of piece.matchAll(DAY_RE)) { const day = dayFrom(m, today); if (day) marks.push({ at: m.index, day }); }
    for (const t of piece.matchAll(TIME_RE)) {
      const minutes = minutesFrom(t);
      if (minutes === null) continue;
      const before = marks.filter((x) => x.at < t.index).at(-1);
      const after = marks.find((x) => x.at > t.index);
      let day = before?.day ?? after?.day;
      if (!day) continue;
      if (key(day) === key(today) && minutes <= today.minutes) {
        if (!day.named) continue; // “today 9am” at 10pm is past
        day = addDays(day, 7); // “Monday 9am” said on a Monday evening means next Monday
      }
      const start = `${key(day)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
      if (!found.some((s) => s.start === start)) found.push({ start });
    }
  }
  return found.sort((a, b) => a.start.localeCompare(b.start)).slice(0, max).map((s, i) => ({ slotId: `s${i + 1}`, start: s.start, label: labelOf(s.start) }));
}

// The shape a meeting offer must have wherever it is checked (Professor, Hub, Student).
export function validMeeting(meeting) {
  if (meeting === null || meeting === undefined) return true;
  if (typeof meeting !== 'object' || !/^mt-[\w-]{6,40}$/.test(meeting.meetingId ?? '') || !Array.isArray(meeting.slots) || meeting.slots.length < 1 || meeting.slots.length > 6) return false;
  return meeting.slots.every((s) => /^s[1-6]$/.test(s?.slotId ?? '') && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s.start ?? '') && s.label === labelOf(s.start));
}
