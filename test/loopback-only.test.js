// Part 18 (owner, 2026-11-07: “Since we have agents on various systems and ports are they going to be also secured”):
// the nine back-end servers listen on 127.0.0.1 only; only the UI server may listen wider, and only with the sign-in.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { startUi, waitFor } from './support/harness.js';
import { hashPassword, saveAccess } from '../src/access.js';
import { lanAddresses } from '../src/auth-gate.js';

const procs = [];
after(() => { for (const p of procs) p.proc.kill(); });

test('loopback only: every back-end server binds 127.0.0.1; only the UI reads UI_HOST', () => {
  const listeners = readdirSync('src').filter((f) => f.endsWith('.js')).filter((f) => /\.listen\(/.test(readFileSync(join('src', f), 'utf8')));
  assert.ok(listeners.length >= 10, `found ${listeners.join(', ')}`);
  for (const f of listeners) {
    const src = readFileSync(join('src', f), 'utf8');
    if (f === 'ui-server.js') {
      assert.match(src, /app\.listen\(port, authCfg\.host,/);
      continue;
    }
    assert.match(src, /^const HOST = '127\.0\.0\.1';/m, f);
    assert.match(src, /\.listen\([^,]+, HOST,/, f);
    assert.doesNotMatch(src, /UI_HOST/, f);
  }
});

test('loopback only: the UI refuses to listen wide without the sign-in, or with an unreadable accounts file', () => {
  const run = (env) => spawnSync(process.execPath, ['src/ui-server.js'], { env: { ...process.env, UI_PORT: '0', HUB_URL: 'http://127.0.0.1:9', ...env }, encoding: 'utf8', timeout: 15000 });
  const off = run({ UI_HOST: '0.0.0.0', AUTH: 'off' });
  assert.equal(off.status, 1);
  assert.match(off.stderr, /\[UI\] refusing to listen on 0\.0\.0\.0 without sign-in/);
  const dir = mkdtempSync(join(tmpdir(), 'acc-'));
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  const bad = run({ UI_HOST: '0.0.0.0', AGENTHUB_ACCESS_FILE: join(dir, 'bad.json') });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\[UI\] refusing to start: the accounts file is not valid JSON/);
});

const lan = lanAddresses()[0];
test('loopback only: opened by the machine\'s IP, everything needs the sign-in and the inbound A2A door is hidden', { skip: !lan && 'no network address on this machine' }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'acc-')), 'access.json');
  saveAccess(file, [{ username: 'alex', ...(await hashPassword('demo-pass-123')) }]);
  const ui = await startUi('http://127.0.0.1:9', { UI_HOST: '0.0.0.0', AGENTHUB_ACCESS_FILE: file });
  procs.push(ui);
  const port = new URL(ui.url).port;
  const also = new RegExp(`\\[UI\\] also on http://${lan.replace(/\./g, '\\.')}:${port} \\(sign-in required\\)`);
  await waitFor(() => also.test(ui.output()), { what: 'the also-on line' });
  const base = `http://${lan}:${port}`;
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/signin`)).status, 200, 'the machine\'s own IP is an accepted Host');
  assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status, 404, 'not from the network');
  assert.equal((await fetch(`${ui.url}/.well-known/agent-card.json`)).status, 200, 'still from this machine');
  // fetch() drops a custom Host header, so this one goes through node:http.
  const status = await new Promise((resolve, reject) => {
    request({ host: lan, port, path: '/signin', headers: { host: `evil.example:${port}` } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject).end();
  });
  assert.equal(status, 421, 'any other Host name is still refused');
});
