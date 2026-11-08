// Part 18 (owner, 2026-11-07: “I dont want people to be able to get to it so I want to add a sigin page”):
// the short list of accounts that may open the demo. One login opens the whole demo (“this is one login to get
// to the demo so that people can demo the full system”). Passwords are never stored — only a salted scrypt hash.
// The file is git-ignored (config/access.json, or AGENTHUB_ACCESS_FILE). Dependency-free.
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_ACCESS_FILE = 'config/access.json';
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
export const MIN_PASSWORD = 8;

export class AccessError extends Error {}

const derive = (password, salt) => new Promise((resolve, reject) => {
  scrypt(String(password), Buffer.from(salt, 'hex'), KEYLEN, PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
});

// Lowercased; letters, digits, dot, underscore, dash; 1–32 characters. Anything else is not a username.
export function normalUser(name) {
  const u = String(name ?? '').trim().toLowerCase();
  return /^[a-z0-9._-]{1,32}$/.test(u) ? u : null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(password, salt)).toString('hex') };
}

// A made-up account, so an unknown username costs one scrypt like a real one (no timing hint that it doesn't exist).
const DUMMY = { salt: '00'.repeat(16), hash: '00'.repeat(KEYLEN) };

export async function verify(users, username, password) {
  const u = normalUser(username);
  const found = u ? users.find((x) => x.username === u) : null;
  const rec = found ?? DUMMY;
  const key = await derive(password ?? '', rec.salt);
  const want = Buffer.from(rec.hash, 'hex');
  return Boolean(found) && want.length === key.length && timingSafeEqual(want, key);
}

export function loadAccess(file = DEFAULT_ACCESS_FILE, { missingOk = false } = {}) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (err) {
    if (missingOk && err.code === 'ENOENT') return [];
    throw new AccessError(`can't read the accounts file (${err.code ?? 'error'})`);
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new AccessError('the accounts file is not valid JSON'); }
  const users = Array.isArray(data?.users) ? data.users : null;
  if (!users) throw new AccessError('the accounts file has no "users" list');
  const ok = (h, n) => typeof h === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(h);
  for (const x of users) {
    if (normalUser(x?.username) !== x?.username || !ok(x.salt, 32) || !ok(x.hash, KEYLEN * 2)) throw new AccessError('the accounts file has a bad entry');
  }
  return users.map(({ username, salt, hash }) => ({ username, salt, hash }));
}

export function saveAccess(file, users) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
