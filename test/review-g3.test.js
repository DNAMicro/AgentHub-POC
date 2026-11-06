// Review fixes G3: C11 (two PeopleSoft nodes named apart), D18 (realistic request and record numbers), D19 (no model
// name in the header). Plumbing and wording checks; the screens are looked at by eye on a rehearsal stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topologyLabel } from '../src/topology.js';
import { createPeopleSoftStore, REQUEST_BASE, RECORD_BASE } from '../src/peoplesoft-store.js';
import { receiptText } from '../src/professor-staff.js';
import { requestsText } from '../src/hr-agent.js';
import { redactTelemetry } from '../src/hub-agent.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const hr = (type, data) => topologyLabel({ source: 'hr', type, data });
const chrs = (type, data) => topologyLabel({ source: 'chrs', type, data });

// ---- C11 ----
test('C11: HR-side labels say PeopleSoft HR (answered, refused with and without a code, not answered)', () => {
  assert.equal(hr('mcp_call_result', { tool: 'get_leave_balances', ok: true, outcome: 'ok' }).label, 'PeopleSoft CHRS answered');
  assert.equal(hr('mcp_call_result', { ok: false, outcome: 'refused', code: 'overlap' }).label, 'PeopleSoft CHRS refused (overlap)');
  assert.equal(hr('mcp_call_result', { ok: false, outcome: 'refused' }).label, 'PeopleSoft CHRS refused');
  assert.equal(hr('mcp_call_result', { ok: false, outcome: 'uncertain' }).label, "PeopleSoft CHRS didn't answer");
});
test('C11: HR session label', () => {
  assert.equal(hr('peoplesoft_session', { status: 'unreachable' }).label, 'PeopleSoft CHRS unreachable');
  assert.equal(hr('peoplesoft_session', { status: 'connected' }).label, 'MCP session open');
});
test('C11: CHRS-side labels say Campus Solutions, never "Student records" or a bare PeopleSoft', () => {
  const all = [
    chrs('mcp_call_result', { ok: true, outcome: 'ok', rosterCount: null }),
    chrs('mcp_call_result', { ok: false, outcome: 'refused', code: 'unknown_course' }),
    chrs('mcp_call_result', { ok: false, outcome: 'refused' }),
    chrs('mcp_call_result', { ok: false, outcome: 'uncertain' }),
    chrs('studentdb_session', { status: 'unreachable' }),
    chrs('studentdb_session', { status: 'not_configured' }),
  ].map((l) => l.label);
  for (const label of all) { assert.match(label, /^Campus Solutions /, label); assert.doesNotMatch(label, /Student records/i); }
  assert.equal(all[2], 'Campus Solutions refused');
});
test('C11: the roster count label still names only a count', () => {
  assert.equal(chrs('mcp_call_result', { ok: true, outcome: 'ok', rosterCount: 25 }).label, 'Roster: 25 students');
});
test('C11: node names in the label module', () => {
  const src = read('src/topology.js');
  assert.match(src, /studentdb: 'PeopleSoft Campus Solutions \(demo stand-in\)'/);
  assert.match(src, /peoplesoft: 'PeopleSoft CHRS \(HR\) \(demo stand-in\)'/);
  assert.match(src, /chrs: 'Campus Agent'/);
});
test('C11: tiles in the page are named apart, two lines for Campus Solutions, MCP SERVER sub-label, no model boxes', () => {
  const js = read('public/topology.js');
  assert.match(js, /peoplesoft: \{ x: 985, y: 935, w: 176, h: 80, kind: 'system', name: 'PeopleSoft CHRS \(HR\)', lines: \['PeopleSoft CHRS', 'HR'\], role: 'MCP server' \}/);
  assert.match(js, /studentdb: \{[^}]*name: 'PeopleSoft Campus Solutions', lines: \['PeopleSoft', 'Campus Solutions'\], role: 'MCP server' \}/);
  assert.doesNotMatch(js, /llm-peoplesoft|llm-studentdb/);
  assert.match(js, /title: 'PeopleSoft CHRS \(HR\) — demo stand-in'/);
  assert.match(js, /title: 'PeopleSoft Campus Solutions — demo stand-in'/);
});
test('C11: the Topology description (aria) and legend name both PeopleSoft systems', () => {
  const html = read('public/index.html');
  assert.match(html, /PeopleSoft CHRS \(HR\) \(a demo stand-in system\), reached only by the HR Agent over MCP/);
  assert.match(html, /PeopleSoft Campus Solutions \(a demo stand-in system\), reached only by the Campus Agent over MCP/);
  assert.match(html, /MCP to Canvas LMS, PeopleSoft CHRS \(HR\) or PeopleSoft Campus Solutions/);
});
test('C11: the stand-ins announce themselves by their distinct names and keep "demo stand-in"', () => {
  const hrSrc = read('src/peoplesoft-mcp.js');
  const csSrc = read('src/student-records-mcp.js');
  assert.match(hrSrc, /PeopleSoft CHRS \(HR\) MCP server \(demo stand-in\) listening on/);
  assert.match(csSrc, /PeopleSoft Campus Solutions MCP server \(demo stand-in\) listening on/);
  assert.match(hrSrc, /Demo stand-in for PeopleSoft CHRS \(HR\):/);
  assert.match(csSrc, /Demo stand-in for PeopleSoft Campus Solutions \(student records\):/);
});
test('C11: the readiness regexes the harness and rehearsal stack parse match the new lines', () => {
  const h = read('test/support/harness.js');
  const re = (name) => new RegExp(h.match(new RegExp(`${name} = /(.*)/;`))[1]);
  assert.ok(re('PEOPLESOFT_READY').test('PeopleSoft CHRS (HR) MCP server (demo stand-in) listening on http://127.0.0.1:1234'));
  assert.ok(re('STUDENT_RECORDS_READY').test('PeopleSoft Campus Solutions MCP server (demo stand-in) listening on http://127.0.0.1:1234'));
  assert.ok(!re('PEOPLESOFT_READY').test('PeopleSoft Campus Solutions MCP server (demo stand-in) listening on http://127.0.0.1:1234'));
  const rs = read('scripts/demo/rehearsal-stack.js');
  assert.ok(rs.includes('PeopleSoft CHRS \\(HR\\) MCP server'));
  assert.match(rs, /PeopleSoft Campus Solutions MCP server/);
});
test('C11: CHRS card text and its tool-choice prompt use Campus Solutions', () => {
  assert.match(read('src/chrs-agent.js'), /from PeopleSoft Campus Solutions/);
  assert.match(read('src/chrs-model.js'), /PeopleSoft Campus Solutions \(a demo stand-in\)/);
});

// ---- D18 ----
const v = (b, e = b) => ({ absenceType: 'VAC', absenceReason: 'VAC', beginDate: b, endDate: e, partial: null });
const file = (s, b, op) => s.file('staff-dabirian', v(b), op, ['store_record']);
test('D18: the first request is 4310288 and its record 00482131', () => {
  const r = file(createPeopleSoftStore(), '2026-11-10', 'op-a');
  assert.equal(r.receipt.requestId, '4310288');
  assert.equal(r.receipt.recordId, '00482131');
  assert.equal(REQUEST_BASE, 4310288);
  assert.equal(RECORD_BASE, 482131);
});
test('D18: numbers go up by one per new request, with a fixed shape', () => {
  const s = createPeopleSoftStore();
  const days = ['2026-11-10', '2026-11-16', '2026-11-17', '2026-11-18'];
  const rs = days.map((d, i) => file(s, d, `op-${i}`).receipt);
  assert.deepEqual(rs.map((r) => r.requestId), ['4310288', '4310289', '4310290', '4310291']);
  assert.deepEqual(rs.map((r) => r.recordId), ['00482131', '00482132', '00482133', '00482134']);
  for (const r of rs) { assert.match(r.requestId, /^\d{7}$/); assert.match(r.recordId, /^\d{8}$/); }
});
test('D18: a repeat of the same operation id returns the same numbers and uses none', () => {
  const s = createPeopleSoftStore();
  const a = file(s, '2026-11-10', 'same');
  const again = file(s, '2026-11-10', 'same');
  assert.deepEqual(again, a);
  assert.equal(file(s, '2026-11-16', 'next').receipt.requestId, '4310289');
});
test('D18: a refused request does not use up a number', () => {
  const s = createPeopleSoftStore();
  assert.equal(file(s, '2026-11-11', 'holiday').ok, false);
  assert.equal(file(s, '2026-11-10', 'fine').receipt.requestId, '4310288');
});
test('D18: reset starts the numbers again', () => {
  const s = createPeopleSoftStore();
  file(s, '2026-11-10', 'x'); file(s, '2026-11-16', 'y');
  s.reset();
  assert.equal(file(s, '2026-11-10', 'z').receipt.requestId, '4310288');
});
test('D18: two stores (two starts) both begin at the base', () => {
  assert.equal(file(createPeopleSoftStore(), '2026-11-10', 'q').receipt.requestId, file(createPeopleSoftStore(), '2026-11-10', 'r').receipt.requestId);
});
test('D18: the list returns the numbers, newest first', () => {
  const s = createPeopleSoftStore();
  file(s, '2026-11-10', 'a'); file(s, '2026-11-16', 'b');
  assert.deepEqual(s.requests('staff-dabirian').map((r) => r.requestId), ['4310289', '4310288']);
});
test('D18: receipt wording says "Request 4310288:" and never TO-/ABS-', () => {
  const r = file(createPeopleSoftStore(), '2026-11-10', 'w').receipt;
  const text = receiptText(r);
  assert.match(text, /^Your time off is recorded\. Request 4310288: Vacation, Tue, Nov 10, 8 hours\.$/);
  assert.doesNotMatch(text, /TO-|ABS-/);
});
test('D18: the list line says "Request <number>:"', () => {
  const s = createPeopleSoftStore();
  file(s, '2026-11-10', 'a');
  const line = requestsText(s.requests('staff-dabirian'))
  assert.match(line, /^Request 4310288: Vacation, Tue, Nov 10, 8 hours — recorded\.$/);
});
test('D18: the Hub keeps the number in a receipt and the record id in telemetry', () => {
  const out = redactTelemetry({ type: 'form_action_result', data: { receipt: { requestId: '4310288', status: 'recorded', hours: 8 } } });
  assert.equal(out.receipt.requestId, '4310288');
  const t = redactTelemetry({ type: 'mcp_call_result', data: { recordId: '00482131', ok: true } });
  assert.equal(t.recordId, '00482131');
  assert.match('4310288', /^[\w-]{1,64}$/);
  assert.match('00482131', /^[\w-]{1,64}$/);
});
test('D18: no TO-/ABS- ids are left in source, scripts or tests that read receipts', () => {
  for (const f of ['src/peoplesoft-store.js', 'src/hr-agent.js', 'src/professor-staff.js', 'public/classroom.js', 'scripts/browser-checks/hr-card.js', 'scripts/browser-checks/peoplesoft.js']) {
    assert.doesNotMatch(read(f).replace(/\/\/.*$/gm, ''), /['"`]TO-|['"`]ABS-|\bTO-\\w|ABS-\\d/, f);
  }
  assert.match(read('public/classroom.js'), /\^Your time off is recorded/);
});

// ---- D19 ----
const headerTexts = () => {
  const app = read('public/app.js');
  const modeBlock = app.match(/const MODE_TEXT = \{[\s\S]*?\n\};/)[0];
  const MODE_TEXT = new Function(`${modeBlock}; return MODE_TEXT;`)();
  const routerBlock = app.match(/const ROUTER_TEXT = \{[^\n]*\};/)[0];
  const ROUTER_TEXT = new Function(`${routerBlock}; return ROUTER_TEXT;`)();
  return { MODE_TEXT, ROUTER_TEXT };
};
const MODEL_WORDS = /claude|haiku|sonnet|opus|\bAI\b|anthropic|localhost/i;
test('D19: the Tutor pill never names a model in live, mock or fixed mode', () => {
  const { MODE_TEXT } = headerTexts();
  for (const mode of ['live', 'mock', 'fixed']) assert.doesNotMatch(MODE_TEXT[mode]({ model: 'claude-haiku-5-5', keyConfigured: true }), MODEL_WORDS, mode);
  assert.equal(MODE_TEXT.live({ model: 'claude-haiku-5-5' }), 'Tutor: live');
});
test('D19: the Router pill text in each state has no model name', () => {
  const { ROUTER_TEXT } = headerTexts();
  for (const t of Object.values(ROUTER_TEXT)) assert.doesNotMatch(t, MODEL_WORDS);
  const app = read('public/app.js');
  assert.match(app, /router\.mode === 'live' \? 'Router: live'/);
});
test('D19: the failed / no-key state adds a plain note, not a model name', () => {
  const app = read('public/app.js');
  assert.match(app, /, no API key set'/);
  assert.doesNotMatch(app.match(/function renderMode[\s\S]*?\n\}/)[0], /status\.model|\.model\b/);
  assert.doesNotMatch(app.match(/function renderRouter[\s\S]*?\n\}/)[0], /\.model\b/);
});
test('D19: the header markup (pills, banner, description) names no model', () => {
  const html = read('public/index.html');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.doesNotMatch(header, /claude|haiku|anthropic|localhost|4444/i);
  const app = read('public/app.js');
  assert.match(app, /Live view disconnected — reconnecting/);
});
test('D19: the server status that feeds the pills is the only place a model is reported, and the page ignores it', () => {
  const app = read('public/app.js');
  const pillFns = app.match(/function renderMode[\s\S]*?\n\}|function renderRouter[\s\S]*?\n\}/g).join('\n');
  assert.doesNotMatch(pillFns, /textContent[^;]*model/);
});
