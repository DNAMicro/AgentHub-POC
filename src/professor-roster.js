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

  // Faculty chat: "show my roster". Returns { reply, entries, ... } for the Professor agent's staff-style result.
  async function request({ operationId, hub }) {
    const asked = gen;
    const value = { type: 'staff_request', operationId, conversationId: conversationId(), text: 'Show my class roster.', service: 'chrs' };
    const r = await hubLink.sendSigned(STAFF_REQUEST_MEDIA_TYPE, value, staffRequestFields(value), { timeoutMs: TIMEOUTS.professorStaffMs });
    const rows = r.status === 'ok' ? r.reply?.roster?.rows : null;
    emit('roster_relayed', { status: r.status, rosterCount: Array.isArray(rows) ? rows.length : 0 });
    if (!Array.isArray(rows) || !rows.length || !r.reply.roster.class || typeof r.reply.roster.class !== 'object') {
      return { action: 'roster_failed', reply: ROSTER_FAILED_TEXT, classSafe: true, entries: [{ role: 'assistant', text: ROSTER_FAILED_TEXT, action: 'error', failed: true }] };
    }
    if (asked !== gen) return { action: 'roster_failed', reply: ROSTER_GONE, classSafe: true, entries: [{ role: 'assistant', text: ROSTER_GONE, action: 'error', failed: true }] }; // the classroom was reset while CHRS answered
    const course = hub?.courses?.find((c) => c.courseId === COURSE.courseId);
    const onlineIds = new Set((course?.enrolled ?? []).filter((s) => s.online).map((s) => s.studentId));
    card = { rosterId: `ro-${randomUUID().slice(0, 12)}`, roster: r.reply.roster, at: new Date(now()).toISOString() };
    remember(rows.length, course ? rows.filter((x) => onlineIds.has(x.studentId)).length : undefined); // no Hub view: keep the last known online count
    const text = rosterCardText(rows.length);
    return { action: 'roster', reply: text, classSafe: true, roster: { rosterId: card.rosterId, count: rows.length }, entries: [{ role: 'assistant', text, action: 'roster', roster: { rosterId: card.rosterId, count: rows.length, at: card.at } }] };
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
  const askTell = (about) => { tell = { at: now() }; return { action: 'clarify', check: 'notify_about', reply: tellAboutText(about), classSafe: true, entries: [{ role: 'assistant', text: tellAboutText(about), action: 'clarify' }] }; };
  const clearTell = () => { tell = null; };
  const rearmTell = () => { tell = { at: now() }; };
  const reset = () => { card = null; known = null; tell = null; gen += 1; };
  return { request, view, state, counts, noteCourse, reset, waitingTell, askTell, clearTell, rearmTell };
}
