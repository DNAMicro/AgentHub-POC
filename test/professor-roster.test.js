// Part 17 Task 4: the Faculty agent's roster desk (roster card state + route, "notify everyone that …", the privacy guard,
// the plain failure sentence, last-known counts). Mock Professor/HR/CHRS (labelled heuristics): these tests prove plumbing
// and code-decided outcomes. The class list is CHRS's 25 fictional students; Alex is the only one online.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack, startProfessor, post, openStream, waitFor, stopProcess } from './support/harness.js';
import { NOTIFY_EMPTY, ROSTER_GONE, asksRoster, asksRosterExport, asksAboutRoster, createRosterDesk, notifyEveryone, notifyIsNew, resolveTags, rosterFact, rosterFilter, sentToAllText, tellText } from '../src/professor-roster.js';
import { readFileSync } from 'node:fs';
import { ROSTER_FAILED_TEXT, ROSTER_POST_FAILED_TEXT } from '../src/staff.js';

const UNSURE = 'Should I file this as time off with HR, tell the class, or both?';
const FAILED_POST = "I couldn't get your class list just now, so nothing was sent. Try again in a moment.";
const FAILED_ROSTER = "I couldn't get your class roster just now. Try again in a moment.";
const SENT = 'Sent to all 25 students in Marketing 351.';
const ROW_SECRET = /csu\.fullerton\.example|888\d{6}/;
// Alex and Sam are the two configured Student-agent sessions (Part 9: their names were in the state before Part 17).
const SESSION_STUDENTS = ['student-alex', 'student-sam'];

// ---- the words (code) ------------------------------------------------------------------------------------------------
test('asksRoster reads roster requests and leaves announcements, tags and long messages alone', () => {
  for (const t of ['show my class roster', 'Show me the roster', 'roster', 'my class roster?', 'who is in my class?', "who's enrolled", 'Who are my students', 'give me the class list', 'list of my students', 'show enrolled students']) assert.equal(asksRoster(t), true, t);
  for (const t of ['', 'Please bring the class roster to the meeting on Monday afternoon at three', 'Tell everyone to check the class list', '@sam show the roster', 'Read chapter 5', 'I need Friday off', 'notify everyone that the roster changed', 'Remind the class who is in each group']) assert.equal(asksRoster(t), false, t);
});

test('notifyEveryone: the opening is stripped, the rest is capitalized with a period; empty rest is empty; others are null', () => {
  const variants = [
    ['Notify everyone that the quiz is on Friday', 'The quiz is on Friday.'],
    ['tell everybody: bring your laptop', 'Bring your laptop.'],
    ['Let all my students know the reading is chapter 5', 'The reading is chapter 5.'],
    ['Inform the whole class that the midterm review is Monday', 'The midterm review is Monday.'],
    ['Tell the class that office hours moved to 3 pm!', 'Office hours moved to 3 pm!'],
  ];
  for (const [said, rest] of variants) assert.deepEqual(notifyEveryone(said), { rest }, said);
  // A subject only (about / of) is never a message: the desk asks what to say.
  assert.deepEqual(notifyEveryone('Inform the whole class about the midterm review.'), { rest: '', about: 'the midterm review' });
  assert.deepEqual(notifyEveryone('tell everyone of the quiz'), { rest: '', about: 'the quiz' });
  assert.deepEqual(notifyEveryone('notify everyone about'), { rest: '' });
  assert.deepEqual(notifyEveryone('notify everyone'), { rest: '' });
  assert.deepEqual(notifyEveryone('Let everyone know'), { rest: '' });
  for (const t of ['Tell Sam the quiz is Friday', 'Please read chapter 5', 'everyone should read chapter 5', 'both', 'tell them']) assert.equal(notifyEveryone(t), null, t);
});

test('final review 5: "tell everyone to <verb> …" becomes "Please <verb> …." (never the fragment "To read …")', () => {
  assert.deepEqual(notifyEveryone('Tell everyone to read chapter 5 before Thursday'), { rest: 'Please read chapter 5 before Thursday.' });
  assert.deepEqual(notifyEveryone('let the class know to bring laptops'), { rest: 'Please bring laptops.' });
  assert.deepEqual(notifyEveryone('Let all my students know to submit by Friday!'), { rest: 'Please submit by Friday!' });
  // Only right after the opening: “that …” / “:” keep his own words.
  assert.deepEqual(notifyEveryone('Tell the class: to be honest, the quiz was hard'), { rest: 'To be honest, the quiz was hard.' });
  assert.deepEqual(notifyEveryone('notify everyone that to-do lists help'), { rest: 'To-do lists help.' });
});

test('the desk keeps the last known counts when the Hub has none, and forgets them on reset', () => {
  const desk = createRosterDesk({ hubLink: {}, conversationId: () => 'c' });
  assert.equal(desk.counts(), null, 'null only before any fetch');
  desk.noteCourse({ rosterCount: 25, onlineCount: 1 });
  desk.noteCourse({ rosterCount: null, onlineCount: null }); // the Hub's 60 s cache expired
  desk.noteCourse(null);
  assert.deepEqual(desk.counts(), { count: 25, online: 1 });
  desk.reset();
  assert.equal(desk.counts(), null);
});

const rows = Array.from({ length: 3 }, (_, i) => ({ studentId: i === 0 ? 'student-alex' : `student-x${i}` }));
const okLink = (before = () => {}) => ({ sendSigned: async () => { await before(); return { status: 'ok', reply: { roster: { class: { code: 'X' }, rows } } }; } });
test('a roster fetched while the Hub view is missing keeps the last known online count (not 0)', async () => {
  const desk = createRosterDesk({ hubLink: okLink(), conversationId: () => 'c' });
  desk.noteCourse({ rosterCount: 3, onlineCount: 1 });
  await desk.request({ operationId: 'op-1', hub: null });
  assert.deepEqual(desk.counts(), { count: 3, online: 1 });
});

test('a classroom reset while a roster request is in flight leaves no roster card', async () => {
  let desk;
  desk = createRosterDesk({ hubLink: okLink(() => desk.reset()), conversationId: () => 'c' });
  const r = await desk.request({ operationId: 'op-2', hub: null });
  assert.equal(r.reply, ROSTER_GONE);
  assert.equal(desk.state(), null);
  assert.equal(desk.view(null, null), null);
});

// ---- the running Faculty agent ---------------------------------------------------------------------------------------
const stacks = [];
const streams = [];
after(() => { for (const x of streams) x.close(); for (const x of stacks) x.kill(); });
async function classroom({ chrs = true, hr = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'a2a-roster-desk-'));
  const files = { inbox: join(d, 'inbox.json'), outbox: join(d, 'outbox.json') };
  const s = await startStack({
    library: false, professor: true, hr, chrs, hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    uiEnv: { STUDENT_INBOX_FILE: files.inbox }, professorEnv: { PROFESSOR_OUTBOX_FILE: files.outbox },
  });
  s.files = files;
  stacks.push(s);
  const stream = await openStream(s.ui.url);
  streams.push(stream);
  s.stream = stream;
  s.reset = async () => { await post(`${s.hub.url}/dev/classroom/reset`, {}); };
  return s;
}
const say = async (s, text, operationId = `op-${randomUUID()}`) => {
  const res = await post(`${s.ui.url}/api/professor/chat`, { operationId, text });
  return { http: res.status, ...(await res.json()) };
};
const state = async (s) => (await fetch(`${s.ui.url}/api/professor/state`)).json();
// CHRS (and its records stand-in) start after the stack did, on the ports the Hub already names, and the Hub marks it ready.
async function bringBackChrs(s) {
  const { randomBytes } = await import('node:crypto');
  const { startChrs, startStudentRecords, hubEntry } = await import('./support/harness.js');
  const token = randomBytes(24).toString('base64url');
  const { unusedPort } = await import('./support/harness.js');
  s.studentRecords = await startStudentRecords({ PORT: String(await unusedPort()), STUDENT_RECORDS_TOKEN: token });
  s.chrs = await startChrs({ ...s.specialistEnv, PORT: String(s.chrsPort), STUDENT_RECORDS_URL: s.studentRecords.url, STUDENT_RECORDS_TOKEN: token });
  await waitFor(async () => (await hubEntry(s.hub, 'chrs'))?.status === 'ready', { what: 'chrs ready', timeout: 10000 });
}
const lastOf = (chat, role) => chat.filter((m) => m.role === role).at(-1);

let main;
before(async () => { main = await classroom({ hr: true }); });
beforeEach(async () => { await main.reset(); });

test('before any fetch the header counts are null; "show my class roster" answers with the exact line and a card reference', async () => {
  const before = await state(main);
  assert.equal(before.rosterCard, null);
  assert.equal(before.roster.count, null);
  assert.equal(before.roster.online, null);
  const r = await say(main, 'show my class roster');
  assert.equal(r.http, 200, JSON.stringify(r));
  assert.equal(r.reply, 'Class roster · 25 students');
  assert.equal(r.action, 'roster');
  const st = await state(main);
  assert.deepEqual(Object.keys(st.rosterCard).sort(), ['at', 'count', 'rosterId']);
  assert.equal(st.rosterCard.count, 25);
  assert.equal(r.roster.rosterId, st.rosterCard.rosterId);
  assert.deepEqual([st.roster.count, st.roster.online], [25, 1], 'header: 25 students · 1 online');
  assert.equal(st.lessons.length, 0, 'asking for a roster posts nothing');
  const line = lastOf(st.chat, 'assistant');
  assert.equal(line.text, 'Class roster · 25 students');
  assert.equal(line.roster.rosterId, st.rosterCard.rosterId);
  assert.equal(st.chat.find((m) => m.role === 'professor').staff, false, 'a roster request is not an HR secret');
  // The state carries a reference only: no name, email or ID.
  const wire = JSON.stringify(st);
  assert.ok(!ROW_SECRET.test(wire) && !/Aguilar|Yamamoto/.test(wire), 'rows are not in the state');
});

test('GET /api/professor/roster serves the full roster to the Faculty view, and 404 "Ask again" when there is none', async () => {
  const none = await fetch(`${main.ui.url}/api/professor/roster`);
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error, ROSTER_GONE);
  const r = await say(main, 'who is in my class?');
  assert.equal(r.reply, 'Class roster · 25 students');
  const res = await fetch(`${main.ui.url}/api/professor/roster`);
  assert.equal(res.status, 200);
  const v = await res.json();
  assert.equal(v.rosterId, r.roster.rosterId);
  assert.equal(v.roster.rows.length, 25);
  assert.match(JSON.stringify(v.roster.rows[0]), /Aguilar/);
  assert.ok(ROW_SECRET.test(JSON.stringify(v)), 'the Faculty view gets the emails and IDs');
  assert.deepEqual(v.online, ['student-alex']);
  // A classroom reset forgets the card.
  await main.reset();
  assert.equal((await fetch(`${main.ui.url}/api/professor/roster`)).status, 404);
  assert.equal((await state(main)).rosterCard, null);
});

test('Review Focus 4: roster emails and IDs never appear in the UI monitor stream, the Hub telemetry, the state or the logs', async () => {
  await say(main, 'show my class roster');
  const rows = (await (await fetch(`${main.ui.url}/api/professor/roster`)).json()).roster.rows;
  assert.equal(rows.length, 25);
  await say(main, 'Notify everyone that the quiz is Friday');
  await new Promise((r) => setTimeout(r, 400)); // telemetry may lag the reply
  const hubEvents = await new Promise((resolve) => {
    const abort = new AbortController();
    const events = [];
    fetch(`${main.hub.url}/viz/events`, { signal: abort.signal }).then(async (res) => {
      let buf = '';
      try {
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) { buf += chunk; let e; while ((e = buf.indexOf('\n\n')) !== -1) { const d = buf.slice(0, e).split('\n').find((l) => l.startsWith('data: ')); buf = buf.slice(e + 2); if (d) events.push(d.slice(6)); } }
      } catch { /* aborted */ }
    });
    setTimeout(() => { abort.abort(); resolve(events); }, 600);
  });
  // Emails and IDs never appear anywhere; classmates' names not in the state either (Ruling 5, checked below and in the
  // final review test that reads the page stream).
  const everywhere = JSON.stringify(main.stream.events) + hubEvents.join('\n') + JSON.stringify(await state(main)) + main.hub.output() + main.professor.output() + main.ui.output();
  for (const row of rows) {
    assert.ok(!everywhere.includes(row.email), `email of ${row.studentId}`);
    assert.ok(!everywhere.includes(String(row.id)), `PeopleSoft ID of ${row.studentId}`);
  }
  const streams = JSON.stringify(main.stream.events) + hubEvents.join('\n') + main.hub.output() + main.professor.output() + main.ui.output();
  for (const name of ['Aguilar', 'Yamamoto']) assert.ok(!streams.includes(name), `${name} stays out of the monitor stream, telemetry and logs`);
  const st = JSON.stringify(await state(main));
  for (const row of rows.filter((x) => !SESSION_STUDENTS.includes(x.studentId))) {
    const [last, first] = row.name.split(',');
    for (const n of [row.name, `${first} ${last}`, last]) assert.ok(!st.includes(n), `${n} is not in /author/state`);
  }
});

test('notify everyone (5 variants) posts the stripped text to all 25 and says how many', async () => {
  const variants = [
    ['Notify everyone that the quiz is on Friday', 'The quiz is on Friday.'],
    ['tell everybody: bring your laptop', 'Bring your laptop.'],
    ['Let all my students know the reading is chapter 5', 'The reading is chapter 5.'],
    ['Inform the whole class that the midterm review is Monday', 'The midterm review is Monday.'],
    ['Tell the class that office hours moved to 3 pm', 'Office hours moved to 3 pm.'],
  ];
  for (const [said, text] of variants) {
    const r = await say(main, said);
    assert.equal(r.http, 200, JSON.stringify(r));
    assert.equal(r.action, 'post', said);
    const st = await state(main);
    const l = st.lessons[0];
    assert.equal(l.text, text, said);
    assert.equal(l.audience, 'all');
    assert.equal(l.author, 'professor');
    assert.equal(l.verbatim, true);
    assert.equal(l.deliveries.length, 25, 'one delivery per roster student');
    assert.equal(lastOf(st.chat, 'assistant').text, SENT, said);
    assert.equal(lastOf(st.chat, 'assistant').staff, false);
  }
  assert.equal(sentToAllText(25), SENT);
});

test('the count in the reply comes from the post’s actual deliveries; names come only from the Faculty view’s roster fetch', async () => {
  await say(main, 'Notify everyone that class starts at ten');
  const l = (await state(main)).lessons[0];
  const mariana = l.deliveries.find((d) => d.studentId === 'student-mariana-aguilar');
  assert.equal(mariana.name, undefined, 'no classmate name in /author/state (Ruling 5)');
  assert.equal(mariana.state, 'queued');
  assert.equal(l.deliveries.find((d) => d.studentId === 'student-alex').state, 'delivered');
  const r = await (await fetch(`${main.ui.url}/api/professor/roster`)).json();
  assert.equal(r.names['student-mariana-aguilar'], 'Mariana Aguilar', 'the Faculty view maps ids to names from its roster fetch');
});

test('Review Focus 2: "notify everyone that I\'m sick, no class" asks the fixed question and posts nothing; "class" then posts it', async () => {
  const r = await say(main, "notify everyone that I'm sick, no class");
  assert.equal(r.reply, UNSURE);
  let st = await state(main);
  assert.equal(st.lessons.length, 0, 'nothing posted on a guess');
  assert.equal(st.chat.find((m) => m.role === 'professor').staff, true, 'held privately');
  const c = await say(main, 'class');
  assert.equal(c.action, 'post', JSON.stringify(c));
  st = await state(main);
  assert.equal(st.lessons.length, 1);
  assert.equal(st.lessons[0].text, "I'm sick, no class.", 'the held message went out as the stripped class post');
  assert.equal(lastOf(st.chat, 'assistant').text, SENT);
  // Relatives and first person count too.
  for (const t of ['Tell the class my mother died', 'let everyone know I will be out Friday']) {
    await main.reset();
    assert.equal((await say(main, t)).reply, UNSURE, t);
    assert.equal((await state(main)).lessons.length, 0, t);
  }
});

test('notify everyone with nothing to tell asks "What should I tell your class?" and posts nothing', async () => {
  const r = await say(main, 'notify everyone');
  assert.equal(r.reply, NOTIFY_EMPTY);
  assert.equal(r.reply, 'What should I tell your class?');
  const st = await state(main);
  assert.equal(st.lessons.length, 0);
  assert.equal(lastOf(st.chat, 'assistant').text, NOTIFY_EMPTY);
});

test('an unrelated plain class message still posts as before; round 2 (R1): "@assistant show my class roster" gets the same code answer', async () => {
  const r = await say(main, 'Please read chapter 5 before Monday');
  assert.equal(r.action, 'post');
  const a = await say(main, '@assistant show my class roster');
  assert.equal(a.action, 'roster'); // was: never reached the roster desk (the model answered from the 2-person session list)
  assert.equal(a.reply, 'Class roster · 25 students');
  assert.equal((await state(main)).lessons.length, 1, 'nothing more posted');
});

test('with an HR card open: a class announcement posts, a statement about himself is asked about, and a roster request leaves the card alone', async () => {
  const hr = await say(main, "I need Friday off, it's a vacation day");
  assert.equal(hr.action, 'staff', JSON.stringify(hr));
  let st = await state(main);
  const formRef = st.hrCard.formRef;
  assert.ok(formRef);
  const posted = await say(main, 'Notify everyone that the reading is chapter 5');
  assert.equal(posted.action, 'post', JSON.stringify(posted));
  st = await state(main);
  assert.equal(st.hrCard.formRef, formRef, 'the card is untouched');
  assert.equal(st.lessons[0].text, 'The reading is chapter 5.');
  const asked = await say(main, 'Notify everyone that I need Friday off');
  assert.equal(asked.reply, UNSURE);
  assert.equal((await state(main)).lessons.length, 1, 'nothing more posted');
  await say(main, 'hr'); // answer the held question so the desk is free again
  st = await state(main);
  assert.ok(st.hrCard);
  const roster = await say(main, 'show my class roster');
  assert.equal(roster.reply, 'Class roster · 25 students');
  assert.equal((await state(main)).hrCard.formRef, st.hrCard.formRef, 'the card is still the same');
});

test('while the staff desk waits for an answer, a roster or notify phrase is read as that answer, not as a new request', async () => {
  assert.equal((await say(main, "I'm sick, cancel Friday's class")).reply, UNSURE);
  const r = await say(main, 'tell the class');
  assert.notEqual(r.reply, NOTIFY_EMPTY, 'a short answer to the question is the desk’s to read');
  assert.equal((await state(main)).rosterCard, null);
});

// ---- Review Focus 5: a Faculty restart ----------------------------------------------------------------------------
test('Review Focus 5: after the Faculty agent restarts the chat line stays, the rows don\'t: "Ask again to see your roster."', async () => {
  const s = await classroom();
  const r = await say(s, 'show my class roster');
  assert.equal(r.reply, 'Class roster · 25 students');
  const old = r.roster.rosterId;
  await stopProcess(s.professor);
  s.professor = await startProfessor({ ...s.specialistEnv, PORT: String(s.professorPort), PROFESSOR_OUTBOX_FILE: s.files.outbox });
  await waitFor(async () => (await state(s)).hubReachable === true, { what: 'professor back', timeout: 8000 });
  const st = await state(s);
  assert.equal(st.rosterCard, null, 'state says gone');
  assert.equal(lastOf(st.chat, 'assistant').text, 'Class roster · 25 students', 'the outbox kept the line');
  assert.equal(lastOf(st.chat, 'assistant').roster.rosterId, old);
  const res = await fetch(`${s.ui.url}/api/professor/roster`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Ask again to see your roster.');
  assert.equal(ROSTER_GONE, 'Ask again to see your roster.');
  // Asking again gives a new card.
  const again = await say(s, 'show my class roster');
  assert.equal(again.reply, 'Class roster · 25 students');
  assert.notEqual((await state(s)).rosterCard.rosterId, old);
});

// ---- CHRS unavailable -------------------------------------------------------------------------------------------------
test('CHRS down: a roster request, a notify and a plain class post each get one plain sentence; nothing technical shows', async () => {
  const s = await classroom({ chrs: false, hr: true });
  const roster = await say(s, 'show my class roster');
  assert.equal(roster.reply, FAILED_ROSTER);
  assert.equal(FAILED_ROSTER, ROSTER_FAILED_TEXT);
  // F3: roster facts fail with the same sentence (never the HR / class / both question).
  for (const text of ['how many students are enrolled?', 'Is Sam Student in my class?', "what's Mariana Aguilar's email?"]) assert.equal((await say(s, text)).reply, FAILED_ROSTER, text);
  assert.equal((await state(s)).rosterCard, null);
  assert.equal((await fetch(`${s.ui.url}/api/professor/roster`)).status, 404);
  for (const text of ['Notify everyone that the quiz is on Friday', 'Please read chapter 5 before Monday']) {
    const r = await say(s, text);
    assert.equal(r.reply, FAILED_POST, text);
    assert.equal(FAILED_POST, ROSTER_POST_FAILED_TEXT);
    assert.equal(r.post, null);
  }
  const st = await state(s);
  const wire = JSON.stringify(st.chat);
  assert.ok(!/roster_unavailable|CHRS|MCP|tool|Hub|student agent/i.test(wire), wire);
  assert.equal(st.lessons.every((l) => l.hubStatus === 'rejected'), true);
  assert.equal(st.lessons.reduce((n, l) => n + l.deliveries.length, 0), 0, 'nothing delivered');
});

test('CHRS down: repeating a refused post with the same operation id is a real retry, never a "duplicate" that pretends it went out', async () => {
  const s = await classroom({ chrs: false });
  const body = { operationId: `op-${randomUUID()}`, kind: 'message', title: 'Note', text: 'Class starts at ten.', audience: 'all' };
  const first = await (await post(`${s.professor.url}/author/lessons`, body)).json();
  assert.equal(first.ack.status, 'rejected');
  assert.equal(first.ack.reason, 'roster_unavailable');
  const again = await post(`${s.professor.url}/author/lessons`, body);
  const second = await again.json();
  assert.equal(again.status, 422);
  assert.equal(second.duplicate, undefined);
  assert.equal(second.ack.reason, 'roster_unavailable', 'the Hub was asked again');
});

test('CHRS down: the class cancellation uses the same sentence, and the offer can be answered again later', async () => {
  const s = await classroom({ chrs: false, hr: true });
  assert.equal((await say(s, "I'm sick, cancel Friday's class")).reply, UNSURE);
  assert.equal((await say(s, 'hr')).action, 'staff');
  const card = (await state(s)).hrCard;
  const surface = card.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
  const submit = await post(`${s.professor.url}/author/hr-action`, { operationId: `op-${randomUUID()}`, formRef: card.formRef, action: { name: 'submitTimeOff', surfaceId: surface, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { note: '', absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' } } });
  assert.equal((await submit.json()).status, 'accepted');
  const yes = await say(s, 'yes');
  assert.equal(yes.reply, FAILED_POST, JSON.stringify(yes));
  assert.equal((await state(s)).lessons.reduce((n, l) => n + l.deliveries.length, 0), 0);
  // The list comes back: the offer is waiting again, so a second yes sends the cancellation, once.
  await bringBackChrs(s);
  const again = await say(s, 'yes');
  assert.equal(again.action, 'post', JSON.stringify(again));
  let st = await state(s);
  const sent = st.lessons.filter((l) => l.title === 'Class cancelled' && l.deliveries.length === 25);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Marketing 351 is cancelled on Fri, Nov 6.');
  const third = await say(s, 'yes'); // the offer is used up: no second cancellation
  assert.ok(third.http === 200 || third.http === 409);
  st = await state(s);
  assert.equal(st.lessons.filter((l) => l.title === 'Class cancelled' && l.deliveries.length === 25).length, 1);
});

test('CHRS down: a held "class" answer is held again, and works once the list is back', async () => {
  const s = await classroom({ chrs: false });
  assert.equal((await say(s, "notify everyone that I'm sick, no class")).reply, UNSURE);
  assert.equal((await say(s, 'class')).reply, FAILED_POST);
  await bringBackChrs(s);
  const r = await say(s, 'class');
  assert.equal(r.action, 'post', JSON.stringify(r));
  assert.equal((await state(s)).lessons.filter((l) => l.deliveries.length === 25).length, 1);
});

// ---- "… about X": ask what to say -------------------------------------------------------------------------------------
test('"inform the class about the midterm review" asks what to say; his next plain reply goes to all 25, not to the staff desk', async () => {
  const r = await say(main, 'Inform the whole class about the midterm review');
  assert.equal(r.reply, 'What should I tell your class about the midterm review?');
  assert.equal((await state(main)).lessons.length, 0, 'no fragment is posted');
  // A reply that would look like an HR matter to the desk ("Friday") still goes to the class.
  const a = await say(main, 'It is on Friday at 2pm in room 101');
  assert.equal(a.action, 'post', JSON.stringify(a));
  const st = await state(main);
  assert.equal(st.hrCard, null);
  assert.equal(st.lessons[0].text, 'About the midterm review: It is on Friday at 2pm in room 101.', 'F6: the subject goes with the reply');
  assert.equal(st.lessons[0].deliveries.length, 25);
  assert.equal(lastOf(st.chat, 'assistant').text, SENT);
  // It was used up: the next plain message is a normal message again.
  const b = await say(main, 'Read chapter 6');
  assert.equal(b.action, 'post');
});

test('while "what should I tell your class about" waits: "never mind" drops it; a first-person leave reply is asked about; the wait expires only by time', async () => {
  await say(main, 'tell everyone about the quiz');
  const d = await say(main, 'never mind');
  assert.equal(d.reply, 'Okay, I won’t send anything to your class.');
  assert.equal((await state(main)).lessons.length, 0);
  assert.notEqual((await say(main, 'Read chapter 6')).reply, 'Okay, I won’t send anything to your class.');
  await main.reset();
  await say(main, 'notify everyone of the schedule change');
  const g = await say(main, "I'm sick on Friday");
  assert.equal(g.reply, UNSURE);
  assert.equal((await state(main)).lessons.length, 0);
  // "that …" keeps the strip-and-send behaviour.
  await main.reset();
  assert.equal((await say(main, 'notify everyone that the midterm review is Monday')).action, 'post');
});

// ---- final review (Part 17) -------------------------------------------------------------------------------------------
// Reads the page's one stream (/api/ui/stream: monitor, student and professor channels) for a while, as raw text.
async function pageStreamText(s, ms) {
  const abort = new AbortController();
  let text = '';
  const res = await fetch(`${s.ui.url}/api/ui/stream`, { signal: abort.signal });
  const reading = (async () => { try { for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) text += chunk; } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, ms));
  abort.abort();
  await reading;
  return text;
}
async function fileSickFriday(s) {
  assert.equal((await say(s, "I'm sick, cancel Friday's class")).reply, UNSURE);
  assert.equal((await say(s, 'hr')).action, 'staff');
  const card = (await state(s)).hrCard;
  const surface = card.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
  const submit = await post(`${s.professor.url}/author/hr-action`, { operationId: `op-${randomUUID()}`, formRef: card.formRef, action: { name: 'submitTimeOff', surfaceId: surface, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { note: '', absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-06', endDate: '2026-11-06', hours: '8' } } });
  assert.equal((await submit.json()).status, 'accepted');
  assert.match(lastOf((await state(s)).chat, 'assistant').text, /Would you like me to send a cancellation/);
}

test('final review 1: "notify everyone that …" gets the plain path’s privacy check — illness, family and funeral words are asked about', async () => {
  for (const t of [
    'Notify everyone that Dr. Dabirian is sick today, no class',
    'Notify everyone that class is cancelled Friday because of a family emergency',
    'Tell the class that the funeral is Friday so no class',
    'Notify everyone that class is cancelled Friday, I am exhausted',
  ]) {
    await main.reset();
    const r = await say(main, t);
    assert.equal(r.reply, UNSURE, t);
    const st = await state(main);
    assert.equal(st.lessons.length, 0, `nothing posted: ${t}`);
    assert.equal(st.chat.find((m) => m.role === 'professor').staff, true, 'held privately');
  }
  // The reply to “What should I tell your class about …?” gets the same check.
  await main.reset();
  assert.equal((await say(main, 'Inform the whole class about Friday')).reply, 'What should I tell your class about Friday?');
  assert.equal((await say(main, 'Dr. Dabirian is sick, no class')).reply, UNSURE);
  assert.equal((await state(main)).lessons.length, 0);
  // Clean announcements still go out.
  await main.reset();
  const ok = await say(main, 'Notify everyone that the review session is Monday');
  assert.equal(ok.action, 'post', JSON.stringify(ok));
  assert.equal(lastOf((await state(main)).chat, 'assistant').text, SENT);
});

test('final review 2: with a cancellation offer waiting, "notify everyone that …" sends the stripped text and the offer stays open', async () => {
  await fileSickFriday(main);
  const r = await say(main, 'Notify everyone that the review session is in room 204');
  assert.equal(r.action, 'post', JSON.stringify(r));
  let st = await state(main);
  assert.equal(st.lessons[0].text, 'The review session is in room 204.', 'never the opening words');
  assert.equal(st.lessons[0].deliveries.length, 25);
  assert.equal(lastOf(st.chat, 'assistant').text, SENT);
  // The offer still waits for its yes.
  const yes = await say(main, 'yes');
  assert.equal(yes.action, 'post', JSON.stringify(yes));
  st = await state(main);
  assert.equal(st.lessons.filter((l) => l.title === 'Class cancelled').length, 1);
  assert.equal(st.lessons.find((l) => l.title === 'Class cancelled').text, 'Marketing 351 is cancelled on Fri, Nov 6.');
});

test('final review 2b: a held class post after a cancellation offer is answered first; the offer keeps waiting', async () => {
  await fileSickFriday(main);
  assert.equal((await say(main, 'Notify everyone that Dr. Dabirian is sick, no class')).reply, UNSURE);
  const c = await say(main, 'class');
  assert.equal(c.action, 'post', JSON.stringify(c));
  let st = await state(main);
  assert.equal(st.lessons[0].text, 'Dr. Dabirian is sick, no class.');
  assert.equal((await say(main, 'yes')).action, 'post');
  st = await state(main);
  assert.equal(st.lessons.filter((l) => l.title === 'Class cancelled').length, 1);
});

test('final review 5: "Tell everyone to read chapter 5 before Thursday" reaches students as "Please read chapter 5 before Thursday."', async () => {
  for (const [said, text] of [['Tell everyone to read chapter 5 before Thursday', 'Please read chapter 5 before Thursday.'], ['let the class know to bring laptops', 'Please bring laptops.']]) {
    const r = await say(main, said);
    assert.equal(r.action, 'post', JSON.stringify(r));
    const st = await state(main);
    assert.equal(st.lessons[0].text, text);
    assert.equal(lastOf(st.chat, 'assistant').text, SENT);
  }
});

test('final review 8: while "what should I tell your class about …?" waits and an HR card is open, a card edit goes to HR', async () => {
  const hr = await say(main, "I need Friday off, it's a vacation day");
  assert.equal(hr.action, 'staff', JSON.stringify(hr));
  assert.equal((await say(main, 'inform the class about the exam')).reply, 'What should I tell your class about the exam?');
  const edit = await say(main, 'make it Dec 7 instead');
  assert.equal(edit.action, 'staff', JSON.stringify(edit));
  assert.equal((await state(main)).lessons.length, 0, 'nothing went to the class');
});

test('final review 6: classmates’ names are in neither /author/state nor the page stream; the roster fetch has them', async () => {
  await say(main, 'show my class roster');
  const rows = (await (await fetch(`${main.ui.url}/api/professor/roster`)).json()).roster.rows;
  await say(main, 'Notify everyone that the reading is chapter 7');
  const text = await pageStreamText(main, 3500) + JSON.stringify(await state(main)) + JSON.stringify(await (await fetch(`${main.professor.url}/author/state`)).json());
  assert.match(text, /student-mariana-aguilar/, 'the stream and state did carry the post (ids only)');
  for (const row of rows.filter((x) => !SESSION_STUDENTS.includes(x.studentId))) {
    const [last, first] = row.name.split(','); // the roster row says "Aguilar,Mariana"; delivery names say "Mariana Aguilar"
    for (const n of [row.name, `${first} ${last}`, last]) assert.ok(!text.includes(n), `${n} stays off the shared state and stream`);
  }
  const names = (await (await fetch(`${main.ui.url}/api/professor/roster`)).json()).names;
  assert.equal(Object.keys(names).length, 25);
});

test('final review 3: delivery names survive the Hub’s 60 s roster cache (here 1.5 s); a reset forgets them', async () => {
  const d = mkdtempSync(join(tmpdir(), 'a2a-roster-ttl-'));
  const s = await startStack({
    library: false, professor: true, hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam', HUB_ROSTER_TTL_MS: '1500' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    uiEnv: { STUDENT_INBOX_FILE: join(d, 'i.json') }, professorEnv: { PROFESSOR_OUTBOX_FILE: join(d, 'o.json') },
  });
  stacks.push(s);
  await say(s, 'Notify everyone that the reading is chapter 5');
  await new Promise((r) => setTimeout(r, 2500)); // the roster cache expired
  const r = await fetch(`${s.ui.url}/api/professor/roster`);
  assert.equal(r.status, 404, 'no roster card was asked for');
  const { names } = await r.json();
  assert.equal(names['student-mariana-aguilar'], 'Mariana Aguilar');
  assert.equal(names['student-owen-bennett'], 'Owen Bennett');
  assert.equal(Object.keys(names).length, 25);
  assert.ok(!Object.values(names).some((n) => /^student-/.test(n)), 'never a raw id as a name');
  // The names-only fetch the Faculty view uses for delivery rows (always 200, no roster card needed).
  const only = await fetch(`${s.ui.url}/api/professor/roster/names`);
  assert.equal(only.status, 200);
  assert.deepEqual((await only.json()).names, names);
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  assert.deepEqual((await (await fetch(`${s.ui.url}/api/professor/roster/names`)).json()).names, {});
});

test('final review 9: the 3-second state poll never waits for a re-publish, and re-sends one post once at a time', async () => {
  const d = mkdtempSync(join(tmpdir(), 'a2a-roster-slow-'));
  const s = await startStack({
    library: false, professor: true, hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    uiEnv: { STUDENT_INBOX_FILE: join(d, 'i.json') }, professorEnv: { PROFESSOR_OUTBOX_FILE: join(d, 'o.json'), PROFESSOR_PUBLISH_TIMEOUT_MS: '1500' },
  });
  stacks.push(s);
  s.studentRecords.proc.kill('SIGSTOP'); // the class list hangs: the Hub's roster lookup waits, the publish times out
  try {
    const body = { operationId: `op-${randomUUID()}`, kind: 'message', title: 'Note', text: 'Class starts at ten.', audience: 'all' };
    const first = await (await post(`${s.professor.url}/author/lessons`, body)).json();
    assert.equal(first.lesson.hubAccepted, false);
    assert.ok(['uncertain', 'not_delivered'].includes(first.lesson.hubStatus), first.lesson.hubStatus);
    for (let i = 0; i < 2; i += 1) {
      const t0 = Date.now();
      const r = await fetch(`${s.professor.url}/author/state`);
      assert.equal(r.status, 200);
      await r.json();
      assert.ok(Date.now() - t0 < 1000, `state answered in ${Date.now() - t0} ms (a re-publish waits up to 1.5 s)`);
    }
  } finally {
    s.studentRecords.proc.kill('SIGCONT');
  }
  // Once the class list answers, a later poll's re-send gets it accepted (the same operation, never a second post).
  await waitFor(async () => {
    const st = await (await fetch(`${s.professor.url}/author/state`)).json();
    return st.lessons.length === 1 && st.lessons[0].hubAccepted && st.lessons[0].deliveries.length === 25;
  }, { what: 'the re-sent post accepted', timeout: 40000 });
});

test('final review 10: the quiz desk no longer takes the dead roster parameter', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(await src('professor-agent.js'), /lastRoster/);
  assert.doesNotMatch((await src('professor-quiz.js')).match(/export function createQuizDesk\([^)]*\)/)[0], /\broster\b/);
});

// ---- Part 17 faculty scenarios (F2–F6) --------------------------------------------------------------------------------
test('F3: rosterFact reads counts, membership and a student\'s details by code; a tag or an unrelated question is not one', () => {
  for (const t of ['how many students are enrolled?', 'How many students are enrolled in my class?', 'how many students do I have?', 'How big is my class?']) assert.deepEqual(rosterFact(t), { kind: 'count' }, t);
  assert.deepEqual(rosterFact('Is Sam Student in my class?'), { kind: 'member', name: 'Sam Student' });
  assert.deepEqual(rosterFact('is Mariana Aguilar enrolled?'), { kind: 'member', name: 'Mariana Aguilar' });
  assert.deepEqual(rosterFact('is Kevin on my roster?'), { kind: 'member', name: 'Kevin' });
  for (const [t, name] of [["what's Mariana Aguilar's email?", 'Mariana Aguilar'], ['what is Omar\'s major', 'Omar'], ['what year is Lily Chen', 'Lily Chen'], ["Diego Castillo's student ID", 'Diego Castillo']]) assert.deepEqual(rosterFact(t), { kind: 'detail', name }, t);
  for (const t of ['@sam is Kevin on my roster?', 'show my class roster', 'Is the quiz on Friday?', 'what is the plan for Friday', 'I need Friday off', 'is everyone in my class?', 'how many students opened it?']) assert.equal(rosterFact(t), null, t);
});

test('F6: tellText puts the subject in front unless the reply already names it', () => {
  assert.equal(tellText('the guest speaker', 'She is a brand manager from a local company and visits on Wednesday'), 'About the guest speaker: She is a brand manager from a local company and visits on Wednesday.');
  assert.equal(tellText('the midterm review', '  the midterm review is Monday '), 'the midterm review is Monday');
  assert.equal(tellText('the quiz', 'it moved to Monday!'), 'About the quiz: It moved to Monday!');
  assert.equal(tellText(null, ' The quiz moved to Monday '), 'The quiz moved to Monday');
});

test('F3: roster facts are answered from the roster by code: count, member, several, not on roster; never the HR question', async () => {
  const cases = [
    ['how many students are enrolled in my class?', '25 students are enrolled in Marketing 351.'],
    ['How big is my class?', '25 students are enrolled in Marketing 351.'],
    ['Is Sam Student in my class?', 'Yes — Sam Student is enrolled in Marketing 351.'],
    ['is Mariana Aguilar enrolled?', 'Yes — Mariana Aguilar is enrolled in Marketing 351.'],
    ['is Kevin on my roster?', 'Yes — Kevin Huang is enrolled in Marketing 351.'],
    ['Is Kim in my class?', 'Yes — Daniel Kim is enrolled in Marketing 351.'],
    ['Is Student in my class?', '2 students match “Student”: Alex Student and Sam Student.'],
    ['Is Jane Doe in my class?', "I don't see Jane Doe on your Marketing 351 roster."],
    ["what is Zed Quill's email?", "I don't see Zed Quill on your Marketing 351 roster."],
  ];
  for (const [text, reply] of cases) {
    const r = await say(main, text);
    assert.equal(r.reply, reply, text);
    assert.notEqual(r.reply, UNSURE);
  }
  const st = await state(main);
  assert.equal(st.lessons.length, 0, 'nothing posted');
  assert.equal(st.hrCard, null, 'nothing went to HR');
  // @sam: a message to that student, not a roster fact.
  const tagged = await say(main, '@sam is Kevin on my roster?');
  assert.notEqual(tagged.action, 'roster_fact');
});

test('F3: a details question shows the roster card with that row highlighted; the email / ID / major never reach the chat or the outbox', async () => {
  for (const [text, id, name] of [["what's Mariana Aguilar's email?", 'student-mariana-aguilar', 'Mariana Aguilar'], ['what is Omar\'s major', 'student-omar-hassan', 'Omar Hassan'], ['what year is Lily Chen', 'student-lily-chen', 'Lily Chen'], ["Diego Castillo's student ID", 'student-diego-castillo', 'Diego Castillo']]) {
    const r = await say(main, text);
    assert.equal(r.reply, `${name} is highlighted on your roster below.`, text);
    assert.equal(r.action, 'roster');
    const st = await state(main);
    const card = lastOf(st.chat, 'assistant');
    assert.equal(card.action, 'roster');
    assert.equal(card.roster.highlight, id);
    assert.equal(card.roster.rosterId, st.rosterCard.rosterId);
    assert.equal(st.chat.at(-2).text, `${name} is highlighted on your roster below.`);
    const rows = await (await fetch(`${main.ui.url}/api/professor/roster`)).json();
    assert.ok(rows.roster.rows.some((x) => x.studentId === id), 'the card fetch has the row');
  }
  const st = await state(main);
  const wire = JSON.stringify(st);
  assert.ok(!ROW_SECRET.test(wire) && !/Business Admin|Junior|Senior/.test(wire), 'no email, ID, major or year in the state');
  const file = readFileSync(main.files.outbox, 'utf8');
  assert.ok(!ROW_SECRET.test(file) && !/Business Admin|Info Systems|Junior|Senior/.test(file), 'nor in the outbox file');
  assert.ok(!st.chat.some((m) => m.text === UNSURE));
});

test('F4: while the HR / class / both question waits, a roster request, a roster fact and "Thanks" are answered and the question keeps waiting', async () => {
  assert.equal((await say(main, "I'm sick, cancel Friday's class")).reply, UNSURE);
  assert.equal((await say(main, 'show my class roster')).reply, 'Class roster · 25 students');
  assert.equal((await say(main, 'how many students are enrolled?')).reply, '25 students are enrolled in Marketing 351.');
  assert.equal((await say(main, 'Is Sam Student in my class?')).reply, 'Yes — Sam Student is enrolled in Marketing 351.');
  assert.equal((await say(main, 'Thanks')).reply, "You're welcome.");
  assert.equal((await say(main, 'thank you')).reply, "You're welcome.");
  // None of those counted toward the re-ask: an unclear reply is asked once (not dropped), then "hr" files the held message.
  assert.equal((await say(main, 'hmm')).reply, UNSURE);
  const hr = await say(main, 'hr');
  assert.equal(hr.action, 'staff', JSON.stringify(hr));
  assert.equal((await state(main)).lessons.length, 0);
});

test('F5: a bare "notify everyone" waits like "… about X": the next plain reply goes to all 25 with the count', async () => {
  assert.equal((await say(main, 'notify everyone')).reply, NOTIFY_EMPTY);
  const r = await say(main, 'The quiz moved to Monday');
  assert.equal(r.action, 'post', JSON.stringify(r));
  const st = await state(main);
  assert.equal(st.lessons[0].text, 'The quiz moved to Monday');
  assert.equal(st.lessons[0].deliveries.length, 25);
  assert.equal(lastOf(st.chat, 'assistant').text, SENT);
  // The same drop words and privacy check.
  await say(main, 'notify everyone');
  assert.equal((await say(main, 'never mind')).reply, 'Okay, I won’t send anything to your class.');
  await say(main, 'tell everyone');
  assert.equal((await say(main, "I'm sick on Friday")).reply, UNSURE);
  assert.equal((await state(main)).lessons.length, 1);
});

test('F6: the reply to "about X" reaches students as "About X: …"', async () => {
  assert.equal((await say(main, 'notify everyone about the guest speaker')).reply, 'What should I tell your class about the guest speaker?');
  await say(main, 'She is a brand manager from a local company and visits on Wednesday');
  const st = await state(main);
  assert.equal(st.lessons[0].text, 'About the guest speaker: She is a brand manager from a local company and visits on Wednesday.');
});

test('F2: with an HR card open, a day or time in the reply to "what should I tell your class about …?" goes to the class, not HR', async () => {
  const hr = await say(main, "I need Friday off, it's a vacation day");
  assert.equal(hr.action, 'staff', JSON.stringify(hr));
  const before = (await state(main)).hrCard;
  assert.equal((await say(main, 'inform the class about the field trip')).reply, 'What should I tell your class about the field trip?');
  const r = await say(main, 'We leave from the main entrance at 9 AM on Friday.');
  assert.equal(r.action, 'post', JSON.stringify(r));
  const st = await state(main);
  assert.equal(st.hrCard.formRef, before.formRef, 'the card is untouched');
  assert.equal(st.hrCard.a2ui.length, before.a2ui.length, 'no update was sent to the card');
  assert.equal(st.lessons[0].text, 'About the field trip: We leave from the main entrance at 9 AM on Friday.');
  assert.equal(lastOf(st.chat, 'assistant').text, SENT);
});

// ---- Part 17 faculty scenarios, round 2 (R1–R5) ------------------------------------------------------------------------
// The fictional roster itself (the authority the answers must match): counts come from these rows, never from a constant.
const { createStudentRecordsStore } = await import('../src/student-records-store.js');
const ROWS = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.rows;
const idsWhere = (fn) => ROWS.filter(fn).map((r) => r.studentId).sort();
const SENIORS = idsWhere((r) => r.level === 'Senior');
const MARKETING = idsWhere((r) => /marketing/i.test(`${r.program} ${r.plan}`));
const JUNIORS = idsWhere((r) => r.level === 'Junior');
const SEC = { EXPORT: "I can't email or export your roster from here, but here it is to look at.", QUESTION: "That reads like a question about your roster, so I didn't send it to your class. I can show your roster, count your students, look up one student, or list students by year or major." };
const lessonsOf = async (s) => (await state(s)).lessons;
const highlighted = async (s) => ((await (await fetch(`${s.ui.url}/api/professor/roster`)).json()).highlight ?? []).slice().sort();

test('R1a: "@assistant how many students are in my class?" gets the code count from the roster, never the 2-person session list', async () => {
  const r = await say(main, '@assistant how many students are in my class?');
  assert.equal(r.reply, '25 students are enrolled in Marketing 351.');
  assert.equal((await say(main, 'how many students are in my class?')).reply, '25 students are enrolled in Marketing 351.');
  assert.equal((await say(main, '@assistant who are my seniors?')).reply, `${SENIORS.length} seniors are highlighted on your roster below.`);
  assert.equal((await say(main, '@assistant is Mariana Aguilar in my class?')).reply, 'Yes — Mariana Aguilar is enrolled in Marketing 351.');
  assert.equal((await lessonsOf(main)).length, 0);
});

test('R2: @-tags resolve against the CHRS roster (@first, @last, @first-last); ambiguous asks by name; unknown is refused; @alex still works', async () => {
  const r = await say(main, '@mariana please resubmit your assignment');
  assert.equal(r.action, 'post', JSON.stringify(r));
  let ls = await lessonsOf(main);
  assert.equal(ls[0].audience, 'student-mariana-aguilar');
  assert.equal(ls[0].text, 'please resubmit your assignment');
  assert.deepEqual(ls[0].deliveries.map((d) => [d.studentId, d.state]), [['student-mariana-aguilar', 'queued']], 'offline: queued like Sam');
  for (const [text, id] of [['@Aguilar your essay was excellent', 'student-mariana-aguilar'], ['@daniel-kim nice presentation', 'student-daniel-kim'], ['@Chen your draft is great', 'student-lily-chen']]) {
    const x = await say(main, text);
    assert.equal(x.action, 'post', text);
    assert.equal((await lessonsOf(main))[0].audience, id, text);
  }
  const before = (await lessonsOf(main)).length;
  const amb = await say(main, '@student please see me');
  assert.equal(amb.reply, 'Which student did you mean: Alex Student or Sam Student? Nothing was sent — tag them by full name, like @alex-student.');
  assert.equal((await say(main, '@zed hello')).reply, "There's no @zed in Marketing 351, so nothing was sent.");
  assert.equal((await lessonsOf(main)).length, before, 'nothing sent for an ambiguous or unknown tag');
  const alex = await say(main, '@alex Great work on the quiz!');
  ls = await lessonsOf(main);
  assert.equal(alex.action, 'post');
  assert.equal(ls[0].audience, 'student-alex');
  assert.equal(ls[0].deliveries[0].state === 'delivered' || ls[0].deliveries[0].opened, true, 'Alex is online');
  // @assistant: the professor's tag names the roster student (mock interpreter; code resolves the tag).
  const via = await say(main, '@assistant @mariana Great job on your project');
  assert.equal(via.action, 'post', JSON.stringify(via));
  assert.equal((await lessonsOf(main))[0].audience, 'student-mariana-aguilar');
});

test('R2: the Faculty view\'s @-suggestions come from the roster: 25 names and tags, no email, ID, level or major', async () => {
  const r = await (await fetch(`${main.ui.url}/api/professor/roster/people`)).json();
  assert.equal(r.people.length, 25);
  assert.ok(r.people.some((p) => p.name === 'Mariana Aguilar' && p.tag === 'mariana'));
  assert.ok(r.people.some((p) => p.name === 'Alex Student' && p.tag === 'alex'));
  const wire = JSON.stringify(r);
  assert.ok(!ROW_SECRET.test(wire) && !/student-|Senior|Junior|Business Admin/.test(wire), 'names and tags only');
  assert.deepEqual(Object.keys(r.people[0]).sort(), ['name', 'tag']);
});

test('R3: "can you email me the roster?" and "export my roster to excel" show the card with one sentence; never posted, never the HR question', async () => {
  for (const text of ['can you email me the roster?', 'export my roster to excel', 'Please print the class list', 'download my class roster as a spreadsheet']) {
    const r = await say(main, text);
    assert.equal(r.reply, SEC.EXPORT, text);
    assert.equal(r.action, 'roster', text);
    const st = await state(main);
    assert.equal(lastOf(st.chat, 'assistant').action, 'roster', `${text}: the card follows the sentence`);
    assert.equal(st.lessons.length, 0, `${text}: never posted`);
  }
  // Any other question about the roster or "my students" is not posted either (and not the HR / class / both question).
  for (const text of ['can you tell me which of my students are online?', 'Which of my students have the roster link?']) {
    const r = await say(main, text);
    assert.equal(r.reply, SEC.QUESTION, text);
    assert.notEqual(r.reply, UNSURE);
  }
  assert.equal((await lessonsOf(main)).length, 0);
});

test('R4: students by level or major: the card highlights exactly those rows; counts in the chat only; nothing in the outbox or the state', async () => {
  const seniors = await say(main, 'who are my seniors?');
  assert.equal(seniors.reply, `${SENIORS.length} seniors are highlighted on your roster below.`);
  assert.deepEqual(await highlighted(main), SENIORS);
  const mkt = await say(main, 'which students are marketing majors?');
  assert.equal(mkt.reply, `${MARKETING.length} Marketing majors are highlighted on your roster below.`);
  assert.deepEqual(await highlighted(main), MARKETING);
  assert.equal((await say(main, 'list my juniors')).reply, `${JUNIORS.length} juniors are highlighted on your roster below.`);
  assert.deepEqual(await highlighted(main), JUNIORS);
  assert.equal((await say(main, 'how many seniors are in my class?')).reply, `${SENIORS.length} of your 25 students are seniors.`);
  assert.equal((await say(main, 'how many accounting majors do I have?')).reply, '1 of your 25 students is an Accounting major.');
  assert.equal((await say(main, 'who are my freshmen?')).reply, 'None of your students are freshmen.');
  const st = await state(main);
  assert.equal(st.lessons.length, 0);
  assert.ok(!st.chat.some((m) => m.text === UNSURE || /nothing was filed/.test(m.text)));
  const wire = JSON.stringify(st);
  // (Alex and Sam are the two Student-agent sessions: their ids are on the state anyway, Part 9.)
  assert.ok(!SENIORS.filter((id) => !SESSION_STUDENTS.includes(id)).some((id) => wire.includes(id)) && !/Senior|Junior|Business Admin/.test(wire), 'which students matched never reaches the state');
  const file = readFileSync(main.files.outbox, 'utf8');
  assert.ok(!SENIORS.some((id) => file.includes(id)) && !/"highlight"|Senior|Junior|Business Admin/.test(file), 'nor the outbox file');
});

test('R5: while the HR / class / both question waits, a notify with something to say and roster asks are new messages; the question keeps waiting', async () => {
  assert.equal((await say(main, "I'm sick, cancel Friday's class")).reply, UNSURE);
  const tell = await say(main, 'tell my students the midterm is postponed');
  assert.equal(tell.action, 'post', JSON.stringify(tell));
  let st = await state(main);
  assert.equal(st.lessons[0].text, 'The midterm is postponed.');
  assert.equal(st.lessons[0].deliveries.length, 25);
  assert.equal(lastOf(st.chat, 'assistant').text, SENT);
  assert.equal((await say(main, 'Let everyone know that grades are posted')).action, 'post');
  assert.equal((await lessonsOf(main))[0].text, 'Grades are posted.');
  assert.equal((await say(main, 'how many seniors are in my class?')).reply, `${SENIORS.length} of your 25 students are seniors.`);
  assert.equal((await say(main, 'who are my seniors?')).reply, `${SENIORS.length} seniors are highlighted on your roster below.`);
  assert.equal((await say(main, 'export my roster to excel')).reply, SEC.EXPORT);
  // A notify that must itself be asked about keeps the waiting question (never replaced) and says it wasn't sent.
  const own = await say(main, 'tell everyone that I am sick today');
  assert.equal(own.reply, "I'm still holding your earlier message — answer HR, the class, or both. Your new message wasn't sent; please send it again after.");
  // None of those counted toward the re-ask: one unclear reply is asked once, then "hr" files the FIRST held message.
  assert.equal((await say(main, 'hmm')).reply, UNSURE);
  const hr = await say(main, 'hr');
  assert.equal(hr.action, 'staff', JSON.stringify(hr));
  st = await state(main);
  assert.equal(st.hrCard.card.title, 'Sick Leave');
  assert.equal(st.lessons.length, 2, 'only the two notices went to the class');
});

test('R5: a held question dropped after unclear replies always says the last message wasn\'t sent when it was a message', async () => {
  assert.equal((await say(main, "I'm sick, cancel Friday's class")).reply, UNSURE);
  assert.equal((await say(main, 'The library closes at noon')).reply, UNSURE);
  assert.equal((await say(main, 'The bookstore is closed')).reply, "Okay, nothing was filed or posted. Your new message wasn't sent; please send it again.");
  // A plain unclear word or a refusal is not a message: no notice.
  assert.equal((await say(main, "I'm sick, cancel Friday's class")).reply, UNSURE);
  assert.equal((await say(main, 'hmm')).reply, UNSURE);
  assert.equal((await say(main, 'huh?')).reply, 'Okay, nothing was filed or posted.');
  assert.equal((await lessonsOf(main)).length, 0);
});

test('round 2 readers (code): rosterFilter, asksRosterExport, asksAboutRoster, resolveTags, notifyIsNew', () => {
  assert.deepEqual(rosterFilter('who are my seniors?'), { kind: 'filter', level: 'senior', major: null, count: false });
  assert.equal(rosterFilter('how many seniors are in my class?').count, true);
  assert.equal(rosterFilter('which students are marketing majors?').major.label, 'Marketing');
  assert.equal(rosterFilter('Who are the seniors majoring in finance?').major.label, 'Finance');
  for (const t of ['how many students are in my class?', "what is Omar's major", "which seniors haven't submitted?", 'Seniors: see me after class', '@sam who are my seniors?', 'how many students are in my marketing class?']) assert.equal(rosterFilter(t), null, t);
  for (const t of ['can you email me the roster?', 'export my roster to excel', 'print the class list']) assert.equal(asksRosterExport(t), true, t);
  for (const t of ['show my class roster', 'Tell everyone that I will share the class list Friday', 'Please email me when you are done']) assert.equal(asksRosterExport(t), false, t);
  assert.equal(asksAboutRoster('can you tell me which of my students are online?'), true);
  for (const t of ['Who wants to present on Friday?', 'Remind my students that the quiz is Friday', '@sam is the roster right?']) assert.equal(asksAboutRoster(t), false, t);
  const P = [{ studentId: 'student-alex', name: 'Alex Student' }, { studentId: 'student-sam', name: 'Sam Student' }, { studentId: 'student-mariana-aguilar', name: 'Mariana Aguilar' }];
  assert.deepEqual(resolveTags('@Aguilar hi', P).tagged.map((x) => x.studentId), ['student-mariana-aguilar']);
  assert.deepEqual(resolveTags('@student hi', P).ambiguous[0].names, ['Alex Student', 'Sam Student']);
  assert.deepEqual(resolveTags('mail alex@example.com or @assistant', P), { tagged: [], ambiguous: [], unknown: [] });
  for (const t of ['tell my students the midterm is postponed', 'Let everyone know that grades are posted', 'Tell everyone to read chapter 5']) assert.equal(notifyIsNew(t), true, t);
  for (const t of ['tell the class please, and thanks so much', 'Tell the class, and post that the exam is postponed', 'tell the class', 'tell the class too']) assert.equal(notifyIsNew(t), false, t);
});

test('live scenario H8: praise for the class is a post, not a roster question', () => {
  assert.equal(asksAboutRoster('What a great class, my students rock!'), false);
  assert.equal(asksAboutRoster('My students did great on the project!'), false);
  assert.equal(asksAboutRoster('What a lovely group my students are'), false);
  assert.equal(asksAboutRoster('what are my students majoring in?'), true);
  assert.equal(asksAboutRoster('can you email me the roster?'), true);
});
