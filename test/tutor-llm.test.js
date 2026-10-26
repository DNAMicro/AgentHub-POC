// Part 4: the Tutor's model integration, reached through the University Hub (Part 7, direct routing). No paid calls: "live" mode runs the real Anthropic
// SDK against a local fake Messages API (ANTHROPIC_BASE_URL), and "mock" mode uses no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack, startUi, waitFor, openStream, post, forRun, find, findAll, stateOf, formVia, formAction, waitLifecycle } from './support/harness.js';
import { addDays, todayIn } from '../src/forms.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import { askTutor, sendFormAction } from '../src/student-agent.js';
import { SYSTEM_PROMPT, modelName } from '../src/tutor-model.js';

// A placeholder that must never appear anywhere except the request to the (fake) provider.
const SENTINEL_KEY = `sk-ant-test-SENTINEL-${randomUUID()}`;
const liveEnv = (stub, extra = {}) => ({
  TUTOR_MODE: 'live', ANTHROPIC_API_KEY: SENTINEL_KEY, ANTHROPIC_BASE_URL: stub.url,
  TUTOR_LOAD_DOTENV: '0', TUTOR_MODEL_TIMEOUT_MS: '1500',
  // Part 4 tests the model plumbing (call counts, errors, history). Part 5 scope checks add calls,
  // so they are switched off here and tested separately in test/scope.test.js.
  TUTOR_SCOPE_ENFORCEMENT: 'off', ...extra,
});

let stub, liveStack, live, liveUi, mockStack, mockUi;
const streams = [];

before(async () => {
  stub = await startFakeAnthropic();
  liveStack = await startStack({ library: false, tutorEnv: liveEnv(stub), uiEnv: { CHAT_TIMEOUT_MS: '4000' } });
  ({ tutor: live, ui: liveUi } = liveStack);
  mockStack = await startStack({ library: false, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' } });
  mockUi = mockStack.ui;
  for (const ui of [liveUi, mockUi]) {
    await waitFor(async () => (await (await fetch(`${ui.url}/api/status`)).json()).tutorStatus, { what: 'tutor status' });
  }
});
after(async () => {
  for (const s of streams) s.close();
  liveStack?.kill();
  mockStack?.kill();
  await stub?.close();
});

const open = async (ui) => {
  const s = await openStream(ui.url);
  streams.push(s);
  return s;
};

// Ask through the browser-facing API and wait for the run to finish.
async function chat(ui, stream, text, contextId) {
  const res = await post(`${ui.url}/api/runs`, { text, contextId });
  assert.equal(res.status, 202);
  const { runId, contextId: ctx } = await res.json();
  await waitFor(() => ['completed', 'failed', 'uncertain'].includes(stateOf(stream.events, runId)), { what: `run ${runId}` });
  await waitFor(() => find(forRun(stream.events, runId), 'tutor', 'reply_published') || stateOf(stream.events, runId) === 'uncertain', { what: 'tutor reply event' });
  const events = forRun(stream.events, runId);
  return { runId, contextId: ctx, events, reply: find(events, 'student', 'reply_received')?.data, error: find(events, 'student', 'tutor_error')?.data };
}

test('live mode sends the specified request to Anthropic and shows the actual model response', async () => {
  stub.reset();
  const stream = await open(liveUi);
  const { reply, events } = await chat(liveUi, stream, 'What is a derivative?');

  assert.equal(stub.requests.length, 1);
  const { body, headers } = stub.requests[0];
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 800);
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'What is a derivative?' }]);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body), `no ${k}`);
  // Positive control: the key really was used — only in the auth header to the provider.
  assert.ok(headers.authorization === `Bearer ${SENTINEL_KEY}` || headers['x-api-key'] === SENTINEL_KEY);

  assert.equal(reply.text, 'Fake answer to: What is a derivative?', 'browser receives the provider’s actual text');
  assert.equal(reply.tutorMode, 'live');
  const order = ['message_received', 'model_call_started', 'model_response_received', 'reply_published']
    .map((t) => find(events, 'tutor', t));
  assert.ok(order.every(Boolean), 'all Tutor milestones observed');
  assert.ok(order.every((e, i) => i === 0 || Date.parse(order[i - 1].at) <= Date.parse(e.at)), 'milestones in order');
});

test('follow-up questions carry that conversation’s earlier messages', async () => {
  stub.reset();
  const stream = await open(liveUi);
  const first = await chat(liveUi, stream, 'What is the derivative of x^2?');
  const second = await chat(liveUi, stream, 'And of x^3?', first.contextId);

  assert.equal(second.contextId, first.contextId);
  assert.deepEqual(stub.requests[1].body.messages, [
    { role: 'user', content: 'What is the derivative of x^2?' },
    { role: 'assistant', content: 'Fake answer to: What is the derivative of x^2?' },
    { role: 'user', content: 'And of x^3?' },
  ]);
  assert.equal(find(second.events, 'tutor', 'model_call_started').data.earlierMessages, 2);
});

test('conversations are isolated: one student’s history never reaches another’s request', async () => {
  stub.reset();
  const stream = await open(liveUi);
  const a1 = await chat(liveUi, stream, 'ALPHA question about limits');
  const b1 = await chat(liveUi, stream, 'BRAVO question about integrals');
  await chat(liveUi, stream, 'ALPHA follow-up', a1.contextId);
  await chat(liveUi, stream, 'BRAVO follow-up', b1.contextId);

  const [, , aFollow, bFollow] = stub.requests.map((r) => JSON.stringify(r.body.messages));
  assert.match(aFollow, /ALPHA question/);
  assert.doesNotMatch(aFollow, /BRAVO/);
  assert.match(bFollow, /BRAVO question/);
  assert.doesNotMatch(bFollow, /ALPHA/);
});

test('usage is reported to the browser and logged without message contents', async () => {
  stub.reset();
  stub.respondWith(() => messageReply('Usage check answer', { inputTokens: 123, outputTokens: 45 }));
  const stream = await open(liveUi);
  const question = `Usage question ${randomUUID()}`;
  const { reply, events } = await chat(liveUi, stream, question);

  assert.deepEqual(reply.tutor.usage, { inputTokens: 123, outputTokens: 45, cacheReadInputTokens: null, cacheCreationInputTokens: null });
  assert.equal(reply.tutor.model, 'claude-haiku-5-5');
  assert.equal(typeof reply.tutor.latencyMs, 'number');
  assert.equal(find(events, 'tutor', 'model_response_received').data.usage.outputTokens, 45);

  const logged = live.output();
  assert.match(logged, /model call ok \{[^}]*model: 'claude-haiku-5-5'[^}]*latencyMs: \d+[^}]*inputTokens: 123[^}]*outputTokens: 45/s);
  assert.ok(!logged.includes(question), 'question text not in Tutor logs (live mode default)');
  assert.ok(!logged.includes('Usage check answer'), 'answer text not in Tutor logs');
  assert.ok(!liveUi.output().includes(question), 'question text not in UI server logs');
  assert.ok(!liveStack.hub.output().includes(question), 'question text not in Hub logs');
});

test('provider failures become clear, sanitized errors — one attempt, no canned success', async () => {
  const cases = [
    [() => ({ status: 401 }), 'authentication_failed'],
    [() => ({ status: 403 }), 'permission_denied'],
    [() => ({ status: 404 }), 'model_unavailable'],
    [() => ({ status: 429 }), 'rate_limited'],
    [() => ({ status: 500 }), 'provider_unavailable'],
    [() => ({ status: 529 }), 'provider_unavailable'],
    [() => ({ ...messageReply('ignored'), delayMs: 2500 }), 'timeout'], // Tutor model timeout is 1.5 s
    [() => messageReply(null, { stopReason: 'refusal' }), 'refusal'],
    [() => messageReply(null, { stopReason: 'max_tokens', withThinking: true }), 'truncated_no_text'],
  ];
  const stream = await open(liveUi);
  for (const [behavior, code] of cases) {
    stub.reset();
    stub.respondWith(behavior);
    const { runId, error, reply, events } = await chat(liveUi, stream, `Failure case ${code}`);
    assert.equal(stub.requests.length, 1, `${code}: exactly one provider call (no hidden retries)`);
    assert.equal(error?.code, code, `${code}: surfaced to the Student`);
    assert.equal(reply, undefined, `${code}: no successful reply shown`);
    assert.equal(stateOf(stream.events, runId), 'failed');
    assert.equal(find(events, 'tutor', 'model_call_failed').data.code, code);
    assert.doesNotMatch(error.message, /fake \d{3}|sk-ant/, `${code}: provider’s raw message not passed on`);
  }
  stub.reset();
});

test('missing API key: clear error and no provider call', async () => {
  const keylessStack = await startStack({ library: false, tutorEnv: { ...liveEnv(stub), ANTHROPIC_API_KEY: '' } });
  const { tutor: keyless, ui: keylessUi } = keylessStack;
  try {
    await waitFor(async () => (await (await fetch(`${keylessUi.url}/api/status`)).json()).tutorStatus, { what: 'status' });
    const status = (await (await fetch(`${keylessUi.url}/api/status`)).json()).tutorStatus;
    assert.deepEqual({ mode: status.mode, keyConfigured: status.keyConfigured }, { mode: 'live', keyConfigured: false });
    assert.match(keyless.output(), /API key \(ANTHROPIC_API_KEY\): NOT SET/);

    stub.reset();
    const stream = await open(keylessUi);
    const { error, reply, events } = await chat(keylessUi, stream, 'Anyone home?');
    assert.equal(error.code, 'missing_credentials');
    assert.equal(find(events, 'tutor', 'model_call_started'), undefined, 'no "call started" claim when no call was made');
    assert.equal(find(events, 'tutor', 'model_call_failed').data.code, 'missing_credentials');
    assert.match(error.message, /ANTHROPIC_API_KEY is not set/);
    assert.equal(reply, undefined);
    assert.equal(stub.requests.length, 0, 'no provider call without a key');
  } finally {
    keylessStack.kill();
  }
});

test('repeated requests never cause duplicate paid calls', async () => {
  stub.reset();
  stub.respondWith((body) => ({ ...messageReply(`Answer to ${body.messages.at(-1).content}`), delayMs: 300 }));
  const contextId = randomUUID();

  // Same request ID twice in a row: the second gets the stored result.
  const messageId = randomUUID();
  const first = await askTutor(live.url, 'Repeat me', { contextId, messageId });
  const again = await askTutor(live.url, 'Repeat me', { contextId, messageId });
  assert.equal(stub.requests.length, 1);
  assert.equal(again.text, first.text);
  assert.equal(again.tutor.duplicate, true);

  // Same request ID concurrently while the first is still in flight: one call.
  const concurrentId = randomUUID();
  const [c1, c2] = await Promise.all([
    askTutor(live.url, 'Concurrent', { contextId, messageId: concurrentId }),
    askTutor(live.url, 'Concurrent', { contextId, messageId: concurrentId }),
  ]);
  assert.equal(stub.requests.length, 2);
  assert.equal(c1.text, c2.text);

  // A different question in the same conversation while one is in flight: refused, not queued or paid.
  const slow = askTutor(live.url, 'Slow one', { contextId, messageId: randomUUID() });
  await waitFor(() => stub.requests.length === 3, { what: 'slow call to start' });
  await assert.rejects(askTutor(live.url, 'Impatient', { contextId, messageId: randomUUID() }), (err) => err.tutorError?.code === 'busy');
  await slow;
  assert.equal(stub.requests.length, 3, 'the refused question made no provider call');
  stub.reset();
});

test('uncertain outcome is reconciled with the same request ID — no second paid call; reconnect sends nothing', async () => {
  stub.reset();
  stub.respondWith(() => ({ ...messageReply('Slow but sure'), delayMs: 900 }));
  // A second Student UI on the same Hub, which gives up on the Student↔Hub leg after 300 ms.
  const impatientUi = await startUi(liveStack.hub.url, { CHAT_TIMEOUT_MS: '300' });
  try {
    const stream = await open(impatientUi);
    const { runId } = await chat(impatientUi, stream, 'Will this time out?');
    assert.equal(stateOf(stream.events, runId), 'uncertain');
    assert.equal(find(forRun(stream.events, runId), 'student', 'request_failed').data.outcome, 'uncertain');
    assert.equal(find(forRun(stream.events, runId), 'student', 'reply_received'), undefined, 'no success claimed');

    await new Promise((r) => setTimeout(r, 900)); // the Tutor finishes its (single) model call meanwhile
    assert.equal((await post(`${impatientUi.url}/api/runs/${runId}/reconcile`, {})).status, 202);
    await waitFor(() => stateOf(stream.events, runId) === 'completed', { what: 'reconciled' });
    const reply = find(forRun(stream.events, runId), 'student', 'reply_received').data;
    assert.equal(reply.text, 'Slow but sure');
    // The Hub answers the reconcile from its own ledger (same Student request ID): nothing is dispatched again.
    await waitFor(() => find(forRun(stream.events, runId), 'hub', 'request_repeat'), { what: 'Hub repeat event' });
    assert.equal(findAll(forRun(stream.events, runId), 'hub', 'forward_attempted').length, 1, 'forwarded to the Tutor once');
    assert.equal(stub.requests.length, 1, 'one paid call in total');

    for (let i = 0; i < 3; i++) (await open(impatientUi)).close(); // browser reconnects
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(stub.requests.length, 1, 'reconnects triggered no call');
    assert.equal((await post(`${impatientUi.url}/api/runs/${runId}/reconcile`, {})).status, 409, 'nothing left to reconcile');
  } finally {
    impatientUi.proc.kill();
    stub.reset();
  }
});

test('mock mode: contextual follow-up, real milestones, labeled mode, no provider', async () => {
  const stream = await open(mockUi);
  const status = (await (await fetch(`${mockUi.url}/api/status`)).json()).tutorStatus;
  assert.equal(status.mode, 'mock');

  const first = await chat(mockUi, stream, 'What is a limit?');
  const second = await chat(mockUi, stream, 'Can you give an example?', first.contextId);
  assert.match(first.reply.text, /^\[Mock tutor — no model was called\].*first question/);
  assert.match(second.reply.text, /Earlier in this conversation you asked: "What is a limit\?"/);
  assert.equal(second.reply.tutor.model, 'mock');
  assert.ok(find(second.events, 'tutor', 'model_call_started') && find(second.events, 'tutor', 'model_response_received'));
});

test('New conversation: recorded as an event, refused mid-request, next message starts fresh', async () => {
  stub.reset();
  stub.respondWith((body) => ({ ...messageReply(`Answer to ${body.messages.at(-1).content}`), delayMs: 400 }));
  const stream = await open(liveUi);
  const first = await chat(liveUi, stream, 'Old conversation question');

  // Refused while a request is in flight, so a late reply can't land in the "new" conversation.
  const pending = post(`${liveUi.url}/api/runs`, { text: 'Still answering', contextId: first.contextId });
  await waitFor(() => stub.requests.length === 2, { what: 'second call in flight' });
  assert.equal((await post(`${liveUi.url}/api/conversation/new`, {})).status, 409);
  const { runId: busyRun } = await (await pending).json();
  await waitFor(() => stateOf(stream.events, busyRun) === 'completed', { what: 'in-flight run' });

  assert.equal((await post(`${liveUi.url}/api/conversation/new`, {})).status, 202);
  await waitFor(() => stream.events.some((e) => e.type === 'conversation_reset'), { what: 'reset event' });
  const resetSeq = stream.events.findLast((e) => e.type === 'conversation_reset').seq;

  // The browser sends no contextId after a reset → new conversation, no earlier messages.
  const fresh = await chat(liveUi, stream, 'Fresh question');
  assert.notEqual(fresh.contextId, first.contextId);
  assert.equal(find(fresh.events, 'tutor', 'model_call_started').data.earlierMessages, 0);
  assert.deepEqual(stub.requests.at(-1).body.messages, [{ role: 'user', content: 'Fresh question' }]);
  assert.ok(find(fresh.events, 'system', 'run_started').seq > resetSeq);

  // A reconnecting browser replays the reset in order, so the old conversation stays cleared.
  const replay = await open(liveUi);
  await waitFor(() => replay.events.some((e) => e.type === 'conversation_reset'), { what: 'replayed reset' });
  stub.reset();
});

test('live form review: the model reads every field, can only flag; “Send anyway” records it; a failed review never blocks', async () => {
  stub.reset();
  const stream = await open(liveUi);
  const date = (() => { for (let n = 2; ; n++) { const d = addDays(todayIn(), n); if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) return d; } })();
  const context = { firstName: 'Alex', lastName: 'Student', email: 'alex@example.com', preferredDate: date, period: ['morning'], specificTime: '', notes: 'Help me fix my car engine.' };
  const reviewCalls = () => stub.requests.filter((r) => /You review a form/.test(r.body.system ?? ''));

  // 1) The review flags the notes → the form goes back; nothing is recorded.
  const { form } = await formVia(liveUi, stream, 'I want to arrange in-person help with calculus');
  stub.respondWith(() => messageReply(JSON.stringify({ flags: [{ field: 'notes', message: 'The notes are about a car, not calculus.' }] })));
  await formAction(liveUi, form.formId, 'submitTutoringRequest', 'submit_button', context);
  await waitFor(() => stream.events.some((e) => e.type === 'form_lifecycle' && e.data.formId === form.formId && e.data.review), { what: 'flagged' });
  const flagged = stream.events.filter((e) => e.type === 'form_lifecycle' && e.data.formId === form.formId).at(-1).data;
  assert.equal(flagged.state, 'editing');
  assert.deepEqual(flagged.flags, [{ field: 'notes', message: 'The notes are about a car, not calculus.' }]);
  assert.equal(reviewCalls().length, 1);
  const sent = reviewCalls()[0].body;
  assert.equal(sent.output_config.format.type, 'json_schema');
  for (const value of ['Alex', 'Student', 'alex@example.com', date, 'morning', context.notes]) assert.ok(sent.messages[0].content.includes(value), `review sees “${value}”`);
  assert.doesNotMatch(live.output(), /recorded tutoring request/, 'nothing recorded while flagged');

  // 2) "Send anyway" with the same values: recorded, no second review call.
  const res = await post(`${liveUi.url}/api/forms/${form.formId}/actions`, { operationId: randomUUID(), acknowledgeReview: true, action: { name: 'submitTutoringRequest', surfaceId: form.formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context } });
  assert.equal(res.status, 202);
  await waitLifecycle(stream, form.formId, ['accepted']);
  assert.equal(reviewCalls().length, 1, 'acknowledged values are not re-reviewed');

  // 3) A failed review (unusable reply) never blocks a valid submission.
  const second = (await formVia(liveUi, stream, 'Please replace the form, I want in-person tutoring')).form;
  stub.respondWith(() => messageReply('not json'));
  await formAction(liveUi, second.formId, 'submitTutoringRequest', 'submit_button', { ...context, notes: 'Derivatives of trig functions.' });
  await waitLifecycle(stream, second.formId, ['accepted']);
  assert.ok(stream.events.some((e) => e.source === 'tutor' && e.type === 'form_review' && e.data.unavailable), 'the failure is reported');
});

test('live form review backstop: an “email doesn’t match the name” flag is discarded, so the request is recorded', async () => {
  stub.reset();
  const stream = await open(liveUi);
  const date = (() => { for (let n = 2; ; n++) { const d = addDays(todayIn(), n); if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) return d; } })();
  await post(`${liveUi.url}/api/conversation/new`, {});
  const { form } = await formVia(liveUi, stream, 'I want to arrange in-person help with calculus');
  stub.respondWith(() => messageReply(JSON.stringify({ flags: [{ field: 'email', message: 'The email address jo@example.com does not appear to match the name Alex Student.' }] })));
  await formAction(liveUi, form.formId, 'submitTutoringRequest', 'submit_button', { firstName: 'Alex', lastName: 'Student', email: 'jo@example.com', preferredDate: date, period: ['morning'], specificTime: '', notes: 'Limits.' });
  await waitLifecycle(stream, form.formId, ['accepted']);
});

test('two concurrent submissions of one form (different operation IDs) cannot both be recorded', async () => {
  stub.reset();
  const { form } = await askTutor(live.url, 'I want to arrange in-person help with calculus', {});
  const recordedBefore = (live.output().match(/recorded tutoring request/g) ?? []).length;
  const date = (() => { for (let n = 2; ; n++) { const d = addDays(todayIn(), n); if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) return d; } })();
  // The review (a model call) takes 400 ms, so the second submission arrives while the first is in it.
  stub.respondWith(() => ({ ...messageReply(JSON.stringify({ flags: [] })), delayMs: 400 }));
  const send = () => sendFormAction(live.url, { form, operationId: randomUUID(), action: { name: 'submitTutoringRequest', surfaceId: form.formId, sourceComponentId: 'submit_button', timestamp: new Date().toISOString(), context: { firstName: 'Alex', lastName: 'Student', email: 'alex@example.com', preferredDate: date, period: ['morning'], specificTime: '', notes: 'Limits.' } } });
  const results = await Promise.all([send(), send()]);
  // Exactly one request is recorded. Both clients resume the same A2A task, so both may see the
  // accepted reply; neither is told "rejected" while its form was in fact recorded.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((live.output().match(/recorded tutoring request/g) ?? []).length - recordedBefore, 1, 'recorded once');
  assert.ok(results.some((r) => r.body.status === 'accepted'));
  for (const r of results) assert.ok(r.body.status === 'accepted' || /already submitted/.test(JSON.stringify(r.body.errors)), JSON.stringify(r.body));
});

test('the API key never appears in frontend assets, browser events, status, or logs', async () => {
  stub.reset();
  const stream = await open(liveUi);
  await waitFor(() => stream.hello, { what: 'hello' });
  await chat(liveUi, stream, 'Key leak check question');
  // Positive control: the key was in play during this test — it reached the provider's auth header.
  assert.ok(JSON.stringify(stub.requests[0].headers).includes(SENTINEL_KEY));
  const assets = readdirSync('public', { recursive: true })
    .filter((f) => /\.(html|js|css)$/.test(f))
    .map((f) => readFileSync(`public/${f}`, 'utf8'));
  const surfaces = {
    'frontend assets': assets.join('\n'),
    'browser events (full replay)': JSON.stringify(stream.events) + JSON.stringify(stream.hello),
    '/api/status': await (await fetch(`${liveUi.url}/api/status`)).text(),
    'Agent Card': await (await fetch(`${live.url}/.well-known/agent-card.json`)).text(),
    'Tutor logs': live.output(),
    'UI server logs': liveUi.output(),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert.ok(text.length > 0, `${name} checked`);
    assert.ok(!text.includes(SENTINEL_KEY), `key absent from ${name}`);
    assert.ok(!text.includes('SENTINEL'), `no key fragment in ${name}`);
  }
});

test('the default model is Claude Haiku 5.5 (no silent substitution)', () => {
  assert.equal(modelName(), 'claude-haiku-5-5');
});

test('each agent can set its own model and key variable: the Tutor’s choice reaches the provider', async () => {
  // A second Tutor configured for Sonnet 5.5 with its own key variable; ANTHROPIC_API_KEY is empty.
  const ownKey = `sk-ant-test-OWNKEY-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'a2a-model-'));
  const config = join(dir, 'tutor.json');
  writeFileSync(config, JSON.stringify({ model: { name: 'claude-haiku-5-5', apiKeyEnv: 'TUTOR_ANTHROPIC_KEY' } }));
  const stack = await startStack({ library: false, tutorEnv: liveEnv(stub, { TUTOR_CONFIG: config, TUTOR_MODEL: 'claude-sonnet-5-5', TUTOR_ANTHROPIC_KEY: ownKey, ANTHROPIC_API_KEY: '' }), uiEnv: { CHAT_TIMEOUT_MS: '4000' } });
  try {
    await waitFor(async () => (await (await fetch(`${stack.ui.url}/api/status`)).json()).tutorStatus, { what: 'tutor status' });
    stub.reset();
    stub.respondWith(() => messageReply('Sonnet here.', { model: 'claude-sonnet-5-5' }));
    const stream = await open(stack.ui);
    const { reply, events } = await chat(stack.ui, stream, 'What is a limit?');
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].body.model, 'claude-sonnet-5-5', 'TUTOR_MODEL overrides the config file');
    const { headers } = stub.requests[0];
    assert.ok(headers['x-api-key'] === ownKey || headers.authorization === `Bearer ${ownKey}`, 'the key comes from the Tutor’s own variable');
    assert.ok(reply, `reply received (${JSON.stringify(events.filter((e) => /error|failed/.test(e.type)).map((e) => [e.type, e.data?.code ?? e.data?.message]))})`);
    assert.equal(reply.tutor.model, 'claude-sonnet-5-5');
    assert.equal(find(events, 'tutor', 'model_call_started').data.model, 'claude-sonnet-5-5', 'telemetry names the Tutor’s model');
    const status = (await (await fetch(`${stack.ui.url}/api/status`)).json()).tutorStatus;
    assert.equal(status.model, 'claude-sonnet-5-5');
  } finally {
    stack.kill();
    stub.reset();
  }
});
