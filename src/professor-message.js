// Review E (second video review, owner 2026-11-06): the MESSAGE PREVIEW CARD. Nothing reaches students from the Faculty
// view chat until the faculty member has seen it on this card and pressed Send (owner: “yes so its confirmed before its
// sent”). The card shows the exact text (editable), who gets it (“To: your 10 seniors”, “To: all 25 students in
// Marketing 351”) and two buttons, Send and Don't send.
//   * His own words (“Reminder: the case study is due Friday at noon.”, “@alex-student great question”, a ↩ Reply) start
//     the box with EXACTLY those words; the audience is what code read (tags → those students, no tag → the whole class).
//   * An INSTRUCTION to message students (“send a message to all seniors to inform them of a mandatory lab work”, “tell
//     everyone to read chapter 5”, “notify the class about the midterm review”) is read here by CODE: the audience (the
//     class, @tags, names, a roster group such as “all seniors”) and what to say. A subject alone (“about X”) or nothing
//     opens the card with an empty box; a “to inform them of …” clause is drafted (live: the Faculty agent's model, from his
//     words only, checked by checkDraft; mock: the labelled code rewrite mockDraft).
// This module is the code: reading the words, checking a draft, and the card's state (memory only, closed by a reset).
// The Faculty agent (src/professor-agent.js) resolves the audience against a fresh roster read and sends.
import { randomUUID } from 'node:crypto';
import { COURSE } from './course-pack.js';
import { groupFilter } from './professor-roster.js';
import { datesIn } from './a2ui-catalog.js';

export const MESSAGE_MAX = 1000;
export const ASK_WHO = 'Who should get this message? Nothing was sent.';
export const REPLACED = 'Not sent — replaced by a newer message.';
export const NOT_SENT_TEXT = 'Not sent.';
export const EMPTY_TEXT = 'Write the message first — the box is empty.';
export const TOO_LONG_TEXT = `Keep the message under ${MESSAGE_MAX} characters.`;
export const PRIVATE_TEXT = 'This message mentions your own leave, health or family, and your students would read it. Change it, then press Send again.';
export const DRAFT_FAILED_TEXT = "I couldn't write a draft just now. Write what they should get, then press Send.";
export const DRAFT_REFUSED_TEXT = "I'd have had to add details you didn't give, so the box is empty. Write what they should get, then press Send.";
export const NOT_CONFIRMED_TEXT = "Your message is on its way, but delivery isn't confirmed yet. I'll keep trying.";
export const CARD_GONE = 'This preview is closed, so nothing was sent from it.';
export const LABELS = {
  own: null, // his own words: no label
  draft: 'Written by your assistant from your instruction',
  lesson: 'Course lesson, as written in the course pack',
};

// ---- reading an instruction (code) ---------------------------------------------------------------------------------
const LEAD = String.raw`^\s*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
const NOUN = String.raw`(?:message|note|notice|announcement|reminder|e-?mail|update|text|heads[-\s]up)`;
// “send a message to all seniors …”, “write a note to the class: …”, “post an announcement to my students …”
const SEND_TO = new RegExp(String.raw`${LEAD}(?:send|write|post|draft|shoot)\s+(?:out\s+)?(?:a|an|the|this|my|one)?\s*(?:quick\s+|short\s+|brief\s+|class\s+)?${NOUN}\s+(?:out\s+)?to\s+([\s\S]+)$`, 'i');
// “send all seniors a message …”, “send @alex a quick note: …”
const SEND_WHO = new RegExp(String.raw`${LEAD}send\s+([\s\S]+?)\s+(?:a|an)\s+(?:quick\s+|short\s+|brief\s+)?${NOUN}\b\s*([\s\S]*)$`, 'i');
// “tell everyone …”, “remind my seniors …”, “let the class know …”, “message the marketing majors …”, “email @sam …”
const VERB = new RegExp(String.raw`${LEAD}(message|e-?mail|text|remind|tell|notify|inform|let|ask|warn|alert)\s+([\s\S]+)$`, 'i');
// The words that end the audience and start what to say.
// “send everyone the link to the syllabus”, “share the slides with my seniors” (live matrix, 2026-11-06: the first was put
// on the card word for word): send/share/give/forward + an audience + a thing → the card asks what to say about the thing.
const SEND_OBJ = new RegExp(String.raw`${LEAD}(?:send|share|give|forward|post)\s+([\s\S]+)$`, 'i');
const SHARE_WITH = new RegExp(String.raw`${LEAD}(?:share|post)\s+([\s\S]+?)\s+with\s+([\s\S]+)$`, 'i');
const CONNECTOR = /(\s*[:—–]\s*|\s+-\s+|,?\s+(?:that|to|about|of|regarding|saying|asking|telling)\b\s*)/i;
const TELLING = /^(?:inform|tell|notify|advise|alert|warn|update|let|remind|ask)\b/i;

const ALL = /^(?:everyone|everybody|all|students|(?:the\s+)?(?:whole\s+|entire\s+)?class|(?:my|the|our)\s+(?:whole\s+|entire\s+)?class(?:\s+section)?|(?:all\s+)?(?:my|the|our)\s+students|all\s+students|everyone\s+in\s+(?:my|the|our)\s+class|(?:all\s+)?(?:my\s+|the\s+|our\s+)?(?:marketing|mktg)\s*351(?:\s+students|\s+class)?|all\s+of\s+you|you\s+all|y['’]?all)$/i;
const TAGS = /^@[a-z][\w-]*(?:\s*(?:,|\band\b|&)\s*@[a-z][\w-]*)*$/i;
const NAME_PART = /^[A-Z][A-Za-zÀ-ÿ'’-]*(?:\s+[A-Z][A-Za-zÀ-ÿ'’-]*){0,2}$/;
const NOT_NAMES = /\b(?:I|Everyone|Everybody|All|The|My|Our|Class|Marketing|Mktg|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Dr|Professor|Assistant|HR)\b/;
const GROUPISH = /\b(?:students?|majors?|majoring|freshm[ae]n|first[-\s]years?|sophomores?|juniors?|seniors?|units?|program|plan|level|classmates|people|those|group)\b/i;
const NOT_AUDIENCE = /^(?:me|us|you|him|her|it|this|that|them|someone|somebody)$/i;
const QUALIFIER = /^(?:who|whom|whose|which|in|on|with|from|majoring|studying|taking|not|without|except|but)$/i;
const HEAD_END = /(?:^|\s)(?:the|a|an|my|our|who|whom|are|is|all|of|and|that|with|in)$/i;

const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').replace(/[\s,.;!?]+$/, '').trim();
// → { kind: 'all' } | { kind: 'tags', phrase } | { kind: 'filter', filter } | { kind: 'names', names } | { kind: 'query', words } | null
export function audienceOf(phrase, { query = true } = {}) {
  const p = clean(phrase).replace(/\ball\s+of\s+/gi, 'all ');
  if (!p || p.split(/\s+/).length > 12) return null;
  if (ALL.test(p)) return { kind: 'all' };
  if (TAGS.test(p)) return { kind: 'tags', phrase: p };
  const filter = groupFilter(p);
  if (filter) return { kind: 'filter', filter };
  const parts = p.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).filter(Boolean);
  if (parts.length && parts.length <= 6 && parts.every((x) => NAME_PART.test(x) && !NOT_NAMES.test(x))) return { kind: 'names', names: parts };
  if (query && GROUPISH.test(p)) return { kind: 'query', words: p };
  return null;
}
// No connector (“tell my students the midterm is postponed”): the longest opening that is an audience, ending on a real word.
function leadingAudience(rest) {
  const words = rest.trim().split(/\s+/);
  for (let k = Math.min(words.length, 10); k >= 1; k -= 1) {
    const phrase = words.slice(0, k).join(' ').replace(/[,:;]+$/, '');
    if (HEAD_END.test(phrase) || QUALIFIER.test(words[k] ?? '')) continue; // “the students | in the back row” narrows the group
    const a = audienceOf(phrase, { query: false });
    if (a) return { audience: a, body: words.slice(k).join(' ') };
  }
  return null;
}
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const sentence = (t) => { const s = cap(clean(t.replace(/\s+/g, ' ').trim()) || ''); const end = /[.!?]$/.test(t.trim()) ? t.trim().slice(-1) : '.'; return s ? `${s}${end}` : ''; };
// Third person about the students → second person (“they need to bring their laptops” → “you need to bring your laptops”).
export const toStudents = (t) => String(t ?? '').replace(/\bthemselves\b/gi, 'yourselves').replace(/\btheir\b/gi, 'your').replace(/\btheirs\b/gi, 'yours').replace(/\bthey['’]re\b/gi, "you're").replace(/\bthey\b/gi, 'you').replace(/\bthem\b/gi, 'you');

// What to say, from the words after the audience. → { kind: 'own' | 'please' | 'clause' | 'about' | 'none', text?, about?, clause? }
function bodyOf(connector, rest) {
  const r = String(rest ?? '').trim();
  const c = String(connector ?? '').trim().replace(/^,\s*/, '').toLowerCase();
  if (!r) return { kind: 'none' };
  if (c === 'about' || c === 'of' || c === 'regarding') return { kind: 'about', about: clean(r) };
  if (c === 'to') {
    if (TELLING.test(r)) return { kind: 'clause', clause: `to ${r}` };
    return { kind: 'please', text: `Please ${sentence(toStudents(r)).replace(/^./, (x) => x.toLowerCase())}` };
  }
  if (c === 'asking' || c === 'telling') return { kind: 'clause', clause: `${c === 'asking' ? 'ask' : 'tell'} ${r}` };
  if (c === 'that') { const swapped = toStudents(r); return swapped === r ? { kind: 'own', text: sentence(r) } : { kind: 'please', text: sentence(swapped) }; }
  return { kind: 'own', text: sentence(r) }; // “:”, “—”, “saying”, or the words right after the audience: his own words
}

// What follows the audience when it starts with a connector (“that …”, “: …”, “to …”, “about …”), else his own words.
function bodyAfter(text) {
  const t = ` ${String(text ?? '').trim()}`;
  const c = CONNECTOR.exec(t);
  return c && c.index === 0 ? bodyOf(c[1], t.slice(c[0].length)) : bodyOf(':', t);
}
// → null (not an instruction to message students: the words are his message), or { audience, body } with audience null when
// code can't read who it is for (the chat asks “Who should get this message?”).
export function readInstruction(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 1500) return null;
  let rest = null;
  let strong = false; // “send a message to …” is always an instruction; “tell …” only when its audience reads as one
  let m = SEND_TO.exec(t);
  if (m) { rest = m[1]; strong = true; }
  if (!rest && (m = SEND_WHO.exec(t))) {
    const a = audienceOf(m[1]);
    return a ? { audience: a, body: bodyAfter(m[2]) } : { audience: null, body: { kind: 'none' } };
  }
  if (!rest && (m = SHARE_WITH.exec(t))) {
    const a = audienceOf(m[2]);
    if (a) return { audience: a, body: { kind: 'about', about: clean(m[1]) } };
  }
  if (!rest && (m = SEND_OBJ.exec(t))) {
    const lead = leadingAudience(m[1]);
    if (lead && lead.body && CONNECTOR.exec(` ${lead.body}`)?.index !== 0) return { audience: lead.audience, body: { kind: 'about', about: clean(lead.body) } };
  }
  let verb = null;
  if (!rest && (m = VERB.exec(t))) { verb = m[1].toLowerCase(); rest = m[2]; }
  if (!rest) return null;
  if (verb === 'let') {
    const k = /^([\s\S]+?)\s+know\b[\s,]*([\s\S]*)$/i.exec(rest);
    if (!k) return null;
    const a = audienceOf(k[1]);
    if (!a) return NOT_AUDIENCE.test(clean(k[1])) || !GROUPISH.test(k[1]) ? null : { audience: null, body: { kind: 'none' } };
    return { audience: a, body: bodyAfter(k[2]) };
  }
  const whole = audienceOf(rest, { query: false });
  if (whole) return { audience: whole, body: { kind: 'none' } };
  const c = CONNECTOR.exec(rest);
  if (c && c.index > 0) {
    const a = audienceOf(rest.slice(0, c.index));
    if (a) return { audience: a, body: bodyOf(c[1], rest.slice(c.index + c[0].length)) };
  }
  const lead = leadingAudience(rest);
  if (lead) return { audience: lead.audience, body: lead.body ? bodyOf(':', lead.body) : { kind: 'none' } };
  const any = !c && audienceOf(rest); // a group with nothing said (“message the students who aren't business majors”)
  if (any) return { audience: any, body: { kind: 'none' } };
  // Who it is for can't be read. “Send a message to …” or a group word (“tell the students in the back row …”) is asked
  // about; anything else (“Tell the truth, the quiz was hard.”, “Let me know if you have questions.”) is his message.
  const head = (c && c.index > 0 ? rest.slice(0, c.index) : rest.split(/\s+/).slice(0, 4).join(' '));
  if (strong || (verb !== 'ask' && GROUPISH.test(head) && !NOT_AUDIENCE.test(clean(head)))) return { audience: null, body: { kind: 'none' } };
  return null;
}

// ---- drafts -----------------------------------------------------------------------------------------------------------
const OBJ = String.raw`(?:them|everyone|everybody|the\s+class|the\s+students|my\s+students|students|him|her|all\s+of\s+them)`;
const noted = (x) => { const t = clean(x); const a = /^(?:a|an)\s+([\s\S]+)$/i.exec(t); return `${a ? `there is ${a[1]}` : t}.`; };
const lower = (t) => t.replace(/^./, (x) => x.toLowerCase());
// The labelled MOCK draft (code, no model): “to inform them of a mandatory lab work” → “Please note: there is mandatory lab
// work.”; “to remind them to submit their forms” → “Reminder: please submit your forms.”; “to ask them to bring laptops” →
// “Please bring laptops.”; “to tell them that the room changed” → “The room changed.”. Plumbing, not judgment.
export function mockDraft(clause) {
  const t = String(clause ?? '').replace(/^\s*to\s+/i, '').replace(/\s+/g, ' ').trim();
  let m = new RegExp(String.raw`^(?:inform|tell|notify|advise|alert|warn|update|let)\s+${OBJ}(?:\s+know)?\s+(of|about|on|regarding|that)\s+([\s\S]+)$`, 'i').exec(t);
  if (m) return m[1].toLowerCase() === 'that' ? sentence(toStudents(m[2])) : `Please note: ${noted(toStudents(m[2]))}`;
  m = new RegExp(String.raw`^remind\s+${OBJ}\s+(to|that|about|of)\s+([\s\S]+)$`, 'i').exec(t);
  if (m) return m[1].toLowerCase() === 'to' ? `Reminder: please ${lower(sentence(toStudents(m[2])))}` : `Reminder: ${lower(sentence(toStudents(m[2])))}`;
  m = new RegExp(String.raw`^(?:ask|tell)\s+${OBJ}\s+to\s+([\s\S]+)$`, 'i').exec(t);
  if (m) return `Please ${lower(sentence(toStudents(m[1])))}`;
  return sentence(toStudents(t.replace(new RegExp(String.raw`^(?:inform|tell|notify|advise|alert|warn|update|remind|ask)\s+${OBJ}\s+`, 'i'), '')));
}
// A drafted message may hold nothing he didn't write: every number, date, weekday, month and time must be in his words,
// and no private word from his staff (HR) messages. → { text } or { problem }.
const DAYS = /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?\b|\b(?:today|tomorrow|tonight|yesterday|next\s+week|this\s+week)\b|\b(?:jan|feb|mar|apr|may|june?|july?|aug|sept?|oct|nov|dec)[a-z]*\b|\b(?:noon|midnight)\b/gi;
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function checkDraft(draft, words, privateWords = []) {
  const text = String(draft ?? '').replace(/\s+\n/g, '\n').trim();
  if (!text || text.length > MESSAGE_MAX) return { problem: 'empty' };
  const said = String(words ?? '');
  const nums = new Set(said.match(/\d+/g) ?? []);
  const extraNum = (text.match(/\d+/g) ?? []).find((n) => !nums.has(n));
  if (extraNum) return { problem: 'invented', added: extraNum };
  const named = new Set((said.match(DAYS) ?? []).map((w) => w.toLowerCase().slice(0, 3)));
  const extraDay = (text.match(DAYS) ?? []).find((w) => !named.has(w.toLowerCase().slice(0, 3)));
  if (extraDay) return { problem: 'invented', added: extraDay };
  const dates = new Set(datesIn(said));
  const extraDate = datesIn(text).find((d) => !dates.has(d));
  if (extraDate) return { problem: 'invented', added: extraDate };
  const allowed = new Set(norm(said).split(' '));
  if (norm(text).split(' ').some((w) => privateWords.includes(w) && !allowed.has(w))) return { problem: 'private' };
  return { text };
}

// Typed answers to an open card in the chat.
export const SEND_WORDS = /^\s*(?:(?:yes|yeah|yep|yup|ok(?:ay)?|sure)(?:[\s,]+(?:please|send(?:\s+it)?(?:\s+now)?|go\s+ahead|do\s+it))*|send(?:\s+(?:it|this|that|the\s+message))?(?:\s+now)?(?:\s+please)?|please\s+send(?:\s+it)?|go\s+ahead|looks\s+good(?:[\s,]+send(?:\s+it)?)?)[\s.!]*$/i;
export const DECLINE_WORDS = /^\s*(?:no|nope|nah|don['’]?t\s+send(?:\s+it)?|do\s+not\s+send(?:\s+it)?|cancel(?:\s+(?:it|that|the\s+message))?|never\s?mind|nvm|forget\s+it|scrap\s+(?:it|that)|discard(?:\s+it)?|no\s+thanks?)[\s.!]*$/i;

// ---- the card (memory only) ---------------------------------------------------------------------------------------
// One open card at a time. Kept here: the student ids it resolves to (never in /author/state), what code read (to read the
// roster again at Send), his own words (the baseline for the label and the privacy check), and the outcome.
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function createMessageDesk() {
  let card = null;
  const open = (c) => {
    let replaced = null;
    if (card && ['open', 'sending'].includes(card.status)) { card.status = 'not_sent'; card.reason = REPLACED; replaced = card.id; }
    card = { id: `mc-${randomUUID().slice(0, 12)}`, status: 'open', problem: null, result: null, postKey: null, reason: null, ...c };
    return { card, replaced };
  };
  const of = (id) => (card && card.id === id ? card : null);
  const current = () => (card && card.status === 'open' ? card : null);
  // What /author/state carries (pushed to every page): the description of the audience and a count — never a name or an id.
  function view() {
    if (!card) return null;
    const c = card;
    return {
      id: c.id, status: c.status, to: c.to, count: c.count, text: c.text, prompt: c.prompt ?? null, none: c.none ?? null, label: LABELS[c.label] ?? null,
      named: Boolean(c.named), max: MESSAGE_MAX, kind: c.kind ?? 'message',
      ...(c.result ? { result: c.result } : {}), ...(c.postKey ? { postKey: c.postKey } : {}), ...(c.problem ? { problem: c.problem } : {}), ...(c.reason ? { reason: c.reason } : {}),
    };
  }
  const begin = (id) => { const c = of(id); if (!c || c.status !== 'open' || !c.count) return null; c.status = 'sending'; c.problem = null; return c; };
  const end = (id, patch) => { const c = of(id); if (c) Object.assign(c, patch); };
  const decline = (id) => { const c = of(id); if (!c || c.status !== 'open') return false; c.status = 'not_sent'; c.problem = null; return true; };
  const reset = () => { card = null; };
  return { open, of, current, view, begin, end, decline, reset };
}
export const courseTitle = COURSE.title;
