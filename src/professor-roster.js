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

// “Notify everyone that …”, “Tell the class: …”, “Let all my students know …”, “Inform the whole class about …”.
const TARGET = String.raw`(?:everyone|everybody|all\s+(?:of\s+)?(?:my|the|our)?\s*students|(?:my|the|our)\s+(?:whole\s+|entire\s+)?class|the\s+whole\s+class)`;
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
  let card = null; // { rosterId, roster, at, onlineIds } — the rows live here and nowhere else
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
    const course = hub?.courses?.find((c) => c.courseId === COURSE.courseId);
    const onlineIds = new Set((course?.enrolled ?? []).filter((s) => s.online).map((s) => s.studentId));
    remember(rows.length, course ? rows.filter((x) => onlineIds.has(x.studentId)).length : undefined); // no Hub view: keep the last known online count
    return { rows, roster: r.reply.roster };
  }
  // A new roster card (the rows stay in this process); highlight = one fictional student id to mark on the card.
  function newCard(roster, highlight = null) {
    card = { rosterId: `ro-${randomUUID().slice(0, 12)}`, roster, at: new Date(now()).toISOString() };
    return { rosterId: card.rosterId, count: roster.rows.length, at: card.at, ...(highlight ? { highlight } : {}) };
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

  // GET /author/roster: the full roster for the Faculty view, with who is online right now (Hub-reported).
  function view(hub, rosterId) {
    if (!card || (rosterId && rosterId !== card.rosterId)) return null;
    const course = hub?.courses?.find((c) => c.courseId === COURSE.courseId);
    const online = (course?.enrolled ?? []).filter((s) => s.online).map((s) => s.studentId);
    if (course) noteCourse(course);
    return { rosterId: card.rosterId, at: card.at, roster: card.roster, online };
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
  const reset = () => { card = null; known = null; tell = null; gen += 1; };
  return { request, fact, view, state, counts, noteCourse, reset, waitingTell, askTell, clearTell, rearmTell };
}
