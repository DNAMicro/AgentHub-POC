// Part 16 Task 5: quiz drafting in MOCK mode (labelled heuristic; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PROFESSOR_MODE = 'mock';
const { draftQuiz, draftOne } = await import('../src/quiz-model.js');
const { checkQuestion } = await import('../src/quiz-rules.js');
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
    const note = topic.notes.find((n) => q.text.includes(n.definition));
    assert.equal(q.answers[q.correct], note.term);
  }
});

test('mock: asking for more than the notes can make says how short', async () => {
  const r = await draftQuiz({ topic: 8, count: 20 });
  assert.equal(r.questions.length + r.short, 20);
  assert.ok(r.short > 0);
  for (const q of r.questions) assert.equal(checkQuestion(q).ok, true);
  assert.equal(new Set(r.questions.map((q) => q.text)).size, r.questions.length);
});

test('mock draftOne: a question not already in the quiz; null when none is left', async () => {
  const first = await draftOne({ topic: 8, existing: [] });
  assert.equal(first.by, 'mock');
  assert.equal(checkQuestion(first.question).ok, true);
  const all = (await draftQuiz({ topic: 8, count: 20 })).questions.map((q) => q.text);
  const next = await draftOne({ topic: 8, existing: all.slice(0, 2) });
  assert.ok(next.question && !all.slice(0, 2).includes(next.question.text));
  const none = await draftOne({ topic: 8, existing: all });
  assert.equal(none.question, null);
});

test('unknown topic: nothing drafted', async () => {
  const r = await draftQuiz({ topic: 99, count: 5 });
  assert.equal(r.questions.length, 0);
  assert.equal(r.short, 5);
});
