// Part 16: Canvas's own AI (step planner). Mock is a labelled heuristic; live runs against the fake Messages API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import { TIMEOUTS } from '../src/timeouts.js';

const quiz = { topic: 1, title: 'Topic 1 Quiz', questions: [] };
let fake;
let live;
let mock;

before(async () => {
  fake = await startFakeAnthropic();
  Object.assign(process.env, { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'placeholder-not-a-key', TUTOR_LOAD_DOTENV: '0' });
  process.env.CANVAS_MODE = 'mock';
  mock = await import('../src/canvas-model.js?mode=mock');
  process.env.CANVAS_MODE = 'live';
  live = await import('../src/canvas-model.js?mode=live');
});
after(async () => { await fake.close(); });

test('planner timeout is 8 s', () => assert.equal(TIMEOUTS.canvasPlannerMs, 8000));

test('mock plan holds the required steps in menu order, store_quiz last', async () => {
  const plan = await mock.planSteps({ quiz });
  assert.equal(plan.by, 'mock');
  assert.equal(plan.model, 'mock heuristic');
  assert.deepEqual(mock.REQUIRED_STEPS, ['check_questions', 'check_settings', 'check_due_date', 'store_quiz']);
  assert.deepEqual(plan.steps, ['check_questions', 'check_settings', 'check_due_date', 'check_course', 'set_unpublished', 'store_quiz']);
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(mock.canvasStatus(), { mode: 'mock', model: 'mock heuristic', keyConfigured: null });
});

test('live: unknown picks dropped, required added, store_quiz last', async () => {
  fake.reset();
  fake.respondWith(() => messageReply('{"steps":["set_unpublished","bogus"]}'));
  const events = [];
  const plan = await live.planSteps({ quiz, emit: (type, data) => events.push([type, data]) });
  assert.equal(plan.by, 'model');
  assert.deepEqual(plan.steps, ['check_questions', 'check_settings', 'check_due_date', 'set_unpublished', 'store_quiz']);
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(events.map((e) => e[0]), ['model_call_started', 'model_response_received']);
  assert.equal(JSON.stringify(fake.requests).includes('Topic 1 Quiz'), false, 'titles/questions are not sent to the model');
  assert.equal(live.canvasStatus().mode, 'live');
  assert.equal(live.canvasStatus().keyConfigured, true);
});

test('live: store_quiz listed early still ends last', async () => {
  fake.reset();
  fake.respondWith(() => messageReply('{"steps":["store_quiz","check_course"]}'));
  const plan = await live.planSteps({ quiz });
  assert.equal(plan.steps.at(-1), 'store_quiz');
  assert.equal(plan.steps.filter((s) => s === 'store_quiz').length, 1);
});

test('live failure still returns the required steps, by model_failed', async () => {
  fake.reset();
  fake.respondWith(() => ({ status: 500 }));
  const events = [];
  const plan = await live.planSteps({ quiz, emit: (type, data) => events.push([type, data]) });
  assert.equal(plan.by, 'model_failed');
  assert.deepEqual(plan.steps, ['check_questions', 'check_settings', 'check_due_date', 'set_unpublished', 'store_quiz']);
  assert.deepEqual(events.map((e) => e[0]), ['model_call_started', 'model_call_failed']);
});
