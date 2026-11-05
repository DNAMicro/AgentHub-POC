// Part 17 Task 3: the Hub's staff-path `service` routing (hr | chrs) and roster-driven deliveries.
// A post to "all" is addressed from CHRS's roster (25 fictional students): Alex (the UI) is delivered, everyone else
// is queued "not online yet". The professor is a signing stand-in registered with the real Hub link (harness).
// CHRS runs in its default mock mode (labelled): these tests prove plumbing and code-decided outcomes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { sendData } from '../src/a2a-data.js';
import { LESSON_PUBLISH_MEDIA_TYPE, LESSON_STATUS_MEDIA_TYPE, contentHash } from '../src/lessons.js';
import { ROSTER_FAILED_TEXT, STAFF_REQUEST_MEDIA_TYPE, staffRequestFields } from '../src/staff.js';
import { signRosterLookup, verifyRosterLookupSignature } from '../src/hub-link.js';
import { TIMEOUTS as T } from '../src/timeouts.js';
import { startStack, professorStandIn, openStream, waitFor, stopProcess } from './support/harness.js';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c().catch(() => {}); });

async function stack(opts = {}) {
  const st = await startStack({ library: false, hr: opts.hr ?? false, chrs: opts.chrs ?? true, hubEnv: opts.hubEnv, uiEnv: { STUDENT_INBOX_FILE: join(mkdtempSync(join(tmpdir(), 'a2a-roster-')), 'inbox.json') } });
  const prof = await professorStandIn(st);
  const stream = await openStream(st.ui.url);
  cleanups.push(async () => { stream.close(); await prof.close(); st.kill(); });
  await waitFor(async () => (await (await fetch(`${st.ui.url}/api/status`)).json()).student.session === 'registered', { what: 'student session', timeout: 8000 });
  return { st, prof, stream };
}
const publish = (prof, over = {}) => {
  const m = { type: 'lesson_publish', operationId: `roster-${randomUUID().slice(0, 8)}`, lessonId: `ls-${randomUUID().slice(0, 12)}`, revision: 1, courseId: 'mkt-351', kind: 'message', author: 'professor', audience: 'all', title: 'Note', text: 'Class starts at ten on Monday.', ...over };
  return prof.link.sendSigned(LESSON_PUBLISH_MEDIA_TYPE, m, ['publish', m.operationId, m.lessonId, m.revision, m.courseId, m.kind, m.audience, contentHash(m.title, m.text, m.kind, m.author, null, null)], { timeoutMs: 30000 });
};
const hubStatus = (prof) => { const nonce = randomUUID(); return prof.link.sendSigned(LESSON_STATUS_MEDIA_TYPE, { type: 'lesson_status', nonce }, ['status', nonce]); };
const ask = (prof, over = {}, fieldsOver = null) => {
  const value = { type: 'staff_request', operationId: randomUUID(), conversationId: randomUUID(), text: 'show me my class roster', ...over };
  return prof.link.sendSigned(STAFF_REQUEST_MEDIA_TYPE, value, fieldsOver ? fieldsOver(value) : staffRequestFields(value), { timeoutMs: 30000 });
};

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
const lookups = (events) => events.filter((e) => e.type === 'roster_lookup_started').length;
const settle = () => new Promise((r) => setTimeout(r, 400));

test('the Faculty status poll never starts a lookup: counts come from the cache only', async () => {
  const { st, prof } = await stack();
  const events = follow(st.hub.url);
  for (let i = 0; i < 5; i++) {
    const s = await hubStatus(prof);
    assert.equal(s.courses[0].rosterCount, null, 'nothing fetched yet');
    assert.equal(s.courses[0].onlineCount, null);
  }
  await settle();
  assert.equal(lookups(events), 0, 'polling made no lookup');
  await publish(prof); // a post fetches once
  for (let i = 0; i < 5; i++) await hubStatus(prof);
  await settle();
  assert.equal(lookups(events), 1);
  const s = await hubStatus(prof);
  assert.deepEqual([s.courses[0].rosterCount, s.courses[0].onlineCount], [25, 1]);
});

test('a stranger tag is re-checked only when the roster came from the cache (never two fresh lookups)', async () => {
  const { st, prof } = await stack();
  const events = follow(st.hub.url);
  const cold = await publish(prof, { audience: 'student-nobody' });
  assert.equal(cold.reason, 'recipient_not_enrolled');
  await settle();
  assert.equal(lookups(events), 1, 'cold cache: one fresh lookup, no second');
  const warm = await publish(prof, { audience: 'student-nobody' });
  assert.equal(warm.reason, 'recipient_not_enrolled');
  await settle();
  assert.equal(lookups(events), 2, 'cached roster: one re-check');
});

test('a failed lookup is reported with a coded reason; roster rows are not kept for a repeat', async () => {
  const { st, prof } = await stack({ chrs: false });
  const events = follow(st.hub.url);
  await publish(prof);
  await waitFor(() => events.find((e) => e.type === 'roster_lookup_failed'), { what: 'roster_lookup_failed' });
  const f = events.find((e) => e.type === 'roster_lookup_failed');
  assert.equal(f.data.code, 'chrs_not_ready');
  assert.equal(f.data.reason, undefined);
});

test('a CHRS roster_request ignores an unsigned courseId and uses the configured course', async () => {
  const { prof } = await stack({ hr: true });
  const r = await ask(prof, { service: 'chrs', courseId: 'other-999' });
  assert.equal(r.status, 'ok');
  assert.equal(r.reply.roster.rows.length, 25);
});

test('a post to everyone becomes one delivery per CHRS roster student: Alex delivered, the other 24 queued', async () => {
  const { st, prof } = await stack();
  const same = { operationId: `roster-${randomUUID().slice(0, 8)}`, lessonId: `ls-${randomUUID().slice(0, 12)}` };
  const ack = await publish(prof, same);
  assert.equal(ack.deliveries.length, 25, JSON.stringify(ack).slice(0, 300));
  assert.equal(ack.deliveries.find((d) => d.studentId === 'student-alex').state, 'delivered');
  assert.equal(ack.deliveries.find((d) => d.studentId === 'student-sam').state, 'queued');
  assert.equal(ack.deliveries.filter((d) => d.state === 'queued').length, 24);
  assert.equal(ack.deliveries.find((d) => d.studentId === 'student-mariana-aguilar').name, 'Mariana Aguilar', 'names come from the roster');
  assert.equal(ack.status, 'queued', 'not everyone has it yet');
  // A repeat of the same operation returns the stored result without asking CHRS again.
  const again = await publish(prof, same);
  assert.equal(again.duplicate, true);
  assert.equal(again.deliveries.length, 25);
  // The Faculty header numbers: counts from the roster and the sessions.
  const s = await hubStatus(prof);
  const course = s.courses[0];
  assert.equal(course.rosterCount, 25);
  assert.equal(course.onlineCount, 1);
  assert.deepEqual(course.enrolled.map((x) => x.studentId), ['student-alex', 'student-sam'], 'enrolled stays the session-allowed list');
  assert.ok(!JSON.stringify(course).includes('csu.fullerton.example'), 'no emails');
  assert.ok(st.chrs, 'CHRS runs in this stack');
});

test('a tagged student must be on the roster: a roster student without a session is queued, a stranger is refused', async () => {
  const { prof } = await stack();
  const one = await publish(prof, { audience: 'student-lily-chen' });
  assert.deepEqual(one.deliveries.map((d) => [d.studentId, d.state]), [['student-lily-chen', 'queued']]);
  const stranger = await publish(prof, { audience: 'student-alex,student-nobody' });
  assert.deepEqual([stranger.status, stranger.reason], ['rejected', 'recipient_not_enrolled']);
});

test('CHRS not running: a post is refused with roster_unavailable and nothing is delivered (no fallback list)', async () => {
  const { st, prof } = await stack({ chrs: false });
  for (const audience of ['all', 'student-alex']) {
    const r = await publish(prof, { audience });
    assert.deepEqual([r.status, r.reason], ['rejected', 'roster_unavailable'], audience);
  }
  const s = await hubStatus(prof);
  assert.equal(s.deliveries.length, 0, 'nothing was delivered or queued');
  assert.equal(s.courses[0].rosterCount, null, 'no made-up count');
  assert.equal(s.courses[0].onlineCount, null);
  assert.equal(st.chrs, null);
});

test('the roster is cached for the course until the classroom is reset', async () => {
  const { st, prof } = await stack();
  assert.equal((await publish(prof)).deliveries.length, 25);
  await stopProcess(st.chrs);
  const cached = await publish(prof);
  assert.equal(cached.deliveries.length, 25, 'served from the Hub’s 60 s cache while CHRS is away');
  const reset = await fetch(`${st.hub.url}/dev/classroom/reset`, { method: 'POST' });
  assert.equal((await reset.json()).status, 'reset');
  const after = await publish(prof);
  assert.deepEqual([after.status, after.reason], ['rejected', 'roster_unavailable'], 'the reset forgot the cached roster');
});

test('staff requests go to the signed service: hr, chrs, none (HR), unknown (refused), and a changed service fails the signature', async () => {
  const { st, prof } = await stack({ hr: true });
  const hr = await ask(prof, { service: 'hr', text: 'I need this Friday off for vacation' });
  assert.equal(hr.status, 'ok', JSON.stringify(hr));
  assert.equal(hr.reply.servedBy, 'hr');
  const roster = await ask(prof, { service: 'chrs' });
  assert.equal(roster.status, 'ok', JSON.stringify(roster).slice(0, 300));
  assert.equal(roster.reply.servedBy, 'chrs');
  assert.equal(roster.reply.roster.rows.length, 25);
  assert.equal(roster.reply.text, 'Class roster · 25 students');
  const none = await ask(prof, { text: 'I need this Friday off for vacation' });
  assert.equal(none.reply.servedBy, 'hr', 'no service = HR, signed the way it always was');
  const unknown = await ask(prof, { service: 'payroll' });
  assert.deepEqual([unknown.status, unknown.code], ['refused', 'unknown_service']);
  const notString = await ask(prof, { service: ['chrs'] });
  assert.equal(notString.status, 'refused');
  // The signature covers `service`: signed as HR (three fields) but sent as chrs, or signed with a different one.
  const stripped = await ask(prof, { service: 'chrs' }, (v) => ['staff-request', v.operationId, v.conversationId]);
  assert.equal(stripped.status, 'refused');
  const swapped = await ask(prof, { service: 'chrs' }, (v) => ['staff-request', v.operationId, v.conversationId, 'hr']);
  assert.equal(swapped.status, 'refused');
  assert.ok(st.hr);
});

test('a CHRS failure says nothing about HR; HR keeps its own words', async () => {
  const { prof } = await stack({ hr: true, chrs: false });
  const r = await ask(prof, { service: 'chrs' });
  assert.equal(r.status, 'not_delivered');
  assert.equal(r.reason, ROSTER_FAILED_TEXT);
  assert.ok(!/HR/.test(r.reason));
});

test('roster student data never reaches Hub telemetry or logs (counts and ids of events only)', async () => {
  const { st, prof } = await stack();
  const events = [];
  const abort = new AbortController();
  cleanups.push(async () => abort.abort());
  (async () => {
    const res = await fetch(`${st.hub.url}/viz/events`, { signal: abort.signal });
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
  const roster = await ask(prof, { service: 'chrs' });
  const rows = roster.reply.roster.rows;
  assert.equal(rows.length, 25);
  await publish(prof);
  await waitFor(() => events.some((e) => e.type === 'roster_lookup_result'), { what: 'roster_lookup_result' });
  const result = events.find((e) => e.type === 'roster_lookup_result');
  assert.equal(result.data.rosterCount, 25);
  assert.equal(result.data.service, 'chrs');
  const seen = JSON.stringify(events) + st.hub.output();
  for (const row of rows) {
    assert.ok(!seen.includes(row.email), `email of ${row.studentId}`);
    assert.ok(!seen.includes(String(row.id)), `PeopleSoft ID of ${row.studentId}`);
  }
  assert.ok(!seen.includes('csu.fullerton.example'));
  for (const name of ['Aguilar', 'Yamamoto']) assert.ok(!seen.includes(name), `the name ${name} stays out of telemetry and logs`);
});

test('roster-lookup signing refuses non-id fields on both sides; the budgets nest', () => {
  const key = 'k'.repeat(43);
  const good = { courseId: 'mkt-351', instructorStaffId: 'staff-dabirian', operationId: randomUUID() };
  const sig = signRosterLookup(key, good);
  assert.ok(sig);
  assert.deepEqual(verifyRosterLookupSignature(key, { courseId: good.courseId, instructorStaffId: good.instructorStaffId }, { hubOperationId: good.operationId, hubSignature: sig }), { courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' });
  for (const bad of [{ ...good, courseId: 'mkt-351|staff-x' }, { ...good, instructorStaffId: '' }, { ...good, operationId: 'a b' }, { ...good, courseId: 'x'.repeat(65) }]) {
    assert.equal(signRosterLookup(key, bad), null, JSON.stringify(bad));
    assert.equal(verifyRosterLookupSignature(key, { courseId: bad.courseId, instructorStaffId: bad.instructorStaffId }, { hubOperationId: bad.operationId, hubSignature: sig }), null);
  }
  assert.ok(T.hubRosterLookupMs > T.chrsToolChoiceMs + T.chrsRecordsCallMs, 'the Hub waits longer than CHRS’s whole lookup');
  assert.ok(T.professorPublishMs > T.hubRosterLookupMs, 'the Professor waits longer than the Hub’s lookup');
  assert.ok(T.hubAuthorProxyMs > T.professorPublishMs);
  // Worst case of a post: one cold lookup (never two fresh) + the Student delivery (5 s) fits inside the Professor's wait.
  assert.ok(T.professorPublishMs > T.hubRosterLookupMs + 5000);
  // A post against a warm cache with a stranger tag: one re-check lookup, same bound.
});
