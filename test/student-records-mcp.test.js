// PeopleSoft student records stand-in MCP server (Part 17): one tool, a token, a reset. Mock model; no network.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startStudentRecords } from './support/harness.js';

const TOKEN = 'tok-records-secret-123';
let sr;
before(async () => { sr = await startStudentRecords({ STUDENT_RECORDS_TOKEN: TOKEN, STUDENT_RECORDS_TEST_HOOKS: '1', STUDENT_RECORDS_MODE: 'mock' }); });
after(() => { sr?.proc.kill(); });

async function connect(token = TOKEN) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${sr.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const args = (over = {}) => ({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian', ...over });

test('lists exactly one tool with the demo prefix', async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['get_class_roster']);
  assert.match(tools[0].description, /^Demo stand-in for PeopleSoft Campus Solutions \(student records\):/);
  await c.close();
});

test('returns the class and 25 rows, with Alex and Sam, and a step count', async () => {
  const c = await connect();
  const r = await c.callTool({ name: 'get_class_roster', arguments: args() });
  assert.notEqual(r.isError, true, JSON.stringify(r));
  const { roster, stepCount } = r.structuredContent;
  assert.equal(roster.class.code, 'MKTG 351 - 01');
  assert.equal(roster.class.daysAndTimes, 'TuTh 10:00AM - 11:15AM');
  assert.equal(roster.rows.length, 25);
  assert.equal(roster.rows.find((x) => x.studentId === 'student-alex').name, 'Student,Alex');
  assert.equal(roster.rows.find((x) => x.studentId === 'student-sam').name, 'Student,Sam');
  assert.equal(stepCount, 4);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  await c.close();
});

test('refusals: not the instructor, unknown course', async () => {
  const c = await connect();
  const a = await c.callTool({ name: 'get_class_roster', arguments: args({ instructorStaffId: 'staff-someone' }) });
  assert.equal(a.isError, true);
  assert.equal(a.structuredContent.code, 'not_instructor');
  const b = await c.callTool({ name: 'get_class_roster', arguments: args({ courseId: 'mkt-999' }) });
  assert.equal(b.isError, true);
  assert.equal(b.structuredContent.code, 'unknown_course');
  await c.close();
});

test('wrong or missing token is 401', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const h of [headers, { ...headers, Authorization: 'Bearer wrong' }]) {
    const res = await fetch(`${sr.url}/mcp`, { method: 'POST', headers: h, body });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('/dev/reset needs the token and the same origin; test hook is gated', async () => {
  assert.equal((await fetch(`${sr.url}/dev/reset`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${sr.url}/dev/reset`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${sr.url}/dev/reset`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await (await fetch(`${sr.url}/test/state`)).json()).rosterRows, 25);
});

test('starting without STUDENT_RECORDS_TOKEN exits 1 and prints no token', async () => {
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, PORT: '0' };
  delete env.STUDENT_RECORDS_TOKEN;
  const p = spawn(process.execPath, ['src/student-records-mcp.js'], { env });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  assert.equal(await new Promise((r) => p.on('exit', r)), 1);
  assert.match(out, /STUDENT_RECORDS_TOKEN is required/);
});

test('malformed JSON gets a JSON 400', async () => {
  const res = await fetch(`${sr.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{not json' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request' });
});

test('the token and student data never reach stdout/stderr', async () => {
  const c = await connect();
  await c.callTool({ name: 'get_class_roster', arguments: args() });
  await c.callTool({ name: 'get_class_roster', arguments: args({ instructorStaffId: 'staff-x' }) });
  await c.close();
  await new Promise((r) => setTimeout(r, 200));
  const logs = sr.output();
  assert.ok(String(logs).length > 0, 'captured logs');
  for (const bad of [TOKEN, 'Aguilar', 'Student,Alex', 'astudent@']) assert.equal(String(logs).includes(bad), false, `log leaks ${bad}`);
});
