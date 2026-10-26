// Part 5 routing, moved into the University Hub (Part 7): the Hub picks one registered service and
// forwards over A2A, or calls none (clarify / unsupported / unavailable) and answers the Student itself.
// The live router runs against a local fake Anthropic API with scripted decisions (no paid calls):
// these tests prove the plumbing — validation, destination, isolation — not the model's accuracy.
// The mock-router section exercises the labeled keyword heuristic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { startTrio, openStream, chatVia, waitFor, status, unusedPort, findAll, find, forRun, stateOf, post } from './support/harness.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';

const EXAMPLES = [
  ['Explain the derivative of x squared', { decision: 'route', agent_id: 'tutor', skill_id: 'calculus-tutoring' }, 'tutor'],
  ['How do I renew a borrowed book?', { decision: 'route', agent_id: 'library', skill_id: 'renewals' }, 'library'],
  ['Where can I find a calculus textbook?', { decision: 'route', agent_id: 'library', skill_id: 'find-resources' }, 'library'],
  ['Explain the derivative example in my library book', { decision: 'route', agent_id: 'tutor', skill_id: 'calculus-tutoring' }, 'tutor'],
  ['I need help', { decision: 'clarify', clarification_question: 'Is this about calculus or the library?' }, null],
  ['How do I repair a leaking faucet?', { decision: 'unsupported' }, null],
  ['Explain Newton’s laws', { decision: 'unsupported' }, null],
  ['Renew my book and explain integrals', { decision: 'clarify', clarification_question: 'Which first: the renewal or the integrals?' }, null],
];
const full = (d) => ({ agent_id: '', skill_id: '', reason: 'scripted', clarification_question: '', ...d });

let stub, trio, stream;
const scripted = new Map(); // question → decision JSON the fake model returns

before(async () => {
  stub = await startFakeAnthropic();
  stub.respondWith((body) => {
    const latest = body.messages[0].content.match(/<latest_student_message>\n([\s\S]*?)\n<\/latest_student_message>/)?.[1];
    return messageReply(JSON.stringify(full(scripted.get(latest) ?? { decision: 'unsupported' })));
  });
  trio = await startTrio({
    hubEnv: { ROUTER_MODE: 'live', ANTHROPIC_API_KEY: 'sk-ant-test-router-placeholder', ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
  });
  stream = await openStream(trio.ui.url);
});
after(async () => {
  stream?.close();
  trio?.kill();
  await stub?.close();
});

test('every routing example reaches exactly the expected A2A destination — or none', async () => {
  for (const [question, decision, expected] of EXAMPLES) {
    scripted.set(question, decision);
    const run = await chatVia(trio.ui, stream, question);
    assert.equal(run.decision.decision, decision.decision, question);
    assert.deepEqual(run.destinations, expected ? [expected] : [], `${question}: actual A2A destination`);
    if (expected) {
      assert.equal(run.reply.servedBy, expected, `${question}: reply came from ${expected}`);
      assert.equal(run.decision.agentId, expected);
    } else {
      assert.equal(find(run.events, 'hub', 'forward_attempted'), undefined, `${question}: no service was called`);
      assert.equal(run.reply.hub.decision, decision.decision, 'the Hub answered the Student itself');
      assert.equal(run.reply.servedBy, null);
      assert.equal(stateOf(stream.events, run.runId), 'completed');
    }
  }
});

test('the router request contains skills as data but no endpoint URLs, and asks for a structured decision', async () => {
  const req = stub.requests.find((r) => r.body.messages[0].content.includes('<services>'));
  assert.ok(req, 'router call observed');
  assert.equal(req.body.model, 'claude-haiku-5-5');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.deepEqual(req.body.output_config.format.schema.properties.decision.enum, ['route', 'clarify', 'unsupported']);
  const services = req.body.messages[0].content.match(/<services>\n([\s\S]*?)\n<\/services>/)[1];
  assert.doesNotMatch(services, /http:\/\/|127\.0\.0\.1|jsonrpc/, 'no URLs given to the model');
  assert.match(services, /calculus-tutoring/);
  assert.match(services, /find-resources/);
});

test('unknown agent IDs and URL-shaped choices fail closed without any outbound request', async () => {
  // A local server standing in for an attacker's endpoint: it must receive nothing.
  let evilHits = 0;
  const evil = http.createServer((req, res) => { evilHits++; res.end('{}'); }).listen(await unusedPort(), '127.0.0.1');
  await once(evil, 'listening');
  const evilUrl = `http://127.0.0.1:${evil.address().port}`;
  const before = { tutor: findAll(stream.events, 'tutor', 'message_received').length, library: findAll(stream.events, 'library', 'message_received').length };
  const attempts = [
    { decision: 'route', agent_id: 'evil-agent', skill_id: 'calculus-tutoring' },
    { decision: 'route', agent_id: `${evilUrl}/a2a/jsonrpc`, skill_id: 'calculus-tutoring' },
    { decision: 'route', agent_id: 'tutor', skill_id: 'physics-tutoring' },
    { decision: 'route', agent_id: 'library', skill_id: 'calculus-tutoring', url: evilUrl },
  ];
  for (const [i, decision] of attempts.entries()) {
    const q = `Malicious routing attempt ${i}`;
    scripted.set(q, decision);
    const run = await chatVia(trio.ui, stream, q);
    if (decision.url) {
      // A valid agent/skill pair with an extra URL: routed to the REGISTERED library endpoint only.
      assert.deepEqual(run.destinations, []); // calculus-tutoring isn't a library skill → rejected
    }
    assert.equal(run.decision.decision, 'unsupported');
    assert.equal(run.decision.invalid, true);
    assert.deepEqual(run.destinations, []);
  }
  assert.equal(evilHits, 0, 'nothing was sent to the URL the model named');
  assert.equal(findAll(stream.events, 'tutor', 'message_received').length, before.tutor);
  assert.equal(findAll(stream.events, 'library', 'message_received').length, before.library);
  evil.close();
});

test('separate A2A contexts per service; follow-ups continue; switching topic switches service', async () => {
  const conv = randomUUID();
  scripted.set('Explain limits please', { decision: 'route', agent_id: 'tutor', skill_id: 'calculus-tutoring' });
  scripted.set('Can you give another example?', { decision: 'route', agent_id: 'tutor', skill_id: 'calculus-tutoring' });
  scripted.set('How do I return a book after hours?', { decision: 'route', agent_id: 'library', skill_id: 'returns' });
  const a = await chatVia(trio.ui, stream, 'Explain limits please', conv);
  const b = await chatVia(trio.ui, stream, 'Can you give another example?', conv);
  const c = await chatVia(trio.ui, stream, 'How do I return a book after hours?', conv);
  assert.deepEqual([a.destinations, b.destinations, c.destinations], [['tutor'], ['tutor'], ['library']]);

  const ctx = (run, agent) => find(run.events, agent, 'message_received').data.contextId;
  assert.equal(ctx(a, 'tutor'), ctx(b, 'tutor'), 'Tutor keeps one context for this conversation');
  assert.notEqual(ctx(c, 'library'), ctx(a, 'tutor'), 'Library gets its own context, never the Tutor’s');
  assert.notEqual(ctx(a, 'tutor'), conv, 'per-service context, not the conversation ID itself');

  // The router saw this conversation's earlier turns when deciding the follow-up.
  const followUpCall = stub.requests.findLast((r) => r.body.messages[0].content.includes('Can you give another example?'));
  assert.match(followUpCall.body.messages[0].content, /<recent_turns>[\s\S]*Explain limits please → tutor/);

  // A different conversation shares nothing: the router sees no earlier turns there.
  scripted.set('What about the other one?', { decision: 'clarify', clarification_question: 'Which topic do you mean?' });
  const other = await chatVia(trio.ui, stream, 'What about the other one?');
  assert.deepEqual(other.destinations, []);
  const otherCall = stub.requests.findLast((r) => r.body.messages[0].content.includes('What about the other one?'));
  assert.match(otherCall.body.messages[0].content, /<recent_turns>\n\(none\)/);
});

test('reconnecting browsers do not trigger routing or service calls again', async () => {
  scripted.set('Explain derivatives briefly', { decision: 'route', agent_id: 'tutor', skill_id: 'calculus-tutoring' });
  await chatVia(trio.ui, stream, 'Explain derivatives briefly');
  const calls = stub.requests.length;
  const tutorReceived = findAll(stream.events, 'tutor', 'message_received').length;
  for (let i = 0; i < 3; i++) (await openStream(trio.ui.url)).close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stub.requests.length, calls, 'no new router (paid) calls');
  assert.equal(findAll(stream.events, 'tutor', 'message_received').length, tutorReceived);
});

test('an offline selected service is reported as unavailable — the question is not redirected elsewhere', async () => {
  trio.library.proc.kill(); // SIGTERM: the Library signs out from the Hub
  await new Promise((r) => trio.library.proc.once('exit', r));
  await waitFor(async () => (await (await fetch(`${trio.hub.url}/viz/topology`)).json()).specialists.find((x) => x.agentId === 'library').status !== 'ready', { what: 'library not ready' });
  scripted.set('How do I renew a borrowed book?', { decision: 'route', agent_id: 'library', skill_id: 'renewals' });
  const run = await chatVia(trio.ui, stream, 'How do I renew a borrowed book?');
  assert.equal(run.decision.decision, 'unavailable', 'a supported request for a service that is not ready');
  assert.equal(run.reply.hub.decision, 'unavailable');
  assert.match(run.reply.text, /Library Agent is not available right now/);
  assert.equal(find(run.events, 'hub', 'forward_attempted'), undefined, 'nothing dispatched');
  assert.deepEqual(run.destinations, [], 'not redirected to the Tutor');
});

test('router provider failure or missing key: clear error, neither service called', async () => {
  stub.respondWith(() => ({ status: 529 }));
  const run = await chatVia(trio.ui, stream, 'Explain the derivative of x squared');
  assert.equal(find(run.events, 'hub', 'route_failed').data.code, 'provider_unavailable');
  assert.equal(find(run.events, 'student', 'tutor_error').data.code, 'provider_unavailable', 'the Student is told the request failed');
  assert.deepEqual(run.destinations, []);
  assert.equal(stateOf(stream.events, run.runId), 'failed');

  const keyless = await startTrio({ hubEnv: { ROUTER_MODE: 'live', ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  try {
    const s = await openStream(keyless.ui.url);
    const before = stub.requests.length;
    const r = await chatVia(keyless.ui, s, 'Explain the derivative of x squared');
    assert.equal(find(r.events, 'hub', 'route_failed').data.code, 'missing_credentials');
    assert.deepEqual(r.destinations, []);
    assert.equal(stub.requests.length, before, 'no provider call without a key');
    s.close();
  } finally {
    keyless.kill();
  }
});

test('mock router (labeled heuristic) on the routing examples', async () => {
  const mockTrio = await startTrio({ hubEnv: { ROUTER_MODE: 'mock' } });
  try {
    const s = await openStream(mockTrio.ui.url);
    for (const [question, , expected] of EXAMPLES) {
      const run = await chatVia(mockTrio.ui, s, question);
      assert.deepEqual(run.destinations, expected ? [expected] : [], `${question} (heuristic)`);
    }
    const r = await status(mockTrio.ui);
    assert.equal(r.topology.hub.router.mode, 'mock');
    s.close();
  } finally {
    mockTrio.kill();
  }
});
