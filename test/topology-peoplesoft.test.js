// Part 15, Task 5: Topology labels for HR's MCP calls to PeopleSoft, and the Hub's allowlist for their fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { topologyLabel } from '../src/topology.js';
import { startStack, post, openStream, waitFor } from './support/harness.js';

const hr = (type, data) => topologyLabel({ source: 'hr', type, data });
const shape = (l) => ({ edge: l.edge, from: l.from, to: l.to, category: l.category, phase: l.phase });

test('mcp_call_started is HR → PeopleSoft, attempted, naming the tool', () => {
  const l = hr('mcp_call_started', { tool: 'create_absence_request', moment: 'submit', operationId: 'op-1' });
  assert.deepEqual(shape(l), { edge: 'hr-peoplesoft', from: 'hr', to: 'peoplesoft', category: 'tool', phase: 'attempted' });
  assert.equal(l.label, 'tools/call create_absence_request');
  assert.equal(l.operationId, 'op-1');
});

test('mcp_call_result labels: ok, saved record, refused, uncertain, unavailable, other failures', () => {
  const back = { edge: 'hr-peoplesoft', from: 'peoplesoft', to: 'hr', category: 'tool' };
  const ok = hr('mcp_call_result', { tool: 'get_leave_balances', ok: true, outcome: 'ok', recordId: null });
  assert.deepEqual(shape(ok), { ...back, phase: 'completed' });
  assert.equal(ok.label, 'PeopleSoft answered');
  const saved = hr('mcp_call_result', { tool: 'create_absence_request', ok: true, outcome: 'ok', recordId: 'ABS-000001' });
  assert.equal(saved.label, 'Saved as ABS-000001');
  const refused = hr('mcp_call_result', { ok: false, outcome: 'refused', code: 'insufficient_balance' });
  assert.deepEqual(shape(refused), { ...back, phase: 'failed' });
  assert.equal(refused.label, 'PeopleSoft refused (insufficient_balance)');
  const uncertain = hr('mcp_call_result', { ok: false, outcome: 'uncertain', code: null });
  assert.deepEqual(shape(uncertain), { ...back, phase: 'unknown' });
  assert.equal(uncertain.label, "PeopleSoft didn't answer");
  const unavailable = hr('mcp_call_result', { ok: false, outcome: 'unavailable', code: null });
  assert.deepEqual(shape(unavailable), { ...back, phase: 'failed' });
  assert.equal(unavailable.label, "PeopleSoft didn't answer");
  const other = hr('mcp_call_result', { ok: false, outcome: 'tool_refused' });
  assert.deepEqual(shape(other), { ...back, phase: 'failed' });
  assert.equal(other.label, "PeopleSoft didn't answer");
});

test('mcp_tool_refused stays inside HR; peoplesoft_session is HR ↔ PeopleSoft registration', () => {
  const refused = hr('mcp_tool_refused', { tool: 'get_leave_balances', moment: 'submit', expected: 'create_absence_request' });
  assert.equal(refused.edge, null);
  assert.deepEqual([refused.node, refused.category, refused.phase], ['hr', 'tool', 'failed']);
  assert.match(refused.label, /not allowed here — no call/);
  const up = hr('peoplesoft_session', { status: 'connected', tools: 3 });
  assert.deepEqual(shape(up), { edge: 'hr-peoplesoft', from: 'hr', to: 'peoplesoft', category: 'registration', phase: 'completed' });
  assert.equal(up.label, 'MCP session open');
  const down = hr('peoplesoft_session', { status: 'unreachable' });
  assert.equal(down.phase, 'failed');
  assert.equal(down.label, 'PeopleSoft unreachable');
});

test('labels never carry staff words', () => {
  const text = JSON.stringify([
    hr('mcp_call_started', { tool: 'create_absence_request', absenceType: 'Bereavement', note: 'grandmother' }),
    hr('mcp_call_result', { ok: false, outcome: 'refused', code: 'x', reason: 'grandmother' }),
  ]);
  assert.ok(!/grandmother|Bereavement/.test(text));
});

test('through a real stack: the monitor stream gets labelled hr-peoplesoft events with safe fields, and peoplesoft_session', async (t) => {
  const stack = await startStack({
    library: false, professor: true, hr: true,
    hubEnv: { ROUTER_MODE: 'mock' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
  });
  t.after(() => stack.kill());
  const stream = await openStream(stack.ui.url);
  t.after(() => stream.close());
  await post(`${stack.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text: 'I want to file for time off. My grandmother passed away, I need Nov 20 off' });
  const call = (e) => e.runId?.startsWith('staff-') && e.topo?.edge === 'hr-peoplesoft';
  await waitFor(() => stream.events.some((e) => call(e) && e.type === 'mcp_call_result'), { timeout: 15000, what: 'labelled PeopleSoft hop' });
  const started = stream.events.find((e) => call(e) && e.type === 'mcp_call_started');
  assert.equal(started.data.tool, 'get_leave_balances');
  assert.equal(started.data.moment, 'balances');
  assert.equal(started.topo.phase, 'attempted');
  const result = stream.events.find((e) => call(e) && e.type === 'mcp_call_result');
  assert.equal(result.data.tool, 'get_leave_balances');
  assert.equal(result.data.outcome, 'ok');
  assert.equal(result.topo.phase, 'completed');
  assert.ok(stream.events.some((e) => e.type === 'peoplesoft_session' && e.source === 'hr' && e.data.status === 'connected'), 'peoplesoft_session reaches the monitor stream');
  const staffEvents = stream.events.filter((e) => e.runId?.startsWith('staff-'));
  assert.ok(!/grandmother|passed away|Bereavement/i.test(JSON.stringify(staffEvents)), 'no staff words in the staff run events');
});
