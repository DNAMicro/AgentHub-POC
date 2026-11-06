// Part 16 Task 5: quiz drafting in MOCK mode (labelled heuristic; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PROFESSOR_MODE = 'mock';
const { draftQuiz, draftOne } = await import('../src/quiz-model.js');
const { checkQuestion: rawCheck } = await import('../src/quiz-rules.js');
const checkQuestion = ({ concept, ...q }) => rawCheck(q); // eslint-disable-line no-unused-vars
const { TOPICS } = await import('../src/course-schedule.js');

test('mock Topic 8, 5 questions: all pass checkQuestion, distinct, deterministic, labelled', async () => {
  const a = await draftQuiz({ topic: 8, count: 5 });
  const b = await draftQuiz({ topic: 8, count: 5 });
  assert.deepEqual(a, b);
  assert.equal(a.questions.length, 5);
  assert.equal(a.short, 0);
  assert.equal(a.by, 'mock');
  assert.equal(a.model, 'mock (labelled heuristic)');
  for (const q of a.questions) {
    assert.deepEqual(checkQuestion(q), { ok: true }, q.text);
    assert.equal(q.origin, 'ai');
    assert.match(q.text, /^Which term matches: /);
  }
  assert.equal(new Set(a.questions.map((q) => q.text)).size, 5);
  const topic = TOPICS.find((t) => t.n === 8);
  const terms = topic.notes.map((n) => n.term);
  for (const q of a.questions) {
    for (const ans of q.answers) assert.ok(terms.includes(ans));
    assert.doesNotMatch(q.text, /[.!?]\?$/, `doubled punctuation: ${q.text}`);
    const note = topic.notes.find((n) => q.text.includes(n.definition.replace(/[.!?]$/, '')));
    assert.equal(q.answers[q.correct], note.term);
  }
});

test('mock: asking for more than the notes can make says how short', async () => {
  const r = await draftQuiz({ topic: 8, count: 20 });
  assert.equal(r.questions.length, 6, 'one question per idea: Topic 8 has six terms');
  assert.equal(r.short, 14);
  assert.equal(r.ideas, 6);
  for (const q of r.questions) assert.equal(checkQuestion(q).ok, true);
  assert.equal(new Set(r.questions.map((q) => q.text)).size, r.questions.length);
});

test('mock draftOne: a question not already in the quiz; null when none is left', async () => {
  const first = await draftOne({ topic: 8, existing: [] });
  assert.equal(first.by, 'mock');
  assert.equal(checkQuestion(first.question).ok, true);
  const full = (await draftQuiz({ topic: 8, count: 20 })).questions;
  const all = full.map((q) => q.text);
  const next = await draftOne({ topic: 8, existing: all.slice(0, 2), earlier: full.slice(0, 2) });
  assert.ok(next.question && !all.slice(0, 2).includes(next.question.text));
  assert.ok(!full.slice(0, 2).some((q) => q.concept === next.question.concept), 'a new idea');
  const none = await draftOne({ topic: 8, existing: all, earlier: full });
  assert.equal(none.question, null);
  assert.equal(none.exhausted, true);
});

test('unknown topic: nothing drafted', async () => {
  const r = await draftQuiz({ topic: 99, count: 5 });
  assert.equal(r.questions.length, 0);
  assert.equal(r.short, 5);
});

test('B7 mock draftOne skips a suggestion that looks like one already in the quiz', async () => {
  const { draftQuiz: dq, draftOne: d1 } = await import('../src/quiz-model.js');
  const five = (await dq({ topic: 8, count: 5 })).questions;
  // He reworded the first question; the mock must not offer anything that repeats it or the others.
  const existing = [five[0].text.replace('Which term matches:', 'Which term fits:'), ...five.slice(1).map((q) => q.text)];
  const r = await d1({ topic: 8, existing, earlier: five });
  assert.ok(r.question);
  const { similarTo } = await import('../src/quiz-rules.js');
  assert.ok(![...existing, ...five].some((o) => similarTo(r.question, o)));
});

// ---- review D12 (mock mode is a LABELLED heuristic: the notes' terms in order, one question each) -----------------------
test('D12 mock: each question carries the term it tests, in the notes’ order, all different', async () => {
  const r = await draftQuiz({ topic: 8, count: 5 });
  const terms = TOPICS.find((t) => t.n === 8).notes.map((n) => n.term);
  assert.deepEqual(r.questions.map((x) => x.concept), terms.slice(0, 5));
});

test('D12 mock: every topic can give the default 5 distinct ideas', async () => {
  for (const t of TOPICS) {
    const r = await draftQuiz({ topic: t.n, count: 5 });
    assert.equal(new Set(r.questions.map((x) => x.concept)).size, 5, `Topic ${t.n}`);
  }
});

test('D12 mock draftOne walks through the unused ideas, then says every idea is covered', async () => {
  const have = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await draftOne({ topic: 8, existing: have.map((x) => x.text), earlier: have });
    assert.ok(r.question, `idea ${i + 1}`);
    assert.ok(!have.some((x) => x.concept === r.question.concept));
    have.push(r.question);
  }
  const done = await draftOne({ topic: 8, existing: have.map((x) => x.text), earlier: have });
  assert.equal(done.exhausted, true);
});
