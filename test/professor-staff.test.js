// HR (staff only), Task 6: the Professor agent spots a request for the professor HIMSELF as staff in the
// Professor view chat, asks when it can't tell staff from class, and relays HR's card (Professor → Hub →
// HR over the signed staff path). Plain class messages behave exactly as before.
//
// Mock Professor (labelled heuristic classifier) and mock HR: these tests prove plumbing and the
// code-decided outcomes (what is filed, what is posted, the fixed texts), not live judgment.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack, post, openStream, waitFor } from './support/harness.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';

const UNSURE = 'Should I file this as time off with HR, tell the class, or both?';
const HOLDING = "I'm still holding your earlier message — please answer HR, the class, or both. If your reply also had something new, send it again after.";
const STILL_HOLDING = "I'm still holding your earlier message — answer HR, the class, or both. Your new message wasn't sent; please send it again after.";
let s;

before(async () => {
  s = await startStack({
    library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
  });
});
after(() => s?.kill());
// Every test starts from a fresh classroom: posts, chat, HR records and the Professor's staff state.
beforeEach(async () => {
  const r = await (await post(`${s.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(r.hr, 'reset');
});

// `on` = another stack (the TTL and live tests start their own); the shared one by default.
const say = async (text, operationId = `op-${randomUUID()}`, on = s) => {
  const res = await post(`${on.ui.url}/api/professor/chat`, { operationId, text });
  return { http: res.status, ...(await res.json()) };
};
const state = async (on = s) => (await fetch(`${on.ui.url}/api/professor/state`)).json();
const requests = async (on = s) => (await (await fetch(`${on.hr.url}/test/hr/requests`)).json()).requests;
// Task 7 adds the UI server's proxy; here the Professor's own authoring route (server caller, no Origin).
const hrAction = async (body, on = s) => {
  const res = await post(`${on.professor.url}/author/hr-action`, body);
  return { http: res.status, ...(await res.json()) };
};
const surfaceOf = (card) => card.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
const dataModel = (card) => card.a2ui.find((m) => m.updateDataModel).updateDataModel.value;
const submitAction = (card, context) => ({ name: 'submitTimeOff', surfaceId: surfaceOf(card), sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { note: '', ...context } });
const lastOf = (chat, role) => chat.filter((m) => m.role === role).at(-1);
const HELD_SICK = "I'm sick, cancel Friday's class"; // the mock heuristic is unsure about it

test('Review Focus 1: unsure → the fixed question, nothing posted or filed; a plain class message posts as today', async () => {
  const r = await say("I'm sick, cancel Friday's class");
  assert.equal(r.http, 200);
  assert.equal(r.reply, UNSURE);
  let st = await state();
  assert.equal(st.lessons.length, 0, 'nothing posted on a guess');
  assert.equal(st.hrCard, null, 'nothing filed on a guess');
  assert.deepEqual(await requests(), []);
  assert.equal(lastOf(st.chat, 'assistant').text, UNSURE, 'the question is in the chat');

  // Rule B (safer outcome, changed from “posts as today”): a reply of 8 words or fewer while a message is held is
  // never posted or classified on its own — with no clear choice it gets the one re-ask.
  const plain = await say('Read chapter 4 before Friday');
  assert.equal(plain.reply, STILL_HOLDING, 'R3 notice (changed from the plain question): it has new content (a day)');
  st = await state();
  assert.equal(st.lessons.length, 0);
  assert.equal(st.hrCard, null);
  assert.deepEqual(await requests(), []);
  // A plain class message with nothing held still posts as today.
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say('Read chapter 4 before Friday')).action, 'post');
});

test('a staff request opens HR’s card (bereavement); Submit files it and the chat keeps the receipt text', async () => {
  const r = await say('I want to file for time off. My grandmother passed away, I need this Thursday and Friday');
  assert.equal(r.http, 200);
  assert.equal(r.action, 'staff');
  let st = await state();
  assert.equal(st.lessons.length, 0, 'never posted to students');
  assert.equal(st.hrCard.card.title, 'Bereavement');
  assert.match(st.hrCard.formRef, /^hf-/);
  assert.deepEqual(dataModel(st.hrCard).absenceReason, ['GGP']);
  assert.equal(st.hrCard.card.subtitle, 'Grandparent/Great Grandparent');
  const hr = lastOf(st.chat, 'hr');
  assert.equal(hr.text, "I'm sorry for your loss. Check it and submit.");
  assert.equal(hr.formRef, st.hrCard.formRef);
  assert.equal(hr.a2ui, undefined, 'the live card is not stored in the chat');

  const operationId = `op-${randomUUID()}`;
  const body = { operationId, formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: ['BRV'], absenceReason: ['GGP'], beginDate: '2026-11-05', endDate: '2026-11-06', hours: '16' }) };
  const done = await hrAction(body);
  assert.equal(done.http, 200, JSON.stringify(done));
  assert.equal(done.status, 'accepted');
  const id = done.receipt.requestId;
  assert.match(id, /^TO-/);
  st = await state();
  assert.equal(lastOf(st.chat, 'hr').text, `Sent to your manager for a decision. Request ${id}: Bereavement (Grandparent/Great Grandparent), Thu, Nov 5 to Fri, Nov 6, 16 hours.`);
  assert.equal(lastOf(st.chat, 'hr').closed, true);
  assert.equal(st.hrCard, null, 'the card is closed');
  assert.equal((await requests()).length, 1);
  // The same operation again: the stored outcome, never a second request.
  const again = await hrAction(body);
  assert.equal(again.duplicate, true);
  assert.equal(again.receipt.requestId, id);
  assert.equal((await requests()).length, 1);
  assert.equal((await state()).lessons.length, 0);
});

test('missing absence name: HR asks; the next message fills the open card (vacation)', async () => {
  await say('I need Friday off');
  let st = await state();
  assert.ok(st.hrCard.card.missing.includes('absenceType'));
  assert.equal(lastOf(st.chat, 'hr').text, 'What kind of time off is this? If none of these fit, pick from the dropdown below.');
  assert.deepEqual(st.hrCard.card.choices.map((c) => c.type), ['VAC', 'SCK', 'PHL']);
  const first = st.hrCard.formRef;
  // While the card is open, a message without @assistant goes to HR (a follow-up), not to students.
  const r = await say("it's for a vacation day");
  assert.equal(r.action, 'staff');
  st = await state();
  assert.equal(st.hrCard.card.title, 'Vacation');
  assert.notEqual(st.hrCard.formRef, first, 'the re-issued card replaces the old one');
  assert.equal(st.lessons.length, 0);
  assert.deepEqual(await requests(), []);
  // @assistant is never a staff turn, even with a card open; the card stays open.
  const a = await say('@assistant who opened my last message?');
  assert.notEqual(a.action, 'staff');
  assert.equal((await state()).hrCard.formRef, st.hrCard.formRef);
});

test('“both”: HR first; after Submit the neutral note is offered, and “yes” posts exactly that note to the class', async () => {
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  const b = await say('both');
  assert.equal(b.action, 'staff');
  let st = await state();
  assert.ok(st.hrCard, 'HR got the held message');
  assert.equal(st.lessons.length, 0, 'nothing to the class yet');
  const done = await hrAction({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' }) });
  assert.equal(done.status, 'accepted', JSON.stringify(done));
  st = await state();
  assert.match(lastOf(st.chat, 'hr').text, /^Sent to your manager for a decision\. Request TO-\w+: Sick Leave \(Sick Personal\), Fri, Nov 6, 8 hours\.$/);
  assert.equal(lastOf(st.chat, 'assistant').text, 'Want me to tell the class: “Professor Amir is out on Fri, Nov 6.”? Reply yes to post it.');
  assert.equal(st.lessons.length, 0, 'not posted before the professor says yes');

  const yes = await say('yes');
  assert.equal(yes.action, 'post');
  st = await state();
  assert.equal(st.lessons.length, 1, 'one class post');
  assert.equal(st.lessons[0].text, 'Professor Amir is out on Fri, Nov 6.');
  assert.equal(st.lessons[0].audience, 'all');
  assert.equal((await requests()).length, 1);
});

test('answering “class” posts the ORIGINAL held message as today; nothing goes to HR', async () => {
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  const r = await say('tell the class');
  assert.equal(r.action, 'post');
  const st = await state();
  assert.equal(st.lessons.length, 1);
  assert.equal(st.lessons[0].text, "I'm sick, cancel Friday's class");
  assert.equal(st.hrCard, null);
  assert.deepEqual(await requests(), []);
});

test('Cancel closes the card without filing; a classroom reset forgets an open card', async () => {
  await say("I need Friday off, it's a vacation day");
  let st = await state();
  const cancel = await hrAction({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: { name: 'cancelForm', surfaceId: surfaceOf(st.hrCard), sourceComponentId: 'cancel_button', timestamp: new Date().toISOString(), context: {} } });
  assert.equal(cancel.status, 'cancelled', JSON.stringify(cancel));
  st = await state();
  assert.equal(st.hrCard, null);
  assert.equal(lastOf(st.chat, 'hr').text, 'Cancelled. Nothing was sent to your manager.');
  assert.deepEqual(await requests(), []);

  await say("I need Friday off, it's a vacation day");
  assert.ok((await state()).hrCard);
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  st = await state();
  assert.equal(st.hrCard, null);
  assert.equal(st.chat.length, 0);
});

test('hr-action input checks: malformed operation, unknown card', async () => {
  assert.equal((await hrAction({ operationId: 'bad id!', formRef: 'hf-x', action: {} })).http, 400);
  const r = await hrAction({ operationId: `op-${randomUUID()}`, formRef: 'hf-nope', action: { name: 'submitTimeOff', surfaceId: 'x', context: {} } });
  assert.equal(r.http, 409);
  // Origin-guarded like every non-GET /author route: a cross-site browser POST is refused.
  const cross = await post(`${s.professor.url}/author/hr-action`, { operationId: `op-${randomUUID()}`, formRef: 'hf-x', action: { name: 'submitTimeOff' } }, { Origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  assert.deepEqual(await requests(), []);
});

// ---- fix round 1 ----------------------------------------------------------------------------------------
const NOTE_OFFER = 'Want me to tell the class: “Professor Amir is out on Fri, Nov 6.”? Reply yes to post it.';
// unsure → both → Submit: the neutral note is now on offer.
async function noteOffer() {
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  await say('both');
  const st = await state();
  const done = await hrAction({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' }) });
  assert.equal(done.status, 'accepted', JSON.stringify(done));
  assert.equal(lastOf((await state()).chat, 'assistant').text, NOTE_OFFER);
}

test('fix 2: an unclear short answer to the unsure question is asked once more, never posted', async () => {
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  const again = await say('yes');
  assert.equal(again.reply, UNSURE, 'the same question once more');
  const dropped = await say('huh?');
  assert.equal(dropped.reply, 'Okay, nothing was filed or posted.');
  assert.equal((await state()).lessons.length, 0);
  assert.deepEqual(await requests(), []);
  // “neither” / “no”: nothing at all, straight away.
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  assert.equal((await say('neither')).reply, 'Okay, nothing was filed or posted.');
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  assert.equal((await say('not sure')).reply, 'Okay, nothing was filed or posted.');
  assert.equal((await state()).lessons.length, 0);
  assert.deepEqual(await requests(), []);
});

test('fix 2: after the note offer, “nah” and an unclear reply never post', async () => {
  await noteOffer();
  assert.equal((await say('nah')).reply, 'Okay, I won’t post it.');
  assert.equal((await state()).lessons.length, 0);
  await noteOffer();
  assert.equal((await say('hmm?')).reply, 'Should I post that note to the class? Reply yes or no.');
  assert.equal((await say('what?')).reply, 'Okay, I won’t post it.');
  assert.equal((await say('yes')).action, 'post', 'the offer is gone: “yes” is now just a message (today’s path)');
  const st = await state();
  assert.ok(!st.lessons.some((l) => l.text.includes('is out on')), 'the note itself was never posted');
});

test('fix 3: a refusal anywhere in the reply is not a yes', async () => {
  for (const words of ["please don't post it", "ok, but don't tell them", 'sure, no actually']) {
    await noteOffer();
    const r = await say(words);
    assert.equal(r.reply, 'Okay, I won’t post it.', words);
    assert.equal((await state()).lessons.length, 0, words);
  }
});

test('fix 4: an open card expires with the Hub’s TTL; the Hub’s typed code closes a card it refuses', async () => {
  // The Hub forgets cards after 1.5 s; the Professor after 3 s (the same variable; different values here
  // only to reach both paths).
  const t = await startStack({
    library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam', HUB_FORM_TTL_MS: '1500' }, professorEnv: { HUB_FORM_TTL_MS: '3000' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
  });
  try {
    await say("I need Friday off, it's a vacation day", undefined, t);
    let st = await state(t);
    assert.ok(st.hrCard);
    await new Promise((r) => setTimeout(r, 1700));
    // Expired at the Hub (code card_closed): the Professor closes the card — no wording parsed.
    const late = await hrAction({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: ['VAC'], absenceReason: ['VAC'], beginDate: '2026-11-20', endDate: '2026-11-20', hours: '8' }) }, t);
    assert.equal(late.status, 'rejected');
    assert.equal(late.closed, true);
    assert.equal((await state(t)).hrCard, null);
    assert.deepEqual(await requests(t), []);

    // Expired at the Professor too: the next plain message is a class message again, not an HR follow-up.
    await say("I need Friday off, it's a vacation day", undefined, t);
    assert.ok((await state(t)).hrCard);
    await new Promise((r) => setTimeout(r, 3200));
    assert.equal((await state(t)).hrCard, null, 'the card expired');
    const r = await say('Read chapter 4 before Friday', undefined, t);
    assert.equal(r.action, 'post');
    st = await state(t);
    assert.equal(st.lessons.length, 1);
    assert.equal(st.lessons[0].text, 'Read chapter 4 before Friday');
  } finally {
    t.kill();
  }
});

test('fix 1: @assistant never sees or posts a private staff message; staff words are not the professor’s class words', async () => {
  // Live Professor against the fake Messages API (scripted output: plumbing and code checks, not judgment).
  const stub = await startFakeAnthropic();
  const drafts = [];
  const interpretCalls = [];
  stub.respondWith((body) => {
    const system = Array.isArray(body.system) ? body.system.map((b) => b.text).join('') : String(body.system);
    if (system.includes('time-off requests go to HR')) return messageReply(JSON.stringify({ kind: 'staff_request' }));
    interpretCalls.push(JSON.stringify(body.messages));
    return messageReply(JSON.stringify({ action: 'post', reply: 'Sending it.', kind: 'message', audience: 'all', title: 'Out', content: drafts.shift(), content_is_verbatim: true, seed_id: '' }));
  });
  const t = await startStack({
    library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    professorEnv: { PROFESSOR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
  });
  try {
    const staff = await say('My grandmother passed away, I need this Thursday and Friday', undefined, t);
    assert.equal(staff.action, 'staff');
    assert.equal((await state(t)).hrCard.card.title, 'Bereavement');
    // Cancel the card so the next plain message isn't an HR follow-up (the @assistant one never is).
    const card = (await state(t)).hrCard;
    await hrAction({ operationId: `op-${randomUUID()}`, formRef: card.formRef, action: { name: 'cancelForm', surfaceId: surfaceOf(card), sourceComponentId: 'cancel_button', timestamp: new Date().toISOString(), context: {} } }, t);

    // The model (scripted) copies the private reason: code refuses it.
    drafts.push("My grandmother passed away, so I'm out Thursday and Friday.");
    const leak = await say("@assistant tell the class I'm out Thursday and Friday", undefined, t);
    assert.equal(leak.action, 'clarify');
    assert.equal(leak.check, 'private_staff');
    assert.equal((await state(t)).lessons.length, 0);
    // The model was never given the staff text — only a private marker.
    assert.ok(interpretCalls.length >= 1);
    for (const c of interpretCalls) {
      assert.ok(!/grandmother|passed away/i.test(c), 'no staff words in the model input');
      assert.match(c, /private: the professor/);
    }

    // Words only the staff message contains are not the professor's words for the class → not verbatim.
    drafts.push('I need this Thursday and Friday');
    const r = await say('@assistant tell everyone about my schedule', undefined, t);
    assert.equal(r.action, 'post');
    const st = await state(t);
    assert.equal(st.lessons.length, 1);
    assert.equal(st.lessons[0].verbatim, false, 'staff words are never counted as verbatim class words');
    assert.ok(!st.lessons.some((l) => /grandmother|passed away/i.test(`${l.title} ${l.text}`)));
  } finally {
    t.kill();
    await stub.close();
  }
});

test('final fix 3: leave words without “I/my” are asked about, never posted (mock heuristic)', async () => {
  for (const text of ['Taking Friday off for a funeral', 'Out sick tomorrow', 'Need Friday off, family emergency']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const r = await say(text);
    assert.equal(r.http, 200, text);
    assert.equal(r.reply, UNSURE, text);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${text}: nothing posted`);
    assert.equal(st.hrCard, null, `${text}: nothing filed`);
  }
  assert.deepEqual(await requests(), []);
  // A plain class message without leave words still posts as today (fresh classroom: no held question).
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say('Quiz moved to Monday')).action, 'post');
});

test('final fix 4: short leave words from a staff message (sick) are private too', async () => {
  // Live Professor against the fake Messages API (scripted output: plumbing and the code guard, not judgment).
  const stub = await startFakeAnthropic();
  const drafts = [];
  stub.respondWith((body) => {
    const system = Array.isArray(body.system) ? body.system.map((b) => b.text).join('') : String(body.system);
    if (system.includes('time-off requests go to HR')) return messageReply(JSON.stringify({ kind: 'staff_request' }));
    return messageReply(JSON.stringify({ action: 'post', reply: 'Sending it.', kind: 'message', audience: 'all', title: 'Thursday', content: drafts.shift(), content_is_verbatim: false, seed_id: '' }));
  });
  const t = await startStack({
    library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    professorEnv: { PROFESSOR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
  });
  try {
    const staff = await say('I’m out sick Thursday', undefined, t);
    assert.equal(staff.action, 'staff');
    drafts.push('No class Thursday: the professor is sick.');
    const leak = await say('@assistant tell the class there is no class Thursday', undefined, t);
    assert.equal(leak.action, 'clarify');
    assert.equal(leak.check, 'private_staff');
    assert.equal((await state(t)).lessons.length, 0, 'nothing posted');
    // Without the private word the same request posts.
    drafts.push('No class Thursday.');
    assert.equal((await say('@assistant tell the class there is no class Thursday', undefined, t)).action, 'post');
  } finally {
    t.kill();
    await stub.close();
  }
});

// The browser's path for a professor message with a card open: UI server → Hub (developer proxy) →
// Professor (/author/chat) → Hub → HR, with the card's current values alongside the words.
const sayWithCard = async (text, card, values, operationId = `op-${randomUUID()}`) => {
  const res = await post(`${s.ui.url}/api/professor/chat`, { operationId, text, formRef: card.formRef, formValues: { absenceType: [], absenceReason: [], beginDate: '', endDate: '', hours: '', note: '', ...values } });
  return { http: res.status, ...(await res.json()) };
};

test('final fix 2: dates edited on the card survive a chat answer (“vacation”)', async () => {
  await say('I need Friday off');
  let st = await state();
  assert.ok(st.hrCard.card.missing.includes('absenceType'));
  // The professor moves the dates on the card to Thu Nov 12 – Fri Nov 13, then answers HR in the chat.
  const r = await sayWithCard('vacation', st.hrCard, { beginDate: '2026-11-12', endDate: '2026-11-13', hours: '16', note: 'Back Monday' });
  assert.equal(r.http, 200);
  assert.equal(r.action, 'staff');
  st = await state();
  const dm = dataModel(st.hrCard);
  assert.deepEqual(dm.absenceType, ['VAC'], 'the words named it');
  assert.deepEqual(dm.absenceReason, ['VAC'], 'Vacation’s own reason is filled in');
  assert.equal(dm.beginDate, '2026-11-12', 'the card’s begin date survived');
  assert.equal(dm.endDate, '2026-11-13', 'the card’s end date survived');
  assert.equal(dm.note, 'Back Monday');
  assert.equal(dm.hours, '16', 'hours from the store for the card’s dates');
  assert.equal(st.hrCard.card.when, 'Thu, Nov 12 to Fri, Nov 13, 2 days');
  assert.deepEqual(await requests(), []);
  // Bad card values are refused at the UI server (unknown key) — nothing reaches HR.
  const bad = await post(`${s.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text: 'vacation', formRef: st.hrCard.formRef, formValues: { surprise: 'x' } });
  assert.equal(bad.status, 400);
});

test('final fix 1: Bereavement picked ON the card gets its reason from the relative named in the chat, and Submit works', async () => {
  await say('I need Friday off');
  let st = await state();
  // The professor picks Bereavement on the card (no reason yet), then answers in the chat.
  const r = await sayWithCard('It was my uncle', st.hrCard, { absenceType: ['BRV'], beginDate: '2026-11-06', endDate: '2026-11-06' });
  assert.equal(r.action, 'staff');
  st = await state();
  const dm = dataModel(st.hrCard);
  assert.deepEqual(dm.absenceType, ['BRV'], 'the name picked on the card is kept');
  assert.deepEqual(dm.absenceReason, ['AUN'], 'read from the follow-up because the CURRENT name is Bereavement');
  assert.equal(st.hrCard.card.subtitle, 'Aunt/Uncle');
  assert.deepEqual(st.hrCard.card.missing, []);
  const done = await hrAction({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: ['BRV'], absenceReason: ['AUN'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' }) });
  assert.equal(done.status, 'accepted');
  const filed = await requests();
  assert.equal(filed.length, 1);
  assert.equal(filed[0].absenceName, 'Bereavement');
  assert.equal(filed[0].absenceReason, 'AUN');
});

test('gap 2: a live staff classifier call is a Professor → model hop on the UI stream, with no staff words', async () => {
  // Live Professor against the fake Messages API (scripted output: plumbing, not judgment).
  const stub = await startFakeAnthropic();
  stub.respondWith(() => messageReply(JSON.stringify({ kind: 'staff_request' })));
  const t = await startStack({
    library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    professorEnv: { PROFESSOR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
  });
  const stream = await openStream(t.ui.url);
  try {
    const staff = await say('My grandmother passed away, I need this Thursday and Friday', undefined, t);
    assert.equal(staff.action, 'staff');
    const hop = (type) => stream.events.find((e) => e.source === 'professor' && e.type === type && e.topo?.edge === 'professor-model');
    await waitFor(() => hop('model_call_started') && hop('model_response_received'), { what: 'the Professor’s staff classifier call on the UI stream' });
    assert.equal(hop('model_call_started').data.purpose, 'staff or class');
    assert.deepEqual([hop('model_call_started').topo.from, hop('model_call_started').topo.to], ['professor', 'model']);
    assert.deepEqual([hop('model_response_received').topo.from, hop('model_response_received').topo.to], ['model', 'professor']);
    assert.match(hop('model_call_started').runId, /^staff-/, 'part of the staff run');
    const professorEvents = stream.events.filter((e) => e.source === 'professor');
    assert.ok(!/grandmother|passed away|Thursday and Friday/i.test(JSON.stringify(professorEvents)), 'no staff words in telemetry');
  } finally {
    stream.close();
    t.kill();
    await stub.close();
  }
});

test('gap 2: a mock staff classifier makes no model hop (labelled heuristic inside the Professor)', async () => {
  const stream = await openStream(s.ui.url);
  try {
    assert.equal((await say('My grandmother passed away, I need this Thursday and Friday')).action, 'staff');
    await waitFor(() => stream.events.some((e) => e.source === 'professor' && e.type === 'staff_decision'), { what: 'the staff decision' });
    assert.equal(stream.events.filter((e) => e.source === 'professor' && /^model_/.test(e.type)).length, 0, 'mock → no model call events');
  } finally {
    stream.close();
  }
});

// Live headed run: after the unsure question the professor sent a NEW full request; it was taken as the answer
// “HR” (it has HR words) and the HELD message was filed instead. Only a short choice answers the question.
test('the live sequence: a new request that contains a choice word (“file”) is held back with the notice, never dropped silently', async () => {
  // Changed (controller ruling): any reply with a choice word is never classified on its own. Its first clause is not
  // a pure HR/both choice, so the professor is told the new message wasn't sent (R3: not silent). Nothing filed/posted.
  assert.equal((await say('I need time off: Off Nov 6, 4 hours, personal holiday, cancel class')).reply, UNSURE);
  const r = await say("I want to file for time off, I'm not feeling well and I'm leaving 2 hours early Friday");
  assert.equal(r.reply, HOLDING, `changed from STILL_HOLDING (one neutral holding text): ${JSON.stringify(r)}`);
  const st = await state();
  assert.equal(st.hrCard, null, 'nothing sent to HR');
  assert.equal(st.lessons.length, 0, 'nothing posted');
  assert.deepEqual(await requests(), []);
});

test('I2: a long class message while a message is held is offered first; posted only after a clear yes', async () => {
  // Strict Rule B (changed from “posts as today”): nothing goes to students on a single classifier verdict.
  const OFFER = (t) => `Should I post this to the class: “${t}”? Reply yes or no.`;
  for (const text of [
    'Reminder: the marketing plan draft is due next Tuesday by noon',
    'Please read chapter four and bring your notes on Monday morning',
    'The guest speaker on brand strategy has moved to next Wednesday afternoon',
    'Great work on the pricing exercise, the average score was really strong',
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, text);
    const r = await say(text);
    assert.equal(r.reply, OFFER(text), text);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${text}: nothing posted without a yes`);
    assert.equal(st.hrCard, null, text);
  }
  // A clear yes posts exactly that text (never the held one); a no posts nothing.
  const yes = await say('yes');
  assert.equal(yes.action, 'post', JSON.stringify(yes));
  assert.deepEqual((await state()).lessons.map((l) => l.text), ['Great work on the pricing exercise, the average score was really strong']);
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  await say('Reminder: the marketing plan draft is due next Tuesday by noon');
  assert.equal((await say('no')).reply, 'Okay, I won’t post it.');
  assert.equal((await state()).lessons.length, 0);
});

test('a clear choice longer than 8 words (“please file it with HR for me, thanks a lot”) acts as HR, never posted', async () => {
  const reply = 'please file it with HR for me, thanks a lot';
  assert.ok(reply.split(/\s+/).length > 8, 'more than 8 words');
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  const r = await say(reply);
  assert.equal(r.action, 'staff', JSON.stringify(r));
  const st = await state();
  assert.equal(st.hrCard.card.title, 'Sick Leave', 'the held message went to HR');
  assert.equal(st.lessons.length, 0);
});

test('a reply of more than 8 words with no choice words is a new message: a staff request goes to HR with ITS text', async () => {
  assert.equal((await say('I need time off: Off Nov 6, 4 hours, personal holiday, cancel class')).reply, UNSURE);
  const r = await say('I need Friday off for a vacation day with my family');
  assert.equal(r.action, 'staff', JSON.stringify(r));
  const st = await state();
  assert.equal(st.hrCard.card.title, 'Vacation', 'HR read the new request, not the held one');
  assert.equal(st.lessons.length, 0);
});

test('“both please” after the unsure question still files the held message and offers the note', async () => {
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  const b = await say('both please');
  assert.equal(b.action, 'staff');
  let st = await state();
  assert.equal(st.hrCard.card.title, 'Sick Leave', 'HR got the held message');
  const done = await hrAction({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' }) });
  assert.equal(done.status, 'accepted', JSON.stringify(done));
  st = await state();
  assert.equal(lastOf(st.chat, 'assistant').text, 'Want me to tell the class: “Professor Amir is out on Fri, Nov 6.”? Reply yes to post it.');
  assert.equal(st.lessons.length, 0);
});

test('a long class message that mentions “class” after the unsure question is re-asked, never posted (Rule B)', async () => {
  // Rule B (safer outcome, changed from “posts as today”).
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
  const r = await say('Reminder for everyone: the marketing plan draft is due next Tuesday in class');
  assert.equal(r.reply, HOLDING, `changed to the one neutral holding text: ${JSON.stringify(r)}`);
  const st = await state();
  assert.equal(st.lessons.length, 0, 'nothing posted: not the reply, not the held message');
  assert.equal(st.hrCard, null);
  assert.deepEqual(await requests(), []);
});

for (const answer of ['HR', 'file it with HR', 'the class', 'tell the class']) {
  test(`a short choice still answers the unsure question: “${answer}”`, async () => {
    assert.equal((await say("I'm sick, cancel Friday's class")).reply, UNSURE);
    const r = await say(answer);
    const st = await state();
    if (/HR/.test(answer)) {
      assert.equal(r.action, 'staff');
      assert.equal(st.hrCard.card.title, 'Sick Leave');
      assert.equal(st.lessons.length, 0);
    } else {
      assert.equal(r.action, 'post');
      assert.equal(st.lessons.length, 1);
      assert.equal(st.hrCard, null);
    }
  });
}

// Re-review: while a message is held, a reply that is really a choice is never posted on its own, a negation
// drops the hold first, and a short reply with its own class content posts THAT text (never the held one).
const HELD = "I'm sick, cancel Friday's class";
test('a long reply that is really a choice is treated as that choice, never posted on its own', async () => {
  for (const [reply, expect] of [
    ['please file it with HR for me, thanks a lot', 'hr'],
    ['can you please file that with HR for me', 'hr'],
    ['tell the class please, and thanks so much', 'class'],
    ['both of those please, HR and the class', 'both'],
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD)).reply, UNSURE, reply);
    const r = await say(reply);
    const st = await state();
    assert.ok(!st.lessons.some((l) => l.text === reply), `${reply}: never posted on its own`);
    if (expect === 'class') {
      assert.equal(r.action, 'post', reply);
      assert.deepEqual(st.lessons.map((l) => l.text), [HELD], `${reply}: the held message, as the professor chose`);
      assert.equal(st.hrCard, null);
    } else {
      assert.equal(r.action, 'staff', reply);
      assert.equal(st.hrCard.card.title, 'Sick Leave', `${reply}: HR got the held message`);
      assert.equal(st.lessons.length, 0, reply);
    }
  }
});

test('negation drops the hold first: nothing filed, nothing posted', async () => {
  for (const reply of ['not the class', 'no, not HR', "don't file it", 'just leave it']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.reply, 'Okay, nothing was filed or posted.', reply);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${reply}: nothing posted`);
    assert.equal(st.hrCard, null, `${reply}: nothing sent to HR`);
  }
  assert.deepEqual(await requests(), []);
});

test('“Class, quiz is on Monday” names the class with other content: re-asked, nothing posted (Rule B)', async () => {
  // Rule B (safer outcome, changed from “posts that text”): never the held text, never posted on its own.
  assert.equal((await say(HELD)).reply, UNSURE);
  const r = await say('Class, quiz is on Monday');
  assert.equal(r.reply, HOLDING, `changed to the one neutral holding text: ${JSON.stringify(r)}`);
  const st = await state();
  assert.equal(st.lessons.length, 0);
  assert.equal(st.hrCard, null);
});

test('Rule B choices: one clear choice acts on the held message; mixed or unclear is re-asked; nothing posted on its own', async () => {
  for (const [reply, expect] of [
    ['class only', 'class'], ['HR I guess', 'hr'], ['send it to HR asap', 'hr'], ['both, thx', 'both'],
    ['class first, then HR', 'reask'], ['HR, not the class', 'hr'], ['tell them', 'reask'], // “class first, then HR”: changed from both (its first clause is a class choice)
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD)).reply, UNSURE, reply);
    const r = await say(reply);
    const st = await state();
    assert.ok(!st.lessons.some((l) => l.text === reply), `${reply}: never posted on its own`);
    if (expect === 'class') {
      assert.deepEqual(st.lessons.map((l) => l.text), [HELD], reply);
      assert.equal(st.hrCard, null, reply);
    } else if (expect === 'reask') {
      assert.equal(r.reply, HOLDING, `${reply}: changed to the one neutral holding text`);
      assert.equal(st.lessons.length, 0, reply);
      assert.equal(st.hrCard, null, reply);
    } else {
      assert.equal(r.action, 'staff', `${reply}: ${JSON.stringify(r)}`);
      assert.equal(st.hrCard.card.title, 'Sick Leave', reply);
      assert.equal(st.lessons.length, 0, `${reply}: the held text is not posted`);
    }
  }
  assert.deepEqual(await requests(), [], 'nothing filed before Submit');
});

test('C1: only a pure “class” choice posts the held text; any other word is asked again, never posted', async () => {
  for (const reply of ['it isn’t for the class', 'class shouldn’t', 'without the class', 'except the class', 'exclude students']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.reply, HOLDING, `${reply}: changed to the one neutral holding text: ${JSON.stringify(r)}`);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${reply}: nothing posted`);
    assert.equal(st.hrCard, null, reply);
  }
  for (const reply of ['class', 'the class', 'tell the class', 'students', 'post it to the class please, thanks', 'class only']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    assert.equal((await say(reply)).action, 'post', reply);
    assert.deepEqual((await state()).lessons.map((l) => l.text), [HELD_SICK], `${reply}: the held message, as chosen`);
  }
});

test('M1: a reply ending in “?” is asked again, never acted on', async () => {
  for (const reply of ['HR or class?', 'HR?', 'the class?']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.reply, UNSURE, reply);
    const st = await state();
    assert.equal(st.lessons.length, 0, reply);
    assert.equal(st.hrCard, null, reply);
  }
});

const LONG_CLASS = 'Reminder: the marketing plan draft is due next Tuesday by noon';
const offered = async () => {
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  assert.match((await say(LONG_CLASS)).reply, /^Should I post this to the class:/);
};
test('post offer: a reply that names HR / human resources / file is never a yes', async () => {
  for (const reply of ['Please send it to HR', 'yes, to HR', 'Ok so that one is for HR', 'yes, file it', 'yes, human resources']) {
    await offered();
    const r = await say(reply);
    assert.equal(r.reply, 'Okay, I won’t post it.', reply);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${reply}: nothing posted`);
    assert.equal(st.hrCard, null, reply);
  }
});

test('post offer: a yes with other content is asked once more; a pure yes posts', async () => {
  await offered();
  const r = await say('yes but change Tuesday to Wednesday');
  // One R3 rule (changed: the re-ask now also says the new content wasn't sent — “Wednesday” is new).
  assert.equal(r.reply, "Should I post that note to the class? Reply yes or no. Your new message wasn't sent; please send it again.");
  assert.equal((await state()).lessons.length, 0);
  assert.equal((await say('yes please, go ahead')).action, 'post');
  assert.deepEqual((await state()).lessons.map((l) => l.text), [LONG_CLASS]);
});

test('“class too” / “class also” mean both: HR first, the held text is never posted directly', async () => {
  for (const reply of ['class too', 'class also']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.action, 'staff', `${reply}: ${JSON.stringify(r)}`);
    const st = await state();
    assert.equal(st.hrCard.card.title, 'Sick Leave', reply);
    assert.equal(st.lessons.length, 0, `${reply}: the held text is not posted`);
  }
});

test('R3 notice: a re-asked reply with new content says the new message was not sent', async () => {
  const NOTICE = "I'm still holding your earlier message — answer HR, the class, or both. Your new message wasn't sent; please send it again after.";
  for (const reply of ['Also need Monday off, same reason', 'Can I also take next Monday off for a doctor appointment?']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.reply, NOTICE, reply);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${reply}: nothing posted`);
    assert.equal(st.hrCard, null, `${reply}: nothing sent to HR`);
  }
  assert.deepEqual(await requests(), []);
  // Without new content the plain question is asked again.
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  assert.equal((await say('huh?')).reply, UNSURE);
});

// One R3 rule: a reply to ANY pending question with new content (a day/date/leave word not in the pending text) acts
// on the clear answer and always says the new content wasn't sent.
const NOT_SENT = "Your new message wasn't sent; please send it again.";
const told = (r) => (r.reply ?? '').endsWith(NOT_SENT) || r.notice === NOT_SENT;
const chatHasNotice = async () => (await state()).chat.some((m) => m.role === 'assistant' && m.text.includes(NOT_SENT));
test('R3 note offer: act on yes / no / HR and say the new content was not sent', async () => {
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  await noteOffer();
  const yes = await say('Yes please. Also I need Monday off, my son is still sick');
  assert.equal(yes.action, 'post', JSON.stringify(yes));
  assert.ok(told(yes), JSON.stringify(yes));
  assert.ok(await chatHasNotice(), 'the notice is in the chat');
  let st = await state();
  assert.deepEqual(st.lessons.map((l) => l.text), ['Professor Amir is out on Fri, Nov 6.'], 'only the note — never the new words');
  for (const reply of ['No thanks. I also need next Monday off', 'Can you file Monday with HR too']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    await noteOffer();
    const r = await say(reply);
    assert.equal(r.reply, `Okay, I won’t post it. ${NOT_SENT}`, reply);
    st = await state();
    assert.equal(st.lessons.length, 0, reply);
  }
});

test('R3 class-post offer: a yes with new content is asked again; a no declines — both say it was not sent', async () => {
  await offered();
  const r1 = await say('Yes, and I also need Tuesday off');
  assert.equal(r1.reply, `Should I post that note to the class? Reply yes or no. ${NOT_SENT}`);
  assert.equal((await state()).lessons.length, 0);
  await offered();
  const r2 = await say('No, I need Tuesday off for a doctor appointment');
  assert.equal(r2.reply, `Okay, I won’t post it. ${NOT_SENT}`);
  assert.equal((await state()).lessons.length, 0);
});

test('R3 held question: a clear choice with new content acts on the HELD message and says the new content was not sent', async () => {
  for (const [reply, both] of [
    ['Please file it with HR, and also I need Monday off', false],
    ['Both please, and I’ll also be out next Monday for a doctor appointment', true],
    ['HR for Monday', false],
    ['HR, and Monday', false],
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.action, 'staff', `${reply}: ${JSON.stringify(r)}`);
    assert.ok(told(r), `${reply}: ${JSON.stringify(r)}`);
    assert.ok(await chatHasNotice(), `${reply}: notice in the chat`);
    const st = await state();
    assert.equal(st.hrCard.card.title, 'Sick Leave', `${reply}: HR got the held message`);
    assert.equal(st.lessons.length, 0, reply);
    if (both) {
      const done = await hrAction({ operationId: `op-${randomUUID()}`, formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' }) });
      assert.equal(done.status, 'accepted');
      assert.equal(lastOf((await state()).chat, 'assistant').text, NOTE_OFFER, 'both: the note offer follows');
    }
  }
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  const no = await say('No, I need Monday off instead');
  assert.equal(no.reply, `Okay, nothing was filed or posted. ${NOT_SENT}`);
  const st = await state();
  assert.equal(st.lessons.length, 0);
  assert.equal(st.hrCard, null);
});

test('R3: possessives match (“friday’s” = Friday): no notice for a word already in the pending message', async () => {
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  const r = await say('HR, Friday');
  assert.equal(r.action, 'staff');
  assert.ok(!told(r), JSON.stringify(r));
});

test('Rule B: a reply with a choice word acts only on a pure HR/both first clause or a pure class reply; otherwise it is held with the notice', async () => {
  for (const reply of [
    'Just tell the class, HR already knows I’m out Friday',
    'Class only. I’ll handle the HR side myself on Monday',
    'Post it to the class; I’ll do the HR form myself Monday',
    'Only the class for now, HR can wait until Monday',
    'Class only please, my chair will file with HR for me tomorrow',
    'Class please. Also I’m out next Monday for a doctor appointment',
    'Tell the class, and I’m also out next Monday for a doctor appointment',
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.reply, HOLDING, `${reply}: changed to the one neutral holding text: ${JSON.stringify(r)}`);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${reply}: nothing posted`);
    assert.equal(st.hrCard, null, `${reply}: nothing sent to HR`);
  }
  assert.deepEqual(await requests(), []);
});

test('N2: a follow-up that mentions hours but cannot be read clearly clears the old hours (never keeps 3)', async () => {
  for (const follow of ['sorry, make that 1pm', 'make that 1pm', 'Actually I am leaving at noon']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say("I'm sick, I need to leave at 2pm Friday for a sick day")).action, 'staff', follow);
    let st = await state();
    assert.match(st.hrCard.card.when, /\b3 hours\b/, `${follow}: the first card is 3 hours`);
    assert.equal((await say(follow)).action, 'staff', follow);
    st = await state();
    assert.doesNotMatch(st.hrCard.card.when, /\b3 hours\b/, `${follow}: the old 3 hours are not kept (${st.hrCard.card.when})`);
  }
});

test('minor: a refusal standing alone in its own sentence does not block a clear HR choice (never posts)', async () => {
  for (const reply of ['HR. Students don’t need to know', 'Not sure. HR I guess', 'No. HR please']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.action, 'staff', `${reply}: ${JSON.stringify(r)}`);
    const st = await state();
    assert.equal(st.hrCard.card.title, 'Sick Leave', reply);
    assert.equal(st.lessons.length, 0, reply);
  }
  // A class pick next to a refusal still never posts.
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  await say('No. Class please');
  assert.equal((await state()).lessons.length, 0);
});

test('item 5: a negation anywhere means the reply is not a pure class choice (asked again, never posted); “No. Both please” is both', async () => {
  for (const reply of ['Not HR. Class please', 'Don’t tell HR. Class please', "Don't tell HR. Class please"]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.reply, HOLDING, `${reply}: changed to the one neutral holding text: ${JSON.stringify(r)}`);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${reply}: nothing posted`);
    assert.equal(st.hrCard, null, reply);
  }
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say(HELD_SICK)).reply, UNSURE);
  assert.equal((await say('No. Both please')).action, 'staff');
  assert.equal((await state()).hrCard.card.title, 'Sick Leave');
});

test('item 2: follow-ups without a real hour signal keep the hours; “make that 1pm” still clears them', async () => {
  for (const [follow, keeps] of [['No note needed', true], ['Make it a personal holiday instead', true], ['make that 1pm', false]]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say('I need a vacation day Friday, leaving 2 hours early')).action, 'staff', follow);
    assert.match((await state()).hrCard.card.when, /\b2 hours\b/, `${follow}: first card is 2 hours`);
    assert.equal((await say(follow)).action, 'staff', follow);
    const when = (await state()).hrCard.card.when;
    if (keeps) assert.match(when, /\b2 hours\b/, `${follow}: hours kept (${when})`);
    else assert.doesNotMatch(when, /\b2 hours\b/, `${follow}: hours cleared (${when})`);
  }
});

// Follow-up merging (controller ruling, replaces the “also <day>” extension): an addition word + a day clears the
// dates; dates read cleanly replace them; an unreadable day clears them; otherwise they are kept.
const dmOf = (st) => st.hrCard.a2ui.filter((m) => m.updateDataModel).at(-1).updateDataModel.value;
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
test('follow-up dates: additions clear, clean dates replace, unreadable days clear', async () => {
  for (const [follow, expect] of [
    ['also Monday', 'clear'], ['plus Wednesday Nov 11', 'clear'], ['Make it Monday, and add a note that I have a dentist appointment', 'clear'],
    ['Change it to Monday and Tuesday', [1, 2]], ['Make it Thursday and Friday', 'clear'], // changed from Thu–Fri: it names the card's Friday with another day
    ['Actually Monday, not Friday, and no note', 'clear-or-monday'],
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say('I need a vacation day Friday')).action, 'staff', follow);
    assert.equal((await say(follow)).action, 'staff', follow);
    const st = await state();
    const dm = dmOf(st);
    if (expect === 'clear') {
      assert.ok(st.hrCard.card.missing.includes('dates'), `${follow}: ${JSON.stringify(dm)}`);
      assert.equal(st.hrCard.card.question, 'Which day or days?', follow);
    } else if (expect === 'clear-or-monday') {
      assert.ok(st.hrCard.card.missing.includes('dates') || (dowOf(dm.beginDate) === 1 && dm.beginDate === dm.endDate), `${follow}: ${JSON.stringify(dm)}`);
    } else {
      assert.deepEqual([dowOf(dm.beginDate), dowOf(dm.endDate)], expect, `${follow}: ${JSON.stringify(dm)}`);
    }
  }
});

test('follow-up hours: a real hour signal without one clear value gives a full day; no signal keeps the hours', async () => {
  for (const [follow, keeps] of [
    ['No note needed', true], ['Make it a personal holiday instead', true],
    ['Actually make it a full day', false], ['No, I will be out all day', false], ['Make it three instead', false], ['make that 1pm', false],
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say('I need a vacation day Friday, leaving 2 hours early')).action, 'staff', follow);
    assert.match((await state()).hrCard.card.when, /\b2 hours\b/, follow);
    assert.equal((await say(follow)).action, 'staff', follow);
    const when = (await state()).hrCard.card.when;
    if (keeps) assert.match(when, /\b2 hours\b/, `${follow}: kept (${when})`);
    else assert.doesNotMatch(when, /\b2 hours\b/, `${follow}: never keeps 2 (${when})`);
  }
});

test('item 1 in follow-ups: a return-day message that is not the one clear shape clears the card’s dates (HR asks)', async () => {
  assert.equal((await say('I need a vacation day Friday')).action, 'staff');
  assert.equal((await say('Out Wednesday, back Friday')).action, 'staff');
  const st = await state();
  assert.ok(st.hrCard.card.missing.includes('dates'), JSON.stringify(st.hrCard.card));
  assert.equal(st.hrCard.card.question, 'Which day or days?');
});

test('follow-up naming the card’s current day together with other days clears the dates (HR asks)', async () => {
  for (const follow of ['Move Friday to Monday and Tuesday', 'Change Friday to Monday and Tuesday', 'Not Friday, Monday and Tuesday', 'Switch it from Friday to Monday']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say('I need a vacation day Friday')).action, 'staff', follow);
    assert.equal((await say(follow)).action, 'staff', follow);
    const st = await state();
    assert.ok(st.hrCard.card.missing.includes('dates'), `${follow}: ${JSON.stringify(dmOf(st))}`);
    assert.equal(st.hrCard.card.question, 'Which day or days?', follow);
  }
  // “back” without a day right after it is not a return day: an open Friday card keeps its dates.
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say('I need a vacation day Friday')).action, 'staff');
  const fri = dmOf(await state()).beginDate;
  assert.equal((await say('My back hurts and I need Friday off')).action, 'staff');
  const dm = dmOf(await state());
  assert.deepEqual([dm.beginDate, dm.endDate], [fri, fri]);
});

test('held question (c): one neutral holding text; the professor is told to resend; “class” then posts only the held text', async () => {
  for (const reply of ['Tell the class, and post that the exam is postponed', 'Tell the class, and say office hours are cancelled']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(HELD_SICK)).reply, UNSURE, reply);
    const r = await say(reply);
    assert.equal(r.reply, HOLDING, `${reply}: ${JSON.stringify(r)}`);
    assert.equal((await state()).lessons.length, 0, `${reply}: nothing posted`);
    assert.equal((await say('class')).action, 'post', reply);
    assert.deepEqual((await state()).lessons.map((l) => l.text), [HELD_SICK], `${reply}: only the held text`);
  }
});

test('change verb + “X to Y” on an open card clears the dates, whatever the card’s day', async () => {
  for (const [first, follow] of [
    ['I need a vacation day next Friday', 'Change Friday to Monday'],
    ['I need a vacation day Thursday', 'Change Friday to Monday'],
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(first)).action, 'staff', first);
    assert.equal((await say(follow)).action, 'staff', follow);
    const st = await state();
    assert.ok(st.hrCard.card.missing.includes('dates'), `${first} + ${follow}: ${JSON.stringify(dmOf(st))}`);
  }
});

test('the card says “until 10:00” for an arrival and “from 15:00” for leaving', async () => {
  assert.equal((await say('I need a personal holiday, coming in at 10am Monday')).action, 'staff');
  assert.match((await state()).hrCard.card.when, /, 2 hours, until 10:00$/);
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say('I need a personal holiday, leaving at 3pm Friday')).action, 'staff');
  assert.match((await state()).hrCard.card.when, /, 2 hours, from 15:00$/);
});

test('mock classifier: holiday / personal day / day off / PTO / vacation without “I” is asked about, never posted', async () => {
  for (const text of ['Off Nov 6, 4 hours, personal holiday', 'Personal day Friday', 'Day off Friday', 'PTO Friday', 'Vacation Friday']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const r = await say(text);
    assert.equal(r.reply, UNSURE, `${text}: ${JSON.stringify(r)}`);
    assert.equal((await state()).lessons.length, 0, `${text}: nothing posted`);
  }
});

test('mock classifier: clear own-leave cues go to HR; late/early/appointment/dentist/doctor only ask; holiday is never posted', async () => {
  for (const text of ["I'm not well, out Monday to Wednesday", "I'd like a personal holiday Friday", "I'm under the weather, out tomorrow", "I'd like to use a floating holiday on Friday", "I'd like to take Friday as a holiday"]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const r = await say(text);
    assert.equal(r.action, 'staff', `${text}: ${JSON.stringify(r)}`);
    assert.equal((await state()).lessons.length, 0, `${text}: nothing posted`);
  }
  // Changed (was staff): “I have a dentist appointment Friday” now asks.
  for (const text of ['If you have a dentist appointment, tell me in advance', 'I will not accept work turned in late', "I'll be in my office late Tuesday if you need me", 'I have a dentist appointment Friday', 'Requesting a holiday on Friday', 'Off Nov 6, 4 hours, personal holiday']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    assert.equal((await say(text)).reply, UNSURE, text);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${text}: nothing posted`);
    assert.equal(st.hrCard, null, `${text}: nothing filed`);
  }
  // “I'm coming in 2 hours late Monday”: asked, then “HR” files it — never posted.
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say("I'm coming in 2 hours late Monday")).reply, UNSURE);
  assert.equal((await say('HR')).action, 'staff');
  const st = await state();
  assert.ok(st.hrCard);
  assert.equal(st.lessons.length, 0);
});

test('a student-tagged message with the professor’s own soft leave cue or “off <day>” is asked about, never delivered', async () => {
  for (const text of ['@alex I have a dentist appointment Friday', "@alex I'm coming in late Monday, start without me", "@alex I'm leaving early Friday for a doctor's appointment", "@alex @sam I'll be in late Tuesday", "@alex I'm off Friday", "I'm off Friday"]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const r = await say(text);
    assert.equal(r.reply, UNSURE, `${text}: ${JSON.stringify(r)}`);
    const st = await state();
    assert.equal(st.lessons.length, 0, `${text}: nothing delivered`);
    assert.equal(st.hrCard, null, `${text}: nothing filed`);
  }
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await say('@alex your homework is late')).action, 'post', 'no first person: delivered as today');
});

test('Task 7: balance and request questions go to HR as text (mock): no unsure question, no card, nothing posted or filed', async () => {
  const b = await say('how much sick leave do I have?');
  assert.equal(b.action, 'staff');
  assert.equal(b.reply, 'You have 15 days (120 hours) of sick leave.');
  let st = await state();
  assert.equal(st.hrCard, null, 'no card');
  assert.equal(st.lessons.length, 0, 'nothing posted to students');
  assert.deepEqual(await requests(), []);
  assert.equal(lastOf(st.chat, 'hr').text, b.reply);
  assert.equal(lastOf(st.chat, 'hr').formRef, undefined);

  // With a card open: answered, the card stays open.
  await say("I'm sick on Wednesday, Nov 18");
  const open = (await state()).hrCard;
  assert.ok(open?.formRef);
  const q = await say('show my time off requests');
  assert.equal(q.reply, 'You have no time-off requests.');
  st = await state();
  assert.equal(st.hrCard.formRef, open.formRef, 'the same card is still open');
  assert.deepEqual(await requests(), []);
});
