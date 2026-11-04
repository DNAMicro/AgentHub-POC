// HR Agent (staff time off): the process, its staff-only check, its dev/test routes and its
// registration with the Hub. The signed-staff behaviour (cards, follow-ups, submit) is tested with the
// Hub's staff path (test/hub-staff.test.js), because only the Hub can sign a staff caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { signStaff, signStudent, verifyStaffSignature } from '../src/hub-link.js';
import { startHr, startPeopleSoft, startStack, hubEntry, waitFor, post } from './support/harness.js';

// ---- the staff signature (unit) ----------------------------------------------------------------

test('staff signature: only a Hub staff signature over these exact ids verifies as staff', () => {
  const key = 'k'.repeat(43);
  const ids = { staffId: 'staff-amir', contextId: 'ctx-1', operationId: 'op-12345678' };
  const meta = (extra) => ({ staffId: ids.staffId, hubOperationId: ids.operationId, callerKind: 'staff', hubSignature: signStaff(key, ids), ...extra });
  assert.equal(verifyStaffSignature(key, meta(), 'ctx-1'), 'staff-amir');
  // A student signature over the same ids never counts as staff.
  assert.equal(verifyStaffSignature(key, meta({ hubSignature: signStudent(key, { studentId: ids.staffId, contextId: ids.contextId, operationId: ids.operationId }) }), 'ctx-1'), null);
  assert.equal(verifyStaffSignature(key, meta({ callerKind: undefined }), 'ctx-1'), null, 'callerKind staff is required');
  assert.equal(verifyStaffSignature(key, meta({ callerKind: 'student' }), 'ctx-1'), null);
  assert.equal(verifyStaffSignature(key, meta(), 'ctx-2'), null, 'another conversation');
  assert.equal(verifyStaffSignature(key, meta({ staffId: 'staff-other' }), 'ctx-1'), null, 'another staff member');
  assert.equal(verifyStaffSignature('x'.repeat(43), meta(), 'ctx-1'), null, 'another key');
  assert.equal(verifyStaffSignature(key, null, 'ctx-1'), null);
});

// ---- the HR process on its own -----------------------------------------------------------------

async function rawChat(baseUrl, text, metadata = {}) {
  const client = await new ClientFactory().createFromUrl(baseUrl);
  return client.sendMessage({
    tenant: '', configuration: undefined, metadata: undefined,
    message: { messageId: randomUUID(), contextId: randomUUID(), taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata, extensions: [], referenceTaskIds: [] },
  });
}
const textOf = (m) => m.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

test('HR alone: refuses callers the Hub did not sign as staff; dev reset and test hooks answer', async (t) => {
  // Part 15: HR's records live in PeopleSoft (the demo stand-in), so HR alone still gets its own PeopleSoft.
  const token = randomUUID();
  const ps = await startPeopleSoft({ PEOPLESOFT_TOKEN: token, PEOPLESOFT_TEST_HOOKS: '1' });
  t.after(() => ps.proc.kill());
  const hr = await startHr({ HR_TEST_HOOKS: '1', PEOPLESOFT_URL: ps.url, PEOPLESOFT_TOKEN: token });
  t.after(() => hr.proc.kill());

  const unsigned = await rawChat(hr.url, 'My grandmother passed away, I need this Thursday and Friday');
  assert.equal(unsigned.role, Role.ROLE_AGENT, 'a plain message, not a form task');
  assert.equal(textOf(unsigned), 'HR serves university staff only.');
  assert.equal(unsigned.metadata.hr.outcome, 'refused');
  assert.equal(unsigned.metadata.agentId, 'hr');

  // A bare claim of being staff (no Hub signature) is refused too.
  const claimed = await rawChat(hr.url, 'I need Friday off', { staffId: 'staff-amir', callerKind: 'staff', hubOperationId: 'op-12345678', hubSignature: 'forged' });
  assert.equal(claimed.metadata.hr.outcome, 'refused');
  assert.ok(!/Friday off/.test(hr.output()), 'the words are not logged');

  const reset = await post(`${hr.url}/dev/hr/reset`, {});
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { status: 'reset' });
  const crossSite = await post(`${hr.url}/dev/hr/reset`, {}, { Origin: 'http://evil.example' });
  assert.equal(crossSite.status, 403, 'a cross-site browser POST is refused');
  assert.deepEqual(await (await fetch(`${hr.url}/test/hr/requests`)).json(), { requests: [] });
  assert.ok(!hr.output().includes(token), 'the PeopleSoft token is never logged');

  // PeopleSoft gone: the reset still closes HR's cards but says PeopleSoft wasn't reset.
  ps.proc.kill();
  await waitFor(() => ps.proc.exitCode !== null || ps.proc.signalCode !== null, { what: 'PeopleSoft stopped' });
  const failed = await post(`${hr.url}/dev/hr/reset`, {});
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { status: 'failed', peoplesoft: 'unavailable' });
});

test('HR in the stack: registers with the Hub and becomes ready with its time-off form skill', async (t) => {
  const stack = await startStack({ hr: true, library: false });
  t.after(() => stack.kill());
  const entry = await waitFor(async () => {
    const e = await hubEntry(stack.hub, 'hr');
    return e?.status === 'ready' ? e : null;
  }, { what: 'HR ready in the Hub registry' });
  assert.deepEqual(entry.skills.map((s) => s.id), ['staff-time-off']);
  const card = await (await fetch(`${stack.hr.url}/.well-known/agent-card.json`)).json();
  assert.equal(card.name, 'HR Agent');
  assert.deepEqual(card.skills.map((s) => s.id), ['staff-time-off']);
});
