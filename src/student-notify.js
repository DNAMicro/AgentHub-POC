// The student lets their instructor know (owner, 2026-11-09: “it should have said who would you like to notify and if they
// said my classes then … have something that says type message and have it sent to the instructor and the instructor agent
// acknowledges receipt … This process should feel very natural”). Approved mockup:
// docs/superpowers/specs/2026-11-09-student-notify-mockup.html.
//
// Code only (no model, no imports): the Student agent reads the words. Names come from the caller — the course notice in the
// Student agent's own inbox (who teaches which course), never from the student's words or a model.
//
//   readsAbsence(text)               → true for “i am sick today”, “I'll miss class Thursday”, “I can't make it to class” …
//   whoOf(text, { offered, course }) → 'instructor' | 'cancel' | 'other' | null (null = not an answer: a new message)
//   askWhoText(text)                 → the question the Student agent asks
//   onlyInstructorText(course)       → when the student names someone this demo can't reach

export const NOTIFY_MAX = 1000;
export const NOTIFY_TTL_MS = 15 * 60_000;
export const NOTHING_SENT_TEXT = 'OK, I didn’t send anything.';
export const CANCEL_LABEL = 'Cancel';
export const instructorLabel = (course) => `${course.professorName} · ${course.courseTitle}`;
export const onlyInstructorText = (course) => `Here I can only reach ${course.professorName}, your ${course.courseTitle} instructor. Want me to let them know?`;
export const NOT_REACHED_TEXT = (course) => `I couldn’t reach ${course.professorName} just now, so nothing was sent. Press Send again in a moment.`;
export const UNSURE_TEXT = (course) => `I’m not sure this reached ${course.professorName}. Press Send again — they won’t get it twice.`;

const norm = (t) => String(t ?? '').replace(/[’‘]/g, '\'').replace(/\s+/g, ' ').trim();
const ILL_WORDS = String.raw`(?:sick|ill|unwell|not\s+well|not\s+feeling\s+(?:well|good|great)|under\s+the\s+weather|feverish|nauseous|throwing\s+up|in\s+the\s+hospital|in\s+hospital)`;
const ILLNESS = /\b(?:flu|fever|cold|covid(?:-19)?|migraine|stomach\s+bug|food\s+poisoning|sore\s+throat|infection|strep|the\s+chills)\b/;
const ILL = new RegExp(String.raw`\b(?:i\s*(?:'m|am)|im|i\s+(?:feel|felt|was|have\s+been|'ve\s+been)|i'm\s+feeling|feeling|got)\s+(?:really\s+|very\s+|so\s+|super\s+|a\s+(?:bit|little)\s+|kind\s+of\s+|kinda\s+|too\s+)?${ILL_WORDS}\b`);
const HAVE = new RegExp(String.raw`\bi\s*(?:have|'ve|got|caught|'ve\s+got|came\s+down\s+with)\s+(?:a\s+|the\s+|some\s+)?(?:bad\s+|terrible\s+|high\s+)?${ILLNESS.source}`);
const CLASSY = String.raw`(?:class(?:es)?|lecture|today|tomorrow|tonight|this\s+(?:morning|afternoon|week)|on\s+\w+day|\w+day|marketing|mktg|the\s+(?:class|lecture|session|exam|quiz|midterm))`;
const MISS = new RegExp(String.raw`\bi(?:\s*'ll|\s+will|\s*'m\s+going\s+to|\s+am\s+going\s+to|\s*'m\s+gonna|\s+have\s+to|\s+need\s+to|\s+might|\s+may|\s+must)?\s+(?:miss|skip|be\s+missing)\s+(?:my\s+|the\s+)?${CLASSY}`);
const CANT = new RegExp(String.raw`\bi\s*(?:can't|cannot|can\s+not|won't|will\s+not|wont|cant|am\s+not\s+able\s+to|'m\s+not\s+able\s+to|'m\s+unable\s+to|am\s+unable\s+to|'m\s+not\s+going\s+to|am\s+not\s+going\s+to|'m\s+not\s+gonna)\s+(?:make\s+it|come|attend|be\s+(?:in|at|there)|go|get\s+to)\b(?:\s+(?:to\s+|in\s+|at\s+)?(?:my\s+|the\s+)?${CLASSY})?`);
const OUT = /\bi(?:\s*'ll|\s+will|\s*'m\s+going\s+to)?\s+be\s+(?:absent|out|late|away)\b|\bi'm\s+(?:running\s+late|not\s+coming|absent)\b|\bi\s+am\s+(?:running\s+late|not\s+coming|absent)\b|\bfamily\s+emergency\b|\bnot\s+coming\s+(?:to\s+class|in\s+today|today)\b/;
// Questions and other services are not an absence to report: “what should I do if I'm sick?”, “can I renew my book if I'm
// out sick?”, “I can't make it to my tutoring appointment”.
const QUESTION_START = /^(?:what|how|when|where|who|why|which|is|are|do|does|did|should|would|could|can(?!'t)|will(?!\s+not)|if)\b/;
const OTHER_SERVICE = /\b(?:tutor(?:ing)?|library|book|books|loan|room|reservation|appointment|hr|time\s+off|vacation)\b/;

export function readsAbsence(text) {
  const t = norm(text).toLowerCase();
  if (!t || t.length > 600) return false;
  if (QUESTION_START.test(t) || OTHER_SERVICE.test(t) || /\bsick\s+(?:of|and\s+tired)\b/.test(t)) return false; // “sick of this homework”
  return ILL.test(t) || HAVE.test(t) || MISS.test(t) || CANT.test(t) || OUT.test(t);
}
export const soundsIll = (text) => { const t = norm(text).toLowerCase(); return ILL.test(t) || HAVE.test(t) || ILLNESS.test(t); };

export function askWhoText(text) {
  return soundsIll(text) ? 'Sorry you’re not feeling well. Who would you like me to let know?' : 'Who would you like me to let know?';
}

const CANCEL = /^(?:cancel|no|nope|nah|no\s+one|noone|nobody|none|never\s*mind|nvm|don't|do\s+not|not\s+now|no\s+thanks?|nothing|forget\s+it)\b/;
const YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please(?:\s+do)?|go\s+ahead|do\s+it|y)\b/;
const OTHER_PERSON = /\b(?:boss|manager|supervisor|work|job|employer|mom|mother|dad|father|parents?|family|roommate|coach|advisor|adviser|counselor|counsellor|friend|doctor|nurse|dean|registrar|landlord|partner|wife|husband|girlfriend|boyfriend|other\s+(?:class|classes|professors?|instructors?|teachers?))\b/;
// whoOf: what the answer to “Who would you like me to let know?” means. Only short answers count; anything longer is a
// new message (the question is dropped and the message is handled as usual).
export function whoOf(text, { offered = false, course } = {}) {
  const t = norm(text).toLowerCase().replace(/[.!?]+$/, '');
  if (!t) return null;
  if (course && t === norm(instructorLabel(course)).toLowerCase()) return 'instructor';
  if (t === CANCEL_LABEL.toLowerCase()) return 'cancel';
  const words = t.split(' ').length;
  if (words > 8) return null;
  if (CANCEL.test(t)) return 'cancel';
  if (offered && YES.test(t)) return 'instructor';
  if (OTHER_PERSON.test(t)) return 'other';
  const last = course ? norm(course.professorName).toLowerCase().split(' ').at(-1) : 'dabirian';
  const courseWords = course ? norm(course.courseTitle).toLowerCase().split(' ') : ['marketing', '351'];
  const INSTRUCTOR = new RegExp(String.raw`\b(?:class(?:es)?|course(?:s)?|professor|prof|instructor|teacher|lecturer|faculty|${last}|${courseWords.map((w) => w.replace(/[^\w]/g, '')).join('|')}|mktg|him|her|them)\b`);
  if (INSTRUCTOR.test(t)) return 'instructor';
  if (!offered && YES.test(t)) return 'instructor'; // “yes” / “sure” to “who …?”: the one person this demo can reach
  return null;
}
