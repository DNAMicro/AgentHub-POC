// Part 18: signed-in sessions and the wrong-tries limiter, in memory only (a restart signs everyone out — the same
// memory-only rule as loans, HR and Canvas records). Session ids are 32 random bytes; never logged or emitted.
import { randomBytes } from 'node:crypto';

export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;   // 12 hours after sign-in
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;   // or 2 hours without a request
export const MAX_FAILS = 5;
export const FAIL_WINDOW_MS = 15 * 60 * 1000;        // 5 wrong tries in 15 minutes …
export const LOCK_MS = 15 * 60 * 1000;               // … lock that address (or username from that address) for 15 minutes
export const ACCOUNT_SOFT = 20;                      // more than this many wrong tries on one account, from anywhere …
export const ACCOUNT_STEP_MS = 1000;                 // … and each further try waits 1 s longer, up to …
export const ACCOUNT_MAX_DELAY_MS = 10_000;          // … 10 s. Slows guessing; never locks the right password out.

export function createSessions({ now = Date.now } = {}) {
  const sessions = new Map();
  const fails = new Map(); // key → { times: [...], lockedUntil }

  const alive = (s, t) => t - s.created <= SESSION_MAX_MS && t - s.lastSeen <= SESSION_IDLE_MS;

  const create = (username) => {
    const id = randomBytes(32).toString('base64url');
    const t = now();
    sessions.set(id, { username, created: t, lastSeen: t });
    // Drop expired sessions now and then so the map can't grow without end.
    if (sessions.size % 50 === 0) for (const [k, s] of sessions) if (!alive(s, t)) sessions.delete(k);
    return id;
  };
  // peek: check without counting as activity (the stream re-check must not keep a session alive by itself).
  const get = (id, { peek = false } = {}) => {
    if (typeof id !== 'string' || !id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    const t = now();
    if (!alive(s, t)) { sessions.delete(id); return null; }
    if (!peek) s.lastSeen = t;
    return { username: s.username };
  };
  const end = (id) => { sessions.delete(id); };

  const entry = (key, t) => {
    const e = fails.get(key) ?? { times: [], lockedUntil: 0 };
    e.times = e.times.filter((x) => t - x < FAIL_WINDOW_MS);
    return e;
  };
  // Tries still being checked count too, so a burst of parallel guesses can't all slip past the lock check.
  const pending = new Map();
  const over = (k, t) => (fails.get(k)?.lockedUntil ?? 0) > t || entry(k, t).times.length + (pending.get(k) ?? 0) >= MAX_FAILS;
  const limiter = {
    locked: (keys) => { const t = now(); return keys.some((k) => (fails.get(k)?.lockedUntil ?? 0) > t); },
    // begin(keys) → null when locked or at the limit with tries in flight; else done(ok) to call once the check ends.
    begin: (keys) => {
      const t = now();
      if (keys.some((k) => over(k, t))) return null;
      for (const k of keys) pending.set(k, (pending.get(k) ?? 0) + 1);
      let ended = false;
      return (ok) => {
        if (ended) return;
        ended = true;
        for (const k of keys) { const n = (pending.get(k) ?? 1) - 1; if (n > 0) pending.set(k, n); else pending.delete(k); }
        if (!ok) limiter.fail(keys);
      };
    },
    fail: (keys) => {
      const t = now();
      for (const k of keys) {
        const e = entry(k, t);
        e.times.push(t);
        if (e.times.length >= MAX_FAILS) { e.lockedUntil = t + LOCK_MS; e.times = []; }
        fails.set(k, e);
      }
      if (fails.size > 10000) for (const [k, e] of fails) if (e.lockedUntil <= t && !e.times.some((x) => t - x < FAIL_WINDOW_MS)) fails.delete(k);
    },
    clear: (key) => { fails.delete(key); },
  };
  // Per account, across all addresses: a growing delay, not a lock (a lock would let anyone keep the shared account out).
  const accountFails = new Map();
  const account = {
    fail: (key) => {
      const t = now();
      const times = (accountFails.get(key) ?? []).filter((x) => t - x < FAIL_WINDOW_MS);
      times.push(t);
      accountFails.set(key, times.slice(-1000));
      if (accountFails.size > 10000) for (const [k, v] of accountFails) if (!v.some((x) => t - x < FAIL_WINDOW_MS)) accountFails.delete(k);
    },
    delayFor: (key) => {
      const t = now();
      const n = (accountFails.get(key) ?? []).filter((x) => t - x < FAIL_WINDOW_MS).length;
      return n < ACCOUNT_SOFT ? 0 : Math.min(ACCOUNT_MAX_DELAY_MS, (n - ACCOUNT_SOFT + 1) * ACCOUNT_STEP_MS);
    },
  };
  return { create, get, end, limiter, account, size: () => sessions.size };
}
