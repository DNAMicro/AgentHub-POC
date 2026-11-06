// Part 16 Task 5: quiz drafting in LIVE mode against the scripted fake Anthropic API (never a real key or network).
// Plumbing only: proves what code does with model output, not how a real model writes questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFakeAnthropic, quizDraftReply, messageReply } from './support/fake-anthropic.js';

const stub = await startFakeAnthropic();
process.env.PROFESSOR_MODE = 'live';
process.env.ANTHROPIC_API_KEY = `sk-ant-test-${randomUUID()}`;
process.env.ANTHROPIC_BASE_URL = stub.url;
process.env.TUTOR_LOAD_DOTENV = '0';
const { draftQuiz, draftOne } = await import('../src/quiz-model.js');
const { checkQuestion } = await import('../src/quiz-rules.js');
const { TOPICS } = await import('../src/course-schedule.js');
test.after(() => stub.close());

// What the model returns now: the right answer and three wrong ones. It never says where the right one goes.
// Each one about a different idea (review B7: near-duplicates are dropped), so the texts differ in more than a number.
const IDEAS = ['geography', 'lifestyle', 'income', 'loyalty', 'benefits', 'occasion', 'usage', 'personality', 'culture', 'climate', 'gender', 'education'];
const good = (i) => ({ text: `Sample ${IDEAS[(i - 1) % IDEAS.length]} question ${i}?`, correct_answer: `Alpha ${i}`, wrong_answers: [`Beta ${i}`, `Gamma ${i}`, `Delta ${i}`] });
const bad = (i) => ({ text: `Q${i}`, correct_answer: 'a', wrong_answers: ['a', 'b', 'c'] });
const recorder = () => { const ev = []; return { ev, emit: (type, data) => ev.push({ type, data }) }; };

test('5 good questions: one call, 5 kept, origin ai', async () => {
  stub.reset();
  stub.respondWith((body) => quizDraftReply(body, [1, 2, 3, 4, 5].map(good)));
  const rec = recorder();
  const r = await draftQuiz({ topic: 8, count: 5, emit: rec.emit });
  assert.equal(stub.requests.length, 1);
  assert.equal(r.questions.length, 5);
  assert.equal(r.short, 0);
  assert.equal(r.by, 'model');
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.ok(r.questions.every((q) => q.origin === 'ai' && checkQuestion(q).ok));
  assert.equal(rec.ev[0].type, 'model_call_started');
  assert.equal(rec.ev[0].data.purpose, 'draft quiz');
  assert.equal(rec.ev.at(-1).type, 'model_response_received');
  assert.ok(stub.requests[0].body.max_tokens > 900, 'token cap raised for this call');
});

test('3 good + 2 bad, then repair gives 2 good: 5 and two calls (repair names the problems)', async () => {
  stub.reset();
  stub.respondWith((body, n) => quizDraftReply(body, n === 1 ? [good(1), bad(2), good(3), bad(4), good(5)] : [good(6), good(7)]));
  const r = await draftQuiz({ topic: 8, count: 5 });
  assert.equal(stub.requests.length, 2);
  assert.equal(r.questions.length, 5);
  assert.equal(r.short, 0);
  const repair = JSON.stringify(stub.requests[1].body.messages.at(-1));
  assert.match(repair, /different/);
});

test('repair still bad: short 2', async () => {
  stub.reset();
  stub.respondWith((body, n) => quizDraftReply(body, n === 1 ? [good(1), good(2), good(3), bad(4), bad(5)] : [bad(6), good(1)]));
  const r = await draftQuiz({ topic: 8, count: 5 });
  assert.equal(stub.requests.length, 2);
  assert.equal(r.questions.length, 3);
  assert.equal(r.short, 2);
  assert.equal(r.by, 'model');
});

test('a date the notes do not contain drops the question', async () => {
  stub.reset();
  const dated = { text: 'What was decided on October 3 about segmenting?', correct_answer: 'One', wrong_answers: ['Two', 'Three', 'Four'] };
  stub.respondWith((body, n) => quizDraftReply(body, n === 1 ? [dated, good(2)] : []));
  const r = await draftQuiz({ topic: 8, count: 2 });
  assert.equal(r.questions.length, 1);
  assert.equal(r.short, 1);
});

test('stop_reason max_tokens -> model_failed, nothing used', async () => {
  stub.reset();
  stub.respondWith((body) => quizDraftReply(body, [good(1), good(2), good(3), good(4), good(5)], { stopReason: 'max_tokens' }));
  const rec = recorder();
  const r = await draftQuiz({ topic: 8, count: 5, emit: rec.emit });
  assert.equal(r.by, 'model_failed');
  assert.equal(r.questions.length, 0);
  assert.equal(r.short, 5);
  assert.equal(stub.requests.length, 1);
  assert.ok(rec.ev.some((e) => e.type === 'model_call_failed'));
});

test('HTTP 500 and a refusal -> model_failed', async () => {
  stub.reset();
  stub.respondWith(() => ({ status: 500 }));
  assert.equal((await draftQuiz({ topic: 8, count: 3 })).by, 'model_failed');
  stub.respondWith((body) => quizDraftReply(body, [good(1)], { stopReason: 'refusal' }));
  assert.equal((await draftQuiz({ topic: 8, count: 3 })).by, 'model_failed');
});

test('the prompt holds Topic 8 notes and no other topic’s, and no student data', async () => {
  stub.reset();
  stub.respondWith((body) => quizDraftReply(body, [good(1)]));
  await draftQuiz({ topic: 8, count: 1 });
  const sent = JSON.stringify(stub.requests[0].body);
  const t8 = TOPICS.find((t) => t.n === 8);
  for (const n of t8.notes) assert.ok(sent.includes(n.term), n.term);
  const other = TOPICS.filter((t) => t.n !== 8).flatMap((t) => t.notes.map((n) => n.definition)).filter((d) => !t8.notes.some((n) => n.definition === d));
  for (const d of other) assert.ok(!sent.includes(d.slice(0, 40)), d);
  assert.match(JSON.stringify(stub.requests[0].body.system), /original/i);
  assert.match(JSON.stringify(stub.requests[0].body.system), /never copy/i);
});

test('draftOne: existing texts are sent; a repeat -> null; a fresh one -> question', async () => {
  stub.reset();
  const g = good(1);
  stub.respondWith((body) => quizDraftReply(body, [g]));
  const rec = recorder();
  const dup = await draftOne({ topic: 8, existing: [g.text.toUpperCase()], emit: rec.emit });
  assert.equal(dup.question, null);
  assert.equal(dup.by, 'model');
  assert.ok(JSON.stringify(stub.requests[0].body).includes(g.text.toUpperCase()));
  assert.equal(rec.ev[0].data.purpose, 'draft one more question');
  const fresh = await draftOne({ topic: 8, existing: ['Something else entirely about targets?'] });
  assert.equal(fresh.question.text, g.text);
  assert.equal(fresh.question.origin, 'ai');
});

test('draftOne: a failed call -> question null, model_failed', async () => {
  stub.reset();
  stub.respondWith(() => messageReply('not json'));
  const r = await draftOne({ topic: 8, existing: [] });
  assert.equal(r.question, null);
  assert.equal(r.by, 'model_failed');
});

// I-2 (LIVE-1): the model once marked the wrong letter. Now code places the right answer, so the key cannot disagree.
test('I-2: code places the correct answer; a stray "correct" index from the model is ignored', async () => {
  stub.reset();
  const withStray = (i) => ({ ...good(i), correct: 3, answers: ['x', 'y', 'z', 'w'] }); // an old-style model answer
  stub.respondWith((body) => quizDraftReply(body, [1, 2, 3, 4, 5, 6].map(withStray)));
  const r = await draftQuiz({ topic: 8, count: 6 });
  assert.equal(r.questions.length, 6);
  r.questions.forEach((q, i) => {
    assert.equal(q.answers[q.correct], `Alpha ${i + 1}`, `question ${i + 1}: the marked answer is the one the model called correct`);
    assert.equal(q.correct, i % 4, 'deterministic rotation');
    assert.ok(!q.answers.includes('x'), 'only the model answers, not the stray list');
  });
  assert.deepEqual([...new Set(r.questions.map((q) => q.correct))].sort(), [0, 1, 2, 3], 'spread by code');
});

test('I-2: the prompt no longer asks the model for an index or for spreading; the schema has no index', async () => {
  stub.reset();
  stub.respondWith((body) => quizDraftReply(body, [good(1)]));
  await draftQuiz({ topic: 8, count: 1 });
  const body = stub.requests[0].body;
  const schema = body.output_config.format.schema.properties.questions.items;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['correct_answer', 'text', 'wrong_answers']);
  assert.ok(!/index|spread/i.test(JSON.stringify(body.system)), 'no index or "spread" instruction');
});

test('I-2: wrong_answers that are not exactly three, or a missing correct_answer, drop the question', async () => {
  stub.reset();
  const two = { ...good(2), wrong_answers: ['Beta 2', 'Gamma 2'] };
  const none = { text: 'Sample question number 3, about targeting?', wrong_answers: ['a1', 'b1', 'c1'] };
  const dup = { ...good(4), wrong_answers: ['Alpha 4', 'Gamma 4', 'Delta 4'] }; // a wrong answer equal to the right one
  stub.respondWith((body, n) => quizDraftReply(body, n === 1 ? [good(1), two, none, dup] : []));
  const r = await draftQuiz({ topic: 8, count: 4 });
  assert.equal(r.questions.length, 1);
  assert.equal(r.short, 3);
});

test('I-2: draftOne places the answer by code too', async () => {
  stub.reset();
  stub.respondWith((body) => quizDraftReply(body, [{ ...good(9), correct: 0 }]));
  const r = await draftOne({ topic: 8, existing: ['one?', 'two?', 'three?'] });
  assert.equal(r.question.correct, 3); // position = the number of questions already in the quiz, mod 4
  assert.equal(r.question.answers[3], 'Alpha 9');
});

// ---- review B7: near-duplicates are dropped like any other bad question ------------------------------------------
const same = (i, text, answer) => ({ text, correct_answer: answer, wrong_answers: [`Wrong ${i}a`, `Wrong ${i}b`, `Wrong ${i}c`] });

test('B7 two questions with the same right answer: the second is dropped, the repair asks for a different idea', async () => {
  stub.reset();
  stub.respondWith((body, n) => quizDraftReply(body, n === 1
    ? [good(1), good(2), same(5, 'What is the definition of marketing?', 'Creating value for customers'), same(6, 'Which statement defines the job of marketers?', 'creating value for customers.')]
    : [good(9)]));
  const r = await draftQuiz({ topic: 8, count: 4 });
  assert.equal(stub.requests.length, 2, 'one repair call');
  assert.equal(r.questions.length, 4);
  assert.equal(r.questions.filter((q) => /creating value/i.test(q.answers[q.correct])).length, 1);
  const repair = JSON.stringify(stub.requests[1].body.messages.at(-1));
  assert.match(repair, /same correct answer as another question/);
});

test('B7 a reworded repeat of a stem is dropped; repair still short → "drafted N of M"', async () => {
  stub.reset();
  stub.respondWith((body, n) => quizDraftReply(body, n === 1
    ? [same(1, 'Which segmentation base groups buyers by lifestyle?', 'Psychographic'), same(2, 'By lifestyle, buyers are grouped with which segmentation base?', 'Lifestyle base')]
    : [same(3, 'Which base of segmentation groups buyers by their lifestyle?', 'Lifestyle grouping')]));
  const r = await draftQuiz({ topic: 8, count: 2 });
  assert.equal(r.questions.length, 1);
  assert.equal(r.short, 1);
});

test('B7 the repair is checked against the questions already kept (not only against itself)', async () => {
  stub.reset();
  stub.respondWith((body, n) => quizDraftReply(body, n === 1 ? [same(1, 'What is a target market?', 'The buyers a firm chooses to serve'), bad(2)] : [same(3, 'Which group is the target market?', 'the buyers a firm chooses to serve')]));
  const r = await draftQuiz({ topic: 8, count: 2 });
  assert.equal(r.questions.length, 1);
});

test('B7 the prompt tells the model: a different idea each, never the same correct answer twice', async () => {
  stub.reset();
  stub.respondWith((body) => quizDraftReply(body, [good(1)]));
  await draftQuiz({ topic: 8, count: 1 });
  assert.match(String(stub.requests[0].body.system), /Every question must test a different idea/);
  assert.match(String(stub.requests[0].body.system), /never two questions with the same correct answer/);
});

test('B7 draftOne: a near-duplicate of an existing text, or the same right answer as an earlier question, is null', async () => {
  stub.reset();
  stub.respondWith((body) => quizDraftReply(body, [same(1, 'What are target markets?', 'Chosen buyer groups')]));
  assert.equal((await draftOne({ topic: 8, existing: ['What is a target market?'] })).question, null);
  stub.respondWith((body) => quizDraftReply(body, [same(2, 'Which word names the buyers a firm decides to serve?', 'Target market')]));
  const earlier = [{ text: 'What do we call the segment a firm picks?', answers: ['Target market', 'Niche', 'Mass', 'Cluster'], correct: 0 }];
  assert.equal((await draftOne({ topic: 8, existing: [earlier[0].text], earlier })).question, null);
  assert.match(JSON.stringify(stub.requests.at(-1).body), /its correct answer must not be the correct answer of any of them/);
  // A genuinely different idea is kept.
  stub.respondWith((body) => quizDraftReply(body, [same(3, 'Which pricing approach starts high and lowers over time?', 'Skimming')]));
  assert.ok((await draftOne({ topic: 8, existing: [earlier[0].text], earlier })).question);
});
