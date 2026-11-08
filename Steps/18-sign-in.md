# Step 18 — One sign-in in front of the demo, and opening it by the machine's IP

> Final state: see `Steps/README.md`. This is your Part 18 request, in your own words, with every decision and fix made while building it merged into the instructions. Running it after Steps 1–17 rebuilds the current app.

## Your original request

> I will be publishing this app on the internet and I dont want people to be able to get to it so I want to add a sigin page create a new branch that we can use to put a login on there design this for me and provide a plan including high fidelity UI design for me to approve

## Your decisions while designing and building it (merged into the instructions below)

- *“No this is one login to get to the demo so that people can demo the full system.”* Signing in opens everything. Accounts don't decide what someone sees.
- You asked *“Since we have agents on various systems and ports are they going to be also secured”*. The answer: the nine back-end processes stay on 127.0.0.1, and a test enforces it.
- *“let the frontend listen on all ip addresses so I can test this out by opening the frontend using the IP of the machine and see it working”*. This added `UI_HOST`. The builder's call: it works only with the sign-in on.
- *“terminal is enough”*: there is no password page in the app. Passwords are set and changed only with `npm run access:add <name>`.
- *“yes approved, go ahead and build it”*. Branch `signin`.

## Instructions

1. **Accounts** (`src/access.js`, `scripts/access.js`):
   - A short list of usernames in `config/access.json` (git-ignored; override with `AGENTHUB_ACCESS_FILE`).
   - Only a scrypt hash and salt are stored: N=32768, r=8, p=1, 32 bytes, file mode 0600.
   - Usernames are lowercased, `[a-z0-9._-]{1,32}`.
   - `npm run access:add <name>` asks for the password twice without showing it (at least 8 characters). Without a terminal it reads the first line of stdin. Also `npm run access:remove <name>` and `npm run access:list`.
   - Checking an unknown username still runs one scrypt, so the timing doesn't reveal which usernames exist.
1b. **Accounts change without a restart.** The running UI re-reads the accounts file when it changes (checked every second). A new account works at once; a removed account, or one whose password changed, is signed out at once. A file that can't be read keeps the last good list. `saveAccess` writes a temporary file and renames it so the reload never sees half a file.
2. **Sessions** (`src/sessions.js`):
   - In memory only. They end 12 hours after sign-in, or after 2 hours idle.
   - Cookie `ah_session`: HttpOnly, SameSite=Lax, Path=/, Max-Age 43200. It is Secure only when `PUBLIC_ORIGIN` is https.
   - Sign-in issues a new id and ends the old one.
   - Limiter: 5 wrong tries in 15 minutes from one address (or for one username from one address) lock that address for 15 minutes. Never lock a username alone; instead, after 20 wrong tries on one account in 15 minutes from anywhere, each further try waits 1 s longer (max 10 s). IPv6 addresses are grouped by /64 only in the (username, address) lock; the address-only lock uses the exact address. Tries still being checked count toward the limit.
3. **The gate** (`src/auth-gate.js`), mounted in `src/ui-server.js` right after the Host guard and before every route and the static files:
   - Open without a session: `/signin`, `/signin.css`, `/signin.js`, and `/fonts/*` from its own static root mounted before the gate (an open `/fonts/` prefix on the main static leaked page code via `/fonts/..%2fapp.js`).
   - A page without a session → 302 to `/signin?next=<path>`. If an old cookie was sent, also add `&e=expired`.
   - `/api/*`, `/auth/*` and any non-GET → 401 `{"error":"sign_in_required"}`.
   - Signing out, or an account being removed or changed, closes that session's open live streams at once. An expired session's stream ends within a minute.
   - Signed-in pages and data are sent with `Cache-Control: no-store` (nothing kept after signing out, not even for the Back button) and `X-Frame-Options: DENY`.
   - `next` is used only if it is a same-site path. Otherwise the person goes to `/conversation`.
   - `GET /auth/me` → `{ auth, username }`. `POST /signout` → `/signin?e=out`.
   - The sign-in and sign-out posts are origin-checked.
   - Paths are compared lowercased and without a trailing slash.
4. **The page** (`public/signin.html/.css/.js`), from the approved mockup:
   - Two panels: on the left a dark panel with the AgentHub mark and a small animated hub diagram (no text under it), on the right the form, centred, with nothing under the Sign in button (owner, 2026-11-07: “remove these writings” — the “A private demo …” paragraph, “No account? …” and the footer “Fictional demo data only · Signed-in sessions last 12 hours” are gone). One column below 720 px. Light and dark mode.
   - The name is “AgentHub — University agents demo”, never the university's name.
   - The server fills in the message, `next` and the username, escaped. The page works without JavaScript; the script adds only Show/Hide, a Caps Lock hint and “Signing in…”.
   - Copy:
     - “That username and password don’t match. Check them and try again.”
     - “Too many tries. Wait 15 minutes, then try again.”
     - “Your session ended. Sign in again to continue.”
     - “You’re signed out.”
5. **Header** (`public/session.js`, `index.html`, `styles.css`):
   - A pill at the right shows “<avatar letter> name | Sign out”, only when the sign-in is on.
   - Any 401 from `/api` or `/auth` sends the page to the sign-in.
6. **Addresses**:
   - `UI_HOST` is read only by the UI server and defaults to 127.0.0.1.
   - A non-loopback value requires the sign-in: `AUTH=off` exits with “refusing to listen on … without sign-in”, and no accounts also exits.
   - The ready line stays `[UI] listening on http://127.0.0.1:<port>`. When wide, it adds `[UI] also on http://<ip>:<port> (sign-in required)`.
   - The Host and Origin guards accept the machine's own IPv4 addresses and the `PUBLIC_ORIGIN` host. Every other Host name still gets 421.
   - `PUBLIC_ORIGIN` requires `TRUST_PROXY`: `1` for a front server on the same machine, or the front server's address (e.g. `172.16.70.87`) when it runs elsewhere. A bare `1` behind a front server on another machine would make every visitor look like that machine.
   - The Student agent's inbound A2A door (`/a2a/jsonrpc`, the agent card) answers only a local caller with no proxy headers; anyone else gets 404.
   - `npm run demo:live:lan` = the live demo with `UI_HOST=0.0.0.0 AUTH=on`.

## Avoid these known problems

- Don't send `Referrer-Policy: no-referrer` on the sign-in page. Chrome then posts the form with `Origin: null`, and the origin check refuses the sign-in (“Cross-origin request refused.”). Use `same-origin`.
- Don't compare paths exactly. Express matches `/A2A/jsonrpc` and `/a2a/jsonrpc/` to the same route, so a check that compares exact text can be bypassed. Lowercase and strip the trailing slash first.
- Don't lock a username by itself: with one shared account, anyone could send 5 wrong passwords every 15 minutes and keep everyone out. Lock per address and per (username, address).
- Don't open a path prefix (`/fonts/`) on the main static server: `/fonts/..%2fapp.js` served page code without signing in. Mount the fonts folder as its own static root before the gate.
- Don't check the lock and then count the try after an `await`. A burst of parallel guesses would all pass the check. Count tries in flight.
- Don't trust 127.0.0.1 behind a front server on the same machine. Every visitor would look local. Require `TRUST_PROXY=1` with `PUBLIC_ORIGIN`, and treat a request with `X-Forwarded-For` as not local.
- Don't put a plain apostrophe inside a single-quoted JS string (“don't”). Use ’.
- In tests, `fetch` silently drops a custom Host header, so send Host checks with `node:http`.
- The listen line can arrive after the ready line, so wait for the “also on” line instead of reading it once.
- playwright-cli `fill` and `click` take snapshot refs, not CSS selectors. A selector typed the password into the Username box. Drive the page with `run-code`.

## Enhancements merged into this step

- Back-end processes are proven to be loopback-only (`test/loopback-only.test.js`), because the owner asked whether the other ports are secured.
- Accounts reload without a restart, because the owner asked: “have it take effect without restarting”.
- `UI_HOST`, so the demo can be opened by the machine's IP, but only with the sign-in, because the owner wanted to test from the machine's IP.
- Two fixes from the whole-branch security review: per-address locks, and fonts served from their own root.
- Three fixes from the automatic security review: path normalization, tries in flight, and `TRUST_PROXY` being required with `PUBLIC_ORIGIN`.
