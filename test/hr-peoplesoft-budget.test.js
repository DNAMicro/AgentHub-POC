// Part 15, Task 5 fix round 1: HR's MCP deadline starts after the tool choice, and a refusal code is accepted
// only from PeopleSoft's fixed set. HR runs LIVE against the fake Anthropic API (plumbing, no real key or network);
// the PeopleSoft side is a tiny stateless MCP stub so its answer time and refusal code are scripted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { startFakeAnthropic, toolChoiceReply } from './support/fake-anthropic.js';

const stub = await startFakeAnthropic();
process.env.HR_MODE = 'live';
process.env.ANTHROPIC_API_KEY = `sk-ant-test-${randomUUID()}`;
process.env.ANTHROPIC_BASE_URL = stub.url;
process.env.TUTOR_LOAD_DOTENV = '0';
const { createPeopleSoftLink } = await import('../src/hr-peoplesoft.js');

let mcpDelayMs = 0;
let connectDelayMs = 0; // initialize and tools/list (the connect), not the tool call
let mcpResult = { structuredContent: { staffId: 'staff-amir', vacation: 96, sick: 120, personalHoliday: 8 } };
const server = createServer(async (req, res) => {
  if (!req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
  let raw = '';
  for await (const c of req) raw += c;
  const method = raw ? JSON.parse(raw).method : null;
  if (connectDelayMs && ['initialize', 'tools/list'].includes(method)) await new Promise((r) => setTimeout(r, connectDelayMs));
  const mcp = new McpServer({ name: 'stub', version: '1.0.0' });
  const tool = (name) => mcp.registerTool(name, { description: name, inputSchema: { staffId: z.string() } }, async () => {
    await new Promise((r) => setTimeout(r, mcpDelayMs));
    return { content: [{ type: 'text', text: '{}' }], ...mcpResult };
  });
  ['get_leave_balances', 'list_absence_requests', 'create_absence_request'].forEach(tool);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); mcp.close(); });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
});
let url;
before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.closeAllConnections(); server.close(); await stub.close(); });

const newLink = (timeoutMs, events, extra = {}) => createPeopleSoftLink({ url, token: 't', timeoutMs, emit: (type, runId, data) => events.push({ type, data }), ...extra });

test('a slow tool choice does not eat into the call budget', async () => {
  stub.respondWith((body) => ({ ...toolChoiceReply(body), delayMs: 1500 })); // choice takes 1.5 s
  mcpDelayMs = 2200; // PeopleSoft answers just under the 3 s budget
  mcpResult = { structuredContent: { staffId: 'staff-amir', vacation: 96, sick: 120, personalHoliday: 8 } };
  const events = [];
  const link = newLink(3000, events);
  const r = await link.balances('staff-amir');
  await link.close();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.vacation, 96);
});

test('a refusal carrying an unknown code reaches telemetry as code null; the reason text stays', async () => {
  stub.respondWith((body) => toolChoiceReply(body));
  mcpDelayMs = 0;
  mcpResult = { isError: true, structuredContent: { code: 'insufficient_balance', reason: 'Not enough vacation.' } };
  const events = [];
  const link = newLink(3000, events);
  const r = await link.balances('staff-amir');
  await link.close();
  assert.equal(r.outcome, 'refused');
  assert.equal(r.code, null);
  assert.equal(r.reason, 'Not enough vacation.');
  assert.equal(events.find((e) => e.type === 'mcp_call_result').data.code, null);
});

test('a refusal with a code from the fixed set keeps it', async () => {
  mcpResult = { isError: true, structuredContent: { code: 'not_enough', reason: 'Not enough vacation.' } };
  const events = [];
  const link = newLink(3000, events);
  const r = await link.balances('staff-amir');
  await link.close();
  assert.equal(r.code, 'not_enough');
  assert.equal(events.find((e) => e.type === 'mcp_call_result').data.code, 'not_enough');
});

test('final-review M7: the call keeps its floor — a connect that eats into it fails as unavailable, never a cut-short call', async () => {
  stub.respondWith((body) => toolChoiceReply(body));
  connectDelayMs = 1300; // initialize + tools/list ≈ 2.6 s: more than the 1.5 s the floor leaves the connect
  mcpDelayMs = 2300; // the tool (think: PeopleSoft's planner) needs 2.3 s; the floor gives it 2.5 s
  mcpResult = { structuredContent: { staffId: 'staff-amir', vacation: 96, sick: 120, personalHoliday: 8 } };
  const events = [];
  const link = newLink(4000, events, { callFloorMs: 2500 });
  const r = await link.balances('staff-amir');
  await link.close();
  connectDelayMs = 0;
  assert.equal(r.outcome, 'unavailable', 'nothing reached the tool — not an uncertain, cut-short call');
  assert.equal(events.filter((e) => e.type === 'mcp_call_started').length, 0);
});

test('final-review M7: the default floor is the planner + 2 s, and it leaves the connect at least 1 s', async () => {
  const { TIMEOUTS: T } = await import('../src/timeouts.js');
  const { readFile } = await import('node:fs/promises');
  assert.match(await readFile(new URL('../src/hr-peoplesoft.js', import.meta.url), 'utf8'), /CALL_FLOOR_MS = TIMEOUTS\.peoplesoftPlannerMs \+ 2000/);
  assert.ok(T.hrPeopleSoftCallMs - (T.peoplesoftPlannerMs + 2000) >= 1000, 'the connect keeps at least 1 s');
});
