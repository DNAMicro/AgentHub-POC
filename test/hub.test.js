// Part 7: the University Hub. The Student talks only to the Hub; the Hub keeps a private registry,
// routes, forwards over A2A, relays forms by opaque reference, deduplicates operations, and reports
// telemetry the topology view draws from. Mock router and mock models only (no network, no cost).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  startStack, startUi, openStream, signedStudent, chatVia, formVia, formAction, waitFor, waitLifecycle, lastLifecycle, find, findAll, forRun, post, hubEntry, status,
} from './support/harness.js';
import { askTutor, sendFormAction } from '../src/student-agent.js';
import { addDays, todayIn } from '../src/forms.js';
import { topologyLabel } from '../src/topology.js';
import { redactTelemetry } from '../src/hub-agent.js';

const weekday = (() => {
  for (let n = 2; ; n++) {
    const d = addDays(todayIn(), n);
    if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) return d;
  }
})();
const ALEX = { firstName: 'Alex', lastName: 'Student', email: 'alex@example.com', preferredDate: weekday, period: ['afternoon'], specificTime: '', notes: 'Chain rule practice.' };
const ASK = 'I want to arrange in-person help with calculus';
const action = (form, context = ALEX) => ({ name: 'submitTutoringRequest', surfaceId: form.formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context });
const countIn = (text, needle) => text.split(needle).length - 1;
const ALLOWED_EDGES = new Set(['student-hub', 'hub-tutor', 'hub-library', 'student-model', 'hub-model', 'tutor-model', 'library-model', null]);

let stack, stream;
before(async () => {
  stack = await startStack({ hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam,student-kim' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' } });
  stream = await openStream(stack.ui.url);
});
after(() => {
  stream?.close();
  stack?.kill();
});

test('the Student discovers only the university’s public card; specialist endpoints never reach it', async () => {
  const card = await (await fetch(`${stack.hub.url}/.well-known/agent-card.json`)).json();
  assert.equal(card.name, 'California State University Fullerton');
  assert.deepEqual(card.supportedInterfaces.map((i) => i.url), [`${stack.hub.url}/a2a/jsonrpc`]);
  const cardText = JSON.stringify(card);
  for (const port of [stack.tutorPort, stack.libraryPort]) assert.ok(!cardText.includes(`:${port}`), 'no specialist endpoint on the public card');

  const s = await status(stack.ui);
  assert.equal(s.university.cardValid, true);
  const studentText = JSON.stringify({ ...s, topology: undefined }); // the topology snapshot is developer telemetry
  for (const port of [stack.tutorPort, stack.libraryPort]) assert.ok(!studentText.includes(`:${port}`), 'the Student holds no specialist URL');
  assert.ok(!stack.ui.output().match(new RegExp(`:(${stack.tutorPort}|${stack.libraryPort})\\b`)), 'and never logs one');
});

test('routing through the Hub: route, clarify, unsupported — each answered over the same Student↔Hub leg', async () => {
  const conv = randomUUID();
  const tutor = await chatVia(stack.ui, stream, 'Explain the derivative of x squared', conv);
  const library = await chatVia(stack.ui, stream, 'How do I renew a borrowed book?', conv);
  const vague = await chatVia(stack.ui, stream, 'I need help', conv);
  const off = await chatVia(stack.ui, stream, 'How do I repair a leaking faucet?', conv);
  assert.deepEqual([tutor.destinations, library.destinations, vague.destinations, off.destinations], [['tutor'], ['library'], [], []]);
  assert.deepEqual([tutor.reply.servedBy, library.reply.servedBy], ['tutor', 'library'], 'attribution');
  assert.deepEqual([vague.reply.hub.decision, off.reply.hub.decision], ['clarify', 'unsupported']);
  // Correlation: one Student↔Hub context; separate Hub↔specialist contexts, kept per specialist.
  const fwd = (r) => find(r.events, 'hub', 'forward_attempted').data;
  assert.equal(fwd(tutor).upstreamContextId, conv);
  assert.equal(fwd(library).upstreamContextId, conv);
  assert.notEqual(fwd(tutor).downstreamContextId, fwd(library).downstreamContextId);
  assert.ok(![fwd(tutor).downstreamContextId, fwd(library).downstreamContextId].includes(conv));
  const again = await chatVia(stack.ui, stream, 'Explain limits', conv);
  assert.equal(fwd(again).downstreamContextId, fwd(tutor).downstreamContextId, 'the Tutor keeps its context for this conversation');
});

test('unknown students are refused; another student can’t use a form; a form can’t be used from another conversation or with an altered reference', async () => {
  const mallory = await askTutor(stack.hub.url, 'Explain limits', { metadata: { studentId: 'mallory' } });
  assert.equal(mallory.hub.decision, 'rejected');

  // Part 9: requests to the Hub are signed with the student's session key (see signedStudent).
  const kim = await signedStudent(stack.hub.url, 'student-kim');
  const sam = await signedStudent(stack.hub.url, 'student-sam');
  const a = await askTutor(stack.hub.url, ASK, kim);
  const b = await askTutor(stack.hub.url, ASK, kim); // a second conversation
  assert.ok(a.form?.formRef && b.form?.formRef && a.form.contextId !== b.form.contextId);
  const tutorActions = () => findAll(stream.events, 'tutor', 'form_action_received').length;
  const before = tutorActions();
  const send = (form, who = kim, act = action(a.form)) => sendFormAction(stack.hub.url, { form, operationId: randomUUID(), action: act, ...who });

  assert.match(JSON.stringify((await send(a.form, sam)).body), /another student/);
  // Claiming to be kim without kim's session key is refused before anything else.
  const forged = await askTutor(stack.hub.url, 'Explain limits', { metadata: { studentId: 'student-kim' }, signer: sam.signer });
  assert.match(forged.text, /isn’t signed/);
  // A's reference presented inside B's (live) conversation and task.
  assert.match(JSON.stringify((await send({ ...a.form, contextId: b.form.contextId, taskId: b.form.taskId })).body), /another conversation/);
  assert.match(JSON.stringify((await send({ ...a.form, formRef: `hf-${randomUUID()}` })).body), /Unknown or altered form reference/);
  assert.match(JSON.stringify((await send(a.form, kim, action(b.form))).body), /does not match this form/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(tutorActions(), before, 'nothing reached the Tutor');
  assert.ok(findAll(stream.events, 'hub', 'form_action_rejected').length >= 4);

  // The genuine owner, in the right conversation, succeeds — and the Hub routes it to the issuer.
  const ok = await send(a.form);
  assert.equal(ok.body.status, 'accepted');
  assert.equal(ok.body.servedBy, 'tutor');
});

test('Hub-level unknown outcome: no automatic retry; reconcile with the same operation ID records once', async () => {
  const own = await startStack({ library: false, hubEnv: { HUB_FORM_TIMEOUT_MS: '300' }, tutorEnv: { TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS: '1000' } });
  try {
    const s = await openStream(own.ui.url);
    const { form } = await formVia(own.ui, s, ASK);
    const operationId = randomUUID();
    await formAction(own.ui, form.formId, 'submitTutoringRequest', 'submit_button', ALEX, operationId);
    await waitLifecycle(s, form.formId, ['confirmation_pending']);
    const failed = await waitFor(() => find(s.events, 'hub', 'form_forward_failed'), { what: 'Hub telemetry' }); // separate connection: may lag
    assert.equal(failed.data.outcome, 'unknown');
    await waitFor(() => own.tutor.output().includes('recorded tutoring request'), { what: 'late recording', timeout: 4000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(findAll(s.events, 'hub', 'form_forwarded').length, 1, 'the Hub did not retry on its own');

    assert.equal((await post(`${own.ui.url}/api/forms/${form.formId}/reconcile`, {})).status, 202);
    await waitLifecycle(s, form.formId, ['accepted']);
    assert.equal(lastLifecycle(s.events, form.formId).receipt.requestId.startsWith('TR-'), true);
    assert.equal(countIn(own.tutor.output(), 'recorded tutoring request'), 1, 'the specialist deduplicated the same operation ID');
    s.close();
  } finally {
    own.kill();
  }
});

test('registration states: heartbeat expiry → stale, sign-out → disconnected, disabled — none receive new requests', async () => {
  const own = await startStack({ hubEnv: { ROUTER_MODE: 'mock' }, libraryEnv: { SPECIALIST_ENABLED: '0' }, readyAgents: ['tutor'] });
  await waitFor(async () => (await hubEntry(own.hub, 'library'))?.status === 'disabled', { what: 'library disabled' });
  try {
    const s = await openStream(own.ui.url);
    assert.equal((await hubEntry(own.hub, 'library')).status, 'disabled');
    const lib = await chatVia(own.ui, s, 'How do I renew a borrowed book?');
    assert.equal(lib.decision.decision, 'unavailable');
    assert.deepEqual(lib.destinations, []);

    own.tutor.proc.kill('SIGKILL'); // no sign-out: only the missing heartbeats tell
    const stale = await waitFor(async () => {
      const e = await hubEntry(own.hub, 'tutor');
      return e.status === 'stale' && e;
    }, { what: 'stale', timeout: 6000 });
    assert.equal(stale.registered, true, 'still registered, but not ready');
    const t = await chatVia(own.ui, s, 'Explain the derivative of x squared');
    assert.equal(t.decision.decision, 'unavailable');
    assert.equal(find(t.events, 'hub', 'forward_attempted'), undefined, 'nothing dispatched to a stale specialist');
    // Telemetry can arrive after the HTTP status changed: wait for the event, don't assume it's there.
    await waitFor(() => findAll(s.events, 'hub', 'registry_status').some((e) => e.data.agentId === 'tutor' && e.data.status === 'stale'), { what: 'registry_status stale event' });

    own.library.proc.kill('SIGTERM'); // a clean shutdown signs out
    await waitFor(async () => (await hubEntry(own.hub, 'library')).status === 'disconnected', { what: 'signed out' });
    await waitFor(() => findAll(s.events, 'hub', 'deregistered').some((e) => e.data.agentId === 'library'), { what: 'deregistered event' });
    s.close();
  } finally {
    own.kill();
  }
});

test('concurrent requests from separate conversations stay separate', async () => {
  const qs = ['Explain limits', 'How do I renew a borrowed book?', 'Explain integrals', 'What are the library opening hours?', 'Explain the derivative of x cubed'];
  const kim = await signedStudent(stack.hub.url, 'student-kim');
  const replies = await Promise.all(qs.map((q) => askTutor(stack.hub.url, q, { runId: randomUUID(), ...kim })));
  for (const [i, r] of replies.entries()) {
    const expected = /library|renew/i.test(qs[i]) ? 'library' : 'tutor';
    assert.equal(r.servedBy, expected, qs[i]);
    if (expected === 'tutor') assert.match(r.text, new RegExp(qs[i]), 'each answer belongs to its own question');
  }
  assert.equal(new Set(replies.map((r) => r.contextId)).size, qs.length, 'one Student↔Hub context each');
});

test('telemetry: every hop is labelled on a real edge — never Student↔specialist — and content is redacted by default', async () => {
  const run = await formVia(stack.ui, stream, ASK);
  const marker = `redact-${randomUUID().slice(0, 8)}@example.com`;
  await formAction(stack.ui, run.form.formId, 'submitTutoringRequest', 'submit_button', { ...ALEX, email: marker });
  await waitLifecycle(stream, run.form.formId, ['accepted']);
  await waitFor(() => findAll(stream.events, 'tutor', 'form_action_received').some((e) => e.data.formId === run.form.formId), { what: 'tutor event' });

  const labelled = stream.events.filter((e) => e.topo);
  assert.ok(labelled.length > 20);
  for (const e of labelled) {
    assert.ok(ALLOWED_EDGES.has(e.topo.edge), `edge ${e.topo.edge}`);
    assert.ok(!(e.topo.from === 'student' && ['tutor', 'library'].includes(e.topo.to)) && !(e.topo.to === 'student' && ['tutor', 'library'].includes(e.topo.from)), 'no Student↔specialist hop');
    assert.ok(['attempted', 'accepted', 'processing', 'completed', 'failed', 'unknown'].includes(e.topo.phase));
    assert.ok(!(e.topo.edge ?? '').endsWith('-model'), 'mock models make no provider calls, so no provider traffic is drawn');
  }
  assert.ok(!JSON.stringify(labelled.map((e) => e.topo)).includes(marker), 'labels carry no form values');
  const agentEvents = stream.events.filter((e) => ['hub', 'tutor', 'library'].includes(e.source));
  assert.ok(!JSON.stringify(agentEvents).includes(marker), 'Hub and specialist telemetry carry no student email');
  const received = findAll(stream.events, 'tutor', 'form_action_received').find((e) => e.data.formId === run.form.formId).data;
  assert.equal(received.receivedValues.email, '[redacted]');
  assert.match(findAll(stream.events, 'tutor', 'message_received').at(-1).data.text, /chars redacted/);
});

test('telemetry stream: resumable by event ID, truncation is announced, heartbeats are live-only', async () => {
  await chatVia(stack.ui, stream, 'Explain limits');
  const last = stream.events.at(-1);
  assert.match(last.id, /^[\w-]+:\d+$/);
  await chatVia(stack.ui, stream, 'Explain integrals');
  const resumed = await openStream(stack.ui.url, { 'Last-Event-ID': last.id });
  await waitFor(() => resumed.replayed, { what: 'resume' });
  assert.equal(resumed.hello.resumed, true);
  assert.ok(resumed.events.length > 0 && resumed.events.every((e) => e.seq > last.seq), 'only what was missed');
  resumed.close();
  const other = await openStream(stack.ui.url, { 'Last-Event-ID': `${randomUUID()}:5` });
  await waitFor(() => other.replayed, { what: 'replay' });
  assert.equal(other.hello.resumed, false, 'an unknown boot ID gets a full replay');
  other.close();

  const heartbeats = await waitFor(() => findAll(stream.events, 'hub', 'heartbeat').length >= 2 && findAll(stream.events, 'hub', 'heartbeat'), { what: 'live heartbeats', timeout: 4000 });
  assert.equal(heartbeats[0].topo.category, 'heartbeat');
  const fresh = await openStream(stack.ui.url);
  await waitFor(() => fresh.replayed, { what: 'replay' });
  assert.equal(fresh.events.filter((e) => e.type === 'heartbeat' && e.seq <= heartbeats.at(-1).seq).length, 0, 'heartbeats are not kept in history');
  fresh.close();

  const small = await startUi(stack.hub.url, { UI_HISTORY_LIMIT: '5' });
  try {
    const s = await openStream(small.url);
    await chatVia(small, s, 'Explain limits');
    const late = await openStream(small.url);
    await waitFor(() => late.replayed, { what: 'replay' });
    assert.ok(late.truncated?.missed > 0, 'dropped history is announced');
    assert.equal(late.truncated.kept, 5);
    s.close();
    late.close();
  } finally {
    small.proc.kill();
  }
});

test('invalid configuration fails at startup with a clear error — no fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-config-'));
  const file = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const run = (script, env) => spawnSync(process.execPath, [script], { env: { ...process.env, PORT: '0', UI_PORT: '0', ...env }, encoding: 'utf8', timeout: 5000 });
  const student = run('src/ui-server.js', { STUDENT_CONFIG: file('student.json', { tutorUrl: 'http://127.0.0.1:41241' }) });
  assert.notEqual(student.status, 0);
  assert.match(student.stderr, /Invalid Student configuration[\s\S]*connects only to the university Hub/);
  const remote = run('src/hub-agent.js', { HUB_CONFIG: file('hub.json', { peers: [{ agentId: 'tutor', expectedName: 'Tutor Agent', baseUrl: 'https://tutor.example.com' }], destinations: { tutoring: { worker: 'tutor' } } }) });
  assert.match(remote.stderr, /baseUrl must be a localhost URL/);
  const secret = run('src/hub-agent.js', { HUB_CONFIG: file('hub2.json', { model: { name: 'claude-haiku-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY', apiKey: 'sk-ant-placeholder' } }) });
  assert.match(secret.stderr, /Put the API key in the environment/);
  const shared = run('src/hub-agent.js', { HUB_CONFIG: file('hub3.json', { destinations: { tutoring: { worker: 'tutor' }, library: { worker: 'tutor' } } }) });
  assert.match(shared.stderr, /already assigned to another destination/);
  const badTutor = run('src/tutor-agent.js', { TUTOR_CONFIG: file('tutor.json', { agentId: 'library' }) });
  assert.match(badTutor.stderr, /agentId must be "tutor"/);
  // Each agent sets its own model, but only from the checked list — never a fallback to another one.
  const oldModel = run('src/tutor-agent.js', { TUTOR_MODEL: 'claude-haiku-4-5' });
  assert.notEqual(oldModel.status, 0);
  assert.match(oldModel.stderr, /Invalid Tutor configuration[\s\S]*"claude-haiku-4-5" is not one of the supported models: claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5 \(set by TUTOR_MODEL\)/);
  const hubModel = run('src/hub-agent.js', { HUB_CONFIG: file('hub4.json', { model: { name: 'gpt-4o' } }) });
  assert.match(hubModel.stderr, /Invalid Hub configuration[\s\S]*model.name "gpt-4o" is not one of the supported models/);
  const libKey = run('src/library-agent.js', { LIBRARY_CONFIG: file('library.json', { model: { name: 'claude-opus-5-5', apiKeyEnv: 'not a variable' } }) });
  assert.match(libKey.stderr, /Invalid Library configuration[\s\S]*model.apiKeyEnv must name an environment variable/);
  for (const name of ['student', 'tutor', 'library', 'hub']) {
    const example = JSON.parse(spawnSync('cat', [`config/${name}.example.json`], { encoding: 'utf8' }).stdout);
    assert.ok(!JSON.stringify(example).match(/sk-ant|"apiKey"/), `${name} example holds no secret`);
  }
});

test('a model line appears only for real (live) calls, on the calling agent’s own line', () => {
  const label = (source, type, data) => topologyLabel({ source, type, data });
  assert.deepEqual(['edge', 'from', 'to', 'phase'].map((k) => label('tutor', 'model_call_started', { mode: 'live', model: 'claude-haiku-5-5' })[k]), ['tutor-model', 'tutor', 'model', 'attempted']);
  assert.deepEqual(['edge', 'from', 'to', 'phase'].map((k) => label('hub', 'model_response_received', { model: 'claude-haiku-5-5', purpose: 'routing' })[k]), ['hub-model', 'model', 'hub', 'completed']);
  assert.equal(label('library', 'model_call_failed', { code: 'timeout' }).phase, 'unknown');
  assert.equal(label('tutor', 'model_call_started', { mode: 'mock', model: 'mock' }).edge, null, 'a mock model is work inside the agent');
  assert.equal(label('tutor', 'model_call_failed', { code: 'missing_credentials' }).edge, null, 'no key: no call was made');
  assert.equal(label('tutor', 'scope_checked', { verdict: 'in_scope', usage: null }).edge, null, 'a heuristic scope check is not a call');
  for (const type of ['request_sent', 'reply_received', 'form_action_sent']) assert.equal(label('student', type, {}).edge, 'student-hub');
});


test('telemetry redaction is an allowlist: receipts reduce to their ID, model reasons and unknown fields are masked', () => {
  const ev = (data, runId = 'run-1') => redactTelemetry({ type: 'form_action_result', runId, data });
  const booking = ev({ formId: 'f1', status: 'accepted', receipt: { bookingId: 'BK-1', room: 'Room C', date: '2026-11-02', start: '10:00', end: '12:00', groupSize: 6, note: 'Demo booking' } });
  assert.deepEqual(booking.receipt, { bookingId: 'BK-1', requestId: undefined, renewalId: undefined, status: undefined }, 'no date, time, room or group size');
  const tutoring = ev({ receipt: { requestId: 'TR-1', status: 'received', preferences: { preferredDate: '2026-11-03', period: ['morning'] } } });
  assert.deepEqual(tutoring.receipt, { requestId: 'TR-1', bookingId: undefined, renewalId: undefined, status: 'received' });
  const scope = ev({ verdict: 'in_scope', reason: 'The student asks about alex@example.com’s limits homework', usage: { inputTokens: 5, outputTokens: 2 } });
  assert.equal(scope.verdict, 'in_scope');
  assert.match(scope.reason, /chars redacted/);
  assert.deepEqual(scope.usage, { inputTokens: 5, outputTokens: 2 });
  assert.equal(ev({ someFutureField: 'Alex Student' }).someFutureField, '[12 chars redacted]', 'unknown fields are masked by default');
  assert.deepEqual(ev({ tutor: { model: 'claude-haiku-5-5', note: 'secret' } }).tutor, { model: 'claude-haiku-5-5', note: '[6 chars redacted]' }, 'nested objects follow the same rules');
  assert.deepEqual(ev({ prefilled: ['date', 'groupSize'] }).prefilled, ['date', 'groupSize'], 'lists of field names pass');
  assert.match(String(ev({ prefilled: ['alex@example.com'] }).prefilled), /redacted/, 'but never values');
  const config = { skills: [{ id: 'calculus', name: 'Calculus' }], reason: 'save' };
  assert.deepEqual(redactTelemetry({ type: 'skills_saved', runId: null, data: config }), config, 'named configuration events pass unchanged');
  // A request sent without a runId must not get its content relayed.
  assert.match(redactTelemetry({ type: 'message_received', runId: null, data: { text: 'Alex Student, alex@example.com' } }).text, /chars redacted/, 'no runId is no exemption');
});
