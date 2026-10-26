// Part 5 reverse path, now terminating at the University Hub (Part 7): skill save → card/ETag change →
// real A2A agent_card_changed notice to the Hub → the Hub re-fetches from its CONFIGURED URL → its
// private registry updates → routing changes. The Student never receives these notices.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { startStack, startHub, startLibrary, openStream, chatVia, waitFor, put, post, findAll, hubEntry, unusedPort } from './support/harness.js';
import { CARD_CHANGED_MEDIA_TYPE } from '../src/skills.js';
import { REGISTER_MEDIA_TYPE } from '../src/hub-link.js';
import { createHubRegistry } from '../src/hub-registry.js';

let trio, stream;
before(async () => {
  trio = await startStack({ hubEnv: { ROUTER_MODE: 'mock' } });
  stream = await openStream(trio.ui.url);
});
after(() => {
  stream?.close();
  trio?.kill();
});

const skillsVia = async (ui, agentId) => (await fetch(`${ui.url}/api/agents/${agentId}/skills`)).json();
const etagOf = async (url) => (await fetch(`${url}/.well-known/agent-card.json`)).headers.get('etag');

// Send a raw control message to the Hub, as any local process could.
async function sendControl(hubUrl, mediaType, value) {
  const client = await new ClientFactory().createFromUrl(hubUrl);
  const result = await client.sendMessage({
    tenant: '', configuration: undefined, metadata: undefined,
    message: { messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, extensions: [], referenceTaskIds: [], metadata: undefined,
      parts: [{ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType }] },
  });
  return result.parts.find((p) => p.content?.$case === 'data').content.value;
}

test('settings API (through the Hub’s developer proxy): read, preview, invalid input, unimplemented capability, stale revision — nothing saved', async () => {
  const s = await skillsVia(trio.ui, 'library');
  assert.equal(s.agentName, 'Library Agent');
  assert.equal(s.revision, 1);
  assert.equal(s.matchesTestedDefault, true);
  assert.ok(!JSON.stringify(s.config).match(/http|securitySchemes/), 'editor exposes skills only');

  const preview = await post(`${trio.ui.url}/api/agents/library/skills/preview`, { config: s.config });
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).card.skills.map((k) => k.id), s.config.skills.map((k) => k.id));

  const bad = structuredClone(s.config);
  bad.skills[0].name = '';
  assert.equal((await put(`${trio.ui.url}/api/agents/library/skills`, { config: bad, baseRevision: 1 })).status, 400);
  const unimplemented = structuredClone(s.config);
  unimplemented.skills.push({ id: 'room-booking', kind: 'answer', enabled: true, name: 'Room booking', description: 'Study rooms.', tags: [], examples: [], scope: { allowed: ['study room bookings'], excluded: [] }, knowledge: '' });
  const res = await put(`${trio.ui.url}/api/agents/library/skills`, { config: unimplemented, baseRevision: 1 });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /Add the answer content/);
  assert.equal((await put(`${trio.ui.url}/api/agents/library/skills`, { config: s.config, baseRevision: 0 })).status, 409, 'stale editor');
  assert.equal((await skillsVia(trio.ui, 'library')).revision, 1, 'nothing was saved');
  assert.equal((await fetch(`${trio.ui.url}/api/agents/evil/skills`)).status, 404, 'only allowlisted agents');
});

test('save → new ETag → A2A notice to the Hub → Hub re-fetch → routing changes', async () => {
  const etag0 = await etagOf(trio.library.url);
  const question = 'Where can I find a calculus textbook?';
  assert.deepEqual((await chatVia(trio.ui, stream, question)).destinations, ['library'], 'starts at Library');

  const s = await skillsVia(trio.ui, 'library');
  const config = structuredClone(s.config);
  config.skills.find((k) => k.id === 'find-resources').enabled = false;
  const saved = await put(`${trio.ui.url}/api/agents/library/skills`, { config, baseRevision: s.revision });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.revision, 2);
  assert.notEqual(body.etag, etag0, 'card content validator changed');

  // Separate, real outcomes: saved, notice delivered to the Hub, Hub re-fetched the card.
  await waitFor(() => findAll(stream.events, 'library', 'skills_saved').some((e) => e.data.revision === 2), { what: 'saved' });
  await waitFor(() => findAll(stream.events, 'library', 'card_notification').some((e) => e.data.revision === 2 && e.data.outcome === 'delivered'), { what: 'notice delivered' });
  const received = await waitFor(() => findAll(stream.events, 'hub', 'card_notification_received').find((e) => e.data.agentId === 'library' && e.data.revision === 2), { what: 'Hub received' });
  assert.equal(received.data.duplicate, false);
  await waitFor(() => findAll(stream.events, 'hub', 'card_refreshed').some((e) => e.data.agentId === 'library' && e.data.revision === 2 && e.data.changed), { what: 'card re-fetched' });
  assert.equal(findAll(stream.events, 'student', 'card_notification_received').length, 0, 'the Student never gets specialist notices');

  const entry = await hubEntry(trio.hub, 'library');
  assert.equal(entry.revision, 2);
  assert.equal(entry.etag, body.etag);
  assert.ok(!entry.skills.some((k) => k.id === 'find-resources'));

  const rerouted = await chatVia(trio.ui, stream, question);
  assert.notDeepEqual(rerouted.destinations, ['library'], 'new routing uses the new skills');
  const { askTutor } = await import('../src/student-agent.js');
  const direct = await askTutor(trio.library.url, question, {});
  assert.notEqual(direct.library.skillId, 'find-resources', 'the Library itself enforces the removed skill');
});

test('duplicate and stale notices: deduplicated, and the CURRENT card is fetched from the configured URL', async () => {
  // A second Hub registry in this process, pointed at the running Library (registration needs the
  // specialist's instance ID, which only the specialist knows).
  const base = trio.library.url;
  const events = [];
  const reg = createHubRegistry({ peers: [{ agentId: 'library', expectedName: 'Library Agent', displayName: 'Library Agent', baseUrl: base, rpcUrl: `${base}/a2a/jsonrpc`, cardUrl: `${base}/.well-known/agent-card.json` }], expiryMs: 10000, onEvent: (type, data) => events.push({ type, data }) });
  try {
    const instanceId = randomUUID();
    assert.equal((await reg.register({ agentId: 'library', instanceId, endpoint: `${base}/a2a/jsonrpc`, cardUrl: `${base}/.well-known/agent-card.json`, enabled: true })).status, 'registered');
    const current = reg.entry('library').revision;
    const id = randomUUID();
    assert.equal(reg.cardChanged({ agentId: 'library', instanceId, notificationId: id, revision: 1 }).status, 'received');
    assert.equal(reg.cardChanged({ agentId: 'library', instanceId, notificationId: id, revision: 1 }).status, 'duplicate');
    await waitFor(() => events.filter((e) => e.type === 'card_refreshed' && e.data.reason === 'card_changed').length >= 1, { what: 'refresh' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.filter((e) => e.type === 'card_refreshed' && e.data.reason === 'card_changed').length, 1, 'one refresh for two copies');
    assert.equal(reg.entry('library').revision, current, 'a notice naming an old revision never rolls back');
    assert.equal(events.at(-1).data.changed, false, '304: unchanged card');
  } finally {
    reg.stop();
  }
});

test('spoofed senders, endpoints and notice-supplied URLs cannot redirect fetches or take over an identity', async () => {
  let evilHits = 0;
  const evil = http.createServer((req, res) => { evilHits++; res.end('{}'); }).listen(0, '127.0.0.1');
  await once(evil, 'listening');
  const evilUrl = `http://127.0.0.1:${evil.address().port}`;
  const tutorBase = trio.tutor.url;
  const register = (v) => sendControl(trio.hub.url, REGISTER_MEDIA_TYPE, { type: 'agent_register', instanceId: randomUUID(), enabled: true, ...v });

  assert.match((await register({ agentId: 'evil-agent', endpoint: `${evilUrl}/a2a/jsonrpc`, cardUrl: `${evilUrl}/.well-known/agent-card.json` })).reason, /unknown_peer/);
  assert.match((await register({ agentId: 'tutor', endpoint: `${evilUrl}/a2a/jsonrpc`, cardUrl: `${evilUrl}/.well-known/agent-card.json` })).reason, /unexpected_endpoint/);
  assert.match((await register({ agentId: 'tutor', endpoint: `${tutorBase}/a2a/jsonrpc`, cardUrl: `${tutorBase}/.well-known/agent-card.json` })).reason, /identity_in_use/, 'a second live instance cannot take over');

  const notice = (v) => sendControl(trio.hub.url, CARD_CHANGED_MEDIA_TYPE, { type: 'agent_card_changed', notificationId: randomUUID(), revision: 99, ...v });
  assert.equal((await notice({ agentId: 'evil-agent' })).status, 'rejected');
  assert.match((await notice({ agentId: 'tutor', instanceId: randomUUID(), cardUrl: `${evilUrl}/card.json` })).reason, /not_registered/, 'a sender that isn’t the registered instance is refused');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(evilHits, 0, 'nothing fetched from a URL in a message');
  const tutor = await hubEntry(trio.hub, 'tutor');
  assert.equal(tutor.status, 'ready', 'the real Tutor is unaffected');
  assert.notEqual(tutor.revision, 99, 'message contents never applied');
  assert.ok(findAll(stream.events, 'hub', 'registration_rejected').length >= 3, 'each refusal is visible');
  evil.close();
});

test('offline Hub: propagation reported pending; registering later makes the Hub fetch the current card', async () => {
  const hubPort = await unusedPort();
  const libPort = await unusedPort();
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const lib = await startLibrary({ PORT: String(libPort), HUB_URL: hubUrl, HEARTBEAT_INTERVAL_MS: '300' });
  let hub;
  try {
    const s = await (await fetch(`${lib.url}/settings/skills`)).json();
    const config = structuredClone(s.config);
    config.skills[0].description = 'Opening hours (edited while the Hub was offline).';
    const saved = await (await put(`${lib.url}/settings/skills`, { config, baseRevision: s.revision })).json();
    const settled = await waitFor(async () => {
      const now = await (await fetch(`${lib.url}/settings/skills`)).json();
      return now.lastNotification?.revision === saved.revision && now.lastNotification;
    }, { what: 'notification attempt' });
    assert.equal(settled.outcome, 'pending', 'not claimed as delivered');
    assert.match(settled.detail, /offline/);

    hub = await startHub({ PORT: String(hubPort), LIBRARY_URL: lib.url, TUTOR_URL: `http://127.0.0.1:${await unusedPort()}` });
    const entry = await waitFor(async () => {
      const e = await hubEntry(hub, 'library');
      return e.status === 'ready' && e;
    }, { what: 'registration + card fetch' });
    assert.equal(entry.revision, saved.revision);
    assert.equal((await hubEntry(hub, 'tutor')).status, 'disconnected', 'a specialist that never registered is not "online"');
  } finally {
    lib.proc.kill();
    hub?.proc.kill();
  }
});

test('failed refresh keeps the last good card and invents nothing; a restarted specialist re-registers after expiry', async () => {
  const own = await startStack({ hubEnv: { ROUTER_MODE: 'mock' } });
  try {
    const good = await hubEntry(own.hub, 'library');
    own.library.proc.kill('SIGKILL'); // a crash: no sign-out
    await new Promise((r) => own.library.proc.once('exit', r));
    await post(`${own.ui.url}/api/registry/refresh`, {});
    const down = await waitFor(async () => {
      const e = await hubEntry(own.hub, 'library');
      return ['unreachable', 'stale'].includes(e.status) && e;
    }, { what: 'unreachable or stale' });
    assert.deepEqual(down.skills, good.skills, 'kept the last good skills — none invented');
    assert.equal(down.registered, true, 'still registered: registered ≠ ready');

    // Restart on the same trusted endpoint: a new instance is refused while the old one could still be
    // alive, then accepted once the old heartbeat expires (3 s in tests).
    own.library = await startLibrary({ ...own.specialistEnv, PORT: String(own.libraryPort) });
    const back = await waitFor(async () => {
      const e = await hubEntry(own.hub, 'library');
      return e.status === 'ready' && e.instance !== good.instance && e;
    }, { what: 'recovered', timeout: 9000 });
    assert.equal(back.revision, good.revision);
  } finally {
    own.kill();
  }
});

test('configuration changes make no model calls', async () => {
  assert.equal(findAll(stream.events, 'tutor', 'model_call_started').length, 0);
  assert.equal(findAll(stream.events, 'tutor', 'scope_check_started').length, 0);
});
