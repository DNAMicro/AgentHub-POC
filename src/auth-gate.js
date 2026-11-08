// Part 18: one login in front of the whole demo (owner, 2026-11-07). Mounted in the UI server right after the
// Host guard, before every route and the static files. Page requests without a session go to /signin?next=…;
// /api and /auth requests get 401 {"error":"sign_in_required"}. Only the sign-in page, its CSS/JS and the fonts
// are open. The Student agent's inbound A2A endpoint never needs a sign-in, but only a local caller (the Hub)
// may reach it; anyone else gets 404, signed in or not.
// Never logs or emits a password, hash, cookie value or session id.
import express from 'express';
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { verify, normalUser, loadAccess, DEFAULT_ACCESS_FILE } from './access.js';
import { createSessions, SESSION_MAX_MS } from './sessions.js';

export const COOKIE = 'ah_session';
export const TEXT = {
  bad: 'That username and password don’t match. Check them and try again.',
  locked: 'Too many tries. Wait 15 minutes, then try again.',
  expired: 'Your session ended. Sign in again to continue.',
  out: 'You’re signed out.',
};
const STREAMS = new Set(['/api/ui/stream', '/api/events', '/api/ag-ui/stream', '/api/ag-ui/professor/stream']);
const OPEN = new Set(['/signin', '/signin.css', '/signin.js']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_NEXT = '/conversation';

export class AuthConfigError extends Error {}
const isLoopbackHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

// Reads UI_HOST, AUTH, PUBLIC_ORIGIN, TRUST_PROXY and AGENTHUB_ACCESS_FILE. Throws AuthConfigError (startup exits).
export function authConfig(env = process.env) {
  const host = (env.UI_HOST ?? '').trim() || '127.0.0.1';
  const wide = !isLoopbackHost(host);
  let publicOrigin = null;
  if (env.PUBLIC_ORIGIN) {
    try {
      const u = new URL(env.PUBLIC_ORIGIN);
      if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.username) throw new Error();
      publicOrigin = u.origin;
    } catch { throw new AuthConfigError(`PUBLIC_ORIGIN must look like https://agenthub.example.org (got something else)`); }
  }
  const authRaw = (env.AUTH ?? '').trim().toLowerCase();
  if (authRaw && authRaw !== 'on' && authRaw !== 'off') throw new AuthConfigError('AUTH must be on or off');
  const auth = authRaw ? authRaw === 'on' : Boolean(publicOrigin || wide);
  if ((wide || publicOrigin) && !auth) throw new AuthConfigError(`refusing to listen on ${host} without sign-in (set AUTH=on and add an account)`);
  // Behind a front server every visitor arrives from 127.0.0.1; only with TRUST_PROXY=1 (and the proxy's
  // X-Forwarded-For) can the gate tell visitors apart and keep the Student agent's inbound door local-only.
  if (publicOrigin && env.TRUST_PROXY !== '1') throw new AuthConfigError('PUBLIC_ORIGIN needs TRUST_PROXY=1, and the front server must send X-Forwarded-For');
  const accessFile = env.AGENTHUB_ACCESS_FILE || DEFAULT_ACCESS_FILE;
  return { host, wide, auth, publicOrigin, secure: publicOrigin?.startsWith('https://') ?? false, trustProxy: env.TRUST_PROXY === '1', accessFile };
}

// The machine's own network addresses (IPv4, not internal) — what “open it by the machine's IP” uses.
export function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

// Hosts and origins the guards accept besides the loopback ones.
export function extraHostsAndOrigins(cfg, port) {
  const hosts = []; const origins = [];
  if (cfg.wide) for (const ip of lanAddresses()) { hosts.push(`${ip}:${port}`); origins.push(`http://${ip}:${port}`); }
  if (cfg.publicOrigin) { const u = new URL(cfg.publicOrigin); hosts.push(u.host); origins.push(u.origin); }
  return { hosts, origins };
}

// Express matches routes case-insensitively and ignores a trailing slash, so every path check here does the same.
export const normPath = (p) => String(p ?? '').toLowerCase().replace(/\/+$/, '') || '/';
const LOCAL_ONLY = ['/a2a/jsonrpc', '/.well-known/agent-card.json'];
const underLocalOnly = (path) => { const p = normPath(path); return LOCAL_ONLY.some((x) => p === x || p.startsWith(`${x}/`)); };

// IPv6 visitors are grouped by their /64 network, so one network can't rotate addresses past the lock.
export function addressKey(ip) {
  const a = String(ip ?? '');
  const v4 = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/); // ::ffff:a.b.c.d, ::a.b.c.d, NAT64 …:a.b.c.d → the IPv4 address
  if (v4) return v4[1];
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = a.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const isLoopbackCaller = (req) => LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers.forwarded;

// Only a local caller with no proxy headers reaches these paths (the Hub delivering to the Student agent).
export function localOnly() {
  return (req, res, next) => {
    if (!underLocalOnly(req.path)) return next();
    if (isLoopbackCaller(req)) return next();
    res.status(404).json({ error: 'Not found.' });
  };
}

// A same-site path only: “/x…”, never “//host”, “/\host”, a scheme, control characters or the sign-in page itself.
export function safeNext(next) {
  const n = String(next ?? '');
  if (!n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\') || /[\u0000-\u001f\\]/.test(n) || n.length > 512) return DEFAULT_NEXT;
  if (n === '/signin' || n.startsWith('/signin?') || n.startsWith('/signout')) return DEFAULT_NEXT;
  return n;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICONS = {
  bad: '<svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 5.5v5.5M10 13.6v.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  warn: '<svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 5.6V10l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>',
  ok: '<svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m6 10.3 2.7 2.7L14 7.6" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9v5M10 6v.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const NOTICE_KIND = { bad: 'bad', locked: 'warn', expired: 'info', out: 'ok' };

export function createAuthGate({ cfg, publicDir, guardOrigin, log = () => {}, now } = {}) {
  let users = cfg.auth ? loadAccess(cfg.accessFile) : [];
  if (cfg.auth && !users.length) throw new AuthConfigError(`AUTH=on but there are no accounts — add one with: npm run access:add <name>`);
  const sessions = createSessions(now ? { now } : {});

  // Owner, 2026-11-07: “have it take effect without restarting”. The accounts file is re-read when it changes
  // (checked every second). A removed account, or one whose password changed, is signed out at once. A file that
  // can't be read keeps the last good list (logged); an empty list means nobody can sign in.
  const reload = () => {
    let next;
    try { next = loadAccess(cfg.accessFile, { missingOk: true }); } catch (err) { log(`accounts file not reloaded: ${err.message}; keeping the previous list`); return; }
    const now2 = new Map(next.map((u) => [u.username, u.hash]));
    const gone = new Set(users.filter((u) => now2.get(u.username) !== u.hash).map((u) => u.username));
    const added = next.filter((u) => !users.some((x) => x.username === u.username)).length;
    users = next;
    const out = gone.size ? sessions.endUsers(gone) : 0;
    log(`accounts reloaded: ${users.length} account(s), ${added} added, ${gone.size} removed or changed${out ? `, ${out} session(s) signed out` : ''}`);
  };
  if (cfg.auth) watchFile(cfg.accessFile, { interval: 1000, persistent: false }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs || cur.ino !== prev.ino) reload(); });
  const close = () => { if (cfg.auth) unwatchFile(cfg.accessFile); };
  const template = readFileSync(join(publicDir, 'signin.html'), 'utf8');

  const cookieOf = (req) => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  };
  const setCookie = (res, value, maxAgeSec) => res.append('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${cfg.secure ? '; Secure' : ''}`);

  const page = (res, { status = 200, notice = null, next = DEFAULT_NEXT, username = '' } = {}) => {
    const kind = notice ? NOTICE_KIND[notice] : null;
    const html = template
      .replace('{{NOTICE}}', notice ? `<div class="notice ${kind}" role="${notice === 'bad' || notice === 'locked' ? 'alert' : 'status'}">${ICONS[kind]}<span>${esc(TEXT[notice])}</span></div>` : '')
      .replace('{{NEXT}}', esc(next))
      .replace('{{USERNAME}}', esc(username))
      .replace('{{USER_STATE}}', notice === 'bad' ? ' aria-invalid="true"' : '')
      .replace('{{PASS_STATE}}', notice === 'bad' ? ' aria-invalid="true"' : '')
      .replace('{{LOCKED}}', notice === 'locked' ? ' disabled' : '');
    res.status(status).set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }).type('html').send(html);
  };

  const signedIn = (req) => (cfg.auth ? sessions.get(cookieOf(req)) : null);

  const middleware = (req, res, next) => {
    if (!cfg.auth) return next();
    const p = normPath(req.path);
    if (OPEN.has(p) || p === '/signout') return next(); // fonts are served before the gate, from their own folder only
    if (underLocalOnly(p) && isLoopbackCaller(req)) return next(); // the local Hub; localOnly() already turned others away
    const id = cookieOf(req);
    const who = sessions.get(id);
    if (who) {
      req.signedInAs = who.username;
      if (STREAMS.has(p)) { // an open stream ends when the session does (checked every minute)
        const timer = setInterval(() => { if (!sessions.get(id, { peek: true })) res.end(); }, 60_000);
        timer.unref?.();
        res.on('close', () => clearInterval(timer));
      }
      return next();
    }
    if (p.startsWith('/api') || p.startsWith('/auth') || !(req.method === 'GET' || req.method === 'HEAD')) {
      return res.status(401).set('Cache-Control', 'no-store').json({ error: 'sign_in_required' });
    }
    const q = new URLSearchParams({ next: safeNext(req.originalUrl) });
    if (id) q.set('e', 'expired');
    res.redirect(302, `/signin?${q}`);
  };

  const routes = (app) => {
    const form = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 });
    app.get('/auth/me', (req, res) => res.set('Cache-Control', 'no-store').json(cfg.auth ? { auth: true, username: req.signedInAs } : { auth: false }));
    app.get('/signin', (req, res) => {
      const next = safeNext(req.query.next);
      if (!cfg.auth || signedIn(req)) return res.redirect(302, next);
      const e = typeof req.query.e === 'string' && (req.query.e === 'expired' || req.query.e === 'out') ? req.query.e : null;
      page(res, { notice: e, next });
    });
    app.post('/signin', (req, res, nxt) => guardOrigin(req, res, nxt), form, async (req, res) => {
      if (!cfg.auth) return res.redirect(303, DEFAULT_NEXT);
      const next = safeNext(req.body?.next);
      const raw = typeof req.body?.username === 'string' ? req.body.username.slice(0, 64) : '';
      const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 256) : '';
      const user = normalUser(raw);
      // Locks are per address and per (username, address): wrong tries from one place never lock out someone
      // else who has the right password (security review, 2026-11-07: the shared account could be kept locked).
      // The hard lock on an address alone uses the exact address (a /64 can be a whole campus network);
      // the (username, address) lock groups IPv6 by /64 so one network can't rotate addresses to keep guessing.
      const exact = addressKey(req.ip).endsWith('::/64') ? String(req.ip) : addressKey(req.ip);
      const acctKey = `acct:${user ?? raw.trim().toLowerCase()}`;
      const userKey = `u:${user ?? raw.trim().toLowerCase()}|ip:${addressKey(req.ip)}`;
      const keys = [userKey, `ip:${exact}`];
      const done = sessions.limiter.begin(keys);
      if (!done) return page(res, { status: 429, notice: 'locked', next, username: raw });
      let ok = false;
      try {
        const wait = sessions.account.delayFor(acctKey); // many wrong tries on this account from anywhere: slow down
        if (wait) await new Promise((r) => setTimeout(r, wait));
        const before = users.find((u) => u.username === user)?.hash;
        ok = await verify(users, user, password);
        // The accounts file may have reloaded during the check: the account must still exist with the same password.
        if (ok && users.find((u) => u.username === user)?.hash !== before) ok = false;
      } finally { done(ok); }
      if (!ok) {
        sessions.account.fail(acctKey);
        log('sign-in refused (wrong details)');
        const locked = sessions.limiter.locked(keys);
        return page(res, { status: locked ? 429 : 401, notice: locked ? 'locked' : 'bad', next, username: raw });
      }
      sessions.limiter.clear(userKey);
      const old = cookieOf(req);
      if (old) sessions.end(old);
      setCookie(res, sessions.create(user), Math.floor(SESSION_MAX_MS / 1000));
      log(`signed in: ${user}`);
      res.redirect(303, next);
    });
    app.post('/signout', (req, res, nxt) => guardOrigin(req, res, nxt), (req, res) => {
      const id = cookieOf(req);
      if (id) sessions.end(id);
      setCookie(res, '', 0);
      res.redirect(303, cfg.auth ? '/signin?e=out' : DEFAULT_NEXT);
    });
  };

  return { middleware, routes, sessions, reload, close };
}
