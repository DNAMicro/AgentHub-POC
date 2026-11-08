import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessions, SESSION_IDLE_MS, SESSION_MAX_MS, LOCK_MS } from '../src/sessions.js';

const clock = () => { let t = 1_000_000; const now = () => t; now.add = (ms) => { t += ms; }; return now; };

test('sessions: a session ends after 2 hours idle', () => {
  const now = clock(); const s = createSessions({ now });
  const id = s.create('alex');
  assert.deepEqual(s.get(id), { username: 'alex' });
  now.add(SESSION_IDLE_MS + 1);
  assert.equal(s.get(id), null);
});

test('sessions: a session ends 12 hours after sign-in even while used', () => {
  const now = clock(); const s = createSessions({ now });
  const id = s.create('alex');
  for (let used = 0; used < SESSION_MAX_MS; used += 60 * 60 * 1000) { now.add(60 * 60 * 1000); s.get(id); }
  now.add(1);
  assert.equal(s.get(id), null);
});

test('sessions: peek does not keep a session alive; end signs out; ids are random', () => {
  const now = clock(); const s = createSessions({ now });
  const id = s.create('alex');
  now.add(SESSION_IDLE_MS - 10); s.get(id, { peek: true }); now.add(20);
  assert.equal(s.get(id), null);
  const a = s.create('alex'); const b = s.create('alex');
  assert.notEqual(a, b); assert.ok(a.length >= 40);
  s.end(a); assert.equal(s.get(a), null);
  assert.equal(s.get(undefined), null);
});

test('limiter: 5 wrong tries lock for 15 minutes; clear resets', () => {
  const now = clock(); const { limiter } = createSessions({ now });
  const keys = ['u:alex', 'ip:1.2.3.4'];
  for (let i = 0; i < 4; i++) limiter.fail(keys);
  assert.equal(limiter.locked(keys), false);
  limiter.fail(keys);
  assert.equal(limiter.locked(['u:alex']), true);
  assert.equal(limiter.locked(['ip:1.2.3.4']), true);
  now.add(LOCK_MS + 1);
  assert.equal(limiter.locked(keys), false);
  for (let i = 0; i < 4; i++) limiter.fail(['u:sam']);
  limiter.clear('u:sam'); limiter.fail(['u:sam']);
  assert.equal(limiter.locked(['u:sam']), false);
});

test('limiter: tries in flight count toward the limit; a right password does not add a failure', () => {
  const now = clock(); const { limiter } = createSessions({ now });
  const keys = ['u:alex', 'ip:1.2.3.4'];
  const inFlight = Array.from({ length: 5 }, () => limiter.begin(keys));
  assert.ok(inFlight.every(Boolean));
  assert.equal(limiter.begin(keys), null, 'a 6th parallel try waits for the first five');
  inFlight[0](true);
  const again = limiter.begin(keys);
  assert.ok(again, 'one finished as a right password: room for one more');
  for (const d of [...inFlight.slice(1), again]) d(false);
  assert.equal(limiter.locked(keys), true);
});
