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

const good = (i) => ({ text: `Sample question number ${i}, about segmentation?`, answers: [`Alpha ${i}`, `Beta ${i}`, `Gamma ${i}`, `Delta ${i}`], correct: i % 4 });
const bad = (i) => ({ text: `Q${i}`, answers: ['a', 'a', 'b', 'c'], correct: 0 });
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
  const dated = { text: 'What was decided on October 3 about segmenting?', answers: ['One', 'Two', 'Three', 'Four'], correct: 0 };
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
