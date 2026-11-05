// Part 17: the Hub's roster client. A post to "all" (or to a tagged student) is addressed from the course roster that
// CHRS gets from the student-records stand-in — never from a list the Hub, the Faculty agent or the browser keeps.
//
//   Hub -> CHRS  roster_lookup { courseId, instructorStaffId } signed by the HUB ITSELF (registry.signRosterLookupFor).
//   CHRS -> Hub  { studentIds, names: { id: "First Last" }, count }  or  { error, text }.
//
// The Hub keeps one roster per course in memory for 60 s (cleared on classroom reset); a lookup already in flight is
// shared. Nothing is written to disk, nothing is logged, and events carry counts only (rosterCount) — never an ID,
// name or email. A failed lookup is never replaced by a fallback list; callers refuse with `roster_unavailable`.
import { randomUUID } from 'node:crypto';
import { sendData } from './a2a-data.js';
import { ROSTER_LOOKUP_MEDIA_TYPE } from './staff.js';
import { TIMEOUTS } from './timeouts.js';

const ID = /^[\w-]{1,64}$/;

export function createRosterClient({ cfg, registry, emit = () => {}, now = () => Date.now(), ttlMs = Number(process.env.HUB_ROSTER_TTL_MS ?? 60000), timeoutMs = Number(process.env.HUB_ROSTER_LOOKUP_TIMEOUT_MS ?? TIMEOUTS.hubRosterLookupMs), failedMs = 5000 }) {
  const cache = new Map(); // courseId → { at, roster }
  const inFlight = new Map(); // courseId → Promise<result>
  const failedAt = new Map(); // courseId → when the last lookup failed (only the polling view honours it)
  const generation = { n: 0 };
  const chrsAgent = () => Object.values(cfg.destinations ?? {}).find((d) => d.audience === 'staff' && d.worker === 'chrs')?.worker ?? null;

  async function fetchRoster(courseId) {
    const course = cfg.courses?.[courseId];
    const agentId = chrsAgent();
    const instructorStaffId = course ? cfg.staff?.[course.professor]?.staffId : null;
    const fail = (reason) => { emit('roster_lookup_failed', { courseId, service: 'chrs', reason }); return { ok: false, reason }; };
    if (!course || !agentId || !instructorStaffId || !ID.test(courseId) || !ID.test(instructorStaffId)) return fail('not_configured');
    if (!registry.isReady(agentId)) return fail('chrs_not_ready');
    const operationId = randomUUID();
    const hubSignature = registry.signRosterLookupFor(agentId, { courseId, instructorStaffId, operationId });
    if (!hubSignature) return fail('not_signed');
    const peer = registry.peer(agentId);
    emit('roster_lookup_started', { courseId, service: 'chrs', operationId });
    const r = await sendData(peer.baseUrl, {
      mediaType: ROSTER_LOOKUP_MEDIA_TYPE,
      value: { type: 'roster_lookup', courseId, instructorStaffId },
      metadata: { hubOperationId: operationId, hubSignature },
      timeoutMs,
    });
    const v = r.value;
    const ids = Array.isArray(v?.studentIds) ? v.studentIds : null;
    if (!r.ok || !ids || !ids.length || !ids.every((x) => typeof x === 'string' && ID.test(x)) || new Set(ids).size !== ids.length) {
      return fail(!r.ok ? r.outcome : v?.error ?? 'bad_reply');
    }
    const names = {};
    for (const id of ids) names[id] = typeof v.names?.[id] === 'string' ? v.names[id].slice(0, 80) : id;
    emit('roster_lookup_result', { courseId, service: 'chrs', ok: true, rosterCount: ids.length });
    return { ok: true, roster: { courseId, studentIds: ids, names } };
  }

  // { ok: true, roster: { courseId, studentIds, names } } or { ok: false, reason }.
  // fresh: skip the cache (a tagged student who isn't on the cached roster is checked against a new lookup).
  // quiet: the polling view; after a failure it doesn't ask again for a few seconds.
  async function get(courseId, { fresh = false, quiet = false } = {}) {
    const hit = cache.get(courseId);
    if (hit && !fresh && now() - hit.at < ttlMs) return { ok: true, roster: hit.roster };
    if (quiet && now() - (failedAt.get(courseId) ?? -Infinity) < failedMs) return { ok: false, reason: 'recently_failed' };
    let p = inFlight.get(courseId);
    if (!p) {
      const gen = generation.n;
      p = fetchRoster(courseId).then((res) => {
        if (gen === generation.n) { // a reset while it was in flight: don't keep what it fetched
          if (res.ok) { cache.set(courseId, { at: now(), roster: res.roster }); failedAt.delete(courseId); } else failedAt.set(courseId, now());
        }
        return res;
      }).finally(() => { if (inFlight.get(courseId) === p) inFlight.delete(courseId); });
      inFlight.set(courseId, p);
    }
    return p;
  }

  return {
    get,
    cached: (courseId) => { const hit = cache.get(courseId); return hit && now() - hit.at < ttlMs ? hit.roster : null; },
    reset() { generation.n += 1; cache.clear(); inFlight.clear(); failedAt.clear(); },
  };
}
