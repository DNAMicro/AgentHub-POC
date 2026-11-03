// HR (staff only): the Hub's signed staff path — Professor → Hub → HR — and HR hidden from students.
//
// The staff caller is a test stand-in for the Professor agent's Hub link (harness professorStandIn): it
// registers with the Hub through the real createHubLink, so the Hub verifies its signatures with the key
// it was really given. HR runs in its default mock mode (labelled heuristic): these tests prove plumbing
// and code-decided outcomes, not live judgment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { askTutor } from '../src/student-agent.js';
import { sendData } from '../src/a2a-data.js';
import { STAFF_ACTION_MEDIA_TYPE, STAFF_REQUEST_MEDIA_TYPE } from '../src/staff.js';
import { startStack, professorStandIn, openStream, chatVia, signedStudent, status, waitFor, post } from './support/harness.js';

let stack;
let prof;
let stream;
const hubEvents = [];
const abort = new AbortController();

before(async () => {
  // Mock router: the student path really routes (the code default sends everything to tutoring).
  stack = await startStack({ hr: true, library: false, hubEnv: { ROUTER_MODE: 'mock' } });
  prof = await professorStandIn(stack);
  stream = await openStream(stack.ui.url);
  (async () => {
    const res = await fetch(`${stack.hub.url}/viz/events`, { signal: abort.signal });
    let buf = '';
    try {
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let end;
        while ((end = buf.indexOf('\n\n')) !== -1) {
          const data = buf.slice(0, end).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(end + 2);
          if (data) hubEvents.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* closed */ }
  })();
});
after(async () => {
  abort.abort();
  stream?.close();
  await prof?.close().catch(() => {});
  stack?.kill();
});

// Each card's conversation (staff actions always carry it, and it is signed): formRef → conversationId.
const conversationOf = new Map();
const ask = async (text, conversationId, operationId = randomUUID()) => {
  const r = await prof.link.sendSigned(STAFF_REQUEST_MEDIA_TYPE, { type: 'staff_request', operationId, conversationId, text }, ['staff-request', operationId, conversationId], { timeoutMs: 30000 });
  if (r.reply?.formRef) conversationOf.set(r.reply.formRef, conversationId);
  return r;
};
const act = (formRef, action, operationId = randomUUID(), conversationId = conversationOf.get(formRef) ?? randomUUID()) =>
  prof.link.sendSigned(STAFF_ACTION_MEDIA_TYPE, { type: 'staff_action', operationId, formRef, action, conversationId }, ['staff-action', operationId, formRef, conversationId], { timeoutMs: 30000 });
const surfaceOf = (reply) => reply.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
const dataModel = (reply) => reply.a2ui.find((m) => m.updateDataModel).updateDataModel.value;
const submit = (reply, context) => ({ name: 'submitTimeOff', surfaceId: surfaceOf(reply), sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { relationship: '', note: '', ...context } });
const requests = async () => (await (await fetch(`${stack.hr.url}/test/hr/requests`)).json()).requests;
const hubEvent = (runId, type) => waitFor(() => hubEvents.find((e) => e.source === 'hub' && e.runId === runId && e.type === type), { what: `${type} for ${runId}` });

test('a professor-signed staff request reaches HR and comes back with its card (bereavement)', async () => {
  const operationId = randomUUID();
  const r = await ask('My grandmother passed away, I need this Thursday and Friday', randomUUID(), operationId);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.reply.servedBy, 'hr');
  assert.match(r.reply.formRef, /^hf-/);
  assert.equal(r.reply.hrCard.title, 'Bereavement/Funeral');
  assert.equal(dataModel(r.reply).relationship, 'grandmother', 'relationship prefilled from the words');
  assert.match(r.reply.text, /^I'm sorry for your loss\. Here's your request\. Check it and submit\./);
  // The Hub routed it on the staff path: no router call, HR the only staff destination.
  const route = await hubEvent(`staff-${operationId}`, 'route_decided');
  assert.equal(route.data.decidedBy, 'staff');
  assert.equal(route.data.agentId, 'hr');
  await hubEvent(`staff-${operationId}`, 'staff_request_received');
  const relay = await hubEvent(`staff-${operationId}`, 'relay_sent');
  assert.equal(relay.data.to, 'professor');
});

test('staff parts without a valid signature from a registered agent are refused', async () => {
  const operationId = randomUUID();
  const conversationId = randomUUID();
  const forged = await sendData(stack.hub.url, { mediaType: STAFF_REQUEST_MEDIA_TYPE, value: { type: 'staff_request', operationId, conversationId, text: 'I need Friday off', professorId: 'professor', instanceId: prof.link.instanceId, signature: 'forged' } });
  assert.equal(forged.ok, true);
  assert.equal(forged.value.status, 'refused');
  assert.equal(forged.value.reply, undefined, 'nothing from HR');
  const unregistered = await sendData(stack.hub.url, { mediaType: STAFF_REQUEST_MEDIA_TYPE, value: { type: 'staff_request', operationId, conversationId, text: 'I need Friday off', professorId: 'tutor', instanceId: randomUUID(), signature: 'x' } });
  assert.equal(unregistered.value.status, 'refused');
  const action = await sendData(stack.hub.url, { mediaType: STAFF_ACTION_MEDIA_TYPE, value: { type: 'staff_action', operationId, formRef: 'hf-x', action: {}, conversationId, professorId: 'professor', instanceId: prof.link.instanceId, signature: 'forged' } });
  assert.equal(action.value.status, 'refused');
  assert.equal((await requests()).length, 0);
});

test('missing absence name: HR asks; the follow-up fills the card; Forecast refusal; submit; duplicate operation', async () => {
  const conversationId = randomUUID();
  const first = await ask('I need Friday off', conversationId);
  assert.equal(first.status, 'ok');
  assert.ok(first.reply.hrCard.missing.includes('absenceName'));
  assert.match(first.reply.text, /What kind of time off is this — for example vacation, sick, or a personal holiday\?$/);

  const second = await ask("it's a vacation day", conversationId);
  assert.equal(second.status, 'ok');
  assert.equal(second.reply.hrCard.title, 'Vacation');
  assert.notEqual(second.reply.formRef, first.reply.formRef);
  // The replaced card can no longer be acted on.
  const stale = await act(first.reply.formRef, submit(first.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(stale.status, 'refused');
  assert.match(stale.reason, /replaced/);
  assert.equal(stale.code, 'card_closed', 'typed: the sender never parses the wording');

  // The conversation is required and must be the card's own (it is signed too).
  const elsewhere = await act(second.reply.formRef, submit(second.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), randomUUID(), randomUUID());
  assert.equal(elsewhere.status, 'refused');
  assert.match(elsewhere.reason, /another conversation/);
  assert.equal(elsewhere.code, 'card_closed');
  const noConversationOp = randomUUID();
  const missing = await prof.link.sendSigned(STAFF_ACTION_MEDIA_TYPE, { type: 'staff_action', operationId: noConversationOp, formRef: second.reply.formRef, action: submit(second.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }) }, ['staff-action', noConversationOp, second.reply.formRef, undefined], { timeoutMs: 30000 });
  assert.equal(missing.status, 'refused');
  assert.match(missing.reason, /another conversation/);
  // A signature over a different conversation than the one sent does not verify.
  const swapOp = randomUUID();
  const swapped = await prof.link.sendSigned(STAFF_ACTION_MEDIA_TYPE, { type: 'staff_action', operationId: swapOp, formRef: second.reply.formRef, action: submit(second.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), conversationId }, ['staff-action', swapOp, second.reply.formRef, randomUUID()], { timeoutMs: 30000 });
  assert.equal(swapped.status, 'refused');
  assert.match(swapped.reason, /isn’t signed/);
  assert.equal((await requests()).length, 0);

  // Review Focus 4 through the Hub: the Forecast refuses 104 h of vacation (96 left), with its own words.
  const big = await act(second.reply.formRef, submit(second.reply, { absenceName: ['Vacation'], beginDate: '2026-11-16', endDate: '2026-12-04', hours: '104' }));
  assert.equal(big.status, 'refused', JSON.stringify(big));
  assert.equal(big.reason, 'Not enough vacation hours: 104 needed, 96 left.');
  assert.equal((await requests()).length, 0);

  const operationId = randomUUID();
  const ok = await act(second.reply.formRef, submit(second.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), operationId);
  assert.equal(ok.status, 'ok', JSON.stringify(ok));
  assert.equal(ok.reply.text, 'Sent to your manager for a decision.');
  assert.match(ok.reply.receipt.requestId, /^TO-/);
  assert.equal(ok.reply.closed, true);
  const again = await act(second.reply.formRef, submit(second.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), operationId);
  assert.equal(again.status, 'ok');
  assert.equal(again.reply.receipt.requestId, ok.reply.receipt.requestId);
  assert.equal((await requests()).length, 1, 'the same operation is recorded once');
  await post(`${stack.hr.url}/dev/hr/reset`, {});
});

test('switching to an absence name that needs no relationship drops the relationship', async () => {
  const conversationId = randomUUID();
  const first = await ask('My grandmother passed away, I need this Thursday and Friday', conversationId);
  assert.equal(dataModel(first.reply).relationship, 'grandmother');
  const second = await ask("it's a vacation day", conversationId);
  assert.equal(second.reply.hrCard.title, 'Vacation');
  assert.equal(dataModel(second.reply).relationship, '', 'no relationship on a vacation card');
  assert.ok(!second.reply.hrCard.missing.includes('relationship'));
});

test('Review Focus 5: a student asking for time off never reaches HR; HR is not a student capability', async () => {
  const card = await (await fetch(`${stack.hub.url}/.well-known/agent-card.json`)).json();
  assert.ok(!card.skills.some((s) => s.id === 'hr'), 'not on the public Hub card');
  assert.ok(!(await status(stack.ui)).university.capabilities.some((c) => c.id === 'hr'), 'not in the Student’s capability list');

  const r = await chatVia(stack.ui, stream, 'I need time off from class next week');
  assert.notEqual(r.reply?.servedBy, 'hr');
  assert.notEqual(r.decision?.agentId, 'hr');
  assert.ok(!stream.events.some((e) => e.source === 'hr' && e.type === 'message_received' && e.runId === r.runId));

  // Forced: a student naming 'hr' as the capability is rejected and routed by the Hub instead.
  const runId = randomUUID();
  const sam = await signedStudent(stack.hub.url, 'student-sam');
  const reply = await askTutor(stack.hub.url, 'I need time off from class next week', { runId, signer: sam.signer, metadata: { ...sam.metadata, requestedCapability: 'hr' } });
  assert.equal((await hubEvent(runId, 'capability_rejected')).data.capability, 'hr');
  assert.notEqual((await hubEvent(runId, 'route_decided')).data.agentId, 'hr');
  assert.notEqual(reply.servedBy, 'hr');
  assert.equal((await requests()).length, 0);
});

test('resets: an HR reset closes open cards; the classroom reset resets HR and drops staff form references', async () => {
  // HR's own reset: the Hub still knows the card, but HR refuses it in plain words.
  const before = await ask("I need Friday off, it's a vacation day", randomUUID());
  assert.equal(before.reply.hrCard.title, 'Vacation');
  assert.equal((await post(`${stack.hr.url}/dev/hr/reset`, {})).status, 200);
  const late = await act(before.reply.formRef, submit(before.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(late.status, 'refused');
  assert.match(late.reason, /reset/i);
  assert.equal((await requests()).length, 0);

  // The classroom reset (New conversation): HR records back to the sample, every staff card forgotten.
  const one = await ask("I need Friday off, it's a vacation day", randomUUID());
  const done = await act(one.reply.formRef, submit(one.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(done.status, 'ok');
  assert.equal((await requests()).length, 1);
  const open = await ask("I need Friday off, it's a vacation day", randomUUID());
  const reset = await (await post(`${stack.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(reset.hr, 'reset');
  assert.equal((await requests()).length, 0);
  const after = await act(open.reply.formRef, submit(open.reply, { absenceName: ['Vacation'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(after.status, 'refused');
  assert.match(after.reason, /Unknown or altered form reference/);
});
