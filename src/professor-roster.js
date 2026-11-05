// Part 17 (CHRS): the Faculty agent's roster desk. Two things the faculty member can say in the Faculty view chat:
//   * "show my class roster"   -> a signed staff request with service 'chrs' (Professor -> Hub -> CHRS). The roster
//     comes back as rows the Faculty view draws as a card. It is kept in THIS process's memory only (like the quiz
//     draft): the outbox chat keeps "Class roster · 25 students", /author/state carries { rosterId, count, at } and
//     only GET /author/roster serves the rows. After a restart the card says "Ask again to see your roster."
//   * "notify everyone that …" -> the rest of the sentence goes to the whole class as his own message (the Hub
//     addresses it from CHRS's roster). Code reads both; no model decides who is told or what is shown.
// Nothing technical may show: CHRS, MCP, tools and the Hub are never named to the faculty member.
import { randomUUID } from 'node:crypto';
import { COURSE } from './course-pack.js';
import { STAFF_REQUEST_MEDIA_TYPE, ROSTER_FAILED_TEXT, staffRequestFields } from './staff.js';
import { TIMEOUTS } from './timeouts.js';

export const ROSTER_GONE = 'Ask again to see your roster.';
export const NOTIFY_EMPTY = 'What should I tell your class?';
export const tellAboutText = (about) => `What should I tell your class about ${about}?`;
export const TELL_DROPPED = 'Okay, I won’t send anything to your class.';
const TELL_EXPIRES_MS = 15 * 60_000; // like the quiz desk's waiting question
const TELL_DROP = /^\s*(?:never\s?mind|nvm|cancel|forget\s+it|skip\s+it|drop\s+it|no\s+thanks?)\b[\s.!]*$/i;
export const dropsTell = (text) => TELL_DROP.test(String(text ?? ''));
export const rosterCardText = (n) => `Class roster · ${n} ${n === 1 ? 'student' : 'students'}`;
export const sentToAllText = (n) => `Sent to all ${n} students in ${COURSE.title}.`;

// ---- reading the words (code) ------------------------------------------------------------------------------------
const WORD_LIMIT = 12; // a roster request is short; a long message that happens to contain "roster" is something else
const ROSTER_NOUN = /\b(?:roster|class\s+list|student\s+list|list\s+of\s+(?:my\s+|the\s+|our\s+)?students|enrolled\s+students|students\s+(?:list|enrolled))\b/i;
const ROSTER_VERB = /\b(?:show|give|get|pull\s+up|see|display|open|bring\s+up|list|view|check|what(?:['’]s| is))\b/i;
const WHO_IN = /\bwho(?:['’]s|\s+is|\s+are)\s+(?:in|enrolled|taking|signed\s+up|registered)\b/i;
const WHO_MINE = /\bwho\s+are\s+my\s+students\b/i;
// An announcement is never a roster request (“Tell everyone to check the class list”).
const ANNOUNCING = /^\s*(?:please\s+)?(?:notify|tell|let|inform|remind|announce|post|send|ask)\b/i;
export function asksRoster(text) {
  const t = String(text ?? '').trim();
  if (!t || /(^|\s)@\w/.test(t) || ANNOUNCING.test(t)) return false;
  if (t.split(/\s+/).length > WORD_LIMIT) return false;
  if (WHO_IN.test(t) || WHO_MINE.test(t)) return true;
  if (!ROSTER_NOUN.test(t)) return false;
  return ROSTER_VERB.test(t) || t.split(/\s+/).length <= 4; // “roster”, “my class roster?” or a verb + the noun
}

// R3 (round 2): “can you email me the roster?”, “export my roster to Excel”, “print the class list”. Nothing here can email,
// export, download or print a roster: the faculty member gets the card to look at and one plain sentence. Never a post.
export const EXPORT_TEXT = "I can't email or export your roster from here, but here it is to look at.";
const EXPORT_WORDS = /\b(?:e-?mail(?:ed|ing)?|mail|export(?:ed|ing)?|download(?:ed|ing)?|print(?:ed|ing)?|send|sent|forward|share|save|copy|attach|excel|csv|spreadsheet|pdf|xlsx?)\b/i;
export function asksRosterExport(text) {
  const t = String(text ?? '').trim();
  if (!t || /(^|\s)@\w/.test(t) || t.split(/\s+/).length > 16) return false;
  if (!ROSTER_NOUN.test(t) || !EXPORT_WORDS.test(t)) return false;
  return !notifyEveryone(t)?.rest; // “Tell everyone that I'll share the class list Friday” is an announcement
}

// R3 (round 2) generally: a plain message that asks something about the roster or “my students” is a question for the
// assistant, never a post to the class (“can you email me the roster?” once reached all 25). Code reads it; the chat is told.
export const ROSTER_QUESTION_TEXT = "That reads like a question about your roster, so I didn't send it to your class. I can show your roster, count your students, look up one student, or list students by year or major.";
const ABOUT_STUDENTS = /\b(?:my|our)\s+(?:students|class\s+list|roster|class\s+roster|freshm[ae]n|first[-\s]years|sophomores|juniors|seniors|majors)\b/i;
const ASKING = /\?\s*$|^\s*(?:(?:can|could|would|will)\s+you|please\s+(?:show|list|send|e-?mail|give|find|get|tell\s+me|export|print|download)|show|list|give\s+me|find|get\s+me|who|which|what|how\s+many|e-?mail|export|download|print)\b/i;
export function asksAboutRoster(text) {
  const t = String(text ?? '').trim();
  if (!t || /^\s*@/.test(t)) return false;
  return (ROSTER_NOUN.test(t) || ABOUT_STUDENTS.test(t)) && ASKING.test(t);
}

// R4 (round 2): students by academic level and/or major, read by code. “who are my seniors?”, “which students are marketing
// majors?”, “list my juniors” → the roster card with those rows highlighted; “how many seniors are in my class?” → a count.
// The chat says counts only (never who, never a level or a major next to a name). The match is against the roster's own
// Academic Level and Program and Plan.
const LEVEL_WORDS = [
  [/^(?:freshm[ae]n|first[-\s]?years?)$/, 'freshman'],
  [/^sophomores?$/, 'sophomore'],
  [/^juniors?$/, 'junior'],
  [/^seniors?$/, 'senior'],
];
const LEVEL_LABEL = { freshman: ['freshman', 'freshmen'], sophomore: ['sophomore', 'sophomores'], junior: ['junior', 'juniors'], senior: ['senior', 'seniors'] };
// Major words → [what to look for in "Program Plan" (lowercase), how to say it]. Longest phrases first.
const MAJORS = [
  ['public relations', 'public relations', 'Public Relations'], ['information systems', 'info systems', 'Info Systems'], ['info systems', 'info systems', 'Info Systems'],
  ['graphic design', 'graphic design', 'Graphic Design'], ['hospitality', 'hosp', 'Entertainment & Hospitality'], ['entertainment', 'ent & hosp', 'Entertainment & Hospitality'],
  ['marketing', 'marketing', 'Marketing'], ['finance', 'finance', 'Finance'], ['management', 'management', 'Management'], ['accounting', 'accounting', 'Accounting'],
  ['advertising', 'advertising', 'Advertising'], ['communications', 'communications', 'Communications'], ['business', 'business admin', 'Business'], ['pr', 'public relations', 'Public Relations'],
];
const FILTER_FILLER = new Set('who which what whom list show me find highlight give get how many are is am in on of my the our all students student class course section roster do i have there enrolled a an please can could would you tell majors major majoring studying taking any currently right now this term here'.split(' '));
const FILTER_FRAME = /^\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:who|which|list|show|find|highlight|give|get|how\s+many|what)\b/i;
// → null, or { kind: 'filter', level, major: { find, label } | null, count: boolean }
export function rosterFilter(text) {
  const raw = String(text ?? '').trim();
  if (!raw || /(^|\s)@\w/.test(raw) || raw.split(/\s+/).length > 14 || !FILTER_FRAME.test(raw)) return null;
  let t = ` ${raw.toLowerCase().replace(/\bfirst\s+years?\b/g, 'first-year').replace(/[’']s\b/g, '').replace(/\b(?:marketing|mktg)\s*351\b/g, ' ').replace(/[^a-z&\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  let major = null;
  for (const [words, find, label] of MAJORS) {
    // Only a major said as one: “marketing majors”, “marketing students”, “majoring in finance”, “studying finance”.
    const re = new RegExp(String.raw` (?:(?:majoring|major|majors)\s+in\s+|studying\s+)${words}(?= )| ${words}(?=\s+(?:majors?|students?)\b)`);
    if (re.test(t)) { major = { find, label }; t = t.replace(re, ' '); break; }
  }
  let level = null;
  const left = [];
  for (const w of t.split(/\s+/).filter(Boolean)) {
    const hit = LEVEL_WORDS.find(([re]) => re.test(w));
    if (hit) { if (level && level !== hit[1]) return null; level = hit[1]; continue; }
    if (!FILTER_FILLER.has(w)) left.push(w);
  }
  if (left.length || (!level && !major)) return null; // anything else said (“which seniors haven't submitted?”) is not a roster filter
  return { kind: 'filter', level, major, count: /^\s*(?:(?:can|could|would)\s+you\s+(?:tell\s+me\s+)?)?(?:please\s+)?how\s+many\b/i.test(raw) };
}
const filterMatches = (f, rows) => rows.filter((r) => (!f.level || String(r.level ?? '').toLowerCase() === f.level)
  && (!f.major || `${r.program ?? ''} ${r.plan ?? ''}`.toLowerCase().includes(f.major.find)));
// “seniors”, “Marketing majors”, “seniors majoring in Marketing” (n = 1 → singular).
function groupLabel(f, n) {
  const one = n === 1;
  const lv = f.level ? LEVEL_LABEL[f.level][one ? 0 : 1] : null;
  if (lv && f.major) return `${lv} majoring in ${f.major.label}`;
  if (lv) return lv;
  return `${f.major.label} ${one ? 'major' : 'majors'}`;
}
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
export const noneText = (f) => `None of your students are ${groupLabel(f, 2)}.`;
export const filterCountText = (f, n, total) => (n === 0 ? noneText(f) : n === 1 ? `1 of your ${total} students is ${article(groupLabel(f, 1))} ${groupLabel(f, 1)}.` : `${n} of your ${total} students are ${groupLabel(f, n)}.`);
export const filterHighlightText = (f, n) => (n === 0 ? noneText(f) : `${n} ${groupLabel(f, n)} ${n === 1 ? 'is' : 'are'} highlighted on your roster below.`);

// R2 (round 2): @-tags resolve against the class roster: @first, @last, @first-last (case-insensitive), or the student id.
// → { tagged: [{ studentId, name }], ambiguous: [{ tag, names }], unknown: [tag] }. A tag starts the message or follows a
// space and starts with a letter (alex@example.com and “@ 3pm” are not tags); @assistant is not a student.
export const tagsOf = (text) => [...new Set([...String(text ?? '').matchAll(/(?:^|\s)@([A-Za-z][\w-]*)/g)].map((m) => m[1].toLowerCase()))].filter((t) => t !== 'assistant');
const slug = (s) => String(s ?? '').toLowerCase().trim().replace(/[’']/g, '').replace(/\s+/g, '-');
function keysOf(p) {
  const [first, ...rest] = String(p.name ?? '').trim().split(/\s+/);
  const last = rest.join(' ');
  return [p.studentId, slug(first), last && slug(last), last && `${slug(first)}-${slug(last)}`].filter(Boolean).map((k) => k.toLowerCase());
}
export function resolveTags(text, people) {
  const tagged = [];
  const ambiguous = [];
  const unknown = [];
  for (const tag of tagsOf(text)) {
    const hits = [...new Map(people.filter((p) => keysOf(p).includes(tag)).map((p) => [p.studentId, p])).values()];
    if (hits.length === 1) { if (!tagged.some((x) => x.studentId === hits[0].studentId)) tagged.push(hits[0]); } else if (hits.length > 1) ambiguous.push({ tag, names: hits.map((p) => p.name) });
    else unknown.push(tag);
  }
  return { tagged, ambiguous, unknown };
}
// The tag the Faculty view suggests: the first name, or first-last when two students share it.
export function tagFor(p, people) {
  const first = slug(String(p.name ?? '').split(/\s+/)[0]);
  return people.filter((x) => slug(String(x.name ?? '').split(/\s+/)[0]) === first).length > 1 ? keysOf(p)[3] ?? first : first;
}
export const whichStudentText = (names) => `Which student did you mean: ${names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`}? Nothing was sent — tag them by full name, like @${slug(names[0]).replace(/[^a-z0-9-]/g, '')}.`;
export const notInClassText = (tag) => `There's no @${tag} in ${COURSE.title}, so nothing was sent.`;

// “Notify everyone that …”, “Tell the class: …”, “Let all my students know …”, “Inform the whole class about …”, “Tell my students …”.
const TARGET = String.raw`(?:everyone|everybody|all\s+(?:of\s+)?(?:my|the|our)?\s*students|(?:my|the|our)\s+students|(?:my|the|our)\s+(?:whole\s+|entire\s+)?class|the\s+whole\s+class)`;
const NOTIFY = new RegExp(String.raw`^\s*(?:please\s+)?(?:(?:notify|tell|inform)|let)\s+${TARGET}(?:\s+know)?\b[\s,:;\-–—]*(?:(that|of|about)\b[\s,:;\-–—]*)?([\s\S]*)$`, 'i');
const TO_VERB = new RegExp(String.raw`${TARGET}(?:\s+know)?\s+to\s+\S`, 'i'); // “tell everyone to …” (no “that”, no colon)
// → null (not this) or { rest } with rest = the sentence to send. '' when he said nothing to tell, or when he only named a
// subject (“… about the midterm review”, “… of the quiz”): { rest: '', about } — a fragment is never sent, the desk asks what to say.
export function notifyEveryone(text) {
  const m = NOTIFY.exec(String(text ?? ''));
  if (!m) return null;
  const body = m[2].replace(/\s+/g, ' ').trim();
  if (!body) return { rest: '' };
  if (/^(?:of|about)$/i.test(m[1] ?? '')) return { rest: '', about: body.replace(/[.!?\s]+$/, '') };
  // “Tell everyone to read chapter 5” is an instruction: students read “Please read chapter 5.”, never “To read chapter 5.”
  const toVerb = !m[1] && TO_VERB.test(String(text)) ? /^to\s+(\S[\s\S]*)$/i.exec(body) : null;
  if (toVerb) return { rest: /[.!?]$/.test(toVerb[1]) ? `Please ${toVerb[1]}` : `Please ${toVerb[1]}.` };
  const capital = body[0].toUpperCase() + body.slice(1);
  return { rest: /[.!?]$/.test(capital) ? capital : `${capital}.` };
}

// ---- roster facts (code): a count, “is X in my class?”, or one student's email / ID / major / year ------------------------
// Each is answered from a fresh roster lookup (the same signed staff request as “show my roster”), never by a model.
// The chat and the outbox get only the sentences below (a count, names); an email, ID or major is never written into
// a reply: a details question shows the roster card with that student's row highlighted (the card fetch shows it).
export const countText = (n) => `${n} ${n === 1 ? 'student is' : 'students are'} enrolled in ${COURSE.title}.`;
export const memberText = (name) => `Yes — ${name} is enrolled in ${COURSE.title}.`;
export const notOnRosterText = (typed) => `I don't see ${typed} on your ${COURSE.title} roster.`;
export const highlightText = (name) => `${name} is highlighted on your roster below.`;
const listNames = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export const severalText = (typed, names) => `${names.length} students match “${typed}”: ${listNames(names)}.`;
const MY_CLASS = String.raw`(?:my|the|our)\s+(?:class|course|section|roster|class\s+roster|marketing\s+351|mktg\s+351)`;
const COUNT = [
  new RegExp(String.raw`^\s*how\s+many\s+(?:students|people)\s+(?:are\s+)?(?:enrolled|registered|signed\s+up|do\s+i\s+have|(?:there\s+)?(?:are\s+)?(?:there\s+)?(?:in|on)\s+${MY_CLASS})(?:\s+(?:in|on|for)\s+${MY_CLASS})?(?:\s+(?:now|right\s+now|this\s+term))?\s*[?.!]*\s*$`, 'i'),
  /^\s*how\s+(?:big|large)\s+is\s+my\s+class\s*[?.!]*\s*$/i,
  /^\s*(?:what(?:['’]s|\s+is)\s+)?my\s+class\s+size\s*[?.!]*\s*$/i,
];
const MEMBER = new RegExp(String.raw`^\s*(?:is|are)\s+(.+?)\s+(?:(?:enrolled|registered|signed\s+up)(?:\s+(?:in|for)\s+${MY_CLASS})?|(?:in|on|taking)\s+${MY_CLASS})\s*[?.!]*\s*$`, 'i');
const FIELD = String.raw`(?:e-?mail(?:\s+address)?|student\s+(?:id|number)|cwid|id(?:\s+number)?|major|plan|program|(?:academic\s+)?level|year|class\s+standing|pronouns)`;
const DETAIL = [
  new RegExp(String.raw`^\s*(?:what(?:['’]s|\s+is|\s+are)\s+|(?:show|give|get|find)\s+(?:me\s+)?)?(.+?)['’]s?\s+${FIELD}\s*[?.!]*\s*$`, 'i'),
  new RegExp(String.raw`^\s*(?:what(?:['’]s|\s+is|\s+are)\s+|(?:show|give|get|find)\s+(?:me\s+)?)the\s+(?:e-?mail(?:\s+address)?|student\s+(?:id|number)|cwid|major|academic\s+level|pronouns)\s+(?:of|for)\s+(.+?)\s*[?.!]*\s*$`, 'i'),
  /^\s*what\s+(?:year|level|major)\s+is\s+(.+?)(?:\s+in)?\s*[?.!]*\s*$/i,
];
const NOT_A_NAME = /^(?:my|the|our|your|his|her|their|this|that|it|he|she|they|them|everyone|everybody|anyone|anybody|someone|somebody|who|what|class|course|roster|section|marketing|mktg|i|me|you|we|there|here)$/i;
function nameIn(raw) {
  const words = String(raw ?? '').trim().replace(/[?.!,]+$/, '').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  if (!words.every((w) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*$/.test(w))) return null;
  if (words.length === 1 && (NOT_A_NAME.test(words[0]) || /^students?$/.test(words[0]))) return null; // “Student” (capital S) is a surname here
  if (words.some((w) => /^(?:my|the|our|your|this|that|every\w*|any\w*|some\w*|who|what|today|tomorrow|tonight|week|(?:mon|tues|wednes|thurs|fri|satur|sun)day|jan|january|feb|february|mar|march|apr|april|june?|july?|aug|august|sept?|september|oct|october|nov|november|dec|december|quiz|exam|midterm|final|topic|chapter|class|course)$/i.test(w))) return null;
  return words.join(' ');
}
// → null (not a roster fact) or { kind: 'count' } | { kind: 'member', name } | { kind: 'detail', name }. A message with a
// student tag (@sam) is never a roster fact (it is a message to that student).
export function rosterFact(text) {
  const t = String(text ?? '').trim();
  if (!t || /(^|\s)@\w/.test(t) || t.split(/\s+/).length > 14) return null;
  if (COUNT.some((re) => re.test(t))) return { kind: 'count' };
  const member = MEMBER.exec(t);
  if (member) { const name = nameIn(member[1]); return name ? { kind: 'member', name } : null; }
  for (const re of DETAIL) {
    const m = re.exec(t);
    const name = m && nameIn(m[1]);
    if (name) return { kind: 'detail', name };
  }
  return null;
}
// Roster rows carry `name` as "Last,First" (PeopleSoft style). → "First Last".
export const displayName = (row) => { const [last, first] = String(row?.name ?? '').split(','); return first ? `${first.trim()} ${last.trim()}` : String(row?.name ?? '').trim(); };
const titleCase = (s) => s.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
// Full name (either order), else a first or last name alone; several matches are listed by name only.
export function matchStudents(name, rows) {
  const want = name.toLowerCase().replace(/[’]/g, "'").split(/\s+/);
  const parts = (r) => { const [last, first] = String(r.name ?? '').toLowerCase().split(','); return { first: (first ?? '').trim(), last: (last ?? '').trim() }; };
  const full = rows.filter((r) => { const p = parts(r); const j = want.join(' '); return j === `${p.first} ${p.last}` || j === `${p.last} ${p.first}`; });
  if (full.length || want.length !== 1) return full;
  return rows.filter((r) => { const p = parts(r); return p.first === want[0] || p.last === want[0]; });
}

// R5 (round 2): while the HR / class / both question waits, “tell my students the midterm is postponed” or “Let everyone know
// that grades are posted” is a new message — the message follows the opening directly (“that”, “:”, “to <verb>” or a word).
// “Tell the class, and …”, “tell the class please …”, “tell the class too” are still answers to the question.
const NEW_NOTIFY = new RegExp(String.raw`^\s*(?:please\s+)?(?:notify|tell|inform|let)\s+${TARGET}(?:\s+know)?(?:\s*:|\s+that\b|\s+to\s+\w|\s+(?!(?:and|please|pls|too|also|as\s+well|thanks?|thx|thank|only|now|first|instead|then|both|hr|it|this|about|of)\b)[a-z0-9])`, 'i');
export const notifyIsNew = (text) => Boolean(notifyEveryone(text)?.rest) && NEW_NOTIFY.test(String(text ?? ''));

// F6: the reply to “What should I tell your class about X?” goes out as “About X: <reply>.” unless the reply already has
// X's main words (then as he wrote it). X as he wrote it; the reply trimmed, first letter capitalised, a period added.
const SMALL = /^(?:the|a|an|my|our|your|this|that|these|those|of|for|on|in|to|and|or|at|with|about|next|new)$/i;
export function tellText(about, reply) {
  const r = String(reply ?? '').replace(/\s+/g, ' ').trim();
  if (!about) return r;
  const main = String(about).toLowerCase().split(/[^a-z0-9’']+/).filter((w) => w && !SMALL.test(w));
  const has = new Set(r.toLowerCase().split(/[^a-z0-9’']+/).filter(Boolean));
  if (main.length && main.every((w) => has.has(w) || has.has(`${w}s`) || (w.endsWith('s') && has.has(w.slice(0, -1))))) return r;
  const body = r[0].toUpperCase() + r.slice(1);
  return `About ${about}: ${/[.!?]$/.test(body) ? body : `${body}.`}`;
}

// ---- the roster in memory + the staff request --------------------------------------------------------------------
export function createRosterDesk({ hubLink, conversationId, emit = () => {}, now = () => Date.now() }) {
  let card = null; // { rosterId, roster, at, highlight } — the rows (and which ones are highlighted) live here and nowhere else
  let people = null; // [{ studentId, name: "First Last" }] from the last roster lookup — names only, memory only (tags, suggestions)
  let peopleLookup = null; // one lookup at a time for the names
  let tell = null; // { at } — “what should I tell your class about …?” is waiting for his next plain reply
  let gen = 0; // a reset while a roster request is in flight leaves no card
  let known = null; // last known { count, online }: the Hub's counts are empty until it has asked CHRS, and empty again after 60 s

  function remember(count, online) {
    if (Number.isInteger(count) && count >= 0) known = { count, online: Number.isInteger(online) ? online : known?.online ?? 0 };
  }
  // The Hub's course view ({ rosterCount, onlineCount, enrolled[] }) — counts only when it has them.
  function noteCourse(course) {
    if (Number.isInteger(course?.rosterCount)) remember(course.rosterCount, course.onlineCount);
  }
  const state = () => (card ? { rosterId: card.rosterId, count: card.roster.rows.length, at: card.at } : null);
  const counts = () => (known ? { ...known } : null);

  const failed = () => ({ action: 'roster_failed', reply: ROSTER_FAILED_TEXT, classSafe: true, entries: [{ role: 'assistant', text: ROSTER_FAILED_TEXT, action: 'error', failed: true }] });
  const gone = () => ({ action: 'roster_failed', reply: ROSTER_GONE, classSafe: true, entries: [{ role: 'assistant', text: ROSTER_GONE, action: 'error', failed: true }] });
  // One fresh lookup (signed staff request, service 'chrs'). → { rows, roster, course } or a failure result.
  async function lookup({ operationId, hub }) {
    const asked = gen;
    const value = { type: 'staff_request', operationId, conversationId: conversationId(), text: 'Show my class roster.', service: 'chrs' };
    const r = await hubLink.sendSigned(STAFF_REQUEST_MEDIA_TYPE, value, staffRequestFields(value), { timeoutMs: TIMEOUTS.professorStaffMs });
    const rows = r.status === 'ok' ? r.reply?.roster?.rows : null;
    emit('roster_relayed', { status: r.status, rosterCount: Array.isArray(rows) ? rows.length : 0 });
    if (!Array.isArray(rows) || !rows.length || !r.reply.roster.class || typeof r.reply.roster.class !== 'object') return { fail: failed() };
    if (asked !== gen) return { fail: gone() }; // the classroom was reset while CHRS answered
    people = rows.filter((x) => typeof x?.studentId === 'string').map((x) => ({ studentId: x.studentId, name: displayName(x) }));
    const course = hub?.courses?.find((c) => c.courseId === COURSE.courseId);
    const onlineIds = new Set((course?.enrolled ?? []).filter((s) => s.online).map((s) => s.studentId));
    remember(rows.length, course ? rows.filter((x) => onlineIds.has(x.studentId)).length : undefined); // no Hub view: keep the last known online count
    return { rows, roster: r.reply.roster };
  }
  // A new roster card (the rows stay in this process); highlight = one fictional student id to mark on the card.
  // highlight: one student id (a details question: the chat entry may carry it, it names nobody's level or major), or
  // `many`: the ids a level / major filter matched — those stay in THIS process's memory only (GET /author/roster serves
  // them with the rows), so the outbox, the state and the streams never learn who is a senior or a Finance major.
  function newCard(roster, highlight = null, many = null) {
    card = { rosterId: `ro-${randomUUID().slice(0, 12)}`, roster, at: new Date(now()).toISOString(), highlight: many ?? (highlight ? [highlight] : []) };
    return { rosterId: card.rosterId, count: roster.rows.length, at: card.at, ...(highlight ? { highlight } : {}), ...(many ? { highlighted: many.length } : {}) };
  }

  // Faculty chat: "show my roster". Returns { reply, entries, ... } for the Professor agent's staff-style result.
  async function request({ operationId, hub }) {
    const got = await lookup({ operationId, hub });
    if (got.fail) return got.fail;
    const ref = newCard(got.roster);
    const text = rosterCardText(got.rows.length);
    return { action: 'roster', reply: text, classSafe: true, roster: { rosterId: ref.rosterId, count: ref.count }, entries: [{ role: 'assistant', text, action: 'roster', roster: ref }] };
  }

  // Faculty chat: a roster fact (rosterFact above). The reply names a count or students only; a details question shows the
  // roster card with that student's row highlighted (the email / ID / major are on the card, never in the chat text).
  async function fact({ operationId, hub, fact: f }) {
    const got = await lookup({ operationId, hub });
    if (got.fail) return got.fail;
    const say = (text, check) => ({ action: 'roster_fact', check, reply: text, classSafe: true, entries: [{ role: 'assistant', text, action: 'roster_fact' }] });
    if (f.kind === 'count') return say(countText(got.rows.length), 'count');
    const typed = titleCase(f.name);
    const found = matchStudents(f.name, got.rows);
    if (!found.length) return say(notOnRosterText(typed), 'not_on_roster');
    if (found.length > 1) return say(severalText(typed, found.map(displayName)), 'several');
    const who = displayName(found[0]);
    if (f.kind === 'member') return say(memberText(who), 'member');
    const ref = newCard(got.roster, found[0].studentId);
    const text = highlightText(who);
    return { action: 'roster', check: 'detail', reply: text, classSafe: true, roster: { rosterId: ref.rosterId, count: ref.count }, entries: [{ role: 'assistant', text, action: 'roster_fact' }, { role: 'assistant', text: rosterCardText(ref.count), action: 'roster', roster: ref }] };
  }

  // R4: students by level and/or major. A count question answers with the count; otherwise the roster card with those rows
  // highlighted (0 → one sentence, no card). Counts only in the chat.
  async function filter({ operationId, hub, filter: f }) {
    const got = await lookup({ operationId, hub });
    if (got.fail) return got.fail;
    const hits = filterMatches(f, got.rows);
    const say = (text, check) => ({ action: 'roster_fact', check, reply: text, classSafe: true, entries: [{ role: 'assistant', text, action: 'roster_fact' }] });
    if (f.count) return say(filterCountText(f, hits.length, got.rows.length), 'filter_count');
    if (!hits.length) return say(noneText(f), 'filter_none');
    const ref = newCard(got.roster, null, hits.map((r) => r.studentId));
    const text = filterHighlightText(f, hits.length);
    return { action: 'roster', check: 'filter', reply: text, classSafe: true, roster: { rosterId: ref.rosterId, count: ref.count }, entries: [{ role: 'assistant', text, action: 'roster_fact' }, { role: 'assistant', text: rosterCardText(ref.count), action: 'roster', roster: ref }] };
  }

  // R3: “email / export / print my roster” — nothing here can; the card to look at and one plain sentence.
  async function exportAsk({ operationId, hub }) {
    const got = await lookup({ operationId, hub });
    if (got.fail) return got.fail;
    const ref = newCard(got.roster);
    return { action: 'roster', check: 'export', reply: EXPORT_TEXT, classSafe: true, roster: { rosterId: ref.rosterId, count: ref.count }, entries: [{ role: 'assistant', text: EXPORT_TEXT, action: 'roster_fact' }, { role: 'assistant', text: rosterCardText(ref.count), action: 'roster', roster: ref }] };
  }

  // R2: the class's names for @-tags (code) and the Faculty view's suggestions: the last lookup's names, or one fresh lookup
  // (fresh: true always asks again). → [{ studentId, name }] or null when the roster can't be had. Names only.
  async function names({ operationId, hub = null, fresh = false } = {}) {
    if (people && !fresh) return people;
    peopleLookup ??= lookup({ operationId: operationId ?? `names-${randomUUID()}`, hub }).finally(() => { peopleLookup = null; });
    const got = await peopleLookup;
    return got.fail ? null : people;
  }

  // GET /author/roster: the full roster for the Faculty view, with who is online right now (Hub-reported) and the rows
  // to highlight (memory only).
  function view(hub, rosterId) {
    if (!card || (rosterId && rosterId !== card.rosterId)) return null;
    const course = hub?.courses?.find((c) => c.courseId === COURSE.courseId);
    const online = (course?.enrolled ?? []).filter((s) => s.online).map((s) => s.studentId);
    if (course) noteCourse(course);
    return { rosterId: card.rosterId, at: card.at, roster: card.roster, online, highlight: [...card.highlight] };
  }
  const waitingTell = () => { if (tell && now() - tell.at > TELL_EXPIRES_MS) tell = null; return tell; };
  // about = the subject he named (“… about the guest speaker”), or null for a bare “notify everyone” (“What should I tell
  // your class?”): both wait 15 minutes for his next plain reply, which goes to the whole class.
  const askTell = (about = null) => {
    tell = { at: now(), about };
    const text = about ? tellAboutText(about) : NOTIFY_EMPTY;
    return { action: 'clarify', check: about ? 'notify_about' : 'notify_empty', reply: text, classSafe: true, entries: [{ role: 'assistant', text, action: 'clarify' }] };
  };
  const clearTell = () => { tell = null; };
  const rearmTell = (about = null) => { tell = { at: now(), about }; };
  const reset = () => { card = null; known = null; tell = null; people = null; gen += 1; };
  return { request, fact, filter, exportAsk, names, known: () => (people ? [...people] : null), view, state, counts, noteCourse, reset, waitingTell, askTell, clearTell, rearmTell };
}
