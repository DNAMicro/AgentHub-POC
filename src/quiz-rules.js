// Quiz settings and checks shared by the page, the UI server, the Faculty agent and Canvas.
// Imports only the schedule; the browser loads it from /shared/quiz-rules.js.
import { TOPICS, TERM, pacificDate, isTaught, dayLabel } from './course-schedule.js';

export const QUIZ_LIMITS = { questions: [1, 20], points: [1, 10], minutes: [1, 120], attempts: [1, 3], questionChars: [10, 300], answerChars: 150 };

const SMALL = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'in', 'on', 'to', 'or']);

function titleCase(name) {
  return name.split(' ').map((w, i) => {
    if (i > 0 && SMALL.has(w)) return w;
    const k = w.search(/[a-z]/i);
    return k < 0 ? w : w.slice(0, k) + w[k].toUpperCase() + w.slice(k + 1);
  }).join(' ');
}

const hmFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: false });

// The UTC instant that is hh:mm on the Pacific calendar day ymd (handles daylight saving).
function pacificToIso(ymd, hh, mm) {
  const [y, m, d] = ymd.split('-').map(Number);
  for (const off of [7, 8]) {
    const guess = new Date(Date.UTC(y, m - 1, d, hh + off, mm));
    if (pacificDate(guess) === ymd) {
      const parts = hmFmt.formatToParts(guess);
      const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
      const mi = Number(parts.find((p) => p.type === 'minute').value);
      if (h === hh && mi === mm) return guess.toISOString();
    }
  }
  return null;
}

export function defaultSettings(topicN, now) {
  const topic = TOPICS.find((x) => x.n === topicN);
  const today = pacificDate(now);
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const ahead = ((1 - dow + 7) % 7) || 7;
  const due = new Date(Date.UTC(y, m - 1, d + ahead)).toISOString().slice(0, 10);
  return {
    title: `Topic ${topicN} Quiz: ${titleCase(topic ? topic.name : '')}`,
    pointsEach: 3, minutes: 10, attempts: 1,
    dueAt: pacificToIso(due, 23, 59),
  };
}

const isInt = (v) => Number.isInteger(v);
const inRange = (v, [lo, hi]) => isInt(v) && v >= lo && v <= hi;

// "Draft one more" carries the question texts the page holds now: at most 20, 300 characters each.
export const validExisting = (v) => Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string' && x.length <= 300);

const QUESTION_KEYS = new Set(['text', 'answers', 'correct', 'origin']);

export function checkQuestion(q) {
  const bad = (problem) => ({ ok: false, problem });
  if (!q || typeof q !== 'object' || Array.isArray(q)) return bad('The question is missing.');
  for (const k of Object.keys(q)) if (!QUESTION_KEYS.has(k)) return bad(`Unknown field: ${k}.`);
  const [lo, hi] = QUIZ_LIMITS.questionChars;
  if (typeof q.text !== 'string') return bad('The question needs text.');
  const len = q.text.trim().length;
  if (len < lo || len > hi) return bad(`The question must be ${lo}–${hi} characters.`);
  if (!Array.isArray(q.answers) || q.answers.length !== 4) return bad('A question needs exactly four answers.');
  if (q.answers.some((a) => typeof a !== 'string' || !a.trim())) return bad('Every answer needs text.');
  if (q.answers.some((a) => a.trim().length > QUIZ_LIMITS.answerChars)) return bad(`An answer is longer than ${QUIZ_LIMITS.answerChars} characters.`);
  if (new Set(q.answers.map((a) => a.trim().toLowerCase())).size !== 4) return bad('The four answers must all be different.');
  if (!inRange(q.correct, [0, 3])) return bad('Pick exactly one correct answer.');
  return { ok: true };
}

// ---- near-duplicate questions (review B7: two drafted questions asked for the definition of marketing) ------------
// Code, not the model. Used to DROP drafted questions (draft, repair, "Draft one more") and to WARN on the card about
// the faculty member's own edits (never to block Approve: his questions are his choice).
// (a) the same correct answer after normalising (case, punctuation, articles, whitespace), or
// (b) question stems that overlap strongly: Jaccard >= SIMILAR_STEMS over content words (4+ letters, plus 3-letter words
//     that carry meaning: "mix", "age"), light stem (plural, -ing, -ed), with the generic question words removed ("which
//     term matches", "what is the definition of"). Tuned on every topic's mock questions (none flagged) and paraphrases.
export const SIMILAR_STEMS = 0.6;
const ARTICLES = new Set(['a', 'an', 'the']);
export const normAnswer = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter((w) => w && !ARTICLES.has(w)).join(' ');
// Words every question form uses; they say nothing about which idea is tested.
const GENERIC = new Set(['which', 'what', 'when', 'where', 'whom', 'whose', 'does', 'term', 'terms', 'definition', 'defin', 'define', 'describ', 'best',
  'match', 'fits', 'following', 'statement', 'true', 'false', 'correct', 'example', 'mean', 'meaning', 'called', 'name', 'this', 'that', 'these', 'those',
  'with', 'from', 'into', 'about', 'than', 'they', 'their', 'there', 'have', 'most', 'likely', 'would', 'should', 'could', 'question', 'answer', 'firm', 'company',
  'and', 'are', 'but', 'can', 'did', 'for', 'has', 'her', 'his', 'how', 'its', 'may', 'not', 'one', 'our', 'own', 'the', 'two', 'use', 'was', 'who', 'why', 'you', 'all', 'any']);
function stemWord(w) {
  let s = w;
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith('es') && /(ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 4) s = s.slice(0, -1); // "price"/"pricing" -> "pric"
  return s;
}
export function stemWords(text) {
  const out = new Set();
  for (const w of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3) continue;
    const s = stemWord(w);
    if (!GENERIC.has(w) && !GENERIC.has(s)) out.add(s);
  }
  return out;
}
export function stemOverlap(a, b) {
  const x = stemWords(a);
  const y = stemWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}
const rightAnswer = (q) => (Array.isArray(q?.answers) && Number.isInteger(q?.correct) ? q.answers[q.correct] : null);
// → why q repeats `other` ('answer' | 'stem') or null. `other` may be a question or a bare question text.
export function similarTo(q, other) {
  if (!q || !other || !String(q.text ?? '').trim()) return null;
  const otherText = typeof other === 'string' ? other : other.text;
  const mine = rightAnswer(q);
  const theirs = typeof other === 'string' ? null : rightAnswer(other);
  if (mine !== null && theirs !== null && normAnswer(mine) && normAnswer(mine) === normAnswer(theirs)) return 'answer';
  if (!String(otherText ?? '').trim()) return null;
  if (String(q.text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(otherText ?? '').trim().toLowerCase().replace(/\s+/g, ' ')) return 'stem';
  return stemOverlap(q.text, otherText) >= SIMILAR_STEMS ? 'stem' : null;
}
// Pairs of 1-based positions that look alike, e.g. [[5, 6]] → “Questions 5 and 6 look alike.” (the card's warning).
export function lookAlikePairs(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const pairs = [];
  for (let j = 1; j < list.length; j += 1) for (let i = 0; i < j; i += 1) if (similarTo(list[j], list[i])) pairs.push([i + 1, j + 1]);
  return pairs;
}
export const lookAlikeText = (pairs) => pairs.map(([i, j]) => `Questions ${i} and ${j} look alike.`).join(' ');

// After Approve (review B8): the confirmation says how many questions he edited or added — real counts only.
export function savedText({ questions, edited = 0, added = 0 }) {
  const by = [edited > 0 && `${edited} edited`, added > 0 && `${added} added`].filter(Boolean);
  const n = Number.isInteger(questions) ? questions : 0;
  return `Saved in Canvas as a draft (${n} question${n === 1 ? '' : 's'}${by.length ? `, ${by.join(' and ')} by you` : ''}). Students can't see it yet.`;
}

const QUIZ_KEYS = new Set(['topic', 'title', 'pointsEach', 'minutes', 'attempts', 'dueAt', 'questions']);
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function checkQuiz(quiz, now) {
  const fail = (code, problem, index) => (index === undefined ? { ok: false, code, problem } : { ok: false, code, problem, index });
  if (!quiz || typeof quiz !== 'object' || Array.isArray(quiz)) return fail('bad_settings', 'The quiz is missing.');
  for (const k of Object.keys(quiz)) if (!QUIZ_KEYS.has(k)) return fail('bad_settings', `Unknown field: ${k}.`);
  if (!inRange(quiz.topic, [1, 20])) return fail('bad_settings', 'Pick one of the 20 topics.');
  if (!isTaught(quiz.topic, now)) return fail('not_taught', `Topic ${quiz.topic} has not been taught yet.`);
  if (typeof quiz.title !== 'string' || !quiz.title.trim() || quiz.title.trim().length > 120) return fail('bad_settings', 'The title must be 1–120 characters.');
  if (!inRange(quiz.pointsEach, QUIZ_LIMITS.points)) return fail('bad_settings', 'Points each must be 1–10.');
  if (!inRange(quiz.minutes, QUIZ_LIMITS.minutes)) return fail('bad_settings', 'The time limit must be 1–120 minutes.');
  if (!inRange(quiz.attempts, QUIZ_LIMITS.attempts)) return fail('bad_settings', 'Attempts must be 1–3.');
  const due = typeof quiz.dueAt === 'string' ? new Date(quiz.dueAt) : null;
  if (!due || Number.isNaN(due.getTime())) return fail('bad_settings', 'The due date is not a date.');
  if (due.getTime() <= now.getTime()) return fail('due_in_past', 'The due date must be in the future.');
  if (pacificDate(due) > TERM.end) return fail('bad_settings', `The due date must be within the term (ends ${dayLabel(TERM.end)}).`);
  if (!Array.isArray(quiz.questions)) return fail('bad_question', 'The quiz needs questions.');
  const [qlo, qhi] = QUIZ_LIMITS.questions;
  if (quiz.questions.length < qlo || quiz.questions.length > qhi) return fail('bad_question', `A quiz needs ${qlo}–${qhi} questions.`);
  const seen = new Set();
  for (let i = 0; i < quiz.questions.length; i += 1) {
    const r = checkQuestion(quiz.questions[i]);
    if (!r.ok) return fail('bad_question', `Question ${i + 1}: ${r.problem}`, i);
    const key = norm(quiz.questions[i].text);
    if (seen.has(key)) return fail('bad_question', `Question ${i + 1} repeats an earlier question.`, i);
    seen.add(key);
  }
  return { ok: true, quiz };
}

export function summaryLine(quiz) {
  const n = quiz.questions.length;
  const pts = n * quiz.pointsEach;
  const plural = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  const due = new Date(quiz.dueAt);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true }).format(due);
  return `${plural(n, 'question')} · ${plural(pts, 'point')} · ${plural(quiz.minutes, 'minute')} · ${plural(quiz.attempts, 'attempt')} · due ${dayLabel(pacificDate(due))}, ${time.replace(/ /g, ' ')}`;
}
