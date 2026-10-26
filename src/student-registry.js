// Student Agent's trusted service registry.
//
// Identity and network destinations come ONLY from the fixed local allowlist below.
// Agent Cards supply skill descriptions for routing; a fetched card must match the trusted
// identity, endpoint, protocol, and (absent) security settings or it is rejected and the last
// good card is kept. Nothing from a card, notification, or model output can add a destination.
import http from 'node:http';
import { SCOPE_EXTENSION_URI } from './skills.js';

const FETCH_TIMEOUT_MS = 3000;
const MAX_CARD_BYTES = 64 * 1024;

// GET the card with only the headers we choose. (Node's fetch adds "Cache-Control: no-cache" to
// any conditional request, which makes Express ignore If-None-Match — so no 304s.) No redirects
// are followed and the body size is capped.
function getCard(url, etag) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) }, timeout: FETCH_TIMEOUT_MS }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_CARD_BYTES) req.destroy(new Error('Agent Card is too large.'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag ?? null, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out fetching the card'), { name: 'TimeoutError' })));
    req.on('error', reject);
  });
}

// Fixed peer allowlist (trusted local configuration). Base URLs are overridable for tests.
export function trustedPeers({ tutorUrl, libraryUrl } = {}) {
  const peer = (agentId, expectedName, displayName, base, extra) => ({
    agentId, expectedName, displayName, baseUrl: base,
    cardUrl: `${base}/.well-known/agent-card.json`,
    rpcUrl: `${base}/a2a/jsonrpc`,
    settingsUrl: `${base}/settings/skills`,
    vizUrl: `${base}/viz/events`,
    ...extra,
  });
  return {
    tutor: peer('tutor', 'Tutor Agent', 'Calculus Tutor', tutorUrl ?? 'http://127.0.0.1:41241', { issuesForms: true }),
    library: peer('library', 'Library Agent', 'Library Agent', libraryUrl ?? 'http://127.0.0.1:41242', {}),
  };
}

const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const str = (v, max) => typeof v === 'string' && v.length <= max;

// Validate a fetched card against the trusted peer entry. Returns { ok, view } or { ok: false, error }.
export function validateCard(card, peer) {
  if (!card || typeof card !== 'object') return { ok: false, error: 'Card is not a JSON object.' };
  if (card.name !== peer.expectedName) return { ok: false, error: `Unexpected agent name "${String(card.name).slice(0, 60)}" (expected "${peer.expectedName}").` };
  const ifaces = card.supportedInterfaces;
  if (!Array.isArray(ifaces) || ifaces.length !== 1) return { ok: false, error: 'Card must declare exactly one interface.' };
  const [iface] = ifaces;
  if (iface.protocolBinding !== 'JSONRPC' || iface.protocolVersion !== '1.0') return { ok: false, error: `Unexpected protocol ${iface.protocolBinding} ${iface.protocolVersion}.` };
  if (iface.url !== peer.rpcUrl) return { ok: false, error: `Card endpoint ${String(iface.url).slice(0, 100)} does not match the registered endpoint; refusing it.` };
  if ((card.securitySchemes && Object.keys(card.securitySchemes).length) || (card.securityRequirements ?? []).length) {
    return { ok: false, error: 'Card changed its security settings; refusing it.' };
  }
  if (!Array.isArray(card.skills) || card.skills.length > 16) return { ok: false, error: 'Card skills missing or too many.' };
  const ext = (card.capabilities?.extensions ?? []).find((e) => e.uri === SCOPE_EXTENSION_URI);
  const scope = ext?.params?.skills ?? {};
  const skills = [];
  for (const s of card.skills) {
    if (!SKILL_ID.test(s?.id ?? '') || !str(s.name, 80) || !str(s.description, 500)) return { ok: false, error: `Malformed skill in card: ${JSON.stringify(s).slice(0, 80)}` };
    const tags = (Array.isArray(s.tags) ? s.tags : []).filter((t) => str(t, 30)).slice(0, 10);
    const examples = (Array.isArray(s.examples) ? s.examples : []).filter((t) => str(t, 200)).slice(0, 6);
    const lim = (v) => (Array.isArray(v) ? v.filter((t) => str(t, 160)).slice(0, 12) : []);
    skills.push({ id: s.id, name: s.name, description: s.description, tags, examples, allowed: lim(scope[s.id]?.allowed), excluded: lim(scope[s.id]?.excluded) });
  }
  return { ok: true, view: { name: card.name, skills, revision: Number.isInteger(ext?.params?.revision) ? ext.params.revision : null } };
}

export function createRegistry({ peers, onEvent = () => {} }) {
  const entries = new Map(Object.values(peers).map((p) => [p.agentId, {
    peer: p, status: 'unknown', card: null, view: null, etag: null, revision: null,
    lastRefreshAt: null, lastSuccessAt: null, lastError: null, refreshing: null, again: false,
  }]));

  async function fetchOnce(entry, reason) {
    const { peer } = entry;
    onEvent('registry_refresh_started', { agentId: peer.agentId, reason });
    entry.lastRefreshAt = new Date().toISOString();
    try {
      // Conditional request: the card is fetched only from the registered URL, revalidated by ETag.
      const res = await getCard(peer.cardUrl, entry.card ? entry.etag : null);
      if (res.status === 304) {
        entry.status = 'ok';
        entry.lastSuccessAt = entry.lastRefreshAt;
        entry.lastError = null;
        onEvent('registry_updated', { agentId: peer.agentId, reason, changed: false, ...summary(entry) });
        return;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status} from the ${peer.agentId} card URL (redirects are not followed)`);
      let card;
      try {
        card = JSON.parse(res.body);
      } catch {
        throw Object.assign(new Error('Agent Card is not valid JSON.'), { invalidCard: true });
      }
      const checked = validateCard(card, peer);
      if (!checked.ok) throw Object.assign(new Error(checked.error), { invalidCard: true });
      // Atomic replacement of the registry entry's card-derived fields.
      Object.assign(entry, { card, view: checked.view, etag: res.etag, revision: checked.view.revision, status: 'ok', lastSuccessAt: entry.lastRefreshAt, lastError: null });
      onEvent('registry_updated', { agentId: peer.agentId, reason, changed: true, ...summary(entry) });
    } catch (err) {
      // Keep the last good card (if any) — a failed refresh never invents skills.
      entry.status = entry.card ? 'stale' : err.invalidCard ? 'invalid' : 'unavailable';
      entry.lastError = err.invalidCard ? err.message : err.code === 'ECONNREFUSED' ? 'Agent offline (connection refused)' : err.name === 'TimeoutError' ? 'Timed out fetching the card' : err.message;
      onEvent('registry_refresh_failed', { agentId: peer.agentId, reason, error: entry.lastError, ...summary(entry) });
    }
  }

  // Coalesced: while a refresh runs, further requests mark "again" and get one follow-up fetch.
  function refresh(agentId, reason) {
    const entry = entries.get(agentId);
    if (!entry) return Promise.resolve(false);
    if (entry.refreshing) {
      entry.again = true;
      return entry.refreshing;
    }
    entry.refreshing = (async () => {
      do {
        entry.again = false;
        await fetchOnce(entry, reason);
      } while (entry.again);
      entry.refreshing = null;
      return entry.status === 'ok';
    })();
    return entry.refreshing;
  }

  const summary = (e) => ({
    agentId: e.peer.agentId, displayName: e.peer.displayName, status: e.status, revision: e.revision, etag: e.etag,
    lastRefreshAt: e.lastRefreshAt, lastSuccessAt: e.lastSuccessAt, lastError: e.lastError,
    skills: e.view?.skills ?? [],
  });

  return {
    has: (agentId) => entries.has(agentId),
    peer: (agentId) => entries.get(agentId)?.peer ?? null,
    entry: (agentId) => entries.get(agentId) ?? null,
    refresh,
    refreshAll: (reason) => Promise.all([...entries.keys()].map((id) => refresh(id, reason))),
    summaries: () => [...entries.values()].map(summary),
    // What the router may see: usable services and their skills — never URLs.
    routingView: () => [...entries.values()].filter((e) => e.view && (e.status === 'ok' || e.status === 'stale')).map((e) => ({
      agentId: e.peer.agentId, name: e.peer.displayName, stale: e.status === 'stale',
      skills: e.view.skills.map(({ id, name, description, tags, examples, allowed, excluded }) => ({ id, name, description, tags, examples, allowed, excluded })),
    })),
  };
}
