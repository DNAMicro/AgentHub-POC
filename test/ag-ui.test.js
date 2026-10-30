// Part 10: AG-UI (@ag-ui/* 1.0.3) between the Student agent / Professor view and the browser. The UI server's
// AG-UI streams are a second view of its real events; /api/events is unchanged (the other test files read it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventSchemas } from '@ag-ui/core/schemas';
import { startStack, waitFor, openStream, post, find } from './support/harness.js';
import { StreamAgent, bufferedChannel } from '../src/ag-ui-stream-agent.js';
import { createAgUiBridge } from '../src/ag-ui-bridge.js';

// Read an AG-UI SSE stream raw (to inspect exactly what the server sends).
async function aguiStream(url, headers = {}) {
  const abort = new AbortController();
  const events = [];
  const res = await fetch(url, { headers, signal: abort.signal });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const sseId = block.split('\n').find((l) => l.startsWith('id:'))?.slice(3).trim();
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (data) events.push({ sseId, ...JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return { events, res, close: () => abort.abort() };
}
// Run the real client (its own run-order verifier) over a stream; collect what it accepted and any failure.
function client(url, opts = {}) {
  const agent = new StreamAgent({ streamUrl: url, ...opts });
  const seen = [];
  const failures = [];
  const done = agent.connectAgent({}, { onEvent: ({ event }) => seen.push(event), onRunFailed: ({ error }) => failures.push(error.message) }).catch((e) => failures.push(e.message));
  return { agent, seen, failures, done };
}
const runInput = (text, extra = {}) => ({ threadId: 'new', runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], state: {}, tools: [], context: [], forwardedProps: {}, ...extra });
const app = (e) => (e.type === 'CUSTOM' ? e.value : e.type === 'ACTIVITY_SNAPSHOT' ? e.content : null);
// Check a whole event list against the run rules the client enforces.
function runRules(events) {
  let open = false;
  for (const e of events) {
    if (e.type === 'RUN_STARTED') { assert.equal(open, false, `RUN_STARTED while a run is open (${e.runId})`); open = true; continue; }
    assert.equal(open, true, `${e.type} outside a run`);
    if (e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR') open = false;
  }
}

let stack;
before(async () => {
  stack = await startStack({ professor: true, hubEnv: { ROUTER_MODE: 'mock', HUB_TELEMETRY_SHOW_CONTENT: '0' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_MOCK_DELAY_MS: '1200' } });
});
after(() => stack?.kill());

test('a chat question as AG-UI run input: valid events, the server’s run ID, threadId = conversation, one block of reply text', async () => {
  const s = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  const c = client(`${stack.ui.url}/api/ag-ui/stream`);
  await waitFor(() => s.events.some((e) => e.type === 'CUSTOM' && e.name === 'replayed'), { what: 'replay marker' });
  const browserRunId = randomUUID();
  const res = await post(`${stack.ui.url}/api/ag-ui/runs`, runInput('Explain the derivative of x squared', { runId: browserRunId }));
  assert.equal(res.status, 202);
  const { runId, contextId } = await res.json();
  assert.notEqual(runId, browserRunId, 'the server owns run IDs');
  await waitFor(() => s.events.some((e) => (e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR') && (e.runId === runId || e.metadata)), { what: 'run end', timeout: 10000 });
  await waitFor(() => s.events.some((e) => e.type === 'RUN_FINISHED' && e.runId === runId), { what: 'RUN_FINISHED for the run', timeout: 10000 });
  const start = s.events.find((e) => e.type === 'RUN_STARTED' && e.runId === runId);
  assert.equal(start.threadId, contextId, 'threadId is the conversation');
  // Every event validates against @ag-ui/core's schemas and carries an ID (also the SSE id: line).
  for (const e of s.events) {
    const { sseId, ...event } = e;
    assert.ok(EventSchemas.safeParse(event).success, `schema: ${e.type}`);
    assert.equal(sseId, e.metadata.id);
  }
  runRules(s.events);
  // The reply: START, CONTENT, END together, then its metadata.
  const i = s.events.findIndex((e) => e.type === 'TEXT_MESSAGE_START');
  assert.deepEqual(s.events.slice(i, i + 3).map((e) => e.type), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
  assert.match(s.events[i + 1].delta, /Mock tutor/);
  const meta = s.events.find((e) => e.type === 'CUSTOM' && e.name === 'reply_received');
  assert.equal(meta.value.textMessageId, s.events[i].messageId);
  assert.equal(meta.value.data.text, undefined, 'the text travels as the AG-UI message, not twice');
  // The real client accepted the whole stream.
  await waitFor(() => c.seen.some((e) => e.type === 'RUN_FINISHED' && e.runId === runId), { what: 'client saw the run', timeout: 10000 });
  assert.deepEqual(c.failures, []);
  s.close(); c.agent.abortRun();
});

test('only the last user message is read; the 64 KB limit holds; malformed input is refused', async () => {
  const s = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  const input = runInput('ignored', { messages: [{ id: '1', role: 'user', content: 'an old message the server must not trust' }, { id: '2', role: 'assistant', content: 'earlier reply' }, { id: '3', role: 'user', content: 'What is a limit?' }] });
  const res = await post(`${stack.ui.url}/api/ag-ui/runs`, input);
  const { runId } = await res.json();
  await waitFor(() => s.events.some((e) => e.type === 'CUSTOM' && e.name === 'run_started' && e.value.runId === runId), { what: 'run_started' });
  assert.equal(s.events.find((e) => e.type === 'CUSTOM' && e.name === 'run_started' && e.value.runId === runId).value.data.text, 'What is a limit?');
  await waitFor(() => s.events.some((e) => e.type === 'RUN_FINISHED' && e.runId === runId), { what: 'finish', timeout: 10000 });
  const huge = await post(`${stack.ui.url}/api/ag-ui/runs`, runInput('x'.repeat(70 * 1024)));
  assert.equal(huge.status, 413, 'the body limit refuses a 64 KB+ input');
  assert.equal((await post(`${stack.ui.url}/api/ag-ui/runs`, { text: 'not AG-UI' })).status, 400);
  s.close();
});

test('agent telemetry is ACTIVITY_SNAPSHOT (redacted, no topology labels); a lesson reaches an idle tab in a server-opened run', async () => {
  const s = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  const other = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  await waitFor(() => s.events.some((e) => e.name === 'replayed') && other.events.some((e) => e.name === 'replayed'), { what: 'both replayed' });
  const mark = s.events.length;
  await post(`${stack.ui.url}/api/professor/lessons`, { operationId: `op-${randomUUID()}`, audience: 'student-alex', title: 'Customer value', text: 'Customer value is what the customer gets minus what it costs them.', kind: 'lesson' });
  await waitFor(() => s.events.slice(mark).some((e) => e.type === 'CUSTOM' && e.name === 'lesson_received'), { what: 'lesson on AG-UI', timeout: 8000 });
  const fresh = s.events.slice(mark);
  const lessonAt = fresh.findIndex((e) => e.type === 'CUSTOM' && e.name === 'lesson_received');
  const runStart = s.events.slice(0, mark + lessonAt).findLast((e) => e.type === 'RUN_STARTED');
  assert.match(runStart.runId, /^srv-/, 'nobody asked: a server-opened run');
  assert.ok(s.events.slice(s.events.indexOf(runStart)).some((e) => e.type === 'CUSTOM' && e.name === 'server_run'), 'named by a server_run marker');
  runRules(s.events);
  // Two tabs both receive it.
  await waitFor(() => other.events.some((e) => e.type === 'CUSTOM' && e.name === 'lesson_received'), { what: 'second tab' });
  // Telemetry from the Hub, Tutor, Library and Professor: ACTIVITY_SNAPSHOT, each with its own messageId, no topo label.
  const activity = s.events.filter((e) => e.type === 'ACTIVITY_SNAPSHOT');
  assert.ok(activity.some((e) => e.activityType === 'hub'));
  assert.equal(new Set(activity.map((e) => e.messageId)).size, activity.length, 'unique messageIds (replace defaults to true)');
  for (const e of [...activity, ...s.events.filter((x) => x.type === 'CUSTOM')]) assert.equal((e.content ?? e.value)?.topo, undefined, 'topology labels stay on the monitoring stream');
  const hubReceived = activity.find((e) => e.activityType === 'tutor' && e.content.type === 'message_received');
  if (hubReceived) assert.match(String(hubReceived.content.data.text), /redacted/, 'specialist content redacted by the Hub allowlist');
  assert.ok(!s.events.some((e) => app(e)?.type === 'heartbeat'), 'no heartbeats on AG-UI');
  s.close(); other.close();
});

test('a lesson and console entries during a slow chat run land INSIDE that run, and the client accepts it', async () => {
  const s = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  const c = client(`${stack.ui.url}/api/ag-ui/stream`);
  await waitFor(() => s.events.some((e) => e.name === 'replayed'), { what: 'replayed' });
  const { runId } = await (await post(`${stack.ui.url}/api/ag-ui/runs`, runInput('Explain the derivative of x cubed'))).json();
  await waitFor(() => s.events.some((e) => e.type === 'RUN_STARTED' && e.runId === runId), { what: 'run open' });
  // The Tutor's mock answer takes 1.2 s: post a lesson meanwhile.
  await post(`${stack.ui.url}/api/professor/lessons`, { operationId: `op-${randomUUID()}`, audience: 'student-alex', title: 'Segments', text: 'A segment is a group of customers with similar needs.', kind: 'lesson' });
  await waitFor(() => s.events.some((e) => e.type === 'RUN_FINISHED' && e.runId === runId), { what: 'finish', timeout: 10000 });
  const startAt = s.events.findIndex((e) => e.type === 'RUN_STARTED' && e.runId === runId);
  const endAt = s.events.findIndex((e) => e.type === 'RUN_FINISHED' && e.runId === runId);
  const inside = s.events.slice(startAt, endAt);
  assert.ok(inside.some((e) => app(e)?.type === 'lesson_received' || app(e)?.type === 'lesson_delivered' || (e.type === 'ACTIVITY_SNAPSHOT' && /lesson/.test(e.content.type))), 'lesson events arrived inside the open run');
  runRules(s.events);
  await waitFor(() => c.seen.some((e) => e.type === 'RUN_FINISHED' && e.runId === runId), { what: 'client', timeout: 10000 });
  assert.deepEqual(c.failures, [], 'the client’s verifier accepted the interleaving');
  s.close(); c.agent.abortRun();
});

test('reconnect with Last-Event-ID resumes at a run boundary; the client drops what it already has', async () => {
  const first = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  await waitFor(() => first.events.some((e) => e.name === 'replayed'), { what: 'replayed' });
  const shared = first.events.filter((e) => /:a\d+$/.test(e.metadata.id));
  const cursor = shared.at(-2).metadata.id; // somewhere inside the last run
  first.close();
  const again = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`, { 'Last-Event-ID': cursor });
  await waitFor(() => again.events.some((e) => e.name === 'replayed'), { what: 'replayed again' });
  const hello = again.events.find((e) => e.name === 'hello');
  assert.equal(hello.value.resumed, true);
  const replay = again.events.filter((e) => /:a\d+$/.test(e.metadata.id));
  assert.equal(replay[0].type, 'RUN_STARTED', 'a resume starts at a run boundary, never mid-run');
  runRules(again.events);
  // The real client with the same cursor and the IDs it already has: no verifier failure.
  const c = client(`${stack.ui.url}/api/ag-ui/stream`, { after: cursor });
  await waitFor(() => c.seen.some((e) => e.type === 'CUSTOM' && e.name === 'replayed'), { what: 'client replayed' });
  assert.deepEqual(c.failures, []);
  again.close(); c.agent.abortRun();
});

test('a reload replays the history with the replayed marker; the form lifecycle is shared state (snapshot first)', async () => {
  const s = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  await waitFor(() => s.events.some((e) => e.name === 'replayed'), { what: 'replayed' });
  const { runId } = await (await post(`${stack.ui.url}/api/ag-ui/runs`, runInput('I want to reserve a group study room'))).json();
  await waitFor(() => s.events.some((e) => e.type === 'STATE_DELTA' && e.delta[0].value.state === 'editing'), { what: 'form lifecycle', timeout: 10000 }).catch((err) => {
    console.log('AG-UI events for the run:', JSON.stringify(s.events.filter((e) => e.type !== 'ACTIVITY_SNAPSHOT').map((e) => e.type === 'CUSTOM' ? `${e.name}:${JSON.stringify(e.value?.data ?? '').slice(0, 120)}` : e.type)));
    throw err;
  });
  await waitFor(() => s.events.some((e) => e.type === 'RUN_FINISHED' && e.runId === runId), { what: 'finish', timeout: 10000 });
  s.close();
  const reload = await aguiStream(`${stack.ui.url}/api/ag-ui/stream`);
  await waitFor(() => reload.events.some((e) => e.name === 'replayed'), { what: 'reload replayed' });
  const firstSnapshot = reload.events.findIndex((e) => e.type === 'STATE_SNAPSHOT');
  const firstDelta = reload.events.findIndex((e) => e.type === 'STATE_DELTA');
  assert.ok(firstSnapshot >= 0 && firstSnapshot < firstDelta, 'STATE_SNAPSHOT before any STATE_DELTA');
  const forms = reload.events[firstSnapshot].snapshot.forms;
  assert.ok(Object.values(forms).some((f) => f.workflowId === 'study-room-booking' && f.state === 'editing'));
  runRules(reload.events);
  reload.close();
});

test('the Professor view: its own stream, a state snapshot, and one message as a run', async () => {
  const p = await aguiStream(`${stack.ui.url}/api/ag-ui/professor/stream`);
  await waitFor(() => p.events.some((e) => e.type === 'STATE_SNAPSHOT'), { what: 'professor snapshot' });
  assert.ok(p.events.find((e) => e.type === 'STATE_SNAPSHOT').snapshot.professor.course, 'the Professor’s state');
  const res = await post(`${stack.ui.url}/api/ag-ui/professor/runs`, { threadId: 'professor', runId: randomUUID(), messages: [{ id: '1', role: 'user', content: '@alex Remember the quiz.' }], tools: [], context: [], forwardedProps: { operationId: `op-${randomUUID()}` } });
  assert.equal(res.status, 202);
  const { runId } = await res.json();
  await waitFor(() => p.events.some((e) => e.type === 'RUN_FINISHED' && e.runId === runId), { what: 'professor run', timeout: 10000 });
  const result = p.events.find((e) => e.type === 'CUSTOM' && e.name === 'professor_result' && e.value.runId === runId);
  assert.equal(result.value.ok, true);
  for (const e of p.events) assert.ok(EventSchemas.safeParse((({ sseId, ...x }) => x)(e)).success, `schema: ${e.type}`);
  runRules(p.events);
  p.close();
});

test('cross-site POSTs to the AG-UI run endpoints are refused', async () => {
  for (const path of ['/api/ag-ui/runs', '/api/ag-ui/professor/runs']) {
    const r = await post(`${stack.ui.url}${path}`, runInput('hello'), { Origin: 'http://evil.example' });
    assert.equal(r.status, 403, path);
  }
});

test('the monitoring stream still carries everything (the strip, Topology and these tests read it)', async () => {
  const stream = await openStream(stack.ui.url);
  const { runId } = await (await post(`${stack.ui.url}/api/ag-ui/runs`, runInput('Explain derivatives'))).json();
  await waitFor(() => stream.events.some((e) => e.runId === runId && e.type === 'reply_received'), { what: 'reply on /api/events', timeout: 10000 });
  const reply = find(stream.events.filter((e) => e.runId === runId), 'student', 'reply_received');
  assert.match(reply.data.text, /Mock tutor/, 'reply text is still on the monitoring stream');
  assert.ok(stream.events.some((e) => e.runId === runId && e.topo), 'topology labels too');
  stream.close();
});

test('one connection per page: /api/ui/stream carries the monitor, student and professor channels', async () => {
  // Browsers allow 6 connections per server; three streams per page blocked every request once two windows were open.
  const abort = new AbortController();
  const res = await fetch(`${stack.ui.url}/api/ui/stream`, { signal: abort.signal });
  const blocks = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = block.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        blocks.push({ name, data: JSON.parse(data), raw: block });
      }
    }
  })().catch(() => {});
  await waitFor(() => blocks.some((b) => b.name === 'monitor:replayed') && blocks.some((b) => b.name === 'student' && b.data.name === 'replayed') && blocks.some((b) => b.name === 'professor' && b.data.type === 'STATE_SNAPSHOT'), { what: 'three channels' });
  assert.equal(blocks[0].name, 'monitor:hello', 'the monitor hello comes first (a restart is known before any AG-UI event)');
  assert.ok(blocks.every((b) => !/^id:/m.test(b.raw)), 'no shared SSE id: — each channel’s cursor is inside its data');
  assert.ok(blocks.every((b) => ['monitor', 'monitor:hello', 'monitor:truncated', 'monitor:replayed', 'student', 'professor'].includes(b.name)), 'every event is named by its channel');
  const { runId } = await (await post(`${stack.ui.url}/api/ag-ui/runs`, runInput('Explain the derivative of x to the fourth'))).json();
  await waitFor(() => blocks.some((b) => b.name === 'student' && b.data.type === 'RUN_FINISHED' && b.data.runId === runId), { what: 'student run', timeout: 10000 });
  assert.ok(blocks.some((b) => b.name === 'monitor' && b.data.runId === runId && b.data.type === 'reply_received' && b.data.topo !== undefined), 'the monitor channel is the /api/events payload');
  for (const b of blocks.filter((x) => x.name === 'student' || x.name === 'professor')) assert.ok(EventSchemas.safeParse(b.data).success, `schema: ${b.data.type}`);
  runRules(blocks.filter((b) => b.name === 'student').map((b) => b.data));
  runRules(blocks.filter((b) => b.name === 'professor').map((b) => b.data));
  // Resume with the page's cursors: the monitor resumes; the student channel restarts at a run boundary.
  abort.abort();
  const monitorLast = blocks.filter((b) => b.name === 'monitor').at(-1).data.id;
  const studentLast = blocks.filter((b) => b.name === 'student' && /:a\d+$/.test(b.data.metadata.id)).at(-1).data.metadata.id;
  const again = await aguiStream(`${stack.ui.url}/api/ui/stream?monitor=${encodeURIComponent(monitorLast)}&student=${encodeURIComponent(studentLast)}`);
  await new Promise((r) => setTimeout(r, 1000));
  again.close();
  assert.ok(again.events.length > 0);
});

// ---- unit: run boundaries, snapshot-before-delta, and a UI-server restart ----------------------------
test('bridge: a history cut keeps whole runs and every connection starts with a snapshot', () => {
  const bridge = createAgUiBridge({ bootId: 'boot', historyLimit: 12 });
  let seq = 0;
  const ev = (e) => ({ seq: ++seq, id: `boot:${seq}`, at: new Date().toISOString(), ...e });
  for (let r = 0; r < 4; r++) {
    const runId = `run-${r}`;
    bridge.push(ev({ source: 'system', type: 'run_started', runId, data: { kind: 'chat', contextId: 'ctx-12345678' } }));
    bridge.push(ev({ source: 'system', type: 'form_lifecycle', runId, data: { formId: `f${r}`, state: 'editing' } }));
    bridge.push(ev({ source: 'system', type: 'state', runId, data: { state: 'completed' } }));
  }
  const written = [];
  const res = { writeHead() {}, write: (chunk) => written.push(chunk), end() {} };
  bridge.connect({ headers: {}, query: {}, on() {} }, res);
  const events = written.map((w) => JSON.parse(w.split('\n').find((l) => l.startsWith('data:')).slice(5)));
  const replay = events.filter((e) => /:a\d+$/.test(e.metadata.id));
  assert.equal(replay[0].type, 'RUN_STARTED', 'the cut never leaves half a run');
  assert.ok(events.findIndex((e) => e.type === 'STATE_SNAPSHOT') < events.findIndex((e) => e.type === 'STATE_DELTA'));
  assert.ok(events.some((e) => e.type === 'CUSTOM' && e.name === 'truncated'));
  runRules(events);
  bridge.close();
});

test('a UI-server restart ends the subscription (bootChanged) instead of confusing the verifier', async () => {
  let bridge = createAgUiBridge({ bootId: 'boot-one' });
  const server = http.createServer((req, res) => bridge.connect(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const a = client(url);
  await waitFor(() => a.seen.some((e) => e.name === 'replayed'), { what: 'first boot' });
  a.agent.abortRun();
  bridge.close();
  bridge = createAgUiBridge({ bootId: 'boot-two' }); // "restarted"
  const b = client(url, { after: a.agent.lastId, bootId: a.agent.bootId });
  await b.done;
  assert.equal(b.agent.bootChanged, true);
  assert.deepEqual(b.failures, []);
  bridge.close();
  server.closeAllConnections();
  server.close();
});

test('a channel of the page’s single connection keeps events until its agent subscribes (none are lost)', async () => {
  // The client subscribes a moment after connectAgent(); a plain Subject dropped the opening snapshot, hello
  // and the whole history replay (seen as an empty chat after a reload).
  const channel = bufferedChannel();
  const agent = new StreamAgent({ events: channel.observable });
  const seen = [];
  const failures = [];
  const done = agent.connectAgent({}, { onEvent: ({ event }) => seen.push(event.type), onRunFailed: ({ error }) => failures.push(error.message) }).catch((e) => failures.push(e.message));
  // Emitted synchronously, before the agent's subscription exists.
  const id = (n) => ({ metadata: { id: `boot:a${n}` } });
  channel.next({ type: 'RUN_STARTED', threadId: 't', runId: 'r1', ...id(1) });
  channel.next({ type: 'STATE_SNAPSHOT', snapshot: { forms: {} }, ...id(2) });
  channel.next({ type: 'CUSTOM', name: 'hello', value: {}, ...id(3) });
  channel.next({ type: 'RUN_FINISHED', threadId: 't', runId: 'r1', ...id(4) });
  channel.next({ type: 'RUN_STARTED', threadId: 't', runId: 'r1', ...id(1) }); // a duplicate — dropped before the verifier
  channel.complete();
  await done;
  assert.deepEqual(seen, ['RUN_STARTED', 'STATE_SNAPSHOT', 'CUSTOM', 'RUN_FINISHED']);
  assert.deepEqual(failures, []);
  assert.equal(agent.lastId, 'boot:a4');
});
