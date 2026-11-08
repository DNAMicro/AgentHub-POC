// Part 18: signed-in sessions and the wrong-tries limiter, in memory only (a restart signs everyone out — the same
// memory-only rule as loans, HR and Canvas records). Session ids are 32 random bytes; never logged or emitted.
import { randomBytes } from 'node:crypto';

export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;   // 12 hours after sign-in
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;   // or 2 hours without a request
export const MAX_FAILS = 5;
export const FAIL_WINDOW_MS = 15 * 60 * 1000;        // 5 wrong tries in 15 minutes …
export const LOCK_MS = 15 * 60 * 1000;               // … lock that username / address for 15 minutes

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
  const limiter = {
    locked: (keys) => { const t = now(); return keys.some((k) => (fails.get(k)?.lockedUntil ?? 0) > t); },
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
  return { create, get, end, limiter, size: () => sessions.size };
}
