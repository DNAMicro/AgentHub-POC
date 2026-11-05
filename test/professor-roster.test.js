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
import { NOTIFY_EMPTY, ROSTER_GONE, asksRoster, createRosterDesk, notifyEveryone, sentToAllText } from '../src/professor-roster.js';
import { ROSTER_FAILED_TEXT, ROSTER_POST_FAILED_TEXT } from '../src/staff.js';

const UNSURE = 'Should I file this as time off with HR, tell the class, or both?';
const FAILED_POST = "I couldn't get your class list just now, so nothing was sent. Try again in a moment.";
const FAILED_ROSTER = "I couldn't get your class roster just now. Try again in a moment.";
const SENT = 'Sent to all 25 students in Marketing 351.';
const ROW_SECRET = /csu\.fullerton\.example|888\d{6}/;

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
    ['Inform the whole class about the midterm review', 'The midterm review.'],
    ['Tell the class that office hours moved to 3 pm!', 'Office hours moved to 3 pm!'],
  ];
  for (const [said, rest] of variants) assert.deepEqual(notifyEveryone(said), { rest }, said);
  assert.deepEqual(notifyEveryone('notify everyone'), { rest: '' });
  assert.deepEqual(notifyEveryone('Let everyone know'), { rest: '' });
  for (const t of ['Tell Sam the quiz is Friday', 'Please read chapter 5', 'everyone should read chapter 5', 'both', 'tell them']) assert.equal(notifyEveryone(t), null, t);
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
  // The state may name students on the delivery rows of a post (that is what the rows show); emails and IDs never.
  const everywhere = JSON.stringify(main.stream.events) + hubEvents.join('\n') + JSON.stringify(await state(main)) + main.hub.output() + main.professor.output() + main.ui.output();
  for (const row of rows) {
    assert.ok(!everywhere.includes(row.email), `email of ${row.studentId}`);
    assert.ok(!everywhere.includes(String(row.id)), `PeopleSoft ID of ${row.studentId}`);
  }
  const streams = JSON.stringify(main.stream.events) + hubEvents.join('\n') + main.hub.output() + main.professor.output() + main.ui.output();
  for (const name of ['Aguilar', 'Yamamoto']) assert.ok(!streams.includes(name), `${name} stays out of the monitor stream, telemetry and logs`);
});

test('notify everyone (5 variants) posts the stripped text to all 25 and says how many', async () => {
  const variants = [
    ['Notify everyone that the quiz is on Friday', 'The quiz is on Friday.'],
    ['tell everybody: bring your laptop', 'Bring your laptop.'],
    ['Let all my students know the reading is chapter 5', 'The reading is chapter 5.'],
    ['Inform the whole class about the midterm review', 'The midterm review.'],
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

test('the count in the reply comes from the post’s actual deliveries; delivery names are passed through for roster-only students', async () => {
  await say(main, 'Notify everyone that class starts at ten');
  const l = (await state(main)).lessons[0];
  const mariana = l.deliveries.find((d) => d.studentId === 'student-mariana-aguilar');
  assert.equal(mariana.name, 'Mariana Aguilar');
  assert.equal(mariana.state, 'queued');
  assert.equal(l.deliveries.find((d) => d.studentId === 'student-alex').state, 'delivered');
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

test('an unrelated plain class message still posts as before; @assistant never reaches the roster desk', async () => {
  const r = await say(main, 'Please read chapter 5 before Monday');
  assert.equal(r.action, 'post');
  const a = await say(main, '@assistant show my class roster');
  assert.notEqual(a.action, 'roster');
  assert.equal((await state(main)).rosterCard, null);
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
});
