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
  // Part 17: CHRS's lookup (tool choice, then the records call whose planner model sits inside it), the Hub's roster
  // lookup for a post, and the Professor's publish wait (one lookup + the Student delivery of 5 s).
  assert.equal(T.chrsToolChoiceMs, 8000);
  assert.equal(T.chrsRecordsCallMs, 12000);
  assert.ok(T.chrsRecordsCallMs > T.studentRecordsPlannerMs);
  assert.equal(T.hubRosterLookupMs, 22000);
  assert.equal(T.professorPublishMs, 50000);
  assert.ok(T.hubRosterLookupMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs);
  assert.ok(T.hubDispatchMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs);
  assert.ok(T.professorPublishMs > T.hubRosterLookupMs + 5000);
  // Review C16: after the deliveries the Hub asks CHRS to email the students who aren't online (tool choice + records call),
  // all inside the publish wait. Review C12: a cancellation reads the class's time and room first, then publishes.
  assert.equal(T.hubEmailNoticeMs, 22000);
  assert.ok(T.hubEmailNoticeMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs);
  assert.ok(T.professorPublishMs > T.hubRosterLookupMs + 5000 + T.hubEmailNoticeMs);
  assert.equal(T.professorClassInfoMs, 25000);
  assert.ok(T.professorClassInfoMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs);
  assert.ok(T.hubAuthorProxyMs > T.professorClassInfoMs + T.professorPublishMs);
  // Review #3: Submit on the HR card waits for HR, then reads the class record for the cancellation preview card; Send on
  // that card reads it again and publishes (both inside the author proxy).
  assert.ok(T.hubAuthorProxyMs > T.professorStaffMs + T.professorClassInfoMs);
  assert.ok(T.hubAuthorProxyMs > T.professorPublishMs);
  // Part 17 final review (finding 4): a chat post runs the Professor's staff-or-class check, its own model (naming the post
  // or reading an @assistant message) and then the publish — all inside the Hub's author proxy, which is inside the UI's wait.
  assert.equal(T.professorModelMs, 45000);
  assert.ok(T.hubAuthorProxyMs > T.professorModelMs + T.professorPublishMs);
  assert.ok(T.hubAuthorProxyMs > T.professorStaffClassifierMs + T.professorModelMs + T.professorPublishMs);
  assert.ok(T.uiProfessorCallMs > T.hubAuthorProxyMs);
  // A roster question in general (2026-11-05): one roster lookup (the staff request wait), then the query model.
  assert.equal(T.professorRosterQueryMs, 10000);
  assert.ok(T.hubAuthorProxyMs > T.professorStaffMs + T.professorRosterQueryMs);
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
  assert.match(await src('professor-model.js'), /PROFESSOR_MODEL_TIMEOUT_MS \?\? TIMEOUTS\.professorModelMs/);
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
  assert.equal(T.hubAuthorProxyMs, 110000);
  assert.match(await readFile(new URL('../src/professor-model.js', import.meta.url), 'utf8'), /maxTokens: 300, timeoutMs: STAFF_CLASSIFIER_TIMEOUT_MS, schema: STAFF_SCHEMA/);
  assert.equal(T.uiProfessorCallMs, 115000);
});

test('Part 16 Task 4: the Canvas budget nests inside the Faculty author route', () => {
  assert.equal(T.canvasPlannerMs, 8000);
  assert.equal(T.professorCanvasToolChoiceMs, 8000);
  assert.equal(T.professorCanvasCallMs, 12000);
  assert.equal(T.professorQuizDraftMs, 30000);
  assert.equal(T.professorQuizRepairMs, 20000);
  assert.equal(T.professorQuizOneMoreMs, 15000);
  assert.ok(T.canvasPlannerMs < T.professorCanvasCallMs);
  // The call keeps planner + 2 s and at least 1 s is left for the connect (src/professor-canvas.js CALL_FLOOR_MS).
  assert.ok(T.professorCanvasCallMs >= T.canvasPlannerMs + 2000 + 1000);
  assert.ok(T.professorCanvasToolChoiceMs + T.professorCanvasCallMs < T.hubAuthorProxyMs);
  assert.ok(T.professorQuizDraftMs + T.professorQuizRepairMs < T.hubAuthorProxyMs);
  assert.ok(T.professorQuizOneMoreMs < T.hubAuthorProxyMs);
});

test('Part 16 Task 4: Faculty reads its Canvas budgets from the shared defaults', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = async (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.match(await src('professor-model.js'), /PROFESSOR_CANVAS_TOOL_CHOICE_TIMEOUT_MS \?\? TIMEOUTS\.professorCanvasToolChoiceMs/);
  assert.match(await src('professor-canvas.js'), /timeoutMs = TIMEOUTS\.professorCanvasCallMs/);
  assert.match(await src('professor-canvas.js'), /CALL_FLOOR_MS = TIMEOUTS\.canvasPlannerMs \+ 2000/);
});

test('Part 17: student records planner budget is 8 s and read from TIMEOUTS', async () => {
  const { readFile } = await import('node:fs/promises');
  assert.equal(T.studentRecordsPlannerMs, 8000);
  assert.match(await readFile(new URL('../src/student-records-model.js', import.meta.url), 'utf8'), /STUDENT_RECORDS_MODEL_TIMEOUT_MS \?\? TIMEOUTS\.studentRecordsPlannerMs/);
});

test('Part 17 Task 2: the CHRS budget nests inside the Hub staff waits', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = async (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.equal(T.chrsToolChoiceMs, 8000);
  assert.equal(T.chrsRecordsCallMs, 12000);
  assert.ok(T.studentRecordsPlannerMs < T.chrsRecordsCallMs);
  // The call keeps planner + 2 s and at least 1 s is left for the connect (src/chrs-records.js CALL_FLOOR_MS).
  assert.ok(T.chrsRecordsCallMs >= T.studentRecordsPlannerMs + 2000 + 1000);
  // A roster request at CHRS: the tool choice, then the records call — inside the Hub's dispatch wait and the Professor's wait.
  assert.ok(T.hubDispatchMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs);
  assert.ok(T.professorStaffMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs);
  assert.match(await src('chrs-model.js'), /CHRS_TOOL_CHOICE_TIMEOUT_MS \?\? TIMEOUTS\.chrsToolChoiceMs/);
  assert.match(await src('chrs-agent.js'), /STUDENT_RECORDS_TIMEOUT_MS \?\? TIMEOUTS\.chrsRecordsCallMs/);
  assert.match(await src('chrs-records.js'), /CALL_FLOOR_MS = TIMEOUTS\.studentRecordsPlannerMs \+ 2000/);
});
