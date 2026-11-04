// Canvas LMS stand-in MCP server: two tools, a token, a reset. Mock planner only; no network.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCanvas } from './support/harness.js';
import { defaultSettings } from '../src/quiz-rules.js';

const NOW = '2026-11-04T18:00:00Z';
const TOKEN = 'canvas-test-token-xyz';
let cv;
before(async () => { cv = await startCanvas({ CANVAS_TOKEN: TOKEN, CANVAS_TEST_HOOKS: '1', CANVAS_MODE: 'mock', CANVAS_NOW: NOW }); });
after(() => { cv?.proc.kill(); });

async function connect(token = TOKEN) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${cv.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const reset = () => fetch(`${cv.url}/dev/reset`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
const quizzes = async () => (await (await fetch(`${cv.url}/test/quizzes`)).json()).quizzes;
const QUESTION = 'Which statement about the marketing mix is correct?';
const q = (i) => ({ text: `${QUESTION} (variant ${i})`, answers: ['Alpha', 'Beta', 'Gamma', 'Delta'], correct: 2 });
const quiz = (extra = {}) => ({ topic: 1, ...defaultSettings(1, new Date(NOW)), questions: [q(1), q(2), q(3)], ...extra });
const create = (c, over = {}) => c.callTool({ name: 'create_quiz', arguments: { courseId: 'mkt-351', quiz: quiz(), operationId: 'create-0001', ...over } });

test('lists exactly two tools with the stand-in prefix', async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['create_quiz', 'publish_quiz']);
  for (const t of tools) assert.match(t.description, /^Demo stand-in for Canvas LMS:/);
  await c.close();
});

test('create then publish: 4821 unpublished, then published; reset restarts numbering', async () => {
  await reset();
  const c = await connect();
  const made = await create(c);
  assert.notEqual(made.isError, true, JSON.stringify(made));
  const r = made.structuredContent.receipt;
  assert.equal(r.quizId, 4821);
  assert.equal(r.published, false);
  assert.equal(r.courseLabel, 'MKTG 351 (Fall 2026)');
  assert.equal(r.stepCount, r.steps.length);
  assert.ok(r.steps.includes('store_quiz'));
  assert.deepEqual(JSON.parse(made.content[0].text), made.structuredContent);
  assert.equal('questions' in r, false, 'no answer key in the receipt');
  const pub = await c.callTool({ name: 'publish_quiz', arguments: { courseId: 'mkt-351', quizId: 4821, operationId: 'publish-0001' } });
  assert.equal(pub.structuredContent.receipt.published, true);
  assert.equal(pub.structuredContent.receipt.stepCount, 2);
  assert.equal((await quizzes())[0].published, true);
  assert.equal((await reset()).status, 200);
  assert.deepEqual(await quizzes(), []);
  const again = await create(c, { operationId: 'create-0002' });
  assert.equal(again.structuredContent.receipt.quizId, 4821);
  await c.close();
});

test('same operationId returns the stored receipt; different quiz is operation_reused', async () => {
  await reset();
  const c = await connect();
  const a = await create(c, { operationId: 'repeat-0001' });
  const b = await create(c, { operationId: 'repeat-0001' });
  assert.deepEqual(a.structuredContent, b.structuredContent);
  assert.equal((await quizzes()).length, 1);
  const d = await create(c, { operationId: 'repeat-0001', quiz: quiz({ questions: [q(9)] }) });
  assert.equal(d.isError, true);
  assert.equal(d.structuredContent.code, 'operation_reused');
  await c.close();
});

test('bad input is a refusal with a code, not a crash', async () => {
  await reset();
  const c = await connect();
  const bad = await create(c, { operationId: 'bad-q-0001', quiz: quiz({ questions: [{ text: 'short', answers: ['a', 'b', 'c', 'd'], correct: 0 }] }) });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.code, 'bad_question');
  for (const odd of ['text', null, [], { questions: 5 }]) {
    const r = await create(c, { operationId: 'odd-input-01', quiz: odd });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent?.code, 'bad_question', JSON.stringify(odd));
  }
  const course = await create(c, { operationId: 'bad-course-1', courseId: 'other' });
  assert.equal(course.structuredContent.code, 'unknown_course');
  const none = await c.callTool({ name: 'publish_quiz', arguments: { courseId: 'mkt-351', quizId: 9999, operationId: 'pub-none-01' } });
  assert.equal(none.structuredContent.code, 'unknown_quiz');
  assert.deepEqual(await quizzes(), []);
  await c.close();
});

test('tool inputs are validated: operationId shape, quizId integer, courseId string', async () => {
  const c = await connect();
  const refused = async (name, args) => { try { const r = await c.callTool({ name, arguments: args }); return r.isError === true; } catch { return true; } };
  assert.equal(await refused('create_quiz', { courseId: 'mkt-351', quiz: quiz(), operationId: 'x' }), true);
  assert.equal(await refused('create_quiz', { courseId: 'mkt-351', quiz: quiz(), operationId: 'has space here' }), true);
  assert.equal(await refused('create_quiz', { courseId: 'mkt-351', quiz: quiz() }), true);
  assert.equal(await refused('create_quiz', { courseId: 5, quiz: quiz(), operationId: 'abcdef12' }), true);
  assert.equal(await refused('publish_quiz', { courseId: 'mkt-351', quizId: 1.5, operationId: 'abcdef12' }), true);
  assert.equal(await refused('publish_quiz', { courseId: 'mkt-351', quizId: -1, operationId: 'abcdef12' }), true);
  assert.equal(await refused('publish_quiz', { courseId: 'mkt-351', quizId: '4821', operationId: 'abcdef12' }), true);
  await c.close();
});

test('refuses calls without the right token; reset needs the token and a same-origin caller', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const h of [headers, { ...headers, Authorization: 'Bearer wrong' }]) {
    const res = await fetch(`${cv.url}/mcp`, { method: 'POST', headers: h, body });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  assert.equal((await fetch(`${cv.url}/dev/reset`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${cv.url}/dev/reset`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' } })).status, 403);
});

test('GET /test/quizzes is absent without the test hook', async () => {
  const own = await startCanvas({ CANVAS_TOKEN: 't', CANVAS_MODE: 'mock' });
  try { assert.equal((await fetch(`${own.url}/test/quizzes`)).status, 404); } finally { own.proc.kill(); }
});

test('starting without CANVAS_TOKEN exits 1 and prints no token', async () => {
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, PORT: '0' };
  delete env.CANVAS_TOKEN;
  const p = spawn(process.execPath, ['src/canvas-mcp.js'], { env });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 1);
  assert.match(out, /CANVAS_TOKEN is required/);
});

test('stdout never contains the token or a question text', async () => {
  const own = await startCanvas({ CANVAS_TOKEN: 'secret-log-token-777', CANVAS_TEST_HOOKS: '1', CANVAS_NOW: NOW, CANVAS_MODE: 'mock' });
  const lines = [];
  own.proc.stdout.on('data', (d) => lines.push(String(d)));
  own.proc.stderr.on('data', (d) => lines.push(String(d)));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${own.url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer secret-log-token-777' } } }));
  await create(client, { operationId: 'log-check-01' });
  await create(client, { operationId: 'log-check-02', quiz: quiz({ questions: [{ text: 'tiny', answers: ['a', 'b', 'c', 'd'], correct: 0 }] }) });
  await client.close();
  await new Promise((r) => setTimeout(r, 100));
  own.proc.kill();
  const all = lines.join('');
  assert.match(all, /created operationId=log-check-01/);
  assert.doesNotMatch(all, /secret-log-token-777/);
  assert.doesNotMatch(all, /marketing mix|Alpha|Topic 1 Quiz/);
});

test('malformed JSON gets a JSON 400 with no HTML or stack', async () => {
  const res = await fetch(`${cv.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{not json' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request' });
});

test('New conversation while the planner thinks: the old save is refused and the fresh store stays empty', async (t) => {
  const { startFakeAnthropic, messageReply } = await import('./support/fake-anthropic.js');
  const { randomUUID } = await import('node:crypto');
  const fake = await startFakeAnthropic();
  t.after(() => fake.close());
  fake.respondWith(() => ({ ...messageReply('{"steps":["set_unpublished"]}'), delayMs: 1500 }));
  const own = await startCanvas({ CANVAS_TOKEN: 't', CANVAS_TEST_HOOKS: '1', CANVAS_NOW: NOW, CANVAS_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: fake.url, TUTOR_LOAD_DOTENV: '0' });
  t.after(() => own.proc.kill());
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${own.url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer t' } } }));
  t.after(() => client.close());
  const pending = create(client, { operationId: 'race-0001' });
  const deadline = Date.now() + 5000;
  while (!fake.requests.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.requests.length, 1, 'the planner was asked');
  assert.equal((await fetch(`${own.url}/dev/reset`, { method: 'POST', headers: { Authorization: 'Bearer t' } })).status, 200);
  const r = await pending;
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent));
  assert.equal(r.structuredContent.code, 'reset_during_call');
  assert.deepEqual((await (await fetch(`${own.url}/test/quizzes`)).json()).quizzes, []);
});

test('CANVAS_NOW pins the date: after the term the default due date is refused', async () => {
  const own = await startCanvas({ CANVAS_TOKEN: 't', CANVAS_TEST_HOOKS: '1', CANVAS_MODE: 'mock', CANVAS_NOW: '2026-12-20T18:00:00Z' });
  try {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${own.url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer t' } } }));
    const r = await create(client, { operationId: 'after-term-1' }); // due date built from 2026-11-04 is in the past by then
    assert.equal(r.isError, true);
    assert.ok(['due_in_past', 'not_taught', 'bad_settings'].includes(r.structuredContent.code), r.structuredContent.code);
    assert.equal(r.structuredContent.code, 'due_in_past');
    await client.close();
  } finally { own.proc.kill(); }
});

test('CANVAS_NOW is ignored without the test hook, and an invalid one refuses to start', async () => {
  const own = await startCanvas({ CANVAS_TOKEN: 't', CANVAS_MODE: 'mock', CANVAS_NOW: '2020-01-01T00:00:00Z' });
  try {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${own.url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer t' } } }));
    const r = await create(client, { operationId: 'ignored-now-1', quiz: quiz({ dueAt: '2026-09-08T06:59:00Z' }) });
    // Past by the real clock (it is after Sep 2026), future by the ignored 2020 pin.
    assert.equal(r.structuredContent.code, 'due_in_past', 'real clock used, not 2020');
    await client.close();
  } finally { own.proc.kill(); }
  const { spawn } = await import('node:child_process');
  const p = spawn(process.execPath, ['src/canvas-mcp.js'], { env: { ...process.env, PORT: '0', CANVAS_TOKEN: 't', CANVAS_TEST_HOOKS: '1', CANVAS_NOW: 'not-a-date' } });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  assert.equal(await new Promise((r) => p.on('exit', r)), 1);
  assert.match(out, /CANVAS_NOW must be an ISO date-time/);
});
