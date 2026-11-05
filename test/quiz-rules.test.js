import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPICS, UNITS, TERM, pacificDate, taughtTopics, isTaught, topicFromWords, countFromWords, asksQuiz, dayLabel,
} from '../src/course-schedule.js';
import { defaultSettings, checkQuestion, checkQuiz, summaryLine, QUIZ_LIMITS } from '../src/quiz-rules.js';

const NOV4 = new Date('2026-11-04T20:00:00Z');
const Q = { text: 'Which term names splitting a market into groups?', answers: ['Segmentation', 'Branding', 'Pricing', 'Retailing'], correct: 0 };
const quizOf = (over = {}) => ({
  topic: 8, ...defaultSettings(8, NOV4),
  questions: [Q, { ...Q, text: 'Which term names picking the groups to serve?' }], ...over,
});

test('taught on Nov 4 = Topics 1–16', () => assert.deepEqual(taughtTopics(NOV4).map((t) => t.n), [...Array(16)].map((_, i) => i + 1)));
test('nothing taught before Aug 25; all after Dec 1', () => {
  assert.equal(taughtTopics(new Date('2026-08-24T20:00:00Z')).length, 0);
  assert.equal(taughtTopics(new Date('2026-12-02T20:00:00Z')).length, 20);
  assert.ok(isTaught(16, NOV4)); assert.ok(!isTaught(17, NOV4));
});
test('Pacific date, not UTC', () => assert.equal(pacificDate(new Date('2026-11-04T06:30:00Z')), '2026-11-03'));
test('term and units', () => {
  assert.deepEqual(TERM, { label: 'Fall 2026', start: '2026-08-25', end: '2026-12-18' });
  assert.deepEqual(UNITS.map((u) => u.exam), ['2026-09-24', '2026-10-22', null]);
});
test('topic from words', () => {
  assert.equal(topicFromWords('a quiz on Topic 8'), 8);
  assert.equal(topicFromWords('quiz on pricing'), 19);
  assert.equal(topicFromWords('create a quiz for Marketing 351'), null);
});
test('count from words', () => {
  assert.equal(countFromWords('segmentation, 8 questions'), 8);
  assert.equal(countFromWords('quiz'), null);
  assert.equal(countFromWords('40 questions'), null);
});
test('asksQuiz', () => {
  assert.ok(asksQuiz('@assistant create a quiz for Marketing 351'));
  assert.ok(!asksQuiz('the quiz was hard'));
  assert.ok(!asksQuiz('@student-alex make a quiz'));
});
test('dayLabel', () => assert.equal(dayLabel('2026-11-03'), 'Tue, Nov 3'));
test('defaults for Topic 8 on Nov 4', () => assert.deepEqual(defaultSettings(8, NOV4), {
  title: 'Topic 8 Quiz: Segmentation & Targeting', pointsEach: 3, minutes: 10, attempts: 1, dueAt: '2026-11-10T07:59:00.000Z',
}));
test('checkQuestion: exactly one correct, four different answers', () => {
  assert.deepEqual(checkQuestion(Q), { ok: true });
  assert.equal(checkQuestion({ ...Q, answers: ['a1', 'a2', 'a3'] }).ok, false);
  assert.equal(checkQuestion({ ...Q, answers: ['Same', 'same', 'Pricing', 'Retailing'] }).ok, false);
  assert.equal(checkQuestion({ ...Q, correct: 4 }).ok, false);
  const short = checkQuestion({ ...Q, text: 'Too short' });
  assert.equal(short.ok, false); assert.equal(typeof short.problem, 'string');
  assert.equal(checkQuestion({ ...Q, answers: ['', 'b', 'c', 'd'] }).ok, false);
  assert.equal(checkQuestion({ ...Q, answers: ['x'.repeat(151), 'b', 'c', 'd'] }).ok, false);
});
test('checkQuiz: ok case', () => { const r = checkQuiz(quizOf(), NOV4); assert.equal(r.ok, true); assert.equal(r.quiz.topic, 8); });
test('checkQuiz: each failure has its code', () => {
  assert.equal(checkQuiz(quizOf({ topic: 19 }), NOV4).code, 'not_taught');
  assert.equal(checkQuiz(quizOf({ dueAt: '2026-11-03T07:59:00.000Z' }), NOV4).code, 'due_in_past');
  assert.equal(checkQuiz(quizOf({ pointsEach: 11 }), NOV4).code, 'bad_settings');
  assert.equal(checkQuiz(quizOf({ dueAt: '2027-01-10T07:59:00.000Z' }), NOV4).code, 'bad_settings');
  assert.equal(checkQuiz({ ...quizOf(), extra: 1 }, NOV4).code, 'bad_settings');
  const rep = checkQuiz(quizOf({ questions: [Q, Q] }), NOV4);
  assert.equal(rep.code, 'bad_question'); assert.equal(rep.index, 1);
  assert.equal(checkQuiz(quizOf({ questions: [] }), NOV4).code, 'bad_question');
  assert.equal(checkQuiz(quizOf({ questions: [{ ...Q, correct: 9 }] }), NOV4).index, 0);
});
test('summaryLine', () => assert.equal(
  summaryLine({ ...defaultSettings(8, NOV4), questions: Array(5).fill(Q) }),
  '5 questions · 15 points · 10 minutes · 1 attempt · due Mon, Nov 9, 11:59 PM'));
test('limits', () => assert.deepEqual(QUIZ_LIMITS.questions, [1, 20]));
test('every topic has 4–6 original notes and a unique name', () => {
  assert.equal(TOPICS.length, 20);
  assert.equal(new Set(TOPICS.map((t) => t.name)).size, 20);
  TOPICS.forEach((t, i) => {
    assert.equal(t.n, i + 1);
    assert.ok(t.notes.length >= 4 && t.notes.length <= 6, `topic ${t.n} notes`);
    for (const n of t.notes) assert.ok(n.term && n.definition && n.definition.length <= 140, `topic ${t.n} ${n.term}`);
  });
});

test('M-5: a question with an extra key is refused (only text, answers, correct and origin)', async () => {
  const { checkQuestion, validExisting } = await import('../src/quiz-rules.js');
  const ok = { text: 'Which statement number 1 is correct?', answers: ['a', 'b', 'c', 'd'], correct: 1 };
  assert.equal(checkQuestion(ok).ok, true);
  assert.equal(checkQuestion({ ...ok, origin: 'ai' }).ok, true);
  assert.deepEqual(checkQuestion({ ...ok, explanation: 'x' }), { ok: false, problem: 'Unknown field: explanation.' });
  assert.equal(checkQuestion([ok]).ok, false);
  assert.equal(validExisting(['a']), true);
  assert.equal(validExisting('a'), false);
});
