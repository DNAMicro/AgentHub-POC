// The Student agent's own model: clarifying unclear questions and choosing which public university
// capability a non-obvious one needs. The Hub honors only its own capability IDs and still owns the
// destinations. No paid calls: "live" runs the real SDK against the local fake Messages API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack, waitFor, openStream, post, forRun, find, findAll, stateOf, chatVia } from './support/harness.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import { askTutor } from '../src/student-agent.js';
import { topologyLabel } from '../src/topology.js';

process.env.STUDENT_MODE = 'mock'; // read at import time
const { planRequest, matchCapabilities } = await import('../src/student-assistant.js');

const CAPABILITIES = [
  { id: 'tutoring', name: 'Tutoring', description: 'Academic tutoring.', tags: ['tutoring', 'explain', 'calculus', 'derivative', 'integral'], examples: [] },
  { id: 'library', name: 'Library services', description: 'Library services.', tags: ['library', 'book', 'renew', 'study room'], examples: [] },
];

test('obvious requests are decided by rule (no model); unclear ones are not', async () => {
  assert.deepEqual(matchCapabilities('How do I renew my book?', CAPABILITIES).map((m) => m.id), ['library']);
  assert.deepEqual(matchCapabilities('Explain the derivative example in my library book', CAPABILITIES).map((m) => m.id), ['tutoring', 'library']);
  assert.deepEqual(matchCapabilities('Can I reserve a study room?', CAPABILITIES).map((m) => m.id), ['library'], 'multi-word tags match as a phrase');
  // Obvious: no Student decision — the Hub's router (which judges intent) routes it.
  const obvious = await planRequest({ question: 'Explain the derivative of x squared', capabilities: CAPABILITIES });
  assert.deepEqual([obvious.action, obvious.capability, obvious.by, obvious.likely], ['send', null, 'rule', 'tutoring']);
  const vague = await planRequest({ question: 'I need help', capabilities: CAPABILITIES });
  assert.equal(vague.action, 'clarify');
  assert.match(vague.clarificationQuestion, /tutoring or library services/);
  const again = await planRequest({ question: 'I need help\nsomething', capabilities: CAPABILITIES, clarifiedAlready: true });
  assert.equal(again.action, 'send', 'never asks twice');
  const mixed = await planRequest({ question: 'Explain the derivative example in my library book', capabilities: CAPABILITIES });
  assert.deepEqual([mixed.action, mixed.capability], ['send', null], 'mock: several matches go to the Hub’s own heuristic');
  for (const unsure of ['I don’t know', 'idk', 'not sure, maybe either']) {
    const p = await planRequest({ question: `I need help\n${unsure}`, capabilities: CAPABILITIES, clarifiedAlready: true, clarificationAnswer: unsure });
    assert.deepEqual([p.action, p.capability, p.by], ['send', null, 'uncertain'], `“${unsure}” after our question goes to the Hub`);
  }
  const reply = await planRequest({ question: 'yes', capabilities: CAPABILITIES, followsQuestion: true });
  assert.deepEqual([reply.action, reply.capability, reply.by], ['send', null, 'context'], 'a reply to the university’s question goes on as-is');
});

test('topology: the Student’s own model calls are drawn on its own line', () => {
  const t = topologyLabel({ source: 'student', type: 'model_call_started', data: { mode: 'live', model: 'claude-haiku-5-5' } });
  assert.deepEqual([t.edge, t.from, t.to], ['student-model', 'student', 'model']);
  assert.equal(topologyLabel({ source: 'student', type: 'request_planned', data: { action: 'send', capability: 'library', capabilityName: 'Library services', by: 'model' } }).label, 'Student chose Library services (its model)');
  assert.equal(topologyLabel({ source: 'student', type: 'request_planned', data: { action: 'send', capability: null, by: 'rule' } }).label, 'Obvious — the Hub routes it');
  assert.equal(topologyLabel({ source: 'hub', type: 'route_decided', data: { decision: 'route', destination: 'library', decidedBy: 'student' } }).label, 'Routed to library (Student’s choice)');
});

let stack;
const streams = [];
before(async () => {
  stack = await startStack({ hubEnv: { ROUTER_MODE: 'mock' }, uiEnv: { STUDENT_MODE: 'mock' } });
});
after(() => {
  for (const s of streams) s.close();
  stack?.kill();
});
const open = async (url) => {
  const s = await openStream(url);
  streams.push(s);
  return s;
};

test('the Hub advertises one public skill per capability, with no worker names or URLs', async () => {
  const card = await (await fetch(`${stack.hub.url}/.well-known/agent-card.json`)).json();
  assert.deepEqual(card.skills.map((s) => s.id), ['tutoring', 'library']);
  assert.ok(!JSON.stringify(card.skills).match(/4124[12]|Tutor Agent|Library Agent/), 'capabilities only');
});

test('an obvious question goes on as-is: the Hub’s router decides, not the Student', async () => {
  const stream = await open(stack.ui.url);
  const r = await chatVia(stack.ui, stream, 'How do I renew a library book?');
  const plan = find(r.events, 'student', 'request_planned').data;
  assert.deepEqual([plan.action, plan.capability, plan.by], ['send', null, 'rule']);
  await waitFor(() => find(forRun(stream.events, r.runId), 'hub', 'route_decided'), { what: 'route decision' });
  const decided = find(forRun(stream.events, r.runId), 'hub', 'route_decided').data;
  assert.deepEqual([decided.decidedBy, decided.destination], ['hub', 'library']);
  assert.equal(r.reply.servedBy, 'library');
});

test('an unclear question: the Student asks first, sends nothing, then sends question + answer together', async () => {
  const stream = await open(stack.ui.url);
  const first = await chatVia(stack.ui, stream, 'I need help');
  const asked = find(first.events, 'student', 'clarification_asked');
  assert.ok(asked, 'the Student asked a clarifying question');
  assert.equal(stateOf(stream.events, first.runId), 'completed');
  assert.ok(!find(first.events, 'student', 'request_sent'), 'nothing went to the Hub');
  assert.ok(!find(first.events, 'hub', 'message_received'));

  const second = await chatVia(stack.ui, stream, 'with renewing a library book', first.contextId);
  const sent = find(second.events, 'student', 'request_sent').data;
  assert.equal(sent.text, 'I need help\nwith renewing a library book');
  assert.equal(second.reply.servedBy, 'library');
});

test('the Hub ignores a capability it doesn’t offer and routes the request itself', async () => {
  const events = [];
  const abort = new AbortController();
  (async () => {
    const res = await fetch(`${stack.hub.url}/viz/events`, { signal: abort.signal });
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
  const runId = randomUUID();
  try {
    const reply = await askTutor(stack.hub.url, 'Explain the derivative of x squared', { runId, metadata: { studentId: 'student-alex', requestedCapability: 'payroll' } });
    await waitFor(() => events.find((e) => e.runId === runId && e.type === 'route_decided'), { what: 'route decision' });
    assert.equal(events.find((e) => e.runId === runId && e.type === 'capability_rejected').data.capability, 'payroll');
    assert.equal(events.find((e) => e.runId === runId && e.type === 'route_decided').data.decidedBy, 'hub');
    assert.equal(reply.servedBy, 'tutor');
  } finally {
    abort.abort();
  }
});

test('live mode: the Student’s own model (and key variable) decides a non-obvious question', async () => {
  const stub = await startFakeAnthropic();
  const key = `sk-ant-test-STUDENT-${randomUUID()}`;
  const live = await startStack({
    hubEnv: { ROUTER_MODE: 'mock' },
    uiEnv: { STUDENT_MODE: 'live', STUDENT_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
  });
  try {
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'send', capability: 'library', reason: 'Finding course material is a library task.', clarification_question: '' }), { model: 'claude-sonnet-5-5' }));
    const stream = await open(live.ui.url);
    await waitFor(() => stream.hello, { what: 'hello' });
    assert.deepEqual([stream.hello.agents.student.mode, stream.hello.agents.student.model], ['live', 'claude-sonnet-5-5']);
    const r = await chatVia(live.ui, stream, 'Where would I get the reading for chapter three?');
    assert.equal(stub.requests.length, 1, 'one Student model call; the specialist runs mock');
    const { body, headers } = stub.requests[0];
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.deepEqual(body.output_config.format.schema.properties.capability.enum, ['tutoring', 'library', 'none'], 'only the Hub’s public capability IDs');
    assert.ok(headers['x-api-key'] === key || headers.authorization === `Bearer ${key}`);
    const plan = find(r.events, 'student', 'request_planned').data;
    assert.deepEqual([plan.action, plan.capability, plan.by], ['send', 'library', 'model']);
    assert.deepEqual(findAll(r.events, 'student', 'model_response_received').map((e) => e.topo.edge), ['student-model']);
    await waitFor(() => find(forRun(stream.events, r.runId), 'hub', 'route_decided'), { what: 'route decision' });
    assert.equal(find(forRun(stream.events, r.runId), 'hub', 'route_decided').data.decidedBy, 'student');
    assert.equal(r.reply.servedBy, 'library');
    assert.ok(!JSON.stringify(stream.events).includes(key), 'the key never reaches the browser');

    // The model may also ask first; its question is shown and nothing is sent.
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'clarify', capability: 'none', reason: 'Could be either.', clarification_question: 'Is this for a class you need explained, or a book you need to find?' })));
    const c = await chatVia(live.ui, stream, 'Can you help me with chapter three?');
    assert.equal(find(c.events, 'student', 'clarification_asked').data.text, 'Is this for a class you need explained, or a book you need to find?');
    assert.ok(!find(c.events, 'student', 'request_sent'));

    // A model failure falls back to the Hub's own routing — visibly, with no other model.
    stub.respondWith(() => ({ status: 500 }));
    const f = await chatVia(live.ui, stream, 'Something about chapter four please');
    assert.equal(find(f.events, 'student', 'model_call_failed').data.code, 'provider_unavailable');
    assert.deepEqual([find(f.events, 'student', 'request_planned').data.by, find(f.events, 'student', 'request_planned').data.capability], ['model_failed', null]);
    assert.ok(find(f.events, 'student', 'request_sent'), 'still sent; the Hub decides');
  } finally {
    live.kill();
    await stub.close();
  }
});

test('live mode: clearly not a university service → the Student answers itself; anything uncertain goes to the Hub', async () => {
  const stub = await startFakeAnthropic();
  const live = await startStack({
    hubEnv: { ROUTER_MODE: 'mock' },
    uiEnv: { STUDENT_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
  });
  try {
    const stream = await open(live.ui.url);
    // Confident: declined here, nothing sent to the university.
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'decline', capability: 'none', reason: 'Home plumbing repair isn’t something the university offers.', clarification_question: '' })));
    const d = await chatVia(live.ui, stream, 'How do I fix my toilet plumbing?');
    const declined = find(d.events, 'student', 'request_declined').data;
    assert.equal(declined.text, 'Home plumbing repair isn’t something the university offers. The university can help with: Tutoring and Library services.');
    assert.ok(!find(d.events, 'student', 'request_sent'), 'nothing sent');
    assert.ok(!find(d.events, 'hub', 'message_received'));
    assert.equal(stateOf(stream.events, d.runId), 'completed');

    // The model is unsure ("none"): the Hub decides.
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'send', capability: 'none', reason: 'Not sure the university covers this.', clarification_question: '' })));
    const u = await chatVia(live.ui, stream, 'Who do I talk to about my parking permit?');
    assert.ok(find(u.events, 'student', 'request_sent'));
    assert.equal(find(u.events, 'student', 'request_planned').data.capability, null);

    // Asked first, then "I don't know": straight to the Hub, no second Student model call.
    stub.respondWith(() => messageReply(JSON.stringify({ action: 'clarify', capability: 'none', reason: 'Could be either.', clarification_question: 'Is this about a class or a library book?' })));
    const c = await chatVia(live.ui, stream, 'Can you help me with chapter five?');
    assert.ok(find(c.events, 'student', 'clarification_asked'));
    const calls = stub.requests.length;
    const a = await chatVia(live.ui, stream, 'I don’t know', c.contextId);
    assert.equal(stub.requests.length, calls, 'no Student model call for an unsure answer');
    assert.equal(find(a.events, 'student', 'request_planned').data.by, 'uncertain');
    assert.equal(find(a.events, 'student', 'request_sent').data.text, 'Can you help me with chapter five?\nI don’t know');
    assert.ok(!find(a.events, 'student', 'request_declined'));
  } finally {
    live.kill();
    await stub.close();
  }
});
