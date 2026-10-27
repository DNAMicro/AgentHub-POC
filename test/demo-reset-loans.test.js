// Demo v2: the pre-talk loan reset command (scripts/demo/reset-loans.js). Temp files only — never data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { resetLoans } from '../scripts/demo/reset-loans.js';
import { unusedPort } from './support/harness.js';

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'reset-loans-'));
  const from = join(dir, 'before.json');
  const to = join(dir, 'loans.json');
  writeFileSync(from, '{"a":1}');
  writeFileSync(to, '{"b":2}');
  return { from, to };
}

test('copies the snapshot over the loan file', async () => {
  const { from, to } = files();
  assert.deepEqual(await resetLoans({ from, to, libraryPort: await unusedPort() }), { ok: true, to });
  assert.deepEqual(JSON.parse(readFileSync(to, 'utf8')), { a: 1 });
});

test('refuses while a Library is listening', async () => {
  const { from, to } = files();
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    assert.deepEqual(await resetLoans({ from, to, libraryPort: server.address().port }), { ok: false, reason: 'library_running' });
    assert.deepEqual(JSON.parse(readFileSync(to, 'utf8')), { b: 2 });
  } finally {
    server.close();
  }
});

test('refuses when the snapshot is missing', async () => {
  const { to } = files();
  assert.deepEqual(await resetLoans({ from: `${to}.missing`, to, libraryPort: await unusedPort() }), { ok: false, reason: 'missing_source' });
});
