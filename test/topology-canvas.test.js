// Part 16, Task 8: Topology labels for the Faculty agent's MCP calls to Canvas, and the page's approved layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topologyLabel } from '../src/topology.js';

const prof = (type, data) => topologyLabel({ source: 'professor', type, data });
const hr = (type, data) => topologyLabel({ source: 'hr', type, data });
const shape = (l) => ({ edge: l.edge, from: l.from, to: l.to, category: l.category, phase: l.phase });
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('professor mcp_call_started is Faculty → Canvas, attempted, naming the tool', () => {
  const l = prof('mcp_call_started', { tool: 'create_quiz', moment: 'approve', operationId: 'op-1' });
  assert.deepEqual(shape(l), { edge: 'professor-canvas', from: 'professor', to: 'canvas', category: 'tool', phase: 'attempted' });
  assert.equal(l.label, 'tools/call create_quiz');
});

test('professor mcp_call_result labels: saved, published, refused, uncertain, unavailable', () => {
  const back = { edge: 'professor-canvas', from: 'canvas', to: 'professor', category: 'tool' };
  const saved = prof('mcp_call_result', { tool: 'create_quiz', ok: true, outcome: 'ok', quizId: 4821 });
  assert.deepEqual(shape(saved), { ...back, phase: 'completed' });
  assert.equal(saved.label, 'Saved as quiz #4821');
  assert.equal(prof('mcp_call_result', { tool: 'publish_quiz', ok: true, outcome: 'ok', quizId: 4821 }).label, 'Published quiz #4821');
  assert.equal(prof('mcp_call_result', { tool: 'create_quiz', ok: true, outcome: 'ok', quizId: null }).label, 'Canvas answered');
  const refused = prof('mcp_call_result', { ok: false, outcome: 'refused', code: 'due_in_past' });
  assert.deepEqual(shape(refused), { ...back, phase: 'failed' });
  assert.equal(refused.label, 'Canvas refused (due_in_past)');
  assert.equal(prof('mcp_call_result', { ok: false, outcome: 'refused', code: null }).label, 'Canvas refused');
  const uncertain = prof('mcp_call_result', { ok: false, outcome: 'uncertain', code: null });
  assert.deepEqual(shape(uncertain), { ...back, phase: 'unknown' });
  assert.equal(uncertain.label, "Canvas didn't answer");
  const unavailable = prof('mcp_call_result', { ok: false, outcome: 'unavailable', code: null });
  assert.equal(unavailable.phase, 'failed');
  assert.equal(unavailable.label, "Canvas didn't answer");
});

test('professor mcp_tool_refused stays inside Faculty; canvas_session is Faculty ↔ Canvas', () => {
  const wrong = prof('mcp_tool_refused', { tool: 'publish_quiz', moment: 'approve', by: 'model' });
  assert.equal(wrong.edge, null);
  assert.deepEqual([wrong.node, wrong.phase], ['professor', 'failed']);
  assert.equal(wrong.label, 'Faculty’s AI picked a tool not allowed here — no call');
  assert.equal(prof('mcp_tool_refused', { tool: null, by: 'model_failed' }).label, 'Faculty’s AI didn’t answer — no call');
  const up = prof('canvas_session', { status: 'connected' });
  assert.deepEqual(shape(up), { edge: 'professor-canvas', from: 'professor', to: 'canvas', category: 'registration', phase: 'completed' });
  assert.equal(up.label, 'MCP session open');
  assert.equal(prof('canvas_session', { status: 'unreachable' }).label, 'Canvas unreachable');
  const nc = prof('canvas_session', { status: 'not_configured' });
  assert.equal(nc.phase, 'failed');
  assert.equal(nc.label, 'Canvas not configured');
});

test('HR events still label on hr-peoplesoft; no label names a step or content', () => {
  assert.equal(hr('mcp_call_started', { tool: 'create_absence_request' }).edge, 'hr-peoplesoft');
  assert.equal(hr('mcp_call_result', { ok: true, outcome: 'ok', recordId: 'ABS-000001' }).label, 'Saved as ABS-000001');
  const text = JSON.stringify([prof('mcp_call_started', { tool: 'create_quiz', title: 'Secret Title', questions: ['q'] }), prof('mcp_call_result', { ok: false, outcome: 'refused', code: 'x', title: 'Secret Title' })]);
  assert.ok(!/Secret Title/.test(text));
});

test('the page: approved viewBox, no Canvas model box, Canvas tile and edge, --lms tokens, canvas_session passes the UI filter', () => {
  const html = read('public/index.html');
  assert.match(html, /viewBox="0 0 1100 1285"/);
  assert.match(html, /Canvas LMS \(a demo stand-in system\), reached only by the Faculty agent over MCP/);
  const js = read('public/topology.js');
  assert.match(js, /canvas: \{ x: 985, y: 680, w: 176, h: 80, kind: 'system'/);
  assert.match(js, /peoplesoft: \{ x: 985, y: 935/);
  assert.match(js, /'professor-canvas': \['professor', 'canvas'\]/);
  assert.doesNotMatch(js, /llm-canvas|llm-peoplesoft/);
  const css = read('public/styles.css');
  assert.match(css, /--lms: #4d7c0f/);
  assert.match(css, /--lms: #a3d65c/);
  assert.match(read('src/ui-server.js'), /CONFIG_EVENTS = new Set\([^)]*'canvas_session'/);
});

test('lesson_opened names what was opened: quiz notice, message, else lesson (old events keep lesson)', () => {
  for (const source of ['student', 'hub']) {
    const l = (data) => topologyLabel({ source, type: 'lesson_opened', data }).label;
    assert.equal(l({ kind: 'quiz' }), 'Student opened the quiz notice');
    assert.equal(l({ kind: 'message' }), 'Student opened the message');
    assert.equal(l({ kind: 'lesson' }), 'Student opened the lesson');
    assert.equal(l({}), 'Student opened the lesson');
  }
});
