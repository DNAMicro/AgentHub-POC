# Sign-in for the public demo — design (draft for approval)

Branch: `signin` (from `HRAgent` at 3113c63). Mockup: `2026-11-07-signin-mockup.html` (this folder).

## Why

The owner will put the app on the internet and wants only people they choose to get in (owner, 2026-11-07: “I dont want people to be able to get to it so I want to add a sigin page”). It also matters for two other reasons:
- Every chat runs paid model calls. Without a sign-in, a stranger could spend the API budget.
- “New conversation” resets the whole classroom for everyone.

## Goals

- Every address served by the UI server (:4444) needs a signed-in session: pages, `/guide`, `/api/*`, the live streams (`/api/ui/stream`, `/api/events`, `/api/ag-ui/*`) and static files. Only these are open without signing in:
  - `/signin` (GET and POST)
  - `/signin.css`
  - the two font files
- A page request without a session is redirected to `/signin?next=<path>`. An API or stream request gets `401 {"error":"sign_in_required"}`. After signing in, the person goes back to `next`, but only if it is a same-site path starting with `/` and not `//`.
- Accounts are a short list the owner manages. There is no sign-up and no password reset by email (the project sends no real email).
- A “Signed in as X · Sign out” pill appears at the right of the header. Sign out ends the session on the server.

## Non-goals

- Changing who sees which tab: one login opens the full demo.
- Real university single sign-on.
- A database. Remember-me past 12 hours. Two-factor sign-in.
- Exposing the other nine processes. They stay on 127.0.0.1; only the UI server is published.

## Anti-goals (a failure even if it “works”)

- The university's name or logo on the sign-in page. It would read as a phishing page. The page says **AgentHub — University agents demo**.
- Any password, hash, cookie value or session id in logs, telemetry, `data/` or git.
- A message that reveals whether a username exists.
- Locking the Hub out of the Student agent's inbound A2A endpoint (`/a2a/jsonrpc`, the agent card). The fix: those stay open only to loopback callers with no `X-Forwarded-For`, and the proxy returns 404 for them from outside.

## How it works (my calls — please check)

| Part | Decision |
|---|---|
| Accounts | `config/access.json`, git-ignored, path override `AGENTHUB_ACCESS_FILE`. Each entry is `{ username, scrypt hash, salt }` (`node:crypto` scrypt, N=2^15). `npm run access:add <name>` asks for the password twice and never echoes it. `npm run access:remove <name>`. No new packages. |
| Sessions | 32 random bytes, kept in memory, so a restart signs everyone out (same rule as loans and HR records). They end after 12 hours or 2 hours idle. Cookie `ah_session`: HttpOnly, SameSite=Lax, Path=/, Secure when `PUBLIC_ORIGIN` is https. A new session id at every sign-in. |
| Wrong tries | After 5 failures in 15 minutes for the same username or the same IP, that username or IP is locked for 15 minutes (“Too many tries”). The password check takes about the same time whether or not the user exists (a dummy hash is checked). |
| Forms | A plain HTML form POST that works without JavaScript. Small script only for Show/Hide and the Caps Lock hint. `sameOriginGuard` is also checked on `/signin` and `/signout`. |
| Public address | New env vars `PUBLIC_ORIGIN` (e.g. `https://agenthub.example.org`) and `TRUST_PROXY=1`. `hostGuard` and `sameOriginGuard` accept that host and origin as well as the loopback ones. Without them, nothing changes locally. |
| Turning it on | `AUTH=on` by default when `PUBLIC_ORIGIN` is set. Local `npm run demo` and `npm test` stay unchanged, with auth off and a startup line saying so. Auth also refuses to start with an empty accounts file. |
| Hosting | Out of scope for code. The plan's README note: run `demo:live` on the server, put Caddy or nginx in front for HTTPS, and forward only :4444. |

## Implementation outline (a full TDD plan follows once you approve)

1. `src/access.js`: the accounts file, scrypt hash and verify, the access CLI script. Tests: hash round-trip, wrong password, unknown user, file not readable.
2. `src/sessions.js`: create, read, touch, end, expire, and the attempt limiter. Tests use a fake clock.
3. `src/auth-gate.js`: middleware that allows the open list, redirects pages, returns 401 for API and streams, and keeps the loopback-only rule for A2A. It is mounted first in `ui-server.js`, before `express.static`.
4. `public/signin.html`, `public/signin.css` and a small `signin.js`, built from the approved mockup (`textContent` only).
5. Header pill and Sign out in `index.html`, `app.js` and `styles.css`. Also `/guide`'s link. When a stream gets a 401, the page goes to `/signin?next=…`.
6. `PUBLIC_ORIGIN` / `TRUST_PROXY` in `local-guard.js` and `config.js`, and the `AUTH` switch.
7. Tests: `test/loopback-only.test.js` (every server binds 127.0.0.1), `test/auth.test.js` (end to end on a stack: every route kind refused, then allowed after sign-in; lockout; sign out; `next` open-redirect cases), plus a browser check `scripts/browser-checks/signin.js` on a separate stack.
8. Docs: CLAUDE.md section, README “Publishing”, `Steps/18-sign-in.md` (copied to the Exercise repo, committed locally only).

## Risks

- Behind a proxy, a wrong `TRUST_PROXY` setting makes every visitor share one IP, so one person's wrong tries would lock out everyone. Step 6 tests this both ways.
- Long-lived streams already open when a session ends keep running until they reconnect. The gate checks the session at connect time and every 60 s, then closes the stream.

## One login for the whole demo (owner, 2026-11-07)

“No this is one login to get to the demo so that people can demo the full system.” Signing in opens everything: all four tabs, both the student and the faculty side. Accounts only decide who can get in, not what they see.

## The other nine processes (owner asked: “are they going to be also secured”)

- **Already true, checked 2026-11-07.** Every server has `HOST = '127.0.0.1'` hard-coded:
  - the Hub and the agents: Tutor, Library, Faculty, HR, Campus Agent
  - the three stand-ins: PeopleSoft CHRS, Canvas, Campus Solutions
  - the UI server
  `lsof` on the running demo shows all ten listening on `127.0.0.1` only. Another computer cannot connect to them at all.
- **The only way in is the UI server**, behind the sign-in. The browser reaches the Hub and the Faculty agent only through the UI server's `/api/*` routes, which the gate covers.
- **A second lock already exists between them.** The processes already check each other:
  - signed Hub messages with per-process keys
  - random tokens for the three stand-ins, made fresh at every start
  - host and origin guards
- **New in this work:**
  - a test, `test/loopback-only.test.js`, that fails if any server would listen on anything but 127.0.0.1;
  - a README rule: on the server, open only port 443 (and 80 for the certificate) in the firewall, never 41241–41249 or 4444;
  - when using Docker, publish only the proxy's port.

## The front end on all addresses (owner, 2026-11-07)

“let the frontend listen on all ip addresses so I can test this out by opening the frontend using the IP of the machine and see it working”

- **New setting `UI_HOST`.** It defaults to `127.0.0.1`, so nothing changes for `npm test` or a plain `npm run demo`.
  - With `UI_HOST=0.0.0.0`, only the UI server (:4444) listens on every address, e.g. `http://172.16.70.100:4444` on the office network.
  - The other nine processes stay on `127.0.0.1`; the setting doesn't touch them.
- **New npm script.** `npm run demo:live:lan` runs `demo:live` with `UI_HOST=0.0.0.0` and `AUTH=on`.
- **It won't listen wide without the sign-in (my call).** The UI server refuses to start with `UI_HOST` other than loopback unless `AUTH=on` and the accounts file has at least one account. Startup then exits with a clear line. Without this rule, anyone on the same Wi-Fi could use the demo and its paid model calls.
- **Host and Origin checks.** `hostGuard` and `sameOriginGuard` accept the machine's own network addresses when `UI_HOST` is wide. Those addresses are read from `os.networkInterfaces()` at start. `PUBLIC_ORIGIN` is added to them.
  - A `Host` header naming some other name is still refused with 421. This keeps the DNS-rebinding protection.
- **The Student agent's inbound A2A endpoint stays loopback-only.** This covers `/a2a/jsonrpc` and the agent card. A caller that is not `127.0.0.1` / `::1` gets 404, even when signed in. The Hub is the only caller and is always local.
- **Plain http on the local network.** The cookie isn't marked Secure there, because it is not https. The password crosses the local network unencrypted. That is fine for an office test with a demo password, not for the internet. The internet setup uses https via the front server.
- **macOS.** The first wide start may show “allow incoming connections for node?”. Choose Allow.
- **Tests.**
  - `test/loopback-only.test.js`: the nine back-end servers always bind 127.0.0.1. The UI binds wide only with `AUTH=on`.
  - `test/auth.test.js`: a request with a LAN Host is signed-in-gated, and the A2A endpoint from a non-loopback address returns 404. This uses a test hook that fakes the remote address.
