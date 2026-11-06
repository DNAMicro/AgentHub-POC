// Part 16 Task 4: the Faculty AI's Canvas tool choice, live mode against the scripted fake Anthropic API (never a
// real key, never the network). Plumbing only: this proves what code does with a pick, not how a real model picks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFakeAnthropic, canvasToolReply, messageReply } from './support/fake-anthropic.js';
import { stopProcess } from './support/harness.js';
import { newToken, validQuiz, canvasRecords, startTestCanvas, recorder } from './support/canvas-fixtures.js';

const stub = await startFakeAnthropic();
process.env.PROFESSOR_MODE = 'live';
process.env.ANTHROPIC_API_KEY = `sk-ant-test-${randomUUID()}`;
process.env.ANTHROPIC_BASE_URL = stub.url;
process.env.TUTOR_LOAD_DOTENV = '0';
const { createCanvasLink } = await import('../src/professor-canvas.js');
const { chooseCanvasTool } = await import('../src/professor-model.js');

test.after(() => stub.close());

async function setup(t) {
  const token = newToken();
  const canvas = await startTestCanvas(token);
  const rec = recorder();
  const link = createCanvasLink({ url: canvas.url, token, emit: rec.emit });
  t.after(async () => { await link.close(); await stopProcess(canvas); });
  stub.reset();
  return { canvas, rec, link };
}

test('the model picks the moment’s own tool and the quiz is saved', async (t) => {
  const { canvas, rec, link } = await setup(t);
  stub.respondWith((body) => canvasToolReply(body));
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.receipt.quizId, 4821);
  assert.equal((await canvasRecords(canvas)).length, 1);
  assert.equal(stub.requests.length, 1, 'one model call');
  assert.ok(!JSON.stringify(stub.requests[0].body).includes('Sample question'), 'the quiz is never sent to the tool-choice model');
  assert.ok(rec.ofType('model_call_started').length === 1 && rec.ofType('model_response_received').length === 1);
});

test('publish_quiz picked at approve: tool_refused, Canvas has 0 quizzes', async (t) => {
  const { canvas, rec, link } = await setup(t);
  stub.respondWith((body) => canvasToolReply(body, { approve: 'publish_quiz' }));
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.deepEqual(r, { ok: false, outcome: 'tool_refused' });
  const refused = rec.ofType('mcp_tool_refused')[0];
  assert.deepEqual([refused.data.tool, refused.data.moment, refused.data.expected, refused.data.by], ['publish_quiz', 'approve', 'create_quiz', 'model']);
  assert.equal(rec.ofType('mcp_call_started').length, 0);
  assert.equal((await canvasRecords(canvas)).length, 0);
});

test('a 500 at the tool choice is tool_choice_failed (not a wrong pick), nothing called', async (t) => {
  const { canvas, rec, link } = await setup(t);
  stub.respondWith(() => ({ status: 500 }));
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.deepEqual(r, { ok: false, outcome: 'tool_choice_failed' });
  assert.equal(rec.ofType('mcp_tool_refused')[0].data.by, 'model_failed');
  assert.equal(rec.ofType('model_call_failed').length, 1);
  assert.equal(rec.ofType('mcp_call_started').length, 0);
  assert.equal((await canvasRecords(canvas)).length, 0);
});

test('an unknown tool name from the model picks nothing', async () => {
  stub.reset();
  stub.respondWith(() => messageReply(JSON.stringify({ tool: 'delete_everything' })));
  const r = await chooseCanvasTool({ moment: 'approve', tools: ['create_quiz', 'publish_quiz'] });
  assert.equal(r.tool, null);
  assert.equal(r.by, 'model');
});

test('no tools listed, or an unknown moment: no model call, model_failed', async () => {
  stub.reset();
  assert.equal((await chooseCanvasTool({ moment: 'approve', tools: [] })).by, 'model_failed');
  assert.equal((await chooseCanvasTool({ moment: 'nope', tools: ['create_quiz'] })).by, 'model_failed');
  assert.equal(stub.requests.length, 0);
});

// ---- review C15: the third moment ("check") ------------------------------------------------------------------------
test('C15 live: the model picks list_course_students and the course list comes back', async (t) => {
  const { link } = await setup(t);
  stub.respondWith((body) => canvasToolReply(body));
  const r = await link.listStudents({ runId: 'run-x' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.students.length, 24);
  assert.match(String(stub.requests[0].body.system), /list the students enrolled in the course in Canvas/);
});

test('C15 live: create_quiz picked at the check moment is refused, nothing called', async (t) => {
  const { canvas, rec, link } = await setup(t);
  stub.respondWith((body) => canvasToolReply(body, { check: 'create_quiz' }));
  assert.deepEqual(await link.listStudents({}), { ok: false, outcome: 'tool_refused' });
  const refused = rec.ofType('mcp_tool_refused')[0];
  assert.deepEqual([refused.data.tool, refused.data.moment, refused.data.expected], ['create_quiz', 'check', 'list_course_students']);
  assert.equal(rec.ofType('mcp_call_started').length, 0);
  assert.equal((await canvasRecords(canvas)).length, 0);
});

test('C15 live: a failed tool choice at the check moment is tool_choice_failed', async (t) => {
  const { link } = await setup(t);
  stub.respondWith(() => ({ status: 500 }));
  assert.deepEqual(await link.listStudents({}), { ok: false, outcome: 'tool_choice_failed' });
});
