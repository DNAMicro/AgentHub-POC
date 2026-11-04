// PeopleSoft stand-in MCP server: three tools, a token, a reset. Mock model only; no network.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startPeopleSoft } from './support/harness.js';

let ps;
before(async () => { ps = await startPeopleSoft({ PEOPLESOFT_TOKEN: 't', PEOPLESOFT_TEST_HOOKS: '1', PEOPLESOFT_MODE: 'mock' }); });
after(() => { ps?.proc.kill(); });

async function connect(token = 't') {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ps.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const records = async () => (await (await fetch(`${ps.url}/test/records`)).json()).records;
const request = (over = {}) => ({ staffId: 'staff-amir', absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-10', endDate: '2026-11-10', partial: null, operationId: 'abcdef0123', ...over });

test('lists exactly three tools', async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['create_absence_request', 'get_leave_balances', 'list_absence_requests']);
  for (const t of tools) assert.match(t.description, /^Demo stand-in for PeopleSoft:/);
  await c.close();
});

test('balances for staff-amir are 96/120/8', async () => {
  const c = await connect();
  const r = await c.callTool({ name: 'get_leave_balances', arguments: { staffId: 'staff-amir' } });
  assert.deepEqual(r.structuredContent, { staffId: 'staff-amir', vacation: 96, sick: 120, personalHoliday: 8 });
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  const bad = await c.callTool({ name: 'get_leave_balances', arguments: { staffId: 'nobody' } });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.code, 'unknown_staff');
  await c.close();
});

test('/dev/reset reseeds', async () => {
  const c = await connect();
  await c.callTool({ name: 'create_absence_request', arguments: request({ operationId: 'a0a0a0a0' }) });
  assert.ok((await records()).length >= 1);
  assert.equal((await fetch(`${ps.url}/dev/reset`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${ps.url}/dev/reset`, { method: 'POST', headers: { Authorization: 'Bearer t', Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${ps.url}/dev/reset`, { method: 'POST', headers: { Authorization: 'Bearer t' } })).status, 200);
  assert.equal((await records()).length, 0);
  await c.close();
});

test('creates a request and lists it', async () => {
  await fetch(`${ps.url}/dev/reset`, { method: 'POST', headers: { Authorization: 'Bearer t' } });
  const c = await connect();
  const made = await c.callTool({ name: 'create_absence_request', arguments: request() });
  assert.notEqual(made.isError, true, JSON.stringify(made));
  assert.equal(made.structuredContent.receipt.recordId, 'ABS-000101');
  assert.equal(made.structuredContent.receipt.status, 'sent_to_manager');
  const listed = await c.callTool({ name: 'list_absence_requests', arguments: { staffId: 'staff-amir' } });
  assert.equal(listed.structuredContent.requests.length, 1);
  assert.equal(listed.structuredContent.requests[0].recordId, 'ABS-000101');
  assert.equal('steps' in listed.structuredContent.requests[0], false);
  await c.close();
});

test('same operationId returns the stored receipt', async () => {
  await fetch(`${ps.url}/dev/reset`, { method: 'POST', headers: { Authorization: 'Bearer t' } });
  const c = await connect();
  const a = await c.callTool({ name: 'create_absence_request', arguments: request({ operationId: 'dead0001' }) });
  const b = await c.callTool({ name: 'create_absence_request', arguments: request({ operationId: 'dead0001' }) });
  assert.equal(a.structuredContent.receipt.recordId, b.structuredContent.receipt.recordId);
  assert.equal((await records()).length, 1);
  await c.close();
});

test('refuses calls without the token', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const h of [headers, { ...headers, Authorization: 'Bearer wrong' }]) {
    const res = await fetch(`${ps.url}/mcp`, { method: 'POST', headers: h, body });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('refusal comes back as a tool error with a fixed code', async () => {
  const c = await connect();
  const r = await c.callTool({ name: 'create_absence_request', arguments: request({ beginDate: '2026-11-11', endDate: '2026-11-12', operationId: 'bad00001' }) });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'holiday_boundary');
  assert.match(r.structuredContent.reason, /campus holiday/);
  await c.close();
});

test('same operationId with different dates is refused as operation_reused', async () => {
  await fetch(`${ps.url}/dev/reset`, { method: 'POST', headers: { Authorization: 'Bearer t' } });
  const c = await connect();
  const a = await c.callTool({ name: 'create_absence_request', arguments: request({ operationId: 'feed0001' }) });
  assert.notEqual(a.isError, true);
  const b = await c.callTool({ name: 'create_absence_request', arguments: request({ operationId: 'feed0001', beginDate: '2026-11-12', endDate: '2026-11-12' }) });
  assert.equal(b.isError, true);
  assert.equal(b.structuredContent.code, 'operation_reused');
  assert.equal((await records()).length, 1);
  await c.close();
});

test('access boundary: GET/DELETE and a session id without the token are 401', async () => {
  const c = await connect();
  const sid = c.transport.sessionId;
  assert.ok(sid);
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${ps.url}/mcp`, { method, headers: { 'mcp-session-id': sid } });
    assert.equal(res.status, 401);
  }
  const res = await fetch(`${ps.url}/mcp`, { method: 'POST', headers: { 'mcp-session-id': sid, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(res.status, 401);
  await c.close();
});

test('starting without PEOPLESOFT_TOKEN exits 1 and prints no token', async () => {
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, PORT: '0' };
  delete env.PEOPLESOFT_TOKEN;
  const p = spawn(process.execPath, ['src/peoplesoft-mcp.js'], { env });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 1);
  assert.match(out, /PEOPLESOFT_TOKEN is required/);
});

test('malformed JSON gets a JSON 400 with no HTML or stack', async () => {
  const res = await fetch(`${ps.url}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{not json' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request' });
});

test('impossible dates and bad hours are refused', async () => {
  const c = await connect();
  const bad = async (over) => { try { const r = await c.callTool({ name: 'create_absence_request', arguments: request({ operationId: 'bad' + Math.random().toString(16).slice(2, 10), ...over }) }); return r.isError === true; } catch { return true; } };
  assert.equal(await bad({ beginDate: '2026-02-30', endDate: '2026-02-30' }), true);
  assert.equal(await bad({ partial: { mode: 'all_days', hours: -1 } }), true);
  assert.equal(await bad({ partial: { mode: 'all_days', hours: 1000 } }), true);
  const r = await c.callTool({ name: 'create_absence_request', arguments: request({ operationId: 'bad-month-13', beginDate: '2026-13-45', endDate: '2026-13-45' }) });
  assert.ok(r.isError && /Input validation error/.test(r.content[0].text) && !/RangeError|Invalid time value/.test(r.content[0].text), `2026-13-45 is a validation error: ${r.content[0].text}`);
  await c.close();
});
