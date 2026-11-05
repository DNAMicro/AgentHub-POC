// Part 17: student records' own AI (step planner). Mock is a labelled heuristic; live runs against the fake Messages API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';

const REQUIRED = ['check_instructor', 'read_enrollment', 'mask_private_fields'];
let fake; let live; let mock;
before(async () => {
  fake = await startFakeAnthropic();
  Object.assign(process.env, { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'placeholder-not-a-key', TUTOR_LOAD_DOTENV: '0' });
  process.env.STUDENT_RECORDS_MODE = 'mock';
  mock = await import('../src/student-records-model.js?mode=mock');
  process.env.STUDENT_RECORDS_MODE = 'live';
  live = await import('../src/student-records-model.js?mode=live');
});
after(async () => { await fake.close(); });

test('mock plan holds the required steps in menu order', async () => {
  const plan = await mock.planSteps({ request: { courseId: 'mkt-351' } });
  assert.equal(plan.by, 'mock');
  assert.equal(plan.model, 'mock heuristic');
  assert.deepEqual(plan.steps, ['check_instructor', 'check_term', 'read_enrollment', 'mask_private_fields']);
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(mock.studentRecordsStatus(), { mode: 'mock', model: 'mock heuristic', keyConfigured: null });
});

test('live: unknown and duplicate picks are dropped; required steps are added', async () => {
  fake.reset();
  fake.respondWith(() => messageReply('{"steps":["check_term","drop_table","check_term"]}'));
  const events = [];
  const plan = await live.planSteps({ request: { courseId: 'mkt-351' }, emit: (t, d) => events.push([t, d]) });
  assert.deepEqual(plan.steps, ['check_instructor', 'check_term', 'read_enrollment', 'mask_private_fields']);
  assert.equal(plan.by, 'model');
  assert.deepEqual(events.map((e) => e[0]), ['model_call_started', 'model_response_received']);
  assert.equal(events[0][1].purpose, 'plan student records steps');
  assert.equal(live.studentRecordsStatus().keyConfigured, true);
});

test('live failure falls back to required steps only, by model_failed', async () => {
  fake.reset();
  fake.respondWith(() => ({ status: 500 }));
  const events = [];
  const plan = await live.planSteps({ request: { courseId: 'mkt-351' }, emit: (t, d) => events.push([t, d]) });
  assert.equal(plan.by, 'model_failed');
  assert.deepEqual(plan.steps, REQUIRED);
  assert.deepEqual(events.map((e) => e[0]), ['model_call_started', 'model_call_failed']);
});
