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
const ask = async (text, conversationId, operationId = randomUUID(), formValues = undefined) => {
  const r = await prof.link.sendSigned(STAFF_REQUEST_MEDIA_TYPE, { type: 'staff_request', operationId, conversationId, text, ...(formValues ? { formValues } : {}) }, ['staff-request', operationId, conversationId], { timeoutMs: 30000 });
  if (r.reply?.formRef) conversationOf.set(r.reply.formRef, conversationId);
  return r;
};
const act = (formRef, action, operationId = randomUUID(), conversationId = conversationOf.get(formRef) ?? randomUUID()) =>
  prof.link.sendSigned(STAFF_ACTION_MEDIA_TYPE, { type: 'staff_action', operationId, formRef, action, conversationId }, ['staff-action', operationId, formRef, conversationId], { timeoutMs: 30000 });
const surfaceOf = (reply) => reply.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
const dataModel = (reply) => reply.a2ui.find((m) => m.updateDataModel).updateDataModel.value;
const submit = (reply, context) => ({ name: 'submitTimeOff', surfaceId: surfaceOf(reply), sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { note: '', ...context } });
const requests = async () => (await (await fetch(`${stack.hr.url}/test/hr/requests`)).json()).requests;
const hubEvent = (runId, type) => waitFor(() => hubEvents.find((e) => e.source === 'hub' && e.runId === runId && e.type === type), { what: `${type} for ${runId}` });

test('a professor-signed staff request reaches HR and comes back with its card (bereavement)', async () => {
  const operationId = randomUUID();
  const r = await ask('My grandmother passed away, I need this Thursday and Friday', randomUUID(), operationId);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.reply.servedBy, 'hr');
  assert.match(r.reply.formRef, /^hf-/);
  assert.equal(r.reply.hrCard.title, 'Bereavement');
  assert.equal(r.reply.hrCard.subtitle, 'Grandparent/Great Grandparent');
  assert.match(r.reply.hrCard.why, /^Picked from what you wrote: “.+”\.$/);
  assert.deepEqual(dataModel(r.reply).absenceType, ['BRV']);
  assert.deepEqual(dataModel(r.reply).absenceReason, ['GGP'], 'the reason is the relationship, read by code from the words');
  assert.equal(dataModel(r.reply).relationship, undefined, 'no relationship field');
  assert.deepEqual(r.reply.hrCard.balances, { vacation: 96, sick: 120, personalHoliday: 8 });
  assert.equal(r.reply.hrCard.credit, null, 'Bereavement uses no balance');
  assert.equal(r.reply.text, "I'm sorry for your loss. Check it and submit.");
  assert.equal(r.reply.hrCard.intro, "I'm sorry for your loss. Check it and submit.");
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
  assert.ok(first.reply.hrCard.missing.includes('absenceType'));
  assert.equal(first.reply.text, 'What kind of time off is this? If none of these fit, pick from the dropdown below.');
  assert.deepEqual(first.reply.hrCard.choices, [{ type: 'VAC', name: 'Vacation' }, { type: 'SCK', name: 'Sick Leave' }, { type: 'PHL', name: 'Personal Holiday' }], 'nothing to go on: his three leave balances');
  assert.equal(first.reply.hrCard.question, null, 'the lead line asks for the name');

  const second = await ask("it's a vacation day", conversationId);
  assert.equal(second.status, 'ok');
  assert.equal(second.reply.hrCard.title, 'Vacation');
  assert.deepEqual(second.reply.hrCard.choices, [], 'a name is picked: no choices');
  assert.equal(second.reply.text, 'Check it and submit.');
  assert.notEqual(second.reply.formRef, first.reply.formRef);
  // The replaced card can no longer be acted on.
  const stale = await act(first.reply.formRef, submit(first.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(stale.status, 'refused');
  assert.match(stale.reason, /replaced/);
  assert.equal(stale.code, 'card_closed', 'typed: the sender never parses the wording');

  // The conversation is required and must be the card's own (it is signed too).
  const elsewhere = await act(second.reply.formRef, submit(second.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), randomUUID(), randomUUID());
  assert.equal(elsewhere.status, 'refused');
  assert.match(elsewhere.reason, /another conversation/);
  assert.equal(elsewhere.code, 'card_closed');
  const noConversationOp = randomUUID();
  const missing = await prof.link.sendSigned(STAFF_ACTION_MEDIA_TYPE, { type: 'staff_action', operationId: noConversationOp, formRef: second.reply.formRef, action: submit(second.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }) }, ['staff-action', noConversationOp, second.reply.formRef, undefined], { timeoutMs: 30000 });
  assert.equal(missing.status, 'refused');
  assert.match(missing.reason, /another conversation/);
  // A signature over a different conversation than the one sent does not verify.
  const swapOp = randomUUID();
  const swapped = await prof.link.sendSigned(STAFF_ACTION_MEDIA_TYPE, { type: 'staff_action', operationId: swapOp, formRef: second.reply.formRef, action: submit(second.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), conversationId }, ['staff-action', swapOp, second.reply.formRef, randomUUID()], { timeoutMs: 30000 });
  assert.equal(swapped.status, 'refused');
  assert.match(swapped.reason, /isn’t signed/);
  assert.equal((await requests()).length, 0);

  // Review Focus 4 through the Hub: the Forecast refuses 104 h of vacation (96 left), with its own words.
  const big = await act(second.reply.formRef, submit(second.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-16', endDate: '2026-12-04', hours: '104' }));
  assert.equal(big.status, 'refused', JSON.stringify(big));
  assert.equal(big.reason, 'Not enough vacation: 104 hours needed, 96 left.');
  assert.equal((await requests()).length, 0);

  const operationId = randomUUID();
  const ok = await act(second.reply.formRef, submit(second.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), operationId);
  assert.equal(ok.status, 'ok', JSON.stringify(ok));
  assert.equal(ok.reply.text, 'Sent to your manager for a decision.');
  assert.match(ok.reply.receipt.requestId, /^TO-/);
  assert.equal(ok.reply.closed, true);
  const again = await act(second.reply.formRef, submit(second.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }), operationId);
  assert.equal(again.status, 'ok');
  assert.equal(again.reply.receipt.requestId, ok.reply.receipt.requestId);
  assert.equal((await requests()).length, 1, 'the same operation is recorded once');
  // The absence name is a leave detail too (some names are health details): the server log shows it redacted.
  assert.match(stack.hr.output(), /received form action/);
  assert.doesNotMatch(stack.hr.output(), /absenceType: (?!'\[redacted\]')/, 'the absence name is never logged');
  await post(`${stack.hr.url}/dev/hr/reset`, {});
});

test('school visit (user report 2026-11-03): no name picked, three choices offered, half a day is 4 hours', async () => {
  const conversationId = randomUUID();
  const r = await ask('I need to file for a leave to take my kid to school next Tuesday for half a day', conversationId);
  assert.equal(r.status, 'ok');
  assert.deepEqual(dataModel(r.reply).absenceType, []);
  assert.deepEqual(r.reply.hrCard.choices, [{ type: 'VAC', name: 'Vacation' }, { type: 'PHL', name: 'Personal Holiday' }, { type: 'DCK', name: 'Dock' }]);
  assert.equal(String(dataModel(r.reply).hours), '4');
  // A follow-up that still names nothing keeps the same choices.
  const again = await ask('next Tuesday', conversationId);
  assert.deepEqual(again.reply.hrCard.choices.map((c) => c.type), ['VAC', 'PHL', 'DCK']);
});

test('follow-up name change clears a foreign reason', async () => {
  const conversationId = randomUUID();
  const first = await ask('My grandmother passed away, I need this Thursday and Friday', conversationId);
  assert.deepEqual([dataModel(first.reply).absenceType, dataModel(first.reply).absenceReason], [['BRV'], ['GGP']]);
  // Without the card's values (the HR card as issued) …
  const second = await ask('actually make it sick leave', conversationId);
  assert.equal(second.reply.hrCard.title, 'Sick Leave');
  assert.deepEqual(dataModel(second.reply).absenceType, ['SCK']);
  assert.deepEqual(dataModel(second.reply).absenceReason, [], 'Grandparent is not a Sick Leave reason; none is guessed');
  assert.deepEqual(second.reply.hrCard.missing, ['absenceReason']);
  assert.equal(second.reply.hrCard.subtitle, null);
  // … and with them (the browser's current values), the same.
  const conversation2 = randomUUID();
  const open = await ask('My grandmother passed away, I need this Thursday and Friday', conversation2);
  const third = await ask('actually make it sick leave', conversation2, randomUUID(), { absenceType: ['BRV'], absenceReason: ['GGP'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '16', note: '' });
  assert.equal(third.status, 'ok', JSON.stringify(third));
  assert.notEqual(third.reply.formRef, open.reply.formRef);
  assert.deepEqual([dataModel(third.reply).absenceType, dataModel(third.reply).absenceReason], [['SCK'], []]);
  assert.deepEqual(third.reply.hrCard.missing, ['absenceReason']);
  // A relative named next fills the reason of the CURRENT name: Sick Leave → Family Care.
  const fourth = await ask("I'm taking care of my mother", conversation2);
  assert.deepEqual([dataModel(fourth.reply).absenceType, dataModel(fourth.reply).absenceReason], [['SCK'], ['FAM']]);
  assert.equal(fourth.reply.hrCard.subtitle, 'Family Care');
  assert.equal(fourth.reply.text, 'Check it and submit.', 'Family Care gets the plain lead (fix round 2)');
  assert.equal((await requests()).length, 0);
  // HR's log never has the chat words or the reason codes read from them.
  assert.doesNotMatch(stack.hr.output(), /grandmother|sick leave|taking care|my mother/i);
  assert.doesNotMatch(stack.hr.output(), /\b(GGP|FAM)\b/);
});

test('fix round 1: a follow-up keeps a reason its OWN words establish; a bare name change uses only the default', async () => {
  // Open Vacation card + “I'm sick” → Sick Leave / Sick Personal (a first-person sick clause), nothing missing.
  const c1 = randomUUID();
  await ask("I need Friday off, it's a vacation day", c1);
  const sick = await ask("I'm sick", c1);
  assert.deepEqual([dataModel(sick.reply).absenceType, dataModel(sick.reply).absenceReason], [['SCK'], ['SCK']]);
  assert.deepEqual(sick.reply.hrCard.missing, []);
  assert.equal(sick.reply.text, 'Feel better soon. Check it and submit.');
  // Open Vacation card + “actually make it sick leave” → Sick Leave, no reason: HR asks.
  const c2 = randomUUID();
  await ask("I need Friday off, it's a vacation day", c2);
  const bare = await ask('actually make it sick leave', c2);
  assert.deepEqual([dataModel(bare.reply).absenceType, dataModel(bare.reply).absenceReason], [['SCK'], []]);
  assert.deepEqual(bare.reply.hrCard.missing, ['absenceReason']);
  assert.equal(bare.reply.text, 'Check it and submit. Which reason fits? Pick it on the card or tell me here.');
  // A name with a default reason: “make it vacation” on a sick card → Vacation / Vacation.
  const vac = await ask('make it vacation', c2);
  assert.deepEqual([dataModel(vac.reply).absenceType, dataModel(vac.reply).absenceReason], [['VAC'], ['VAC']]);
  // Open Bereavement card with no reason + “it was my aunt” → Aunt/Uncle.
  const c3 = randomUUID();
  await ask("I need Friday off, it's a vacation day", c3);
  const aunt = await ask('it was my aunt', c3, randomUUID(), { absenceType: ['BRV'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' });
  assert.deepEqual([dataModel(aunt.reply).absenceType, dataModel(aunt.reply).absenceReason], [['BRV'], ['AUN']]);
  assert.deepEqual(aunt.reply.hrCard.missing, []);
  assert.equal(aunt.reply.text, "I'm sorry for your loss. Check it and submit.");
  assert.equal((await requests()).length, 0);
});

test('ambiguous card hours ask in chat; spread answer first day; Submit files 12 hours', async () => {
  const conversationId = randomUUID();
  const open = await ask("I need Friday off, it's a vacation day", conversationId);
  assert.equal(open.reply.hrCard.title, 'Vacation');
  const cardValues = { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '12', note: '' };
  const asked = await ask('I updated the card', conversationId, randomUUID(), cardValues);
  assert.equal(asked.status, 'ok', JSON.stringify(asked));
  const question = 'Is that 4 hours on Thu, Nov 5 and the rest in full, or 6 hours each day?';
  assert.ok(asked.reply.hrCard.missing.includes('spread'), JSON.stringify(asked.reply.hrCard));
  assert.equal(asked.reply.hrCard.question, question);
  assert.ok(asked.reply.text.endsWith(question), asked.reply.text);
  assert.equal(asked.reply.hrCard.spread.mode, 'ask');
  assert.equal(dataModel(asked.reply).hours, '12', 'the typed hours stay on the card');
  // Submit before answering: refused with the same question; nothing filed.
  const early = await act(asked.reply.formRef, submit(asked.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '12' }));
  assert.equal(early.status, 'refused', JSON.stringify(early));
  assert.equal(early.reason, question);
  assert.equal((await requests()).length, 0, 'nothing filed on a guess');

  const answered = await ask('the first day only', conversationId, randomUUID(), cardValues);
  assert.equal(answered.status, 'ok', JSON.stringify(answered));
  assert.deepEqual(answered.reply.hrCard.spread, { mode: 'start_day_only', first: 4 });
  assert.ok(!answered.reply.hrCard.missing.includes('spread'));
  assert.equal(answered.reply.hrCard.when, 'Thu, Nov 5, 4 hours, then Fri, Nov 6 in full');
  assert.deepEqual(answered.reply.hrCard.credit, { type: 'vacation', label: 'vacation', now: 96, after: 84 });
  const done = await act(answered.reply.formRef, submit(answered.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '12' }));
  assert.equal(done.status, 'ok', JSON.stringify(done));
  assert.equal(done.reply.receipt.hours, 12);
  const filed = await requests();
  assert.equal(filed.length, 1);
  assert.equal(filed[0].hours, 12);
  // The submitted values are logged with the reason and the note redacted.
  assert.match(stack.hr.output(), /absenceReason: '\[redacted\]'/);
  assert.match(stack.hr.output(), /note: '\[redacted\]'/);
  await post(`${stack.hr.url}/dev/hr/reset`, {});
});

test('words decide the spread: leaving at noon Thursday, out Friday → first day partial; Submit keeps that choice', async () => {
  const conversationId = randomUUID();
  const r = await ask("I'm not feeling well, I'm leaving at noon on Thursday and I'll be out Friday", conversationId);
  const card = r.reply.hrCard;
  assert.equal(card.title, 'Sick Leave');
  assert.equal(card.subtitle, 'Sick Personal');
  assert.deepEqual(card.spread, { mode: 'start_day_only', first: 5 }, 'noon = 5 hours (the day ends at 17:00)');
  assert.equal(card.startAt, '12:00');
  assert.match(card.when, /^Thu, Nov \d+ from 12:00 \(5 hours\), then Fri, Nov \d+ in full$/);
  assert.ok(!card.missing.includes('spread'), 'the words decided it; nothing asked');
  const dm = dataModel(r.reply);
  assert.equal(dm.hours, '13');
  const done = await act(r.reply.formRef, submit(r.reply, { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: dm.beginDate, endDate: dm.endDate, hours: '13' }));
  assert.equal(done.status, 'ok', JSON.stringify(done));
  assert.equal(done.reply.receipt.hours, 13);
  await post(`${stack.hr.url}/dev/hr/reset`, {});
});

test('fix round 2: hours typed on the card go with the card’s current dates — asked or refused, never full days', async () => {
  // P5: a one-day partial (Fri, 4 h) moved to Mon on the card → Mon, 4 hours.
  const c1 = randomUUID();
  const fri = await ask("Vacation: I'm leaving at 1pm on Friday", c1);
  assert.equal(dataModel(fri.reply).hours, '4');
  const moved = await ask('looks good', c1, randomUUID(), { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-09', endDate: '2026-11-09', hours: '4', note: '' });
  assert.deepEqual(moved.reply.hrCard.spread, { mode: 'one_day', first: 4 });
  assert.equal(moved.reply.hrCard.when, 'Mon, Nov 9, 4 hours');
  assert.equal(dataModel(moved.reply).hours, '4', 'never 8');

  // P1: an asking card (12 h Thu–Fri) moved to Mon–Tue + “the first day only” → 4 hours on Mon, 12 in all.
  const c2 = randomUUID();
  await ask("I need Friday off, it's a vacation day", c2);
  const asked = await ask('I updated the card', c2, randomUUID(), { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '12', note: '' });
  assert.ok(asked.reply.hrCard.missing.includes('spread'));
  const answered = await ask('the first day only', c2, randomUUID(), { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-09', endDate: '2026-11-10', hours: '12', note: '' });
  assert.deepEqual(answered.reply.hrCard.spread, { mode: 'start_day_only', first: 4 });
  assert.equal(answered.reply.hrCard.when, 'Mon, Nov 9, 4 hours, then Tue, Nov 10 in full');
  assert.equal(dataModel(answered.reply).hours, '12', 'never 16');

  // Mon–Wed ending on the Nov 11 holiday, 16 h → the store's holiday problem; Submit refused; nothing filed.
  const holiday = await ask('looks good', c2, randomUUID(), { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-09', endDate: '2026-11-11', hours: '16', note: '' });
  assert.match(holiday.reply.hrCard.problem, /campus holiday/);
  const refused = await act(holiday.reply.formRef, submit(holiday.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-09', endDate: '2026-11-11', hours: '16' }));
  assert.equal(refused.status, 'refused', JSON.stringify(refused));

  // Item 2: Nov 11–13 with 12 h fits both spreads, but the holiday boundary comes first — no spread question.
  const first = await ask('looks good', c2, randomUUID(), { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-11', endDate: '2026-11-13', hours: '12', note: '' });
  assert.match(first.reply.hrCard.problem, /campus holiday \(Wed, Nov 11\)/);
  assert.ok(!first.reply.hrCard.missing.includes('spread'));
  assert.equal(first.reply.hrCard.question, null);
  const blocked = await act(first.reply.formRef, submit(first.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-11', endDate: '2026-11-13', hours: '12' }));
  assert.equal(blocked.status, 'refused');
  // The shared validator refuses a holiday begin/end first, on the date field (final review item 5).
  assert.equal(blocked.reply.errors.beginDate, "An absence can't begin or end on a campus holiday.");
  assert.equal((await requests()).length, 0);
});

test('“each day” answers the spread question with the same hours every day', async () => {
  const conversationId = randomUUID();
  await ask("I need Friday off, it's a vacation day", conversationId);
  const cardValues = { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '12', note: '' };
  assert.ok((await ask('I updated the card', conversationId, randomUUID(), cardValues)).reply.hrCard.missing.includes('spread'));
  const unclear = await ask('hmm, not sure', conversationId, randomUUID(), cardValues);
  assert.ok(unclear.reply.hrCard.missing.includes('spread'), 'anything else leaves it asking');
  const each = await ask('each day', conversationId, randomUUID(), cardValues);
  assert.deepEqual(each.reply.hrCard.spread, { mode: 'all_days', each: 6 });
  assert.equal(each.reply.hrCard.when, 'Thu, Nov 5 to Fri, Nov 6, 6 hours each day');
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
  const late = await act(before.reply.formRef, submit(before.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(late.status, 'refused');
  assert.match(late.reason, /reset/i);
  assert.equal((await requests()).length, 0);

  // The classroom reset (New conversation): HR records back to the sample, every staff card forgotten.
  const one = await ask("I need Friday off, it's a vacation day", randomUUID());
  const done = await act(one.reply.formRef, submit(one.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(done.status, 'ok');
  assert.equal((await requests()).length, 1);
  const open = await ask("I need Friday off, it's a vacation day", randomUUID());
  const reset = await (await post(`${stack.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(reset.hr, 'reset');
  assert.equal((await requests()).length, 0);
  const after = await act(open.reply.formRef, submit(open.reply, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }));
  assert.equal(after.status, 'refused');
  assert.match(after.reason, /Unknown or altered form reference/);
});

test('balance question gets text, no card', async () => {
  const conversationId = randomUUID();
  const before = (await requests()).length;
  const sick = await ask('how much sick leave do I have?', conversationId);
  assert.equal(sick.status, 'ok', JSON.stringify(sick));
  assert.equal(sick.reply.text, 'You have 15 days (120 hours) of sick leave.');
  assert.equal(sick.reply.formRef, undefined, 'no card, no form reference');
  assert.equal(sick.reply.hrCard ?? null, null);
  assert.equal(sick.reply.hrOutcome, 'balance');
  assert.equal((await ask("what's my vacation balance", conversationId)).reply.text, 'You have 12 days (96 hours) of vacation.');
  assert.equal((await ask('my personal holiday balance', conversationId)).reply.text, 'You have 1 day (8 hours) of personal holiday.');
  const all = await ask('my leave balances', conversationId);
  assert.equal(all.reply.text, 'You have 15 days (120 hours) of sick leave.\nYou have 12 days (96 hours) of vacation.\nYou have 1 day (8 hours) of personal holiday.');
  assert.equal((await requests()).length, before, 'nothing was filed');
});

test('requests list after submit; an open card stays open and unchanged through a balance question', async () => {
  const conversationId = randomUUID();
  const first = await ask('show my time off requests', conversationId);
  assert.match(first.reply.text, /^(You have no time-off requests\.|TO-)/);
  assert.equal(first.reply.formRef, undefined);

  const card = await ask("I'm sick on Wednesday, Nov 18", conversationId);
  const open = await ask('how many vacation days do I have left', conversationId, randomUUID(), { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-18', endDate: '2026-11-18', hours: '8', note: '' });
  assert.equal(open.reply.text, 'You have 12 days (96 hours) of vacation.');
  assert.equal(open.reply.formRef, undefined, 'no replacement card');
  const done = await act(card.reply.formRef, submit(card.reply, { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-18', endDate: '2026-11-18', hours: '8' }));
  assert.equal(done.status, 'ok', JSON.stringify(done));
  const id = done.reply.receipt.requestId;

  const list = await ask('what time off have I filed', conversationId);
  assert.equal(list.reply.text.split('\n')[0], `${id}: Sick Leave (Sick Personal), Wed, Nov 18, 8 hours — sent to your manager.`);
  assert.equal((await ask('my time off requests', conversationId)).reply.text.split('\n')[0], list.reply.text.split('\n')[0]);
  assert.equal(list.reply.formRef, undefined);
});
