// HR (staff only), Task 7: the card on screen. These tests cover the UI server's side of the Professor
// view: the open card reaches the browser in the Professor state, Submit/Cancel go browser → UI server →
// Hub (developer proxy) → Professor agent → Hub → HR, the route is origin-guarded, the staff run's events
// reach the monitoring stream with topology labels (Hub → HR hop), and `npm run demo` starts HR.
//
// Mock Professor (labelled heuristic classifier) and mock HR: plumbing and code-decided outcomes only.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startStack, post, openStream, waitFor } from './support/harness.js';
import { topologyLabel } from '../src/topology.js';
import { professorViewRun } from '../src/ui-server.js';

let s;
before(async () => {
  s = await startStack({
    library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off', TUTOR_MOCK_DELAY_MS: '1500' }, // the delay keeps a student run open during a staff turn
  });
});
after(() => s?.kill());
beforeEach(async () => {
  const r = await (await post(`${s.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(r.hr, 'reset');
});

const say = async (text) => (await post(`${s.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text })).json();
const state = async () => (await fetch(`${s.ui.url}/api/professor/state`)).json();
const requests = async () => (await (await fetch(`${s.hr.url}/test/hr/requests`)).json()).requests;
const act = async (body, headers = {}) => {
  const res = await post(`${s.ui.url}/api/professor/hr/actions`, body, headers);
  return { http: res.status, ...(await res.json()) };
};
const surfaceOf = (card) => card.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
// The action exactly as the A2UI renderer produces it (same shape the student side posts to /api/forms/:id/actions).
const userAction = (card, name, button, context) => ({ name, surfaceId: surfaceOf(card), sourceComponentId: button, timestamp: new Date().toISOString(), context });
const lastOf = (chat, role) => chat.filter((m) => m.role === role).at(-1);
const GRANDMOTHER = 'I want to file for time off. My grandmother passed away, I need this Thursday and Friday';

test('the grandmother message: the Professor state carries the card; Submit through the UI server files it and the chat has the receipt', async () => {
  const r = await say(GRANDMOTHER);
  assert.equal(r.action, 'staff');
  let st = await state();
  assert.equal(st.hrCard.card.title, 'Bereavement');
  assert.equal(st.hrCard.card.subtitle, 'Grandparent/Great Grandparent');
  assert.match(st.hrCard.card.why, /^Picked from what you wrote: “.+”\.$/);
  assert.ok(st.hrCard.a2ui.some((m) => m.createSurface), 'the A2UI surface travels to the browser');
  assert.equal(lastOf(st.chat, 'hr').formRef, st.hrCard.formRef, 'the HR chat entry names the open card');

  const operationId = `op-${randomUUID()}`;
  const done = await act({ operationId, formRef: st.hrCard.formRef, action: userAction(st.hrCard, 'submitTimeOff', 'submit_button', { absenceType: ['BRV'], absenceReason: ['GGP'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '16', note: '' }) });
  assert.equal(done.http, 200, JSON.stringify(done));
  assert.equal(done.status, 'accepted');
  st = await state();
  assert.equal(lastOf(st.chat, 'hr').text, `Your time off is recorded. Request ${done.receipt.requestId}: Bereavement (Grandparent/Great Grandparent), Thu, Nov 5 to Fri, Nov 6, 16 hours.`);
  assert.equal(st.hrCard, null, 'the card is closed');
  assert.equal((await requests()).length, 1);
  assert.equal(st.lessons.length, 0, 'never posted to students');
});

test('Sick Leave: the UI server posts absenceType/absenceReason codes and the chat gets the receipt', async () => {
  const r = await say("I want to file for time off, I'm sick and need Friday off");
  assert.equal(r.action, 'staff', JSON.stringify(r));
  let st = await state();
  assert.equal(st.hrCard.card.title, 'Sick Leave');
  const done = await act({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: userAction(st.hrCard, 'submitTimeOff', 'submit_button', { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8', note: '' }) });
  assert.equal(done.http, 200, JSON.stringify(done));
  assert.equal(done.status, 'accepted');
  assert.equal(done.receipt.absenceType, 'SCK');
  assert.equal(done.receipt.absenceReason, 'SCK');
  st = await state();
  assert.equal(lastOf(st.chat, 'hr').text, `Your time off is recorded. Request ${done.receipt.requestId}: Sick Leave (Sick Personal), Fri, Nov 6, 8 hours.`);
  const filed = await requests();
  assert.equal(filed.length, 1);
  assert.equal(filed[0].hours, 8);
});

test('Cancel through the UI server closes the card without filing', async () => {
  await say("I need Friday off, it's a vacation day");
  let st = await state();
  const r = await act({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: userAction(st.hrCard, 'cancelForm', 'cancel_button', {}) });
  assert.equal(r.status, 'cancelled', JSON.stringify(r));
  st = await state();
  assert.equal(st.hrCard, null);
  assert.equal(lastOf(st.chat, 'hr').text, 'You cancelled this card. Nothing was filed.');
  // Owner 2026-11-04: ONE cancel sentence on screen. The chat keeps a single closing entry, flagged so the screen
  // shows its words once (on the closed card) and not again as a separate HR bubble.
  assert.equal(st.chat.filter((m) => m.role === 'hr' && m.closed).length, 1);
  assert.equal(lastOf(st.chat, 'hr').cancelled, true);
  assert.deepEqual(await requests(), []);
});

test('input checks at the UI server: cross-site Origin 403, unexpected fields 400, invalid values 400 — nothing reaches HR', async () => {
  await say(GRANDMOTHER);
  const st = await state();
  const good = { operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: userAction(st.hrCard, 'submitTimeOff', 'submit_button', { absenceType: ['BRV'], absenceReason: ['GGP'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '16', note: '' }) };
  assert.equal((await act(good, { Origin: 'http://evil.example' })).http, 403);
  assert.equal((await act({ ...good, extra: 1 })).http, 400);
  assert.equal((await act({ ...good, operationId: 'bad id!' })).http, 400);
  assert.equal((await act({ ...good, action: { ...good.action, url: 'x' } })).http, 400);
  assert.equal((await act({ ...good, action: { ...good.action, sourceComponentId: 'cancel_button' } })).http, 400, 'action must come from its own button');
  const invalid = await act({ ...good, action: { ...good.action, context: { ...good.action.context, absenceType: [] } } });
  assert.equal(invalid.http, 400);
  assert.ok(invalid.errors?.absenceType, JSON.stringify(invalid));
  // A stale reason from another name (an old browser) is refused too.
  const foreign = await act({ ...good, action: { ...good.action, context: { ...good.action.context, absenceReason: ['VAC'] } } });
  assert.equal(foreign.http, 400);
  assert.equal(foreign.errors?.absenceReason, 'Choose a reason.', JSON.stringify(foreign));
  // The old relationship field is not a card field any more.
  assert.equal((await act({ ...good, action: { ...good.action, context: { ...good.action.context, relationship: 'grandmother' } } })).http, 400);
  assert.deepEqual(await requests(), []);
  assert.ok((await state()).hrCard, 'the card is still open');
});

test('the staff run reaches the monitoring stream with topology labels: Professor → Hub → HR and back', async () => {
  const stream = await openStream(s.ui.url);
  try {
    await say(GRANDMOTHER);
    const hop = (edge, from, to) => stream.events.find((e) => e.runId?.startsWith('staff-') && e.topo?.edge === edge && e.topo.from === from && e.topo.to === to);
    await waitFor(() => hop('hub-hr', 'hub', 'hr') && hop('hub-professor', 'professor', 'hub') && hop('hub-professor', 'hub', 'professor'), { what: 'staff hops on the monitoring stream' });
    assert.ok(stream.events.some((e) => e.source === 'hr' && e.runId?.startsWith('staff-')), 'HR’s own events for the staff run');
    // HR content never leaves through the Hub's allowlist (no HUB_TELEMETRY_SHOW_CONTENT here). (HR's own skill
    // examples on its status event mention a grandmother too, so only the staff run's events are checked.)
    const staffEvents = stream.events.filter((e) => e.runId?.startsWith('staff-') || e.type === 'staff_decision');
    assert.ok(staffEvents.length >= 8, `staff events: ${staffEvents.length}`);
    assert.ok(!/grandmother|passed away/i.test(JSON.stringify(staffEvents)), 'no staff words in telemetry');
  } finally {
    stream.close();
  }
});

test('topology labels: HR is a node behind the Hub with its own model box', () => {
  assert.equal(topologyLabel({ source: 'hub', type: 'forward_attempted', data: { agentId: 'hr' } }).edge, 'hub-hr');
  assert.equal(topologyLabel({ source: 'hr', type: 'model_call_started', data: { mode: 'live', model: 'claude-haiku-5-5' } }).edge, 'hr-model');
  assert.equal(topologyLabel({ source: 'hr', type: 'model_call_started', data: { mode: 'mock' } }).edge, null, 'a mock read stays inside HR');
  const relay = topologyLabel({ source: 'hub', type: 'relay_sent', data: { to: 'professor', kind: 'staff_reply' } });
  assert.deepEqual([relay.edge, relay.from, relay.to], ['hub-professor', 'hub', 'professor']);
  // A student reply is still Hub → Student.
  assert.equal(topologyLabel({ source: 'hub', type: 'relay_sent', data: { kind: 'answer' } }).edge, 'student-hub');
});

test('npm run demo starts ten processes, HR and PeopleSoft among them (each MCP token goes to its two processes only); the Hub snapshot labels HR as a staff service', async () => {
  const src = readFileSync(new URL('../scripts/start-all.js', import.meta.url), 'utf8');
  assert.match(src, /\['hr', 'src\/hr-agent\.js', \{ HR_MODE: live \? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken \}\]/);
  assert.match(src, /\['psoft', 'src\/peoplesoft-mcp\.js', \{ PEOPLESOFT_MODE: live \? 'live' : 'mock', PEOPLESOFT_TOKEN: peoplesoftToken \}\]/);
  assert.equal((src.match(/PEOPLESOFT_TOKEN: peoplesoftToken/g) ?? []).length, 2, 'only HR and PeopleSoft get the token');
  assert.match(src, /randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(src, /ten/i);
  // Part 17: the records server starts before CHRS; its token goes to those two only.
  assert.match(src, /\['records', 'src\/student-records-mcp\.js', \{ STUDENT_RECORDS_MODE: live \? 'live' : 'mock', STUDENT_RECORDS_TOKEN: recordsToken \}\]/);
  assert.match(src, /\['chrs', 'src\/chrs-agent\.js', \{ CHRS_MODE: live \? 'live' : 'mock', STUDENT_RECORDS_TOKEN: recordsToken \}\]/);
  assert.equal((src.match(/STUDENT_RECORDS_TOKEN: recordsToken/g) ?? []).length, 2, 'only records and CHRS get the token');
  assert.ok(src.indexOf("['records'") < src.indexOf("['chrs'"), 'records starts before CHRS');
  assert.match(src, /\['canvas', 'src\/canvas-mcp\.js', \{ CANVAS_MODE: live \? 'live' : 'mock', CANVAS_TOKEN: canvasToken \}\]/);
  assert.match(src, /\['prof', 'src\/professor-agent\.js', \{[^}]*CANVAS_URL: 'http:\/\/127\.0\.0\.1:41247', CANVAS_TOKEN: canvasToken \}\]/);
  assert.equal((src.match(/CANVAS_TOKEN: canvasToken/g) ?? []).length, 2, 'only Faculty and Canvas get the Canvas token');
  const topo = await (await fetch(`${s.hub.url}/viz/topology`)).json();
  assert.equal(topo.hub.destinations.find((d) => d.destination === 'hr').audience, 'staff');
  const hr = topo.specialists.find((x) => x.agentId === 'hr');
  assert.equal(hr.audience, 'staff');
  assert.match(hr.role, /staff/i);
});

test('professor-view runs: staff-* only from the Hub, HR and the Professor; prof-* only from the Professor; IDs follow the operation-ID rule', () => {
  for (const source of ['hub', 'hr', 'professor', 'chrs']) assert.equal(professorViewRun(source, 'staff-op-123'), 'staff', source);
  for (const source of ['tutor', 'library', 'student', 'system']) assert.equal(professorViewRun(source, 'staff-op-123'), null, `${source}: a foreign source is dropped`);
  assert.equal(professorViewRun('professor', 'prof-op-123'), 'prof');
  for (const source of ['hub', 'hr', 'tutor']) assert.equal(professorViewRun(source, 'prof-op-123'), null, `${source}: prof-* only from the Professor`);
  // Operation IDs are 6–80 of [\w-] (src/lessons.js ID): a 6-character ID is a valid run, 5 or 81 are not.
  assert.equal(professorViewRun('hub', 'staff-abcdef'), 'staff');
  assert.equal(professorViewRun('professor', 'prof-abcdef'), 'prof');
  assert.equal(professorViewRun('hub', 'staff-abcde'), null);
  assert.equal(professorViewRun('hub', `staff-${'a'.repeat(81)}`), null);
  assert.equal(professorViewRun('hub', 'staff-bad id!'), null);
  assert.equal(professorViewRun('hub', null), null);
});

test('professor and staff runs stay out of the student AG-UI stream (they still reach the monitor)', async () => {
  const agui = await aguiEvents(`${s.ui.url}/api/ag-ui/stream`);
  const stream = await openStream(s.ui.url);
  try {
    // A student run is open (mock Tutor) while the professor makes a staff turn.
    const started = await post(`${s.ui.url}/api/runs`, { text: 'Explain the derivative of x squared' });
    assert.equal(started.status, 202);
    const { runId } = await started.json();
    const r = await say('Out sick tomorrow'); // mock heuristic: unsure → asked; the staff run's events only
    assert.equal(r.action, 'clarify');
    await waitFor(() => stream.events.some((e) => e.runId === runId && e.type === 'state' && ['completed', 'failed'].includes(e.data.state)), { what: 'student run done', timeout: 10000 });
    await waitFor(() => stream.events.some((e) => e.runId?.startsWith('staff-')), { what: 'staff run on the monitor' });
    await new Promise((res) => setTimeout(res, 300));
    const leaked = agui.events.filter((e) => /"runId":"(staff|prof)-|"parentRunId":"(staff|prof)-/.test(JSON.stringify(e)));
    assert.deepEqual(leaked.map((e) => e.type), [], 'no professor/staff run events in the student bridge');
    assert.ok(agui.events.length > 0, 'the student bridge did carry the student run');
  } finally {
    agui.close();
    stream.close();
  }
});

async function aguiEvents(url) {
  const abort = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: abort.signal });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer.slice(0, end).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        buffer = buffer.slice(end + 2);
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch(() => {});
  return { events, close: () => abort.abort() };
}
