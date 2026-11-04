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

export function checkQuestion(q) {
  const bad = (problem) => ({ ok: false, problem });
  if (!q || typeof q !== 'object') return bad('The question is missing.');
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
