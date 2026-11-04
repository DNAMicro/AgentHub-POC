// Part 16 Task 4: the Faculty agent's MCP link to the Canvas stand-in (mock tool choice). The live tool choice
// (scripted fake Anthropic) is in test/professor-canvas-live.test.js: the mode is read at import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCanvasLink } from '../src/professor-canvas.js';
import { unusedPort, stopProcess, startCanvas } from './support/harness.js';
import { canvasEnv, newToken, validQuiz, canvasRecords, startTestCanvas, recorder } from './support/canvas-fixtures.js';

async function setup(t, { canvasExtra = {}, linkOpts = {} } = {}) {
  const token = newToken();
  const canvas = await startTestCanvas(token, canvasExtra);
  const rec = recorder();
  const link = createCanvasLink({ url: canvas.url, token, emit: rec.emit, ...linkOpts });
  t.after(async () => { await link.close(); await stopProcess(canvas); });
  return { token, canvas, rec, link };
}

test('approve picks create_quiz and Canvas returns quiz 4821 (steps stripped, stepCount kept)', async (t) => {
  const { canvas, rec, link } = await setup(t);
  const operationId = randomUUID();
  const r = await link.createQuiz({ quiz: validQuiz(), operationId, runId: 'run-1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.receipt.quizId, 4821);
  assert.equal(r.value.receipt.published, false);
  assert.equal('steps' in r.value.receipt, false);
  assert.ok(r.value.receipt.stepCount >= 4);
  assert.equal((await canvasRecords(canvas)).length, 1);
  const started = rec.ofType('mcp_call_started')[0];
  assert.deepEqual([started.data.tool, started.data.moment, started.data.operationId, started.runId], ['create_quiz', 'approve', operationId, 'run-1']);
  const result = rec.ofType('mcp_call_result')[0];
  assert.equal(result.data.ok, true);
  assert.equal(result.data.quizId, 4821);
  assert.equal(result.data.stepCount, r.value.receipt.stepCount);
  assert.deepEqual(rec.ofType('canvas_session').map((e) => e.data.status), ['connected']);
  const text = JSON.stringify(rec.events);
  assert.ok(!text.includes('Sample question') && !text.includes('check_questions'), 'no quiz content or step names in telemetry');
});

test('publish picks publish_quiz and publishes the saved quiz', async (t) => {
  const { canvas, link } = await setup(t);
  const made = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  const r = await link.publishQuiz({ quizId: made.value.receipt.quizId, operationId: randomUUID() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.receipt.published, true);
  assert.equal('steps' in r.value.receipt, false);
  assert.equal((await canvasRecords(canvas))[0].published, true);
});

test('a Canvas refusal keeps its code only if it is in the fixed set', async (t) => {
  const { link } = await setup(t);
  const bad = validQuiz();
  bad.questions[0].answers[1] = bad.questions[0].answers[0];
  const r = await link.createQuiz({ quiz: bad, operationId: randomUUID() });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.code, 'bad_question');
  assert.equal(typeof r.reason, 'string');
  const missing = await link.publishQuiz({ quizId: 9999, operationId: randomUUID() });
  assert.deepEqual([missing.outcome, missing.code], ['refused', 'unknown_quiz']);
});

test('a schema failure at Canvas (error without structured content) is uncertain, not refused', async (t) => {
  const { link } = await setup(t);
  const r = await link.publishQuiz({ quizId: -5, operationId: randomUUID() });
  assert.deepEqual(r, { ok: false, outcome: 'uncertain' });
});

// A tiny scripted MCP server (stateless): the tool throws, or the HTTP answer is a 5xx, or the answer has no receipt.
async function scriptedCanvas(t, mode) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    if (mode === '503' && body?.method === 'tools/call') { res.writeHead(503).end('busy'); return; }
    const mcp = new McpServer({ name: 'scripted', version: '1.0.0' });
    const handler = async () => {
      if (mode === 'throw') throw new Error('boom');
      if (mode === 'empty') return { content: [{ type: 'text', text: '{}' }], structuredContent: {} };
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    mcp.registerTool('create_quiz', { description: 'x', inputSchema: { courseId: z.string(), quiz: z.any(), operationId: z.string() } }, handler);
    mcp.registerTool('publish_quiz', { description: 'x', inputSchema: { courseId: z.string(), quizId: z.number(), operationId: z.string() } }, handler);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const link = createCanvasLink({ url: `http://127.0.0.1:${server.address().port}`, token: 'tok' });
  t.after(async () => { await link.close(); server.close(); server.closeAllConnections(); });
  return link;
}

test('a thrown tool error at Canvas is uncertain (it may have stored the quiz)', async (t) => {
  const link = await scriptedCanvas(t, 'throw');
  assert.deepEqual(await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() }), { ok: false, outcome: 'uncertain' });
});

test('a success-shaped answer with no receipt is uncertain', async (t) => {
  const link = await scriptedCanvas(t, 'empty');
  assert.deepEqual(await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() }), { ok: false, outcome: 'uncertain' });
});

test('an HTTP 5xx during tools/call is uncertain, not unavailable', async (t) => {
  const link = await scriptedCanvas(t, '503');
  assert.deepEqual(await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() }), { ok: false, outcome: 'uncertain' });
});

test('no token: not_configured, no network, no mcp_call_started', async () => {
  const rec = recorder();
  const link = createCanvasLink({ url: `http://127.0.0.1:${await unusedPort()}`, token: undefined, emit: rec.emit });
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.deepEqual(r, { ok: false, outcome: 'not_configured' });
  assert.equal(rec.ofType('mcp_call_started').length, 0);
  assert.deepEqual(rec.ofType('canvas_session').map((e) => e.data.status), ['not_configured']);
  await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.equal(rec.ofType('canvas_session').length, 1, 'reported only on a change');
});

test('isClosed true: closed, no call', async (t) => {
  const { canvas, rec, link } = await setup(t);
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID(), isClosed: () => true });
  assert.deepEqual(r, { ok: false, outcome: 'closed' });
  assert.equal(rec.ofType('mcp_call_started').length, 0);
  assert.equal((await canvasRecords(canvas)).length, 0);
});

test('a card closed during the tool choice makes no call', async (t) => {
  const { canvas, rec, link } = await setup(t);
  let asked = 0;
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID(), isClosed: () => (asked += 1) > 1 });
  assert.deepEqual(r, { ok: false, outcome: 'closed' });
  assert.equal(rec.ofType('mcp_call_started').length, 0);
  assert.equal((await canvasRecords(canvas)).length, 0);
});

test('Canvas stopped: unavailable, and the session pill says unreachable', async (t) => {
  const { canvas, rec, link } = await setup(t);
  await stopProcess(canvas);
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.deepEqual(r, { ok: false, outcome: 'unavailable' });
  assert.ok(rec.ofType('canvas_session').some((e) => e.data.status === 'unreachable'));
  assert.equal(rec.ofType('mcp_call_started').length, 0);
});

test('a wrong token is unavailable', async (t) => {
  const { canvas } = await setup(t);
  const link = createCanvasLink({ url: canvas.url, token: newToken() });
  t.after(() => link.close());
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.deepEqual(r, { ok: false, outcome: 'unavailable' });
});

test('a call slower than the budget is uncertain; the retry with the same operationId saves once', async (t) => {
  const { canvas, rec, link } = await setup(t, { canvasExtra: { CANVAS_TEST_DELAY_MS: '1500' }, linkOpts: { timeoutMs: 300 } });
  const operationId = randomUUID();
  const first = await link.createQuiz({ quiz: validQuiz(), operationId });
  assert.deepEqual(first, { ok: false, outcome: 'uncertain' });
  assert.equal(rec.ofType('mcp_call_result').at(-1).data.outcome, 'uncertain');
  // Canvas wrote it anyway; the repeat gets the stored receipt, not a second quiz.
  const again = await link.createQuiz({ quiz: validQuiz(), operationId });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.value.receipt.quizId, 4821);
  assert.equal((await canvasRecords(canvas)).length, 1);
});

test('Canvas restarted (session unknown): reconnects once and succeeds', async (t) => {
  const token = newToken();
  const port = await unusedPort();
  const env = canvasEnv(token, { PORT: String(port) });
  let canvas = await startCanvas(env);
  const rec = recorder();
  const link = createCanvasLink({ url: canvas.url, token, emit: rec.emit });
  t.after(async () => { await link.close(); await stopProcess(canvas); });
  assert.equal((await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() })).ok, true);
  await stopProcess(canvas);
  canvas = await startCanvas(env);
  const r = await link.createQuiz({ quiz: validQuiz(), operationId: randomUUID() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.receipt.quizId, 4821, 'the fresh Canvas numbers from 4821 again');
  assert.equal(rec.ofType('mcp_call_started').length, 2, 'one started event per call; the reconnect resend is not a second call');
});

test('the receipt never carries steps and the link stays cache-free', async (t) => {
  const { link } = await setup(t);
  const operationId = randomUUID();
  const a = await link.createQuiz({ quiz: validQuiz(), operationId });
  const b = await link.createQuiz({ quiz: validQuiz(), operationId });
  assert.equal(JSON.stringify(a).includes('steps"'), false);
  assert.deepEqual(a.value.receipt, b.value.receipt);
});
