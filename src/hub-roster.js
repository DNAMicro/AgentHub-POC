// Part 17: the Hub's roster client. A post to "all" (or to a tagged student) is addressed from the course roster that
// CHRS gets from the student-records stand-in — never from a list the Hub, the Faculty agent or the browser keeps.
//
//   Hub -> CHRS  roster_lookup { courseId, instructorStaffId } signed by the HUB ITSELF (registry.signRosterLookupFor).
//   CHRS -> Hub  { studentIds, names: { id: "First Last" }, count }  or  { error, text }.
//
// Review C13: every send reads the roster FRESH from CHRS (add/drop changes it) — get(courseId, { fresh: true }). The
// last result is kept in memory for 60 s only for the Faculty header's counts (cached(), read by the 3 s status poll,
// which never starts a lookup); cleared on classroom reset. A lookup already in flight is shared. Nothing is written to
// disk, nothing is logged, and events carry counts only (rosterCount) — never an ID, name or email. A failed lookup is
// never replaced by a fallback list; callers refuse with `roster_unavailable`.
//
// Review C16: email(...) asks CHRS to email the students a post couldn't reach in the app — signed by the Hub's own key
// (registry.signEmailNoticeFor). CHRS reads the addresses itself; the Hub gets back per-student 'emailed' | 'failed'.
import { randomUUID } from 'node:crypto';
import { sendData } from './a2a-data.js';
import { EMAIL_NOTICE_MEDIA_TYPE, ROSTER_LOOKUP_MEDIA_TYPE } from './staff.js';
import { TIMEOUTS } from './timeouts.js';

const ID = /^[\w-]{1,64}$/;
const FAIL_CODES = new Set(['not_configured', 'chrs_not_ready', 'not_signed', 'not_delivered', 'uncertain', 'roster_unavailable', 'refused', 'bad_reply']);

export function createRosterClient({ cfg, registry, emit = () => {}, now = () => Date.now(), ttlMs = Number(process.env.HUB_ROSTER_TTL_MS ?? 60000), timeoutMs = Number(process.env.HUB_ROSTER_LOOKUP_TIMEOUT_MS ?? TIMEOUTS.hubRosterLookupMs), emailTimeoutMs = Number(process.env.HUB_EMAIL_NOTICE_TIMEOUT_MS ?? TIMEOUTS.hubEmailNoticeMs) }) {
  const cache = new Map(); // courseId → { at, roster }
  const inFlight = new Map(); // courseId → Promise<result>
  const generation = { n: 0 };
  const chrsAgent = () => Object.values(cfg.destinations ?? {}).find((d) => d.audience === 'staff' && d.worker === 'chrs')?.worker ?? null;

  async function fetchRoster(courseId) {
    const course = cfg.courses?.[courseId];
    const agentId = chrsAgent();
    const instructorStaffId = course ? cfg.staff?.[course.professor]?.staffId : null;
    // `code` is one of a fixed set (never CHRS's own words), so it passes the Hub's telemetry allowlist.
    const fail = (reason) => { const code = FAIL_CODES.has(reason) ? reason : 'bad_reply'; emit('roster_lookup_failed', { courseId, service: 'chrs', code }); return { ok: false, reason: code }; };
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
  // `fromCache: true` marks a roster served from the cache (the caller may re-check it once with fresh: true).
  // fresh: skip the cache (a tagged student who isn't on the cached roster is checked against a new lookup).
  // Only a post or a roster request calls this; the status view reads cached() and never starts a lookup.
  async function get(courseId, { fresh = false } = {}) {
    const hit = cache.get(courseId);
    if (hit && !fresh && now() - hit.at < ttlMs) return { ok: true, roster: hit.roster, fromCache: true };
    let p = inFlight.get(courseId);
    if (!p) {
      const gen = generation.n;
      p = fetchRoster(courseId).then((res) => {
        if (gen === generation.n) { // a reset while it was in flight: don't keep what it fetched
          if (res.ok) cache.set(courseId, { at: now(), roster: res.roster });
        }
        return res;
      }).finally(() => { if (inFlight.get(courseId) === p) inFlight.delete(courseId); });
      inFlight.set(courseId, p);
    }
    return p;
  }

  // Review C16: email a post to the students it couldn't reach in the app. → { ok: true, results: { id: 'emailed' | 'failed' } }
  // or { ok: false, reason } (then nobody was emailed, as far as the Hub knows). Counts only in events.
  async function email({ courseId, operationId, studentIds, title, text }) {
    const course = cfg.courses?.[courseId];
    const agentId = chrsAgent();
    const instructorStaffId = course ? cfg.staff?.[course.professor]?.staffId : null;
    const fail = (reason) => { const code = FAIL_CODES.has(reason) ? reason : 'bad_reply'; emit('email_fallback_failed', { courseId, service: 'chrs', code, recipients: studentIds.length }); return { ok: false, reason: code }; };
    if (!studentIds.length) return { ok: true, results: {} };
    if (!course || !agentId || !instructorStaffId) return fail('not_configured');
    if (!registry.isReady(agentId)) return fail('chrs_not_ready');
    const hubSignature = registry.signEmailNoticeFor(agentId, { courseId, instructorStaffId, operationId, studentIds, title, text });
    if (!hubSignature) return fail('not_signed');
    emit('email_fallback_started', { courseId, service: 'chrs', operationId, recipients: studentIds.length });
    const r = await sendData(registry.peer(agentId).baseUrl, {
      mediaType: EMAIL_NOTICE_MEDIA_TYPE,
      value: { type: 'email_notice', courseId, instructorStaffId, studentIds, title, text },
      metadata: { hubOperationId: operationId, hubSignature },
      timeoutMs: emailTimeoutMs,
    });
    const got = r.ok && r.value?.results && typeof r.value.results === 'object' ? r.value.results : null;
    if (!got) return fail(!r.ok ? r.outcome : r.value?.error ?? 'bad_reply');
    // Only the students asked about, and only the two known answers; anything else counts as not emailed.
    const results = Object.fromEntries(studentIds.map((id) => [id, got[id] === 'emailed' ? 'emailed' : 'failed']));
    const emailedCount = Object.values(results).filter((x) => x === 'emailed').length;
    emit('email_fallback_sent', { courseId, service: 'chrs', operationId, emailedCount, emailFailedCount: studentIds.length - emailedCount });
    return { ok: true, results };
  }

  return {
    get,
    email,
    cached: (courseId) => { const hit = cache.get(courseId); return hit && now() - hit.at < ttlMs ? hit.roster : null; },
    reset() { generation.n += 1; cache.clear(); inFlight.clear(); },
  };
}
