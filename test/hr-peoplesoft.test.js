// Part 15: HR reaches PeopleSoft (the demo stand-in) over MCP, and HR's AI chooses the tool at each moment.
//
// The staff caller is the harness's Professor stand-in (real createHubLink, real Hub signatures). HR runs in
// its mock mode (labelled heuristic: the moment's own tool) except in the wrong-pick test, where HR is live
// against the fake Anthropic API (never a real key, never the network). PeopleSoft is the real stand-in
// process the harness starts with every HR stack, on its own port, with a random token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { STAFF_ACTION_MEDIA_TYPE, STAFF_REQUEST_MEDIA_TYPE } from '../src/staff.js';
import { startStack, professorStandIn, waitFor, post, stopProcess } from './support/harness.js';
import { startFakeAnthropic, messageReply, toolChoiceReply } from './support/fake-anthropic.js';

const UNAVAILABLE = 'PeopleSoft didn\'t answer. Nothing is filed until it confirms — press Submit again; it won\'t file twice.';

// HR's own telemetry (its /viz/events feed), unredacted: the test reads what HR really emitted.
function follow(url) {
  const events = [];
  const abort = new AbortController();
  (async () => {
    const res = await fetch(`${url}/viz/events`, { signal: abort.signal });
    let buf = '';
    try {
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let end;
        while ((end = buf.indexOf('\n\n')) !== -1) {
          const data = buf.slice(0, end).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(end + 2);
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* closed */ }
  })();
  return { events, close: () => abort.abort() };
}

// A stack with HR + PeopleSoft + the Professor stand-in, its HR feed and the staff helpers.
async function hrStack(opts = {}) {
  const stack = await startStack({ hr: true, library: false, ...opts });
  const prof = await professorStandIn(stack).catch((err) => { stack.kill(); throw err; });
  const feed = follow(stack.hr.url);
  await waitFor(() => feed.events.length > 0, { what: 'HR feed connected' });
  const conversationOf = new Map();
  const ask = async (text, conversationId = randomUUID()) => {
    const operationId = randomUUID();
    const r = await prof.link.sendSigned(STAFF_REQUEST_MEDIA_TYPE, { type: 'staff_request', operationId, conversationId, text }, ['staff-request', operationId, conversationId], { timeoutMs: 30000 });
    if (r.reply?.formRef) conversationOf.set(r.reply.formRef, conversationId);
    return r;
  };
  const act = (formRef, action, operationId = randomUUID()) => {
    const conversationId = conversationOf.get(formRef);
    return prof.link.sendSigned(STAFF_ACTION_MEDIA_TYPE, { type: 'staff_action', operationId, formRef, action, conversationId }, ['staff-action', operationId, formRef, conversationId], { timeoutMs: 30000 });
  };
  const requests = async () => (await (await fetch(`${stack.hr.url}/test/hr/requests`)).json()).requests;
  const close = async () => { feed.close(); await prof.close().catch(() => {}); stack.kill(); };
  return { stack, prof, feed, ask, act, requests, close };
}
const surfaceOf = (reply) => reply.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
const submit = (reply, context) => ({ name: 'submitTimeOff', surfaceId: surfaceOf(reply), sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { note: '', ...context } });
const VACATION = { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' };
const ofType = (events, type) => events.filter((e) => e.type === type);

let s;
before(async () => { s = await hrStack(); });
after(async () => { await s?.close(); });

test('card issue calls get_leave_balances through MCP', async () => {
  const from = s.feed.events.length;
  const r = await s.ask("I need Friday off, it's a vacation day");
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.deepEqual(r.reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 }, 'balances from PeopleSoft');
  const events = s.feed.events.slice(from);
  const started = events.findIndex((e) => e.type === 'mcp_call_started' && e.data.tool === 'get_leave_balances' && e.data.moment === 'balances');
  const sent = events.findIndex((e) => e.type === 'form_sent');
  assert.ok(started >= 0, `mcp_call_started for get_leave_balances: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.ok(sent > started, 'the balances call comes before the card');
  const result = events.find((e) => e.type === 'mcp_call_result' && e.data.tool === 'get_leave_balances');
  assert.equal(result.data.ok, true);
  assert.equal(result.data.moment, 'balances');
  assert.equal(typeof result.data.latencyMs, 'number');
  assert.equal(events[started].runId, result.runId, 'the same run as HR’s other events');
  assert.ok(ofType(s.feed.events, 'peoplesoft_session').some((e) => e.data.status === 'connected'), 'session reported');
});

test('submit files in PeopleSoft and returns ABS record id', async () => {
  const card = await s.ask("I need Friday off, it's a vacation day");
  const from = s.feed.events.length;
  const done = await s.act(card.reply.formRef, submit(card.reply, VACATION));
  assert.equal(done.status, 'ok', JSON.stringify(done));
  assert.match(done.reply.receipt.recordId, /^ABS-\d{6}$/);
  assert.equal('steps' in done.reply.receipt, false, 'the wrapper’s steps never reach the receipt');
  const records = await s.requests();
  assert.equal(records.length, 1);
  assert.equal(records[0].recordId, done.reply.receipt.recordId);
  const events = s.feed.events.slice(from);
  const started = events.find((e) => e.type === 'mcp_call_started' && e.data.tool === 'create_absence_request');
  assert.equal(started.data.moment, 'submit');
  assert.ok(started.data.operationId);
  const result = events.find((e) => e.type === 'mcp_call_result' && e.data.tool === 'create_absence_request');
  assert.equal(result.data.recordId, done.reply.receipt.recordId);
  assert.ok(result.data.stepCount >= 4, 'only the step count is reported');
  assert.ok(!JSON.stringify(events).includes('store_record'), 'no step names in HR telemetry');
  assert.ok(!s.stack.hr.output().includes(s.stack.peoplesoftToken), 'the token is never logged');
});

test('reset reseeds PeopleSoft and closes the card', async () => {
  const card = await s.ask("I need Friday off, it's a vacation day");
  // PeopleSoft's own records (its test hook), not HR's view of them.
  const inPeopleSoft = async () => (await (await fetch(`${s.stack.peoplesoft.url}/test/records`)).json()).records;
  assert.ok((await inPeopleSoft()).length >= 1, 'the earlier test filed in PeopleSoft itself');
  const reset = await post(`${s.stack.hr.url}/dev/hr/reset`, {});
  assert.equal(reset.status, 200);
  assert.deepEqual(await inPeopleSoft(), [], 'PeopleSoft back to the sample');
  assert.deepEqual(await s.requests(), []);
  const late = await s.act(card.reply.formRef, submit(card.reply, VACATION));
  assert.equal(late.status, 'refused');
  assert.match(late.reason, /reset/i);
  assert.deepEqual(await s.requests(), []);
});

test('card opens without balances when PeopleSoft is down', async (t) => {
  const own = await hrStack();
  t.after(() => own.close());
  await stopProcess(own.stack.peoplesoft);
  const r = await own.ask("I need Friday off, it's a vacation day");
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.reply.hrCard.balances, null);
  assert.equal(r.reply.hrCard.problem, 'PeopleSoft didn\'t answer, so the balance isn\'t shown.');
  assert.ok(ofType(own.feed.events, 'peoplesoft_session').some((e) => e.data.status === 'unreachable'));
  const chat = await own.ask('how much sick leave do I have?');
  assert.equal(chat.reply.text, UNAVAILABLE);
});

test('uncertain submit then retry files once', async (t) => {
  const own = await hrStack({ peoplesoftEnv: { PEOPLESOFT_TEST_DELAY_MS: '1500' }, hrEnv: { PEOPLESOFT_TIMEOUT_MS: '300' } });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  assert.deepEqual(card.reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 });
  const operationId = randomUUID();
  const first = await own.act(card.reply.formRef, submit(card.reply, VACATION), operationId);
  assert.equal(first.status, 'refused', JSON.stringify(first));
  assert.equal(first.reason, UNAVAILABLE);
  assert.ok(own.feed.events.some((e) => e.type === 'mcp_call_result' && e.data.tool === 'create_absence_request' && e.data.outcome === 'uncertain'));
  await waitFor(async () => (await own.requests()).length === 1, { what: 'PeopleSoft wrote it anyway' });
  const again = await own.act(card.reply.formRef, submit(card.reply, VACATION), operationId);
  assert.equal(again.status, 'ok', JSON.stringify(again));
  assert.match(again.reply.receipt.recordId, /^ABS-\d{6}$/);
  assert.equal('steps' in again.reply.receipt, false);
  assert.equal((await own.requests()).length, 1, 'filed once');
});

test('a wrong tool pick makes no call', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  // The tool choice at Submit names the wrong tool; every other call gets its expected answer.
  stub.respondWith((body) => toolChoiceReply(body, { submit: 'list_absence_requests' }) ?? messageReply(JSON.stringify({ pair: 'VAC:VAC', quote: 'vacation', note: '', choices: [] })));
  const own = await hrStack({ hrEnv: { HR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  assert.deepEqual(card.reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 }, 'the balances moment got its tool');
  const from = own.feed.events.length;
  const done = await own.act(card.reply.formRef, submit(card.reply, VACATION));
  assert.equal(done.status, 'refused', JSON.stringify(done));
  const events = own.feed.events.slice(from);
  const refused = events.find((e) => e.type === 'mcp_tool_refused');
  assert.ok(refused, 'the wrong pick is reported');
  assert.equal(refused.data.tool, 'list_absence_requests');
  assert.equal(refused.data.moment, 'submit');
  assert.equal(events.filter((e) => e.type === 'mcp_call_started').length, 0, 'no MCP call');
  assert.deepEqual(await own.requests(), [], 'nothing filed');
  assert.ok(stub.requests.some((r) => r.body.output_config?.format?.schema?.properties?.tool), 'HR asked its model which tool');
});

test('through the real Professor: an unconfirmed Submit is outcome_unknown with the exact sentence; the same operation files once', async (t) => {
  const stack = await startStack({
    library: false, professor: true, hr: true,
    peoplesoftEnv: { PEOPLESOFT_TEST_DELAY_MS: '1500' }, hrEnv: { PEOPLESOFT_TIMEOUT_MS: '300' },
    hubEnv: { ROUTER_MODE: 'mock' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
  });
  t.after(() => stack.kill());
  const said = await post(`${stack.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text: 'I want to file for time off. I need Friday Nov 20 off, it is a vacation day' });
  assert.equal(said.status, 200);
  const st = await (await fetch(`${stack.ui.url}/api/professor/state`)).json();
  assert.ok(st.hrCard, 'the card is open');
  const body = { operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submit(st.hrCard, VACATION) };
  const hrAction = async () => { const res = await post(`${stack.professor.url}/author/hr-action`, body); return { http: res.status, ...(await res.json()) }; };
  const first = await hrAction();
  assert.equal(first.status, 'outcome_unknown', JSON.stringify(first));
  assert.equal(first.reply, UNAVAILABLE);
  assert.equal(first.closed, false, 'the card stays open');
  const again = await hrAction();
  assert.equal(again.status, 'accepted', JSON.stringify(again));
  assert.equal(again.duplicate, undefined, 'not an earlier stored answer');
  assert.equal('steps' in again.receipt, false);
  assert.equal((await (await fetch(`${stack.hr.url}/test/hr/requests`)).json()).requests.length, 1, 'filed once');
});
