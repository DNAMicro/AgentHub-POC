// Reading a time-off request by CODE: dates and partial days come only from the professor's words,
// never from a model. The absence name is chosen in hr-model.js (and verified there).
import { addDays, hhmm, todayIn } from './forms.js';
import { workdays } from './absence-types.js';
import { chooseAbsence } from './hr-model.js';

// Short forms Mon–Fri are days too ("Mon to Wed"); "sat"/"sun" are not (ordinary words).
const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, tues: 2, thurs: 4, weds: 3, mon: 1, tue: 2, wed: 3, thu: 4, thur: 4, fri: 5 };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const ORD = '(?:st|nd|rd|th)?';
// A bare number in a day list ("Nov 5, 6 and 7") is a day only when nothing after it makes it something else.
const AT_TIME = '\\s*(?:am|pm|a\\.m|p\\.m|hours?|hrs?|h|o\'clock|minutes?|mins?)\\b';
const DAY_END = `(?![:/.]|${AT_TIME}|\\s*(?:days?|weeks?|people|students?|times?|of)\\b)`;
// A joiner and a bare number left over right after a month date ("Nov 5th and the 6th"): a day the
// reading couldn't take. The whole reading is refused (asked) rather than silently shortened.
// A number followed by hours or a time ("Nov 6, 4 hours", "Nov 6, 10 am") is never a day.
const LEFTOVER_DAY = new RegExp(`^\\s*(?:,|and|&|to|through|thru|until|-|–)\\s*(?:and\\s+|&\\s*)?(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b(?![:/]|\\.\\d|${AT_TIME})`, 'i');

// One scan over the words; each alternative names what it found.
const MENTION = new RegExp([
  `\\b(?<!\\bc['’])(?:(?<prefix>this|next|last|coming)\\s+)?(?<weekday>${Object.keys(DAYS).join('|')})\\b`,
  '\\b(?<rel>today|tonight|this\\s+(?:morning|afternoon|evening)|tomorrow|yesterday)\\b', // “this afternoon”, “tonight” = today
  `\\b(?<month>${MONTH_RE})\\.?\\s+(?<day>\\d{1,2})${ORD}\\b(?:\\s*(?:to|through|thru|until|-|–)\\s*(?<day2>\\d{1,2})${ORD}\\b(?![:/]|\\.\\d|${AT_TIME})|(?<more>(?:\\s*(?:,\\s*(?:and\\s+|&\\s*)?|and\\s+|&\\s*)\\d{1,2}${ORD}\\b${DAY_END})+))?(?:,?\\s+(?<year>20\\d\\d))?`,
  '(?<![\\d/])(?<nm>\\d{1,2})/(?<nd>\\d{1,2})(?:/(?<ny>\\d{4}|\\d{2}))?(?![\\d/])',
].join('|'), 'gi');

const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const real = (y, m, d) => {
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s ? s : null;
};
// A month and day with no year: this year, unless that is long past (then the next one).
function withYear(today, m, d, year) {
  const y = year ? Number(year.length === 2 ? `20${year}` : year) : Number(today.slice(0, 4));
  const s = real(y, m, d);
  if (!s || year) return s;
  return s < addDays(today, -180) ? real(y + 1, m, d) : s;
}

const FRACTIONS = new Set(['1/2', '1/3', '2/3', '1/4', '3/4']);
const JOINER = /^\s*(?:,|,?\s*(?:and|&|to|through|thru|until|till|-|–))\s*$/i;
// "Dec 30 - 2": an end day before the start day runs into the next month, never backwards.
function endOfRange(first, month, day2) {
  if (!first) return null;
  const y = Number(first.slice(0, 4));
  const same = real(y, month, day2);
  if (same && same >= first) return same;
  return month === 12 ? real(y + 1, 1, day2) : real(y, month + 1, day2);
}

function weekdayDate(today, target, prefix, after) {
  const p = prefix?.toLowerCase();
  if (p === 'last') return addDays(today, -(((dow(today) - target + 7) % 7) || 7));
  if (p === 'next') return addDays(today, -((dow(today) + 6) % 7) + 7 + ((target + 6) % 7)); // the following Mon-start week
  const from = after ?? today; // a day in a list ("Thursday and Friday") is the next one after the one before it
  return addDays(from, (target - dow(from) + 7) % 7);
}

// "Mon to Wed next week" / "next week, Mon to Wed": "next week" right next to the weekday list makes its first
// bare weekday the one in the following Mon-start week (as "next Mon"); the others follow it as in any list.
const NEXT_WEEK = /\bnext\s+week\b/gi;
const DAY_ONLY_TAIL = new RegExp(`^(?:\\s*(?:${Object.keys(DAYS).join('|')}|and|or|to|through|thru|until|on|-|–)\\b)*\\s*(?:[,;.!?]|$)`, 'i');
// "out Thursday and Friday, next week too": more days in a week the reading can't name → no dates (HR asks).
const MORE_NEXT_WEEK = /\bnext\s+week\s+(?:too|also|as\s+well)\b|\balso\s+next\s+week\b/i;
function nextWeekList(str) {
  const nw = [...str.matchAll(NEXT_WEEK)];
  if (nw.length !== 1) return false;
  const days = [...str.matchAll(MENTION)].filter((m) => m.groups.weekday);
  if (!days.length || days.some((m) => m.groups.prefix)) return false;
  const [first, last] = [days[0], days.at(-1)];
  const at = nw[0].index;
  const lastEnd = last.index + last[0].length;
  // After the list, "next week" counts only when nothing but day words / joiners follow it to the end of its clause
  // ("out Friday, next week I'm back" is about another week: no shift).
  const tail = str.slice(at + nw[0][0].length);
  const afterList = at >= lastEnd && /^\s*,?\s*$/.test(str.slice(lastEnd, at)) && DAY_ONLY_TAIL.test(tail);
  const beforeList = at + nw[0][0].length <= first.index && /^\s*,?\s*(?:on\s+)?$/i.test(str.slice(at + nw[0][0].length, first.index));
  return afterList || beforeList;
}

export function readDates(text, now = new Date()) {
  const today = todayIn(now);
  const str = String(text ?? '');
  const found = [];
  let prevEnd = null;
  if (MORE_NEXT_WEEK.test(str)) return null;
  let nextWeek = nextWeekList(str);
  let lastWeekday = null; // { at, day }: the weekday just read, until the next mention
  for (const m of str.matchAll(MENTION)) {
    const g = m.groups;
    const rest = str.slice(m.index + m[0].length);
    // "1/2 day", "3/4 of the day" are fractions, not dates.
    if (g.nm && (FRACTIONS.has(`${g.nm}/${g.nd}`) || /^\s*(?:of|days?|hours?|hrs?)\b/i.test(rest))) continue;
    // A weekday right before a date names that date ("Friday Nov 6", "Friday, Nov 6"): one day, read from the date;
    // a weekday that disagrees with it ("Friday Nov 7", a Saturday) is asked, never guessed.
    const namesDay = Boolean(lastWeekday && (g.month || g.nm) && /^\s*,?\s*$/.test(str.slice(prevEnd, m.index)));
    // Two or more mentions are one span only when joined as a list or range ("Thursday and Friday", "Nov 10 to Nov 12").
    if (prevEnd !== null && !namesDay && !JOINER.test(str.slice(prevEnd, m.index))) return null;
    prevEnd = m.index + m[0].length;
    let dates = [];
    if (g.weekday) {
      const prefix = g.prefix ?? (nextWeek && !found.length ? 'next' : undefined);
      nextWeek = false;
      dates = [weekdayDate(today, DAYS[g.weekday.toLowerCase()], prefix, prefix ? null : found.at(-1))];
    } else if (g.rel) {
      dates = [addDays(today, { tomorrow: 1, yesterday: -1 }[g.rel.toLowerCase()] ?? 0)];
    } else if (g.month) {
      const mo = MONTHS[g.month.toLowerCase().slice(0, 3)];
      const first = withYear(today, mo, Number(g.day), g.year);
      dates = [first, g.day2 ? endOfRange(first, mo, Number(g.day2)) : null];
      if (g.day2 && first && !dates[1]) return null;
      if (g.more) {
        // "Nov 5, 6 and 7": every listed day, each the day after the one before (a gap is asked, never widened).
        for (const n of g.more.match(/\d{1,2}(?=(?:st|nd|rd|th)?\b)/g).map(Number)) {
          const last = dates.filter(Boolean).at(-1);
          const next = last && endOfRange(last, Number(last.slice(5, 7)), n);
          if (!next || next !== addDays(last, 1)) return null;
          dates.push(next);
        }
      }
      if (LEFTOVER_DAY.test(rest)) return null;
    } else {
      dates = [withYear(today, Number(g.nm), Number(g.nd), g.ny)];
    }
    if (namesDay) {
      if (!dates[0] || dow(dates[0]) !== lastWeekday.day) return null;
      found.splice(lastWeekday.at, 1);
    }
    lastWeekday = g.weekday ? { at: found.length, day: DAYS[g.weekday.toLowerCase()] } : null;
    // A date that isn't real ("Feb 30") is not read at all.
    for (const d of dates) if (d) found.push(d);
    if (dates.some((d, i) => i === 0 && !d)) return null;
  }
  if (!found.length) return null;
  const sorted = [...found].sort();
  return { beginDate: sorted[0], endDate: sorted.at(-1) };
}

const WORKDAY_END = 17 * 60;
const STANDARD_HOURS = 8; // the sample staff member's standard day (peoplesoft-store seed)
// A number of hours: "4 hours", "4 hrs", "3 hr", "6h", "2.5 hours", ".5 hours", "a 4-hour absence". Never part of
// a word or identifier ("B4h"), never the tail of a decimal or a clock ("2.5", "9:30").
const DURATION = /(?<![\w.:/])(\d+(?:\.\d+)?|\.\d+|an|one)\s*-?\s*(?:hours?|hrs?|h)\b/gi; // "an hour" / "one hour" = 1
// Is that number the LENGTH of the absence? Only when the words tie it to the time off:
// "leaving 2 hours early", "coming in 2 hours late" (wins over "in"): only with the professor's OWN leaving or
// arriving verb right before the number, or right after "early/late" ("2 hours early to leave"). Never when the
// clause is negated ("not leaving 2 hours early"), and never when early/late is about something else
// ("2 hours late with the report", "late for class") — those give no partial day (null beats a wrong number).
const EARLY_LATE = /^\s*(?:early|late|earlier|later than usual)\b/i;
const OWN_MOVE = 'leav(?:e|ing)|head(?:ing)?\\s+out|out|go(?:ing)?\\s+home|start(?:ing)?|com(?:e|ing)\\s+in|arriv(?:e|ing)|get(?:ting)?\\s+in';
const MOVE_BEFORE = new RegExp(`\\b(?:${OWN_MOVE})\\s*$`, 'i');
const MOVE_AFTER = new RegExp(`^\\s*(?:early|late|earlier)\\s+(?:to\\s+)?(?:${OWN_MOVE})\\b`, 'i');
const ABOUT_ELSE = new RegExp(`^\\s*(?:early|late|earlier|later than usual)\\s+(?:with|for|on|to|in|at)\\s+(?!(?:${Object.keys(DAYS).join('|')}|today|tomorrow|${MONTH_RE}|\\d|noon|midday|this\\b|next\\b|the\\s+(?:morning|afternoon)|${OWN_MOVE}))`, 'i');
const NEGATED = /\b(?:not|no|never|won['’]?t|don['’]?t|didn['’]?t|can['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t)\b/i;
const clauseBefore = (before) => before.split(/[.,;!?]/).at(-1);
// Who is leaving/arriving? The subject nearest the verb decides: the speaker ("I", "I'm", "I'll", "I'd") or a
// third party ("my kid", "the students", "he", "the shuttle", "Alex is …"). No subject at all (a fragment such as
// "leaving 2 hours early Friday") is the speaker. Anything else unknown is not the speaker (null beats wrong hours).
const SPEAKER = /^(?:i|i['’](?:m|ll|d|ve))$/i;
const THIRD = /^(?:he|she|they|we|you|it|someone|somebody|everyone|everybody|students?|kids?|children|class|shuttle|bus|flight|train|plane|team|husband|wife|son|daughter|partner|mom|dad)$/i;
const DETERMINER = /^(?:my|the|his|her|their|our|your|a|an|this|that|these|those)$/i;
const FILLER = new RegExp(`^(?:${Object.keys(DAYS).join('|')}|today|tomorrow|tonight|${MONTH_RE}|\\d{1,2}(?:st|nd|rd|th)?|on|next|and|then|so|also|just|please|ok|okay|need|needs|to|have|has|will|would|like|be|being|am|going|gonna|want|should|must|can|could|may|might|plan|planning|hoping|hope|off|out|time)$`, 'i');
function speakerMoves(subjectPart) {
  const words = subjectPart.replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const w = words[i];
    if (SPEAKER.test(w)) return true;
    if (THIRD.test(w) || DETERMINER.test(w)) return false;
    if (!FILLER.test(w) && !/^(?:says?|said|told|tells|thinks?|think|wants?|asked|asks)$/i.test(w)) return false; // a name or other noun: someone else
  }
  return true; // no subject: a fragment, the speaker's own
}
// Structural rule (a): after "N hours early/late" only a day/date/time phrase may follow, plus punctuation and
// please/thanks ("Friday", "on Nov 6", "Friday afternoon", "this week"). Anything else — a retraction ("jk",
// "nvm", "on second thought skip it"), a correction ("I mean 3 hours early"), more words — gives no partial day.
// After that day/time, a SHORT reason may follow ("for a doctor appointment", "to pick up my kid", "if that's ok",
// ", dentist"): at most 8 words starting with for/to/because/since/as/if/so, or at most 3 words after a comma —
// and never a retraction, correction or negation ("jk", "nvm", "actually no", "I mean 3 hours early", "or maybe not").
const TIME_TOKEN = `(?:${Object.keys(DAYS).join('|')}|today|tomorrow|tonight|${MONTH_RE}|\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|on|this|next|the|morning|afternoon|evening|week|noon|please|thanks|thank|you)\\b`;
const TIME_PREFIX = new RegExp(`^(?:[\\s.,;:!?()–-]*${TIME_TOKEN})*`, 'i');
const TAKEN_BACK = /\b(?:jk|j\/k|kidding|nvm|never\s*mind|wait|scratch|actually|second\s+thought|skip|disregard|ignore|forget|cancel|maybe|not|no|never|don['’]?t|won['’]?t|i\s+mean|hours?|hrs?)\b/i;
function tailIsTime(tail) {
  const rest = tail.slice(tail.match(TIME_PREFIX)[0].length);
  if (!rest.replace(/[\s.,;:!?()–-]/g, '')) return true; // only a day/time (and please/thanks)
  const commaLed = /^\s*[,;:–-]/.test(rest);
  const reason = rest.replace(/^[\s,;:–-]+/, '').replace(/[\s.!?]+$/, '');
  const words = reason.split(/\s+/).filter(Boolean);
  if (TAKEN_BACK.test(reason) || words.length > 8) return false;
  return /^(?:for|to|because|since|as|if|so)\b/i.test(reason) || (commaLed && words.length <= 3);
}
// Structural rule (b): an earlier clause about someone else ("My kid is sick, leaving 2 hours early") makes a
// subject-less verb clause someone else's too. A clause with "I" in it is the speaker's.
function thirdPartyClause(c) {
  const words = c.replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.some((w) => SPEAKER.test(w))) return false;
  return words.some((w) => THIRD.test(w.replace(/['’]s$/i, ''))) // "Kid's sick"
    || /\b(?:my|the|his|her|their|our|your)\s+\w/i.test(c)
    || /\b(?!(?:i|it|that|this|there|what|which|who)\b)[a-z]+(?:['’]s)?\s+(?:is|are|was|were|has|will)\b/i.test(c); // "Alex is", "alex is", "Kid's" (any case)
}
// "…, no wait never mind", "scratch that": the speaker took it back.
const RETRACTED = /\b(?:never\s*mind|no\s+wait|scratch\s+that|actually\s+no|forget\s+(?:it|that)|cancel\s+that|ignore\s+that)\b/i;
const TIED_AFTER = /^\s*(?:off|out|away|absence|absent|leave|of\s+(?:leave|time off|absence))\b/i; // "4 hours off", "a 4-hour absence"
// …or it stands alone in the request, after a date, a comma or a leave word ("Off Nov 6, 4 hours", "Friday 6h",
// "out for 2 hours", "4 hours on Friday") and nothing after it makes it something else.
const DATE_WORDS = `${Object.keys(DAYS).join('|')}|today|tomorrow|yesterday|\\d{1,2}(?:st|nd|rd|th)?`;
const ALONE_BEFORE = new RegExp(`(?:^|[,;:(–-]|\\b(?:off|out|away|leave|absence|for|${DATE_WORDS}))\\s*(?:a|an|about|around|just|only)?\\s*$`, 'i');
const ALONE_AFTER = new RegExp(`^\\s*(?:$|[,.;:!?)–-]|(?:on|this|next|today|tomorrow|for|${Object.keys(DAYS).join('|')}|${MONTH_RE})\\b)`, 'i');
// Never the length: "in 2 hours" (a relative time), "I have 2 hours of meetings", "12 hours notice".
const NOT_LENGTH_BEFORE = /\b(?:in|within|after|every|have|had|has|spent|spend|takes?|took)\s*(?:a|an|about|around|just|only)?\s*$/i;
const NOT_LENGTH_AFTER = /^\s*(?:of\b(?!\s+(?:leave|time off|absence))|notice\b|later\b(?! than usual)|ago\b|from now\b|before\b|until\b)/i;
// A stated time: "at noon", "at 1pm", "after 2:30", "at 14:00", "at 14h" (24-hour clock: a time of day, never hours).
const TIME = /\b(?:at|after|around|from)\s+(?:(?<noon>noon|midday)|(?<h>\d{1,2})(?::(?<min>\d{2}))?\s*(?:(?<ap>am|pm)|(?<h24>h)\b)?(?!\s*(?:days?|hours?|hrs?|weeks?|people|times?|students?)\b))/i;

function leavingHour(g) {
  const h = Number(g.h);
  const ap = g.ap?.toLowerCase();
  if (ap) return h >= 1 && h <= 12 ? (ap === 'am' ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12) : null;
  if (g.h24) return h <= 23 ? h : null; // "14h": exactly that hour
  if (!g.min) return null; // a bare number needs a colon, am/pm or h to be a time
  if (h > 23) return null;
  if (h === 0 || h >= 13) return h; // "14:00"
  return h >= 7 && h <= 11 ? h : h === 12 ? 12 : h + 12; // without am/pm: 7–11 is morning, 12 and 1–6 are afternoon
}

// Rule A (structural, fails safe). Every hour cue in the message is a candidate: each leaving/arriving clock time
// ("at noon" → hours left until 17:00), each "N hours"/"N-hour", each "N hours early/late", and each
// morning/afternoon/half-day word (4 h). Cues that clearly aren't about the absence are removed: 8 hours or more,
// over 24, "N hours notice", "in N hours", "2 hours of meetings". A cue that is present but can't be read as the
// absence's length (an early/late phrase that isn't the professor's own, a stray "Room 4h") stays and blocks.
// A partial day comes back ONLY when exactly one readable candidate remains and the message has no correction or
// alternative marker anywhere ("or", "make it", "I mean", "actually", "maybe", "jk", "never mind", …). Two cues
// ("leaving 2 hours early Friday afternoon") or a marker → null: a full day the professor edits, never a guess.
const CORRECTION = /\b(?:or|make\s+it|otherwise|unless|instead|i\s+mean|actually|perhaps|maybe|either|jk|nvm|never\s*mind|scratch\s+that|on\s+second\s+thought|cancel|no\s+wait|correction)\b/i;
// After the one hour cue, ANY number or number word (a date excepted) or a correction word means the hours may have
// been changed: no partial day. Before the cue they don't block ("Sorry, I'm sick, leaving at noon today" is 5).
const NUMBER_AFTER = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|noon|midnight|midday|an?\s+hour)\b/i;
const MARKER_AFTER = /\b(?:sorry|moved|oops|make\s+(?:that|it)|no|wait|earlier|later|possibly|maybe|might|probably)\b/i; // after the cue: a retraction or doubt
const DAY_REF = new RegExp(`${MENTION.source}|\\b(?:tonight|this\\s+(?:morning|afternoon|evening))\\b`, 'i');
const DATES = new RegExp(`\\b(?:${MONTH_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d\\d)?\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\bthe\\s+\\d{1,2}(?:st|nd|rd|th)\\b|\\b20\\d\\d\\b`, 'gi');
// A clock time is a cue ONLY right after the professor's own leaving verb (hours = 17:00 − T) or own arrival verb
// (hours = T − 08:00, the time missed before arriving); a day/date may sit between ("leaving Friday at 2pm").
// "meeting at 3pm", "flight is at 3pm", "students leave at noon" are not cues. ("back at 2pm" is not an arrival
// cue: "Out Friday, back at 2pm" stays a full day.) "starting at T" and "from T" are not cues either.
// Any clock time in the message that is not inside the one verb-tied cue BLOCKS ("Leaving at 2pm, no wait, noon",
// "I have a meeting at 3pm I'll miss", "Off Friday starting at 1pm"): no partial day.
const ANY_CLOCK = /\b(?:noon|midday)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?![a-z])|\b\d{1,2}:\d{2}\b/gi;
const WORKDAY_START = 8 * 60;
const BETWEEN = `(?:\\s+(?:on\\s+)?(?:${Object.keys(DAYS).join('|')}|today|tomorrow|(?:${MONTH_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?)){0,2}`;
const CLOCK = TIME.source.replace(/^\\b\(\?:at\|after\|around\|from\)\\s\+/, '');
const LEAVE_AT = new RegExp(`\\b(?<verb>leav(?:e|ing)|head(?:ing)?\\s+out|go(?:ing)?\\s+home|out)${BETWEEN}\\s+(?:at|after|around)\\s+${CLOCK}`, 'gi');
const ARRIVE_AT = new RegExp(`\\b(?<verb>com(?:e|ing)\\s+in|be\\s+in|in|arriv(?:e|ing))${BETWEEN}\\s+(?:at|around)\\s+${CLOCK}`, 'gi');
// Morning/afternoon/half day count only when tied to being off/out/sick/leaving ("off the afternoon", "out this
// morning", "sick yesterday afternoon", "afternoon off", "half day"); "I have class in the morning" is not a cue.
// “half day”, “half-day”, “half a day”, “half of the day”.
const HALF_DAY = 'half(?:[- ]|\\s+a\\s+|\\s+of\\s+(?:the|a|my)\\s+)day';
const DAY_WORDS_BETWEEN = `(?:(?:the|this|tomorrow|yesterday|today|on|${Object.keys(DAYS).join('|')})\\s+)*`;
const DAY_PARTS = new RegExp(`\\b(?:off|out|sick|ill|unwell|leaving|leave|away|absent)\\s+${DAY_WORDS_BETWEEN}(?:morning|afternoon)\\b|\\b(?:morning|afternoon)\\s+off\\b|\\b(?:off|out|away|absent)\\s+(?:on\\s+)?${DAY_WORDS_BETWEEN}(?:(?:${MONTH_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\s+)?(?:in|for|during)\\s+the\\s+(?:morning|afternoon)\\b|\\b(?:off|out|away|absent)\\s+(?:for|during)\\s+the\\s+(?:morning|afternoon)\\b|\\bthe\\s+(?:morning|afternoon)\\s+of\\s+(?:\\w+\\s+){1,3}?off\\b|\\b${HALF_DAY}\\b`, 'gi');
export function readPartial(text) {
  const c = readCue(text);
  if (!c) return null;
  return c.kind === 'arrive' ? { mode: 'start_day_only', hours: c.hours, side: 'arrive' } : { mode: 'start_day_only', hours: c.hours };
}
// A follow-up that only sets the hours on an open card (“make it 4 hours instead”, “change it to 6 hours”, “4 hours
// please”): the edit words around the one hour value are not a correction of it. Anything else (“4 or 5 hours”,
// “make it 4 hours or maybe 6”) still reads as nothing.
const EDIT_LEAD = /^\s*(?:(?:ok(?:ay)?|sorry|actually)[,\s]+)?(?:(?:please|can\s+you|could\s+you)\s+)?(?:(?:make|change|switch|set|put|update)\s+(?:it|that|the\s+hours|my\s+hours)\s+(?:to\s+)?|(?:just|only)\s+)?/i;
const EDIT_TAIL_WORDS = new Set(['instead', 'please', 'then', 'thanks', 'thank', 'you']);
export function readEditHours(text) {
  const t = String(text ?? '').slice(0, 200).replace(/\s+/g, ' ').trim(); // a short edit; collapsed spaces keep the regexes linear
  const words = t.replace(EDIT_LEAD, '').split(' ');
  while (words.length && EDIT_TAIL_WORDS.has(words.at(-1).replace(/[,.!]+$/, '').toLowerCase())) words.pop();
  const core = words.join(' ').replace(/[,.!]+$/, '').trim();
  return core ? readPartial(core) : null;
}
// Rule A's one readable cue: { hours, kind, end } — kind 'leave' (a leaving clock time or "N hours early": the
// leaving time is known, 17:00 − hours), 'arrive', or 'other' (a length with no time: "4 hours off", "afternoon").
function readCue(text) {
  const s = String(text ?? '');
  if (CORRECTION.test(s)) return null;
  const found = []; // hours, or null for a cue that is present but not readable as the absence's length
  const spans = []; // [start, end) of each entry in found
  const cue = (value, m) => { found.push(value); spans.push([m.index, m.index + m[0].length]); };
  const tied = []; // [start, end) of each verb-tied clock cue
  const arrivals = new Set(); // indexes in found that are arrivals (“coming in at 10am”, “2 hours late”)
  const leaves = new Set(); // indexes in found whose leaving time is said (“leaving at noon”, “leaving 2 hours early”)
  for (const [re, toHours] of [[LEAVE_AT, (m) => (WORKDAY_END - m) / 60], [ARRIVE_AT, (m) => (m - WORKDAY_START) / 60]]) {
    for (const t of s.matchAll(re)) {
      tied.push([t.index, t.index + t[0].length]);
      // "students leave at noon": not the professor's own time → a blocking cue (never a value, never ignored).
      const subject = clauseBefore(s.slice(0, t.index)).split(/\b(?:and|but|so|then)\b/i).at(-1);
      if (!speakerMoves(subject)) { cue(null, t); continue; }
      const h = t.groups.noon ? 12 : leavingHour(t.groups);
      if (h === null) continue; // not a time ("at 4 hours", a bare number)
      const hours = toHours(h * 60 + Number(t.groups.min ?? 0));
      if (hours > 0 && hours < STANDARD_HOURS) { (re === ARRIVE_AT ? arrivals : leaves).add(found.length); cue(hours, t); } // otherwise not a cue
    }
  }
  // A clock time outside every verb-tied cue blocks.
  for (const k of s.matchAll(ANY_CLOCK)) if (!tied.some(([a, b]) => k.index >= a && k.index < b)) cue(null, k);
  for (const n of s.matchAll(DURATION)) {
    const hours = /^(?:an|one)$/i.test(n[1]) ? 1 : Number(n[1]);
    if (!(hours > 0 && hours < STANDARD_HOURS)) continue; // 8+ (a full day), over 24 ("48 hours notice"), zero: not partial
    const before = s.slice(0, n.index);
    const after = s.slice(n.index + n[0].length);
    if (EARLY_LATE.test(after)) {
      if (/^\s*late/i.test(after)) arrivals.add(found.length);
      else if (/^\s*(?:early|earlier)\b/i.test(after)) leaves.add(found.length);
      cue(earlyLateHours(before, after) ? hours : null, { index: n.index, 0: n[0] + after.match(EARLY_LATE)[0] }); // the cue includes “early/late”
      continue;
    }
    if (NOT_LENGTH_BEFORE.test(before) || NOT_LENGTH_AFTER.test(after)) continue; // "in 2 hours", "2 hours of meetings", "notice"
    cue(TIED_AFTER.test(after) || (ALONE_BEFORE.test(before) && ALONE_AFTER.test(after)) ? hours : null, n);
  }
  for (const d of s.matchAll(DAY_PARTS)) cue(4, d);
  if (found.length !== 1 || found[0] === null) return null;
  const [start, end] = spans[0];
  if (NUMBER_AFTER.test(s.slice(end).replace(DATES, ' ')) || MARKER_AFTER.test(s.slice(end))) return null;
  // A day named after the cue must belong to the cue's own clause: “leaving at noon, and out tomorrow too” — the
  // hours are today's, tomorrow is another day → no partial day.
  const later = s.slice(end).search(DAY_REF);
  if (later >= 0 && /[,;.!?]|\band\b/i.test(s.slice(end, end + later))) return null;
  // 'arrive': the hours are missed BEFORE arriving (the card says “until 10:00”); otherwise before leaving.
  return { hours: found[0], kind: arrivals.has(0) ? 'arrive' : leaves.has(0) ? 'leave' : 'other', end };
}

// Is "N hours early/late" the professor's own leaving/arriving, with only a day/time (and a short reason) after it?
function earlyLateHours(before, after) {
  const clause = clauseBefore(before);
  const verb = before.match(MOVE_BEFORE);
  const tied = Boolean(verb) || MOVE_AFTER.test(after);
  // The subject: the clause up to the verb (verb before the number) or up to the number ("I need 2 hours early to leave").
  const subjectPart = verb ? clauseBefore(before.slice(0, verb.index)) : clause;
  const tail = after.replace(EARLY_LATE, '').replace(new RegExp(`^\\s*(?:to\\s+)?(?:${OWN_MOVE})\\b`, 'i'), ''); // "2 hours early to leave": the verb is part of the phrase
  const hasI = subjectPart.split(/[^\w’']+/).some((w) => SPEAKER.test(w));
  const earlier = before.slice(0, before.length - clause.length).split(/[.,;:!?]/);
  const someoneElse = !hasI && earlier.some(thirdPartyClause);
  // Negation counts only in the verb's own part of the sentence (“I'm not feeling well and I'm leaving …” is not negated).
  const ownPart = clause.split(/\b(?:and|but|so|then)\b/i).at(-1);
  return tied && tailIsTime(tail) && !someoneElse && !ABOUT_ELSE.test(after) && !NEGATED.test(ownPart) && !RETRACTED.test(after) && speakerMoves(subjectPart) && !/\bevery\s*$/i.test(before);
}

// Does this text say anything about hours at all (a cue, a clock time, a number other than a date, a number word,
// a correction)? Used by follow-ups: if it does but readPartial can't read one clear value, the old hours are cleared.
export function mentionsHours(text) {
  // Only REAL hour signals: a clock time; hour(s)/hr(s); early/late; morning/afternoon/evening/tonight; half day;
  // full/all/whole/entire day; any number or number word that is not part of a date. Correction words alone
  // (“No note needed”, “Make it a personal holiday instead”) are not signals.
  const s = String(text ?? '');
  return new RegExp(ANY_CLOCK.source, 'i').test(s)
    || /\b(?:hours?|hrs?|early|late|earlier|later|morning|afternoon|evening|tonight|(?:full|all|whole|entire)\s+day)\b/i.test(s)
    || new RegExp(`\\b(?:half[- ]?day|${HALF_DAY})\\b`, 'i').test(s)
    || /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)\b/i.test(s.replace(DATES, ' '));
}
// Does the text name a day or date at all (readable or not)?
export const mentionsDay = (text) => new RegExp(DAY_REF.source, 'i').test(String(text ?? ''));

// A change of day said as “X to Y” / “from X to Y” with a change word (change, move, switch, swap, shift, instead, not,
// rather than): never read as a range — the dates are unclear and HR asks. (“Change Friday to Monday” is not Fri–Mon.)
const CHANGE_WORD = /\b(?:change|move|switch|swap|shift|instead|not|rather\s+than)\b/i;
const ONE_DAY = `(?:(?:this|next)\\s+)?(?:${Object.keys(DAYS).join('|')}|today|tomorrow|(?:${MONTH_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}/\\d{1,2})`;
const X_TO_Y = new RegExp(`\\b${ONE_DAY}\\s+(?:to|into|for)\\s+${ONE_DAY}\\b|\\b${ONE_DAY}\\s+instead\\s+of\\s+${ONE_DAY}\\b`, 'i');
// Whole message (ruling): a change word anywhere + an “X to Y” day pattern → unclear (HR asks).
export const changesDay = (text) => CHANGE_WORD.test(String(text ?? '')) && X_TO_Y.test(String(text ?? ''));

// Day references: today (incl. tonight / this morning / this afternoon / this evening), tomorrow, yesterday, weekday
// names and dates — each resolved to its date. "back <day>" is the return day, not an absence day (removed first).
// A return phrase: back / return(ing) [to work] DIRECTLY followed by [on] [next|this] and a day or date (“back Monday”,
// “back on Nov 9”, “back next Thursday”), taken to the end of its clause so extra words (“Friday next week”) are seen.
// “My back hurts and I need Friday off” has no day right after “back”: not a return phrase.
const BACK_PHRASE = new RegExp(`\\b(?:back|return(?:ing)?)(?:\\s+to\\s+work)?\\s+(?:on\\s+)?(?=(?:(?:next|this)\\s+)?(?:${Object.keys(DAYS).join('|')}|today|tomorrow|(?:${MONTH_RE})\\.?\\s+\\d|\\d{1,2}/\\d))[^,.;!?]*`, 'gi');
const returnPhrases = (text) => [...String(text ?? '').matchAll(BACK_PHRASE)];
export const nextWorkday = (date) => { let d = addDays(date, 1); while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1); return d; };
// “back/return <day>” is the return day. The absence dates come from the rest — but only in the one clear shape
// “<one day>, back <the next working day>” (“Out Friday, back Monday”). The back day is resolved for real (“next
// Thursday”, “Monday the 16th” and “Friday next week” — extra words — are not the next working day); any other message
// with a return day gives NO dates, so HR asks — never a wrong date.
function datesWithReturn(text, now) {
  if (changesDay(text)) return { dates: null, unclear: true };
  const backs = returnPhrases(text);
  if (!backs.length) return { dates: readDates(text, now), unclear: false };
  const d = readDates(withoutReturnDay(text), now);
  if (backs.length !== 1 || !d || d.beginDate !== d.endDate) return { dates: null, unclear: true };
  const phrase = backs[0][0].replace(/^\S+(?:\s+to\s+work)?\s*(?:on\s+)?/i, '');
  const mentions = [...phrase.matchAll(MENTION)];
  if (mentions.length !== 1 || phrase.replace(mentions[0][0], '').replace(/[\s,.;!?]+/g, '')) return { dates: null, unclear: true }; // only the day, nothing else
  const g = mentions[0].groups;
  // A bare weekday counts from the absence day (“Out Friday, back Monday” is the Monday after); anything else as said.
  const back = g.weekday && !g.prefix ? addDays(d.beginDate, ((DAYS[g.weekday.toLowerCase()] - dow(d.beginDate) + 7) % 7) || 7) : readDates(mentions[0][0], now)?.beginDate;
  return back === nextWorkday(d.beginDate) ? { dates: d, unclear: false } : { dates: null, unclear: true };
}
const TODAY_WORDS = /\b(?:tonight|this\s+(?:morning|afternoon|evening))\b/i;
export const withoutReturnDay = (text) => { let s = String(text ?? ''); for (const m of returnPhrases(s)) s = s.replace(m[0], ' '); return s; };
// Every day the text names (each mention resolved on its own), after removing a return phrase.
const WEEKDAY_THEN_DATE = new RegExp(`^\\s*,?\\s*(?:(?:${MONTH_RE})\\.?\\s+\\d|\\d{1,2}/\\d)`, 'i');
export function mentionedDays(text, now = new Date()) {
  const s = withoutReturnDay(text);
  const days = new Set();
  if (TODAY_WORDS.test(s)) days.add(todayIn(now));
  for (const m of s.matchAll(MENTION)) {
    // A weekday right before a date names that date (“Tuesday Nov 17”): one day, not two.
    if (m.groups.weekday && WEEKDAY_THEN_DATE.test(s.slice(m.index + m[0].length))) continue;
    const d = readDates(m[0], now);
    if (d) for (let x = d.beginDate; x <= d.endDate; x = addDays(x, 1)) days.add(x);
  }
  return days;
}
export const dayReferences = (text, now = new Date()) => mentionedDays(text, now).size;

// ---- part days over several days (R1-strict: anything unclear → null, full days the professor edits) ----------
const CLAUSE_SPLIT = /[,;.!?]|\b(?:and|but|then)\b/i;
const clausesOf = (text) => {
  const out = [];
  let rest = String(text ?? '');
  let at = 0;
  for (;;) {
    const m = rest.match(CLAUSE_SPLIT);
    if (!m) { out.push({ text: rest, start: at, end: at + rest.length }); return out; }
    out.push({ text: rest.slice(0, m.index), start: at, end: at + m.index });
    at += m.index + m[0].length;
    rest = rest.slice(m.index + m[0].length);
  }
};
// A clause that names the remaining day(s) as away: out/off/away/sick/absent (not negated) or "won't be in".
const AWAY = /\b(?:out|off|away|sick|absent)\b/i;
const WONT_BE_IN = /\bwon['’]?t\s+be\s+in\b/i;
// …and the one away is the SPEAKER: "I'm out", "I'll be off", or no subject ("and out Friday"). "my TA is out",
// "we are off", "the class is off" are someone else (speakerMoves: "we" and any noun are not the speaker).
function awayClause(c) {
  const m = c.match(WONT_BE_IN) ?? c.match(AWAY);
  if (!m) return false;
  if (m[0].match(WONT_BE_IN) ? NEGATED.test(c.replace(WONT_BE_IN, ' ')) : NEGATED.test(c)) return false;
  const subject = c.slice(0, m.index).replace(new RegExp(`\\b(?:${Object.keys(DAYS).join('|')}|today|tomorrow|tonight)\\b`, 'gi'), ' ');
  return speakerMoves(subject.replace(/\bwon['’]?t\b/gi, ' ')) && !/\b(?:is|are|was|were)\b/i.test(subject);
}
// "…and out Friday if my flight is delayed": a condition or doubt about a day → no first-day shape.
const CONDITIONAL = /\b(?:if|unless|in\s+case|depending|might|maybe|possibly|probably)\b/i;
const sameDays = (a, b) => a.length === b.length && a.every((d, i) => d === b[i]);

// "leaving at noon on Thursday and I'll be out Friday": the message's single hour cue sits in the clause that names
// the FIRST day, every other clause has no hour signal, and the clauses naming the other days say the professor is
// away. Returns { partial, cue, dates } or null. `dates` is the range the clauses name (all of them workdays, no gap).
function startDayOnly(text, now, dates) {
  const s = String(text ?? '');
  if (CORRECTION.test(s) || CONDITIONAL.test(s)) return null;
  const clauses = clausesOf(s).filter((c) => c.text.trim());
  const timed = clauses.filter((c) => mentionsHours(c.text));
  if (timed.length !== 1) return null;
  const cueClause = timed[0];
  if (new RegExp(`\\b(?:half[- ]?day|${HALF_DAY})\\b`, 'i').test(cueClause.text)) return null; // "half day Thursday and Friday off": which days? ambiguous
  const cueDays = [...mentionedDays(cueClause.text, now)];
  if (cueDays.length !== 1) return null;
  const named = new Set(cueDays);
  for (const c of clauses) {
    if (c === cueClause) continue;
    const days = mentionedDays(c.text, now);
    if (!days.size) continue;
    if (!awayClause(c.text)) return null;
    for (const d of days) named.add(d);
  }
  const sorted = [...named].sort();
  if (sorted[0] !== cueDays[0] || sorted.length < 2) return null; // the cue's day is the first day
  if (!sameDays(sorted, workdays(sorted[0], sorted.at(-1)))) return null; // every day a workday, no gap
  if (dates && (dates.beginDate !== sorted[0] || dates.endDate !== sorted.at(-1))) return null;
  // Rule A on the words up to the end of the cue's clause (earlier clauses keep their say: "My kid is sick, …").
  const c = readCue(s.slice(0, cueClause.end));
  if (!c) return null;
  const after = s.slice(cueClause.end);
  if (NUMBER_AFTER.test(after.replace(DATES, ' ')) || MARKER_AFTER.test(after)) return null;
  return { cue: c, dates: { beginDate: sorted[0], endDate: sorted.at(-1) } };
}

// "4 hours each day Mon to Wed": only an explicit "N hours each/every/a/per day" (N digits or one–seven, halves
// allowed), 0 < N < 8, nothing else about hours, no correction word, not negated, and only day/leave words before it.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const EACH_DAY = new RegExp(`(?<![\\w.:/])(\\d+(?:\\.5)?|\\.5|${Object.keys(NUM_WORDS).join('|')})\\s*-?\\s*(?:hours?|hrs?)\\s+(?:(?:off|out|away)\\s+)?(?:each|every|a|per)\\s+day\\b`, 'gi');
const EACH_DAY_BEFORE = new RegExp(`^(?:i|i['’]m|i['’]ll|i['’]d|need|will|would|like|want|to|take|taking|be|off|out|away|for|just|only|please|so|also|leave|leaving|absent|time|on|from|the|this|next|week|to|through|thru|until|${Object.keys(DAYS).join('|')}|today|tomorrow|${MONTH_RE}|\\d{1,2}(?:st|nd|rd|th)?)$`, 'i');
const ESTIMATE = /\b(?:about|around|roughly|approximately|approx|maybe|like|or\s+so|ish)\b|~/i;
// After the phrase only days, dates and joiners may follow to the end of the message ("for meetings", "of class",
// "the students will be in lab" → not the absence's length).
const EACH_DAY_AFTER = new RegExp(`^(?:[\\s,.;:!?–-]*(?:${Object.keys(DAYS).join('|')}|today|tomorrow|${MONTH_RE}|\\d{1,2}(?:st|nd|rd|th)?|on|this|next|week|the|and|to|through|thru|until|from|off|out|please|thanks)\\b)*[\\s.,;:!?–-]*$`, 'i');
function allDays(text) {
  const s = String(text ?? '');
  if (CORRECTION.test(s) || CONDITIONAL.test(s) || ESTIMATE.test(s)) return null;
  const hits = [...s.matchAll(EACH_DAY)];
  if (hits.length !== 1) return null;
  const m = hits[0];
  const n = NUM_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
  if (!(n > 0 && n < STANDARD_HOURS)) return null;
  if (mentionsHours(s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length))) return null; // any other hour signal
  const after = s.slice(m.index + m[0].length);
  if (NOT_LENGTH_AFTER.test(after) || !EACH_DAY_AFTER.test(after)) return null;
  const clause = clauseBefore(s.slice(0, m.index)).split(/\b(?:and|but|so|then)\b/i).at(-1);
  if (NEGATED.test(clause)) return null;
  const words = clause.replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.every((w) => EACH_DAY_BEFORE.test(w))) return null; // "I work 4 hours a day": not the absence
  return n;
}

const startAtOf = (cue) => (cue?.kind === 'leave' ? hhmm(WORKDAY_END - Math.round(cue.hours * 60)) : null);

export async function readRequest({ text, now = new Date(), emit }) {
  // “Sick, going home at 1pm, back Wednesday”: Wednesday is the return day — no absence date from it (HR asks).
  const [choice, read] = [await chooseAbsence({ text, emit }), datesWithReturn(text, now)];
  let { dates } = read;
  const { unclear } = read;
  let cue = null;
  let partial = null;
  const single = dates && dates.beginDate === dates.endDate;
  if (single || !dates) {
    // Partial hours on ONE day apply only when the message refers to exactly one day: two or more days ("this
    // afternoon and tomorrow"), none, or a span → full days.
    if (single && dayReferences(text, now) === 1) cue = readCue(text);
    if (cue) partial = cue.kind === 'arrive' ? { mode: 'start_day_only', hours: cue.hours, side: 'arrive' } : { mode: 'start_day_only', hours: cue.hours };
  }
  // Several days: a first-day part day (its clause names the first day, the others say "out"), or the same hours
  // each day ("4 hours each day"). Dates the plain reader could not join ("noon Thursday and out Friday") are
  // taken only in that exact first-day shape.
  if (!partial && !unclear && !returnPhrases(text).length && (!dates || workdays(dates.beginDate, dates.endDate).length >= 2)) {
    const first = startDayOnly(text, now, dates);
    if (first) {
      dates = first.dates;
      cue = first.cue;
      partial = cue.kind === 'arrive' ? { mode: 'start_day_only', hours: cue.hours, side: 'arrive' } : { mode: 'start_day_only', hours: cue.hours };
    } else if (dates) {
      const each = allDays(text);
      if (each !== null) partial = { mode: 'all_days', hours: each };
    }
  }
  const prefill = {
    absenceType: choice.absenceType,
    absenceReason: choice.absenceReason,
    beginDate: dates?.beginDate ?? '',
    endDate: dates?.endDate ?? '',
  };
  const missing = [];
  if (!prefill.absenceType) missing.push('absenceType');
  else if (!prefill.absenceReason) missing.push('absenceReason');
  if (!dates) missing.push('dates');
  return {
    prefill, partial, startAt: partial?.mode === 'start_day_only' ? startAtOf(cue) : null, side: partial?.side ?? null,
    quote: choice.quote, note: choice.note, choices: choice.choices ?? [], missing,
    ...(unclear ? { datesUnclear: true } : {}), ...(choice.error ? { error: choice.error } : {}),
  };
}

// ---- questions about balances and filed requests (read by code; answered as text, nothing is filed) ----
// Narrow on purpose: both fire only for the professor's OWN leave, with an explicit leave word and a question
// shape, and never when anything suggests a leave request, a student, a class matter or a day.
const VETO = [
  /@\w/, // a student tag anywhere
  /\bi\s*(?:['’]m|am)\s+(?:\w+\s+)?(?:sick|ill|unwell|out|off)\b/i, /\bi\s+feel\s+(?:\w+\s+)?(?:sick|ill|unwell)\b/i,
  /\b(?:need|needs|needed|taking|take|took)\s+(?:\w+\s+){0,2}(?:time\s+off|leave|off)\b/i, /\bunpaid\s+leave\b/i,
  /\bleave\s+early\b/i, /\bcan['’]?t\s+make\s+it\b/i, /\bwon['’]?t\s+be\s+in\b/i,
  /\b(?:next|this)\s+week\b/i, /\b(?:today|tomorrow|tonight|yesterday)\b/i,
  /\b(?:semester|students?|class(?:es)?|homework|exam|grading|grades?|lab|assignments?|submit)\b/i,
];
const OWN = /\b(?:my|do\s+i\s+have|have\s+i\s+got)\b/i;
const OWN_LEFT = /\bi\s+have\b[^?]*\bleft\b/i;
const LEAVE_WORD = /\b(?:vacation|sick\s+(?:leave|days?|hours?|time|balances?)|personal\s+holidays?|pto|leave\s+balances?|time[- ]off|leave)\b/i;
const QUANTITY = /\b(?:balances?|how\s+much|how\s+many|remaining|left|do\s+i\s+have)\b/i;
const vetoed = (s) => VETO.some((re) => re.test(s)) || mentionsDay(s);

export function asksBalance(text) {
  const s = String(text ?? '');
  if (vetoed(s) || !(OWN.test(s) || OWN_LEFT.test(s)) || !LEAVE_WORD.test(s) || !QUANTITY.test(s)) return null;
  if (/\bpto\b/i.test(s)) return 'all';
  const named = [['sick', /\bsick\s+(?:leave|days?|hours?|time|balances?)\b/i], ['vacation', /\bvacation\b/i], ['personalHoliday', /\bpersonal\s+holidays?\b/i]].filter(([, re]) => re.test(s)).map(([k]) => k);
  return named.length === 1 ? named[0] : 'all';
}

const KIND = String.raw`(?:time[- ]off|leave|absences?)`;
export function asksRequests(text) {
  const s = String(text ?? '');
  if (vetoed(s)) return false;
  return new RegExp(String.raw`\bmy\s+(?:time[- ]off|leave|absence)\s+requests\b`, 'i').test(s)
    || new RegExp(String.raw`\b(?:what|which)\s+${KIND}\s+(?:have\s+i|did\s+i)\s+(?:filed|requested|submitted|file|request)\b`, 'i').test(s);
}

// An appointment (doctor, dentist, check-up, visit) with no illness word: the card's opening line is the plain
// “Check it and submit.”, not “Feel better soon.” (owner, 2026-11-04). Read by code from the professor's words.
const APPOINTMENT = /\b(?:appointments?|check-?ups?|visit|dentist|dental|orthodontist|physical therapy)\b/i;
const ILLNESS = /\b(?:sick|ill|illness|flu|fever|migraines?|unwell|nauseous|covid|cold|injur\w*|pain|vomit\w*|headaches?|sore|infection|not\s+feeling|under\s+the\s+weather|surgery|chemo\w*|medical|procedure|treatments?|diagnos\w*|cancer|dialysis|radiation|biopsy|pregnan\w*|hospital\w*)\b/i;
export const mentionsIllness = (text) => ILLNESS.test(String(text ?? ''));
export const isAppointment = (text) => APPOINTMENT.test(String(text ?? '')) && !ILLNESS.test(String(text ?? ''));
