# Step 2 — Browser monitor for the A2A exchange

Time: about 25 minutes. Cost: free (no model calls, no API key).

## What you'll see when it works

- `http://127.0.0.1:4444` shows a **Student Agent** and a **Tutor Agent** panel, each logging its messages with times and IDs.
- A timeline fills from real events: Request sent → Tutor Agent received → Response sent → Student Agent received.
- With the Tutor stopped, the page shows the real connection error, never a reply.

## Starting point

Start from the committed code of Step 1. Run `npm test` first; fix any Step 1 failure before adding anything.

## Instructions for Claude (lead)

Use the three phases from Step 0: Contracts → parallel Build → Join and check. Start **both tasks in ONE message** with the Agent tool.

Keep three channels separate. Agent messages never travel over SSE:
- **A2A**: Student `askTutor` → Tutor `/a2a/jsonrpc`. The only path for agent messages.
- **Tutor viz feed**: Tutor `GET /viz/events` (SSE) → UI server. Events the Tutor really emitted.
- **Browser stream**: UI `GET /api/events` (SSE) → browser. Display only.

## Phase 1 — Contracts (lead writes these first)

Write these as a header comment in a stub `src/ui-server.js`, and add the npm script `"ui": "node src/ui-server.js"`.

1. **Event:** `{ seq, id: '<bootId>:<seq>', at, source, type, runId, data }`. `seq` counts per boot. `bootId` is a UUID made at startup. `source` is `system`, `student` or `tutor`. `runId` is a UUID or `null`.
2. **Types:**
   - `system`: `run_started { text }`, `state { state }`, `tutor_feed { connected }`.
   - `student`: `card_discovered`, `request_sent { messageId, text }`, `reply_received { messageId, contextId, taskId, text, runId }`, `request_failed { error, code }`.
   - `tutor`: `message_received { messageId, contextId, taskId, text }`, `reply_published { messageId, contextId, inReplyTo, text }`.
3. **Run states:** `sending`, `waiting`, `completed`, `failed`. `idle` is a browser-only label.
4. **Routes:**
   - `POST /api/runs { text }` → `202 { runId }`; `400 { error }` if empty or over 2,000 characters; `409 { error, activeRunId }` while a run is active.
   - `GET /api/status` → `{ tutorUrl, tutorFeedConnected, activeRunId }`.
   - `GET /api/events` (SSE): `event: hello` with `{ bootId, tutorFeedConnected, activeRunId }`, then all history, then live events. Each event is written as `id: <id>` and `data: <json>`.
5. **Process:** `UI_PORT` (default 4444; `0` = free). `TUTOR_URL` (default `http://127.0.0.1:41241`). Startup line `[UI] listening on http://127.0.0.1:<port>`.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A — Servers and tests | haiku | `src/tutor-agent.js`, `src/student-agent.js`, `src/ui-server.js`, `src/local-guard.js`, `test/support/harness.js`, `test/ui.test.js` | Viz feed, event hook, UI server, guards, tests | `npm test` passes |
| B — Browser page | haiku | `public/index.html`, `public/app.js`, `public/styles.css` | Monitor page | `node --check public/app.js`; no `innerHTML` in it |

### Task A — Servers and tests

**Tutor (`src/tutor-agent.js`)**
1. Add an `EventEmitter` and `emitViz(type, runId, data)` that emits `{ source: 'tutor', type, runId, at, data }`.
2. Serve `GET /viz/events` as SSE: write `: connected`, then forward live events. No replay.
3. Read `runId` from the incoming `message.metadata.runId` (`null` for CLI runs).
4. Emit `message_received` right after the `received message` log.
5. Put `{ runId }` in the reply's `metadata`.
6. Emit `reply_published` after `eventBus.finished()`. It means "published", not "delivered".
7. Inside the listen callback, add `app.use(hostGuard(actualPort))` before the other routes.

**Student (`src/student-agent.js`)**
1. New signature: `askTutor(baseUrl, text = STUDENT_MESSAGE, { runId, onEvent = () => {} } = {})`. Step 1 calls still work.
2. Send `metadata: { runId }` on the A2A message when `runId` is set.
3. Call `onEvent` with `card_discovered` after discovery, and `request_sent` just before `sendMessage` ("send started", not "received").
4. Call `onEvent('reply_received', …)` with `runId` read from the reply's metadata.
5. On any error: `onEvent('request_failed', { error: err.message, code: err.cause?.code ?? null })`, then rethrow.

**Guards (`src/local-guard.js`)**
1. `hostGuard(port)`: `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, else `421 { error }`. This blocks DNS rebinding.
2. `sameOriginGuard(port)`: if `Origin` is present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`, else `403 { error }`. A missing `Origin` passes.

**UI server (`src/ui-server.js`)**
1. Export `startUiServer({ port, tutorUrl })` → `{ server, baseUrl, close }`.
2. Listen like Step 1: check `err`, read the real port, then create both guards.
3. Host guard on every request. Origin guard on every POST route.
4. Serve `public/` statically. Use `express.json({ limit: '16kb' })`.
5. `publish(event)` stamps `seq`, `id` and `at` (unless given), keeps a 1,000-event history, and writes to every open stream.
6. Follow the Tutor's `/viz/events`, reconnecting every second. Publish `tutor_feed` only when `connected` changes.
7. Relay a Tutor event only if its `runId` is a run this server started. Keep the Tutor's `at`.
8. `NEXT_STATES`: `sending → waiting | completed | failed`; `waiting → completed | failed`; `completed` and `failed` → nothing.
9. `setState` ignores moves not in the table. A Tutor `message_received` moves the run to `waiting`.
10. `POST /api/runs` is the **only** place an A2A request starts. It validates, sets `activeRunId`, publishes `run_started` and `state sending`, and answers 202.
11. Then it calls `askTutor(tutorUrl, text, { runId, onEvent })`, publishing `student` events. Success → `completed`; error → `failed`. Always clear `activeRunId`.
12. When run directly, also print `[UI] Student Agent will contact Tutor Agent at <tutorUrl>`.

**Harness (`test/support/harness.js`)** — add:
1. `UI_READY = /\[UI\] listening on (http:\/\/127\.0\.0\.1:\d+)/`.
2. `startUi(tutorUrl, env = {})`: starts `src/ui-server.js` with `UI_PORT: '0'` and `TUTOR_URL`; sets `ui.url`.
3. `openStream(baseUrl, headers = {})`: reads `/api/events` into `stream.hello` and `stream.events`; `stream.close()` aborts.
4. `waitFor(check, { timeout = 5000, what })` and `post(url, body, headers = {})`.

**Tests (`test/ui.test.js`)** — a real Tutor plus a UI pointed at it. Check:
1. **Round-trip:** the Tutor's `message_received` has the typed text and the `messageId` from `request_sent`.
2. `reply_published.inReplyTo` is that `messageId`. `reply_received` has the Tutor's reply and the run's `runId`.
3. Times are in order: sent ≤ received ≤ published ≤ reply.
4. States are `sending,waiting,completed` or `sending,completed`. Wait for Tutor events with `waitFor`.
5. **Correlation:** two runs have different `runId`s, each with one receive and one publish carrying its own text.
6. **Double submit:** two quick POSTs give `[202, 409]` and one `run_started`.
7. **Reconnect:** a new stream replays one `run_started` and one `request_sent`; the Tutor logged the message once; `activeRunId` is `null`.
8. **Tutor down:** UI on `unusedPort()`: `hello.tutorFeedConnected` is false; a run ends `failed`, code `ECONNREFUSED`, no reply, no `tutor` events.
9. **Validation:** whitespace-only and 2,001-character texts give 400 and start no run.
10. **Guards:** POST `/api/runs` with `Origin: http://attacker.example` gives 403. A wrong `Host` gives 421 (use `node:http`; `fetch` won't send a custom `Host`).

### Task B — Browser page

1. Plain HTML, CSS and JavaScript. No framework, web fonts or third-party requests.
2. Two labelled panels side by side: **Student Agent** (A2A client) and **Tutor Agent** (A2A server). One column on narrow screens.
3. Student panel: a textarea (`maxlength` 2000) prefilled with `Hello Tutor Agent. Can you help me with calculus?` and a Send button.
4. Tutor panel note: it gives one fixed reply until Step 4 adds the model. This is by design.
5. Each log line shows direction, time (with ms), text, and IDs: messageId, contextId, taskId ("none — direct Message reply" if empty), inReplyTo, short run tag.
6. Timeline: Request sent, Tutor Agent received, Response sent, Student Agent received. Mark a step only when its real event arrives for the current run.
7. Show the state label, a browser-stream badge and a Tutor-feed badge.
8. On `request_failed`, show the error and code in the Student log and under the timeline.
9. Use `new EventSource('/api/events')`. Skip events whose `seq` was seen. If `hello.bootId` changes, clear the page and the seen set.
10. Disable Send while the POST is in flight and while a run is `sending` or `waiting`. Show 400/409 errors by the form.
11. Set all text with `textContent`. Never use `innerHTML`.
12. Clean and readable: system fonts, good contrast. No special theme yet.

## Phase 3 — Join and check (lead)

1. Check the page uses the contract's event types and field names.
2. Run `npm test` until it passes.
3. (Optional — needs a browser; if none is available, say so.) Run `npm run tutor` and `npm run ui`. In a real browser: send, reload, check nothing is re-sent.
4. Stop the Tutor (`kill $(lsof -tiTCP:41241 -sTCP:LISTEN)`), send again, see the failure. If you couldn't use a browser, say so.
5. Stop the UI by port: `kill $(lsof -tiTCP:4444 -sTCP:LISTEN)`.

## Rules that apply to the whole step

1. Emit each event where the thing really happens. Never invent messages or confirmations.
2. Every server binds to `127.0.0.1` and uses `hostGuard`.
3. No LLM, API key, Hub, A2UI, database or accounts yet.

## Avoid these known problems

- Tutor events can land after the A2A reply. Wait for them; never assume order.
- Don't let a late event move a finished run backwards. Use `NEXT_STATES`.
- Don't render replayed events twice. Dedupe by `seq`; reset on a new `bootId`.
- Don't create the guards before `listen()`. They need the real port.

## Done when

- `npm test` → all tests pass, 0 failed.
- `npm run ui` prints `[UI] listening on http://127.0.0.1:4444`.
- In the browser (optional — needs a browser; if none is available, say so): round-trip works, the timeline fills, reload doesn't re-send, a stopped Tutor shows a failure.

Then append the "CLAUDE.md notes" below to `CLAUDE.md` and commit `Step 2: Browser monitor for the A2A exchange`.

## CLAUDE.md notes

```markdown
## Step 2 (browser monitor)
- Three channels: A2A (agent messages); Tutor /viz/events SSE (real Tutor events); UI /api/events SSE (display only). Never send agent messages over SSE or invent events.
- src/ui-server.js hosts the Student and owns run state (NEXT_STATES, forward-only). Only POST endpoints start A2A requests.
- Events: { seq, id: '<bootId>:<seq>', at, source, type, runId, data }. The browser dedupes by seq and resets on a new bootId.
- Tutor viz events can arrive after the A2A reply. Tests wait for them.
- src/local-guard.js: hostGuard on every server, sameOriginGuard on UI POST routes, created inside the listen callback.
- Keep the "[UI] listening on http://127.0.0.1:<port>" line. Browser text uses textContent only.
```

## Show it (optional)

`npm run tutor`, `npm run ui`, open `http://127.0.0.1:4444`, and send.
