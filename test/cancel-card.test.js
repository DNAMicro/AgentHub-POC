// Review #3 (second review): the class cancellation PREVIEW card. After a time-off filing that covers a class day, the
// Faculty view shows the exact text students will get, “To: your 25 students (class roster)”, an optional note, and
// Send to students / Don't send — instead of a yes/no question. Typing “yes” / “no” still works.
// Review #10: the class meets Tue & Thu (src/course-schedule.js MEETING), so these tests file Thursdays and Tuesdays.
//
// Mock Professor / mock HR / mock CHRS (labelled): these tests prove plumbing and code-decided outcomes, not judgment.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack, post, waitFor, stopProcess, startChrs, hubEntry } from './support/harness.js';

let s;
before(async () => {
  s = await startStack({
    library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
  });
});
after(() => s?.kill());
beforeEach(async () => {
  const r = await (await post(`${s.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(r.hr, 'reset');
});

const op = () => `op-${randomUUID()}`;
const say = async (text) => { const res = await post(`${s.ui.url}/api/professor/chat`, { operationId: op(), text }); return { http: res.status, ...(await res.json()) }; };
const state = async () => (await fetch(`${s.ui.url}/api/professor/state`)).json();
// The Faculty view's own route (UI server → Hub proxy → Faculty agent).
const act = async (body) => { const res = await post(`${s.ui.url}/api/professor/cancel/actions`, body); return { http: res.status, ...(await res.json()) }; };
const surfaceOf = (card) => card.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
const submitAction = (card, context) => ({ name: 'submitTimeOff', surfaceId: surfaceOf(card), sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { note: '', ...context } });
const cancelPosts = async () => (await state()).lessons.filter((l) => l.title === 'Class cancelled');
const CLASS = 'Marketing 351 (10:00–11:15 AM, Mihaylo Hall 2405)';
const LEAD = (dates) => `You have ${CLASS} on ${dates}. Here's the cancellation your students would get — check it before you send it.`;

// File time off through HR's card (fixed dates: the Submit carries them).
async function file(text, beginDate, endDate = beginDate, hours = '8', type = 'VAC') {
  await say(text);
  const st = await state();
  assert.ok(st.hrCard, `${text}: HR opened a card`);
  const res = await post(`${s.professor.url}/author/hr-action`, { operationId: op(), formRef: st.hrCard.formRef, action: submitAction(st.hrCard, { absenceType: [type], absenceReason: [type], beginDate, endDate, hours }) });
  assert.equal((await res.json()).status, 'accepted');
  return state();
}
const fileThu = () => file("I need Thursday off, it's a vacation day", '2026-11-12');

test('preview: the card carries the exact code-built text, the dates and the class size; nothing is sent yet', async () => {
  const st = await fileThu();
  const card = st.cancelCard;
  assert.match(card.id, /^cc-[\w-]{6,80}$/);
  assert.equal(card.status, 'open');
  assert.deepEqual(card.days, ['2026-11-12']);
  assert.equal(card.text, `${CLASS} is cancelled on Thu, Nov 12.`);
  assert.equal(card.count, 25, 'the class size from the fresh class record');
  assert.equal(card.professorName, 'Dr. Dabirian');
  assert.equal(card.noteMax, 500);
  const lead = st.chat.filter((m) => m.role === 'assistant').at(-1);
  assert.equal(lead.text, LEAD('Thu, Nov 12'));
  assert.deepEqual(lead.cancelCard, { id: card.id });
  assert.equal((await cancelPosts()).length, 0, 'nothing sent before Send');
  // No student data on the card (it is in the state every page receives) and never a reason.
  assert.doesNotMatch(JSON.stringify(card), /student-|888\d|@csu|vacation|sick|Aguilar/i);
});

test('Send to students posts exactly the previewed text; the card shows the delivery line', async () => {
  const card = (await fileThu()).cancelCard;
  const r = await act({ cardId: card.id, operationId: op(), action: 'send' });
  assert.equal(r.http, 200, JSON.stringify(r));
  assert.deepEqual([r.ok, r.status, r.text], [true, 'sent', '25 students notified.']);
  const [p] = await cancelPosts();
  assert.equal(p.text, card.text, 'exactly what was previewed');
  assert.equal(p.audience, 'all');
  assert.equal(p.deliveries.length, 25);
  const st = await state();
  assert.equal(st.cancelCard.status, 'sent');
  assert.equal(st.cancelCard.result, '25 students notified.');
  assert.ok(st.lessons.some((l) => l.key === st.cancelCard.postKey));
  const line = st.chat.filter((m) => m.cancelCardId === card.id);
  assert.deepEqual(line.map((m) => m.text), ['25 students notified.'], 'the chat keeps the outcome, tied to the card');
});

test('Send with a note: his note as its own paragraph, tidied the same way the preview shows it', async () => {
  const cases = [
    ['  we will make it up next Tuesday in the review session ', "We will make it up next Tuesday in the review session."],
    ['"Read chapter 6 before Tuesday!"', 'Read chapter 6 before Tuesday!'],
    ['Office hours move to Zoom this week', 'Office hours move to Zoom this week.'],
  ];
  for (const [raw, want] of cases) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const card = (await fileThu()).cancelCard;
    const r = await act({ cardId: card.id, operationId: op(), action: 'send', note: raw });
    assert.equal(r.status, 'sent', JSON.stringify(r));
    assert.deepEqual((await cancelPosts()).map((p) => p.text), [`${card.text}\n\nFrom Dr. Dabirian: ${want}`], raw);
  }
});

test('a double click sends once: two presses at the same time, and the same operation again, give one post', async () => {
  const card = (await fileThu()).cancelCard;
  const id = op();
  const [a, b] = await Promise.all([act({ cardId: card.id, operationId: id, action: 'send' }), act({ cardId: card.id, operationId: op(), action: 'send' })]);
  assert.ok([a, b].every((x) => x.status === 'sent' || x.closed), JSON.stringify([a, b]));
  const again = await act({ cardId: card.id, operationId: id, action: 'send' });
  assert.equal(again.duplicate, true);
  assert.equal(again.status, 'sent');
  const later = await act({ cardId: card.id, operationId: op(), action: 'send' });
  assert.equal(later.http, 409);
  assert.equal(later.status, 'sent', 'a new press on a sent card says it was sent');
  assert.equal((await cancelPosts()).length, 1, 'one cancellation');
});

test('a note about himself, an illness, his leave or a relative is refused inline; nothing is sent; the card stays open', async () => {
  const card = (await fileThu()).cancelCard;
  for (const note of ['I have the flu, sorry', 'Dr. Dabirian is sick today', 'my mother is in the hospital', 'family emergency, back next week', 'I am at a funeral', "I'm recovering from surgery"]) {
    const r = await act({ cardId: card.id, operationId: op(), action: 'send', note });
    assert.equal(r.http, 422, note);
    assert.equal(r.code, 'note_private', note);
    assert.equal(r.text, 'Your note talks about you, and all your students would read it. Change the note or remove it, then press Send again.');
  }
  assert.equal((await cancelPosts()).length, 0);
  assert.equal((await state()).cancelCard.status, 'open');
  // Without the note it goes out, and nothing of the refused notes is anywhere.
  assert.equal((await act({ cardId: card.id, operationId: op(), action: 'send' })).status, 'sent');
  const st = await state();
  assert.doesNotMatch(JSON.stringify(st), /flu|hospital|funeral|surgery|family emergency/);
});

test('a note over 500 characters is refused; a blank note is no note', async () => {
  const card = (await fileThu()).cancelCard;
  const long = await act({ cardId: card.id, operationId: op(), action: 'send', note: 'Please read the chapter. '.repeat(25) });
  assert.deepEqual([long.http, long.code, long.text], [422, 'note_too_long', 'Your note is too long — keep it under 500 characters.']);
  assert.equal((await cancelPosts()).length, 0);
  const blank = await act({ cardId: card.id, operationId: op(), action: 'send', note: '   ' });
  assert.equal(blank.status, 'sent');
  assert.deepEqual((await cancelPosts()).map((p) => p.text), [card.text]);
});

test("Don't send: “Not sent.”, the card closes, nothing goes out, and a later Send or “yes” sends nothing", async () => {
  const card = (await fileThu()).cancelCard;
  const r = await act({ cardId: card.id, operationId: op(), action: 'decline' });
  assert.deepEqual([r.http, r.ok, r.status, r.text], [200, true, 'not_sent', 'Not sent.']);
  const st = await state();
  assert.equal(st.cancelCard.status, 'not_sent');
  assert.equal(st.chat.filter((m) => m.cancelCardId === card.id).at(-1).text, 'Okay, I won’t send a cancellation. Your class is still on for your students.');
  const send = await act({ cardId: card.id, operationId: op(), action: 'send' });
  assert.deepEqual([send.http, send.status], [409, 'not_sent']);
  await say('yes');
  assert.equal((await cancelPosts()).length, 0);
});

test('typing still works: “yes” (with a note) sends the card, “no” closes it — the card follows', async () => {
  let card = (await fileThu()).cancelCard;
  const yes = await say("yes, we'll make it up on Tuesday");
  assert.equal(yes.action, 'post', JSON.stringify(yes));
  let st = await state();
  assert.equal(st.cancelCard.status, 'sent');
  assert.equal(st.cancelCard.result, '25 students notified.');
  assert.deepEqual((await cancelPosts()).map((p) => p.text), [`${card.text}\n\nFrom Dr. Dabirian: We'll make it up on Tuesday.`]);
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  card = (await fileThu()).cancelCard;
  assert.equal((await say('no')).reply, 'Okay, I won’t send a cancellation. Your class is still on for your students.');
  st = await state();
  assert.equal(st.cancelCard.status, 'not_sent');
  assert.equal((await act({ cardId: card.id, operationId: op(), action: 'send' })).http, 409);
  // A typed private note is asked about; the card stays open for Send.
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  card = (await fileThu()).cancelCard;
  assert.match((await say('yes, I have bronchitis so please be patient')).reply, /^Your note talks about you/);
  assert.equal((await state()).cancelCard.status, 'open');
  assert.equal((await act({ cardId: card.id, operationId: op(), action: 'send' })).status, 'sent');
});

test('an @assistant aside keeps the card open; the card is the same on every read (a reload or another tab)', async () => {
  const card = (await fileThu()).cancelCard;
  await say('@assistant what does chapter 5 cover?');
  const a = (await state()).cancelCard;
  const b = (await state()).cancelCard;
  assert.deepEqual(a, b);
  assert.equal(a.id, card.id);
  assert.equal(a.status, 'open');
  assert.equal((await act({ cardId: card.id, operationId: op(), action: 'send' })).status, 'sent');
});

test('a later filing adds its class days to the open card (same card, none lost); Send covers them all', async () => {
  const first = (await fileThu()).cancelCard;
  const st = await file("I also need Tuesday off, it's a vacation day", '2026-11-17');
  assert.equal(st.cancelCard.id, first.id, 'the same card');
  assert.deepEqual(st.cancelCard.days, ['2026-11-12', '2026-11-17']);
  assert.equal(st.cancelCard.text, `${CLASS} is cancelled on Thu, Nov 12 and Tue, Nov 17.`);
  const leads = st.chat.filter((m) => m.cancelCard?.id === first.id);
  assert.deepEqual(leads.map((m) => m.text), [LEAD('Thu, Nov 12'), LEAD('Thu, Nov 12 and Tue, Nov 17')]);
  // A filing on a day without class leaves the card as it is.
  const fri = await file("I need Friday off too, it's a vacation day", '2026-11-20');
  assert.deepEqual(fri.cancelCard.days, ['2026-11-12', '2026-11-17']);
  assert.equal((await act({ cardId: first.id, operationId: op(), action: 'send' })).status, 'sent');
  assert.deepEqual((await cancelPosts()).map((p) => p.text), [`${CLASS} is cancelled on Thu, Nov 12 and Tue, Nov 17.`]);
});

test('New conversation closes the card; a press on it afterwards sends nothing', async () => {
  const card = (await fileThu()).cancelCard;
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await state()).cancelCard, null);
  const r = await act({ cardId: card.id, operationId: op(), action: 'send' });
  assert.deepEqual([r.http, r.closed], [409, true]);
  assert.equal((await cancelPosts()).length, 0);
});

test('strict requests: unknown fields, a bad id or action, a note on Don’t send, and a cross-site browser post are refused', async () => {
  const card = (await fileThu()).cancelCard;
  for (const body of [
    { cardId: card.id, operationId: op(), action: 'send', extra: 1 },
    { cardId: 'nope', operationId: op(), action: 'send' },
    { cardId: card.id, operationId: 'x', action: 'send' },
    { cardId: card.id, operationId: op(), action: 'publish' },
    { cardId: card.id, operationId: op(), action: 'decline', note: 'hi there class' },
    { cardId: card.id, operationId: op(), action: 'send', note: 42 },
  ]) assert.equal((await act(body)).http, 400, JSON.stringify(body));
  const cross = await fetch(`${s.professor.url}/author/cancel-action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ cardId: card.id, operationId: op(), action: 'send' }) });
  assert.equal(cross.status, 403);
  assert.equal((await state()).cancelCard.status, 'open');
  assert.equal((await cancelPosts()).length, 0);
});

// Last: it stops CHRS and starts a new one.
test('the class list is unavailable at Send: nothing goes out, the card stays open with the reason, and Send works once it is back', async () => {
  const card = (await fileThu()).cancelCard;
  await stopProcess(s.chrs);
  await waitFor(async () => (await hubEntry(s.hub, 'chrs'))?.status !== 'ready', { what: 'chrs gone', timeout: 10000 });
  const id = op();
  const r = await act({ cardId: card.id, operationId: id, action: 'send' });
  assert.equal(r.http, 503, JSON.stringify(r));
  assert.equal(r.retryable, true);
  assert.equal(r.text, "I couldn't get your class list just now, so nothing was sent. Try again in a moment.");
  let st = await state();
  assert.equal(st.cancelCard.status, 'open');
  assert.equal(st.cancelCard.problem, r.text);
  assert.equal((await cancelPosts()).length, 0);
  s.chrs = await startChrs({ ...s.specialistEnv, PORT: String(s.chrsPort), CHRS_TEST_HOOKS: '1', STUDENT_RECORDS_URL: s.studentRecords.url, STUDENT_RECORDS_TOKEN: s.studentRecordsToken });
  await waitFor(async () => (await hubEntry(s.hub, 'chrs'))?.status === 'ready', { what: 'chrs ready', timeout: 10000 });
  const again = await act({ cardId: card.id, operationId: id, action: 'send' }); // the page reuses the operation after a “try again”
  assert.equal(again.status, 'sent', JSON.stringify(again));
  st = await state();
  assert.equal(st.cancelCard.problem, undefined);
  assert.deepEqual((await cancelPosts()).map((p) => p.text), [card.text]);
});
