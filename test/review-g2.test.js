// Review group G2: honest delivery counts (A4), the email fallback through CHRS (C16), a fresh roster on every send
// (C13), the class's time and room (C12), and the faculty member's note on a cancellation (A5 — its chat flows live in
// test/professor-staff.test.js next to the other cancellation tests).
// CHRS, the Campus Solutions stand-in and the campus mail stand-in run in their mock modes (labelled): these tests prove
// plumbing and code-decided outcomes. No real email is ever sent (the mail stand-in is an in-memory outbox).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { deliveredText, deliveryCounts } from '../src/delivery-text.js';
import { cancelNoteOf, cancellationLead, cancellationText, classDetailsOf } from '../src/professor-staff.js';
import { emailContentHash, signEmailNotice, signRosterLookup, verifyEmailNoticeSignature, signStaff } from '../src/hub-link.js';
import { createRosterClient } from '../src/hub-roster.js';
import { topologyLabel } from '../src/topology.js';
import { createStudentRecordsStore } from '../src/student-records-store.js';
import { LESSON_PUBLISH_MEDIA_TYPE, LESSON_STATUS_MEDIA_TYPE, contentHash } from '../src/lessons.js';
import { TIMEOUTS as T } from '../src/timeouts.js';
import { startStack, professorStandIn, openStream, waitFor, post, sendCard, stopProcess } from './support/harness.js';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c().catch(() => {}); });

// ---- A4: the confirmation sentence (unit) ------------------------------------------------------------------------
const d = (state, extra = {}) => ({ studentId: `student-${randomUUID().slice(0, 6)}`, state, ...extra });
const many = (n, state, extra) => Array.from({ length: n }, () => d(state, extra));

test('A4: the whole class — 1 in the app, 24 emailed', () => {
  assert.equal(deliveredText([d('delivered'), ...many(24, 'queued', { emailed: true })]), "25 students notified.");
});
test('A4: everyone online / everyone emailed / an opened one counts as in the app', () => {
  assert.equal(deliveredText(many(3, 'delivered')), '3 students notified.');
  assert.equal(deliveredText(many(25, 'queued', { emailed: true })), "25 students notified.");
  assert.equal(deliveredText([d('delivered', { opened: true }), d('queued', { emailed: true })]), "2 students notified.");
});
test('A4: the email failed too — said plainly, last', () => {
  assert.equal(deliveredText([d('delivered'), ...many(24, 'queued', { emailFailed: true })]), "1 student notified. 24 students aren't online and will be notified when they are.");
  assert.equal(deliveredText(many(2, 'queued')), "2 students aren't online and will be notified when they are.");
  assert.equal(deliveredText([d('delivered'), ...many(20, 'queued', { emailed: true }), ...many(4, 'queued', { emailFailed: true })]), "21 students notified. 4 students aren't online and will be notified when they are.");
});
test('A4: one student — stored without a name, each outcome in plain words', () => {
  const one = (x) => deliveredText([x], { audience: x.studentId });
  assert.equal(one(d('delivered')), '1 student notified.');
  assert.equal(one(d('queued', { emailed: true })), "1 student notified.");
  assert.equal(one(d('queued', { emailFailed: true })), "1 student isn't online and will be notified when they are.");
  assert.equal(one(d('uncertain')), "1 student is still being notified.");
  assert.equal(one(d('failed')), "1 student couldn't be notified.");
});
test('A4: several tagged students, uncertain and failed rows, and nothing to count', () => {
  assert.equal(deliveredText([d('delivered'), d('queued', { emailed: true })], { audience: 'student-a,student-b' }), "2 students notified.");
  assert.equal(deliveredText([d('delivered'), d('uncertain'), d('failed')]), "1 student notified. 1 student is still being notified. 1 student couldn't be notified.");
  assert.equal(deliveredText([]), null, 'no ack deliveries: no claim at all');
  assert.equal(deliveredText(undefined), null);
  assert.deepEqual(deliveryCounts([d('delivered'), d('queued', { emailed: true }), d('queued')]), { total: 3, app: 1, emailed: 1, waiting: 1, failed: 0, sending: 0 });
});
test('A4: never a bare "Sent" and never a system name', () => {
  const texts = [deliveredText([d('delivered'), ...many(24, 'queued', { emailed: true })]), deliveredText([d('queued')], { audience: 'x' })];
  for (const t of texts) {
    assert.match(t, /^\d+ students? /);
    assert.doesNotMatch(t, /CHRS|Hub|MCP|agent|PeopleSoft|AI\b/);
  }
});

// ---- C12: time and room (unit) ---------------------------------------------------------------------------------------
test('C12: the class record reads as "10:00–11:15 AM, Mihaylo Hall 2405" (review #10: Tue & Thu); placeholders and odd times are no detail', () => {
  const klass = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.class;
  assert.equal(klass.room, 'Mihaylo Hall 2405');
  assert.equal(klass.daysAndTimes, 'TuTh 10:00AM - 11:15AM');
  assert.deepEqual(classDetailsOf(klass), { time: '10:00–11:15 AM', room: 'Mihaylo Hall 2405' });
  assert.deepEqual(classDetailsOf({ daysAndTimes: 'TuTh 11:30AM - 12:45PM', room: 'Steven G. Mihaylo Hall 1101' }), { time: '11:30 AM–12:45 PM', room: 'Steven G. Mihaylo Hall 1101' });
  for (const bad of [{ daysAndTimes: 'MoTuWeThFr 10:00AM - 10:50AM', room: 'Mihaylo Hall 1xxx' }, { daysAndTimes: 'TBA', room: 'Mihaylo Hall 2405' }, { daysAndTimes: 'MoWe 9:00AM - 9:50AM', room: '' }, null, {}]) assert.equal(classDetailsOf(bad), null, JSON.stringify(bad));
});
test('C12 + A5: the offer and the notice carry time and room; a note is its own paragraph; dates only, never a reason', () => {
  const info = { time: '10:00–11:15 AM', room: 'Mihaylo Hall 2405' };
  assert.equal(cancellationLead(['2026-11-10', '2026-11-12'], info), "You have Marketing 351 (10:00–11:15 AM, Mihaylo Hall 2405) on Tue, Nov 10 and Thu, Nov 12. Here's the cancellation your students would get — check it before you send it.");
  assert.equal(cancellationText(['2026-11-10', '2026-11-12'], info), 'Marketing 351 (10:00–11:15 AM, Mihaylo Hall 2405) is cancelled on Tue, Nov 10 and Thu, Nov 12.');
  assert.equal(cancellationText(['2026-11-12'], info, "We'll make it up on Friday in the review session."), "Marketing 351 (10:00–11:15 AM, Mihaylo Hall 2405) is cancelled on Thu, Nov 12.\n\nFrom Dr. Dabirian: We'll make it up on Friday in the review session.");
  assert.equal(cancellationLead(['2026-11-12'], null), "You have Marketing 351 on Thu, Nov 12. Here's the cancellation your students would get — check it before you send it.", 'no class info: the course only, never a guess');
  assert.equal(cancellationText([], info), null);
});

// ---- A5: the note after "yes" (unit) ----------------------------------------------------------------------------------
test('A5: a plain yes (with filler) has no note', () => {
  for (const t of ['yes', 'Yes!', 'yes notify students', 'yes please send it', 'ok go ahead', 'sure, send the cancellation', 'yes, tell them', 'yes thanks']) assert.equal(cancelNoteOf(t), null, t);
});
test('A5: yes + a note of 3+ words → the note, tidied', () => {
  assert.equal(cancelNoteOf("yes, we'll make it up on Friday in the review session"), "We'll make it up on Friday in the review session.");
  assert.equal(cancelNoteOf('sure, tell them to read chapter 6'), 'Please read chapter 6.');
  assert.equal(cancelNoteOf('yes and add: makeup session Friday at 10'), 'Makeup session Friday at 10.');
  assert.equal(cancelNoteOf('Yes, notify everyone that the quiz moves to Monday!'), 'The quiz moves to Monday!');
  assert.equal(cancelNoteOf('ok, note: "Review slides 4-9 at home."'), 'Review slides 4-9 at home.');
  assert.equal(cancelNoteOf('yes say we meet online instead'), 'We meet online instead.');
});
test('A5: a change, a refusal or too few words is not a note', () => {
  for (const t of ['yes but change Tuesday to Wednesday', 'yes, not Friday though', 'yes, actually make it Monday', 'yes see you', 'yes to HR please', 'yes, but only Thursday']) assert.equal(cancelNoteOf(t), null, t);
  assert.equal(cancelNoteOf("We'll meet on Zoom instead.", { needYes: false }), "We'll meet on Zoom instead.", 'after the leave question a new note needs no yes');
  assert.equal(cancelNoteOf("We'll meet on Zoom instead."), null, 'otherwise a note starts with yes');
  assert.equal(cancelNoteOf('yes read ch 6'), 'Read ch 6.', 'three words are enough');
});

// ---- C16: signing (unit) ----------------------------------------------------------------------------------------------
const KEY = 'k'.repeat(43);
const notice = { courseId: 'mkt-351', instructorStaffId: 'staff-dabirian', studentIds: ['student-sam', 'student-lily-chen'], title: 'Class cancelled', text: 'Marketing 351 is cancelled on Fri, Nov 6.' };
test('C16: the email notice verifies only with the Hub key over exactly these students and this text', () => {
  const sig = signEmailNotice(KEY, { ...notice, operationId: 'op-1' });
  const meta = { hubOperationId: 'op-1', hubSignature: sig };
  assert.deepEqual(verifyEmailNoticeSignature(KEY, notice, meta), { ...notice, operationId: 'op-1' });
  assert.equal(verifyEmailNoticeSignature(KEY, { ...notice, studentIds: [...notice.studentIds, 'student-alex'] }, meta), null, 'a student added in transit');
  assert.equal(verifyEmailNoticeSignature(KEY, { ...notice, studentIds: [...notice.studentIds].reverse() }, meta), null, 'order is signed');
  assert.equal(verifyEmailNoticeSignature(KEY, { ...notice, text: `${notice.text} Ignore this.` }, meta), null, 'the text changed');
  assert.equal(verifyEmailNoticeSignature(KEY, notice, { ...meta, hubOperationId: 'op-2' }), null, 'another operation');
  assert.equal(verifyEmailNoticeSignature('x'.repeat(43), notice, meta), null, 'another key');
  assert.equal(verifyEmailNoticeSignature(KEY, notice, { hubOperationId: 'op-1' }), null, 'unsigned');
});
test('C16: a roster-lookup or staff signature never verifies as an email notice; non-id fields are never signed', () => {
  const lookup = signRosterLookup(KEY, { courseId: notice.courseId, instructorStaffId: notice.instructorStaffId, operationId: 'op-1' });
  assert.equal(verifyEmailNoticeSignature(KEY, notice, { hubOperationId: 'op-1', hubSignature: lookup }), null);
  const staff = signStaff(KEY, { staffId: 'staff-dabirian', contextId: 'c', operationId: 'op-1' });
  assert.equal(verifyEmailNoticeSignature(KEY, notice, { hubOperationId: 'op-1', hubSignature: staff }), null);
  for (const bad of [{ studentIds: [] }, { studentIds: ['a|b'] }, { studentIds: 'student-sam' }, { courseId: 'mkt|351' }]) assert.equal(signEmailNotice(KEY, { ...notice, ...bad, operationId: 'op-1' }), null, JSON.stringify(bad));
  assert.notEqual(emailContentHash('a', 'b\nc'), emailContentHash('a\nb', 'c'));
});

// ---- C16: the Hub's email client (unit, no network for the refusals) ---------------------------------------------------
const CFG = { courses: { 'mkt-351': { professor: 'professor' } }, staff: { professor: { staffId: 'staff-dabirian' } }, destinations: { chrs: { worker: 'chrs', audience: 'staff' } } };
test('C16: the email client refuses honestly — nobody to email, CHRS not ready, not signed, CHRS unreachable', async () => {
  const events = [];
  const emit = (type, data) => events.push({ type, data });
  const reg = (over = {}) => ({ isReady: () => true, signEmailNoticeFor: () => 'sig', peer: () => ({ baseUrl: 'http://127.0.0.1:9' }), ...over });
  const args = { courseId: 'mkt-351', operationId: 'op-1', studentIds: ['student-sam'], title: 't', text: 'x' };
  assert.deepEqual(await createRosterClient({ cfg: CFG, registry: reg(), emit }).email({ ...args, studentIds: [] }), { ok: true, results: {} });
  assert.deepEqual(await createRosterClient({ cfg: CFG, registry: reg({ isReady: () => false }), emit }).email(args), { ok: false, reason: 'chrs_not_ready' });
  assert.deepEqual(await createRosterClient({ cfg: CFG, registry: reg({ signEmailNoticeFor: () => null }), emit }).email(args), { ok: false, reason: 'not_signed' });
  assert.deepEqual(await createRosterClient({ cfg: { ...CFG, destinations: {} }, registry: reg(), emit }).email(args), { ok: false, reason: 'not_configured' });
  const down = await createRosterClient({ cfg: CFG, registry: reg(), emit, emailTimeoutMs: 2000 }).email(args);
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'not_delivered');
  assert.deepEqual(events.map((e) => e.type), ['email_fallback_failed', 'email_fallback_failed', 'email_fallback_failed', 'email_fallback_started', 'email_fallback_failed']);
  assert.ok(events.every((e) => !JSON.stringify(e).includes('student-sam')), 'events carry counts, not who');
});

// ---- Topology labels (unit) ------------------------------------------------------------------------------------------
test('labels: the email fallback on the Hub–CHRS edge (counts only), Canvas course size, the C15 comparison', () => {
  const hub = (type, data) => topologyLabel({ source: 'hub', type, data });
  assert.deepEqual([hub('email_fallback_started', { recipients: 24 }).edge, hub('email_fallback_started', { recipients: 24 }).label], ['hub-chrs', "Hub asked Campus Agent to email 24 students who aren't online"]);
  assert.equal(hub('email_fallback_started', { recipients: 1 }).label, "Hub asked Campus Agent to email 1 student who isn't online");
  const sent = hub('email_fallback_sent', { emailedCount: 24, emailFailedCount: 0 });
  assert.deepEqual([sent.from, sent.to, sent.phase, sent.label], ['chrs', 'hub', 'completed', 'Campus Agent emailed 24 students']);
  assert.equal(hub('email_fallback_sent', { emailedCount: 1, emailFailedCount: 2 }).label, "Campus Agent emailed 1 student (2 couldn't be emailed)");
  assert.equal(hub('email_fallback_sent', { emailedCount: 0, emailFailedCount: 2 }).phase, 'failed');
  assert.equal(hub('email_fallback_failed', { code: 'chrs_not_ready' }).edge, null, 'not sent: stays inside the Hub');
  assert.equal(hub('email_fallback_failed', { code: 'uncertain' }).phase, 'unknown');
  const canvas = topologyLabel({ source: 'professor', type: 'mcp_call_result', data: { tool: 'list_course_students', ok: true, canvasCount: 24 } });
  assert.equal(canvas.label, 'Canvas: 24 students in the course');
  assert.equal(topologyLabel({ source: 'professor', type: 'mcp_call_result', data: { tool: 'publish_quiz', ok: true, quizId: 4821 } }).label, 'Published quiz #4821');
  const prof = (data) => topologyLabel({ source: 'professor', type: 'quiz_membership', data });
  assert.equal(prof({ status: 'ok', missingCount: 1, extraCount: 0 }).label, 'Canvas vs roster: 1 missing, 0 extra');
  assert.equal(prof({ status: 'ok', missingCount: 0, extraCount: 0 }).label, 'Canvas matches the class roster');
  assert.equal(prof({ status: 'failed' }).phase, 'failed');
  assert.equal(topologyLabel({ source: 'chrs', type: 'email_notice_sent', data: { emailedCount: 3, emailFailedCount: 1 } }).label, 'Campus mail stand-in: 3 emailed, 1 failed');
  // A staff reply CHRS served (a roster request, the class's time and room) is named for CHRS, not HR.
  assert.equal(hub('relay_sent', { kind: 'staff_reply', to: 'professor', status: 'ok', servedBy: 'chrs' }).label, 'Hub relayed Campus Agent’s reply (ok)');
  assert.equal(hub('relay_sent', { kind: 'staff_reply', to: 'professor', status: 'ok', servedBy: 'hr' }).label, 'Hub relayed HR’s reply (ok)');
});

test('budgets: the email notice and the class info nest inside the publish and the author proxy', () => {
  assert.ok(T.hubEmailNoticeMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs);
  assert.ok(T.professorPublishMs > T.hubRosterLookupMs + 5000 + T.hubEmailNoticeMs);
  assert.ok(T.hubAuthorProxyMs > T.professorStaffClassifierMs + T.professorModelMs + T.professorPublishMs);
  assert.ok(T.hubAuthorProxyMs > T.professorStaffMs + T.professorClassInfoMs, 'a Submit that offers a cancellation reads the class info too');
  assert.ok(T.uiProfessorCallMs > T.hubAuthorProxyMs);
});

// ---- Hub-level end to end (a signing Faculty stand-in) ------------------------------------------------------------------
async function hubStack({ chrsEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-g2-'));
  const lessonFile = join(dir, 'hub-lessons.json');
  const st = await startStack({ library: false, chrs: true, chrsEnv, hubEnv: { HUB_LESSON_FILE: lessonFile }, uiEnv: { STUDENT_INBOX_FILE: join(dir, 'inbox.json') } });
  const prof = await professorStandIn(st);
  const stream = await openStream(st.ui.url);
  cleanups.push(async () => { stream.close(); await prof.close(); st.kill(); });
  await waitFor(async () => (await (await fetch(`${st.ui.url}/api/status`)).json()).student.session === 'registered', { what: 'student session', timeout: 8000 });
  const events = follow(st.hub.url);
  return { st, prof, events, lessonFile };
}
function follow(hubUrl) {
  const events = [];
  const abort = new AbortController();
  cleanups.push(async () => abort.abort());
  (async () => {
    const res = await fetch(`${hubUrl}/viz/events`, { signal: abort.signal });
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
  return events;
}
const publish = (prof, over = {}) => {
  const m = { type: 'lesson_publish', operationId: `g2-${randomUUID().slice(0, 8)}`, lessonId: `ls-${randomUUID().slice(0, 12)}`, revision: 1, courseId: 'mkt-351', kind: 'message', author: 'professor', audience: 'all', title: 'Note', text: 'Class starts at ten on Monday.', ...over };
  return prof.link.sendSigned(LESSON_PUBLISH_MEDIA_TYPE, m, ['publish', m.operationId, m.lessonId, m.revision, m.courseId, m.kind, m.audience, contentHash(m.title, m.text, m.kind, m.author, null, null)], { timeoutMs: 40000 });
};
const hubStatus = (prof) => { const nonce = randomUUID(); return prof.link.sendSigned(LESSON_STATUS_MEDIA_TYPE, { type: 'lesson_status', nonce }, ['status', nonce]); };
const mailOf = async (st) => (await (await fetch(`${st.chrs.url}/test/mail`)).json()).mail;
const enroll = (st, dropped) => post(`${st.studentRecords.url}/test/enrollment`, { dropped });
const count = (events, type) => events.filter((e) => e.type === type).length;
const settle = () => new Promise((r) => setTimeout(r, 400));

test('C16: a post to the class — the 24 offline students are emailed (flags on their deliveries), Alex is not', async () => {
  const { st, prof, events } = await hubStack();
  const ack = await publish(prof, { title: 'Reading', text: 'Read chapter 6 before Monday.' });
  assert.equal(ack.deliveries.length, 25);
  const alex = ack.deliveries.find((x) => x.studentId === 'student-alex');
  assert.deepEqual([alex.state, alex.emailed ?? false], ['delivered', false], 'online in the app: no email');
  const offline = ack.deliveries.filter((x) => x.studentId !== 'student-alex');
  assert.ok(offline.every((x) => x.state === 'queued' && x.emailed === true), 'still queued for the app, and emailed');
  const mail = await mailOf(st);
  assert.equal(mail.length, 24);
  assert.ok(!mail.some((m) => m.studentId === 'student-alex'));
  const sam = mail.find((m) => m.studentId === 'student-sam');
  assert.equal(sam.to, 'sstudent@csu.fullerton.example', 'the address on file in Campus Solutions');
  assert.equal(sam.subject, 'MKTG 351: Reading');
  assert.match(sam.body, /^Read chapter 6 before Monday\.\n\nDr\. Dabirian, MKTG 351 - 01\n/);
  await waitFor(() => events.find((e) => e.type === 'email_fallback_sent'), { what: 'email_fallback_sent' });
  assert.deepEqual([events.find((e) => e.type === 'email_fallback_sent').data.emailedCount, events.find((e) => e.type === 'email_fallback_sent').data.emailFailedCount], [24, 0]);
  // The Faculty status view carries the flags (ids and flags only).
  const s = await hubStatus(prof);
  assert.equal(s.deliveries.filter((x) => x.emailed).length, 24);
});

test('C16: a re-publish (same operation) and a repeat at CHRS never email twice; a new post emails again', async () => {
  const { st, prof } = await hubStack();
  const same = { operationId: `g2-${randomUUID().slice(0, 8)}`, lessonId: `ls-${randomUUID().slice(0, 12)}` };
  await publish(prof, same);
  const again = await publish(prof, same);
  assert.equal(again.duplicate, true);
  assert.equal(again.deliveries.filter((x) => x.emailed).length, 24, 'the stored flags');
  assert.equal((await mailOf(st)).length, 24, 'no second email');
  await publish(prof, { audience: 'student-sam' });
  const mail = await mailOf(st);
  assert.equal(mail.length, 25, 'a different post is a new email');
  assert.equal(mail.filter((m) => m.studentId === 'student-sam').length, 2);
});

test('C16: a single offline student is emailed; a single online student is not', async () => {
  const { st, prof } = await hubStack();
  const sam = await publish(prof, { audience: 'student-sam' });
  assert.deepEqual(sam.deliveries.map((x) => [x.studentId, x.state, Boolean(x.emailed)]), [['student-sam', 'queued', true]]);
  const alex = await publish(prof, { audience: 'student-alex' });
  assert.deepEqual(alex.deliveries.map((x) => [x.studentId, x.state, Boolean(x.emailed)]), [['student-alex', 'delivered', false]]);
  assert.deepEqual((await mailOf(st)).map((m) => m.studentId), ['student-sam']);
});

test('C16: when the email can\'t be sent the delivery stays queued with emailFailed (no retry, nothing invented)', async () => {
  const { st, prof, events } = await hubStack({ chrsEnv: { CHRS_TEST_MAIL_FAIL: 'student-sam,student-lily-chen' } });
  const ack = await publish(prof);
  const sam = ack.deliveries.find((x) => x.studentId === 'student-sam');
  assert.deepEqual([sam.state, sam.emailed ?? false, sam.emailFailed], ['queued', false, true]);
  assert.equal(ack.deliveries.filter((x) => x.emailed).length, 22);
  assert.equal(ack.deliveries.filter((x) => x.emailFailed).length, 2);
  assert.equal((await mailOf(st)).length, 22);
  await waitFor(() => events.find((e) => e.type === 'email_fallback_sent'), { what: 'email result' });
  assert.equal(events.find((e) => e.type === 'email_fallback_sent').data.emailFailedCount, 2);
});

test('C16: CHRS refuses an unsigned or student-signed email notice; a signed one from the Hub only', async () => {
  const { st } = await hubStack();
  const { sendData } = await import('../src/a2a-data.js');
  const { EMAIL_NOTICE_MEDIA_TYPE } = await import('../src/staff.js');
  const value = { type: 'email_notice', courseId: 'mkt-351', instructorStaffId: 'staff-dabirian', studentIds: ['student-sam'], title: 'Hi', text: 'Hello.' };
  for (const metadata of [{}, { hubOperationId: 'op-1' }, { hubOperationId: 'op-1', hubSignature: 'forged' }, { hubOperationId: 'op-1', hubSignature: signEmailNotice('z'.repeat(43), { ...value, operationId: 'op-1' }) }]) {
    const r = await sendData(st.chrs.url.replace(/\/$/, ''), { mediaType: EMAIL_NOTICE_MEDIA_TYPE, value, metadata, timeoutMs: 5000 });
    assert.equal(r.value?.error, 'refused', JSON.stringify(metadata));
  }
  assert.equal((await mailOf(st)).length, 0, 'nothing was "sent"');
});

test('C16: no email address reaches the Hub — not its events, logs, ack, status or lessons file', async () => {
  const { st, prof, events, lessonFile } = await hubStack();
  const ack = await publish(prof);
  const status = await hubStatus(prof);
  await waitFor(() => events.find((e) => e.type === 'email_fallback_sent'), { what: 'email_fallback_sent' });
  await settle();
  const seen = JSON.stringify(events) + st.hub.output() + JSON.stringify(ack) + JSON.stringify(status) + readFileSync(lessonFile, 'utf8');
  assert.ok(!seen.includes('csu.fullerton.example'), 'no address anywhere at the Hub');
  assert.ok(!/888\d{6}/.test(seen), 'no campus ID');
  assert.ok(!st.chrs.output().includes('csu.fullerton.example'), 'CHRS never logs an address');
  assert.match(st.chrs.output(), /campus mail: demo stand-in/);
  assert.ok(readFileSync(lessonFile, 'utf8').includes('"emailed": true') || readFileSync(lessonFile, 'utf8').includes('"emailed":true'), 'the flag is on the delivery record');
});

test('C16: New conversation clears the campus mail stand-in; the next post emails again', async () => {
  const { st, prof } = await hubStack();
  await publish(prof);
  assert.equal((await mailOf(st)).length, 24);
  const r = await (await post(`${st.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(r.chrs, 'reset');
  assert.equal((await mailOf(st)).length, 0);
  await publish(prof, { audience: 'student-sam' });
  assert.equal((await mailOf(st)).length, 1);
});

test('C13: two sends in a row each look the roster up; the 3 s status poll never does', async () => {
  const { prof, events } = await hubStack();
  await publish(prof);
  await publish(prof, { audience: 'student-sam' });
  await settle();
  assert.equal(count(events, 'roster_lookup_started'), 2, 'one fresh lookup per send');
  for (let i = 0; i < 6; i++) await hubStatus(prof);
  await settle();
  assert.equal(count(events, 'roster_lookup_started'), 2, 'polling made no lookup');
  assert.equal((await hubStatus(prof)).courses[0].rosterCount, 25, 'the header reads the last result');
});

test('C13: a student dropped between two sends is not addressed (nor emailed); added back, they are', async () => {
  const { st, prof } = await hubStack();
  assert.equal((await publish(prof)).deliveries.length, 25);
  assert.equal((await (await enroll(st, ['student-lily-chen', 'student-omar-hassan'])).json()).rosterRows, 23);
  const after = await publish(prof);
  assert.equal(after.deliveries.length, 23, 'the second send read the roster again');
  assert.ok(!after.deliveries.some((x) => x.studentId === 'student-lily-chen'));
  assert.equal((await mailOf(st)).filter((m) => m.studentId === 'student-lily-chen').length, 1, 'only the first post emailed them');
  const dropped = await publish(prof, { audience: 'student-lily-chen' });
  assert.deepEqual([dropped.status, dropped.reason], ['rejected', 'recipient_not_enrolled']);
  await enroll(st, []);
  assert.equal((await publish(prof)).deliveries.length, 25, 'added back: on the next send');
  assert.equal((await publish(prof, { audience: 'student-lily-chen' })).deliveries.length, 1);
});

test('C13 + C16: one post reads Campus Solutions twice — the roster lookup, then the email read (both fresh)', async () => {
  const { st, prof } = await hubStack();
  await publish(prof);
  const out = st.studentRecords.output();
  assert.equal((out.match(/roster courseId=mkt-351 rows=25/g) ?? []).length, 2, 'the lookup and the email each read the records');
});

test('C16 + C13: CHRS down — the post is refused (roster_unavailable): nobody is emailed or queued', async () => {
  const { st, prof } = await hubStack();
  await stopProcess(st.chrs);
  const r = await publish(prof);
  assert.deepEqual([r.status, r.reason], ['rejected', 'roster_unavailable']);
  assert.equal((await hubStatus(prof)).deliveries.length, 0);
});

// ---- A4 end to end: the Faculty chat's confirmations on a real stack (mock Faculty, labelled) ----------------------------
async function facultyStack(chrsEnv = {}) {
  const st = await startStack({ library: false, professor: true, chrsEnv, hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' } });
  cleanups.push(async () => st.kill());
  await waitFor(async () => (await (await fetch(`${st.ui.url}/api/status`)).json()).student.session === 'registered', { what: 'student session', timeout: 8000 });
  const say = async (text) => sendCard(st.ui.url, await (await post(`${st.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text })).json()); // review E: Send on the preview card
  const confirmations = async () => (await (await fetch(`${st.ui.url}/api/professor/state`)).json()).chat.filter((m) => m.role === 'assistant' && m.action === 'sent');
  return { st, say, confirmations };
}

test('A4 + C16: every send path states the real counts — email failed for some students (plain, notify, one student, @assistant)', async () => {
  const fail = ['student-sam', 'student-lily-chen', 'student-omar-hassan'].join(',');
  const { say, confirmations } = await facultyStack({ CHRS_TEST_MAIL_FAIL: fail });
  const expectClass = "22 students notified. 3 students aren't online and will be notified when they are.";
  assert.equal((await say('Please bring your laptops to class tomorrow.')).action, 'post');
  assert.equal((await confirmations()).at(-1).text, expectClass, 'a plain class post');
  await say('Notify everyone that the review session moves to Room 110.');
  assert.equal((await confirmations()).at(-1).text, expectClass, 'notify everyone');
  const toSam = await say('@sam your draft is due Monday.');
  assert.equal(toSam.action, 'post', JSON.stringify(toSam));
  const sam = (await confirmations()).at(-1);
  assert.deepEqual([sam.text, sam.sentTo], ["1 student isn't online and will be notified when they are.", 'student-sam']);
  await say('@mariana your draft is due Monday.');
  assert.equal((await confirmations()).at(-1).text, "1 student notified.");
  await say('@alex nice work today.');
  assert.equal((await confirmations()).at(-1).text, '1 student notified.');
  await say('@assistant send the Evidence before assumptions lesson to the class');
  assert.equal((await confirmations()).at(-1).text, expectClass, 'an @assistant post');
  const all = await confirmations();
  assert.equal(all.length, 6, 'one confirmation per post');
  assert.ok(all.every((m) => !/Student|Aguilar|@|csu\.fullerton/.test(m.text)), 'the stored text names nobody and no address');
});

// ---- C12 end to end: the class info can't be read → no guessed details, nothing sent, the offer waits ---------------------
test('C12: CHRS away — the offer names the course only; “yes” is refused like an unavailable class list and the offer waits', async () => {
  const st = await startStack({ library: false, professor: true, hr: true, hrEnv: { HR_TEST_HOOKS: '1' }, hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' } });
  cleanups.push(async () => st.kill());
  const say = async (text) => sendCard(st.ui.url, await (await post(`${st.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text })).json()); // review E: Send on the preview card
  const state = async () => (await fetch(`${st.ui.url}/api/professor/state`)).json();
  assert.equal((await say("I'm sick, cancel Friday's class")).reply, 'Should I file this as time off with HR, tell the class, or both?');
  await say('both');
  const card = (await state()).hrCard;
  await stopProcess(st.chrs);
  const surfaceId = card.a2ui.find((m) => m.createSurface).createSurface.surfaceId;
  const action = { name: 'submitTimeOff', surfaceId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { note: '', absenceType: ['SCK'], absenceReason: ['SCK'], beginDate: '2026-11-05', endDate: '2026-11-05', hours: '8' } };
  const done = await (await post(`${st.professor.url}/author/hr-action`, { operationId: `op-${randomUUID()}`, formRef: card.formRef, action })).json();
  assert.equal(done.status, 'accepted', JSON.stringify(done));
  const offer = (await state()).chat.filter((m) => m.role === 'assistant').at(-1).text;
  assert.equal(offer, "You have Marketing 351 on Thu, Nov 5. Here's the cancellation your students would get — check it before you send it.", 'no guessed time or room');
  const cc = (await state()).cancelCard;
  assert.equal(cc.text, 'Marketing 351 is cancelled on Thu, Nov 5.', 'the preview names the course only');
  assert.equal(cc.count, null, 'no class size read: the card says “your class roster”');
  const yes = await say('yes');
  assert.equal(yes.reply, "I couldn't get your class list just now, so nothing was sent. Try again in a moment.");
  assert.equal((await state()).lessons.length, 0, 'nothing sent without the class details');
  assert.equal((await say('no')).reply, 'Okay, I won’t send a cancellation. Your class is still on for your students.', 'the offer was waiting again');
});

// ---- C13 at the Faculty level: “notify everyone” and a cancellation each read the roster when they happen -------------------
test('C13: a student dropped between two “notify everyone” sends is not addressed; the header count follows', async () => {
  const { st, say } = await facultyStack();
  const events = follow(st.hub.url);
  await say('Notify everyone that the review session is in Room 110.');
  let s = await (await fetch(`${st.ui.url}/api/professor/state`)).json();
  assert.equal(s.lessons[0].deliveries.length, 25);
  await enroll(st, ['student-noah-walker']);
  await say('Notify everyone that the review session starts at 3 PM.');
  s = await (await fetch(`${st.ui.url}/api/professor/state`)).json();
  const newest = s.lessons.find((l) => /3 PM/.test(l.text));
  assert.equal(newest.deliveries.length, 24, 'read fresh: the dropped student is not addressed');
  assert.ok(!newest.deliveries.some((x) => x.studentId === 'student-noah-walker'));
  const said = s.chat.filter((m) => m.action === 'sent').at(-1).text;
  assert.equal(said, "24 students notified.");
  await settle();
  assert.ok(events.filter((e) => e.type === 'roster_lookup_started').length >= 1, 'the Hub looked the roster up for the send');
});
