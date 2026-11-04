// Part 15 fix round 1: the staff-path time budgets nest — every outer wait is longer than everything it waits on,
// so the innermost honest answer (HR's “PeopleSoft didn't answer …”) is the one the professor sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMEOUTS as T } from '../src/timeouts.js';
import { loadHubConfig } from '../src/config.js';

test('the default budgets nest: each outer timeout is longer than the sum of what runs inside it', () => {
  assert.equal(T.peoplesoftPlannerMs, 8000);
  assert.equal(T.hrToolChoiceMs, 8000);
  assert.equal(T.hrAbsenceModelMs, 30000);
  assert.equal(T.hrPeopleSoftCallMs, 12000);
  assert.equal(T.hubStaffActionMs, 25000);
  // Inside one PeopleSoft call: the planner model.
  assert.ok(T.hrPeopleSoftCallMs > T.peoplesoftPlannerMs);
  // The call's floor (planner + 2 s, src/hr-peoplesoft.js) fits inside the shared budget with at least 1 s left for the connect.
  assert.ok(T.hrPeopleSoftCallMs >= T.peoplesoftPlannerMs + 2000 + 1000);
  // A Submit at HR: the tool choice, then the PeopleSoft call — inside the Hub's staff-action wait.
  assert.ok(T.hubStaffActionMs > T.hrToolChoiceMs + T.hrPeopleSoftCallMs);
  // A card issue at HR: the absence name, the tool choice, the balances call — inside the Hub's dispatch wait.
  assert.ok(T.hubDispatchMs > T.hrAbsenceModelMs + T.hrToolChoiceMs + T.hrPeopleSoftCallMs);
  // The outer chain: Professor → Hub (staff action or request), Hub dev proxy → Professor, UI server → Hub proxy.
  assert.ok(T.professorStaffMs > Math.max(T.hubStaffActionMs, T.hubDispatchMs));
  assert.ok(T.hubAuthorProxyMs > T.professorStaffMs);
  assert.ok(T.uiProfessorCallMs > T.hubAuthorProxyMs);
  // Students keep their short form-action wait.
  assert.equal(T.hubFormActionMs, 8000);
});

test('the Hub configuration uses the staff budget for staff actions (env override HUB_STAFF_ACTION_TIMEOUT_MS)', () => {
  const saved = process.env.HUB_STAFF_ACTION_TIMEOUT_MS;
  delete process.env.HUB_STAFF_ACTION_TIMEOUT_MS;
  try {
    const cfg = loadHubConfig();
    assert.equal(cfg.timeouts.staffActionMs, T.hubStaffActionMs);
    assert.equal(cfg.timeouts.formActionMs, T.hubFormActionMs);
    assert.equal(cfg.timeouts.dispatchMs, T.hubDispatchMs);
    process.env.HUB_STAFF_ACTION_TIMEOUT_MS = '31000';
    assert.equal(loadHubConfig().timeouts.staffActionMs, 31000);
  } finally {
    if (saved === undefined) delete process.env.HUB_STAFF_ACTION_TIMEOUT_MS; else process.env.HUB_STAFF_ACTION_TIMEOUT_MS = saved;
  }
});

test('each site reads its budget from the shared defaults', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = async (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.match(await src('hub-agent.js'), /async function staffAction[\s\S]*?timeoutMs: cfg\.timeouts\.staffActionMs/);
  assert.match(await src('hub-agent.js'), /\/author\$\{path\}`[\s\S]{0,300}AbortSignal\.timeout\(TIMEOUTS\.hubAuthorProxyMs\)/);
  assert.match(await src('ui-server.js'), /AbortSignal\.timeout\(TIMEOUTS\.uiProfessorCallMs\)/);
  assert.match(await src('professor-staff.js'), /STAFF_TIMEOUT_MS = TIMEOUTS\.professorStaffMs/);
  assert.match(await src('hr-model.js'), /HR_TOOL_CHOICE_TIMEOUT_MS \?\? TIMEOUTS\.hrToolChoiceMs/);
  assert.match(await src('hr-model.js'), /HR_MODEL_TIMEOUT_MS \?\? TIMEOUTS\.hrAbsenceModelMs/);
  assert.match(await src('hr-agent.js'), /PEOPLESOFT_TIMEOUT_MS \?\? TIMEOUTS\.hrPeopleSoftCallMs/);
  assert.match(await src('peoplesoft-model.js'), /PEOPLESOFT_MODEL_TIMEOUT_MS \?\? TIMEOUTS\.peoplesoftPlannerMs/);
});

test('Part 15 Task 5: the Professor staff classifier fits inside the proxy budget', async () => {
  const { readFile } = await import('node:fs/promises');
  assert.equal(T.professorStaffClassifierMs, 10000);
  // The classifier runs, then the Hub staff wait: both inside the Professor → Hub proxy wait, which is inside the UI's.
  assert.ok(T.professorStaffClassifierMs + T.professorStaffMs < T.hubAuthorProxyMs);
  assert.ok(T.hubAuthorProxyMs < T.uiProfessorCallMs);
  assert.equal(T.hubAuthorProxyMs, 80000);
  assert.match(await readFile(new URL('../src/professor-model.js', import.meta.url), 'utf8'), /maxTokens: 300, timeoutMs: STAFF_CLASSIFIER_TIMEOUT_MS, schema: STAFF_SCHEMA/);
  assert.equal(T.uiProfessorCallMs, 85000);
});
