// The student lets their instructor know (owner, 2026-11-09): “i am sick today” → the Student agent asks who should know →
// “my classes” → a message card filled with their words → Send → stored in Dr. Dabirian's chat → the Faculty agent's receipt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack, openStream, post, waitFor, find, findAll, forRun, stateOf } from './support/harness.js';
import { NOTHING_SENT_TEXT, askWhoText, readsAbsence, whoOf } from '../src/student-notify.js';

const COURSE = { professorName: 'Dr. Dabirian', courseTitle: 'Marketing 351' };

test('readsAbsence: a student who can’t come, not a question or another service', () => {
  for (const t of ['i am sick today', 'I’m sick', 'I have the flu', 'I will miss class Thursday', 'I can’t make it to class today', 'I won’t be in class tomorrow', 'I’ll be absent on Tuesday', 'family emergency, I can’t come today', 'I’m not feeling well']) assert.ok(readsAbsence(t), t);
  for (const t of ['what should I do if I’m sick?', 'I can’t make it to my tutoring appointment', 'I need to renew my library book', 'Is there a quiz tomorrow?', 'hello', 'I am sick of this homework']) assert.ok(!readsAbsence(t), t);
  assert.equal(askWhoText('i am sick today'), 'Sorry you’re not feeling well. Who would you like me to let know?');
  assert.equal(askWhoText('I will miss class Thursday'), 'Who would you like me to let know?');
});

test('whoOf: the answer to “who should know?”', () => {
  for (const t of ['my classes', 'my professor', 'Dr. Dabirian · Marketing 351', 'teacher', 'marketing', 'him']) assert.equal(whoOf(t, { course: COURSE }), 'instructor', t);
  for (const t of ['Cancel', 'no one', 'never mind']) assert.equal(whoOf(t, { course: COURSE }), 'cancel', t);
  assert.equal(whoOf('my boss', { course: COURSE }), 'other');
  assert.equal(whoOf('yes', { offered: true, course: COURSE }), 'instructor');
  assert.equal(whoOf('can you tell me when the final exam is and where it is held please', { course: COURSE }), null, 'a new message, not an answer');
});

// ---- end to end on a mock stack ------------------------------------------------------------------------------------------
const stacks = [];
const streams = [];
after(() => { for (const s of streams) s.close(); for (const s of stacks) s.kill(); });
async function classroom() {
  const d = mkdtempSync(join(tmpdir(), 'a2a-n-'));
  const s = await startStack({
    library: false, professor: true, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' },
    uiEnv: { STUDENT_INBOX_FILE: join(d, 'inbox.json') },
    professorEnv: { PROFESSOR_OUTBOX_FILE: join(d, 'outbox.json'), PROFESSOR_TEST_HOOKS: '1', PROFESSOR_NOW: '2026-11-06T20:00:00Z' },
  });
  stacks.push(s);
  const stream = await openStream(s.ui.url);
  streams.push(stream);
  await waitFor(async () => (await (await fetch(`${s.ui.url}/api/inbox`)).json()).notices.length === 1, { timeout: 15000, what: 'course notice' });
  return { s, stream };
}
const profChat = async (s) => (await (await fetch(`${s.ui.url}/api/professor/state`)).json()).chat;
async function say(s, stream, text, contextId) {
  const res = await post(`${s.ui.url}/api/runs`, { text, ...(contextId ? { contextId } : {}) });
  assert.equal(res.status, 202);
  const body = await res.json();
  await waitFor(() => ['completed', 'failed'].includes(stateOf(stream.events, body.runId)), { timeout: 15000, what: `run for “${text}”` });
  return { ...body, events: forRun(stream.events, body.runId) };
}
const lastCard = (stream, cardId) => findAll(stream.events, 'student', 'notify_card').filter((e) => !cardId || e.data.cardId === cardId).at(-1)?.data;

test('i am sick today → who? → my classes → card with their words → Send → Dr. Dabirian has it → receipt', async () => {
  const { s, stream } = await classroom();
  const first = await say(s, stream, 'i am sick today');
  const asked = find(first.events, 'student', 'notify_step').data;
  assert.equal(asked.text, 'Sorry you’re not feeling well. Who would you like me to let know?');
  assert.deepEqual(asked.choices.map((c) => c.label), ['Dr. Dabirian · Marketing 351', 'Cancel']);
  assert.ok(!find(first.events, 'student', 'request_sent'), 'nothing went to the university');

  const second = await say(s, stream, 'my classes', first.contextId);
  assert.ok(!find(second.events, 'student', 'request_sent'), 'still nothing sent');
  const card = find(second.events, 'student', 'notify_card').data;
  assert.equal(card.status, 'open');
  assert.equal(card.text, 'i am sick today', 'prefilled with what they typed');
  assert.equal(card.to, 'Dr. Dabirian');
  assert.equal(card.course, 'Marketing 351');
  assert.ok(!('capability' in card) && !('messageId' in card));
  assert.equal((await profChat(s)).filter((m) => m.role === 'student').length, 0, 'Dr. Dabirian has nothing yet');

  const message = 'i am sick today and won’t make it to class. I’ll catch up on the notes.';
  const sent = await post(`${s.ui.url}/api/notify/${card.cardId}/send`, { text: message });
  assert.equal(sent.status, 202);
  await waitFor(() => lastCard(stream, card.cardId)?.status === 'sent', { timeout: 15000, what: 'card sent' });
  const { runId } = await sent.json();
  const reply = find(forRun(stream.events, runId), 'student', 'reply_received').data;
  assert.equal(reply.text, 'Got it — Dr. Dabirian has been notified. They’ll reply to you here. Feel better soon.');
  assert.equal(reply.professor.outcome, 'notified');
  assert.equal(find(forRun(stream.events, runId), 'student', 'request_sent').data.notifyCardId, card.cardId, 'the card’s words are not drawn twice');
  const chat = await profChat(s);
  const handed = chat.find((m) => m.role === 'student' && m.text === message);
  assert.ok(handed, 'the edited words are in Dr. Dabirian’s chat');
  assert.ok(chat.some((m) => m.id === handed.id.replace(/:s$/, ':r') && m.needsProfessor), 'as a hand-over waiting for a reply');

  // A second Send is refused: it is sent once.
  assert.equal((await post(`${s.ui.url}/api/notify/${card.cardId}/send`, { text: message })).status, 409);
});

test('Cancel and Don’t send send nothing; a named person the demo can’t reach is said plainly', async () => {
  const { s, stream } = await classroom();
  const a = await say(s, stream, 'I will miss class Thursday');
  assert.equal(find(a.events, 'student', 'notify_step').data.text, 'Who would you like me to let know?');
  const b = await say(s, stream, 'Cancel', a.contextId);
  assert.equal(find(b.events, 'student', 'notify_step').data.text, NOTHING_SENT_TEXT);

  const c = await say(s, stream, 'i am sick today', a.contextId);
  const d = await say(s, stream, 'my boss', c.contextId);
  assert.equal(find(d.events, 'student', 'notify_step').data.text, 'Here I can only reach Dr. Dabirian, your Marketing 351 instructor. Want me to let them know?');
  const e = await say(s, stream, 'yes', c.contextId);
  const card = find(e.events, 'student', 'notify_card').data;
  assert.equal(card.text, 'i am sick today');
  assert.equal((await post(`${s.ui.url}/api/notify/${card.cardId}/decline`, {})).status, 200);
  await waitFor(() => lastCard(stream, card.cardId)?.status === 'not_sent', { what: 'card not sent' });
  assert.equal((await post(`${s.ui.url}/api/notify/${card.cardId}/send`, { text: 'x' })).status, 409);
  assert.equal((await profChat(s)).filter((m) => m.role === 'student').length, 0, 'nothing reached Dr. Dabirian');
});

test('a message already written to Dr. Dabirian goes on as before (no who-question)', async () => {
  const { s, stream } = await classroom();
  const r = await say(s, stream, 'tell Dr. Dabirian I am sick today');
  assert.ok(!find(r.events, 'student', 'notify_step'));
  assert.ok(find(r.events, 'student', 'request_sent'));
});
