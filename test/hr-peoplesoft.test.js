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
import { startStack, startPeopleSoft, professorStandIn, waitFor, post, stopProcess } from './support/harness.js';
import { startFakeAnthropic, messageReply, toolChoiceReply } from './support/fake-anthropic.js';

const UNAVAILABLE = 'HR\'s system didn\'t answer. Nothing is recorded until it confirms — press Submit again; it won\'t be filed twice.';
const UNAVAILABLE_CHAT = 'HR\'s system didn\'t answer, so I can\'t show your leave right now. Nothing changed — ask again in a moment.';
const WRONG_PICK_SUBMIT = 'Something went wrong on our side, so nothing was filed. Press Submit again.';
const WRONG_PICK_BALANCES = 'Your balance can\'t be shown right now.';

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
  assert.equal(r.reply.hrCard.problem, 'Your balance can\'t be shown right now.');
  assert.ok(ofType(own.feed.events, 'peoplesoft_session').some((e) => e.data.status === 'unreachable'));
  const read = own.feed.events.filter((e) => e.type === 'request_read').at(-1);
  assert.equal(read.data.outcome, 'no_balances', 'the only problem is the balances');
  const chat = await own.ask('how much sick leave do I have?');
  assert.equal(chat.reply.text, UNAVAILABLE_CHAT, 'chat gets its own words (the Submit sentence is for Submit)');
  assert.equal((await own.ask('show my time off requests')).reply.text, UNAVAILABLE_CHAT);
});

test('a PeopleSoft restart under a running HR: the next balances call reconnects once and succeeds', async (t) => {
  const own = await hrStack();
  t.after(() => own.close());
  assert.deepEqual((await own.ask("I need Friday off, it's a vacation day")).reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 });
  const port = new URL(own.stack.peoplesoft.url).port;
  await stopProcess(own.stack.peoplesoft);
  own.stack.peoplesoft = await startPeopleSoft({ PORT: port, PEOPLESOFT_TOKEN: own.stack.peoplesoftToken, PEOPLESOFT_TEST_HOOKS: '1' });
  const from = own.feed.events.length;
  const r = await own.ask("I need Friday off, it's a vacation day");
  assert.deepEqual(r.reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 }, 'balances after the restart');
  assert.equal(r.reply.hrCard.problem, null);
  const results = own.feed.events.slice(from).filter((e) => e.type === 'mcp_call_result' && e.data.tool === 'get_leave_balances');
  assert.equal(results.length, 1);
  assert.equal(results[0].data.ok, true);
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
  // Telemetry may land after the A2A reply (full-suite load): wait for it rather than assume the order.
  await waitFor(() => own.feed.events.some((e) => e.type === 'mcp_call_result' && e.data.tool === 'create_absence_request' && e.data.outcome === 'uncertain'), { what: 'mcp_call_result uncertain' });
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
  assert.equal(done.reason, WRONG_PICK_SUBMIT);
  assert.equal(done.reply.unknownOutcome, undefined, 'a definite answer: nothing was filed');
  assert.deepEqual(await own.requests(), [], 'nothing filed');
  assert.ok(stub.requests.some((r) => r.body.output_config?.format?.schema?.properties?.tool), 'HR asked its model which tool');
  // Not kept under the operation ID: the same operation reaches HR again (and its AI chooses again).
  const op = randomUUID();
  const first = await own.act(card.reply.formRef, submit(card.reply, VACATION), op);
  const second = await own.act(card.reply.formRef, submit(card.reply, VACATION), op);
  assert.equal(first.reason, WRONG_PICK_SUBMIT);
  assert.equal(second.reason, WRONG_PICK_SUBMIT);
  assert.equal(own.feed.events.filter((e) => e.type === 'mcp_tool_refused' && e.data.moment === 'submit').length, 3, 'asked every time, nothing stored');
});

test('a wrong tool pick at the balances moment: the card says so, PeopleSoft is not blamed', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  stub.respondWith((body) => toolChoiceReply(body, { balances: 'list_absence_requests' }) ?? messageReply(JSON.stringify({ pair: 'VAC:VAC', quote: 'vacation', note: '', choices: [] })));
  const own = await hrStack({ hrEnv: { HR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  assert.equal(card.reply.hrCard.balances, null);
  assert.equal(card.reply.hrCard.problem, WRONG_PICK_BALANCES);
  assert.equal(own.feed.events.filter((e) => e.type === 'request_read').at(-1).data.outcome, 'no_balances');
  assert.equal(own.feed.events.filter((e) => e.type === 'mcp_call_started').length, 0, 'no MCP call');
});

test('through the real Professor: a wrong tool pick at Submit is a definite rejection, not kept; the card stays open', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  stub.respondWith((body) => toolChoiceReply(body, { submit: 'get_leave_balances' }) ?? messageReply(JSON.stringify({ pair: 'VAC:VAC', quote: 'vacation', note: '', choices: [] })));
  const stack = await startStack({
    library: false, professor: true, hr: true,
    hrEnv: { HR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
    hubEnv: { ROUTER_MODE: 'mock' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
  });
  t.after(() => stack.kill());
  await post(`${stack.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text: 'I want to file for time off. I need Friday Nov 20 off, it is a vacation day' });
  const st = await (await fetch(`${stack.ui.url}/api/professor/state`)).json();
  assert.ok(st.hrCard, 'the card is open');
  const body = { operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submit(st.hrCard, VACATION) };
  const hrAction = async () => { const res = await post(`${stack.professor.url}/author/hr-action`, body); return { http: res.status, ...(await res.json()) }; };
  const first = await hrAction();
  assert.equal(first.status, 'rejected', JSON.stringify(first));
  assert.equal(first.reply, WRONG_PICK_SUBMIT);
  assert.equal(first.closed, false);
  const again = await hrAction();
  assert.equal(again.duplicate, undefined, 'not a stored answer');
  assert.ok((await (await fetch(`${stack.ui.url}/api/professor/state`)).json()).hrCard, 'the card stays open');
  assert.deepEqual((await (await fetch(`${stack.hr.url}/test/hr/requests`)).json()).requests, []);
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

test('connect and call share one MCP budget: a slow PeopleSoft cannot hold HR past it', async (t) => {
  const { createServer, request } = await import('node:http');
  const { createPeopleSoftLink } = await import('../src/hr-peoplesoft.js');
  const token = `tok-${randomUUID()}`;
  const ps = await startPeopleSoft({ PEOPLESOFT_TOKEN: token });
  t.after(() => stopProcess(ps));
  // A proxy that delays every request by 350 ms: each step alone fits 600 ms, the three together do not.
  const slow = createServer((req, res) => setTimeout(() => {
    const up = request(`${ps.url}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(ps.url).host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    req.on('error', () => up.destroy());
    res.on('close', () => up.destroy());
    req.pipe(up);
  }, 350));
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  t.after(() => { slow.closeAllConnections(); slow.close(); });
  const link = createPeopleSoftLink({ url: `http://127.0.0.1:${slow.address().port}`, token, timeoutMs: 600 });
  const t0 = Date.now();
  const r = await link.balances('staff-dabirian');
  assert.equal(r.ok, false, 'one budget for connect + list + call');
  assert.ok(['unavailable', 'uncertain'].includes(r.outcome), r.outcome);
  const took = Date.now() - t0;
  await link.close();
  await new Promise((r) => setTimeout(r, 500)); // let the SDK's stream settle before the proxy goes away
  assert.ok(took < 1000, `took ${took} ms`);
});

// ---- Part 15 final-review fixes ----------------------------------------------------------------------------
const CHOICE_FAILED_SUBMIT = 'Something went wrong on our side, so nothing was filed. Press Submit again.';
const CHOICE_FAILED_BALANCES = 'Your balance can\'t be shown right now.';
const CHOICE_FAILED_CHAT = 'Something went wrong on our side, so I can\'t show your leave right now. Nothing changed — ask again in a moment.';
const RESET_CLOSED = /closed when the HR records were reset/;
const liveHr = (stub) => ({ HR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' });
const isChoice = (body, moment) => Boolean(body?.output_config?.format?.schema?.properties?.tool) && { submit: /file the time-off request/, balances: /leave balances/ }[moment].test(String(body.system ?? ''));
const VAC_PAIR = () => messageReply(JSON.stringify({ pair: 'VAC:VAC', quote: 'vacation', note: '', choices: [] }));
// The card is closed at HR: a fresh Submit on it is refused with the reset words.
async function assertClosedByReset(own, card) {
  const again = await own.act(card.reply.formRef, submit(card.reply, VACATION));
  assert.equal(again.status, 'refused', JSON.stringify(again));
  assert.match(again.reason, RESET_CLOSED);
}

test('I1: New conversation during HR\'s tool choice — no PeopleSoft call, nothing filed, the card stays closed', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  stub.respondWith((body) => (isChoice(body, 'submit') ? { ...toolChoiceReply(body), delayMs: 1500 } : toolChoiceReply(body) ?? VAC_PAIR()));
  const own = await hrStack({ hrEnv: liveHr(stub) });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  const from = own.feed.events.length;
  const pending = own.act(card.reply.formRef, submit(card.reply, VACATION));
  await waitFor(() => stub.requests.some((r) => isChoice(r.body, 'submit')), { what: 'HR asked its AI for the Submit tool' });
  assert.equal((await post(`${own.stack.hr.url}/dev/hr/reset`, {})).status, 200);
  const late = await pending;
  assert.notEqual(late.status, 'ok', JSON.stringify(late));
  assert.equal(late.reply?.receipt, undefined, 'no receipt');
  assert.match(late.reason, RESET_CLOSED);
  assert.equal(own.feed.events.slice(from).filter((e) => e.type === 'mcp_call_started').length, 0, 'the call was skipped');
  assert.deepEqual(await own.requests(), [], 'nothing filed');
  await assertClosedByReset(own, card);
});

test('I1: New conversation while PeopleSoft\'s planner thinks — refused at PeopleSoft, nothing filed, the card stays closed', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  // PeopleSoft live against the fake API; its planner answers after 1.5 s. HR stays in mock mode.
  stub.respondWith(() => ({ ...messageReply('{"steps":["notify_timekeeper"]}'), delayMs: 1500 }));
  const own = await hrStack({ peoplesoftEnv: { PEOPLESOFT_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  const pending = own.act(card.reply.formRef, submit(card.reply, VACATION));
  await waitFor(() => stub.requests.length > 0, { what: 'PeopleSoft asked its planner' });
  assert.equal((await post(`${own.stack.hr.url}/dev/hr/reset`, {})).status, 200);
  const late = await pending;
  assert.notEqual(late.status, 'ok', JSON.stringify(late));
  assert.equal(late.reply?.receipt, undefined);
  assert.match(late.reason, RESET_CLOSED);
  const result = own.feed.events.find((e) => e.type === 'mcp_call_result' && e.data.tool === 'create_absence_request');
  assert.equal(result.data.code, 'reset_during_call', 'PeopleSoft refused the stale filing');
  assert.deepEqual(await own.requests(), [], 'the fresh records stay empty');
  await assertClosedByReset(own, card);
});

test('I1: New conversation after PeopleSoft filed but before HR heard back — the closed card is not turned into accepted', async (t) => {
  // PeopleSoft writes, then answers 1.5 s late (its test hook); the reset lands in between and wipes the record.
  const own = await hrStack({ peoplesoftEnv: { PEOPLESOFT_TEST_DELAY_MS: '1500' } });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  const pending = own.act(card.reply.formRef, submit(card.reply, VACATION));
  await waitFor(async () => (await own.requests()).length === 1, { what: 'PeopleSoft wrote it' });
  assert.equal((await post(`${own.stack.hr.url}/dev/hr/reset`, {})).status, 200);
  const late = await pending;
  assert.notEqual(late.status, 'ok', JSON.stringify(late));
  assert.equal(late.reply?.receipt, undefined, 'no receipt for a card the reset closed');
  assert.match(late.reason, RESET_CLOSED);
  assert.deepEqual(await own.requests(), []);
  await assertClosedByReset(own, card);
});

test('I2: HR\'s AI failing at the Submit tool choice is said plainly; definite, not stored, retryable', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  stub.respondWith((body) => (isChoice(body, 'submit') ? { status: 500 } : toolChoiceReply(body) ?? VAC_PAIR()));
  const own = await hrStack({ hrEnv: liveHr(stub) });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  assert.deepEqual(card.reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 });
  const from = own.feed.events.length;
  const op = randomUUID();
  const done = await own.act(card.reply.formRef, submit(card.reply, VACATION), op);
  assert.equal(done.status, 'refused', JSON.stringify(done));
  assert.equal(done.reason, CHOICE_FAILED_SUBMIT);
  assert.equal(done.reply.retryable, true);
  assert.equal(done.reply.unknownOutcome, undefined, 'definite: nothing was called');
  const events = own.feed.events.slice(from);
  const refused = events.find((e) => e.type === 'mcp_tool_refused');
  assert.equal(refused.data.by, 'model_failed');
  assert.equal(refused.data.moment, 'submit');
  assert.equal(events.filter((e) => e.type === 'mcp_call_started').length, 0, 'no MCP call');
  assert.deepEqual(await own.requests(), []);
  const again = await own.act(card.reply.formRef, submit(card.reply, VACATION), op);
  assert.equal(again.reason, CHOICE_FAILED_SUBMIT, 'not a stored answer: HR asked its AI again');
  assert.equal(own.feed.events.filter((e) => e.type === 'mcp_tool_refused' && e.data.by === 'model_failed').length, 2);
});

test('I2: HR\'s AI failing at the balances moment — the card and the chat say so, PeopleSoft is not blamed', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  stub.respondWith((body) => (isChoice(body, 'balances') ? { status: 500 } : toolChoiceReply(body) ?? VAC_PAIR()));
  const own = await hrStack({ hrEnv: liveHr(stub) });
  t.after(() => own.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  assert.equal(card.reply.hrCard.balances, null);
  assert.equal(card.reply.hrCard.problem, CHOICE_FAILED_BALANCES);
  const chat = await own.ask('how much sick leave do I have?');
  assert.equal(chat.reply.text, CHOICE_FAILED_CHAT);
  assert.equal(own.feed.events.filter((e) => e.type === 'mcp_call_started').length, 0, 'no MCP call');
  assert.ok(own.feed.events.some((e) => e.type === 'mcp_tool_refused' && e.data.by === 'model_failed' && e.data.moment === 'balances'));
});

test('M3: the session status follows the calls — unreachable when a call ends unavailable, connected again on the next success, only on a change', async (t) => {
  const own = await hrStack();
  t.after(() => own.close());
  await own.ask("I need Friday off, it's a vacation day");
  const sessions = (from) => ofType(own.feed.events.slice(from), 'peoplesoft_session').map((e) => e.data.status);
  assert.deepEqual(sessions(0), ['connected']);
  const port = new URL(own.stack.peoplesoft.url).port;
  await stopProcess(own.stack.peoplesoft);
  let from = own.feed.events.length;
  assert.equal((await own.ask("I need Friday off, it's a vacation day")).reply.hrCard.balances, null);
  assert.deepEqual(sessions(from), ['unreachable'], 'the open session failed: the pill must not keep saying connected');
  from = own.feed.events.length;
  await own.ask("I need Friday off, it's a vacation day");
  assert.deepEqual(sessions(from), [], 'still down: no repeat');
  own.stack.peoplesoft = await startPeopleSoft({ PORT: port, PEOPLESOFT_TOKEN: own.stack.peoplesoftToken, PEOPLESOFT_TEST_HOOKS: '1' });
  from = own.feed.events.length;
  assert.deepEqual((await own.ask("I need Friday off, it's a vacation day")).reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 });
  assert.deepEqual(sessions(from), ['connected']);
  from = own.feed.events.length;
  await own.ask("I need Friday off, it's a vacation day");
  assert.deepEqual(sessions(from), [], 'no change, no event');
});

test('M1: an unconfirmed Submit is "unknown" on the HR and Hub hops too (unknownOutcome passes the Hub allowlist)', async (t) => {
  const { topologyLabel } = await import('../src/topology.js');
  const own = await hrStack({ peoplesoftEnv: { PEOPLESOFT_TEST_DELAY_MS: '1500' }, hrEnv: { PEOPLESOFT_TIMEOUT_MS: '300' } });
  t.after(() => own.close());
  const hubFeed = follow(own.stack.hub.url);
  t.after(() => hubFeed.close());
  const card = await own.ask("I need Friday off, it's a vacation day");
  const first = await own.act(card.reply.formRef, submit(card.reply, VACATION));
  assert.equal(first.reply?.unknownOutcome, true, JSON.stringify(first));
  await waitFor(() => hubFeed.events.some((e) => e.source === 'hub' && e.type === 'form_result_relayed'), { what: 'Hub relayed the card result' });
  const relayed = hubFeed.events.find((e) => e.source === 'hub' && e.type === 'form_result_relayed');
  assert.equal(relayed.data.unknownOutcome, true);
  assert.equal(topologyLabel(relayed).phase, 'unknown');
  const result = hubFeed.events.find((e) => e.source === 'hr' && e.type === 'form_action_result' && e.data.status === 'rejected');
  assert.equal(result.data.unknownOutcome, true, 'kept by the Hub’s allowlist');
  assert.equal(topologyLabel(result).phase, 'unknown');
  await waitFor(() => hubFeed.events.some((e) => e.source === 'hub' && e.type === 'relay_sent' && e.data.kind === 'staff_action_result'), { what: 'Hub replied to the Professor' });
  const sent = hubFeed.events.find((e) => e.source === 'hub' && e.type === 'relay_sent' && e.data.kind === 'staff_action_result');
  assert.equal(topologyLabel(sent).phase, 'unknown');
});

test('owner 2026-11-04: what the employee reads never names PeopleSoft, MCP, tools or the AI', () => {
  for (const t of [UNAVAILABLE, UNAVAILABLE_CHAT, WRONG_PICK_SUBMIT, WRONG_PICK_BALANCES, CHOICE_FAILED_SUBMIT, CHOICE_FAILED_BALANCES, CHOICE_FAILED_CHAT]) assert.doesNotMatch(t, /PeopleSoft|MCP|\btools?\b|\bAI\b|\bHub\b|student agent/i, t);
});
