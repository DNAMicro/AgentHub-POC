// Review D12 at the desk: the idea each suggestion tests stays inside the desk; the quiz and the card stay as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuizDesk } from '../src/professor-quiz.js';

const NOW = new Date('2026-11-04T20:00:00Z');
const noCanvas = { createQuiz: async () => ({ ok: false }), publishQuiz: async () => ({ ok: false }) };
const desk = () => createQuizDesk({ canvas: noCanvas, createPost: async () => ({ http: 200, body: {} }), now: () => NOW }); // real mock model
const keys = (v, out = new Set()) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); } return out; };

test('D12 quiz questions and the state summary never carry a concept key; the draft view maps text to idea', async () => {
  const d = desk();
  const r = await d.turn('make a quiz on segmentation, 5 questions', { operationId: 'a1' });
  const view = d.draft(r.draftId);
  assert.ok(!keys(view.quiz).has('concept'));
  assert.ok(!keys(d.card()).has('concept'));
  assert.equal(Object.keys(view.concepts).length, 5);
  assert.deepEqual(Object.values(view.concepts).slice(0, 2), ['Market segmentation', 'Target market']);
});

test('D12 asking for 8 on a 6-idea topic says so in the reply', async () => {
  const d = desk();
  const r = await d.turn('make a quiz on segmentation, 8 questions', { operationId: 'a2' });
  assert.equal(d.draft(r.draftId).quiz.questions.length, 6);
  assert.match(r.reply, /Drafted 6 of 8 — the Topic 8 notes cover 6 ideas, one question each\./);
});

test('D12 asking for exactly the default 5 on a 5-idea topic has no shortfall sentence', async () => {
  const d = desk();
  const r = await d.turn('make a quiz on retailing, 5 questions', { operationId: 'a3' });
  assert.equal(d.draft(r.draftId).quiz.questions.length, 5);
  assert.doesNotMatch(r.reply, /Only|Drafted \d+ of/);
});

test('D12 Draft one more takes an unused idea each time, and answers honestly when none is left', async () => {
  const d = desk();
  const r = await d.turn('make a quiz on segmentation, 5 questions', { operationId: 'a4' });
  const one = await d.action({ draftId: r.draftId, operationId: 'm1', action: 'one_more' });
  assert.equal(one.ok, true);
  assert.equal(one.concept, 'Undifferentiated targeting');
  assert.ok(!('concept' in one.question));
  const texts = [...d.draft(r.draftId).quiz.questions.map((x) => x.text), one.question.text];
  const none = await d.action({ draftId: r.draftId, operationId: 'm2', action: 'one_more', existing: texts });
  assert.equal(none.ok, false);
  assert.equal(none.exhausted, true);
  assert.equal(none.retryable, false);
  assert.equal(none.text, 'Every idea in the Topic 8 notes already has a question.');
});

test('D12 removing a suggestion from the page frees its idea; rewriting it frees it too', async () => {
  const d = desk();
  const r = await d.turn('make a quiz on segmentation, 5 questions', { operationId: 'a5' });
  const qs = d.draft(r.draftId).quiz.questions.map((x) => x.text);
  // He removed question 2 and rewrote question 3 (new wording, so the desk no longer matches it to an idea).
  const held = [qs[0], 'My own words about a lifestyle group of buyers?', qs[3], qs[4]];
  const a = await d.action({ draftId: r.draftId, operationId: 'm3', action: 'one_more', existing: held });
  assert.equal(a.ok, true);
  assert.ok(['Target market', 'Geographic segmentation', 'Undifferentiated targeting'].includes(a.concept), a.concept);
});

test('D12 a bad page list of questions is still refused', async () => {
  const d = desk();
  const r = await d.turn('make a quiz on segmentation', { operationId: 'a6' });
  const a = await d.action({ draftId: r.draftId, operationId: 'm4', action: 'one_more', existing: 'nope' });
  assert.equal(a.ok, false);
});
