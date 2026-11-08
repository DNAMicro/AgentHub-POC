// Part 18: one login in front of the whole demo. A spawned UI server with AUTH=on and a temporary accounts file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUi, waitFor } from './support/harness.js';
import { hashPassword, saveAccess } from '../src/access.js';
import { safeNext, authConfig, AuthConfigError } from '../src/auth-gate.js';

const PW = 'demo-pass-123';
const procs = [];
after(() => { for (const p of procs) p.proc.kill(); });

async function authUi(env = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'auth-')), 'access.json');
  saveAccess(file, [{ username: 'alex', ...(await hashPassword(PW)) }]);
  const ui = await startUi('http://127.0.0.1:9', { AUTH: 'on', AGENTHUB_ACCESS_FILE: file, ...env });
  ui.accessFile = file;
  procs.push(ui);
  return ui;
}
const get = (url, cookie, headers = {}) => fetch(url, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
const signIn = (base, username, password, next = '/faculty') => fetch(`${base}/signin`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username, password, next }),
});
const cookieFrom = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test('auth: nothing opens without signing in; the sign-in page and its files do', async () => {
  const ui = await authUi();
  const page = await get(`${ui.url}/conversation`);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/signin?next=%2Fconversation');
  assert.equal((await get(`${ui.url}/guide`)).status, 302);
  assert.equal((await get(`${ui.url}/app.js`)).status, 302);
  for (const path of ['/api/status', '/api/ui/stream', '/api/events', '/api/professor/state', '/auth/me']) {
    const r = await get(`${ui.url}${path}`);
    assert.equal(r.status, 401, path);
    assert.deepEqual(await r.json(), { error: 'sign_in_required' });
  }
  const post = await fetch(`${ui.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 401);
  for (const path of ['/signin', '/signin.css', '/signin.js', '/fonts/atkinson-hyperlegible-next-latin.woff2']) {
    assert.equal((await get(`${ui.url}${path}`)).status, 200, path);
  }
  const html = await (await get(`${ui.url}/signin?next=/faculty`)).text();
  assert.match(html, /<h1>Sign in<\/h1>/);
  assert.match(html, /name="next" value="\/faculty"/);
  assert.doesNotMatch(html, /California State University/, 'the sign-in page never names the university');
  // no-referrer made Chrome post the form with Origin: null, which the origin check refuses (found in the browser check).
  assert.equal((await get(`${ui.url}/signin`)).headers.get('referrer-policy'), 'same-origin');
});

test('auth: wrong details, then right details, then signed in everywhere, then signed out', async () => {
  const ui = await authUi();
  const bad = await signIn(ui.url, 'alex', 'wrong-pass');
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /That username and password don’t match/);
  const unknown = await signIn(ui.url, 'nobody', PW);
  assert.match(await unknown.text(), /That username and password don’t match/, 'same message for an unknown username');

  const ok = await signIn(ui.url, 'Alex', PW, '/faculty');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/faculty');
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /^ah_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  assert.doesNotMatch(setCookie, /Secure/, 'plain http on the local network: not Secure');
  const cookie = cookieFrom(ok);
  assert.equal((await get(`${ui.url}/api/status`, cookie)).status, 200);
  assert.equal((await get(`${ui.url}/conversation`, cookie)).status, 200);
  assert.deepEqual(await (await get(`${ui.url}/auth/me`, cookie)).json(), { auth: true, username: 'alex' });
  assert.equal((await get(`${ui.url}/signin`, cookie)).status, 302, 'already signed in → back to the app');

  const out = await fetch(`${ui.url}/signout`, { method: 'POST', redirect: 'manual', headers: { cookie } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), '/signin?e=out');
  assert.match(await (await get(`${ui.url}/signin?e=out`)).text(), /You’re signed out\./);
  assert.equal((await get(`${ui.url}/api/status`, cookie)).status, 401, 'the old cookie no longer works');
  const expired = await get(`${ui.url}/faculty`, cookie);
  assert.equal(expired.headers.get('location'), '/signin?next=%2Ffaculty&e=expired');
  assert.match(await (await get(`${ui.url}/signin?next=%2Ffaculty&e=expired`)).text(), /Your session ended/);
});

test('auth: a cross-site sign-in post is refused; a bad next never leaves the site', async () => {
  const ui = await authUi();
  const cross = await fetch(`${ui.url}/signin`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    body: new URLSearchParams({ username: 'alex', password: PW }),
  });
  assert.equal(cross.status, 403);
  for (const next of ['//evil.com', '/\\evil.com', 'https://evil.com', '/signin?x', '/signout', 'javascript:alert(1)']) {
    assert.equal(safeNext(next), '/conversation', next);
  }
  assert.equal(safeNext('/faculty?x=1'), '/faculty?x=1');
  const ok = await signIn(ui.url, 'alex', PW, '//evil.com');
  assert.equal(ok.headers.get('location'), '/conversation');
});

test('auth: 5 wrong tries lock that username and address for 15 minutes', async () => {
  const ui = await authUi();
  for (let i = 1; i <= 4; i++) assert.equal((await signIn(ui.url, 'alex', `wrong-${i}-xx`)).status, 401);
  const fifth = await signIn(ui.url, 'alex', 'wrong-5-xx');
  assert.equal(fifth.status, 429);
  assert.match(await fifth.text(), /Too many tries\. Wait 15 minutes, then try again\./);
  const right = await signIn(ui.url, 'alex', PW);
  assert.equal(right.status, 429, 'even the right password waits');
  assert.equal(right.headers.get('set-cookie'), null);
  // X-Forwarded-For is ignored without TRUST_PROXY, so it can't dodge the address lock.
  const spoof = await fetch(`${ui.url}/signin`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '9.9.9.9' }, body: new URLSearchParams({ username: 'other', password: 'whatever-1' }) });
  assert.equal(spoof.status, 429);
});

test('auth: no file outside the fonts folder opens without signing in, however the path is spelled', async () => {
  const ui = await authUi();
  for (const path of ['/fonts/..%2fapp.js', '/fonts/%2e%2e/app.js', '/fonts/..%2findex.html', '/fonts/..%2fguide.html', '/signin.js/..%2fapp.js', '/fonts/']) {
    const r = await get(`${ui.url}${path}`);
    assert.ok([302, 401, 403, 404].includes(r.status), `${path} → ${r.status}`);
    assert.doesNotMatch(await r.text(), /followBottom|<nav class="tabs"|import /, `${path} must not leak page code`);
  }
});

test('auth: wrong tries from one address never lock out the right password from another', async () => {
  const ui = await authUi({ TRUST_PROXY: '1' });
  const from = (ip, password) => fetch(`${ui.url}/signin`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, body: new URLSearchParams({ username: 'alex', password }) });
  for (let i = 0; i < 5; i++) await from('198.51.100.1', `wrong-${i}-xx`);
  assert.equal((await from('198.51.100.1', PW)).status, 429, 'the guessing address waits');
  assert.equal((await from('198.51.100.2', PW)).status, 303, 'someone else with the right password gets in');
});

test('auth: a burst of parallel wrong tries cannot get past the limit', async () => {
  const ui = await authUi();
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => signIn(ui.url, 'alex', `burst-${i}-xx`)));
  const checked = res.filter((r) => r.status === 401).length;
  assert.ok(checked <= 5, `only 5 tries were checked, not ${checked}`);
  assert.equal(res.filter((r) => r.status === 429).length, 20 - checked);
});

test('auth: other spellings of the inbound door get no special treatment', async () => {
  const ui = await authUi();
  for (const path of ['/A2A/jsonrpc', '/a2a/jsonrpc/', '/.well-known/agent-card.json/', '/.WELL-KNOWN/agent-card.json']) {
    const viaProxy = await get(`${ui.url}${path}`, null, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(viaProxy.status, 404, `${path} through a proxy`);
  }
  assert.equal((await get(`${ui.url}/.well-known/other.json`)).status, 302, 'only the agent card skips the sign-in, not all of .well-known');
});

test('auth: the local Hub still reaches the Student agent’s inbound door without signing in', async () => {
  const ui = await authUi();
  const card = await get(`${ui.url}/.well-known/agent-card.json`);
  assert.equal(card.status, 200);
  const proxied = await get(`${ui.url}/.well-known/agent-card.json`, null, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(proxied.status, 404, 'through a proxy it is hidden');
});

test('auth config: listening wide needs the sign-in; AUTH must be on/off; PUBLIC_ORIGIN is checked', () => {
  assert.deepEqual(authConfig({}).auth, false);
  assert.equal(authConfig({}).host, '127.0.0.1');
  assert.throws(() => authConfig({ UI_HOST: '0.0.0.0', AUTH: 'off' }), AuthConfigError);
  assert.equal(authConfig({ UI_HOST: '0.0.0.0' }).auth, true, 'wide turns the sign-in on by default');
  assert.throws(() => authConfig({ AUTH: 'yes' }), AuthConfigError);
  assert.throws(() => authConfig({ PUBLIC_ORIGIN: 'agenthub.example.org' }), AuthConfigError);
  assert.throws(() => authConfig({ PUBLIC_ORIGIN: 'https://agenthub.example.org' }), /TRUST_PROXY=1/, 'behind a front server the gate must see real addresses');
  const pub = authConfig({ PUBLIC_ORIGIN: 'https://agenthub.example.org', TRUST_PROXY: '1' });
  assert.equal(pub.auth, true); assert.equal(pub.secure, true);
});

test('auth: adding, removing and changing accounts takes effect without a restart', async () => {
  const ui = await authUi();
  const alex = cookieFrom(await signIn(ui.url, 'alex', PW));
  assert.equal((await get(`${ui.url}/api/status`, alex)).status, 200);
  const sam = { username: 'sam', ...(await hashPassword('sam-pass-123')) };
  saveAccess(ui.accessFile, [{ username: 'alex', ...(await hashPassword(PW)) }, sam]); // alex's password changed too
  await waitFor(() => /accounts reloaded: 2 account\(s\), 1 added, 1 removed or changed, 1 session\(s\) signed out/.test(ui.output()), { timeout: 8000, what: 'the reload line' });
  assert.equal((await get(`${ui.url}/api/status`, alex)).status, 401, 'a changed password signs that account out');
  assert.equal((await signIn(ui.url, 'sam', 'sam-pass-123')).status, 303, 'a new account works at once');
  const samCookie = cookieFrom(await signIn(ui.url, 'sam', 'sam-pass-123'));
  saveAccess(ui.accessFile, []);
  await waitFor(() => /accounts reloaded: 0 account\(s\)/.test(ui.output()), { timeout: 8000, what: 'the second reload' });
  assert.equal((await get(`${ui.url}/api/status`, samCookie)).status, 401, 'a removed account is signed out at once');
  assert.equal((await signIn(ui.url, 'sam', 'sam-pass-123')).status, 401);
  assert.doesNotMatch(ui.output(), /sam-pass-123|[0-9a-f]{64}/, 'no password or hash in the log');
});

test('auth: signing out closes that session’s live stream at once; pages and data are never kept by the browser', async () => {
  const ui = await authUi();
  const cookie = cookieFrom(await signIn(ui.url, 'alex', PW));
  for (const path of ['/api/status', '/conversation', '/auth/me']) {
    const r = await get(`${ui.url}${path}`, cookie);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
  }
  const stream = await fetch(`${ui.url}/api/ui/stream?monitor=0&student=0`, { headers: { cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read(); // the stream is open
  const t0 = Date.now();
  await fetch(`${ui.url}/signout`, { method: 'POST', redirect: 'manual', headers: { cookie } });
  let ended = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const { done } = await reader.read(); if (done) { ended = true; break; } }
  assert.ok(ended, 'the stream ended');
  assert.ok(Date.now() - t0 < 5000, 'within seconds, not a minute');
});
