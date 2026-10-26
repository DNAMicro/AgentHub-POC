// Part 5 reverse path: skill save → card/ETag change → real A2A agent_card_changed notification
// → Student re-fetches from its registered URL → registry update → routing changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { startTrio, startLibrary, startUi, startTutor, openStream, chatVia, waitFor, put, post, find, findAll, status, unusedPort } from './support/harness.js';
import { CARD_CHANGED_MEDIA_TYPE } from '../src/skills.js';

let trio, stream;
before(async () => {
  trio = await startTrio({ uiEnv: { ROUTER_MODE: 'mock' } });
  stream = await openStream(trio.ui.url);
});
after(() => {
  stream?.close();
  trio?.kill();
});

const skillsVia = async (ui, agentId) => (await fetch(`${ui.url}/api/agents/${agentId}/skills`)).json();
const etagOf = async (url) => (await fetch(`${url}/.well-known/agent-card.json`)).headers.get('etag');
const registryEntry = async (ui, agentId) => (await status(ui)).registry.find((r) => r.agentId === agentId);

// Send a raw notification to Student's A2A endpoint, as any local process could.
async function sendNotice(studentUrl, notice) {
  const client = await new ClientFactory().createFromUrl(studentUrl);
  const result = await client.sendMessage({
    tenant: '', configuration: undefined, metadata: undefined,
    message: { messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, extensions: [], referenceTaskIds: [], metadata: undefined,
      parts: [{ content: { $case: 'data', value: notice }, metadata: undefined, filename: '', mediaType: CARD_CHANGED_MEDIA_TYPE }] },
  });
  return result.parts.find((p) => p.content?.$case === 'data').content.value;
}

test('settings API: read, preview, invalid input, unimplemented capability, stale revision — nothing saved', async () => {
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
  unimplemented.skills.push({ id: 'room-booking', handler: 'room-booking', enabled: true, name: 'Room booking', description: 'Books study rooms.', tags: [], examples: [], scope: { allowed: ['study room bookings'], excluded: [] } });
  const res = await put(`${trio.ui.url}/api/agents/library/skills`, { config: unimplemented, baseRevision: 1 });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /not implemented by this agent/);
  assert.equal((await put(`${trio.ui.url}/api/agents/library/skills`, { config: s.config, baseRevision: 0 })).status, 409, 'stale editor');
  assert.equal((await skillsVia(trio.ui, 'library')).revision, 1, 'nothing was saved ("Cancel" never calls the API at all)');
});

test('save → new ETag → A2A notification → Student re-fetch → routing changes', async () => {
  const before = { etag: await etagOf(trio.library.url), entry: await registryEntry(trio.ui, 'library') };
  const question = 'Where can I find a calculus textbook?';
  assert.deepEqual((await chatVia(trio.ui, stream, question)).destinations, ['library'], 'starts at Library');

  const s = await skillsVia(trio.ui, 'library');
  const config = structuredClone(s.config);
  config.skills.find((k) => k.id === 'find-resources').enabled = false;
  const saved = await put(`${trio.ui.url}/api/agents/library/skills`, { config, baseRevision: s.revision });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.revision, 2);
  assert.notEqual(body.etag, before.etag, 'card content validator changed');
  assert.equal(await etagOf(trio.library.url), body.etag);

  // Three separate, real outcomes.
  await waitFor(() => findAll(stream.events, 'library', 'skills_saved').some((e) => e.data.revision === 2), { what: 'saved' });
  await waitFor(() => findAll(stream.events, 'library', 'card_notification').some((e) => e.data.revision === 2 && e.data.outcome === 'delivered'), { what: 'notification delivered' });
  const received = await waitFor(() => findAll(stream.events, 'student', 'card_notification_received').find((e) => e.data.agentId === 'library' && e.data.revision === 2), { what: 'Student received' });
  assert.equal(received.data.duplicate, false);
  await waitFor(() => findAll(stream.events, 'student', 'registry_updated').some((e) => e.data.agentId === 'library' && e.data.revision === 2 && e.data.changed), { what: 'registry updated' });

  const after = await registryEntry(trio.ui, 'library');
  assert.equal(after.revision, 2);
  assert.equal(after.etag, body.etag);
  assert.ok(!after.skills.some((k) => k.id === 'find-resources'));
  assert.ok(Date.parse(after.lastSuccessAt) >= Date.parse(before.entry.lastSuccessAt));

  // New routing decisions use the new skills: finding a textbook no longer matches the Library.
  const rerouted = await chatVia(trio.ui, stream, question);
  assert.notDeepEqual(rerouted.destinations, ['library']);
  // And the Library itself rejects the removed skill even when called directly.
  const { askTutor } = await import('../src/student-agent.js');
  const direct = await askTutor(trio.library.url, question, {});
  assert.equal(direct.library.outcome, 'skill_disabled');
  assert.doesNotMatch(direct.text, /sample catalog/, 'no catalog content served');
});

test('duplicate and delayed notifications: deduplicated, and the CURRENT card is fetched', async () => {
  const id = randomUUID();
  const refreshesBefore = findAll(stream.events, 'student', 'registry_refresh_started').filter((e) => e.data.agentId === 'tutor').length;
  const first = await sendNotice(trio.studentUrl, { type: 'agent_card_changed', notificationId: id, agentId: 'tutor', revision: 1 });
  const second = await sendNotice(trio.studentUrl, { type: 'agent_card_changed', notificationId: id, agentId: 'tutor', revision: 1 });
  assert.equal(first.status, 'received');
  assert.equal(second.status, 'duplicate');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(findAll(stream.events, 'student', 'registry_refresh_started').filter((e) => e.data.agentId === 'tutor').length, refreshesBefore + 1, 'one refresh for two copies');

  // A late notice naming an OLD library revision doesn't roll the registry back.
  await sendNotice(trio.studentUrl, { type: 'agent_card_changed', notificationId: randomUUID(), agentId: 'library', revision: 1 });
  await waitFor(() => findAll(stream.events, 'student', 'registry_updated').filter((e) => e.data.agentId === 'library').length >= 2, { what: 'refetch' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await registryEntry(trio.ui, 'library')).revision, 2, 'still the current revision');
  assert.equal(findAll(stream.events, 'student', 'registry_updated').filter((e) => e.data.agentId === 'library').at(-1).data.changed, false, '304: unchanged card');
});

test('spoofed senders and notification-supplied URLs cannot redirect fetches or grant access', async () => {
  let evilHits = 0;
  const evil = http.createServer((req, res) => { evilHits++; res.end('{}'); }).listen(0, '127.0.0.1');
  await once(evil, 'listening');
  const evilUrl = `http://127.0.0.1:${evil.address().port}`;

  const unknown = await sendNotice(trio.studentUrl, { type: 'agent_card_changed', notificationId: randomUUID(), agentId: 'evil-agent', revision: 99 });
  assert.equal(unknown.status, 'rejected');
  const withUrl = await sendNotice(trio.studentUrl, { type: 'agent_card_changed', notificationId: randomUUID(), agentId: 'tutor', revision: 99, cardUrl: `${evilUrl}/card.json`, endpoint: evilUrl });
  assert.equal(withUrl.status, 'received', 'treated as a hint for the registered tutor');
  const rec = await waitFor(() => findAll(stream.events, 'student', 'card_notification_received').find((e) => e.data.ignoredFields?.includes('cardUrl')), { what: 'ignored fields' });
  assert.deepEqual(rec.data.ignoredFields.sort(), ['cardUrl', 'endpoint']);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(evilHits, 0, 'no request to the URL in the notification');
  const tutorEntry = await registryEntry(trio.ui, 'tutor');
  assert.notEqual(tutorEntry.revision, 99, 'message contents never applied');
  assert.ok(!(await status(trio.ui)).registry.some((r) => r.agentId === 'evil-agent'));
  evil.close();
});

test('offline Student: propagation reported pending; startup refresh recovers', async () => {
  const studentPort = await unusedPort();
  const lib = await startLibrary({ STUDENT_A2A_URL: `http://127.0.0.1:${studentPort}` });
  const tutor = await startTutor({ STUDENT_A2A_URL: `http://127.0.0.1:${studentPort}` });
  try {
    const s = await (await fetch(`${lib.url}/settings/skills`)).json();
    const config = structuredClone(s.config);
    config.skills[0].description = 'Opening hours (edited while Student was offline).';
    const saved = await (await put(`${lib.url}/settings/skills`, { config, baseRevision: s.revision })).json();
    const settled = await waitFor(async () => {
      const now = await (await fetch(`${lib.url}/settings/skills`)).json();
      return now.lastNotification?.revision === saved.revision && now.lastNotification;
    }, { what: 'notification attempt' });
    assert.equal(settled.outcome, 'pending', 'not claimed as delivered');
    assert.match(settled.detail, /offline/);

    const ui = await startUi(tutor.url, { LIBRARY_URL: lib.url, STUDENT_A2A_PORT: String(studentPort), ROUTER_MODE: 'mock' });
    try {
      const entry = await waitFor(async () => {
        const e = (await status(ui)).registry.find((r) => r.agentId === 'library');
        return e.status === 'ok' && e;
      }, { what: 'startup refresh' });
      assert.equal(entry.revision, saved.revision);
      assert.match(entry.skills[0].description, /edited while Student was offline/);
    } finally {
      ui.proc.kill();
    }
  } finally {
    lib.proc.kill();
    tutor.proc.kill();
  }
});

test('failed refresh keeps the last good card (marked stale) and invents nothing; manual refresh recovers', async () => {
  const studentPort = await unusedPort();
  const libPort = await unusedPort();
  let lib = await startLibrary({ PORT: String(libPort), STUDENT_A2A_URL: `http://127.0.0.1:${studentPort}` });
  const tutor = await startTutor({ STUDENT_A2A_URL: `http://127.0.0.1:${studentPort}` });
  const ui = await startUi(tutor.url, { LIBRARY_URL: lib.url, STUDENT_A2A_PORT: String(studentPort), ROUTER_MODE: 'mock' });
  const s = await openStream(ui.url);
  try {
    await waitFor(async () => (await status(ui)).registry.every((r) => r.status === 'ok'), { what: 'ready' });
    const good = (await status(ui)).registry.find((r) => r.agentId === 'library');
    lib.proc.kill();
    await new Promise((r) => lib.proc.once('exit', r));
    await post(`${ui.url}/api/registry/refresh`, { agentId: 'library' });
    const stale = await waitFor(async () => {
      const e = (await status(ui)).registry.find((r) => r.agentId === 'library');
      return e.status === 'stale' && e;
    }, { what: 'stale' });
    assert.deepEqual(stale.skills, good.skills, 'kept the last good skills — none invented');
    assert.match(stale.lastError, /offline|refused|fetch failed/i);

    lib = await startLibrary({ PORT: String(libPort), STUDENT_A2A_URL: `http://127.0.0.1:${studentPort}` });
    await post(`${ui.url}/api/registry/refresh`, { agentId: 'library' });
    await waitFor(async () => (await status(ui)).registry.find((r) => r.agentId === 'library').status === 'ok', { what: 'recovered' });
    assert.ok(findAll(s.events, 'student', 'registry_refresh_failed').length >= 1);
  } finally {
    s.close();
    ui.proc.kill();
    tutor.proc.kill();
    lib.proc.kill();
  }
});

test('configuration changes make no model calls', async () => {
  // The trio runs mock router + fixed Tutor here; assert no model milestones were emitted by any refresh.
  assert.equal(findAll(stream.events, 'tutor', 'model_call_started').length, 0);
  assert.equal(findAll(stream.events, 'tutor', 'scope_check_started').length, 0);
  void find;
});
