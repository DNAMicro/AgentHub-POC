// Review E (second video review, owner 2026-11-06): the MESSAGE PREVIEW CARD. Nothing reaches students from the Faculty
// view chat until he has seen it on the card and pressed Send (owner: “yes so its confirmed before its sent”).
//   * an instruction (“send a message to all seniors to inform them of a mandatory lab work”) → the audience read by code
//     (here: the 10 seniors, not all 25) and a draft (mock: the labelled code rewrite), never his instruction word for word;
//   * nothing to say (“send a message to all seniors”) → an empty box and “What should your N seniors get?”;
//   * his own words (“Reminder: …”, “@alex great question”, a ↩ Reply) → the box holds exactly his words.
// Mock Professor / mock CHRS (labelled): these tests prove plumbing and code-decided outcomes, not judgment.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack, post, waitFor } from './support/harness.js';
import { readInstruction, mockDraft, checkDraft, audienceOf, createMessageDesk, REPLACED, SEND_WORDS, DECLINE_WORDS, ASK_WHO, PRIVATE_TEXT, EMPTY_TEXT } from '../src/professor-message.js';
import { audienceText, noOneText, filterQuery, groupFilter } from '../src/professor-roster.js';
import { newPrivateWords } from '../src/professor-staff.js';

const { createStudentRecordsStore } = await import('../src/student-records-store.js');
const ROWS = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.rows;
const idsWhere = (fn) => ROWS.filter(fn).map((r) => r.studentId).sort();
const SENIORS = idsWhere((r) => r.level === 'Senior');
const MARKETING = idsWhere((r) => /marketing/i.test(r.plan));
const JUNIOR_MKT = idsWhere((r) => r.level === 'Junior' && /marketing/i.test(r.plan));
const NOT_BUSINESS = idsWhere((r) => !/business/i.test(r.plan));
const FRESHMEN = idsWhere((r) => r.level === 'Freshman');
const ALL = ROWS.length;
const nameOf = (id) => { const r = ROWS.find((x) => x.studentId === id); const [last, first] = r.name.split(','); return `${first.trim()} ${last.trim()}`; };

// ---- code readers (no stack) ---------------------------------------------------------------------------------------
test('readInstruction: the audience phrasings (all / class / my seniors / majors / juniors who are … / not business / tags / names)', () => {
  const cases = [
    ['send a message to all seniors to inform them of a mandatory lab work', 'filter', 'clause'],
    ['send a message to all seniors', 'filter', 'none'],
    ['send a note to my seniors: the lab is mandatory', 'filter', 'own'],
    ['message the marketing majors that the fair is Friday', 'filter', 'own'],
    ['send a message to juniors who are marketing majors that the fair is Friday', 'filter', 'own'],
    ['message the students who aren\'t business majors', 'query', 'none'],
    ['tell everyone to read chapter 5', 'all', 'please'],
    ['Notify the whole class that the quiz is on Friday', 'all', 'own'],
    ['let all my students know to submit by Friday', 'all', 'please'],
    ['tell @alex and @sam to see me', 'tags', 'please'],
    ['email Alex Student and Sam Student about the project', 'names', 'about'],
    ['send all seniors a message', 'filter', 'none'],
    ['remind my seniors to submit their forms', 'filter', 'please'],
  ];
  for (const [said, aud, body] of cases) {
    const r = readInstruction(said);
    assert.ok(r, said);
    assert.equal(r.audience?.kind, aud, `${said}: ${JSON.stringify(r)}`);
    assert.equal(r.body.kind, body, `${said}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(readInstruction('send a message to juniors who are marketing majors').audience.filter, { kind: 'filter', level: 'junior', major: { find: 'marketing', label: 'Marketing' }, count: false });
  assert.deepEqual(readInstruction('email Alex Student and Sam Student about the project').audience.names, ['Alex Student', 'Sam Student']);
  assert.equal(readInstruction('remind my seniors to submit their forms').body.text, 'Please submit your forms.');
});

test('readInstruction: his own messages are not instructions; an audience code can\'t read is asked about', () => {
  for (const t of ['Reminder: the case study is due Friday at noon.', '@alex-student great question today', 'What a great class, my students rock!', 'Let me know if you have questions.', 'Tell the truth, the quiz was hard', 'Please read chapter 5 before Thursday', 'Great job on the midterm everyone!']) assert.equal(readInstruction(t), null, t);
  for (const t of ['send a message to my family', 'post an announcement to the lab partners', 'write a note to Friday']) assert.equal(readInstruction(t)?.audience, null, t);
  // A group code can't read on its own is a QUERY (the model reads it; “none” → “Who should get this message?”).
  assert.equal(readInstruction('send a note to the people upstairs').audience.kind, 'query');
  assert.equal(audienceOf('the students in the back row').kind, 'query', 'a narrowed group is read as a query, never “all”');
});

test('mockDraft (labelled code rewrite) and checkDraft: never a number, day or time he didn\'t write; private words refused', () => {
  assert.equal(mockDraft('to inform them of a mandatory lab work'), 'Please note: there is mandatory lab work.');
  assert.equal(mockDraft('to let them know that their projects are graded'), 'Your projects are graded.');
  assert.equal(mockDraft('to remind them to bring their laptops'), 'Reminder: please bring your laptops.');
  assert.equal(mockDraft('to ask them to see me after class'), 'Please see me after class.');
  const words = 'send a message to all seniors to inform them of a mandatory lab work';
  assert.deepEqual(checkDraft('Please note: there is mandatory lab work.', words), { text: 'Please note: there is mandatory lab work.' });
  for (const bad of ['Mandatory lab work is on Friday.', 'Lab work starts at 3 pm in room 204.', 'The lab is due Nov 12.', 'Please come tomorrow for lab work.']) assert.deepEqual(checkDraft(bad, words), { problem: 'invented' }, bad);
  assert.deepEqual(checkDraft('The lab is on Friday at 3.', 'tell everyone the lab is on Friday at 3'), { text: 'The lab is on Friday at 3.' });
  assert.deepEqual(checkDraft('I am at the funeral, lab is cancelled.', words, ['funeral']), { problem: 'private' });
  assert.deepEqual(checkDraft('', words), { problem: 'empty' });
});

test('the audience describer: “your 10 seniors”, “your N Marketing majors”, a negation, nobody', () => {
  const q = (t) => filterQuery(groupFilter(t));
  assert.equal(audienceText(q('seniors'), 10), 'your 10 seniors');
  assert.equal(audienceText(q('my marketing majors'), 15), 'your 15 Marketing majors');
  assert.equal(audienceText(q('juniors who are marketing majors'), 4), 'your 4 juniors majoring in Marketing');
  assert.equal(audienceText(q('seniors'), 1), 'your 1 senior');
  assert.equal(audienceText({ kind: 'list', match: 'all', filters: [{ field: 'plan', op: 'not_contains', value: 'business', label: 'Business' }] }, 2), "the 2 students who aren't Business majors");
  assert.equal(noOneText(q('freshmen')), "None of your students are freshmen, so there's no one to send this to.");
});

test('typed answers to an open card, and the Send privacy gate (code)', () => {
  for (const t of ['yes', 'Yes, send it', 'send it', 'send', 'ok', 'go ahead', 'please send', 'yes please', 'looks good, send it']) assert.ok(SEND_WORDS.test(t), t);
  for (const t of ['no', "don't send", 'do not send it', 'cancel', 'never mind', 'nope']) assert.ok(DECLINE_WORDS.test(t), t);
  for (const t of ['yes and add the room', 'send it to Sam too', 'no class Friday']) assert.ok(!SEND_WORDS.test(t) && !DECLINE_WORDS.test(t), t);
  assert.equal(newPrivateWords('Lab is mandatory. I am sick, sorry.', 'send a message to all seniors to inform them of a mandatory lab work'), true);
  assert.equal(newPrivateWords("I'll be out Friday, read chapter 5.", 'tell everyone to read chapter 5'), true);
  assert.equal(newPrivateWords('My grandmother is visiting so class is online.', 'tell everyone class is online'), true);
  assert.equal(newPrivateWords('No class Thursday for the Thanksgiving holiday.', 'No class Thursday for the Thanksgiving holiday.'), false, 'words that already passed (he chose the class) stay allowed');
  assert.equal(newPrivateWords('Please read chapter 5 before Thursday.', 'tell everyone to read chapter 5'), false);
});

test('the desk: one open card; a new one replaces it (“Not sent — replaced …”); the view carries no ids or names', () => {
  const desk = createMessageDesk();
  const a = desk.open({ aud: { kind: 'all' }, ids: ['student-alex', 'student-sam'], count: 2, to: 'all 2 students', text: 'Hi', own: 'Hi', label: 'own' });
  assert.equal(a.replaced, null);
  const b = desk.open({ aud: { kind: 'all' }, ids: ['student-alex'], count: 1, to: '1 student you tagged', text: 'Hey', own: 'Hey', label: 'own' });
  assert.equal(b.replaced, a.card.id);
  assert.equal(a.card.status, 'not_sent');
  assert.equal(a.card.reason, REPLACED);
  assert.equal(desk.of(a.card.id), null, 'one card at a time');
  const v = desk.view();
  assert.doesNotMatch(JSON.stringify(v), /student-/);
  assert.deepEqual(Object.keys(v).sort(), ['count', 'id', 'kind', 'label', 'max', 'named', 'none', 'prompt', 'status', 'text', 'to']);
  assert.equal(desk.decline(b.card.id), true);
  assert.equal(desk.begin(b.card.id), null, 'a closed card can\'t be sent');
});

// ---- the running Faculty agent -------------------------------------------------------------------------------------
let s;
before(async () => {
  const d = mkdtempSync(join(tmpdir(), 'a2a-message-card-'));
  s = await startStack({
    library: false, professor: true, hr: true, hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    uiEnv: { STUDENT_INBOX_FILE: join(d, 'inbox.json') }, professorEnv: { PROFESSOR_OUTBOX_FILE: join(d, 'outbox.json') },
  });
  s.outboxFile = join(d, 'outbox.json');
});
after(() => s?.kill());
beforeEach(async () => { await post(`${s.hub.url}/dev/classroom/reset`, {}); });

const op = () => `op-${randomUUID()}`;
const say = async (text, extra = {}) => { const res = await post(`${s.ui.url}/api/professor/chat`, { operationId: op(), text, ...extra }); return { http: res.status, ...(await res.json()) }; };
const state = async () => (await fetch(`${s.ui.url}/api/professor/state`)).json();
const act = async (body) => { const res = await post(`${s.ui.url}/api/professor/message/actions`, body); return { http: res.status, ...(await res.json()) }; };
const send = (card, extra = {}) => act({ cardId: card.id, operationId: op(), action: 'send', ...extra });
const names = async (card) => (await (await fetch(`${s.ui.url}/api/professor/message/${card.id}/names`)).json()).names;
const posts = async () => (await state()).lessons;
const recipients = (p) => p.deliveries.map((d) => d.studentId).sort();

test('owner sentence 1: “send a message to all seniors to inform them of a mandatory lab work” → the 10 seniors, a draft, nothing sent until Send', async () => {
  const r = await say('send a message to all seniors to inform them of a mandatory lab work');
  assert.equal(r.http, 200, JSON.stringify(r));
  assert.equal(r.action, 'preview');
  const c = r.messageCard;
  assert.equal(c.to, `your ${SENIORS.length} seniors`);
  assert.equal(c.count, SENIORS.length);
  assert.equal(c.text, 'Please note: there is mandatory lab work.');
  assert.equal(c.label, 'Written by your assistant from your instruction');
  assert.equal((await posts()).length, 0, 'nothing sent before Send');
  assert.deepEqual(await names(c), SENIORS.map(nameOf).sort((a, b) => a.localeCompare(b)));
  const sent = await send(c);
  assert.equal(sent.http, 200, JSON.stringify(sent));
  assert.equal(sent.text, `${SENIORS.length} students notified.`.replace(/^1 students/, '1 student'));
  const [p] = await posts();
  assert.equal(p.text, 'Please note: there is mandatory lab work.');
  assert.deepEqual(recipients(p), SENIORS, 'exactly the seniors');
  assert.equal(p.verbatim, false);
  const st = await state();
  assert.equal(st.messageCard.status, 'sent');
  assert.equal(st.messageCard.postKey, p.key);
  assert.ok(st.chat.some((m) => m.messageCardId === c.id && m.action === 'sent' && m.postKey === p.key), 'the outcome line is tied to the card');
});

test('owner sentence 2: “send a message to all seniors” → an empty box, “What should your N seniors get?”; Send stays refused until there is text', async () => {
  const c = (await say('send a message to all seniors')).messageCard;
  assert.equal(c.text, '');
  assert.equal(c.prompt, `What should your ${SENIORS.length} seniors get?`);
  const empty = await send(c);
  assert.deepEqual([empty.http, empty.code, empty.text], [422, 'empty', EMPTY_TEXT]);
  const ok = await send(c, { text: 'Lab work is mandatory this week.' });
  assert.equal(ok.http, 200);
  const [p] = await posts();
  assert.equal(p.text, 'Lab work is mandatory this week.', 'the box text, exactly');
  assert.deepEqual(recipients(p), SENIORS);
});

test('an empty box filled from the chat: his next plain message becomes the text (“About X: …” for a subject), then “yes” sends it', async () => {
  const c = (await say('inform the whole class about the guest speaker')).messageCard;
  assert.equal(c.prompt, `What should your ${ALL} students hear about the guest speaker?`);
  const filled = await say('She arrives at 10 and talks about pricing.');
  assert.equal(filled.action, 'preview');
  assert.equal(filled.messageCard.text, 'About the guest speaker: She arrives at 10 and talks about pricing.');
  assert.equal((await posts()).length, 0);
  const yes = await say('yes');
  assert.equal(yes.action, 'sent', JSON.stringify(yes));
  const [p] = await posts();
  assert.equal(p.text, 'About the guest speaker: She arrives at 10 and talks about pricing.');
  assert.equal(p.deliveries.length, ALL);
});

test('audience variations resolve by code against the roster: marketing majors, juniors who are marketing majors, not business majors, everyone, the whole class', async () => {
  for (const [said, ids, to] of [
    ['message the marketing majors that the fair is Friday', MARKETING, `your ${MARKETING.length} Marketing majors`],
    ['send a message to juniors who are marketing majors that the fair is Friday', JUNIOR_MKT, `your ${JUNIOR_MKT.length} juniors majoring in Marketing`],
    ['message the students who aren\'t business majors that the fair is Friday', NOT_BUSINESS, null],
    ['tell everyone that the fair is Friday', null, `all ${ALL} students in Marketing 351`],
    ['notify the whole class that the fair is Friday', null, `all ${ALL} students in Marketing 351`],
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const r = await say(said);
    assert.equal(r.action, 'preview', `${said}: ${JSON.stringify(r)}`);
    if (to) assert.equal(r.messageCard.to, to, said);
    assert.equal(r.messageCard.text, 'The fair is Friday.', said);
    await send(r.messageCard);
    const [p] = await posts();
    if (ids) { assert.deepEqual(recipients(p), ids, said); assert.notEqual(p.audience, 'all'); } else { assert.equal(p.audience, 'all'); assert.equal(p.deliveries.length, ALL); }
  }
});

// Live check 2026-11-06: “message all freshmen about tutoring” and “send a note to students who aren't business majors
// about the guest speaker” got the HR / class / both question. A class message without first-person words opens the card.
test('instructions about a subject open the card, never the HR / class / both question', async () => {
  for (const said of ['message all freshmen about tutoring', "send a note to students who aren't business majors about the guest speaker", 'notify everyone about the field trip', 'message the marketing majors about the career fair', 'send a message to all seniors about the capstone', 'tell everyone about the review session']) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const r = await say(said);
    assert.notEqual(r.check, 'staff_or_class', `${said}: ${JSON.stringify(r)}`);
    assert.ok(r.messageCard || r.action === 'preview', `${said}: ${JSON.stringify(r).slice(0, 300)}`);
  }
});

test('zero matches: “None of your students are freshmen, so there\'s no one to send this to.” and no Send', async () => {
  assert.equal(FRESHMEN.length, 0, 'the fictional class has no freshmen');
  const c = (await say('send a message to all freshmen to bring laptops')).messageCard;
  assert.equal(c.count, 0);
  assert.equal(c.none, "None of your students are freshmen, so there's no one to send this to.");
  const r = await send(c);
  assert.deepEqual([r.http, r.code], [409, 'no_one']);
  assert.equal((await posts()).length, 0);
});

test('tags and names: “To: 2 students you tagged”, names only through the Faculty-view route; an unknown name is refused', async () => {
  const tr = await say('tell @alex and @sam to bring the case notes');
  const t = tr.messageCard;
  assert.ok(t, JSON.stringify(tr));
  assert.equal(t.to, '2 students you tagged');
  assert.equal(t.text, 'Please bring the case notes.');
  assert.deepEqual(await names(t), ['Alex Student', 'Sam Student']);
  assert.doesNotMatch(JSON.stringify((await state()).messageCard), /Alex|Sam|student-/);
  await send(t);
  assert.deepEqual(recipients((await posts())[0]), ['student-alex', 'student-sam']);
  const n = await say('email Alex Student and Sam Student that the project is graded');
  assert.equal(n.messageCard?.to, '2 students you named', JSON.stringify(n));
  const unknown = await say('email Jane Doe that the project is graded');
  assert.equal(unknown.action, 'clarify');
  assert.equal(unknown.reply, "I don't see Jane Doe on your Marketing 351 roster, so nothing was sent.");
  const who = await say('send a message to the lab partners');
  assert.equal(who.reply, ASK_WHO);
});

test('his own words: a plain reminder, a tagged message and praise open the card with EXACTLY his words; Send posts them as written', async () => {
  for (const [said, text, ids] of [
    ['Reminder: the case study is due Friday at noon.', 'Reminder: the case study is due Friday at noon.', null],
    ['@alex great question today', 'great question today', ['student-alex']],
    ['Great work on the midterm, everyone!', 'Great work on the midterm, everyone!', null],
  ]) {
    await post(`${s.hub.url}/dev/classroom/reset`, {});
    const r = await say(said);
    assert.equal(r.action, 'preview', `${said}: ${JSON.stringify(r)}`);
    assert.equal(r.messageCard.text, text);
    assert.equal(r.messageCard.label, null, 'his own words carry no draft label');
    assert.equal((await posts()).length, 0, 'nothing sent before Send');
    const sent = await send(r.messageCard);
    assert.equal(sent.http, 200);
    const [p] = await posts();
    assert.equal(p.text, text);
    assert.equal(p.verbatim, true);
    if (ids) assert.deepEqual(recipients(p), ids); else assert.equal(p.audience, 'all');
  }
});

test('the edited text is sent exactly; a double click sends once; the same operation replays its outcome', async () => {
  const c = (await say('tell everyone to read chapter 5')).messageCard;
  assert.equal(c.text, 'Please read chapter 5.');
  const opId = op();
  const edited = 'Please read chapter 5 and the case on page 112.';
  const [a, b] = await Promise.all([act({ cardId: c.id, operationId: opId, action: 'send', text: edited }), act({ cardId: c.id, operationId: op(), action: 'send', text: edited })]);
  assert.ok(a.http === 200 && (b.http === 200 || b.http === 409), `${JSON.stringify(a)} ${JSON.stringify(b)}`);
  const again = await act({ cardId: c.id, operationId: opId, action: 'send', text: edited });
  assert.equal(again.duplicate, true);
  const all = await posts();
  assert.equal(all.length, 1, 'sent once');
  assert.equal(all[0].text, edited);
  assert.equal(all[0].verbatim, true, 'he rewrote the draft: his words now (only an untouched draft is labelled as the assistant’s)');
});

test('privacy at Send: text that now names his illness, leave or family is refused on the card; nothing is sent', async () => {
  const c = (await say('tell everyone to read chapter 5')).messageCard;
  for (const text of ['Please read chapter 5. I am sick today.', 'Read chapter 5, I will be out Friday.', 'My mother is in the hospital, read chapter 5.', 'Read chapter 5; I have a doctor appointment.']) {
    const r = await send(c, { text });
    assert.deepEqual([r.http, r.code, r.text], [422, 'private', PRIVATE_TEXT], text);
  }
  assert.equal((await posts()).length, 0);
  assert.equal((await state()).messageCard.status, 'open', 'the card stays open for an edit');
  const ok = await send(c, { text: 'Please read chapter 5 before Thursday.' });
  assert.equal(ok.http, 200);
});

test('privacy before the card: an instruction whose words name his illness asks HR / class / both; no card', async () => {
  const r = await say("tell everyone that I'm sick and class is cancelled");
  assert.equal(r.reply, 'Should I file this as time off with HR, tell the class, or both?');
  assert.equal((await state()).messageCard, null);
  const cls = await say('the class');
  assert.equal(cls.action, 'preview', 'his answer opens the card; still nothing sent');
  assert.equal((await posts()).length, 0);
});

test('Don\'t send, typed “no”, a replaced card, and a reset: nothing is sent', async () => {
  const a = (await say('tell everyone to read chapter 5')).messageCard;
  const d = await act({ cardId: a.id, operationId: op(), action: 'decline' });
  assert.deepEqual([d.http, d.status, d.text], [200, 'not_sent', 'Not sent.']);
  const late = await send(a);
  assert.equal(late.http, 409);
  const b = (await say('tell everyone to read chapter 6')).messageCard;
  const no = await say("don't send");
  assert.equal(no.action, 'message_declined');
  assert.equal((await state()).messageCard.status, 'not_sent');
  const c1 = (await say('tell everyone to read chapter 7')).messageCard;
  const c2 = (await say('tell everyone to read chapter 8')).messageCard;
  assert.notEqual(c1.id, c2.id);
  const st = await state();
  assert.ok(st.chat.some((m) => m.messageCardId === c1.id && m.text === REPLACED), 'the old card is “Not sent — replaced by a newer message.”');
  assert.equal((await send(c1)).http, 409);
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await state()).messageCard, null);
  assert.equal((await send(c2)).http, 409);
  assert.equal((await posts()).length, 0);
  assert.ok(b.id);
});

test('the roster changed at Send: the card is updated (“The list changed: now …”) and nothing is sent; the next Send goes', async () => {
  const c = (await say('send a message to all seniors to bring laptops')).messageCard;
  const drop = SENIORS.find((id) => !['student-alex', 'student-sam'].includes(id));
  await post(`${s.studentRecords.url}/test/enrollment`, { dropped: [drop] });
  try {
    const r = await send(c);
    assert.equal(r.http, 409, JSON.stringify(r));
    assert.equal(r.code, 'changed');
    assert.equal(r.text, `The list changed: now ${SENIORS.length - 1} seniors. Check it, then press Send again.`);
    const st = await state();
    assert.equal(st.messageCard.count, SENIORS.length - 1);
    assert.equal(st.messageCard.to, `your ${SENIORS.length - 1} seniors`);
    assert.equal((await posts()).length, 0);
    const ok = await send(st.messageCard);
    assert.equal(ok.http, 200);
    assert.deepEqual(recipients((await posts())[0]), SENIORS.filter((x) => x !== drop));
  } finally {
    await post(`${s.studentRecords.url}/test/enrollment`, { dropped: [] });
  }
});

test('@assistant posts open the card too (the assistant\'s draft, labelled); a ↩ Reply opens one for that student only', async () => {
  const a = await say('@assistant tell everyone the reading for next week is chapter 6');
  assert.equal(a.action, 'preview', JSON.stringify(a));
  assert.match(a.reply, /check it, then press Send/);
  assert.equal(a.messageCard.to, `all ${ALL} students in Marketing 351`);
  assert.equal((await posts()).length, 0);
  await send(a.messageCard);
  const [p] = await posts();
  assert.equal(p.author, 'assistant');
  assert.equal(p.audience, 'all');
  const r = await say('Thanks, see you Thursday.', { replyTo: 'student-sam' });
  assert.equal(r.messageCard.to, 'the student you’re replying to');
  await send(r.messageCard);
  const reply = (await posts()).find((x) => x.audience === 'student-sam');
  assert.equal(reply.text, 'Thanks, see you Thursday.');
});

test('the state and the outbox never carry a recipient\'s name or id for a group card', async () => {
  const c = (await say('send a message to all seniors to bring laptops')).messageCard;
  const wire = JSON.stringify((await state()).messageCard);
  assert.ok(!SENIORS.some((id) => wire.includes(id)) && !/Aguilar|Student\b/.test(wire), wire);
  await send(c);
  const file = readFileSync(s.outboxFile, 'utf8');
  const chat = JSON.stringify(JSON.parse(file).chat);
  assert.ok(!SENIORS.filter((id) => !['student-alex', 'student-sam'].includes(id)).some((id) => chat.includes(id)), 'no senior id in the chat entries');
});

test('UI route: strict keys, bad ids, text only on Send, cross-site Origin refused at the Faculty agent', async () => {
  const c = (await say('tell everyone to read chapter 5')).messageCard;
  for (const body of [{ cardId: c.id, operationId: op(), action: 'send', extra: 1 }, { cardId: 'nope', operationId: op(), action: 'send' }, { cardId: c.id, operationId: op(), action: 'shout' }, { cardId: c.id, operationId: op(), action: 'decline', text: 'x' }, { cardId: c.id, operationId: op(), action: 'send', text: 5 }]) {
    assert.equal((await act(body)).http, 400, JSON.stringify(body));
  }
  const res = await fetch(`${s.professor.url}/author/message-action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ cardId: c.id, operationId: op(), action: 'send' }) });
  assert.equal(res.status, 403);
  assert.equal((await posts()).length, 0);
});

test('the message card survives a reload (it is in the state) and the chat line carries its id', async () => {
  const c = (await say('send a message to all seniors')).messageCard;
  const st = await state();
  assert.equal(st.messageCard.id, c.id);
  const own = st.chat.find((m) => m.role === 'professor' && m.text === 'send a message to all seniors');
  assert.deepEqual(own.messageCard, { id: c.id });
  await waitFor(async () => (await state()).messageCard?.id === c.id, { what: 'card still there' });
});

test('@assistant: a course lesson opens the card labelled as the course pack has it; a meeting offer waits on the card too', async () => {
  const l = await say('@assistant send the Evidence before assumptions lesson to the class');
  assert.equal(l.action, 'preview', JSON.stringify(l));
  assert.equal(l.messageCard.label, 'Course lesson, as written in the course pack');
  assert.match(l.messageCard.text, /Check your understanding:/);
  await send(l.messageCard);
  const [lesson] = await posts();
  assert.deepEqual([lesson.kind, lesson.title, lesson.verbatim], ['lesson', 'Evidence before assumptions', true]);
  const m = await say('@assistant schedule a meeting with @alex Tue 2pm or Wed 10:30am');
  assert.equal(m.action, 'preview', JSON.stringify(m));
  assert.match(m.messageCard.text, /Pick the time that works for you/);
  assert.equal((await posts()).length, 1, 'the offer is not sent before Send');
  await send(m.messageCard);
  const offer = (await posts()).find((p) => p.meetingState);
  assert.equal(offer.audience, 'student-alex');
  assert.equal(offer.meetingState.length, 2);
});

test('names route: unknown or closed cards answer 404; a reset forgets the card', async () => {
  assert.equal((await fetch(`${s.ui.url}/api/professor/message/mc-doesnotexist/names`)).status, 404);
  assert.equal((await fetch(`${s.ui.url}/api/professor/message/not-a-card/names`)).status, 404);
  const c = (await say('send a message to all seniors')).messageCard;
  assert.equal((await names(c)).length, SENIORS.length);
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.equal((await fetch(`${s.ui.url}/api/professor/message/${c.id}/names`)).status, 404);
});

test('a typed “yes” sends the text the page shows in the box (messageCard in the chat request), not the older server copy', async () => {
  const c = (await say('tell everyone to read chapter 5')).messageCard;
  const r = await say('yes', { messageCard: { id: c.id, text: 'Please read chapter 5 and bring questions.' } });
  assert.equal(r.action, 'sent', JSON.stringify(r));
  assert.equal((await posts())[0].text, 'Please read chapter 5 and bring questions.');
  const bad = await say('yes', { messageCard: { id: c.id, text: 5 } });
  assert.equal(bad.http, 400);
});
