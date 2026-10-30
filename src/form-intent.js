// Part 6: when does a message ask for a workflow form?
//
// * Deterministic heuristics: used in fixed/mock modes and by tests. Labelled heuristics — they prove
//   the plumbing, not real language understanding. Live mode asks the model for the outcome instead.
// * Prefill is ALWAYS parsed here from the student's own words, in every mode. The model never
//   supplies prefilled values, so nothing it invents can end up in a form.
import { BOOKING, TUTORING_HOURS, addDays, todayIn } from './forms.js';

const lower = (s) => String(s ?? '').toLowerCase().replace(/[’']/g, "'");

// ---- Tutor: in-person tutoring requests --------------------------------------------------------

const IN_PERSON = /\b(in[- ]person|face[- ]to[- ]face|meet (?:with )?(?:a|the|my) tutor|tutor(?:ing)? (?:session|appointment|meeting)s?)\b/;
const ASKS_HOW = /^\s*(how|what|why|when|where|is|are|does|do)\b/;
const INFO_WORDS = /\b(work|works|cost|costs|mean|means|happen|happens|available|availability|process)\b|\bhow (?:do|can) i (?:request|arrange|book|get)\b/;
const WANTS = /\b(want|need|like|arrange|book|schedule|set up|request|reserve|can i|could i|may i|i'd)\b/;
const WANTS_TUTORING = /\b(i (?:want|need|would like|'d like)|can i (?:get|have)|looking for)\b.*\b(tutoring|a tutor)\b/;

// → 'offer' | 'info' | 'clarify' | null
export function mockTutorIntent(question) {
  const q = lower(question);
  if (IN_PERSON.test(q) && ASKS_HOW.test(q) && INFO_WORDS.test(q)) return 'info';
  if (IN_PERSON.test(q) && WANTS.test(q)) return 'offer';
  if (WANTS_TUTORING.test(q)) return 'clarify';
  return null;
}

// ---- Library: group study-room bookings --------------------------------------------------------

const ROOM = /\b(study ?rooms?|group rooms?|rooms?)\b/;
const BOOK = /\b(reserve|book|booking|schedule|get)\b/;
const HOW_TO = /^\s*(how|what|when|where|is|are|does|do)\b/;

export function mockLibraryIntent(question) {
  const q = lower(question);
  if (!ROOM.test(q)) return null;
  // "How do I book a study room?" is about the process; "Where are the study rooms?" is a plain question.
  if (HOW_TO.test(q) && /\b(book|reserve|booking|reservation)s?\b/.test(q) && !/\b(i want|i'd like|i need)\b/.test(q)) return 'info';
  if (BOOK.test(q)) return 'offer';
  if (/\b(need|want|looking for)\b/.test(q)) return 'clarify';
  return null;
}

// Part 8 (mock only, labelled heuristic): the student is asking about their OWN current loans — not
// how borrowing works in general ("How do I renew my book?" stays a how-to question).
const OWN_LOANS = /\b(my loans?|my (books?|items?) (is |are )?due|when (is|are) (my|the) [\w\s:'’-]{0,60}\bdue|everything i (have )?borrowed|what (did|have) i borrow|(books?|items?) i (have )?borrowed|extend (the|my|it)|keep (it|the|my)|why can'?t i renew|renew (the|my|this|that) [\w\s:'’-]{0,40}\bbook)\b/;
const HOW_DO_I = /^\s*how (do|can|should|would|does) (i|you|one|a student)\b/;
export const mockOwnLoans = (question) => OWN_LOANS.test(lower(question)) && !HOW_DO_I.test(lower(question));

// "replace the form", "start over" → the student explicitly wants a fresh form.
export const wantsReplacement = (question) => /\b(replace|start over|start again|new form|fresh form|discard)\b/.test(lower(question));

// ---- prefill: only explicitly stated values ------------------------------------------------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parseStatedDate(question, now = new Date()) {
  const q = lower(question);
  const today = todayIn(now);
  if (/\bday after tomorrow\b/.test(q)) return addDays(today, 2);
  if (/\btomorrow\b/.test(q)) return addDays(today, 1);
  if (/\btoday\b/.test(q)) return today;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(q);
  if (iso) return iso[1];
  // A month and day without a year means the next time that date comes round. Impossible dates (2/30) → none.
  const onOrAfterToday = (month, dayOfMonth, year = null) => {
    const iso = (y) => `${y}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
    let y = year ?? Number(today.slice(0, 4));
    if (year === null && iso(y) < today) y += 1;
    const d = new Date(`${iso(y)}T12:00:00Z`);
    return month >= 1 && month <= 12 && d.getUTCMonth() + 1 === month && d.getUTCDate() === dayOfMonth ? iso(y) : null;
  };
  const monthOf = (name) => MONTHS.findIndex((m) => m.startsWith(name)) + 1;
  const names = MONTHS.map((m) => m.slice(0, 3)).join('|');
  const md = new RegExp(`\\b(${names})[a-z]*\\.?\\s+(\\d{1,2})\\b`).exec(q);
  if (md) return onOrAfterToday(monthOf(md[1]), Number(md[2]));
  // "10 November", "the 10th of november".
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${names})[a-z]*\\b`).exec(q);
  if (dm) return onOrAfterToday(monthOf(dm[2]), Number(dm[1]));
  // US month/day the way people type it: "11/10", "11/10/26", "11/10/2026" — never inside math ("x^1/2", "3/4x").
  const num = /(?<![\w^.\/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\w\/])/.exec(q);
  if (num) return onOrAfterToday(Number(num[1]), Number(num[2]), num[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : null);
  const day = new RegExp(`\\b(?:next |this |on )?(${DAYS.join('|')})\\b`).exec(q);
  if (day) {
    const target = DAYS.indexOf(day[1]);
    const current = new Date(`${today}T12:00:00Z`).getUTCDay();
    return addDays(today, ((target - current + 7) % 7) || 7);
  }
  return null;
}

export function parseStatedTime(question) {
  const q = lower(question);
  const ampm = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/.exec(q);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === 'pm') h += 12;
    return h <= 23 ? `${String(h).padStart(2, '0')}:${ampm[2] ?? '00'}` : null;
  }
  const hm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(q);
  return hm ? `${hm[1].padStart(2, '0')}:${hm[2]}` : null;
}

// The receiving agent re-validates every value against the form's rules and drops any that
// don't fit (out of range, weekend, inconsistent period/time), so a prefill can never be invalid.
export function tutoringPrefill(question, now = new Date()) {
  const q = lower(question);
  const prefill = {};
  const date = parseStatedDate(question, now);
  const today = todayIn(now);
  if (date && date >= today && date <= addDays(today, TUTORING_HOURS.maxDaysAhead) && ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) prefill.preferredDate = date;
  if (/\bmorning\b/.test(q)) prefill.period = 'morning';
  else if (/\bafternoon\b/.test(q)) prefill.period = 'afternoon';
  const time = parseStatedTime(question);
  if (time && time >= TUTORING_HOURS.open && time < TUTORING_HOURS.close) {
    const period = time < TUTORING_HOURS.noon ? 'morning' : 'afternoon';
    if (!prefill.period || prefill.period === period) Object.assign(prefill, { specificTime: time, period });
  }
  return prefill;
}

export function bookingPrefill(question, now = new Date()) {
  const q = lower(question);
  const prefill = {};
  const date = parseStatedDate(question, now);
  const today = todayIn(now);
  if (date && date >= today && date <= addDays(today, BOOKING.maxDaysAhead)) prefill.date = date;
  const size = /\b(?:for|group of|party of)\s+(\d{1,2})\b|\b(\d{1,2})\s*(?:people|persons|students|of us)\b/.exec(q);
  const n = size ? Number(size[1] ?? size[2]) : 0;
  if (n >= 1 && n <= BOOKING.maxGroup) prefill.groupSize = n;
  if (/\b(2|two)\s*hours?\b/.test(q)) prefill.duration = 120;
  else if (/\b(1|one|an)\s*hours?\b/.test(q)) prefill.duration = 60;
  return prefill;
}
