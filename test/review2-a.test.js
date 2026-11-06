// Second review, group A: the Campus Agent rename (was "CHRS Agent"), the PeopleSoft CHRS (HR) tile, roster-trace
// wording, and one counted row for repeated events (review #8). Labels are pure; the page code is read as text, and
// the grouped Agent activity row is run in jsdom with the page's own function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { topologyLabel } from '../src/topology.js';
import { loadHubConfig } from '../src/config.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const label = (source, type, data = {}) => topologyLabel({ source, type, data });

// ---- #1 Campus Agent --------------------------------------------------------------------------------------------
test('rename: node names say Campus Agent and PeopleSoft CHRS (HR), Campus Solutions unchanged', () => {
  const src = read('src/topology.js');
  assert.match(src, /chrs: 'Campus Agent'/);
  assert.match(src, /peoplesoft: 'PeopleSoft CHRS \(HR\) \(demo stand-in\)'/);
  assert.match(src, /studentdb: 'PeopleSoft Campus Solutions \(demo stand-in\)'/);
});
test('rename: the Hub asking for the roster names Campus Agent', () => {
  assert.equal(label('hub', 'roster_lookup_started').label, 'Hub asked Campus Agent for the class roster');
});
test('rename: email fallback, singular and plural, says Campus Agent', () => {
  assert.equal(label('hub', 'email_fallback_started', { recipients: 1 }).label, "Hub asked Campus Agent to email 1 student who isn't online");
  assert.equal(label('hub', 'email_fallback_started', { recipients: 24 }).label, "Hub asked Campus Agent to email 24 students who aren't online");
  assert.equal(label('hub', 'email_fallback_sent', { emailedCount: 24 }).label, 'Campus Agent emailed 24 students');
  assert.equal(label('hub', 'email_fallback_sent', { emailedCount: 1, emailFailedCount: 1 }).label, "Campus Agent emailed 1 student (1 couldn't be emailed)");
});
test('rename: routing to the Campus Agent reads "Routed to Campus Agent" (no "staff path" suffix); HR keeps its suffix', () => {
  assert.equal(label('hub', 'route_decided', { decision: 'route', destination: 'chrs', decidedBy: 'staff' }).label, 'Routed to Campus Agent');
  assert.equal(label('hub', 'route_decided', { decision: 'route', destination: 'hr', decidedBy: 'staff' }).label, 'Routed to HR Agent (staff path)');
  assert.equal(label('hub', 'route_decided', { decision: 'route', destination: 'tutor', decidedBy: 'router' }).label, 'Routed to tutor');
});
test('rename: the Campus Agent\'s records call reads "Campus Agent → Campus Solutions: get_class_roster"', () => {
  const l = label('chrs', 'mcp_call_started', { tool: 'get_class_roster' });
  assert.equal(l.label, 'Campus Agent → Campus Solutions: get_class_roster');
  assert.equal(l.edge, 'chrs-studentdb');
});
test('rename: HR\'s tool call is still tools/call and never says Campus', () => {
  assert.equal(label('hr', 'mcp_call_started', { tool: 'get_leave_balances' }).label, 'tools/call get_leave_balances');
});
test('rename: PeopleSoft CHRS answered / refused / did not answer / unreachable', () => {
  assert.equal(label('hr', 'mcp_call_result', { ok: true, outcome: 'ok' }).label, 'PeopleSoft CHRS answered');
  assert.equal(label('hr', 'mcp_call_result', { ok: false, outcome: 'refused', code: 'overlap' }).label, 'PeopleSoft CHRS refused (overlap)');
  assert.equal(label('hr', 'mcp_call_result', { ok: false, outcome: 'uncertain' }).label, "PeopleSoft CHRS didn't answer");
  assert.equal(label('hr', 'peoplesoft_session', { status: 'unreachable' }).label, 'PeopleSoft CHRS unreachable');
});
test('rename: Campus Solutions labels are unchanged', () => {
  assert.equal(label('chrs', 'mcp_call_result', { ok: true, rosterCount: 25 }).label, 'Roster: 25 students');
  assert.equal(label('chrs', 'mcp_call_result', { ok: false, outcome: 'refused', code: 'not_instructor' }).label, 'Campus Solutions refused (not_instructor)');
  assert.equal(label('chrs', 'studentdb_session', { status: 'unreachable' }).label, 'Campus Solutions unreachable');
});
test('rename: the Campus Agent\'s model refusals name it; Faculty and HR keep theirs', () => {
  assert.equal(label('chrs', 'mcp_tool_refused', { by: 'model_failed' }).label, 'Campus Agent’s AI didn’t answer — no call');
  assert.equal(label('hr', 'mcp_tool_refused', { by: 'model' }).label, 'HR’s AI picked a tool not allowed here — no call');
  assert.equal(label('professor', 'mcp_tool_refused', { by: 'model_failed' }).label, 'Faculty’s AI didn’t answer — no call');
});
test('rename: a relayed roster reply says Campus Agent; a relayed HR reply says HR', () => {
  assert.equal(label('hub', 'relay_sent', { kind: 'staff_reply', to: 'professor', status: 'ok', servedBy: 'chrs' }).label, 'Hub relayed Campus Agent’s reply (ok)');
  assert.equal(label('hub', 'relay_sent', { kind: 'staff_reply', to: 'professor', status: 'ok', servedBy: 'hr' }).label, 'Hub relayed HR’s reply (ok)');
});

// ---- #2 names everywhere an audience looks ------------------------------------------------------------------------
test('names: the page tiles, model box, details panel and Agent activity names', () => {
  const js = read('public/topology.js');
  assert.match(js, /chrs: \{ x: 710, y: 1115, r: 56, name: 'Campus Agent', role: 'Staff only' \}/);
  assert.match(js, /name: 'Campus Agent’s model'/);
  assert.match(js, /peoplesoft: \{[^}]*name: 'PeopleSoft CHRS \(HR\)', lines: \['PeopleSoft CHRS', 'HR'\]/);
  assert.match(js, /studentdb: \{[^}]*name: 'PeopleSoft Campus Solutions', lines: \['PeopleSoft', 'Campus Solutions'\]/);
  assert.match(js, /title: 'PeopleSoft CHRS \(HR\) — demo stand-in'/);
  assert.match(js, /reachedBy: 'the Campus Agent'/);
  assert.match(read('public/app.js'), /chrs: 'Campus Agent'/);
});
test('names: the staff trace is "Staff request (Faculty → HR)" to HR and "Roster request (Faculty → Campus Agent)" to the roster agent', () => {
  const js = read('public/topology.js');
  assert.match(js, /toRoster \? 'Roster request \(Faculty → Campus Agent\)' : `Staff request \(Faculty → \${staffTo}\)`/);
  assert.match(js, /toRoster \? 'Campus Agent' : toHr \? 'HR' : 'Hub'/);
  assert.match(js, /\.ev-trace`\)\) b\.textContent = traceName/);
});
test('names: the Hub\'s agent list shows Campus Agent (config peer, destination, display name) and the agent card says so', () => {
  const cfg = loadHubConfig();
  const peer = cfg.peers.find((p) => p.agentId === 'chrs');
  assert.equal(peer.expectedName, 'Campus Agent');
  assert.equal(peer.displayName, 'Campus Agent');
  assert.equal(cfg.destinations.chrs.name, 'Campus Agent');
  assert.match(read('src/chrs-agent.js'), /name: 'Campus Agent',/);
});
test('names: log prefixes and startup lines the harness and rehearsal stack parse', () => {
  assert.match(read('src/chrs-agent.js'), /console\.log\('\[Campus Agent\]'/);
  assert.match(read('src/peoplesoft-mcp.js'), /PeopleSoft CHRS \(HR\) MCP server \(demo stand-in\) listening on/);
  assert.match(read('src/peoplesoft-mcp.js'), /console\.log\('\[PeopleSoft CHRS\]'/);
  const h = read('test/support/harness.js');
  const re = (name) => new RegExp(h.match(new RegExp(`${name} = /(.*)/;`))[1]);
  assert.ok(re('CHRS_READY').test('[Campus Agent] listening on http://127.0.0.1:1234'));
  assert.ok(!re('CHRS_READY').test('[CHRS Agent] listening on http://127.0.0.1:1234'));
  assert.ok(re('PEOPLESOFT_READY').test('PeopleSoft CHRS (HR) MCP server (demo stand-in) listening on http://127.0.0.1:1234'));
  assert.ok(!re('PEOPLESOFT_READY').test('PeopleSoft Campus Solutions MCP server (demo stand-in) listening on http://127.0.0.1:1234'));
  assert.ok(read('scripts/demo/rehearsal-stack.js').includes('PeopleSoft CHRS \\(HR\\) MCP server'));
});
test('names: the SVG description and legend', () => {
  const html = read('public/index.html');
  assert.match(html, /HR Agent and Campus Agent,/);
  assert.match(html, /PeopleSoft CHRS \(HR\) \(a demo stand-in system\), reached only by the HR Agent over MCP/);
  assert.match(html, /reached only by the Campus Agent over MCP/);
  assert.match(html, /PeopleSoft CHRS \(HR\) or PeopleSoft Campus Solutions/);
});
test('names: no audience-visible "CHRS Agent" or "PeopleSoft HR" string is left in src/public (comments excepted)', () => {
  for (const f of ['src/topology.js', 'public/topology.js', 'public/app.js', 'public/index.html', 'src/config.js', 'src/chrs-agent.js', 'src/peoplesoft-mcp.js', 'public/classroom.js', 'public/roster-ui.js']) {
    const code = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
    assert.doesNotMatch(code, /CHRS Agent|PeopleSoft HR|CHRS’s model/, f);
  }
});
test('names: the Faculty view never names either system (the roster card is just "Class roster")', () => {
  const ui = read('public/roster-ui.js');
  assert.match(ui, /label: 'Class roster'/);
  assert.doesNotMatch(ui, /label: 'CHRS/);
  for (const f of ['public/classroom.js', 'public/quiz-ui.js', 'public/roster-ui.js']) {
    const code = read(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /(['"`])[^'"`\n]*\b(Campus Agent|PeopleSoft CHRS)\b[^'"`\n]*\1/, f);
  }
});

// ---- #8 grouping --------------------------------------------------------------------------------------------------
test('group: a queued lesson carries a group key per lesson and a count template', () => {
  const a = label('hub', 'lesson_queued', { lessonId: 'L1', deliveryId: 'd1' });
  assert.equal(a.group, 'lesson:L1');
  assert.equal(a.groupLabel, 'Lesson queued — {n} students not online');
  assert.equal(a.label, 'Lesson queued — Student agent offline'); // a single one keeps its own wording
});
test('group: two different lessons get different keys; same lesson, different deliveries the same key', () => {
  const k = (l, d) => label('hub', 'lesson_queued', { lessonId: l, deliveryId: d }).group;
  assert.notEqual(k('L1', 'd1'), k('L2', 'd1'));
  assert.equal(k('L1', 'd1'), k('L1', 'd2'));
});
test('group: other event types carry no group (delivered, attempted, uncertain, registry)', () => {
  for (const t of ['lesson_delivered', 'lesson_delivery_attempted', 'lesson_uncertain', 'forward_attempted']) {
    assert.equal(label('hub', t, { lessonId: 'L1', agentId: 'tutor', attempt: 1 })?.group, undefined, t);
  }
});
test('group: the email fallback is one event per post (counts), so it needs no group', () => {
  assert.equal(label('hub', 'email_fallback_started', { recipients: 24 }).group, undefined);
});
test('group: the Topology list merges by run + type + connection + group, live and after a clear', () => {
  const js = read('public/topology.js');
  assert.match(js, /\[ev\.runId \?\? '', ev\.source, ev\.type, t\.edge \?\? t\.node, t\.group\]\.join/);
  assert.match(js, /hit\?\.li\.isConnected/);
  assert.match(js, /t\.groupLabel\.replace\('\{n\}', hit\.n\)/);
  assert.match(js, /groupRows\.clear\(\)/);
});

// The page's own groupedRow, run against a stand-in log.
function groupedHarness() {
  const dom = new JSDOM('<ol id="hub-log"></ol><ol id="other-log"></ol>');
  const { document } = dom.window;
  const src = read('public/app.js');
  const grab = (name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf("\n}\n", i) + 3); };
  const fns = ['definitionList', 'messageItem'].map(grab).join('\n');
  const grouped = src.slice(src.indexOf('const groupedRows = new Map();'), src.indexOf('function appendTo('));
  const body = `const renderRichText = (el, text) => { el.textContent = text; };
    const shortTime = (iso) => iso; const pending = { el: null }; const els = { studentLog: null };
    function appendTo(log, item) { log.append(item); }
    ${fns}\n${grouped}\nreturn { groupedRow, groupedRows };`;
  const api = new Function('document', body)(document);
  const log = (id) => document.getElementById(id);
  const queued = (logEl, { lessonId = 'L1', run = 'r1', i = 0 } = {}) => api.groupedRow(logEl, `lesson_queued|${run}|${lessonId}`, 1, (n) => ({ at: `2026-11-05T10:00:0${i % 10}Z`, speaker: 'hub', dir: 'info',
    label: n === 1 ? 'Lesson queued' : `Lesson queued — ${n} students not online`, text: n === 1 ? 'one' : `${n} students`, ids: n === 1 ? { delivery: `d${i}` } : { deliveries: n, lesson: lessonId, run } }));
  return { document, log, queued, api };
}
test('group live: 24 queued events arrive one by one and make one row that counts up', () => {
  const h = groupedHarness();
  const hub = h.log('hub-log');
  h.queued(hub, { i: 0 });
  assert.equal(hub.children.length, 1);
  assert.equal(hub.querySelector('.msg-dir').textContent, 'Lesson queued');
  for (let i = 1; i < 24; i++) { h.queued(hub, { i }); assert.equal(hub.children.length, 1, `row ${i}`); }
  assert.equal(hub.querySelector('.msg-dir').textContent, 'Lesson queued — 24 students not online');
  assert.equal(hub.querySelector('li').dataset.count, '24');
  assert.match(hub.querySelector('.msg-text').textContent, /^24 students/);
});
test('group live: a different lesson or run is its own row; a different log is separate', () => {
  const h = groupedHarness();
  const hub = h.log('hub-log');
  for (let i = 0; i < 3; i++) h.queued(hub, { lessonId: 'L1', i });
  for (let i = 0; i < 2; i++) h.queued(hub, { lessonId: 'L2', i });
  h.queued(hub, { lessonId: 'L1', run: 'r2', i: 0 });
  h.queued(h.log('other-log'), { lessonId: 'L1', i: 0 });
  assert.deepEqual([...hub.querySelectorAll('.msg-dir')].map((e) => e.textContent), ['Lesson queued — 3 students not online', 'Lesson queued — 2 students not online', 'Lesson queued']);
  assert.equal(h.log('other-log').children.length, 1);
});
test('group replay: after the log is cleared (New conversation / reload) the same events start a fresh row', () => {
  const h = groupedHarness();
  const hub = h.log('hub-log');
  for (let i = 0; i < 5; i++) h.queued(hub, { i });
  hub.replaceChildren();
  for (let i = 0; i < 4; i++) h.queued(hub, { i });
  assert.equal(hub.children.length, 1);
  assert.equal(hub.querySelector('.msg-dir').textContent, 'Lesson queued — 4 students not online');
});
test('group live: an unrelated row between the queued ones does not split the group', () => {
  const h = groupedHarness();
  const hub = h.log('hub-log');
  h.queued(hub, { i: 0 });
  hub.append(h.document.createElement('li'));
  h.queued(hub, { i: 1 });
  h.queued(hub, { i: 2 });
  assert.equal(hub.querySelectorAll('.msg').length, 1);
  assert.equal(hub.querySelector('.msg-dir').textContent, 'Lesson queued — 3 students not online');
});
test('group: the console case uses the run and the lesson in its key, and is the only grouped event in hubEvent', () => {
  const src = read('public/app.js');
  assert.match(src, /groupedRow\(els\.hubLog, `lesson_queued\|\$\{run \?\? ''\}\|\$\{data\.lessonId \?\? ''\}`/);
  assert.equal((src.match(/groupedRow\(els\./g) ?? []).length, 1);
  assert.match(src, /function hubEvent\(panel, type, data, run, at\)/);
});
