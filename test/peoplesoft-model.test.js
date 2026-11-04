// Part 15: PeopleSoft's own AI (step planner). Mock is a labelled heuristic; live runs against the fake Messages API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';

const REQUIRED = ['check_balance', 'check_dates_and_holidays', 'check_overlap', 'store_record'];
const request = { absenceType: 'VAC', beginDate: '2026-11-09', endDate: '2026-11-10', hours: 16 };
let fake;
let live;
let mock;

before(async () => {
  fake = await startFakeAnthropic();
  Object.assign(process.env, { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'placeholder-not-a-key', TUTOR_LOAD_DOTENV: '0' });
  process.env.PEOPLESOFT_MODE = 'mock';
  mock = await import('../src/peoplesoft-model.js?mode=mock');
  process.env.PEOPLESOFT_MODE = 'live';
  live = await import('../src/peoplesoft-model.js?mode=live');
});
after(async () => { await fake.close(); });

test('mock plan always holds the required steps in menu order', async () => {
  const plan = await mock.planSteps({ request });
  assert.equal(plan.by, 'mock');
  assert.equal(plan.model, 'mock heuristic');
  assert.deepEqual(plan.steps, ['check_balance', 'check_dates_and_holidays', 'check_overlap', 'apply_leave_policy', 'route_to_manager', 'store_record']);
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(mock.peoplesoftStatus(), { mode: 'mock', model: 'mock heuristic', keyConfigured: null });
});

test('live: unknown and duplicate picks are dropped; required steps are added', async () => {
  fake.reset();
  fake.respondWith(() => messageReply('{"steps":["notify_timekeeper","delete_everything","notify_timekeeper"]}'));
  const events = [];
  const plan = await live.planSteps({ request, emit: (type, data) => events.push([type, data]) });
  assert.deepEqual(plan.steps, ['check_balance', 'check_dates_and_holidays', 'check_overlap', 'notify_timekeeper', 'store_record']);
  assert.equal(plan.by, 'model');
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(events.map((e) => e[0]), ['model_call_started', 'model_response_received']);
  assert.equal(events[0][1].purpose, 'plan PeopleSoft steps');
  assert.equal(live.peoplesoftStatus().mode, 'live');
  assert.equal(live.peoplesoftStatus().keyConfigured, true);
});

test('live failure falls back to required + route_to_manager, by model_failed', async () => {
  fake.reset();
  fake.respondWith(() => ({ status: 500 }));
  const events = [];
  const plan = await live.planSteps({ request, emit: (type, data) => events.push([type, data]) });
  assert.equal(plan.by, 'model_failed');
  assert.deepEqual(plan.steps, ['check_balance', 'check_dates_and_holidays', 'check_overlap', 'route_to_manager', 'store_record']);
  assert.deepEqual(events.map((e) => e[0]), ['model_call_started', 'model_call_failed']);
  assert.deepEqual(REQUIRED.filter((s) => !plan.steps.includes(s)), []);
});
