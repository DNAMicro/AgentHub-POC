// HR (staff only): the Professor agent's staff desk in the Faculty view chat. Before a message without
// @assistant goes to students, this decides whether it is a request for the professor HIMSELF as staff:
//   * staff_request → HR, over the Hub's signed staff path (Professor → Hub → HR); HR's card comes back.
//   * unsure        → ask the fixed question; the next message answers it (HR / class / both).
//   * class_message → null: the chat continues exactly as today (direct post).
// Nothing is filed or posted on a guess. After HR files a request, the assistant checks the filed dates for
// class days (review #10: the class meets Tue & Thu — src/course-schedule.js MEETING — minus campus holidays, part days
// included) and shows a cancellation PREVIEW card (review #3: the exact text, the recipients, an optional note, Send /
// Don't send); students get the code-built message (“Marketing 351 is cancelled on …”, dates from HR's receipt, never a
// reason — privacy) only on Send or a typed “yes”.
//
// State here is memory only (owner rule): the open card (formRef, its A2UI messages, the hrCard summary),
// the held message awaiting an answer, and the note awaiting “yes”. The chat itself (in the outbox) keeps
// the text of every HR exchange, never the card. A classroom reset (resetStaff) clears it all and starts a
// new HR conversation.
import { TIMEOUTS } from './timeouts.js';
import { randomUUID } from 'node:crypto';
import { CARD_CLOSED, STAFF_ACTION_MEDIA_TYPE, STAFF_REQUEST_MEDIA_TYPE, staffActionFields, staffRequestFields } from './staff.js';
import { ABSENCE_TYPES, shortDate, titleOf, workdays } from './absence-types.js';
import { COURSE } from './course-pack.js';
import { meetsOn } from './course-schedule.js';
import { NOTE_MAX, cancelNoteText, withCancelNote } from './cancel-text.js';
import { classifyStaff } from './professor-model.js';
import { asksBalance, asksRequests, mentionsDay, mentionsHours, mentionsIllness } from './hr-intent.js';
const MENTION_DAYS = /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?\b|\b(?:jan|feb|mar|apr|may|june?|july?|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi;

export const UNSURE_QUESTION = 'Should I file this as time off with HR, tell the class, or both?';
export const HOLDING = "I'm still holding your earlier message — please answer HR, the class, or both. If your reply also had something new, send it again after.";
export const STILL_HOLDING = "I'm still holding your earlier message — answer HR, the class, or both. Your new message wasn't sent; please send it again after.";
export const NOT_SENT = "Your new message wasn't sent; please send it again.";
// One R3 rule: a reply to ANY pending question (the held HR/class/both question, the class-post offer, the note
// offer) that brings NEW content — a day, date, month, number or leave word not in the pending text — is never
// dropped silently: the clear answer is acted on and the professor is told the new part wasn't sent.
const tokens = (text) => new Set((String(text).toLowerCase().match(/[\w’']+/g) ?? []).map((w) => w.replace(/['’]s$/, '')));
const hasNewContent = (pendingText, reply) => {
  const known = tokens(pendingText);
  const words = String(reply).toLowerCase().replace(new RegExp(DROP.source, 'gi'), ' '); // “just leave it” is not a leave request
  return (words.match(NEW_CONTENT) ?? []).some((w) => !known.has(w));
};
// Words that make a reply new content of its own: days, dates, months and leave words.
const NEW_CONTENT = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday|week|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}(?:st|nd|rd|th)?|off|sick|ill|leave|vacation|holiday|doctor|dentist|appointment|funeral|surgery|out)\b/g;
// > the Hub's staff waits (dispatch for a request, staffActionMs for an action), so the Hub's answer arrives first (src/timeouts.js).
const STAFF_TIMEOUT_MS = TIMEOUTS.professorStaffMs;
const HELD_FOR_MS = 15 * 60_000; // an unanswered question or note offer is forgotten after this
// The Hub's card lifetime (same variable and default as src/hub-agent.js): after it, the Hub refuses the
// card, so the Professor stops sending messages to HR as follow-ups and the chat is back to normal.
const CARD_TTL_MS = Number(process.env.HUB_FORM_TTL_MS ?? 2 * 60 * 60 * 1000);
export const NOTE_REASK = 'Should I post that note to the class? Reply yes or no.';
export const NOTE_DECLINED = 'Okay, I won’t post it.';
export const CANCEL_REASK = 'Should I send the cancellation to your students? Reply yes or no.';
export const CANCEL_DECLINED = 'Okay, I won’t send a cancellation. Your class is still on for your students.';
const NOTHING_DONE = 'Okay, nothing was filed or posted.';

let conversationId = randomUUID(); // one HR conversation per classroom (a reset starts a new one)
let openCard = null; // { formRef, a2ui, hrCard, conversationId, at }
let pendingChoice = null; // { text, entryId, at, reasked } — the held message awaiting HR / class / both
let pendingNote = null; // { text, at, reasked, kind?, entryId?, cardId? } — the class cancellation (kind 'cancel') or an offered class post (kind 'post') awaiting “yes”
// Review #3: the cancellation preview card (memory only, closed by a reset). status: open | sending | sent | not_sent.
// { id, status, days, info, count, at, result?, postKey?, problem? } — info = the class's time and room as previewed.
let cancelCard = null;
let staffGen = 0; // bumped by a reset, so a filing in flight doesn't open a card in the new classroom

// The answer to the unsure question (words, read by code): “both” wins; then HR words; then class words.
const BOTH = /\bboth\b/i;
const YES = /^\s*(yes|yeah|yep|sure|ok|okay|please|please do|post it|go ahead)\b/i;
const YES_FILLER = /^(yes|yeah|yep|sure|ok|okay|post|it|please|do|go|ahead|thanks|thank|you)$/i;
const HR_NAMED = /\b(hr|human\s+resources|file|filed|filing)\b/i;
// Any refusal anywhere means it is not a yes (“please don't post it”, “ok, but don't tell them”).
const ANSWER_START = /^\s*(yes|yeah|yep|sure|ok|okay|no|nope|nah|don['’]?t|do not|never)\b/i;
const CANCEL_WORD = /\b(cancel|cancell?ation|cancell?ed)\b/i;
// The cancellation offer's own words: “yes, send the cancellation”, “sure, cancel the class”.
const CANCEL_WORDS = /\b(cancel|cancell?ation|cancell?ed)\b/gi;
// Naming who to tell is still a plain yes (owner, 2026-11-04: “I already said notify and it asked again”).
const CANCEL_FILLER = /^(send|cancel|cancellation|cancelled|canceled|the|class|classes|students|my|them|to|for|me|now|notify|inform|tell|let|know|all|everyone|everybody)$/i;
const NEGATION = /\b(no|nope|nah|not|never|don['’]?t|do not|won['’]?t|skip|cancel|neither)\b/i;
// A short reply right after a question is an answer attempt — never a message for the class.
const SHORT = (text) => text.trim().split(/\s+/).length <= 4;

// ---- an open HR card: is this plain message about the time off, the class, or neither? (read by code) ----
// Leave words (strong): the time off itself, a reason or a relative, or an absence name from the list.
const LEAVE_WORDS = /\b(?:off|out|leave|leaving|sick|ill|illness|unwell|vacation|holiday|absent|absence|pto|bereavement|funeral|died|passed|death|jury|witness|military|appointment|doctor|dentist|hospital|surgery|dock|sabbatical|maternity|paternity|personal|time\s+off|day\s+off|days\s+off|sorry|submit|balance)\b/i;
const RELATIVES = /\b(?:mother|father|mom|dad|mum|grand(?:mother|father|parents?|ma|pa)|brother|sister|wife|husband|spouse|partner|son|daughter|child|children|kids?|aunt|uncle|cousin|niece|nephew|in-?laws?|family|relative)\b/i;
// Edit cues (they name a change to the card): “make it Friday”, “instead”, “change it to …”, “only”, “also”, “not”.
const EDIT_CUE = /\b(?:make\s+(?:it|that)|instead|(?:change|move|switch|swap)\s+(?:it|that|this|the\s+(?:dates?|days?|hours?|times?))|not|only|also|add|never\s?mind|actually|each\s+day|every\s+day|first\s+day|half|full|whole|all\s+day|reason|note)\b/i;
// Class words: the class, the students, or what a class announcement is made of.
const CLASS_WORDS = /\b(?:class(?:es)?|students?|everyone|reminder|remind|read|reading|chapter|homework|quiz|exam|midterm|test|assignment|due|syllabus|lecture|slides|office\s+hours|project|grades?|announce\w*)\b/i;
const FIRST_PERSON_WORDS = /(^|[^\w’'])(?:i|i['’](?:m|ll|ve|d)|im|me|my|myself|we|we['’](?:re|ll|ve)|our|ours|us)(?![\w’'])/i;
const ACK = /^\s*(?:ok(?:ay)?[\s,]+)?(?:thanks?(?:\s+(?:a\s+lot|so\s+much))?|thank\s+you(?:\s+(?:so\s+much|very\s+much))?|thx)[\s.!]*$/i;
// Words that add no content to an answer: what is left (after days, numbers, hours and times) is what the message is about.
const FILLER = /^(?:a|an|the|it|is|i|to|for|please|just|on|at|of|and|that|this|my|me|be|can|you|will|would|from|till|until|through|in|with|by|so|ok|okay|thanks|yes|no|day|days|hour|hours|hrs|morning|afternoon|evening|noon|am|pm|next|this|week|today|tomorrow|yesterday)$/i;
const absenceNameIn = (text) => { const t = String(text).toLowerCase(); return ABSENCE_TYPES.some((a) => t.includes(a.name.toLowerCase())); };
const contentWords = (t) => String(t).replace(new RegExp(MENTION_DAYS.source, 'gi'), ' ').toLowerCase().replace(/[^a-z\s’']/g, ' ').split(/\s+/).filter((w) => w && !FILLER.test(w));
// 'hr' | 'class' (a candidate: staffTurn double-checks) | 'ack' | 'ask'
export function aboutOpenCard(text) {
  const t = String(text ?? '');
  if (ACK.test(t)) return 'ack';
  const classy = CLASS_WORDS.test(t) || /(^|\s)@\w/.test(t);
  const strong = LEAVE_WORDS.test(t) || RELATIVES.test(t) || absenceNameIn(t);
  const edit = EDIT_CUE.test(t);
  // A class message with a day in it (“before Thursday”) is still a class message; with a leave word, or words that
  // edit the card, it could be either: asked, never guessed.
  // Only an announcement with no statement about himself can be a class post (“I'm exhausted”, “my back” need no word list).
  if (classy) return strong || edit || mentionsHours(t) || FIRST_PERSON_WORDS.test(t) ? 'ask' : 'class';
  if (strong || edit) return 'hr';
  // A bare day, number or time answers HR only when almost nothing else is said (“Friday please”, “8 hours”,
  // “just the morning”); a longer announcement with a day in it (“Guest speaker comes Thursday”) is asked about.
  if (mentionsDay(t) || mentionsHours(t)) return contentWords(t).length <= 1 ? 'hr' : 'ask';
  if (SHORT(t)) return 'hr'; // a short answer to HR's own question (“yes”, “no”, “the first day only”)
  return 'ask';
}
// Rule B — reading a reply to the HR / class / both question (see staffTurn). Structural, and fails safe: a reply
// that mentions a choice word or has 8 words or fewer is GUARDED — never posted or classified on its own.
const CHOICE_WORDS = /\b(hr|human\s+resources|file|filed|filing|class|students|them|both|tell|post)\b/i;
const HR_CHOICE = /\b(hr|file|filed|filing)\b/i;
const CLASS_CHOICE = /\b(class|students)\b/i;
const DROP = /\b(leave it|forget it|skip it|drop it|never ?mind|nvm|nothing)\b/i;
// Words that add nothing to a choice (choice words, politeness, small words). Two or more OTHER words (“Class, quiz
// is on Monday”) make the reply more than a choice: asked again, never posted.
const CHOICE_FILLER = /^(hr|file|filed|filing|class|students|everyone|tell|both|them|only|post|send|put|please|pls|thanks|thx|thank|you|a|an|lot|so|much|can|could|would|will|it|that|this|those|these|of|for|me|with|to|and|then|the|just|ok|okay|yes|yeah|yep|sure|go|ahead|all|my|our|i|do|no|not|nope|nah|never|neither|don['’]?t|dont|won['’]?t|leave|forget|skip|drop|nothing|mind|nvm)$/i;
// The choices a reply names. Each part (split at , ; but then) is read alone, so a negation removes only the choice
// in its own part (“HR, not the class” → HR). A negation that names no choice drops everything (“no, not HR” has
// “no” alone). Returns null when the reply drops the hold.
function choicesInSentence(text) {
  const picked = new Set();
  for (const part of text.split(/[,;]|\bbut\b|\bthen\b/i)) {
    const named = [...(BOTH.test(part) ? ['hr', 'class'] : []), ...(HR_CHOICE.test(part) ? ['hr'] : []), ...(CLASS_CHOICE.test(part) ? ['class'] : [])];
    if (NEGATION.test(part) || DROP.test(part)) {
      // A bare refusal (“no”, “not sure”, “just leave it”) drops the hold; a negation inside the professor's own
      // content (“I'm not feeling well …”) is not a refusal of the question.
      const content = part.toLowerCase().replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter((w) => w && !CHOICE_FILLER.test(w));
      if (!named.length) { if (!content.length) return null; continue; }
      continue; // a refused choice: not picked
    }
    for (const c of named) picked.add(c);
    if (named.includes('class') && /\b(too|also|as well)\b/i.test(part)) picked.add('hr'); // “class too”: both
  }
  return picked;
}
// Sentence by sentence: a refusal standing alone in its own sentence (“No. HR please”, “Not sure. HR I guess”) does
// not block a clear HR (or both) pick in another sentence — HR never posts. A class-only pick next to a refusal still
// drops (“No. Class please” never posts the held text).
function choicesIn(text) {
  const sentences = text.split(/[.!]+/).filter((x) => x.trim());
  if (sentences.length < 2) return choicesInSentence(text);
  const picked = new Set();
  let refused = false;
  for (const x of sentences) {
    const p = choicesInSentence(x);
    if (p === null) refused = true;
    else for (const c of p) picked.add(c);
  }
  if (refused && !picked.has('hr')) return null;
  return picked;
}
// A cancellation offer with a preview card waits as long as its card is open (the card is on his screen); everything else
// is forgotten after 15 minutes.
const fresh = (held) => Boolean(held) && (held.cardId ? cancelCard?.id === held.cardId && cancelCard.status === 'open' : Date.now() - held.at < HELD_FOR_MS);
const cardOpen = () => {
  if (openCard && Date.now() - openCard.at > CARD_TTL_MS) openCard = null; // expired at the Hub too
  return openCard;
};

// The filed days the class meets (review #10: Tue & Thu inside the term, src/course-schedule.js MEETING) minus campus
// holidays, part days included. A filing with no class day offers nothing.
export const classDays = ({ beginDate, endDate }) => workdays(beginDate, endDate).filter(meetsOn);
const listOf = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
// Review C12: the class's meeting time and room from the class record CHRS reads from Campus Solutions (daysAndTimes
// "TuTh 10:00AM - 11:15AM", room "Mihaylo Hall 2405") → { time: '10:00–11:15 AM', room } or null (never a guess:
// an unreadable time or a placeholder room is no detail at all).
export function classDetailsOf(klass) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(klass?.daysAndTimes ?? ''));
  const room = typeof klass?.room === 'string' ? klass.room.replace(/\s+/g, ' ').trim() : '';
  if (!m || !room || room.length > 80 || /x{2,}|tba|tbd/i.test(room)) return null;
  const [a, b, ma, mb] = [`${Number(m[1])}:${m[2]}`, `${Number(m[4])}:${m[5]}`, m[3].toUpperCase(), m[6].toUpperCase()];
  return { time: ma === mb ? `${a}–${b} ${mb}` : `${a} ${ma}–${b} ${mb}`, room };
}
const classLabel = (info) => (info ? `${COURSE.title} (${info.time}, ${info.room})` : COURSE.title);
// The student message: fixed words, dates (and since review C12 the class's time and room) only — never why (privacy).
// Review A5: his own note for the students (a makeup plan) as its own paragraph, after the code-built sentence.
export function cancellationText(days, info = null, note = null) {
  if (!days.length) return null;
  const base = `${classLabel(info)} is cancelled on ${listOf(days.map(shortDate))}.`;
  return withCancelNote(base, COURSE.professorName, note);
}
// Review #3: the chat line above the preview card (no yes/no question: the card has the buttons).
export const cancellationLead = (days, info = null) => `You have ${classLabel(info)} on ${listOf(days.map(shortDate))}. Here's the cancellation your students would get — check it before you send it.`;
// Review A5: the note he adds after “yes”. His words, but they go to the students, so a note naming an illness, his leave
// or a relative is never sent without asking (the Part 14 checks); 500 characters at most.
export const NOTE_PRIVATE = 'Your note talks about you, and all your students would read it. Send the cancellation without the note? Reply yes, or write a new note about the class.';
export const NOTE_TOO_LONG = 'Your note is too long — keep it under 500 characters. Reply yes followed by a shorter note, or just yes.';
const YES_START = /^\s*(?:yes|yeah|yep|sure|ok|okay)\b[\s,.!:;—–-]*/i;
// Filler between the yes and the note: “notify them”, “send it”, “please”, “go ahead”, “and add / say / tell them”, “note:”.
const NOTE_FILLER = /^(?:(?:please|pls)(?=[\s,]+(?:go\s+ahead|send|cancel|notify|inform|tell|let|and|also|add|say|note)\b)|go\s+ahead|send\s+(?:it|that|this|the\s+cancellation|them\s+the\s+cancellation)|cancel\s+(?:it|the\s+class|class)|(?:notify|inform|tell|let)\s+(?:them|students|the\s+students|my\s+students|all\s+(?:my\s+)?students|everyone|everybody|the\s+class|my\s+class)(?:\s+know)?|and|also|plus|add(?:\s+(?:this|that|a\s+note|the\s+note|this\s+note))?|say|(?:a\s+|the\s+)?note|with\s+(?:this|a|the)\s+note|that|saying)(?![\w’'])[\s,.!:;—–-]*/i;
// A yes followed by a change or a refusal is not a note (“yes but change Tuesday to Wednesday”, “yes, not Friday”).
const NOT_A_NOTE = /^(?:but|except|only|not|no|nope|don['’]?t|do\s+not|never|instead|wait|actually|hold\s+on|change|move|make\s+it|to\s+hr|hr)\b/i;
export function cancelNoteOf(text, { needYes = true } = {}) {
  let t = String(text ?? '').trim();
  const yes = YES_START.exec(t);
  if (yes) t = t.slice(yes[0].length);
  else if (needYes) return null;
  for (let i = 0; i < 12; i += 1) {
    const f = NOTE_FILLER.exec(t);
    if (!f || !f[0]) break;
    t = t.slice(f[0].length);
  }
  t = t.replace(/\s+/g, ' ').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  if (!t || NOT_A_NOTE.test(t) || t.split(' ').filter((w) => /[\w]/.test(w)).length < 3) return null;
  const toVerb = /^to\s+(\S[\s\S]*)$/i.exec(t); // “tell them to read chapter 6” → “Please read chapter 6.”
  if (toVerb) t = `Please ${toVerb[1]}`;
  t = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
// “we / our” is the class here and “leave from …” is not leave (forClassWords); I / me / my with a leave word is his own.
const notePrivate = (t) => mentionsIllness(t) || CLASS_POST_PRIVATE.test(forClassWords(t)) || RELATIVES.test(t) || (SINGULAR_ME.test(t) && TELL_LEAVE.test(t));
// Live check 2026-11-05: “yes, I have bronchitis so please be patient” went to all 25 students — no word list knows every
// illness, and a classifier can read “please be patient” as a class message. So a note that talks about himself (I, I'm,
// me, my …) is always asked about first; a note about the class (“We'll make it up on Friday”, “Read chapter 6”) is sent.
const noteNeedsAsking = (t) => notePrivate(t) || SINGULAR_ME.test(t);
// “Your time off is recorded. Request 4310288: Bereavement (Grandparent/Great Grandparent), Thu, Nov 5 – Fri, Nov 6,
// 16 hours.” The reason is in parentheses only when it says more than the name (titleOf's subtitle).
export function receiptText(r) {
  const { subtitle } = titleOf(r.absenceType, r.absenceReason);
  const dates = r.beginDate === r.endDate ? shortDate(r.beginDate) : `${shortDate(r.beginDate)} to ${shortDate(r.endDate)}`;
  return `Your time off is recorded. Request ${r.requestId}: ${r.absenceName}${subtitle ? ` (${subtitle})` : ''}, ${dates}, ${r.hours} ${r.hours === 1 ? 'hour' : 'hours'}.`;
}

// The open card as /author/state shows it (the Faculty view renders it); null when none is open.
export const staffView = () => (cardOpen() ? { formRef: openCard.formRef, a2ui: openCard.a2ui, card: openCard.hrCard } : null);

// Part 17 (roster desk): the Faculty agent's other desks need the staff desk's state without owning it.
export const staffConversation = () => conversationId;
// The professor said yes (or “class”), the offer / held message was taken off the desk, and then the post to the class
// failed because the class list wasn't available: nothing went out, so the same offer / question is waiting again
// (a second yes works once the list is back). Only what the result says it took is put back.
export function rearmStaff(rearm) {
  if (rearm?.note && !pendingNote && !pendingChoice) pendingNote = { ...rearm.note, at: Date.now() };
  if (rearm?.choice && !pendingNote && !pendingChoice) pendingChoice = { ...rearm.choice, at: Date.now() };
}
// ---- Review #3: the cancellation preview card -----------------------------------------------------------------------
// One card at a time. The card is what the professor reads before anything goes out: the exact code-built text, who gets
// it (the class size from the fresh class record), an optional note, Send / Don't send. A typed “yes” (with or without a
// note) or “no” in the chat does the same as the buttons. Nothing about a student is on the card.
export const CARD_NOTE_PRIVATE = 'Your note talks about you, and all your students would read it. Change the note or remove it, then press Send again.';
export const CARD_NOTE_TOO_LONG = `Your note is too long — keep it under ${NOTE_MAX} characters.`;
export const CARD_CHANGED = 'The class time or room changed since this preview. Check the new preview, then send it again.';
// The preview was made without the class time and room (they couldn't be read then); now they can be: shown first.
export const CARD_DETAILS_ADDED = 'I can read the class time and room now, so they are in the preview. Check it, then send it again.';
export const cancelCardOf = (id) => (cancelCard && cancelCard.id === id ? cancelCard : null);
// What /author/state carries (pushed to every page): dates, the text without a note, the count — never a student, never a
// note he hasn't sent (a refused note never leaves the request that carried it).
export function cancelCardView() {
  if (!cancelCard) return null;
  const c = cancelCard;
  return {
    id: c.id, status: c.status, days: [...c.days], text: cancellationText(c.days, c.info), count: c.count, professorName: COURSE.professorName, noteMax: NOTE_MAX,
    ...(c.result ? { result: c.result } : {}), ...(c.postKey ? { postKey: c.postKey } : {}), ...(c.problem ? { problem: c.problem } : {}),
  };
}
// His note from the card, checked here (authoritative; the page only previews it): → { note } (null = no note) or
// { code, text } refused — the Part 14 / review A5 rules: a note about himself, an illness, his leave or a relative is
// never sent; 500 characters at most.
export function checkCardNote(raw) {
  const note = cancelNoteText(raw);
  if (!note) return { note: null };
  if (note.length > NOTE_MAX) return { code: 'note_too_long', text: CARD_NOTE_TOO_LONG };
  if (noteNeedsAsking(note)) return { code: 'note_private', text: CARD_NOTE_PRIVATE };
  return { note };
}
// Take an open card for sending (Send or a typed yes): the offer leaves the chat desk while it is sent.
export function beginCancelSend(id) {
  const c = cancelCardOf(id);
  if (!c || c.status !== 'open') return null;
  c.status = 'sending';
  c.problem = null;
  if (pendingNote?.cardId === id) pendingNote = null;
  return { days: [...c.days], info: c.info };
}
// The send came back: sent (the delivery line, the post), or the card is open again with the problem (a later Send or
// “yes” works). info: the class details read at Send when they differ from the preview (the card shows the new text).
export function endCancelSend(id, { sent = false, result = null, postKey = null, problem = null, info } = {}) {
  const c = cancelCardOf(id);
  if (!c) return; // reset meanwhile
  if (sent) { Object.assign(c, { status: 'sent', result, postKey, problem: null }); return; }
  Object.assign(c, { status: 'open', problem, ...(info !== undefined ? { info } : {}) });
  if (!pendingNote && !pendingChoice) pendingNote = { text: cancellationText(c.days), at: Date.now(), kind: 'cancel', days: [...c.days], cardId: c.id };
}
// Don't send (or a typed no): the card closes, “Not sent.”
export function declineCancelCard(id) {
  const c = cancelCardOf(id);
  if (!c || c.status !== 'open') return false;
  c.status = 'not_sent';
  c.problem = null;
  if (pendingNote?.cardId === id) pendingNote = null;
  return true;
}

// A question (HR / class / both) or a note offer is waiting for its answer; a plain reply must reach staffTurn so it
// is read as that answer. A cancellation offer alone does not block the roster desk.
export const staffHolding = () => ({ question: fresh(pendingChoice), offer: fresh(pendingNote) ? pendingNote.kind ?? 'post' : null, noteAsked: Boolean(fresh(pendingNote) && pendingNote.noteAsked) });
// Part 17 final review: everything the roster desk would send to the whole class — the rest of “notify everyone that …” and
// the reply to “What should I tell your class about …?” — gets the same check as a plain class message, so wrapping words
// in the opening never weakens the Part 14 rule (“Notify everyone that Dr. Dabirian is sick today” was posted to 25).
//   * an illness, leave or relative word (with or without I/my) → asked, never posted;
//   * an HR card is open → the open-card rule: a statement about himself or words that edit the card are asked about;
//   * otherwise the staff classifier (mock heuristic, live model) must say class_message; anything else is asked.
// `text` is what would be posted; `held` is the whole message held for the answer (a held “notify everyone …” goes out as
// its stripped text when he answers “class”). Returns the fixed question (holding the message) or null (safe to post).
const CLASS_POST_PRIVATE = /\b(?:leave|sick|ill|illness|unwell|vacation|holiday|absent|absence|pto|bereavement|funeral|died|dying|passed\s+away|death|jury|witness|military|appointment|doctor|dentist|hospital|surgery|sabbatical|maternity|paternity|emergency|time\s+off|days?\s+off|day\s+off)\b/i;
// forClass (F2): the words he gave after asking to tell the class (“notify everyone that …”, the reply to “What should I tell
// your class about …?”). He named the class himself, so “we/our” is the class and “leave” as a verb (“we leave from the
// main entrance”) is not leave; a statement about himself (I, me, my) and leave as a noun (“on leave”) are still asked about.
// Round 2: words that may be his own leave (illness, leave, a relative) — a message with them is never answered as a roster question.
export const privateLeaveWords = (text) => { const t = String(text ?? ''); return mentionsIllness(t) || CLASS_POST_PRIVATE.test(t) || RELATIVES.test(t); };
const SINGULAR_ME = /(^|[^\w’'])(?:i|i['’](?:m|ll|ve|d)|im|me|my|myself)(?![\w’'])/i;
const LEAVE_VERB = /\b(?:leave|leaving)\b(?=\s+(?:from|at|for\s+the|by|together|campus|the\s+(?:room|building|campus|parking))\b)/gi;
const forClassWords = (t) => t.replace(LEAVE_VERB, ' ');
// keepHeld (round 2, R5): a new class message sent while the HR / class / both question already waits. If it would have to be
// asked about too, the waiting question is kept (never replaced or dropped) and he is told the new message wasn't sent.
export async function checkClassPost({ text, held = text, entryId, emit = () => {}, forClass = false, keepHeld = false }) {
  const said = String(text ?? '');
  const t = forClass ? forClassWords(said) : said; // the code checks read this; the classifier reads his own words
  const ask = (decidedBy, extra = {}) => {
    if (keepHeld && fresh(pendingChoice)) {
      emit('staff_decision', { kind: 'unsure', decidedBy, kept: true, ...extra });
      return { action: 'clarify', check: 'staff_or_class', reply: STILL_HOLDING, entries: [{ role: 'assistant', text: STILL_HOLDING, action: 'clarify' }] };
    }
    pendingChoice = { text: String(held ?? t), entryId, at: Date.now() };
    emit('staff_decision', { kind: 'unsure', decidedBy, ...extra });
    return { action: 'clarify', check: 'staff_or_class', reply: UNSURE_QUESTION, entries: [{ role: 'assistant', text: UNSURE_QUESTION, action: 'clarify' }] };
  };
  if (mentionsIllness(t) || CLASS_POST_PRIVATE.test(t) || RELATIVES.test(t) || (FIRST_PERSON_WORDS.test(t) && (LEAVE_WORDS.test(t) || absenceNameIn(t)))) return ask('class_post_guard');
  if (cardOpen() && ((forClass ? SINGULAR_ME : FIRST_PERSON_WORDS).test(t) || (forClass ? tellCardEdit(t) : EDIT_CUE.test(t)))) return ask('open_card_words');
  // Every message now opens a preview card he confirms (review E), so the staff classifier is asked only when the
  // words talk about HIM (I, I'm, me, my …) — a live check sent “message all freshmen about tutoring” and “send a note to
  // students who aren't business majors about the guest speaker” to the HR / class / both question. The code guards
  // above (illness, leave, relatives, first person + leave) still always ask.
  if (!SINGULAR_ME.test(t)) { emit('staff_decision', { kind: 'class_message', decidedBy: 'class_post_no_first_person' }); return null; }
  const c = await classifyStaff({ text: said, emit });
  emit('staff_decision', { kind: c.kind, decidedBy: 'class_post_check', model: c.model ?? null, error: c.error ?? null });
  if (c.kind === 'class_message') return null;
  return ask('class_post_check', { model: c.model ?? null });
}
// Review E: the message preview card's Send. The words he chose for the class already passed checkClassPost when the card
// opened (or he answered “class” for them); his edits on the card did not. Send refuses a message that NOW names an illness,
// leave, a relative, or says he is out / off / away — unless those exact words were already in what passed. Code only: no
// classifier and nothing held (the card shows the refusal and he edits the text).
const PRIVATE_HITS = new RegExp(`${CLASS_POST_PRIVATE.source}|${RELATIVES.source}`, 'gi');
const AWAY = /(^|[^\w’'])(?:i|i['’](?:m|ll|ve|d)|im|me|my|myself)(?![\w’'])[\s\S]{0,40}\b(?:out|off|away|not\s+(?:be\s+)?(?:in|here|there|on\s+campus))\b/i;
export function newPrivateWords(text, baseline = '') {
  const t = forClassWords(String(text ?? ''));
  const base = forClassWords(String(baseline ?? ''));
  const had = new Set([...base.matchAll(PRIVATE_HITS)].map((m) => m[0].toLowerCase()));
  if ([...t.matchAll(PRIVATE_HITS)].some((m) => !had.has(m[0].toLowerCase()))) return true;
  if (mentionsIllness(t) && !mentionsIllness(base)) return true;
  return AWAY.test(t) && !AWAY.test(base);
}
// F2: while “What should I tell your class about …?” waits and an HR card is open, the reply goes to HR only when it is
// clearly a card edit: an edit cue (“make it”, “change”, “instead”, “move it”, “switch”, “use 4 hours”), hours of leave, an
// absence name, or a leave / illness / relative word. A day or a time alone is not enough (“We leave from the main entrance
// at 9 AM on Friday.” is for the class).
const TELL_EDIT = /\b(?:make\s+(?:it|that)|change|changed|instead|move\s+(?:it|that|this)|switch|swap|use\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?))\b/i;
const LEAVE_HOURS = /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b|\b(?:half|full|whole)\s+day\b/i;
const TELL_LEAVE = /\b(?:sick|ill|illness|unwell|vacation|pto|bereavement|funeral|died|passed\s+away|death|jury|witness|military|appointment|doctor|dentist|hospital|surgery|absent|absence|time\s+off|days?\s+off|(?:on|take|taking|sick|family|medical|personal|bereavement|my)\s+leave|leave\s+(?:of\s+absence|request))\b/i;
const TELL_NAMES = ABSENCE_TYPES.map((a) => a.name).filter((n) => !/^(?:other|voting)$/i.test(n));
const namesAbsence = (t) => TELL_NAMES.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`, 'i').test(t));
export const tellCardEdit = (text) => {
  const t = String(text ?? '');
  return TELL_EDIT.test(t) || LEAVE_HOURS.test(t) || namesAbsence(t) || TELL_LEAVE.test(t) || mentionsIllness(t) || RELATIVES.test(t);
};
export const tellGoesToCard = (text) => Boolean(cardOpen()) && !fresh(pendingChoice) && tellCardEdit(text);
// “Thanks” / “thank you” (F4: answered “You're welcome.” without touching a held question).
export const isThanks = (text) => ACK.test(String(text ?? ''));
// A reply that answers a waiting cancellation offer (starts with yes/no, or talks about cancelling): the offer's, not a class message.
export const answersCancelOffer = (text) => fresh(pendingNote) && pendingNote.kind === 'cancel' && (ANSWER_START.test(String(text ?? '')) || CANCEL_WORD.test(String(text ?? '')));

export function resetStaff() {
  staffGen += 1;
  cancelCard = null;
  conversationId = randomUUID();
  openCard = null;
  pendingChoice = null;
  pendingNote = null;
}

// One professor message. Returns null (not a staff turn: carry on as today), { continueWith, entryId }
// (the professor chose “class” for a held message: send THAT message as today), { note } (the professor
// said yes to the note offer: post it), or a staff result { action: 'staff', reply, entries, … }.
// bypass: @assistant messages and replies to one student (the reply icon: an explicit “to this student”,
// accepted by the owner's ruling) are never staff turns — not even while a card is open; they also drop
// any held question or note offer (the professor moved on).
// card: { formRef, formValues } — the browser's open card and its current (checked) values; sent to HR with
// a follow-up only when it is the card that is open here (a stale card's values are never sent).
// The result with the “new message wasn't sent” notice: in the reply text for a clarify, as `notice` otherwise
// (the Professor agent adds it to the chat as its own assistant entry).
function withNotice(r) {
  if (r?.action === 'clarify' && typeof r.reply === 'string') return { ...r, reply: `${r.reply} ${NOT_SENT}`, entries: [{ role: 'assistant', text: `${r.reply} ${NOT_SENT}`, action: 'clarify' }] };
  return { ...r, notice: NOT_SENT };
}

export async function staffTurn({ operationId, text, entryId, hubLink, bypass = false, card = {}, emit = () => {} }) {
  if (bypass) {
    pendingChoice = null;
    // A class cancellation offer survives an aside to the assistant (“@assistant …”) or one student: it waits for
    // its yes or no. Other offers are dropped (the professor moved on).
    if (pendingNote?.kind !== 'cancel') pendingNote = null;
    return null;
  }
  // A question about balances or filed requests is always HR's (code decides, mock and live, no classifier call).
  // It files nothing and posts nothing to students; an open card is not touched (no card values are sent), and a
  // held question or note offer stays held.
  if (asksBalance(text) || asksRequests(text)) return sendToHr({ operationId, text, hubLink, emit, decidedBy: 'info_question' });
  // While a card is open, a plain message goes to HR as a follow-up only when CODE reads it as about this time off
  // (owner, 2026-11-04: a class reminder went to HR and moved the card's dates). A class message with no leave
  // word goes the normal class path only after a second look (below); anything unclear is asked about (the
  // held-message question), never guessed. A reply to that question is read by the held-message rules, and a
  // yes/no to a waiting cancellation offer is the offer's answer first.
  const cancelWaiting = fresh(pendingNote) && pendingNote.kind === 'cancel';
  const answersOffer = cancelWaiting && (ANSWER_START.test(text) || CANCEL_WORD.test(text)); // only a clear yes/no (or talk of cancelling): a short answer to HR (“It was my uncle”) stays HR's
  if (cardOpen() && !fresh(pendingChoice) && !answersOffer) {
    const where = aboutOpenCard(text);
    if (where === 'hr') {
      const formValues = card.formValues && card.formRef === openCard.formRef ? card.formValues : undefined;
      return sendToHr({ operationId, text, hubLink, emit, decidedBy: 'open_card', formValues });
    }
    if (where === 'ack') {
      emit('staff_decision', { kind: 'acknowledged', decidedBy: 'open_card_words' });
      return { action: 'clarify', check: 'ack', reply: "You're welcome.", entries: [{ role: 'assistant', text: "You're welcome.", action: 'clarify' }] };
    }
    // 'class' is only a candidate: it is posted only if the words name no illness or medical reason, the mock
    // heuristic (or, live, the classifier) also says class message. Anything else is asked about.
    if (where === 'class' && !mentionsIllness(text)) {
      const c = await classifyStaff({ text, emit });
      emit('staff_decision', { kind: c.kind, decidedBy: 'open_card_words', model: c.model ?? null, error: c.error ?? null });
      if (c.kind === 'class_message') return null;
    }
    pendingChoice = { text, entryId, at: Date.now() };
    emit('staff_decision', { kind: 'unsure', decidedBy: 'open_card_words' });
    return { action: 'clarify', check: 'staff_or_class', reply: UNSURE_QUESTION, entries: [{ role: 'assistant', text: UNSURE_QUESTION, action: 'clarify' }] };
  }
  const say = (reply, extra = {}) => ({ action: 'clarify', reply, ...extra, entries: [{ role: 'assistant', text: reply, action: 'clarify' }] });

  let note = fresh(pendingNote) ? pendingNote : null;
  pendingNote = null;
  // A class post the roster desk held for the HR / class / both question AFTER a cancellation offer: this reply answers
  // that question first; the offer keeps waiting for its own yes or no.
  if (note?.kind === 'cancel' && fresh(pendingChoice) && pendingChoice.at >= note.at) {
    pendingNote = note;
    note = null;
  }
  // The cancellation offer follows every filed request, so the professor often just carries on (“I also need
  // Monday off”, “I need Friday off”, “Please read chapter 5”). An answer starts with yes or no, talks about
  // cancelling, or is short (4 words or fewer) with no new day or leave word; anything else is a NEW message:
  // handled as usual, and the offer stays open for a later yes or no (nothing reaches students without one).
  // A note he was asked to rewrite (it named his leave): whatever he writes next answers that question.
  const answers = (n) => n.noteAsked || ANSWER_START.test(text) || CANCEL_WORD.test(text) || (SHORT(text) && !hasNewContent(n.text, text));
  if (note?.kind === 'cancel' && !answers(note)) {
    pendingNote = note;
    note = null;
  }
  if (note) {
    const fresh = hasNewContent(note.text, text); // new content: act on the answer, and say it wasn't sent
    const told = (r) => (fresh ? withNotice(r) : r);
    const sayN = (reply, extra) => say(fresh ? `${reply} ${NOT_SENT}` : reply, extra);
    const cancel = note.kind === 'cancel';
    const declined = cancel ? CANCEL_DECLINED : NOTE_DECLINED;
    // A no (or a second unclear reply) closes the preview card too: “Not sent.”
    const decline = () => { if (cancel && note.cardId) declineCancelCard(note.cardId); return sayN(declined, { check: 'note_declined' }); };
    // Review A5: “yes” followed by a note for the students (3+ words once filler is removed) sends the cancellation with
    // it, as its own paragraph. A plain yes (“yes”, “yes notify students”, “yes please send it”) is a plain yes, at once.
    // After “Your note says something about you …” any new note (with or without a yes) is read the same way.
    if (cancel) {
      const plainYes = YES.test(text) && text.toLowerCase().replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter(Boolean).every((w) => YES_FILLER.test(w) || CANCEL_FILLER.test(w));
      let studentNote = plainYes ? null : cancelNoteOf(text, { needYes: !note.noteAsked });
      // A private “note” that also brings a new day or leave word (“Yes please. Also I need Monday off, my son is sick”) is
      // a new request (it names a day), not a note: the R3 rule below answers the yes and says the new part wasn't sent.
      if (studentNote && !note.noteAsked && notePrivate(studentNote) && fresh && mentionsDay(studentNote)) studentNote = null;
      if (studentNote) {
        if (studentNote.length > NOTE_MAX) {
          pendingNote = { ...note, at: Date.now() };
          return say(NOTE_TOO_LONG, { check: 'note_too_long' });
        }
        if (noteNeedsAsking(studentNote)) {
          pendingNote = { ...note, at: Date.now(), noteAsked: true };
          return say(NOTE_PRIVATE, { check: 'note_private' });
        }
        return { note: note.text, days: note.days ?? null, studentNote, rearm: { note }, cardId: note.cardId ?? null };
      }
      if (note.noteAsked && plainYes) return { note: note.text, days: note.days ?? null, rearm: { note: { ...note, noteAsked: false } }, cardId: note.cardId ?? null };
    }
    // “cancel” is the offer's own word (“yes, cancel it”): not a refusal here.
    const refusal = cancel ? String(text).replace(CANCEL_WORDS, ' ') : text;
    if (NEGATION.test(refusal)) return decline();
    // A reply that names HR is never a yes to posting (“yes, to HR”, “Please send it to HR”).
    if (HR_NAMED.test(text)) return decline();
    // A yes counts only when it is nothing but yes words (“yes”, “ok, post it”, “yes please, go ahead”). With new
    // content, the first sentence decides (“Yes please. Also I need Monday off” is a yes); a yes with other words in
    // the same sentence (“yes but change Tuesday to Wednesday”, “Yes, and I also need Tuesday off”) is asked again.
    const decides = fresh ? text.split(/[.!?]/)[0] : text;
    const pureYes = YES.test(decides) && decides.toLowerCase().replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter(Boolean).every((w) => YES_FILLER.test(w) || (cancel && CANCEL_FILLER.test(w)));
    const reaskNote = () => {
      if (note.reasked) return decline();
      pendingNote = { ...note, reasked: true };
      return sayN(cancel ? CANCEL_REASK : NOTE_REASK, { check: 'note_reask' });
    };
    if (YES.test(text) && !pureYes) return reaskNote();
    // A long class message offered while a message was held (“Should I post this to the class: …?”) goes out as
    // the professor's own message (today's path); the neutral HR note goes out as the note.
    if (pureYes) return told(note.kind === 'post' ? { continueWith: note.text, entryId: note.entryId, rearm: { note } } : { note: note.text, days: note.days ?? null, rearm: { note }, cardId: note.cardId ?? null });
    // Not a clear yes or no: ask once more; a second unclear reply declines. Never posted either way. A reply with
    // new content is an answer attempt too (never dropped silently).
    if (SHORT(text) || fresh) return reaskNote();
    // A longer message: a new message (the note offer is dropped).
  }

  const held = fresh(pendingChoice) ? pendingChoice : null;
  pendingChoice = null;
  let c = null; // the classifier's reading of THIS message (a long reply to the question is classified first)
  if (held) {
    // Rule B. A reply of 8 words or fewer is never posted or classified on its own: negation anywhere → drop
    // (“HR, not the class”: the negation only removes the class); exactly one clear choice (HR, class, or both) →
    // act on the HELD message; otherwise ask once more, then drop.
    // A reply of more than 8 words: a pure choice (“please file it with HR for me, thanks a lot”) acts the same
    // way, without a model call; anything else is classified on its own FIRST — a staff request goes to HR with
    // its OWN words (negations like “not feeling well” don't drop it), a class message that mentions
    // HR/file/class/students/them/both/tell is asked about once more (never posted), a class message without them
    // posts as today, and “unsure” asks the question about THIS message. The held message is dropped unless re-asked.
    const words = text.toLowerCase().replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter(Boolean);
    const picked = choicesIn(text);
    const negated = NEGATION.test(text) || DROP.test(text);
    const extra = words.filter((w) => !CHOICE_FILLER.test(w)).length;
    const fresh = hasNewContent(held.text, text);
    const actOnChoice = async () => {
      const both = picked.has('hr') && picked.has('class');
      if (picked.has('hr')) {
        const r = await sendToHr({ operationId, text: held.text, hubLink, emit, decidedBy: both ? 'both' : 'professor_choice' }); // the class hears only through the cancellation offer
        return fresh ? withNotice(r) : r;
      }
      emit('staff_decision', { kind: 'class_message', decidedBy: 'professor_choice' });
      const r = { continueWith: held.text, entryId: held.entryId, rearm: { choice: held } };
      return fresh ? withNotice(r) : r;
    };
    // Round 2 (R5): whenever the reply that drops the question was itself a message (new content, or two or more words that
    // are not a choice or a refusal: “The library closes early today”), he is told it wasn't sent — always, not only for days.
    const dropped = () => say(fresh || extra >= 2 ? `${NOTHING_DONE} ${NOT_SENT}` : NOTHING_DONE, { check: 'staff_or_class_dropped' });
    const reask = () => {
      if (held.reasked) return dropped();
      pendingChoice = { ...held, reasked: true };
      // A re-asked reply that brings NEW content was not sent: say so, so the professor knows to send it again.
      return say(fresh ? STILL_HOLDING : UNSURE_QUESTION, { check: 'staff_or_class' });
    };
    // A question back (“HR or class?”) is always asked again.
    if (/\?\s*$/.test(text)) return reask();
    // A reply with ANY choice word is an answer to the question — never classified on its own, never posted or filed
    // except on a clear choice: (a) its FIRST clause (up to . , ; — or “and”) is a pure HR or both choice (one other
    // word allowed, e.g. “HR I guess”, “HR for Monday”) and no later clause picks the class instead; or (b) the whole
    // reply is a pure class choice (no other word at all: “class only”, “tell the class please, and thanks so much”).
    // Anything else (“Just tell the class, HR already knows I'm out Friday”, “Class please. Also I'm out next Monday …”)
    // is held with the notice. A negation that refuses everything drops the hold (“no, not HR”, “don't file it”).
    if (CHOICE_WORDS.test(text)) {
      if (picked === null || (negated && !picked.size)) return dropped();
      if (picked.size === 1 && picked.has('class') && extra === 0 && !negated) return actOnChoice(); // (b) — no negation anywhere (“Not HR. Class please” is held)
      // The first clause, after any leading sentence that is only a refusal (“No. HR please”).
      const sentences = text.split(/(?<=[.!])/);
      while (sentences.length > 1 && choicesInSentence(sentences[0].replace(/[.!]+$/, '')) === null) sentences.shift();
      const rest0 = sentences.join('');
      const first = rest0.split(/[.,;—–]|\band\b/i)[0];
      const firstPicked = choicesIn(first);
      const firstExtra = first.toLowerCase().replace(/[^\w’'\s]/g, ' ').split(/\s+/).filter((w) => w && !CHOICE_FILLER.test(w)).length;
      const laterClass = (choicesIn(rest0.slice(first.length)) ?? new Set()).has('class');
      if (firstPicked?.has('hr') && firstExtra <= 1 && (firstPicked.has('class') || !laterClass)) { // (a)
        picked.clear();
        for (const x of firstPicked) picked.add(x);
        return actOnChoice();
      }
      // (c): one neutral holding text, true in every case (it may or may not have had something new).
      if (held.reasked) return dropped();
      pendingChoice = { ...held, reasked: true };
      return say(HOLDING, { check: 'staff_or_class' });
    }
    // No choice word: 8 words or fewer is not an answer — a negation drops the hold, anything else is asked again.
    if (words.length <= 8) return negated ? dropped() : reask();
    // More than 8 words and no choice word: classified on its own (a new message; the held one is dropped).
    c = await classifyStaff({ text, emit });
    if (c.kind === 'class_message') {
      emit('staff_decision', { kind: c.kind, decidedBy: 'classifier', model: c.model ?? null, error: c.error ?? null });
      // Nothing goes to students on one classifier verdict while a message is held: offer it, post only on a yes.
      pendingNote = { text, at: Date.now(), kind: 'post', entryId };
      const offer = `Should I post this to the class: “${text}”? Reply yes or no.`;
      return say(offer, { check: 'post_offer' });
    }
    // Otherwise a new message, handled below (the held one is dropped, never posted or filed).
  }

  c ??= await classifyStaff({ text, emit });
  emit('staff_decision', { kind: c.kind, decidedBy: 'classifier', model: c.model ?? null, error: c.error ?? null });
  if (c.kind === 'class_message') return null;
  if (c.kind === 'unsure') {
    pendingChoice = { text, entryId, at: Date.now() };
    return { action: 'clarify', check: 'staff_or_class', reply: UNSURE_QUESTION, model: c.model ?? null, entries: [{ role: 'assistant', text: UNSURE_QUESTION, action: 'clarify', model: c.model ?? null }] };
  }
  return sendToHr({ operationId, text, hubLink, emit, decidedBy: 'classifier', model: c.model });
}

// Professor → Hub → HR: a signed staff request in this classroom's HR conversation.
async function sendToHr({ operationId, text, hubLink, emit, decidedBy, model = null, formValues }) {
  const value = { type: 'staff_request', operationId, conversationId, text, ...(formValues ? { formValues } : {}) };
  const asked = conversationId;
  const r = await hubLink.sendSigned(STAFF_REQUEST_MEDIA_TYPE, value, staffRequestFields(value), { timeoutMs: STAFF_TIMEOUT_MS });
  emit('staff_relayed', { kind: 'request', status: r.status, decidedBy, card: Boolean(r.reply?.formRef), cardValues: Boolean(formValues) });
  const result = { action: 'staff', decidedBy, model, hr: { status: r.status, formRef: r.reply?.formRef ?? null } };
  if (r.status === 'ok' && r.reply) {
    // A reset while HR answered started a new conversation: that card is gone with it.
    if (r.reply.formRef && asked === conversationId) {
      openCard = { formRef: r.reply.formRef, a2ui: r.reply.a2ui ?? [], hrCard: r.reply.hrCard ?? null, conversationId: asked, at: Date.now() };
    }
    return { ...result, reply: r.reply.text, entries: [{ role: 'hr', text: r.reply.text, ...(r.reply.formRef ? { formRef: r.reply.formRef } : {}) }] };
  }
  const text2 = r.status === 'refused' ? `HR didn’t take this: ${r.reason ?? 'refused'}`
    : r.status === 'not_delivered' ? `This didn’t reach HR: ${r.reason ?? 'unreachable'} Nothing was filed.`
      : `HR didn’t answer in time (${r.reason ?? 'no answer'}). Nothing is filed until you submit a card — send it again to get one.`;
  return { ...result, reply: text2, entries: [{ role: 'hr', text: text2, failed: true }] };
}

// The professor pressed a button on the open card. Returns { http, body, entries, definite }.
// definite = HR's answer is known (store it for a repeat); an unknown outcome is retried with the SAME
// operationId (the Hub and HR both dedupe), so it is not stored.
// classInfo (review C12): reads the class record fresh from CHRS for the cancellation preview → the record (time, room and,
// review #3, the class size for “To: your 25 students”) or null (the preview then names the course only and “your class
// roster”; the cancellation itself is re-read at Send and is refused without the details).
export async function staffAction({ operationId, formRef, action, hubLink, emit = () => {}, classInfo = async () => null }) {
  if (!cardOpen() || openCard.formRef !== formRef) return { http: 409, body: { error: 'That card isn’t open any more.' } };
  const card = openCard;
  const value = { type: 'staff_action', operationId, formRef, action, conversationId: card.conversationId };
  const r = await hubLink.sendSigned(STAFF_ACTION_MEDIA_TYPE, value, staffActionFields(value), { timeoutMs: STAFF_TIMEOUT_MS });
  emit('staff_relayed', { kind: 'action', status: r.status, actionName: typeof action?.name === 'string' ? action.name : null, closed: Boolean(r.reply?.closed) });
  const current = openCard === card; // not reset or replaced while HR answered
  const reply = r.reply ?? null;
  if (r.status === 'ok' && reply?.closed) {
    if (current) openCard = null;
    const entries = [];
    let status = 'cancelled';
    if (reply.receipt) {
      status = 'accepted';
      // `record` = what was filed (the receipt's own fields, never the note), so the card's question can show
      // the answer the professor picked once the card is gone.
      const { requestId, absenceType, absenceReason, beginDate, endDate, hours } = reply.receipt;
      entries.push({ role: 'hr', text: receiptText(reply.receipt), formRef, closed: true, record: { requestId, absenceType, absenceReason, beginDate, endDate, hours } });
      // Class on any filed day (Tue / Thu, part days too): a cancellation preview card; students get it only on Send or
      // “yes”. A preview card still open (an earlier filing) gets the new days, so no class day is dropped.
      const open = current && cancelCard?.status === 'open' ? cancelCard : null;
      const waiting = open ? open.days : current && pendingNote?.kind === 'cancel' && fresh(pendingNote) ? pendingNote.days ?? [] : [];
      const days = [...new Set([...waiting, ...classDays(reply.receipt)])].sort();
      if (days.length && current) {
        const gen = staffGen;
        let record = null;
        try { record = await classInfo(); } catch { record = null; }
        if (gen === staffGen) {
          const info = classDetailsOf(record);
          const count = Number.isInteger(record?.enrolled) && record.enrolled > 0 ? record.enrolled : null;
          const card = open && cancelCard === open && open.status === 'open' ? open : { id: `cc-${randomUUID()}` };
          cancelCard = Object.assign(card, { status: 'open', days, info, count, at: Date.now(), problem: null });
          pendingNote = { text: cancellationText(days), at: Date.now(), kind: 'cancel', days, cardId: card.id };
          entries.push({ role: 'assistant', text: cancellationLead(days, info), action: 'clarify', cancelCard: { id: card.id } });
        }
      }
    } else {
      entries.push({ role: 'hr', text: reply.text, formRef, closed: true, cancelled: true }); // the closed card says it; the screen skips this entry
    }
    return { http: 200, definite: true, entries, body: { status, reply: entries[0].text, closed: true, ...(reply.receipt ? { receipt: reply.receipt } : {}) } };
  }
  // HR's system didn't confirm: the outcome is unknown, HR's words say so. Not kept, so the same
  // operation can be sent again (the browser keeps its operation ID for outcome_unknown) — it won't file twice.
  if (r.status === 'refused' && reply?.retryable && reply?.unknownOutcome) {
    const text = r.reason ?? reply.text ?? 'Not confirmed.';
    return { http: 200, definite: false, entries: [{ role: 'hr', text, formRef, failed: true }], body: { status: 'outcome_unknown', reply: text, closed: false } };
  }
  if (r.status === 'ok' || r.status === 'refused') {
    // HR (or the Hub) refused it: the card stays open with HR's errors, unless the Hub says (typed code,
    // never its wording) that the card itself can't be acted on any more.
    const gone = r.code === CARD_CLOSED;
    if (current && gone) openCard = null;
    if (current && !gone && reply?.a2ui?.length) openCard = { ...openCard, a2ui: [...openCard.a2ui, ...reply.a2ui] };
    const text = r.reason ?? reply?.text ?? 'Not accepted.';
    // A retryable rejection (e.g. a wrong tool pick, nothing filed) is definite but not stored,
    // so the same operation can run again; the browser starts a new operation after a rejection anyway.
    return { http: 200, definite: !reply?.retryable, entries: [{ role: 'hr', text, formRef, failed: true }], body: { status: 'rejected', reply: text, closed: gone, ...(reply?.errors ? { errors: reply.errors } : {}) } };
  }
  const text = r.status === 'not_delivered' ? "HR didn't answer, so nothing was submitted. Press Submit again — it won't be filed twice." : `HR didn’t confirm in time, so the outcome is unknown. Press the button again — it won’t file twice.`;
  return { http: 200, definite: false, entries: [{ role: 'hr', text, formRef, failed: true }], body: { status: r.status === 'not_delivered' ? 'not_delivered' : 'outcome_unknown', reply: text, closed: false } };
}
