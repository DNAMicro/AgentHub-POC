// Part 17 Task 2: CHRS (staff only) answers two typed data parts from the Hub and reaches the student-records stand-in
// over MCP. The Hub is a stand-in here (it only learns CHRS's key at registration) so the test signs exactly what the
// real Hub would. CHRS runs in mock mode (the moment's own tool) except in the wrong-pick and choice-failed tests, where
// it is live against the fake Anthropic API (never a real key, never the network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { sendData } from '../src/a2a-data.js';
import { signRosterLookup, signStaff } from '../src/hub-link.js';
import { ROSTER_LOOKUP_MEDIA_TYPE, ROSTER_REQUEST_MEDIA_TYPE, ROSTER_FAILED_TEXT } from '../src/staff.js';
import { startChrs, startStudentRecords, standInHub, waitFor } from './support/harness.js';
import { startFakeAnthropic, messageReply, rosterToolReply } from './support/fake-anthropic.js';

const REFUSED = 'CHRS serves university staff only.';
const FAILED = 'I couldn\'t get your class roster just now. Try again in a moment.';

function follow(url) {
  const events = [];
  const abort = new AbortController();
  (async () => {
    const res = await fetch(`${url}/viz/events`, { signal: abort.signal });
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
  return { events, close: () => abort.abort() };
}

// CHRS + (optionally) the real records stand-in + a stand-in Hub, with helpers that sign like the Hub.
async function setup(t, { records = true, chrsEnv = {}, recordsEnv = {} } = {}) {
  const hub = await standInHub();
  t.after(() => hub.close());
  const token = randomUUID();
  const sr = records ? await startStudentRecords({ STUDENT_RECORDS_TOKEN: token, STUDENT_RECORDS_TEST_HOOKS: '1', ...recordsEnv }) : null;
  if (sr) t.after(() => sr.proc.kill());
  const chrs = await startChrs({ HUB_URL: hub.url, HEARTBEAT_INTERVAL_MS: '500', ...(sr ? { STUDENT_RECORDS_URL: sr.url, STUDENT_RECORDS_TOKEN: token } : {}), ...chrsEnv });
  t.after(() => chrs.proc.kill());
  await waitFor(() => hub.keyOf('chrs'), { what: 'CHRS registered' });
  const feed = follow(chrs.url);
  t.after(() => feed.close());
  const key = hub.keyOf('chrs');
  const staffMeta = (staffId = 'staff-dabirian', contextId, operationId = randomUUID()) => ({ staffId, hubOperationId: operationId, callerKind: 'staff', hubSignature: signStaff(key, { staffId, contextId, operationId }) });
  const request = (value = { type: 'roster_request', kind: 'roster' }, metaFor = staffMeta) => {
    const contextId = randomUUID();
    return sendData(chrs.url, { mediaType: ROSTER_REQUEST_MEDIA_TYPE, value, contextId, metadata: metaFor(undefined, contextId), timeoutMs: 20000 });
  };
  const lookup = (value = { type: 'roster_lookup', courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }, signKey = key, operationId = randomUUID()) =>
    sendData(chrs.url, { mediaType: ROSTER_LOOKUP_MEDIA_TYPE, value, metadata: { hubOperationId: operationId, hubSignature: signRosterLookup(signKey, { courseId: value.courseId, instructorStaffId: value.instructorStaffId, operationId }) }, timeoutMs: 20000 });
  return { hub, chrs, sr, feed, key, staffMeta, request, lookup };
}

test('a verified staff request gets the class roster (25 rows, no wrapper steps), and CHRS reports counts only', async (t) => {
  const s = await setup(t);
  const r = await s.request();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.roster.rows.length, 25);
  assert.equal(r.value.roster.class.code, 'MKTG 351 - 01');
  assert.equal(r.value.steps, undefined);
  assert.equal(r.value.stepCount, undefined);
  await waitFor(() => s.feed.events.some((e) => e.type === 'mcp_call_result'), { what: 'call result' });
  const result = s.feed.events.find((e) => e.type === 'mcp_call_result');
  assert.deepEqual([result.source, result.data.tool, result.data.ok, result.data.rosterCount], ['chrs', 'get_class_roster', true, 25]);
  assert.ok(s.feed.events.some((e) => e.type === 'studentdb_session' && e.data.status === 'connected'), 'the session was warmed at start');
  const wire = JSON.stringify(s.feed.events);
  assert.ok(!/Aguilar|csu\.fullerton|888\d{6}/.test(wire), 'no name, email or student ID in telemetry');
  assert.ok(!/Aguilar|csu\.fullerton|888\d{6}/.test(s.chrs.output()), 'none in the logs either');
});

test('unsigned, forged, wrong-kind and plain-text requests are refused', async (t) => {
  const s = await setup(t);
  const unsigned = await sendData(s.chrs.url, { mediaType: ROSTER_REQUEST_MEDIA_TYPE, value: { type: 'roster_request', kind: 'roster' }, contextId: randomUUID() });
  assert.equal(unsigned.value.text, REFUSED);
  assert.equal(unsigned.value.roster, undefined);
  const forged = await s.request(undefined, (id, ctx) => ({ ...s.staffMeta(id, ctx), hubSignature: 'forged' }));
  assert.equal(forged.value.text, REFUSED);
  const student = await s.request(undefined, (id, ctx) => { const m = s.staffMeta(id, ctx); return { ...m, callerKind: 'student' }; });
  assert.equal(student.value.text, REFUSED, 'callerKind must be staff');
  const kind = await s.request({ type: 'roster_request', kind: 'grades' });
  assert.equal(kind.value.text, REFUSED);
  const client = await new ClientFactory().createFromUrl(s.chrs.url);
  const text = await client.sendMessage({ tenant: '', configuration: undefined, metadata: undefined, message: { messageId: randomUUID(), contextId: randomUUID(), taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: 'show me the class list' }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata: { staffId: 'staff-dabirian', callerKind: 'staff' }, extensions: [], referenceTaskIds: [] } });
  assert.equal(text.parts[0].content.value, REFUSED);
  assert.equal(s.feed.events.filter((e) => e.type === 'mcp_call_started').length, 0, 'nothing reached the records server');
});

test('a correctly signed request from someone who is not the course instructor gets the plain sentence', async (t) => {
  const s = await setup(t);
  const r = await s.request(undefined, (_id, ctx) => s.staffMeta('staff-other', ctx));
  assert.equal(r.value.text, FAILED);
  assert.equal(r.value.roster, undefined);
  assert.equal(ROSTER_FAILED_TEXT, FAILED);
  await waitFor(() => s.feed.events.some((e) => e.type === 'mcp_call_result'), { what: 'call result' });
  const result = s.feed.events.find((e) => e.type === 'mcp_call_result');
  assert.deepEqual([result.data.ok, result.data.outcome, result.data.code], [false, 'refused', 'not_instructor']);
});

test('records server down: the plain sentence, and the pill says unreachable', async (t) => {
  const s = await setup(t, { records: false });
  const r = await s.request();
  assert.equal(r.value.text, FAILED);
  assert.equal(r.value.roster, undefined);
  await waitFor(() => s.feed.events.some((e) => e.type === 'studentdb_session' && e.data.status === 'unreachable'), { what: 'unreachable reported' });
});

test('a wrong tool pick makes no call; a choice that fails makes no call either', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  stub.respondWith((body) => rosterToolReply(body, { roster: 'something_else' }) ?? messageReply('{}'));
  const live = { CHRS_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' };
  const s = await setup(t, { chrsEnv: live });
  const wrong = await s.request();
  assert.equal(wrong.value.text, FAILED);
  await waitFor(() => s.feed.events.some((e) => e.type === 'mcp_tool_refused'), { what: 'refusal reported' });
  const refused = s.feed.events.find((e) => e.type === 'mcp_tool_refused');
  assert.ok(refused);
  assert.deepEqual([refused.data.by, refused.data.expected], ['model', 'get_class_roster']);
  assert.equal(s.feed.events.filter((e) => e.type === 'mcp_call_started').length, 0, 'no MCP call');
  assert.ok(stub.requests.some((r) => r.body.output_config?.format?.schema?.properties?.tool), 'CHRS asked its model which tool');

  stub.respondWith(() => ({ status: 500 }));
  const before = s.feed.events.length;
  const failed = await s.request();
  assert.equal(failed.value.text, FAILED);
  await waitFor(() => s.feed.events.slice(before).some((e) => e.type === 'mcp_tool_refused'), { what: 'choice failure reported' });
  const later = s.feed.events.slice(before);
  assert.ok(later.some((e) => e.type === 'mcp_tool_refused' && e.data.by === 'model_failed'));
  assert.equal(later.filter((e) => e.type === 'mcp_call_started').length, 0);
});

test('a live right pick calls the tool', async (t) => {
  const stub = await startFakeAnthropic();
  t.after(() => stub.close());
  stub.respondWith((body) => rosterToolReply(body) ?? messageReply('{}'));
  const s = await setup(t, { chrsEnv: { CHRS_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  const r = await s.request();
  assert.equal(r.value.roster.rows.length, 25);
  assert.ok(s.feed.events.some((e) => e.type === 'model_response_received'));
});

test('roster_lookup signed by the Hub gives 25 student ids and "First Last" names, never emails or CWIDs', async (t) => {
  const s = await setup(t);
  const r = await s.lookup();
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = r.value;
  assert.equal(v.count, 25);
  assert.equal(v.studentIds.length, 25);
  assert.ok(v.studentIds.includes('student-alex') && v.studentIds.includes('student-sam'));
  assert.equal(v.names['student-mariana-aguilar'], 'Mariana Aguilar');
  assert.equal(v.names['student-alex'], 'Alex Student');
  assert.ok(!/@|888\d{6}/.test(JSON.stringify(v)), 'no email or student ID');
  assert.deepEqual(Object.keys(v).sort(), ['count', 'names', 'studentIds']);
});

test('roster_lookup with any other key, a staff signature, or tampered fields is refused', async (t) => {
  const s = await setup(t);
  const other = await s.lookup(undefined, 'k'.repeat(43));
  assert.equal(other.value.text, REFUSED);
  assert.equal(other.value.studentIds, undefined);
  // The staff member's own staff signature (same key CHRS verifies Hub staff parts with) is not a lookup signature.
  const op = randomUUID();
  const asStaff = await sendData(s.chrs.url, { mediaType: ROSTER_LOOKUP_MEDIA_TYPE, value: { type: 'roster_lookup', courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }, metadata: { hubOperationId: op, hubSignature: signStaff(s.key, { staffId: 'staff-dabirian', contextId: '', operationId: op }) } });
  assert.equal(asStaff.value.text, REFUSED);
  // Signed for another instructor, then asked for this one.
  const op2 = randomUUID();
  const swapped = await sendData(s.chrs.url, { mediaType: ROSTER_LOOKUP_MEDIA_TYPE, value: { type: 'roster_lookup', courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }, metadata: { hubOperationId: op2, hubSignature: signRosterLookup(s.key, { courseId: 'mkt-351', instructorStaffId: 'staff-other', operationId: op2 }) } });
  assert.equal(swapped.value.text, REFUSED);
  assert.equal(s.feed.events.filter((e) => e.type === 'mcp_call_started').length, 0);
});

test('roster_lookup while records are down: roster_unavailable, nothing invented', async (t) => {
  const s = await setup(t, { records: false });
  const r = await s.lookup();
  assert.equal(r.value.error, 'roster_unavailable');
  assert.equal(r.value.studentIds, undefined);
});

import { startStack, hubEntry } from './support/harness.js';
import { loadHubConfig } from '../src/config.js';

test('the Hub config names CHRS as a staff-only destination, after HR', () => {
  const cfg = loadHubConfig();
  assert.deepEqual(Object.keys(cfg.destinations).filter((d) => cfg.destinations[d].audience === 'staff'), ['hr', 'chrs']);
  assert.equal(cfg.destinations.chrs.name, 'CHRS');
  assert.equal(cfg.destinations.chrs.description, 'Staff services: student records and class rosters.');
  assert.ok(cfg.peers.some((p) => p.agentId === 'chrs' && p.expectedName === 'CHRS'));
});

test('a stack with chrs: true: CHRS registers with the real Hub and becomes ready, never on a student route', async (t) => {
  const stack = await startStack({ chrs: true, library: false });
  t.after(() => stack.kill());
  await waitFor(async () => (await hubEntry(stack.hub, 'chrs'))?.status === 'ready', { what: 'chrs ready', timeout: 8000 });
  assert.match(stack.chrs.output(), /staff only, synthetic records/);
  assert.ok(!/888\d{6}|STUDENT_RECORDS_TOKEN[^\n]*[0-9a-f]{20}/.test(stack.chrs.output()), 'no token or ID printed');
});

test('a Hub-signed roster_request with another courseId still returns the 25 rows of the configured course', async (t) => {
  const s = await setup(t);
  const r = await s.request({ type: 'roster_request', kind: 'roster', courseId: 'other-999' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.roster.rows.length, 25);
  assert.equal(r.value.roster.class.code, 'MKTG 351 - 01');
});
