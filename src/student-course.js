// Review F (owner, 2026-11-06): what a STUDENT asks the Marketing 351 course assistant about the class, answered in code
// before any model call. “All the student scenarios should have been answered instead of asking the professor”: the
// assistant ANSWERS from the shared class facts (src/course-schedule.js) and from the notices THIS student was sent.
// Sending a question to Dr. Dabirian is the exception and is always offered first (yes / no) — never done on a guess.
//
// courseAnswer(question, { now, notices }) → { topic, text, offer? } | null
//   topic: a short label for telemetry (no words of the question)
//   offer: 'ask' (the student asked for the faculty member), 'decision' (only the faculty member can decide it),
//          'class_message' (a message for the whole class) — the agent holds the question and waits for yes / no.
// notices: the posts this (Hub-verified) student was sent: [{ title, text, kind, createdAt, quiz?, meeting? }].
// Privacy: never a classmate's name, count, email, ID, level or major — the answer about other students is a fixed decline.
import { COURSE } from './course-pack.js';
import { HOLIDAYS } from './absence-types.js';
import {
  COURSE_DESCRIPTION, FINAL_EXAM, GRADING, MEETING, OFFICE_HOURS, TERM, TOPICS, UNITS,
  asksCovered, coveredText, dayLabel, meetsOn, pacificDate,
} from './course-schedule.js';

const PROF = COURSE.professorName;
const TITLE = COURSE.title;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---- fixed words (the student reads them) -------------------------------------------------------------------
export const PRIVACY_TEXT = 'I can’t share who else is in the class or anything about another student — student records are private. You’ll meet your classmates in class.';
export const OFFER_ASK_TEXT = `Want me to send this to ${PROF}?`;
export const OFFER_DECISION_TEXT = `That’s ${PROF}’s call. Want me to send your question to them?`;
export const OFFER_CLASS_TEXT = `Only ${PROF} can message the whole class. Want me to send your message to ${PROF}?`;
export const OFFER_UNKNOWN_TEXT = `I don’t have that in the course notes or the class schedule. Want me to send your question to ${PROF}?`;
export const SENT_TEXT = `Sent to ${PROF} — they’ll get back to you here.`;
export const OFFER_NOT_SENT_TEXT = 'OK, I didn’t send it.';
export const LATE_YES_TEXT = `I didn’t send your earlier question — it’s no longer waiting. Ask it again and I’ll offer to send it to ${PROF}.`;
export const ALREADY_SENT_TEXT = `That’s already sent to ${PROF} — they’ll get back to you here.`;
export const GRADES_TEXT = 'Your grades are in Canvas — this assistant can’t see them.';
export const NO_QUIZ_TEXT = 'No quiz has been posted yet.';
export const WHO_TEACHES_TEXT = `${PROF} teaches ${TITLE}.`;
export const IDENTITY_TEXT = `I’m ${PROF}’s course assistant for ${TITLE}, not ${PROF}. I can answer questions about the class and the course material, and I can send a question to ${PROF} for you.`;
export const offerText = (kind) => (kind === 'decision' ? OFFER_DECISION_TEXT : kind === 'class_message' ? OFFER_CLASS_TEXT : kind === 'unknown' ? OFFER_UNKNOWN_TEXT : OFFER_ASK_TEXT);
// How long a held question waits for the student's yes (then a yes is answered honestly with LATE_YES_TEXT).
export const OFFER_TTL_MS = 15 * 60_000;

// ---- yes / no to an offer -------------------------------------------------------------------------------------
const YES = /^\s*(?:yes|yeah|yep|yup|ya|sure|ok(?:ay)?|please(?:\s+do)?|go\s+ahead|send\s+it|do\s+it|y)\b[\s,.!:;—–-]*/i;
const NO = /^\s*(?:no|nope|nah|don['’]?t|do\s+not|never\s*mind|nevermind|not\s+now|no\s+thanks|cancel)\b/i;
// “yes” → { extra: '' }; “yes — and tell them I was sick” → { extra: 'and tell them I was sick' }; anything else → null.
export function yesOf(text) {
  const s = String(text ?? '').trim();
  if (NO.test(s)) return null;
  const m = YES.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length).replace(/^(?:please|send\s+it|go\s+ahead|thanks?|thank\s+you)\b[\s,.!:;—–-]*/i, '').trim();
  return { extra: /^[.!?]*$/.test(rest) ? '' : rest.slice(0, 1000) };
}
export const isNo = (text) => NO.test(String(text ?? '')) && String(text).trim().split(/\s+/).length <= 6;

// ---- recognisers ---------------------------------------------------------------------------------------------
const s = (t) => String(t ?? '').replace(/[’]/g, '\'').replace(/\s+/g, ' ').trim();
const PROF_LAST = PROF.split(/\s+/).at(-1);
const PROF_REF = `(?:dr\\.?\\s+${PROF_LAST}|${PROF_LAST}|(?:my|the|our)\\s+(?:professor|prof|instructor|teacher|lecturer|faculty(?:\\s+member)?))`;

// A message for everyone in the class: “tell everyone in my marketing class that the study group meets tonight”.
const CLASS_MESSAGE = /\b(?:tell|message|notify|inform|email|e-mail|text|remind|let|ping|announce\s+to|send\s+(?:a\s+)?(?:message|note|reminder)\s+to|post\s+(?:a\s+)?(?:message|note)?\s*(?:to|for))\s+(?!me\b|us\b)(?:all\s+(?:of\s+)?)?(?:everyone|everybody|the\s+(?:whole\s+|entire\s+)?class|my\s+(?:whole\s+)?class|(?:my|the|our)\s+classmates|all\s+(?:my\s+|the\s+)?(?:classmates|students)|the\s+(?:other\s+)?students|the\s+rest\s+of\s+(?:the\s+)?class)\b/i;
// Asking for the faculty member WITH something to send: “can you ask Dr. Dabirian about the homework?”,
// “I'll miss class Tuesday, can you let Dr. Dabirian know?”, “tell my professor I'm sick”.
const ASKS_PROFESSOR = new RegExp(`\\b(?:ask|tell|let|message|email|e-mail|contact|reach|notify|inform|ping|forward\\s+(?:this|it|that)\\s+to|send\\s+(?:this|it|that|a\\s+(?:message|note))\\s+to|pass\\s+(?:this|it|that)\\s+(?:on\\s+|along\\s+)?to)\\s+${PROF_REF}\\b`, 'i');
const MISSES_CLASS = /\b(?:i(?:'ll| will| am going to|'m going to| won't be able to| can't| cannot)?\s+(?:miss|be\s+missing|be\s+absent|be\s+out|not\s+(?:be\s+)?(?:in|at)\s+class))\b/i;
// Only the faculty member can decide: extensions, make-ups, excused absences, grade disputes, accommodations, dropping.
const DECISION = /\b(?:extensions?|extend\s+(?:the\s+|my\s+)?(?:deadline|due\s+date)|more\s+time\s+(?:on|for|to)|make[- ]?up\s+(?:exam|quiz|test|work|assignment|class|the)|make\s+up\s+(?:the|my|an?)\s+(?:exam|quiz|test|midterm|final|class|work)|retake|re-take|excused?\s+(?:absence|from)|excused|excuse\s+(?:my|me|the)|regrade|re-grade|dispute\s+(?:my|the|a)\s+(?:grade|score)|(?:my\s+)?grade\s+(?:is|was|looks)\s+wrong|wrong\s+grade|an?\s+incomplete|accommodations?|(?:drop|withdraw\s+from)\s+(?:the|this|my)\s+(?:class|course))\b/i;

// Another student — never answered (names, counts, emails, IDs, levels, majors, who has done what).
const NOT_A_NAME = new Set(['Dr', 'Dabirian', 'Marketing', 'Mktg', 'Canvas', 'Professor', 'Prof', 'Mihaylo', 'Hall', 'Topic', 'Unit', 'Fall', 'Spring',
  'There', 'It', 'This', 'That', 'The', 'My', 'Our', 'Your', 'Class', 'Anyone', 'Anybody', 'Someone', 'Somebody', 'Everyone', 'Everybody', 'He', 'She',
  'They', 'We', 'You', 'I', 'Am', 'What', 'When', 'Where', 'Who', 'Why', 'How', 'Which', 'Is', 'Are', 'Does', 'Do', 'Did', 'Has', 'Have', 'Can', 'Will',
  'Today', 'Tomorrow', 'Tonight', 'Personal', 'Quiz', 'Exam', 'Midterm', 'Final', 'Syllabus', 'Office',
  ...WEEKDAY_NAMES, ...MONTHS, 'January', 'February', 'March', 'April', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const NAMED_DOES = /\b(?:[Ii]s|[Aa]re|[Dd]oes|[Dd]id|[Hh]as|[Cc]an|[Ww]ill|[Ww]as)\s+([A-Z][a-z]+(?:[- ][A-Z][a-z]+)?)\s+(?:in|taking|take|took|enrolled|registered|have|had|has|get|got|done|finish\w*|submit\w*|see|seen|know|still|also|even|really|a|an|on|passing|failing|doing|coming|going|attend\w*)\b/;
const NAMED_OWNS = /\b([A-Z][a-z]+(?:[- ][A-Z][a-z]+)?)'s\s+(?:e-?mail|phone|number|cell|id|student\s+id|cwid|major|minor|grade|grades|score|scores|address|contact|year|level|schedule|pronouns|gpa|units|class\s+standing|info\w*|details|instagram|snapchat|socials?)\b/;
const PEOPLE = [
  /\bclass-?mates?\b/i,
  /\bwho(?:'s|\s+is|\s+are)?\s+else\b/i,
  /\bwho(?:'s|\s+is|\s+are)\s+(?:in|taking|enrolled|registered|signed\s+up)\b/i,
  /\bwho\s+(?:takes|is\s+taking|else\s+takes)\b/i,
  /\b(?:other|another|fellow)\s+students?\b/i,
  /\bhow\s+many\s+(?:students|people|kids|of\s+us|others|seniors|juniors|majors|classmates)\b/i,
  /\bhow\s+(?:big|large|full)\s+is\s+(?:my|the|our|this)\s+(?:class|section|course)\b/i,
  /\b(?:class|student)\s+(?:list|roster)\b|\broster\b/i,
  /\bwho\b[^?.!]*\b(?:seniors?|juniors?|sophomores?|freshm[ae]n|first[- ]years?|transfer\s+students?|majors?|majoring)\b/i,
  /\b(?:any|which|are\s+there(?:\s+any)?|list\s+(?:the|all)?)\s+(?:[a-z]+\s+){0,2}(?:seniors?|juniors?|sophomores?|freshm[ae]n|majors?)\b[^?.!]*\b(?:class|course|section|marketing)\b/i,
  /\b(?:anyone|anybody|someone|somebody|everyone|everybody)\b[^?.!]*\b(?:in|from|taking)\s+(?:my|our|the|this)\s+(?:marketing\s+)?(?:class|course|section)\b/i,
  /\b(?:is|are)\s+(?:my\s+)?(?:friend|roommate|buddy|boyfriend|girlfriend|partner|cousin|brother|sister)\b[^?.!]*\b(?:in|taking)\b/i,
  /\b(?:is|are)\s+(?!we\b|i\b|you\b|it\b|there\b|they\b)[a-z][\w.'-]*(?:\s+[a-z][\w.'-]*)?\s+(?:in|taking|enrolled\s+in|registered\s+for)\s+(?:my|our|the|this)\s+(?:marketing\s+)?(?:class|course|section)\b/i,
  /\b(?:e-?mails?|phone\s+numbers?|contact\s+info\w*)\s+(?:of|for)\s+(?:a\s+|an?other\s+|my\s+|the\s+)?(?:students?|classmates?|someone|somebody|people)\b/i,
];
function namesSomeone(t) {
  for (const re of [NAMED_DOES, NAMED_OWNS]) {
    const m = re.exec(t);
    if (m && !m[1].split(/[- ]/).some((w) => NOT_A_NAME.has(w))) return true;
  }
  return false;
}
export const asksAboutClassmates = (text) => { const t = s(text); return PEOPLE.some((re) => re.test(t)) || namesSomeone(t); };

const WHO_TEACHES = new RegExp(`\\bwho\\b(?!\\s+else)[^?.!]*\\b(?:teach(?:es|ing)?|instructor|professor|prof|lecturer|faculty|in\\s+charge)\\b|\\bwho\\s+is\\s+${PROF_REF}\\b|\\bwhat(?:'s|\\s+is)\\s+(?:my|the)\\s+(?:professor|instructor|teacher)(?:'s)?\\s+name\\b`, 'i');
const IDENTITY = new RegExp(`\\b(?:are\\s+you|am\\s+i\\s+(?:talking|speaking|chatting)\\s+(?:to|with))\\s+${PROF_REF}\\b|\\bwho\\s+(?:are\\s+you|am\\s+i\\s+(?:talking|speaking|chatting)\\s+(?:to|with))\\b|\\bare\\s+you\\s+(?:a\\s+)?(?:real|human|a\\s+person|the\\s+(?:professor|instructor|teacher))\\b`, 'i');
const OWN_GRADE = /\b(?:my|i)\b[^?.!]*\b(?:grades?|scores?|gpa|marks?|points)\b|\bhow\s+am\s+i\s+doing\b|\bam\s+i\s+(?:passing|failing)\b|\bdid\s+i\s+pass\b|\bwhat\s+did\s+i\s+get\b/i;
const GRADING_Q = /\b(?:how|what)\b[^?.!]*\b(?:graded|grading|weighted|weights?|worth|percent(?:age)?|breakdown|calculated|computed|counts?\s+for)\b|\bgrading\s+(?:policy|scale|breakdown)\b/i;
const SYLLABUS = /\bsyllab(?:us|i)\b|\bcourse\s+(?:outline|schedule|calendar)\b/i;
const DESCRIPTION = /\bwhat(?:'s|\s+is)\s+(?:this\s+|the\s+|my\s+)?(?:course|class|marketing\s+351|mktg\s+351)\s+about\b|\bcourse\s+description\b|\bwhat\s+(?:do|will)\s+we\s+learn\s+in\s+(?:this|the)\s+(?:course|class)\b/i;
const OFFICE = new RegExp(`\\boffice\\s+hours?\\b|\\b(?:where|when)\\b[^?.!]*\\b(?:see|meet(?:\\s+with)?|visit|find)\\s+${PROF_REF}\\b|\\b${PROF_REF}(?:'s)?\\s+office\\b`, 'i');
const EXAM = /\b(?:midterms?|exams?|finals?|tests?)\b/i;
const EXAM_WHEN = /\b(?:when|what\s+day|which\s+day|what\s+date|date|dates|where|what\s+time|schedule|scheduled|next|coming\s+up|upcoming|is\s+there|are\s+there|how\s+many)\b/i;
const QUIZ = /\bquiz(?:zes)?\b/i;
const QUIZ_WHEN = /\b(?:when|due|deadline|how\s+long|how\s+many|is\s+there|are\s+there|any|posted|open|minutes|attempts?|take|find|where|what)\b/i;
const CANCELLED = /\bcancel(?:l?ed|led|ling|lation)?\b|\bno\s+(?:marketing\s+)?class\b|\b(?:is\s+there|do\s+we\s+(?:still\s+)?have|will\s+there\s+be|are\s+we\s+having|is\s+(?:my|the|our)\s+(?:marketing\s+)?class\s+(?:still\s+)?(?:on|happening|meeting))\s+(?:a\s+)?(?:marketing\s+)?(?:class|lecture)?\b/i;
const NEXT_CLASS = /\b(?:when(?:'s|\s+is)\s+(?:the\s+|our\s+|my\s+)?next\s+(?:marketing\s+)?(?:class|lecture|meeting)|next\s+(?:marketing\s+)?(?:class|lecture)\s+(?:is\s+)?when)\b/i;
const MEETING_Q = /\b(?:when|what\s+time|what\s+days?|which\s+days?|where|what\s+room|which\s+room|what\s+building|how\s+often|what\s+(?:is|are)\s+the\s+(?:class\s+)?(?:times?|days?|hours))\b[^?.!]*\b(?:meet|meets|meeting|class|lecture|held|located|room|marketing\s+351|mktg\s+351)\b|\b(?:class|lecture)\s+(?:time|times|room|location|days)\b/i;
const TERM_Q = /\b(?:when|what\s+day)\b[^?.!]*\b(?:semester|term|quarter|classes)\b[^?.!]*\b(?:start|begin|end|finish|over)\b/i;
const STUDENT_COVERED = /\b(?:what|which)\b[^?.!]*\b(?:topics?|chapters?|units?|lectures?|class(?:es)?)\b[^?.!]*\b(?:next|covering|cover|covered|learning|learn|learned|studying|study|doing|discuss\w*|going\s+over|went\s+over)\b|\bwhat\s+(?:are|will|did|have)\s+we\b[^?.!]*\b(?:cover\w*|learn\w*|stud\w*|discuss\w*|go(?:ing)?\s+over|went\s+over|doing)\b|\bwhat(?:'s|\s+is)\s+next\s+in\s+(?:the\s+)?(?:class|course)\b/i;

// ---- dates ---------------------------------------------------------------------------------------------------
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTH_INDEX = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const realYmd = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? ymdOf(y, m, d) : null; };
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); };
const weekdayOf = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const TERM_YEAR = Number(TERM.start.slice(0, 4));
// The one day a question names, or null: today / tomorrow / a weekday (the coming one, today included) / “Nov 12” / “11/12”.
export function dayAsked(text, now) {
  const t = s(text).toLowerCase();
  const today = pacificDate(now);
  if (/\b(?:today|tonight|this\s+morning)\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  const md = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (md) return realYmd(TERM_YEAR, MONTH_INDEX[md[1]], Number(md[2]));
  const num = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (num) return realYmd(TERM_YEAR, Number(num[1]), Number(num[2]));
  const wd = /\b(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/.exec(t);
  if (wd) {
    const want = WEEKDAYS[wd[2]];
    if (want === undefined) return null;
    let d = wd[1] ? addDays(today, 1) : today;
    for (let i = 0; i < 7 && weekdayOf(d) !== want; i += 1) d = addDays(d, 1);
    return d;
  }
  return null;
}
const monthDayOf = (iso) => { const p = pacificDate(new Date(iso)); const [, m, d] = p.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };
const dueFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dueLabel = (iso) => dueFmt.format(new Date(iso)).replace(/^(\w{3}), (\w{3} \d+), /, '$1, $2, ').replace(' at ', ', ');

// ---- class facts as sentences ------------------------------------------------------------------------------------
const termRange = () => `${TERM.label}, ${dayLabel(TERM.start).split(', ')[1]} – ${dayLabel(TERM.end).split(', ')[1]}`;
export const meetingText = () => `${TITLE} meets ${MEETING.daysLabel}, ${MEETING.timeLabel} in ${MEETING.room} (${termRange()}).`;
const meetingShort = () => `${TITLE} meets ${MEETING.daysLabel}, ${MEETING.timeLabel} in ${MEETING.room}.`;
export const officeHoursText = () => `${PROF}’s office hours are ${OFFICE_HOURS.daysLabel}, ${OFFICE_HOURS.timeLabel} in ${OFFICE_HOURS.room}${OFFICE_HOURS.byAppointment ? ', and by appointment' : ''}.`;
const finalText = () => `${dayLabel(FINAL_EXAM.date)}, ${FINAL_EXAM.timeLabel} in ${FINAL_EXAM.room}`;
export const gradingText = () => `${TITLE} grading:\n${GRADING.map((g) => `- ${g.part}: ${g.percent}%`).join('\n')}`;
const unitTopics = (u) => TOPICS.filter((x) => x.unit === u.unit).map((x) => x.name).join('; ');
export function syllabusText() {
  const units = UNITS.map((u) => `- Unit ${u.unit} (Topics ${u.from}–${u.to}${u.exam ? `, exam ${dayLabel(u.exam)}` : ''}): ${unitTopics(u)}.`).join('\n');
  return [
    `${TITLE} — ${termRange()}. Instructor: ${PROF}. Class: ${MEETING.daysLabel}, ${MEETING.timeLabel}, ${MEETING.room}.`,
    officeHoursText(),
    units,
    `Final exam: ${finalText()}.`,
    `Grading: ${GRADING.map((g) => `${g.part.replace(/\s*\(.*\)$/, '').toLowerCase()} ${g.percent}%`).join(', ')}.`,
    'The full syllabus is in Canvas.',
  ].join('\n\n');
}
function examText(t, now) {
  const today = pacificDate(now);
  const units = UNITS.filter((u) => u.exam);
  const unitWord = /\bunit\s*(\d)\b/i.exec(t);
  if (unitWord) {
    const u = UNITS.find((x) => x.unit === Number(unitWord[1]));
    if (u?.exam) return `The Unit ${u.unit} exam ${u.exam < today ? 'was' : 'is'} on ${dayLabel(u.exam)}.`;
    if (u) return `There’s no separate Unit ${u.unit} exam on the schedule. The final exam is ${finalText()}.`;
  }
  if (/\bfinals?\b/i.test(t) && !/\bmidterms?\b/i.test(t)) return `The ${TITLE} final exam is ${finalText()}.`;
  if (/\bnext\b|\bcoming\s+up\b|\bupcoming\b/i.test(t)) {
    const next = units.find((u) => u.exam >= today);
    return next ? `The next exam is the Unit ${next.unit} exam on ${dayLabel(next.exam)}.` : `The next exam is the final: ${finalText()}.`;
  }
  return `${TITLE} has two unit exams (midterms): Unit 1 on ${dayLabel(units[0].exam)} and Unit 2 on ${dayLabel(units[1].exam)}. The final exam is ${finalText()}.`;
}
// Cancellation notices this student was sent (the code-built “Marketing 351 (…) is cancelled on Thu, Nov 12 and …” text).
const CANCEL_DAY = /\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g;
export function cancelledDays(notices) {
  const out = [];
  for (const n of notices ?? []) {
    if (n?.title !== 'Class cancelled' || typeof n.text !== 'string') continue;
    const sentence = n.text.split(/\n\n/)[0]; // never the faculty member's note under it
    for (const m of sentence.matchAll(CANCEL_DAY)) {
      const ymd = realYmd(TERM_YEAR, MONTHS.indexOf(m[1]) + 1, Number(m[2]));
      if (ymd) out.push({ date: ymd, sent: n.createdAt ? monthDayOf(n.createdAt) : null });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
const isHoliday = (ymd) => HOLIDAYS.includes(ymd);
const cancelledLine = (c) => `Yes — ${PROF} cancelled class on ${dayLabel(c.date)}${c.sent ? ` (sent ${c.sent})` : ''}.`;
function cancelText(t, now, notices) {
  const cancelled = cancelledDays(notices);
  const day = dayAsked(t, now);
  if (!day) {
    const upcoming = cancelled.filter((c) => c.date >= pacificDate(now));
    if (!upcoming.length) return `I don’t see any class cancellations. ${meetingShort()}`;
    return upcoming.map(cancelledLine).join('\n');
  }
  return dayStatus(day, cancelled);
}
function dayStatus(day, cancelled) {
  const hit = cancelled.find((c) => c.date === day);
  if (hit) return cancelledLine(hit);
  if (day < TERM.start || day > TERM.end) return `${dayLabel(day)} is outside the ${TERM.label} term (${termRange().split(', ')[1]}), so ${TITLE} doesn’t meet that day.`;
  if (!MEETING.weekdays.includes(weekdayOf(day))) return `${TITLE} doesn’t meet on ${WEEKDAY_NAMES[weekdayOf(day)]}s — it meets ${MEETING.daysLabel}, ${MEETING.timeLabel} in ${MEETING.room}.`;
  if (isHoliday(day)) return `${dayLabel(day)} is a campus holiday, so there’s no ${TITLE} class that day.`;
  return `I don’t see a cancellation for ${dayLabel(day)}. ${meetingShort()}`;
}
function nextClassText(now, notices) {
  const cancelled = new Set(cancelledDays(notices).map((c) => c.date));
  let d = pacificDate(now);
  if (d < TERM.start) d = TERM.start;
  const skipped = [];
  for (let i = 0; i < 120 && d <= TERM.end; i += 1, d = addDays(d, 1)) {
    if (!meetsOn(d)) continue;
    if (isHoliday(d)) { skipped.push(`${dayLabel(d)} (campus holiday)`); continue; }
    if (cancelled.has(d)) { skipped.push(`${dayLabel(d)} (cancelled)`); continue; }
    return `The next ${TITLE} class is ${dayLabel(d)}, ${MEETING.timeLabel} in ${MEETING.room}.${skipped.length ? ` No class on ${skipped.join(', ')}.` : ''}`;
  }
  return `${TITLE} has no more classes this term (${termRange()}). The final exam is ${finalText()}.`;
}
function quizText(notices) {
  const quizzes = (notices ?? []).filter((n) => n?.quiz).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!quizzes.length) return NO_QUIZ_TEXT;
  const line = (q) => `“${q.title}” is due ${dueLabel(q.dueAt)}: ${q.questions} question${q.questions === 1 ? '' : 's'}, ${q.minutes} minute${q.minutes === 1 ? '' : 's'}, ${q.attempts} attempt${q.attempts === 1 ? '' : 's'}.`;
  const seen = new Set();
  const lines = quizzes.map((n) => n.quiz).filter((q) => !seen.has(q.canvasQuizId) && seen.add(q.canvasQuizId)).slice(0, 3).map(line);
  return `${lines.length === 1 ? lines[0] : lines.map((l) => `- ${l}`).join('\n')}\n\nTake it in Canvas.`;
}
function officeText(notices) {
  const offers = (notices ?? []).filter((n) => n?.meeting?.slots?.length).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const extra = offers.length ? `\n\n${PROF} also offered you these meeting times: ${offers[0].meeting.slots.map((x) => x.label).join('; ')}.` : '';
  return `${officeHoursText()}${extra}`;
}

// ---- the entry point -----------------------------------------------------------------------------------------------
export function courseAnswer(question, { now = new Date(), notices = [] } = {}) {
  const t = s(question);
  if (!t || t.length > 600) return null;
  if (CLASS_MESSAGE.test(t)) return { topic: 'class_message', text: OFFER_CLASS_TEXT, offer: 'class_message' };
  if (ASKS_PROFESSOR.test(t) || (MISSES_CLASS.test(t) && /\bclass|lecture|exam|quiz|midterm|final\b/i.test(t))) return { topic: 'ask_professor', text: OFFER_ASK_TEXT, offer: 'ask' };
  if (IDENTITY.test(t)) return { topic: 'identity', text: IDENTITY_TEXT };
  if (asksAboutClassmates(t)) return { topic: 'classmates', text: PRIVACY_TEXT };
  if (DECISION.test(t)) return { topic: 'decision', text: OFFER_DECISION_TEXT, offer: 'decision' };
  if (WHO_TEACHES.test(t)) return { topic: 'instructor', text: WHO_TEACHES_TEXT };
  if (GRADING_Q.test(t)) return { topic: 'grading', text: gradingText() };
  if (OWN_GRADE.test(t)) return { topic: 'grades', text: GRADES_TEXT };
  if (SYLLABUS.test(t)) return { topic: 'syllabus', text: syllabusText() };
  if (OFFICE.test(t)) return { topic: 'office_hours', text: officeText(notices) };
  if (EXAM.test(t) && EXAM_WHEN.test(t) && !QUIZ.test(t)) return { topic: 'exam', text: examText(t, now) };
  if (QUIZ.test(t) && QUIZ_WHEN.test(t)) return { topic: 'quiz', text: quizText(notices) };
  if (CANCELLED.test(t) && (/\bcancel/i.test(t) || dayAsked(t, now) || /\bno\s+class\b/i.test(t))) return { topic: 'cancellation', text: cancelText(t, now, notices) };
  if (NEXT_CLASS.test(t)) return { topic: 'next_class', text: nextClassText(now, notices) };
  if (TERM_Q.test(t)) return { topic: 'term', text: `${TERM.label} runs ${dayLabel(TERM.start)} – ${dayLabel(TERM.end)}. ${meetingShort()} The final exam is ${finalText()}.` };
  if (MEETING_Q.test(t) && !/\b(?:topic|chapter|unit|cover|learn)\w*\b/i.test(t)) return { topic: 'meeting', text: meetingText() };
  if (asksCovered(t) || STUDENT_COVERED.test(t)) return { topic: 'schedule', text: coveredText(now, { nextOnly: /\bnext\b/i.test(t) && !/\bso\s+far\b/i.test(t) }) };
  if (DESCRIPTION.test(t)) return { topic: 'description', text: COURSE_DESCRIPTION };
  return null;
}

// The class facts the student-path model may use (nothing about other students; the notices come separately).
export function classFactsBlock(now) {
  return [
    meetingText(),
    `Instructor: ${PROF} (refer to them by name, with they/them).`,
    officeHoursText(),
    `Exams: Unit 1 exam ${dayLabel(UNITS[0].exam)}; Unit 2 exam ${dayLabel(UNITS[1].exam)}; final exam ${finalText()}.`,
    gradingText().replace(/\n/g, ' '),
    `Course description: ${COURSE_DESCRIPTION}`,
    `Schedule so far: ${coveredText(now).replace(/\n+/g, ' ')}`,
    'Grades are in Canvas (you cannot see them). The full syllabus is in Canvas.',
  ].join('\n');
}
