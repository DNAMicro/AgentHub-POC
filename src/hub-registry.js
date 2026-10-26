// Part 7: the University Hub's PRIVATE specialist registry.
//
// Destinations come only from the Hub's configuration (allowlisted identities and trusted endpoints).
// A specialist registers (application message over A2A), the Hub checks the claimed identity and
// endpoint against its allowlist, fetches the card from the configured URL and validates it before
// enabling dispatch. Registered, enabled, reachable, heartbeat freshness and readiness are tracked
// separately — registration alone never means "online".
//
// Storage is a plain in-memory Map behind this small interface, so a durable store could replace it.
import { signStudent } from './hub-link.js';
import { getCard, validateCard } from './cards.js';

export const STATUS = { ready: 'ready', stale: 'stale', unreachable: 'unreachable', disconnected: 'disconnected', disabled: 'disabled', invalid: 'invalid_card' };

export function createHubRegistry({ peers, expiryMs, cardFetchMs = 3000, onEvent = () => {}, now = () => Date.now() }) {
  const entries = new Map(peers.map((peer) => [peer.agentId, {
    peer, registered: false, instanceId: null, enabled: null, registeredAt: null, lastHeartbeatAt: null,
    card: null, view: null, etag: null, revision: null, cardStatus: 'none', reachable: null, lastError: null,
    refreshing: null, again: false, status: STATUS.disconnected, seenNotices: new Set(),
  }]));

  const expired = (e) => !e.lastHeartbeatAt || now() - e.lastHeartbeatAt > expiryMs;
  function computeStatus(e) {
    if (!e.registered) return STATUS.disconnected;
    if (expired(e)) return STATUS.stale;
    if (e.cardStatus === 'invalid') return STATUS.invalid;
    if (!e.card || e.reachable === false) return STATUS.unreachable;
    if (!e.enabled || !e.view?.skills.length) return STATUS.disabled;
    return STATUS.ready;
  }
  function update(e, reason) {
    const next = computeStatus(e);
    if (next === e.status) return;
    const from = e.status;
    e.status = next;
    onEvent('registry_status', { agentId: e.peer.agentId, from, status: next, reason, ...snapshotOf(e) });
  }

  async function fetchCard(e, reason) {
    try {
      const res = await getCard(e.peer.cardUrl, e.card ? e.etag : null, cardFetchMs);
      if (res.status === 304) {
        e.reachable = true;
        onEvent('card_refreshed', { agentId: e.peer.agentId, reason, changed: false, revision: e.revision });
        return;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status} from the card URL`);
      let card;
      try { card = JSON.parse(res.body); } catch { throw Object.assign(new Error('Agent Card is not valid JSON.'), { invalidCard: true }); }
      const checked = validateCard(card, e.peer);
      if (!checked.ok) throw Object.assign(new Error(checked.error), { invalidCard: true });
      // Atomic replacement of the card-derived fields.
      Object.assign(e, { card, view: checked.view, etag: res.etag, revision: checked.view.revision, cardStatus: 'ok', reachable: true, lastError: null });
      onEvent('card_refreshed', { agentId: e.peer.agentId, reason, changed: true, revision: e.revision, etag: e.etag, skills: e.view.skills.map((s) => ({ id: s.id, name: s.name })) });
    } catch (err) {
      // Keep the last good card; a failed refresh never invents skills.
      if (err.invalidCard) e.cardStatus = 'invalid';
      else e.reachable = false;
      e.lastError = err.invalidCard ? err.message : err.code === 'ECONNREFUSED' ? 'Agent offline (connection refused)' : err.message;
      onEvent('card_refresh_failed', { agentId: e.peer.agentId, reason, error: e.lastError });
    }
  }
  // Coalesced: concurrent refresh requests share one fetch plus at most one follow-up.
  function refresh(agentId, reason) {
    const e = entries.get(agentId);
    if (!e) return Promise.resolve(false);
    if (e.refreshing) {
      e.again = true;
      return e.refreshing;
    }
    e.refreshing = (async () => {
      do {
        e.again = false;
        await fetchCard(e, reason);
      } while (e.again);
      e.refreshing = null;
      update(e, reason);
      return e.status === STATUS.ready;
    })();
    return e.refreshing;
  }

  const snapshotOf = (e) => ({
    agentId: e.peer.agentId, displayName: e.peer.displayName, role: e.peer.agentId === 'tutor' ? 'Tutoring specialist' : e.peer.agentId === 'library' ? 'Library specialist' : 'Specialist',
    status: e.status, registered: e.registered, enabled: e.enabled, reachable: e.reachable, cardStatus: e.cardStatus,
    lastHeartbeatAt: e.lastHeartbeatAt ? new Date(e.lastHeartbeatAt).toISOString() : null,
    registeredAt: e.registeredAt ? new Date(e.registeredAt).toISOString() : null,
    revision: e.revision, etag: e.etag, instance: e.instanceId ? e.instanceId.slice(0, 8) : null,
    skills: (e.view?.skills ?? []).map((s) => ({ id: s.id, name: s.name })), lastError: e.lastError,
  });

  // Periodic expiry check: a specialist that stops beating becomes stale (no new dispatches).
  const ticker = setInterval(() => { for (const e of entries.values()) update(e, 'heartbeat_check'); }, Math.max(200, Math.floor(expiryMs / 4)));
  ticker.unref?.();

  return {
    has: (agentId) => entries.has(agentId),
    peer: (agentId) => entries.get(agentId)?.peer ?? null,
    entry: (agentId) => entries.get(agentId) ?? null,
    // Sign the student identity forwarded to a registered specialist (null if it gave no key).
    signFor(agentId, fields) {
      const key = entries.get(agentId)?.callKey;
      return key ? signStudent(key, fields) : null;
    },
    isReady: (agentId) => entries.get(agentId)?.status === STATUS.ready,
    status: (agentId) => entries.get(agentId)?.status ?? null,
    snapshot: () => [...entries.values()].map(snapshotOf),
    refresh,
    stop: () => clearInterval(ticker),

    // ---- control messages (application conventions over A2A) -------------------------------------
    async register(msg) {
      const e = entries.get(msg?.agentId);
      if (!e) return { status: 'rejected', reason: 'unknown_peer: this identity is not on the Hub’s allowlist.' };
      if (msg.endpoint !== e.peer.rpcUrl || msg.cardUrl !== e.peer.cardUrl) {
        return { status: 'rejected', reason: 'unexpected_endpoint: the claimed endpoint does not match the Hub’s configuration for this identity.' };
      }
      if (typeof msg.instanceId !== 'string' || !/^[\w-]{8,64}$/.test(msg.instanceId)) return { status: 'rejected', reason: 'malformed instanceId.' };
      // Duplicate identity takeover: a second live instance can't replace the registered one.
      if (e.registered && e.instanceId !== msg.instanceId && !expired(e)) {
        return { status: 'rejected', reason: 'identity_in_use: another instance with this identity is registered and alive.' };
      }
      // The specialist's signing key for forwarded identities (in memory only; never in snapshots or events).
      const callKey = typeof msg.callKey === 'string' && /^[\w-]{40,64}$/.test(msg.callKey) ? msg.callKey : null;
      Object.assign(e, { registered: true, instanceId: msg.instanceId, enabled: msg.enabled !== false, registeredAt: now(), lastHeartbeatAt: now(), reachable: null, callKey });
      onEvent('registration_accepted', { agentId: e.peer.agentId, instance: msg.instanceId.slice(0, 8), enabled: e.enabled });
      // Verify before enabling dispatch: fetch the card from the CONFIGURED URL and validate it.
      await refresh(e.peer.agentId, 'registration');
      return { status: 'registered', readiness: e.status };
    },
    heartbeat(msg) {
      const e = entries.get(msg?.agentId);
      if (!e || !e.registered || e.instanceId !== msg.instanceId) return { status: 'not_registered' };
      e.lastHeartbeatAt = now();
      e.enabled = msg.enabled !== false;
      onEvent('heartbeat', { agentId: e.peer.agentId });
      if (e.reachable === false || e.status === STATUS.stale) refresh(e.peer.agentId, 'heartbeat_recovered');
      else update(e, 'heartbeat');
      return { status: 'ok', readiness: e.status };
    },
    deregister(msg) {
      const e = entries.get(msg?.agentId);
      if (!e || e.instanceId !== msg.instanceId) return { status: 'ignored' };
      e.registered = false;
      update(e, 'deregistered');
      return { status: 'deregistered' };
    },
    cardChanged(notice) {
      const e = entries.get(notice?.agentId);
      if (!e) return { status: 'rejected', reason: 'unknown_sender' };
      if (!e.registered || e.instanceId !== notice.instanceId) return { status: 'rejected', reason: 'not_registered: register before sending card changes.' };
      if (typeof notice.notificationId !== 'string' || !/^[\w-]{8,100}$/.test(notice.notificationId)) return { status: 'rejected', reason: 'malformed notificationId' };
      if (e.seenNotices.has(notice.notificationId)) return { status: 'duplicate' };
      e.seenNotices.add(notice.notificationId);
      if (e.seenNotices.size > 200) e.seenNotices.delete(e.seenNotices.values().next().value);
      // Fetch the CURRENT card from the trusted URL — never apply anything from the notice itself.
      refresh(e.peer.agentId, 'card_changed');
      return { status: 'received' };
    },
    // Dispatch outcomes feed reachability (a failed dispatch makes the specialist unreachable).
    markReachable(agentId, ok, error) {
      const e = entries.get(agentId);
      if (!e) return;
      e.reachable = ok;
      if (!ok) e.lastError = error;
      update(e, ok ? 'dispatch_ok' : 'dispatch_failed');
    },
    // What the router may see: skills and availability — never URLs.
    routingView: () => [...entries.values()].filter((e) => e.view).map((e) => ({
      agentId: e.peer.agentId, name: e.peer.displayName, available: e.status === STATUS.ready, status: e.status,
      skills: e.view.skills.map(({ id, name, description, tags, examples, allowed, excluded }) => ({ id, name, description, tags, examples, allowed, excluded })),
    })),
  };
}
