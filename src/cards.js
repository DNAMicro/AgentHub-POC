// Agent Card fetching and validation, shared by the University Hub (specialist cards) and the
// Student (the Hub's public card). A fetched card must match the trusted identity, endpoint,
// protocol and (absent) security settings configured locally, or it is rejected.
import http from 'node:http';
import { SCOPE_EXTENSION_URI } from './skills.js';

const FETCH_TIMEOUT_MS = 3000;
const MAX_CARD_BYTES = 64 * 1024;

// GET the card with only the headers we choose. (Node's fetch adds "Cache-Control: no-cache" to
// any conditional request, which makes Express ignore If-None-Match — so no 304s.) No redirects
// are followed and the body size is capped.
export function getCard(url, etag, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) }, timeout: timeoutMs }, (res) => {
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
