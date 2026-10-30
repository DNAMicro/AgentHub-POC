# Step 7a — The University Hub in the middle

Time: about 90 minutes. Cost: free (tests use mocks). Optional live check: PAID, a few cents.

## What you'll see when it works

- `npm run demo` starts four processes: Hub (41243), Tutor (41241), Library (41242) and the Student UI (4444).
- The Student talks only to "California State University Fullerton" (the Hub). It never learns a Tutor or Library address.
- A calculus question goes Student → Hub → Tutor → Hub → Student. A library question goes through the Library. Both forms still work, through the Hub.
- Stop the Library and, after the heartbeat expires, the Hub answers "Library Agent is not available right now (it isn’t connected)."

## Starting point

Steps 1–6 must be done: Tutor and Library agents, A2UI forms, `src/router.js`, `src/models.js` with `useModel()`, editable skills with card-change notices, and the Step 6 workflow forms.

Start from the committed code of Step 6.

## Instructions for Claude (lead)

Use the three phases from Step 0: Contracts → parallel Build → Join and check.

1. Run `npm test` first and confirm it passes.
2. Write the Phase 1 contracts yourself.
3. Start **all four tasks in the table in ONE message** with the Agent tool.
4. Join, run the checks, fix failures, append the CLAUDE.md notes and commit.

Don't stop to ask questions. Everything you need is in this file and Step 0.

## Phase 1 — Contracts (lead writes these first)

1. **Control media types**, exported from `src/hub-link.js`:
   - `REGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-register+json'`
   - `HEARTBEAT_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-heartbeat+json'`
   - `DEREGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-deregister+json'`
   - `CONTROL_MEDIA_TYPES = new Set([those three, CARD_CHANGED_MEDIA_TYPE])`
   - `CARD_CHANGED_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-card-changed+json'` stays in `src/skills.js` (rename Step 5's constant if needed).
2. **Control bodies** (one data part; message metadata `{ control: <type>, agentId }`; empty `contextId`). The reply is one `application/json` data part:
   - `{ type: 'agent_register', agentId, instanceId, endpoint, cardUrl, enabled, heartbeatIntervalMs, at }` → `{ status: 'registered', readiness }` or `{ status: 'rejected', reason }`.
   - `{ type: 'agent_heartbeat', agentId, instanceId, enabled, at }` → `{ status: 'ok', readiness }` or `{ status: 'not_registered' }`.
   - `{ type: 'agent_deregister', agentId, instanceId, at }` → `{ status: 'deregistered' | 'ignored' }`.
   - `{ type: 'agent_card_changed', notificationId, agentId, instanceId, revision, reason, changedAt }` → `{ status: 'received' | 'duplicate' | 'rejected', reason? }`.
3. **Stubs with exact exports:**
   - `src/config.js`: `ConfigError`, `loadStudentConfig()`, `loadSpecialistConfig(role)`, `loadHubConfig()`.
   - `src/hub-registry.js`: `STATUS`, `createHubRegistry({ peers, expiryMs, cardFetchMs, onEvent, now })` → `{ has, peer, entry, isReady, status, snapshot, refresh, stop, register, heartbeat, deregister, cardChanged, markReachable, routingView }`.
   - `src/cards.js`: `getCard(url, etag, timeoutMs)` → `{ status, etag, body }`; `validateCard(card, peer)` → `{ ok: true, view: { name, skills, revision } }` or `{ ok: false, error }` (`peer` has `expectedName`, `rpcUrl`).
   - `src/hub-agent.js`: `startHubServer({ port })`, `redactTelemetry(event)`.
4. **A2A metadata:**
   - Student → Hub: `{ studentId, runId }`; form actions add `operationId, formId, formVersion, formRef, reviewAcknowledged?`.
   - Hub → specialist: `{ hubOperationId, via: 'csuf-hub', studentId, runId }`.
   - Hub → Student: `{ runId, operationId, agentId, servedByName, hub: { decision, destination, reason, model, decidedBy } }`. A form adds `formRef, formId, workflowId, formVersion, issuer, supersedes, prefilled`.
5. **Hub telemetry event types** (`source: 'hub'`): `message_received`, `request_repeat`, `route_decided`, `route_failed`, `forward_attempted`, `forward_completed`, `forward_failed`, `relay_sent`, `form_ref_created`, `form_action_received`, `form_action_rejected`, `form_action_duplicate`, `form_forwarded`, `form_result_relayed`, `form_forward_failed`, `registration_accepted`, `registration_rejected`, `deregistered`, `heartbeat`, `card_notification_received`, `card_notification_rejected`, `card_refreshed`, `card_refresh_failed`, `registry_status`, `specialist_feed`, and `model_call_started` / `model_response_received` / `model_call_failed` with `purpose: 'routing'`.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | haiku | `src/config.js`, `config/{student,hub,tutor,library}.example.json`, `scripts/start-all.js`, `package.json` (scripts only) | Validated configuration, examples, the launcher | `node -e "import('./src/config.js').then(m=>{m.loadHubConfig();m.loadStudentConfig();m.loadSpecialistConfig('tutor')})"` exits 0, and with `HUB_MODEL=x` it throws `ConfigError` |
| B | sonnet | `src/hub-agent.js`, `src/hub-registry.js`, `src/cards.js`, `src/router.js`, `src/student-agent.js` | The Hub: card, registry, routing, forwarding, form references, dedupe, telemetry relay | `node --check` passes on each owned `.js` file; `node -e "import('./src/hub-agent.js')"` exits without starting a server. (Starting the Hub needs Task A's real `loadHubConfig`; that check runs in Phase 3.) |
| C | haiku | `src/hub-link.js`, `src/tutor-agent.js`, `src/library-agent.js`, `src/agent-settings.js`, `src/skills.js` | Registration, heartbeats, sign-out, card notices to the Hub | `node --check` passes on each owned `.js` file, and `node -e "import('./src/hub-link.js').then(m=>console.log(m.CONTROL_MEDIA_TYPES.size))"` prints `4`. (Registering with a running Hub needs Tasks A and B; that check runs in Phase 3.) |
| D | sonnet | `src/ui-server.js`, `public/app.js`, `public/index.html`, `public/styles.css`, `test/support/harness.js`, all `test/*.test.js`, new `test/hub.test.js` | The Student connects only to the Hub; all tests run on the full stack | `npm test` passes after the join |

### Task A — Configuration and launcher

1. `src/config.js` imports only `node:fs` and `./models.js`.
2. Each loader reads an optional JSON file named by `STUDENT_CONFIG`, `HUB_CONFIG`, `TUTOR_CONFIG` or `LIBRARY_CONFIG`, deep-merged over built-in localhost defaults. An unreadable file throws `ConfigError`.
3. `ConfigError(role, problems)`: message `Invalid <Role> configuration:` then one `  - <problem>` line each; a `problems` array.
4. Invalid configuration always throws. Never fall back to direct Student-to-specialist routing.
5. **Student defaults:** `agentId: 'student-alex'`, `displayName: 'Student Agent'`, `university: { name: 'California State University Fullerton', relationship: 'Enrolled student (fictional demo identity)', hubUrl: 'http://127.0.0.1:41243' }`, `timeouts: { chatMs: 60000, formActionMs: 8000 }`, `model: { name: 'claude-haiku-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY' }`.
6. `university.cardUrl` defaults to, and must equal, `<hubUrl>/.well-known/agent-card.json`.
7. The Student config refuses `tutorUrl`, `libraryUrl`, `specialists` and `peers`.
8. Student env overrides: `HUB_URL`, `CHAT_TIMEOUT_MS`, `SUBMIT_TIMEOUT_MS`, `STUDENT_MODEL`.
9. **Specialist defaults** (`tutor`: 41241, "Tutor Agent"; `library`: 41242, "Library Agent"): `agentId` = role, `displayName`, `hub: { url: 'http://127.0.0.1:41243' }`, `enabled: true`, `heartbeatIntervalMs: 3000`, `model`.
10. Specialist checks: `agentId` equals the role; `enabled` is boolean; `heartbeatIntervalMs` is an integer ≥ 200.
11. Specialist env overrides: `HUB_URL`, `HEARTBEAT_INTERVAL_MS`, `SPECIALIST_ENABLED=0`, `TUTOR_MODEL` / `LIBRARY_MODEL`.
12. **Hub defaults:** `agentId: 'csuf-hub'`, `name: 'California State University Fullerton'`, a description saying it is a fictional local demo, not an official service.
13. Hub `peers`: `{ agentId: 'tutor', expectedName: 'Tutor Agent', displayName: 'Tutor Agent', baseUrl: 'http://127.0.0.1:41241' }`, and the same for `library` on 41242.
14. Hub `destinations` (public; they become the Hub card's skills):
    - `tutoring`: `worker: 'tutor'`, `name: 'Tutoring'`, tags `tutor, tutoring, explain, homework, calculus, derivative, integral, limit, algebra, math`, two examples.
    - `library`: `worker: 'library'`, `name: 'Library services'`, tags `library, book, borrow, renew, return, loan, due, overdue, hours, study room, reserve`, two examples.
15. Hub `students: ['student-alex']` is the **student allowlist**: the Hub serves only these IDs. `HUB_STUDENTS=student-alex,student-sam` replaces it. Tests add a second fictional student this way to check isolation.
16. Hub `heartbeatExpiryMs: 10000`; `timeouts: { dispatchMs: 60000, formActionMs: 8000, cardFetchMs: 3000 }`; `model`.
17. Hub env overrides: `<AGENTID>_URL` (`TUTOR_URL`, `LIBRARY_URL`) replaces a peer's `baseUrl`; `HEARTBEAT_EXPIRY_MS`, `HUB_DISPATCH_TIMEOUT_MS`, `HUB_FORM_TIMEOUT_MS`, `HUB_STUDENTS`, `HUB_MODEL`.
18. Hub checks: every URL matches `^http://(127\.0\.0\.1|localhost):\d{1,5}$`; unique peer IDs; `expectedName` required; each destination's `worker` is a peer, and no worker serves two destinations; `tags`/`examples` are string lists; expiry ≥ 500; timeouts positive.
19. After validation, add trusted URLs to each peer: `rpcUrl` (`/a2a/jsonrpc`), `cardUrl`, `settingsUrl` (`/settings/skills`), `vizUrl` (`/viz/events`).
20. **Model checks** (every agent): `model.name` must be a key of `MODELS` in `src/models.js`. The error lists the allowed names, plus `(set by TUTOR_MODEL)` when an env var set it.
21. `model.apiKeyEnv` must match `^[A-Z][A-Z0-9_]*$`. Any other `…key` field is refused: "Put the API key in the environment, not in the configuration file."
22. Write `config/{student,hub,tutor,library}.example.json` with these defaults. No keys.
23. `scripts/start-all.js` spawns `hub`, `tutor`, `library`, `ui` (`src/hub-agent.js`, `src/tutor-agent.js`, `src/library-agent.js`, `src/ui-server.js`). Each output line is prefixed with the name padded to 7 characters and ` | `.
24. `DEMO_MODE=live` sets `ROUTER_MODE`, `TUTOR_MODE` and `LIBRARY_MODE` to `live`; otherwise each is `mock`. It prints the mode and `Open http://127.0.0.1:4444`. Ctrl+C SIGTERMs all children, then exits after 1 s.
25. Add the Step 7a scripts from Step 0: `hub`, `hub:live`, `hub:direct`, `demo`, `demo:live`. `demo:live` sets only `DEMO_MODE=live`.

### Task B — The Hub

1. `src/hub-agent.js` exports `startHubServer({ port })` → `{ server, baseUrl, close, registry }` and `redactTelemetry(event)`.
2. In this step `redactTelemetry(event)` returns `event.data` unchanged. Step 7b replaces the body with an allowlist (`SAFE_FIELDS`, `CONFIG_EVENT_TYPES`). Keep the name and export.
3. The file starts a server **only** when run directly (`import.meta.url === \`file://${process.argv[1]}\``). Tests import it.
4. When run directly: `STUDENT_LOG_CONTENT ??= '0'`, `A2A_CLIENT_LABEL ??= '[Hub → specialist]'`, port from `PORT` (default 41243). Log `[Hub] listening on <baseUrl>`, the card URL and `router: <mode>` (live adds the model, `API key (<VAR>): configured|NOT SET` and `API host: …`).
5. Call `loadHubConfig()` and `useModel(cfg.model)` at startup. Mount routes inside the `listen()` callback (check `err` first) with `hostGuard(actualPort)`.
6. **Public card** at `/.well-known/agent-card.json` (`cache: { maxAge: 0 }`), JSON-RPC at `/a2a/jsonrpc`:
   - `name`, `description` from config; `version: '0.1.0'`; one JSONRPC 1.0 interface.
   - `capabilities: { streaming: false, pushNotifications: false, extensions: [A2UI v0.9, basic catalog, required: false] }`; empty security.
   - Input `text/plain` + `application/a2ui+json`; output those plus `application/json`.
   - `skills`: one per destination `{ id, name, description, tags, examples }`. Never worker names, URLs or specialist cards.
7. **Executor order:** control data part → control handling. Then the student check. Then an A2UI part → form action. Otherwise chat.
8. Student check: `metadata.studentId` must be in `cfg.students`. Otherwise reply "This university front door only serves enrolled students configured for this demo." with `hub: { decision: 'rejected', reason: 'unknown_student' }`.
9. **Registry** (`src/hub-registry.js`): one in-memory entry per peer. Track registered, `instanceId`, enabled, heartbeat time, card, view, ETag, revision, card status, reachable and last error separately.
10. Status, first match wins: not registered → `disconnected`; heartbeat older than expiry → `stale`; invalid card → `invalid_card`; no card or unreachable → `unreachable`; disabled or no skills → `disabled`; else `ready`.
11. Only `ready` gets new work. A ticker re-checks every `max(200, expiryMs/4)` ms. Each change emits `registry_status`.
12. `register` refuses `unknown_peer`, `unexpected_endpoint` (endpoint or card URL differ from config), a malformed `instanceId` (`^[\w-]{8,64}$`), and `identity_in_use` (another unexpired instance).
13. On accept: emit `registration_accepted`, fetch and validate the card from the configured URL, then reply.
14. A heartbeat from an unknown instance gets `not_registered`. A heartbeat after `stale` or `unreachable` triggers a refresh.
15. `cardChanged` accepts only the registered instance, dedupes `notificationId` (keep 200), and re-fetches the card. Never apply anything from the notice.
16. `refresh` is coalesced: concurrent calls share one fetch plus at most one follow-up. 304 keeps the card. A failed refresh keeps the last good card.
17. `card_refreshed` carries `{ agentId, reason, changed, revision, etag, skills: [{ id, name }] }`.
18. `routingView()` gives `{ agentId, name, available, status, skills }` per peer with a card. Never URLs.
19. **`src/cards.js`:** move `getCard(url, etag, timeoutMs)` and `validateCard` out of `src/router.js` (Step 5) unchanged; `router.js` no longer exports them. `getCard` uses `node:http`, sends `If-None-Match` when it has an ETag, caps the body at 64 KB and follows no redirects.
20. `validateCard`: `name === peer.expectedName`; exactly one JSONRPC 1.0 interface with `url === peer.rpcUrl`; no security settings; at most 16 well-formed skills. The view includes scope `allowed`/`excluded` from the skill-scope extension.
21. **Routing** uses the same `src/router.js` from Step 5 (`decideRoute`, `validateDecision`, `routerStatus`). Its header comment now says it is the Hub's router. Keep the event names `route_decided` / `route_failed`; the Hub emits them now, not the UI server.
22. Add `publicWords(value, services)` to `src/router.js`: in text the student reads (reason, clarifying question), replace each service's `name` with its `publicName` and drop "(<name>)". `validateDecision` applies it.
23. The router's `services` = registry view plus `destination`, `publicName` and `description` from that peer's destination. A specialist is reachable only through its own destination.
    - The live model sees each service **without** `available`/`status` (strip them in `decideRoute`): readiness is decided in code — a route to a specialist that isn't ready becomes `unavailable` (“service unavailable”).
    - Router prompt: if the student answers your clarification with “I don't know” / “not sure”, never repeat the question — ask about the work itself with an example of each option.
24. `ROUTER_MODE=direct` routes everything to the `tutoring` worker (`unavailable` if none).
25. Keep 6 recent turns per conversation (question, agent, skill, reply snippet), so "yes" after a clarifying question works.
26. A `route` to a non-ready specialist becomes `unavailable`: "Library Agent is not available right now (it isn’t connected)." Never show raw status codes.
27. Only `route` dispatches. The Hub answers `clarify`, `unsupported` and `unavailable` itself in plain words.
28. Live routing emits `model_call_started`, `model_response_received` (`latencyMs`, `usage`) or `model_call_failed`, all with `purpose: 'routing'`.
29. **Two A2A legs:** the Student↔Hub `contextId` is the conversation. The Hub keeps one downstream `contextId` per (conversation, specialist) and sends its own `messageId`.
30. Forward with `askTutor(peer.baseUrl, question, { runId, contextId, messageId, card: registry.entry(id).card, timeoutMs: cfg.timeouts.dispatchMs, metadata })`. The URL comes from configuration only.
31. A conversation belongs to its first student. Another gets "This conversation belongs to another student."
32. **`chatLedger`**, keyed `<upstream contextId>|<messageId>`, holds the reply promise. A repeat reuses it, emits `request_repeat`, and dispatches nothing.
33. `forward_failed` has `outcome` `answered_with_error`, `unknown` or `not_delivered`. For unknown, say it didn't answer in time and nothing is assumed undone.
34. **Form references:** for a returned form, record `formRef = 'hf-' + uuid` → student, upstream context, issuer, workflow, downstream `{ formId, taskId, contextId, formVersion }`, state `open`, created time. A form with `supersedes` marks the older open reference `superseded`.
35. Return the form as the Hub's **own task** in `INPUT_REQUIRED`, with the form metadata from Contract 4.
36. **Form actions** need `formRef` and an `operationId` matching `^[\w-]{8,100}$`. Refuse without forwarding when the reference is unknown or altered, another student's or conversation's, older than `HUB_FORM_TTL_MS` (default 2 h), superseded, or the `surfaceId` isn't the form's ID.
37. **`operations`** dedupes by `operationId` over a hash of `{ name, context, reviewAcknowledged }`. Same hash → stored result with `duplicate: true` (`form_action_duplicate`). Different hash, or a closed form → refuse.
38. Forward to the **recorded issuer**: `sendFormAction(peer.baseUrl, { form: downstream, action, operationId, runId, card, acknowledgeReview, timeoutMs: cfg.timeouts.formActionMs, metadata })`. Never route a form action by its content.
39. Cache only definite results. Specialist timeout → `{ status: 'outcome_unknown' }`. Unreachable → `{ status: 'not_delivered' }`. Never retry automatically.
40. Resuming the Hub's form task: re-publish `ctx.task`, then a status update — `COMPLETED` for `accepted`/`cancelled`, else `INPUT_REQUIRED`.
41. **`src/student-agent.js`:** logs use `process.env.A2A_CLIENT_LABEL ?? '[Student Agent]'`. `askTutor` and `sendFormAction` gain a `metadata` option (default `{}`) merged into the message metadata, and a `card` option: an already-validated Agent Card that is used as-is instead of fetching the card again. Full option lists after this step:
    - `askTutor(baseUrl, text = STUDENT_MESSAGE, { runId, contextId = '', messageId = randomUUID(), timeoutMs = CHAT_TIMEOUT_MS, card, metadata = {}, onEvent = () => {} } = {})`
    - `sendFormAction(baseUrl, { form, action, operationId, runId, card, acknowledgeReview = false, timeoutMs = SUBMIT_TIMEOUT_MS, metadata = {}, onEvent = () => {} })`
    - Step 9b adds `signer = null` to both.
42. `sendFormAction` sends the form's `formRef`. Body `status: 'outcome_unknown'` throws with `outcome: 'uncertain'`; `'not_delivered'` throws with `outcome: 'not_delivered'`.
43. Replies expose `servedBy` (from `metadata.agentId`), `servedByName` and `hub`. Forms keep `issuer` and `formRef`.
44. **Telemetry:** `/viz/events` (SSE) first sends a Hub `status` event with the snapshot, then each specialist's last `status`, then live `{ source, type, runId, at, data }`.
45. The Hub follows each peer's `vizUrl` (retry every 1 s), emits `specialist_feed { agentId, connected }`, and relays events with `source: agentId` and `data: redactTelemetry(ev)`.
46. `/viz/topology` returns the snapshot (Hub, router status, destination → worker map, specialists with active counts) plus `feeds`.
47. **Developer proxy** (HTTP, not A2A): `GET /dev/agents/:agentId/skills`, `POST …/skills/preview`, `PUT …/skills` → the peer's `settingsUrl`. `POST /dev/registry/refresh` → 202, refresh every peer. Non-GET `/dev/*` routes use `sameOriginGuard(actualPort)`.
48. The Hub never logs message text.

### Task C — Specialists register with the Hub

1. `src/hub-link.js` exports `createHubLink({ agentId, hubUrl, endpoint, cardUrl, enabled, heartbeatIntervalMs, emit, log })` → `{ state, instanceId, start, stop, notifyCardChanged }`.
2. `instanceId` is a new random UUID per process.
3. Send over A2A with `new ClientFactory().createFromUrl(hubUrl)` and a 3 s timeout. Drop the client after an error so a restarted Hub is found again.
4. `start()` registers, then beats every `heartbeatIntervalMs` (timer `unref`'d). A beat while unregistered, or a `not_registered` ack, registers again.
5. Each registration emits `hub_registration { status, reason, hubUrl }`; `status: 'not_delivered'` when the Hub is offline.
6. `stop()` sends a deregister, best effort.
7. `notifyCardChanged({ revision, reason })` → `{ notificationId, outcome: 'delivered' | 'rejected' | 'pending', detail }`. Pending = Hub offline; it re-fetches the card when this agent registers.
8. In `src/tutor-agent.js` and `src/library-agent.js`: `const CONFIG = loadSpecialistConfig('<role>')` and `useModel(CONFIG.model)` at startup.
9. Inside the `listen()` callback, create the link with `endpoint = <baseUrl>/a2a/jsonrpc`, `cardUrl = <baseUrl>/.well-known/agent-card.json`. Call `hubLink.start()` after mounting routes.
10. Hub-link events go on the agent's own viz feed with `runId: null`.
11. When run directly, on SIGINT/SIGTERM race `hubLink.stop()` against 800 ms, then exit 0.
12. Keep the `[Tutor Agent] listening on …` and `[Library Agent] listening on …` lines unchanged.
13. `src/agent-settings.js`: `createSkillService` takes `notify` (the link's `notifyCardChanged`) instead of Step 5's `notifyStudent`. One notice per save, no retry loop, no startup notice. Emit `card_notification` with the result.
14. Remove `STUDENT_URL` and `notifyStudent` from the specialists. They never contact the Student.

### Task D — Student side and tests

1. In `src/ui-server.js`, **remove** Step 5's temporary trusted registry, the `decideRoute` call with its `route_requested` / `route_decided` / `route_failed` events, and the `/a2a/jsonrpc` receiving endpoint for card notices.
2. Use `loadStudentConfig()`. The only destination is `cfg.university.hubUrl`.
3. Discover the Hub card with `getCard` + `validateCard(card, { expectedName: <university name>, rpcUrl: <hubUrl>/a2a/jsonrpc })`. Keep the validated skills.
4. Re-read the card at startup, on send if missing, when the Hub feed reconnects, and on "Refresh skills". Publish `card_discovered { name, url, skills, reason }` or `hub_card_failed`.
5. No valid card at send time → `request_failed` with `outcome: 'not_delivered'`; nothing sent.
6. Every chat and form action goes to the Hub with `metadata: { studentId: cfg.agentId }`. Form actions carry the form's `formRef`.
7. `registerForm` refuses a form without `issuer` or `formRef`.
8. Follow only the Hub's `/viz/events` (retry every 1 s); publish `hub_feed { connected }` on change.
9. Hub `status` → `topology` event. Specialist `status` → `agent_status`. Run-less events pass only from the Hub or for `skills_saved`, `card_notification`, `hub_registration`. Run events pass only for this UI's runs.
10. A Hub `message_received` moves the run to `waiting`.
11. `/api/status` adds `university: { name, cardUrl, cardValid, cardError, capabilities }`, `hubFeedConnected`, `topology`, `agents`.
12. Skill settings go through the Hub: `/api/agents/:agentId/skills` (GET, PUT, `/preview`) → `<hubUrl>/dev/agents/:agentId/skills…`. `POST /api/registry/refresh` re-reads the Hub card and calls `<hubUrl>/dev/registry/refresh`.
13. Startup log: `[UI] Student Agent connects only to California State University Fullerton at <hubUrl>`.
14. **Browser:** add a Hub panel showing the Hub's events. Chat bubbles and form cards say "California State University Fullerton · Tutor Agent" (or Library Agent). The Hub's own replies use the Hub's color.
15. Skills boxes show "Advertised" beside the "Hub's view" (from `card_refreshed`), and saved → notice delivered → Hub routing updated.
16. **Harness:** `startHub(env)` spawns `src/hub-agent.js` with `PORT=0`. Change Step 2's `startUi(tutorUrl, env)` to `startUi(hubUrl, env)`, setting `HUB_URL` instead of `TUTOR_URL`.
17. `startStack({ tutorEnv, libraryEnv, hubEnv, uiEnv, library = true, tutorPort, libraryPort, waitReady = true, readyAgents })`:
    - Pre-pick specialist ports with `unusedPort()` so the Hub's `TUTOR_URL`/`LIBRARY_URL` name them.
    - Specialists no longer get `STUDENT_URL`; drop Step 5's UI-port pre-pick for it.
    - Start the Hub (`HEARTBEAT_EXPIRY_MS=3000`), then the specialists (`HUB_URL`, `HEARTBEAT_INTERVAL_MS=500`), then the UI.
    - Wait until the UI's `hubFeedConnected` and `university.cardValid` are true, and every `readyAgents` member (default: tutor, plus library if started) is `ready` in `/viz/topology` **and** has `feeds[id]` true.
    - Return `{ hub, tutor, library, ui, tutorPort, libraryPort, specialistEnv, kill() }`. `kill()` reads the processes from the object, so a restarted one is killed too.
    - If readiness fails, kill everything, then throw.
18. `export const startTrio = startStack`. `startProcess` defaults `HUB_URL=http://127.0.0.1:9`, so no test process registers with a real Hub.
19. `chatVia(ui, stream, text, contextId)` posts `/api/runs`, waits for the run to end and for the destination's `reply_published` or `form_sent`. Returns `{ runId, contextId, events, decision, reply, destinations }`.
20. **Port every existing test** (including `test/ui.test.js`) onto the Hub. Assert the real destination from the specialist's own `message_received` and the reply's `servedBy`.
21. Tests that read specialist event values beyond IDs and statuses pass `hubEnv: { HUB_TELEMETRY_SHOW_CONTENT: '1' }` now, so Step 7b's redaction won't break them.
22. Step 4 plumbing tests keep `TUTOR_SCOPE_ENFORCEMENT=off`. Routing tests set `ROUTER_MODE=mock` on the Hub.
23. `test/card-refresh.test.js` targets the Hub: settings via the proxy; save → new ETag → notice → Hub re-fetch → routing changes; duplicate and spoofed notices; offline Hub → pending, then re-registration fetches the current card; failed refresh keeps the last good card; no model calls.
24. `test/tutor-llm.test.js` adds: a Tutor with `TUTOR_MODEL=claude-sonnet-5-5` and its own key variable reaches the fake provider with that model.
25. **New `test/hub.test.js`** (mock router, `HUB_STUDENTS=student-alex,student-sam`) checks:
    - The Student's status shows only the Hub card; no specialist URL appears in it.
    - Route, clarify and unsupported are all answered over the Student↔Hub leg.
    - An unknown student is refused; another student can't use a form; a form can't be used from another conversation or with an altered reference.
    - A Hub-level unknown outcome isn't retried; reconcile with the same operation ID records once.
    - Heartbeat expiry → `stale`, sign-out → `disconnected`, `SPECIALIST_ENABLED=0` → `disabled`; none get new requests.
    - Concurrent requests from separate conversations stay separate.
    - A repeated chat request ID gets `request_repeat` and one dispatch.
    - Invalid configuration (Student with `tutorUrl`, non-local URL, unknown model, key in file) throws `ConfigError`.
26. **`test/skills.test.js`**: add the test `words the student reads name services publicly, never by agent`. With `services = [{ agentId: 'tutor', name: 'Tutor Agent', publicName: 'Tutoring', skills: [] }]` it checks, through `validateDecision` (which applies `publicWords`):
    - a clarify decision with `clarification_question: 'Which subject: Calculus (Tutor Agent)?'` → `clarificationQuestion` is `'Which subject: Calculus?'` (the "(<name>)" is dropped);
    - `reason: 'Could be Tutor Agent.'` → `'Could be Tutoring.'`;
    - ordinary words stay: an `unsupported` decision with reason `'Ask the tutor at the library.'` keeps that reason unchanged.
    Step 9a extends this test with the Professor.

## Phase 3 — Join and check (lead)

1. Confirm `src/ui-server.js` no longer imports `src/router.js` and has no A2A receiving endpoint.
1a. Cross-task checks that each task could not run alone:
    - `PORT=0 node src/hub-agent.js` prints `[Hub] listening on http://127.0.0.1:<port>` (Task B with Task A's config).
    - With that Hub running, `HUB_URL=<hub> PORT=0 node src/tutor-agent.js` logs a hub registration with `status: 'registered'` (Task C). Stop both by PID.
2. Run `npm test`. Fix failures in the owning file.
3. (Optional — needs a browser; if none is available, say so.) Run `npm run demo`. Open `http://127.0.0.1:4444`. Ask "Explain the derivative of x squared" and "How do I renew a library book?". Check each reply's label. Stop with Ctrl+C.

## Rules that apply to the whole step

1. Topology is fixed: Student → Hub → Tutor or Library → Hub → Student. Both legs are real A2A.
2. Specialist endpoints come only from the Hub's configuration, never from a card, message, model output or user text.
3. The Hub forwards each request to at most one specialist. Specialists never forward.
4. Registration, heartbeats, sign-out and card notices are this app's conventions carried in A2A data parts, not built-in A2A features. Say so in comments.
5. Self-declared identity on localhost is not authentication.
6. All Hub state is in memory. A restart forgets registrations, forms and dedupe records.
7. Specialists keep enforcing their own current scope, even when the Hub's view is stale.
8. Configuration changes and notices never trigger model calls.
9. Each process calls `useModel()` from its own config; code reads `modelName()`. Only models in `src/models.js`; no fallback model.
10. Startup lines name the key variable, never the value. No key in any config file.

## Avoid these known problems

- Give the router model the services' skills only, never `available`/`status`: shown an offline service, it answered an outage with "not supported". Readiness is decided in code.
- "I don't know" to the router's clarification: ask about the work itself with an example of each option, never the same question again.
- Pre-pick specialist ports (no `PORT=0`), wait for the Hub's feeds, and kill the stack's current processes; a restarted specialist kept in a closure hung the runner.
- A specialist restarted after a crash is refused (`identity_in_use`) until its old heartbeat expires (3 s in tests).
- Simulate a crash with `SIGKILL`. `SIGTERM` signs out instead.
- Fetch cards with `node:http`. Node's `fetch` adds `Cache-Control: no-cache` to conditional requests, so Express never answers 304.
- Keep `not_delivered` and `outcome_unknown` separate. A plain "rejected" hides whether a retry is safe.
- A Hub-answered reconcile has no specialist "duplicate" marker. Assert on `request_repeat` and one dispatch.
- The Hub reuses the Student's A2A client, which logs text by default. Set `STUDENT_LOG_CONTENT=0` in the Hub.
- `messageReply()` in the fake Anthropic server already returns `{ status, json }`. Don't wrap it again.
- Stop servers by port: `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`. Never a loose `pkill`.
- In shell loops over test files, pass `--test-timeout`. A hung child keeps `node --test` alive.

## Done when

- `npm test` → all tests pass, 0 failed.
- `node --test test/hub.test.js` passes.
- `node -e "import('./src/hub-agent.js').then(m => console.log(typeof m.redactTelemetry))"` prints `function` and exits.
- `HUB_MODEL=claude-foo node src/hub-agent.js` exits with `Invalid Hub configuration:` listing the allowed models.
- `grep -n "router.js" src/ui-server.js` prints nothing.
- Manual (optional — needs a browser; if none is available, say so): `npm run demo` → both questions answered with the right "California State University Fullerton · …" label. Then `kill $(lsof -tiTCP:41242 -sTCP:LISTEN)`; about 10 s later a library question gets the "not available right now" reply.

Then append the "CLAUDE.md notes" below to `CLAUDE.md` and commit `Step 7a: The University Hub in the middle`.

## CLAUDE.md notes

```markdown
## Step 7a — University Hub
- Fixed topology: Student → Hub (:41243) → Tutor/Library. Student config forbids specialist URLs; endpoints come only from the Hub config (TUTOR_URL/LIBRARY_URL override). Invalid config throws ConfigError — never fall back.
- Config: src/config.js over config/*.example.json (STUDENT_CONFIG/HUB_CONFIG/TUTOR_CONFIG/LIBRARY_CONFIG). HUB_STUDENTS replaces the Hub's student allowlist.
- Control messages (register, heartbeat, deregister, card changed) are typed A2A data parts handled before any student check. Registered ≠ ready; only `ready` gets dispatches.
- Two A2A legs with separate IDs. chatLedger dedupes chat repeats; `operations` dedupes form actions (definite results only).
- Form actions carry formRef and go to the recorded issuer. Hub statuses outcome_unknown / not_delivered → uncertain / not_delivered.
- src/hub-agent.js starts a server only when run directly (tests import redactTelemetry).
- Tests: startStack (alias startTrio) pre-picks specialist ports and waits for Hub feeds; readyAgents for disabled specialists; heartbeat expiry 3 s.
- Specialists sign out on SIGTERM; crash tests use SIGKILL and wait for expiry.
- Per-agent model: config `model: { name, apiKeyEnv }`, <ROLE>_MODEL overrides, checked against src/models.js.
```

## Show it (optional)

- Free: `npm run demo`, open `http://127.0.0.1:4444`. Ask a calculus question, a library question, "I want to reserve a group study room", and "How do I fix my plumbing?".
- PAID (a few cents): `env -u ANTHROPIC_BASE_URL npm run demo:live`. Each live startup line must say `API host: api.anthropic.com`.
- A later step adds a Professor behind the same Hub. Keep peers, destinations and the registry driven by config, so a new peer needs no Hub code changes.
