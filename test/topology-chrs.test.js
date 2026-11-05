// Part 17, Task 6: Topology labels for CHRS (its student-records MCP calls, its session, its model) and the Hub's roster lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topologyLabel } from '../src/topology.js';

const chrs = (type, data) => topologyLabel({ source: 'chrs', type, data });
const hub = (type, data) => topologyLabel({ source: 'hub', type, data });
const shape = (l) => ({ edge: l.edge, from: l.from, to: l.to, category: l.category, phase: l.phase });
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('chrs mcp_call_started is CHRS → student records, attempted, naming the tool', () => {
  const l = chrs('mcp_call_started', { tool: 'get_class_roster', moment: 'roster' });
  assert.deepEqual(shape(l), { edge: 'chrs-studentdb', from: 'chrs', to: 'studentdb', category: 'tool', phase: 'attempted' });
  assert.equal(l.label, 'tools/call get_class_roster');
});

test('chrs mcp_call_result labels: a count, refused, uncertain, unavailable', () => {
  const back = { edge: 'chrs-studentdb', from: 'studentdb', to: 'chrs', category: 'tool' };
  const ok = chrs('mcp_call_result', { ok: true, outcome: 'ok', rosterCount: 25 });
  assert.deepEqual(shape(ok), { ...back, phase: 'completed' });
  assert.equal(ok.label, 'Roster: 25 students');
  assert.equal(chrs('mcp_call_result', { ok: true, outcome: 'ok', rosterCount: null }).label, 'Student records answered');
  const refused = chrs('mcp_call_result', { ok: false, outcome: 'refused', code: 'not_instructor' });
  assert.equal(refused.phase, 'failed');
  assert.equal(refused.label, 'Student records refused (not_instructor)');
  const uncertain = chrs('mcp_call_result', { ok: false, outcome: 'uncertain' });
  assert.equal(uncertain.phase, 'unknown');
  assert.equal(chrs('mcp_call_result', { ok: false, outcome: 'unavailable' }).phase, 'failed');
  assert.equal(chrs('mcp_call_result', { ok: false, outcome: 'unavailable' }).label, "Student records didn't answer");
});

test('chrs mcp_tool_refused stays inside CHRS; its model calls hop on chrs-model only when live', () => {
  const r = chrs('mcp_tool_refused', { by: 'model_failed' });
  assert.equal(r.edge, null);
  assert.equal(r.node, 'chrs');
  assert.equal(r.label, 'CHRS’s AI didn’t answer — no call');
  assert.equal(chrs('mcp_tool_refused', { by: 'model' }).label, 'CHRS’s AI picked a tool not allowed here — no call');
  assert.deepEqual(shape(chrs('model_call_started', { mode: 'live', purpose: 'tool choice' })), { edge: 'chrs-model', from: 'chrs', to: 'model', category: 'model', phase: 'attempted' });
  assert.deepEqual(shape(chrs('model_response_received', { mode: 'live', purpose: 'tool choice' })), { edge: 'chrs-model', from: 'model', to: 'chrs', category: 'model', phase: 'completed' });
  assert.equal(chrs('model_call_started', { mode: 'mock' }).edge, null);
});

test('studentdb_session is like peoplesoft_session: open, unreachable, not configured', () => {
  const open = chrs('studentdb_session', { status: 'connected' });
  assert.deepEqual(shape(open), { edge: 'chrs-studentdb', from: 'chrs', to: 'studentdb', category: 'registration', phase: 'completed' });
  assert.equal(open.label, 'MCP session open');
  assert.equal(chrs('studentdb_session', { status: 'unreachable' }).phase, 'failed');
  assert.equal(chrs('studentdb_session', { status: 'unreachable' }).label, 'Student records unreachable');
  assert.equal(chrs('studentdb_session', { status: 'not_configured' }).label, 'Student records not configured');
});

test('Hub roster_lookup hops go Hub → CHRS and back, with a count only', () => {
  const s = hub('roster_lookup_started', { courseId: 'mkt-351', service: 'chrs', operationId: 'op-1' });
  assert.deepEqual(shape(s), { edge: 'hub-chrs', from: 'hub', to: 'chrs', category: 'request', phase: 'attempted' });
  const r = hub('roster_lookup_result', { courseId: 'mkt-351', service: 'chrs', ok: true, rosterCount: 25 });
  assert.deepEqual(shape(r), { edge: 'hub-chrs', from: 'chrs', to: 'hub', category: 'request', phase: 'completed' });
  assert.equal(r.label, 'Roster: 25 students');
  assert.equal(hub('roster_lookup_failed', { code: 'uncertain' }).phase, 'unknown');
  assert.equal(hub('roster_lookup_failed', { code: 'refused' }).phase, 'failed');
  const unsent = hub('roster_lookup_failed', { code: 'chrs_not_ready' });
  assert.equal(unsent.edge, null); // nothing was sent
  assert.equal(unsent.node, 'hub');
});

test('Hub forwards to CHRS on hub-chrs', () => {
  assert.equal(hub('forward_attempted', { agentId: 'chrs' }).edge, 'hub-chrs');
  assert.equal(hub('forward_completed', { agentId: 'chrs', service: 'chrs', kind: 'roster', rosterCount: 3 }).edge, 'hub-chrs');
});

test('no label carries a student name, ID or email', () => {
  const dirty = { rosterCount: 25, name: 'Jamie Rivera', studentId: 'student-jamie', email: 'jamie@example.com', rows: [{ name: 'Jamie Rivera' }], tool: 'get_class_roster' };
  const text = JSON.stringify([chrs('mcp_call_started', dirty), chrs('mcp_call_result', { ...dirty, ok: true, outcome: 'ok' }), hub('roster_lookup_result', { ...dirty, ok: true }), chrs('studentdb_session', { status: 'connected', ...dirty })]);
  assert.ok(!/Jamie|student-jamie|example\.com/.test(text), text);
});

test('the page: approved layout, indigo CHRS, model box, student records tile and edges, no studentdb model box, session event passes the filters', () => {
  const html = read('public/index.html');
  assert.match(html, /viewBox="0 0 1100 1285"/);
  assert.match(html, /PeopleSoft student records \(a demo stand-in system\), reached only by CHRS over MCP/);
  const js = read('public/topology.js');
  assert.match(js, /student: \{ x: 130, y: 605,/);
  assert.match(js, /hub: \{ x: 450, y: 605,/);
  assert.match(js, /'llm-student': \{ x: 130, y: 355,/);
  assert.match(js, /'llm-hub': \{ x: 450, y: 355,/);
  assert.match(js, /chrs: \{ x: 710, y: 1115, r: 56, name: 'CHRS', role: 'Staff only' \}/);
  assert.match(js, /'llm-chrs': \{ x: 985, y: 1060,/);
  assert.match(js, /studentdb: \{ x: 985, y: 1190, w: 176, h: 80, kind: 'system', name: 'PeopleSoft', role: 'Student records' \}/);
  assert.match(js, /'hub-chrs': \['hub', 'chrs'\]/);
  assert.match(js, /'chrs-model': \['chrs', 'llm-chrs'\]/);
  assert.match(js, /'chrs-studentdb': \['chrs', 'studentdb'\]/);
  assert.doesNotMatch(js, /llm-studentdb|llm-canvas|llm-peoplesoft/);
  assert.match(read('src/ui-server.js'), /SESSION_EVENTS = new Set\([^)]*'studentdb_session'/);
  assert.match(read('src/ui-server.js'), /CONFIG_EVENTS = new Set\([^)]*'studentdb_session'/);
  assert.match(read('src/hub-agent.js'), /ev\.type === 'studentdb_session'/);
  assert.match(read('public/app.js'), /chrs: 'var\(--chrs\)'/);
});
