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
  const refused = hr('mcp_call_result', { ok: false, outcome: 'refused', code: 'not_enough' });
  assert.deepEqual(shape(refused), { ...back, phase: 'failed' });
  assert.equal(refused.label, 'PeopleSoft refused (not_enough)');
  const noCode = hr('mcp_call_result', { ok: false, outcome: 'refused', code: null });
  assert.equal(noCode.label, 'PeopleSoft refused');
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

test('final-review I2: a failed tool choice is "HR’s AI didn’t answer — no call", not a wrong pick', () => {
  const failed = hr('mcp_tool_refused', { tool: null, moment: 'submit', expected: 'create_absence_request', by: 'model_failed' });
  assert.equal(failed.edge, null);
  assert.deepEqual([failed.node, failed.category, failed.phase], ['hr', 'tool', 'failed']);
  assert.equal(failed.label, 'HR’s AI didn’t answer — no call');
  assert.match(hr('mcp_tool_refused', { tool: 'get_leave_balances', moment: 'submit', by: 'model' }).label, /not allowed here — no call/);
});

test('final-review M1: an unknown outcome is amber (unknown) on the HR and Hub hops, not red', () => {
  const hub = (type, data) => topologyLabel({ source: 'hub', type, data });
  const handler = hr('form_action_result', { status: 'rejected', unknownOutcome: true });
  assert.equal(handler.phase, 'unknown');
  assert.equal(handler.label, 'Handler result: outcome unknown');
  assert.equal(hr('form_action_result', { status: 'rejected' }).phase, 'failed', 'a definite rejection stays red');
  const relayed = hub('form_result_relayed', { agentId: 'hr', status: 'rejected', unknownOutcome: true });
  assert.deepEqual(shape(relayed), { edge: 'hub-hr', from: 'hr', to: 'hub', category: 'form', phase: 'unknown' });
  assert.equal(relayed.label, 'Issuer replied: outcome unknown');
  assert.equal(hub('form_result_relayed', { agentId: 'hr', status: 'rejected' }).phase, 'failed');
  const sent = hub('relay_sent', { to: 'professor', kind: 'staff_action_result', status: 'refused', unknownOutcome: true });
  assert.equal(sent.phase, 'unknown');
  assert.equal(sent.label, 'Hub relayed HR’s card result (outcome unknown)');
  assert.equal(hub('relay_sent', { to: 'professor', kind: 'staff_action_result', status: 'refused' }).phase, 'failed');
});

test('final-review M1: the Hub allowlist keeps unknownOutcome (a boolean) and by', async () => {
  const { redactTelemetry } = await import('../src/hub-agent.js');
  const out = redactTelemetry({ type: 'form_action_result', data: { status: 'rejected', unknownOutcome: true, by: 'model_failed', note: 'grandmother' } });
  assert.equal(out.unknownOutcome, true);
  assert.equal(out.by, 'model_failed');
  assert.notEqual(out.note, 'grandmother');
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
