import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashPassword, verify, normalUser, loadAccess, saveAccess, AccessError } from '../src/access.js';

const PW = 'demo-pass-123';

test('access: right password verifies, wrong and unknown do not', async () => {
  const users = [{ username: 'alex', ...(await hashPassword(PW)) }];
  assert.equal(await verify(users, 'alex', PW), true);
  assert.equal(await verify(users, 'ALEX', PW), true, 'usernames are case-insensitive');
  assert.equal(await verify(users, 'alex', 'nope-nope'), false);
  assert.equal(await verify(users, 'nobody', PW), false);
  assert.equal(await verify(users, 'bad name', PW), false);
});

test('access: usernames are normalised or refused', () => {
  assert.equal(normalUser(' Farsheed '), 'farsheed');
  assert.equal(normalUser('Bad Name'), null);
  assert.equal(normalUser(''), null);
  assert.equal(normalUser('x'.repeat(33)), null);
});

test('access: the saved file has no password, mode 0600, and loads back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const file = join(dir, 'access.json');
  saveAccess(file, [{ username: 'alex', ...(await hashPassword(PW)) }]);
  assert.ok(!readFileSync(file, 'utf8').includes(PW));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadAccess(file)[0].username, 'alex');
  assert.deepEqual(loadAccess(join(dir, 'missing.json'), { missingOk: true }), []);
  assert.throws(() => loadAccess(join(dir, 'missing.json')), AccessError);
});

test('access CLI: add from stdin, list, remove; never prints the password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-cli-'));
  const env = { ...process.env, AGENTHUB_ACCESS_FILE: join(dir, 'a.json') };
  const run = (args, input) => spawnSync(process.execPath, ['scripts/access.js', ...args], { env, input, encoding: 'utf8' });
  const add = run(['add', 'Alex'], `${PW}\n`);
  assert.equal(add.status, 0, add.stderr);
  assert.ok(!add.stdout.includes(PW));
  assert.equal(run(['list']).stdout.trim(), 'alex');
  assert.equal(run(['add', 'sam'], 'short\n').status, 1, 'too short is refused');
  assert.equal(run(['remove', 'alex']).status, 0);
  assert.equal(run(['list']).stdout.trim(), '(no accounts)');
});
