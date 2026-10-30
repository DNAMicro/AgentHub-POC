# A2A Spike — Source map for the teaching site (Steps 1–11)

Repository: this one (`..` from this folder). Sources: `Steps/README.md`, `Steps/01–09-*.md`, `CLAUDE.md`, `README.md`, `package.json`, git history (32 commits on `main`, `79c6ef4` → `36ba0a6`), `test/*.test.js`. All statements below are cited; anything inferred is labelled **[reconstructed]** or **[unknown]**.

---

## Introduction

**Problem.** Show, with real protocols rather than mock transcripts, how independent AI agents discover each other, exchange messages, hand structured UI to a person, get routed by an intermediary, and start conversations from either side.

**Users (fictional).** A student, **Alex Student** (`student-alex`, `alex@example.com`), a second enrolled student **Sam Student** (`student-sam`, no Student agent), and a professor using the Professor view. Everything is fictional sample data (CLAUDE.md "Scope constraints"; Steps/09 §4).

**Purpose.** A learning spike, built in 9 prompted steps, each "explain → implement → test → stop so I can understand" (Steps/01 "Teaching style"). Each `Steps/NN-*.md` is the original prompt with later enhancements merged, plus "Avoid these known problems" and "Enhancements merged" sections (Steps/README.md).

**What it demonstrates (final state).**
- Real **A2A v1.0** (JSON-RPC binding) between separate Node processes via `@a2a-js/sdk` 1.3.0 — Agent Card discovery, Messages, Tasks (`INPUT_REQUIRED`), typed data parts (README "How a message gets there and back").
- **A2UI v0.9** forms carried inside A2A and rendered by the official `@a2ui/lit` 0.14.0 renderer, including model-composed UI validated against the official schemas (Steps/03, 08).
- **Claude Haiku 5.5** (`claude-haiku-5-5`, `@anthropic-ai/sdk` 1.3.0) used per agent for answers, scope checks, routing, clarifying, form review, UI composition and professor assistance (CLAUDE.md).
- A **University Hub** (public name “California State University Fullerton”, fictional) as the only front door, with private registry, routing, relaying, form-reference mapping and dedupe (Steps/07).
- **Reverse-direction** communication: a Professor posts lessons Professor → Hub → Student as new signed A2A interactions (Steps/09).
- Honest visualization: a separate SSE telemetry channel that only reports real events (CLAUDE.md "Three channels").

**Out of production scope** (CLAUDE.md "Scope constraints"; README "Deliberately not included"): token streaming, A2A push notifications, multi-agent fan-out (Hub forwards to at most one specialist), mailboxes, database (only JSON files under `data/`), real auth/accounts (Part 9 keys are a local demo measure), real email/SMS, frontend frameworks, model tools, model-generated code/HTML (model-generated UI only in Part 8 from the validated catalog), deployment. All servers bind `127.0.0.1`. Dependencies pinned exactly.

**Final dependencies** (`package.json`): `@a2a-js/sdk` 1.3.0, `@a2ui/lit` 0.14.0, `@a2ui/web_core` 0.14.0, `@anthropic-ai/sdk` 1.3.0, `ajv` 8.20.0, `express` 5.3.0, `lit` 3.3.3; dev: `esbuild` 0.28.2, `jsdom` 30.1.2. Node ≥20.

---

## Step 1 — Two agents talking over A2A

1. **Title / commits:** "Student Agent ↔ Tutor Agent over the real A2A protocol". `79c6ef4` (spike), `bd61b67` (CLAUDE.md) — verified in git (both 2026-10-25).
2. **Before:** Empty project folder.
3. **Intent:** "Build a minimal local spike that proves two agents can communicate using the actual Agent-to-Agent (A2A) protocol… a protocol connectivity test, not an AI intelligence test" (Steps/01).
4. **Built:** `src/tutor-agent.js` (Agent B, A2A server on 127.0.0.1:41241; `tutorExecutor` → `DefaultRequestHandler` → `jsonRpcHandler`/`agentCardHandler`; fixed `TUTOR_REPLY`), `src/student-agent.js` (Agent A; `askTutor(baseUrl, text)` uses `DefaultAgentCardResolver` + `ClientFactory().createFromAgentCard(card)` + `client.sendMessage`), `test/a2a.test.js`, README, lockfile. Contracts: `GET /.well-known/agent-card.json`; `POST /a2a/jsonrpc` method `SendMessage`; one text part; log lines with `messageId`/`contextId`/`taskId`; `listening on http://127.0.0.1:<port>`.
5. **Technologies introduced:** `@a2a-js/sdk` 1.3.0 (A2A v1.0 client+server, protobuf-shaped types), `express` 5.3.0 (HTTP host for SDK adapters). Node `node:test` for tests.
6. **Changed / corrections:**
   - CLAUDE.md added after the spike via `/init` (`bd61b67`, same step).
   - Port-safe startup (Express 5 passes EADDRINUSE to the listen callback) and routes mounted inside `listen()` so the card URL has the real port — rules in Steps/01 "Avoid".
   - The fixed reply was deliberately kept until Step 4 (Steps/02 "Enhancements").
7. **Evidence:** `test/a2a.test.js` (4 tests): "Agent Card is discoverable and advertises the A2A JSON-RPC interface", "Student sends via the A2A client and receives the exact Tutor reply", "…exchange is traceable in both logs", "negative: unavailable Tutor yields a clear connection failure, not a fake reply". Suite after step: 4 (counted at `79c6ef4`). No live checks (deterministic by design).
8. **Pitfall → lesson:** SDK 1.x uses A2A **v1.0 protobuf-shaped** types (parts `{ content: { $case: 'text', value } }`, enum roles, `supportedInterfaces`), not the v0.3 examples online — read the package `.d.ts` files.
9. **Architecture after:**
   - Components: **Student Agent (CLI process) [ADDED]**, **Tutor Agent [ADDED]**.
   - Edges: Student → Tutor `HTTP GET /.well-known/agent-card.json` (discovery) **[ADDED]**; Student → Tutor `A2A SendMessage JSON-RPC: question text` / Tutor → Student `A2A Message: fixed reply text` **[ADDED]**.
10. **User action** ("Hello Tutor Agent. Can you help me with calculus?"):
    1. `npm run tutor` → Tutor listens, builds Agent Card (`src/tutor-agent.js`).
    2. `npm run student` → Student fetches `/.well-known/agent-card.json` (`askTutor`, `src/student-agent.js`).
    3. `ClientFactory` picks JSON-RPC from `supportedInterfaces`.
    4. Student `sendMessage` → `POST /a2a/jsonrpc` `SendMessage` with `ROLE_USER` text part.
    5. SDK `jsonRpcHandler` decodes; `DefaultRequestHandler` assigns `contextId`/`taskId`.
    6. `tutorExecutor.execute()` logs `received message`, publishes `AgentEvent.message` with the fixed reply.
    7. JSON-RPC result returns the `Message`; Student logs `received reply` and prints the text.
11. **Code example** — `src/tutor-agent.js:70-77` (current file; same shape since `79c6ef4`):
    ```js
    supportedInterfaces: [
      {
        url: `http://${HOST}:${port}${JSONRPC_PATH}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: '',
      },
    ],
    ```
12. **Test:** `node --test test/a2a.test.js` → 4 pass. Manual: `npm run tutor` then `npm run student` → prints "Hello Student Agent. Yes, I can help you with calculus." With Tutor stopped, Student fails with a connection error.
13. **Unknown:** Steps/01 was first committed in `c81e566` (Part 6 commit), i.e. written retrospectively **[reconstructed wording risk]**.

---

## Step 2 — Browser monitor for the A2A exchange

1. **Title / commits:** "Browser UI that shows the real A2A exchange via a separate visualization event stream". `dad775b` (verified).
2. **Before:** CLI-only exchange; only logs to watch.
3. **Intent:** "Enhance the existing two-agent A2A spike with a simple browser UI so I can watch the agents communicate" — truthful, run-correlated, never resending on reconnect (Steps/02).
4. **Built:** `src/ui-server.js` (hosts the Student in-process; UI port then **3000**), `public/index.html`, `public/app.js`, `public/styles.css`, `test/ui.test.js`. Contracts: `POST /api/runs` (only place an A2A request starts), `GET /api/events` (SSE to browser, history replay, dedupe by `seq`, reset on new `bootId`), Tutor `GET /viz/events` (SSE, read-only). A2A message carries `metadata: { runId }`. Events: `run_started`, `request_sent`, `message_received`, `reply_published`, `reply_received`, `request_failed`; states idle/sending/waiting/completed/failed (README "The browser monitor").
5. **Technologies:** no new package. Architectural change: a **second, visualization-only channel (SSE)** separate from A2A; plain HTML/CSS/JS.
6. **Changed / corrections:**
   - "Switchboard" visual design and self-hosted fonts (`public/fonts/`) applied **after Step 6** (`c81e566`), merged into Steps/02.
   - User asked whether the reply is always fixed; kept fixed until Step 4 (during step).
   - UI port later changed 3000 → 4444 (`9150c60`, Part 9).
7. **Evidence:** `test/ui.test.js` (6 at `dad775b`): "typed message round-trips through A2A and every step is observed", "events from separate runs are correlated by runId and never mixed", "a second submission while a run is in progress is rejected", "browser reconnect replays history but never resends the A2A request", "unavailable Tutor: real error is shown…", "input validation…". Suite: 10. Browser verification: required by prompt; outcome not recorded **[unknown]**.
8. **Pitfall → lesson:** Telemetry arrives on a separate connection and can land *after* the A2A reply — wait for events, never assume order; never move a finished run backwards.
9. **Architecture after:**
   - Components: Browser UI **[ADDED]**, UI server hosting Student Agent **[ADDED]** (CLI Student still exists), Tutor Agent, SSE telemetry channel **[ADDED]**.
   - Edges: Browser → UI server `HTTP POST /api/runs: typed text` **[ADDED]**; UI/Student → Tutor `A2A SendMessage: text + metadata.runId` **[MODIFIED]**; Tutor → UI server `SSE /viz/events: telemetry` **[ADDED]**; UI server → Browser `SSE /api/events: telemetry + replay` **[ADDED]**.
10. **User action:**
    1. Alex types the prefilled message, clicks Send (`public/app.js`).
    2. Browser `POST /api/runs` → UI server creates `runId`, publishes `run_started` (`src/ui-server.js`).
    3. `askTutor(text, { runId })` fetches card, emits `request_sent`.
    4. A2A `SendMessage` with `metadata.runId` → Tutor.
    5. Tutor executor emits `message_received` on `/viz/events` (`src/tutor-agent.js`).
    6. Tutor publishes reply (carries `runId`), emits `reply_published`.
    7. Student emits `reply_received`; state `completed`.
    8. UI server relays all events over `/api/events`; browser renders with `textContent`.
11. **Code example** — `src/tutor-agent.js:42-45`:
    ```js
    // Visualization-only feed. Events are emitted from the executor at the moment
    // they actually happen; nothing here carries or replaces A2A traffic.
    const vizEvents = new EventEmitter();
    const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'tutor', type, runId, at: new Date().toISOString(), data });
    ```
12. **Test:** `node --test test/ui.test.js` (current version runs through the Hub stack; 7 tests incl. tab addresses). Historical: `npm test` at `dad775b` → 10 pass.
13. **Unknown:** whether a real-browser pass was done in Step 2.

---

## Step 3 — A2UI form sent by the Tutor, submitted over A2A

1. **Title / commits:** "A2UI v0.9 student-details form sent by the Tutor, rendered in the browser, submitted back over A2A". `d9a1e9b`, `3f31bb5` (verified; `3f31bb5` dated 2026-10-26).
2. **Before:** Text-only exchange; no structured UI.
3. **Intent:** "An A2UI form sent by Tutor Agent, completed by the student, and returned to Tutor Agent through A2A" — real A2UI messages, renderer-driven, validated in three places (Steps/03).
4. **Built:** `src/student-form.js` (shared, dependency-free: form builder, validation, payload allowlist; served at `/shared/student-form.js`), `src/browser/a2ui-entry.js` (bundled to `public/vendor/a2ui.js`), `src/local-guard.js` (Host/Origin guards), Tutor form handling, `test/form.test.js`, `test/a2ui-render.test.js`, `test/support/{a2ui-schema,harness,render-form}.js`. Contracts: form request = A2A message with `metadata.request = 'student-details-form'` plus `metadata.a2uiClientCapabilities` and header `A2A-Extensions: https://a2ui.org/a2a-extension/a2ui/v0.9`; reply = **Task in `INPUT_REQUIRED`** with DataPart `mediaType` and `metadata.mimeType` = `application/a2ui+json` (`createSurface`/`updateComponents`/`updateDataModel`, basic catalog); submission = A2UI `action` DataPart (`submitStudentDetails`) with `submissionId`; resume by `taskId`, or new message with `referenceTaskIds` if terminal (`GetTask` check). UI server: `POST /api/forms`, `POST /api/forms/:formId/submissions`. Delivery outcomes `not_delivered` / `uncertain`.
5. **Technologies:** `@a2ui/lit` 0.14.0 + `@a2ui/web_core` 0.14.0 (official A2UI v0.9 renderer/core), `lit` 3.3.3 (renderer's web-component base); dev: `esbuild` 0.28.2 (browser bundle, `npm run build:ui`), `jsdom` 30.1.2 (render tests), `ajv` 8.20.0 (schema validation in tests) — from `git show d9a1e9b -- package.json`.
6. **Changed / corrections:**
   - Strict Student-side A2UI payload allowlist after a security review (`3f31bb5`, same step).
   - Pinned v0.9, not v0.9.1, to match the renderer's registered catalog (during step).
   - **Step 6 replaced the entry point:** "Request form" button, `POST /api/forms`, `student-form.js` and the student-details form were removed (`c81e566`); mechanics kept (now `src/forms.js`).
   - `submissionId` dedupe was generalised to `operationId` in Step 6.
7. **Evidence:** at `d9a1e9b`: form.test.js (8) e.g. "valid round trip: Tutor receives all four values exactly…", "duplicate submission is processed once…", "uncertain delivery is reported honestly…", "localhost guards…"; a2ui-render.test.js (5) e.g. "received A2UI payload validates against the official v0.9 schemas", "editing fields only changes local draft state…". `3f31bb5` added `test/payload-policy.test.js` (4). Suite: 23 → 27.
8. **Pitfall → lesson:** A completed A2A task is terminal — check with `GetTask` first and otherwise send a new message in the same context with `referenceTaskIds`; never "resume" a finished task.
9. **Architecture after:**
   - Components: Browser UI (+ A2UI renderer bundle) **[MODIFIED]**, UI server/Student, Tutor, SSE channel.
   - Edges: Browser → UI server `POST /api/forms`, `POST /api/forms/:id/submissions` **[ADDED]**; Student ↔ Tutor A2A now also carries `metadata.request`, A2UI Task (`INPUT_REQUIRED`, `application/a2ui+json`) and A2UI action DataParts **[MODIFIED]**; UI server → Browser SSE also delivers the received A2UI payload to the renderer **[MODIFIED]**.
10. **User action:**
    1. Alex clicks "Request form" (`public/app.js`) → `POST /api/forms`.
    2. Student sends A2A request with `metadata.request` (`src/student-agent.js`).
    3. Tutor builds the A2UI form, returns Task `INPUT_REQUIRED` (`src/tutor-agent.js`).
    4. Student allowlists payload (`src/student-form.js`), UI server sends it over SSE.
    5. Browser renders with `@a2ui/lit`; drafts stay local (`sendDataModel: false`).
    6. Submit → browser validation → `POST /api/forms/:formId/submissions`; UI server re-validates.
    7. Student sends A2UI action DataPart resuming `taskId` (or `referenceTaskIds`).
    8. Tutor validates, dedupes by `submissionId`, records in memory, acknowledges; panels show values and ack.
11. **Code example** — `git show d9a1e9b:src/tutor-agent.js` lines 100-102 (unchanged today as `src/form-host.js:20`):
    ```js
    // A2A v1.0 Parts have a native mediaType; the A2UI extension spec (written against A2A v0.3
    // examples) names metadata.mimeType. Set both so either reading finds it.
    const a2uiPart = (messages) => ({ content: { $case: 'data', value: messages }, metadata: { mimeType: A2UI_MIME_TYPE }, filename: '', mediaType: A2UI_MIME_TYPE });
    ```
12. **Test:** `node --test test/a2ui-render.test.js test/payload-policy.test.js` (current versions test the Part 6 forms). Historical `npm test` at `3f31bb5` → 27.
13. **Unknown:** today's repo no longer contains the Step 3 form; teach it from git `d9a1e9b`.

---

## Step 4 — Tutor answers with Claude Haiku 5.5

1. **Title / commits:** `e996a6a` (Part 4), `5cc671d` (live-mode fixes, committed after Part 5's first commits) — verified.
2. **Before:** Tutor returned one fixed sentence whatever was asked.
3. **Intent:** "Connect Tutor Agent to Anthropic Claude Haiku 5.5 so it gives real, contextual tutoring responses", with server-side key, bounded history, cost/failure controls (Steps/04).
4. **Built:** `src/tutor-model.js` (`TUTOR_MODE` fixed/mock/live read at import; `SYSTEM_PROMPT`; history per `contextId`, 10 msgs / 12,000 chars; ledger keyed `(contextId, messageId)`; one in-flight call per context; `toTutorError` sanitized codes), `scripts/live-smoke.js` (gated by `LIVE_SMOKE_MAX_USD`), `test/support/fake-anthropic.js`, `test/tutor-llm.test.js`, `.env.example`. UI: mode label, "New conversation" (`POST /api/conversation/new`), reconcile (`POST /api/runs/:runId/reconcile`). Events: model call started / response received with usage.
5. **Technologies:** `@anthropic-ai/sdk` 1.3.0 (Messages API), model `claude-haiku-5-5` (effort `low`, 800-token cap, `maxRetries: 0`).
6. **Changed / corrections:**
   - Fake 429s came from a parent `ANTHROPIC_BASE_URL` proxy; start live servers with `env -u ANTHROPIC_BASE_URL`, log API host (`5cc671d`, after Part 5 commit).
   - "New conversation" also clears all visible messages and timeline (user request, during step).
   - Budget approval step dropped; "ready means live" rule (user instruction).
   - Model call code moved from `tutor-model.js` into shared `src/llm.js` in Step 5; `MODEL` constant replaced by per-agent `useModel()` in Step 7.
   - Original test "Part 3 still works in live mode, and form details never reach Anthropic" was reversed in Step 6 (the advisory review sends all fields to the model).
7. **Evidence:** tutor-llm.test.js (13 at `e996a6a`): "live mode sends the specified request to Anthropic…", "follow-up questions carry that conversation’s earlier messages", "conversations are isolated…", "repeated requests never cause duplicate paid calls", "uncertain outcome is reconciled with the same request ID…", "the API key never appears in frontend assets, browser events, status, or logs". Suite: 40. Live: smoke test with a calculus question + follow-up required; results not recorded in Steps/04 **[unknown]**.
8. **Pitfall → lesson:** Haiku 5.5 rejects `temperature`/`top_p`/`top_k` (400) and thinking counts toward `max_tokens` — use `effort: "low"` with the cap and always check `stop_reason` (`refusal`, `max_tokens`) before using content.
9. **Architecture after:**
   - Components: Browser, UI server/Student (still deterministic), Tutor, **Tutor model [ADDED]**, **Anthropic API (external) [ADDED]**, SSE.
   - Edges: Tutor → Anthropic `HTTPS Messages API: system prompt + bounded history` **[ADDED]**; Browser → UI server `POST /api/conversation/new`, `/api/runs/:id/reconcile` **[ADDED]**; SSE carries model milestones + usage **[MODIFIED]**.
10. **User action** ("Explain the derivative of x squared", then a follow-up):
    1. Browser `POST /api/runs`.
    2. Student A2A `SendMessage` to Tutor (same `contextId` for follow-ups).
    3. Tutor executor → `tutor-model.js` checks ledger/busy.
    4. Tutor emits model-call-started; calls Messages API with history.
    5. Haiku returns; Tutor checks `stop_reason`, logs model/latency/usage (no content in live).
    6. Tutor appends exchange to the context history, replies over A2A.
    7. Student receives; browser shows answer and usage.
11. **Code example** — `src/llm.js:122-130` (Step 4's call lived in `tutor-model.js` at `e996a6a`; moved here in Step 5):
    ```js
    // Explicit apiKey: the SDK then ignores other credential sources. maxRetries 0: no hidden retries.
    client ??= new Anthropic({ apiKey: apiKey(), maxRetries: 0 });
    const response = await client.messages.create({
      model: current.name,
      max_tokens: maxTokens,
      // Low effort suits chat/classification; thinking counts toward max_tokens on every listed model.
      output_config: { effort: 'low', ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
      system,
      messages,
    }, { timeout: timeoutMs });
    ```
12. **Test:** `node --test test/tutor-llm.test.js` (fake API, no paid calls). Live: `LIVE_SMOKE_MAX_USD=<cap> env -u ANTHROPIC_BASE_URL npm run smoke:live`; startup must print `API host: api.anthropic.com`.
13. **Unknown:** live smoke cost/outputs for Step 4.

---

## Step 5 — Routing, Library Agent, editable skills, scope enforcement

1. **Title / commits:** `020018c` (Part 5), `7bc2e21` (answer content + dialog redesign), `5cc671d` (live fixes) — verified.
2. **Before:** One specialist; every chat went to the Tutor; the Tutor answered anything.
3. **Intent:** "Intelligent routing between Tutor and Library agents, editable Agent Cards, automatic card-refresh notifications, and enforcement of each agent’s advertised scope" (Steps/05).
4. **Built:** `src/library-agent.js` (:41242), `src/library-fixture.js`, `src/router.js` (Student's router; `ROUTER_MODE` direct/mock/live; `DECISION_SCHEMA`; `validateDecision`), `src/llm.js` (shared model call), `src/skills.js` (`buildCardSkills`, `buildScopeExtension` → `urn:a2a-spike:skill-scope:v1`, `policyFromConfig`, `CARD_CHANGED_MEDIA_TYPE`), `src/agent-settings.js` (settings API, ETag/revision, notify), `src/student-registry.js` (trusted allowlist, `node:http` card fetch with ETag), `src/student-endpoint.js` (Student's A2A receiving endpoint, :41240), `scripts/live-eval.js` (`LIVE_EVAL_MAX_USD`); `7bc2e21` added `src/library-model.js`; `5cc671d` added `src/text-match.js`. Tests: routing, scope, skills, card-refresh. UI: gear dialogs, three panels.
   - Contracts: routing decision `{ decision: route|clarify|unsupported, agent_id, skill_id, reason, clarification_question }`; notification = A2A data part `application/vnd.a2a-spike.agent-card-changed+json` to `http://127.0.0.1:41240`; UI proxy `/api/agents/:agentId/skills` (GET/PUT/preview), `/api/registry`, `POST /api/registry/refresh`. Tutor scope verdicts in_scope/out_of_scope/needs_clarification; Library live answers need verbatim evidence lines.
5. **Technologies:** no new package. Behavioral changes: application-level routing over a trusted registry; Agent Card as single source for card/router/policy; reverse A2A notification path; HTTP conditional fetch (`node:http`).
6. **Changed / corrections:**
   - Handlers removed; each skill has private "answer content" (`knowledge`), never on the card; dialog redesign (`7bc2e21`, user request). **Library's model was introduced here** (`LIBRARY_MODE=live`, `library:live` script) — `020018c` Library was deterministic ("no model is called").
   - Router/scope too strict ("What is SWOT analysis?" declined) → skills cover standard concepts (`5cc671d`).
   - Mock typo tolerance ("derivitive") (`5cc671d`).
   - "Tutor Agent", not "Calculus Tutor" (user request).
   - **Superseded in Step 7:** router moved to the Hub; `student-endpoint.js`, `student-registry.js` deleted; notifications go to the Hub.
7. **Evidence:** at `5cc671d`: routing.test.js (8) "every routing example reaches exactly the expected A2A destination — or none", "unknown agent IDs and URL-shaped choices fail closed…"; scope.test.js (11) "calculus-only Tutor declines physics, plumbing, and rule-override requests — even via direct A2A", "Library (live path): an answer is released only if its evidence is in the saved content"; skills.test.js (5) "card skills, scope extension, and runtime policy all derive from the same saved configuration"; card-refresh.test.js (7) "save → new ETag → A2A notification → Student re-fetch → routing changes", "configuration changes make no model calls". Suite: 69 → 70 → 71. Live: `eval:live` and browser demo required (SWOT route); results summarized only qualitatively in "Enhancements".
8. **Pitfall → lesson:** Fetch Agent Cards with `node:http`, not `fetch` — undici adds `Cache-Control: no-cache` to conditional requests, so Express returns 200 instead of 304 and revalidation silently never happens.
9. **Architecture after:**
   - Components: Browser, UI server/Student, **Student model (router) [ADDED]**, Tutor, Tutor model **[MODIFIED: + scope check]**, **Library Agent [ADDED]**, **Library model [ADDED in `7bc2e21`]**, Anthropic API, SSE.
   - Edges: Student → Anthropic `HTTPS: routing decision` **[ADDED]**; Library → Anthropic `HTTPS: evidence-backed answer` **[ADDED]**; Student → Library `A2A SendMessage: question` **[ADDED]**; Student → Tutor/Library `HTTP GET agent-card (ETag)` **[MODIFIED]**; Tutor/Library → Student endpoint :41240 `A2A data part agent-card-changed` **[ADDED]**; Library → UI server `SSE /viz/events` **[ADDED]**; UI server → specialists `HTTP settings proxy` **[ADDED]**.
10. **User action** ("Where can I find a calculus textbook?"):
    1. Browser `POST /api/runs`.
    2. UI server `decideRoute` (`src/router.js`) with registry skills as data; publishes `route_decided`.
    3. Live router returns `route` → library; `validateDecision` checks agent+skill in registry.
    4. Endpoint resolved from trusted registry (`src/student-registry.js`).
    5. A2A `SendMessage` to Library.
    6. Library checks its enabled skills; mock extracts lines / live verifies evidence (`src/library-model.js`).
    7. Library replies; Library emits `reply_published` on its own `/viz/events`.
    8. Student receives; browser shows routing note + answer in Library color.
11. **Code example** — `src/router.js:22-33` (decision schema; file is now the Hub's router):
    ```js
    const DECISION_SCHEMA = {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['route', 'clarify', 'unsupported'] },
        agent_id: { type: 'string' },
        skill_id: { type: 'string' },
        reason: { type: 'string' },
        clarification_question: { type: 'string' },
      },
      required: ['decision', 'agent_id', 'skill_id', 'reason', 'clarification_question'],
      additionalProperties: false,
    };
    ```
12. **Test:** `node --test test/routing.test.js test/scope.test.js test/skills.test.js test/card-refresh.test.js`. Live: `LIVE_EVAL_MAX_USD=<cap> npm run eval:live`.
13. **Unknown:** live eval figures for Step 5.

---

## Step 6 — Conversational workflow forms

1. **Title / commits:** "Add Part 6" = `c81e566`, then `99f4f38` (serialize actions per form) — verified.
2. **Before:** Forms only via a "Request form" button; one static student-details form; no notion of the agent deciding.
3. **Intent:** "Conversationally triggered A2UI workflows for in-person tutoring requests and group study-room bookings, with correct form dismissal after submission, an advisory model review before anything is recorded, and a clean chat-style UI" (Steps/06).
4. **Built:** `src/forms.js` (shared: `WORKFLOWS`, form builders, validation, allowlist; replaces `student-form.js`; served `/shared/forms.js`), `src/form-host.js` (issue, actions, dedupe by `operationId`), `src/form-intent.js` (prefill parsed from student's words), `src/form-review.js` (`reviewGate`, advisory flags), `src/demo-store.js` (`createRoomStore`, synchronous `reserveStudyRoom`), `public/forms-ui.js`, fonts, `test/booking.test.js`. The `Steps/` folder (01–06) was created in this commit. Contracts: workflows `tutoring-request` (Tutor skill `in-person-tutoring-request`) and `study-room-booking` (Library); outcomes answer/clarify/offer_*_form/out_of_scope; `form_lifecycle` events editing→submitting→accepted|rejected|confirmation_pending, cancelled|superseded; standard A2UI `deleteSurface`; UI routes `POST /api/forms/:formId/actions|edit|reconcile`; `metadata.operationId`; review `needs_review` + "Send anyway".
5. **Technologies:** no new package. Fonts Atkinson Hyperlegible Next + IBM Plex Mono self-hosted (OFL). Change: agent-decided forms, UI-server-owned lifecycle, model-based advisory review.
6. **Changed / corrections:**
   - Concurrent final submissions both recorded → serialize per form (`99f4f38`, right after).
   - "I need a room" → "yes" needed router reply snippets + Library memory (during step).
   - Forms moved into the chat as items; "You sent" summary; agent "Sent" entries (user reports, during step).
   - Switchboard redesign with frontend-design skill (user request, during step; merged into Steps/02).
   - Corrections reopen with the sent values even after reload (user request).
7. **Evidence:** booking.test.js (7) e.g. "concurrent confirmations for the same slot: exactly one booking…"; form.test.js rewritten, e.g. "no request-form shortcut…", "review: a flagged submission comes back unrecorded; “Send anyway” records it…"; tutor-llm "two concurrent submissions of one form… cannot both be recorded" (`99f4f38`). Suite: 93 → 94 (commit message: "93 passing"). Live: full Playwright pass of every scenario against live servers (Steps/06 "Enhancements").
8. **Pitfall → lesson:** Keep check-and-reserve synchronous (no `await` between availability check and write) — that alone makes the double-booking test pass; and serialize (queue) actions per form rather than rejecting the second.
9. **Architecture after:** no new components.
   - **Student model (router)** gets reply snippets **[MODIFIED]**; Tutor model + Library model gain intent outcomes and advisory form review **[MODIFIED]**.
   - Edges: Student ↔ Library A2A now carries forms too (Task `INPUT_REQUIRED`, actions with `operationId`) **[MODIFIED]**; Browser → UI server `POST /api/forms` and `/api/forms/:id/submissions` **[REMOVED]**, `/api/forms/:id/actions|edit|reconcile` **[ADDED]**; SSE carries `form_lifecycle` **[MODIFIED]**.
10. **User action** ("I want to reserve a group study room"):
    1. Browser `POST /api/runs`; router → Library.
    2. Library classifies intent (mock heuristic / live outcome) → offer form (`src/library-agent.js`).
    3. `formHost.issue` returns A2UI Task `INPUT_REQUIRED` (`src/form-host.js`, `src/forms.js`).
    4. UI server allowlists, opens lifecycle `editing`; browser renders as chat item.
    5. Changing date/room/duration/size → `checkAvailability` action (scheduling fields only) → `listStudyRoomAvailability` (`src/demo-store.js`).
    6. Review booking → server-sent A2UI update; Confirm → `POST /api/forms/:id/actions`.
    7. Library validates, `reviewGate` (`src/form-review.js`), then synchronous `reserveStudyRoom`.
    8. Library replies with receipt (booking ID); surface deleted; "You sent" summary + reply in chat.
11. **Code example** — `src/forms.js:31-40`:
    ```js
    export const WORKFLOWS = {
      'tutoring-request': {
        id: 'tutoring-request', agentId: 'tutor', skillId: 'in-person-tutoring-request',
        title: 'Request an in-person calculus tutoring session',
        finalAction: 'submitTutoringRequest', pendingText: 'Sending request…',
        actions: {
          submitTutoringRequest: { button: 'submit_button', fields: TUTORING_FIELDS, final: true },
          cancelForm: { button: 'cancel_button', fields: [], cancel: true },
        },
      },
    ```
12. **Test:** `node --test test/booking.test.js test/form.test.js test/a2ui-render.test.js`.
13. **Unknown:** Steps 1–5 files were authored in this commit, retrospectively.

---

## Step 7 — University Hub orchestrator with live topology

1. **Title / commits:** `cfb7040`, `ecb79af`, `520b83a`, `283c4fb`, `81afc79`, `39d242c`, `5508964` (verified). Note: `5508964` was committed after Part 8's `48b2fa6`; step-label change "Agent identified" landed in `9150c60` (Part 9).
2. **Before:** Student held specialist URLs, the registry and the router; specialists notified the Student directly; only Tutor/Library existed.
3. **Intent:** "Introduce a University Hub between the Student, Tutor and Library agents. The Student connects only to the university… Add a dedicated browser Topology tab" (Steps/07).
4. **Built:** `src/hub-agent.js` (:41243, public card “California State University Fullerton”, capability skills `tutoring`/`library`), `src/hub-registry.js`, `src/hub-link.js` (register/heartbeat/deregister/card-changed), `src/cards.js` (`getCard`, `validateCard`), `src/config.js` (`ConfigError`), `config/*.example.json`, `src/models.js` (allowed models + prices), `src/topology.js` (`topologyLabel`), `src/student-assistant.js` (Student's own model), `public/topology.js` (SVG), `scripts/start-all.js`, `test/hub.test.js`, `test/student-model.test.js`. Deleted `src/student-endpoint.js`, `src/student-registry.js`.
   - Contracts: control data parts `application/vnd.a2a-spike.agent-{register,heartbeat,deregister,card-changed}+json`; statuses ready/stale/unreachable/disconnected/disabled/invalid_card; Student → Hub `metadata.requestedCapability`; Hub → specialist `hubOperationId`, `via`; replies `servedBy`, `decision`, `decidedBy`; forms mapped by opaque `formRef` (`hf-<uuid>`); Hub statuses `outcome_unknown` / `not_delivered`; telemetry IDs `<bootId>:<seq>`, `Last-Event-ID`, `/viz/topology`; tabs `/conversation`, `/activity`, `/topology`; Hub dev proxy `/dev/agents/:id/skills`, `/dev/registry/refresh`.
5. **Technologies:** no new package. Architectural change: hub-and-spoke orchestration with private registry, heartbeats, per-agent model configuration (`claude-haiku-5-5` default; `claude-sonnet-5-5`, `claude-opus-5-5` allowed), server-labelled topology telemetry.
6. **Changed / corrections:**
   - Moving the router to the Hub silently removed the Student's only model use; user noticed in the diagram → Student's own model added (clarify / choose public capability) — **within the step, before `cfb7040`**.
   - Keyword-as-decision bug ("reading for my calculus course" sent to Tutor) → obvious matches go on unchanged, Hub decides (before commit).
   - Telemetry redaction: denylist → allowlist (`ecb79af`) → exempt by event type, not missing `runId` (`520b83a`), both from post-commit security reviews.
   - Student declines clearly unsupported questions itself; "I don't know" goes to the Hub (`283c4fb`).
   - Pending clarification swallowed the next message → `relation: answers_question|new_request` (`7347f41`, found in Part 8's e2e).
   - UX: Enter/Shift+Enter (`81afc79`), 1-second spinner (`39d242c`), `followBottom` scrolling (`5508964`).
7. **Evidence:** hub.test.js (11) e.g. "the Student discovers only the university’s public card; specialist endpoints never reach it", "registration states: heartbeat expiry → stale, sign-out → disconnected, disabled — none receive new requests", "telemetry redaction is an allowlist…"; student-model.test.js (8) e.g. "an obvious question goes on as-is: the Hub’s router decides, not the Student", "live mode: clearly not a university service → the Student answers itself…". Suite: 113 (`cfb7040`) → 114 → 115. Live: Playwright pass on `demo:live`; per-agent models verified (Hub Haiku, Tutor Sonnet, Library Opus ≈ $0.024); `scripts/browser-checks/chat-scroll.js` old code 8/12 (4 failed), fix 12/12 in 3 runs.
8. **Pitfall → lesson:** Ask before removing what works — a structural move (router → Hub) can delete a capability as a side effect (the Student's model); say so first.
9. **Architecture after:**
   - Components: Browser (3 tabs), UI server/Student Agent, **Student model [REMOVED as router, then ADDED back as clarifier/capability chooser]**, **University Hub [ADDED]**, **Hub router model [ADDED]**, Tutor, Tutor model, Library, Library model, Anthropic API, SSE.
   - Edges **[REMOVED]**: Student ↔ Tutor/Library A2A; specialist → Student :41240 notifications; Student card fetches of specialists; UI server ← specialists' SSE; UI server → specialist settings.
   - Edges **[ADDED]**: Student → Hub `A2A SendMessage: question + requestedCapability; form actions + formRef`; Student → Hub `GET agent-card` (public card only); Hub → Tutor/Library `A2A: forwarded question / form action (hubOperationId)`; Tutor/Library → Hub `A2A data parts: register/heartbeat/deregister/card-changed`; Hub → specialists `HTTP GET agent-card (configured URL, conditional)`; Hub → Anthropic `HTTPS: routing`; Student → Anthropic `HTTPS: clarify/capability`; Tutor/Library → Hub `SSE /viz/events` → Hub (redacted, relayed) → UI server `SSE /viz/events` → Browser `SSE /api/events`; UI server → Hub `/dev/*` (settings proxy) → specialists.
10. **User action** ("Explain the derivative of x squared"):
    1. Browser `POST /api/runs`.
    2. `planAndSend` → `planRequest` matches one capability (tutoring) → `request_planned` "obvious" (`src/ui-server.js`, `src/student-assistant.js`).
    3. Student A2A `SendMessage` to Hub only.
    4. Hub checks student allowlist, `chatLedger`; router decides `route → tutoring` (`src/router.js` in `src/hub-agent.js`); `route_decided`.
    5. Registry confirms Tutor `ready` (`src/hub-registry.js`).
    6. Hub forwards with its own messageId/context + `hubOperationId`.
    7. Tutor scope check → answer (Tutor model); replies.
    8. Hub relays with `servedBy`, decision; Student receives.
    9. Topology animates student-hub, hub-tutor, tutor-model hops from labelled events; strip marks 9 steps.
11. **Code example** — `src/hub-link.js:23-26`:
    ```js
    export const REGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-register+json';
    export const HEARTBEAT_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-heartbeat+json';
    export const DEREGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-deregister+json';
    export const CONTROL_MEDIA_TYPES = new Set([REGISTER_MEDIA_TYPE, HEARTBEAT_MEDIA_TYPE, DEREGISTER_MEDIA_TYPE, CARD_CHANGED_MEDIA_TYPE]);
    ```
12. **Test:** `node --test test/hub.test.js test/student-model.test.js` (uses `startStack`). Run `npm run demo` (mock) or `env -u ANTHROPIC_BASE_URL npm run demo:live`; open `http://127.0.0.1:4444/topology` (port was 3000 at the time).
13. **Unknown:** Steps/07 says "Final count: 115"; the commit says 113 — both true at different commits.

---

## Step 8 — Model-generated UI for Library loans

1. **Title / commits:** `48b2fa6`, `7347f41` (verified); write-up completed in `d9f007b`.
2. **Before:** Every form was a server-registered template; models only picked outcomes.
3. **Intent:** "Demonstrate a model that understands the conversation, decides whether to answer, ask a clarifying question, or generate an interface, and composes that interface from a supported component catalog" — not a template chosen by keyword (Steps/08).
4. **Built:** `src/loan-store.js` (persisted `data/library-loans.json`, `LOAN_POLICY { maxRenewals: 2, renewalDays: 21 }`, idempotent synchronous `renewLoan`), `src/a2ui-catalog.js` (`catalogForModel()` generated from installed schemas; `validateGeneratedUi`), `src/loan-model.js` (`replyAboutLoans`, `answer|clarify|ui`, ≤2 repairs, truthful fallback), `WORKFLOWS['loan-renewal']` (`generated: true`), Library skill `book-loans`, Generated UI inspector, `test/loans.test.js`. Hub signing: `callKey` at registration, `registry.signFor`, `hubSignature` = HMAC(`studentId|contextId|hubOperationId`), `hubLink.verifiedStudent`. Router rule for "own borrowed items". Telemetry `ui_generated` (inspector), `loan_operation`.
5. **Technologies:** `ajv` 8.20.0 moved devDependencies → dependencies (runtime schema validation; same version). Node `node:crypto` HMAC for signed identity. No other new package.
6. **Changed / corrections:**
   - First version trusted `metadata.studentId`; security review → Hub-signed identity (during step).
   - Validator rejected dates implied by the permitted range ("push back two weeks") → any day in range allowed (`7347f41`).
   - Read-only overview mislabelled "Waiting for you" (`7347f41`).
   - Redaction masked arrays → `prefilled` crash; field-name lists pass (during step).
   - Open decisions (Student→Hub auth; inspector content) settled in Step 9: authenticate; structure-only inspector.
7. **Evidence:** loans.test.js (14) e.g. "the model-visible catalog is the installed renderer’s catalog (minus URL-loading media)", "eligible renewal: generated surface through the Hub → verified receipt; retries and double submits renew once", "the Library never takes the borrower from the caller…", "mock mode answers in labelled text and never generates UI". Suite: 129. Live (Haiku 5.5, browser): ~3 cents; e2e ~5 cents (Steps/08).
8. **Pitfall → lesson:** A metadata field is not authentication — the Hub must sign the identity it forwards with a per-process key and the specialist must verify it (spoofed `studentId: "student-sam"` would otherwise read/renew another student's loans).
9. **Architecture after:** no new agents.
   - **data/*.json storage [ADDED]** (`data/library-loans.json`, Library).
   - Library model **[MODIFIED]**: classification + loan reply that composes A2UI (Library → Anthropic HTTPS, up to 2 repairs).
   - Edges: Tutor/Library → Hub registration carries `callKey` **[MODIFIED]**; Hub → Library A2A carries `studentId`, `hubOperationId`, `hubSignature` **[MODIFIED]**; Hub → Student relays generated A2UI unchanged; SSE carries `ui_generated` inspector **[MODIFIED]**.
10. **User action** ("Can I keep the calculus book until after my exam?"):
    1. Student plans; sends to Hub.
    2. Hub router (own-borrowed-items rule) → library; signs student.
    3. Library verifies `hubSignature` (`src/hub-link.js`), classifies `my_loans` (`src/library-model.js`).
    4. Loan model asks for exam date (clarify) (`src/loan-model.js`).
    5. Alex answers; loan model returns `ui` with `components_json`/`data_model_json`.
    6. `validateGeneratedUi` (schema + rules) passes; `formHost.issue` wraps surface.
    7. Hub relays Task `INPUT_REQUIRED`; browser renders date picker bounded to `permittedReturnDates`.
    8. Click generated button → action with `formRef` → Hub → Library `renewLoan`: re-verifies borrower, version, range.
    9. `loans.renewLoan` (persisted, idempotent) → receipt `RN-…` back through Hub.
11. **Code example** — `src/loan-model.js:16-27`:
    ```js
    const SCHEMA = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['answer', 'clarify', 'ui'] },
        text: { type: 'string' },
        loan_ids: { type: 'array', items: { type: 'string' } },
        components_json: { type: 'string' },
        data_model_json: { type: 'string' },
      },
      required: ['kind', 'text', 'loan_ids', 'components_json', 'data_model_json'],
      additionalProperties: false,
    };
    ```
12. **Test:** `node --test test/loans.test.js` → 14 pass (scripted fake-API output = plumbing, not judgment). Live: `env -u ANTHROPIC_BASE_URL npm run demo:live`, ask about "my borrowed library book", inspect Agent activity → Generated UI inspector.
13. **Unknown:** none material.

---

## Step 9 — Marketing 101 Professor and professor-initiated lessons

1. **Title / commits:** Table: `6d84aec`, `cad2e9d`, `2814874`, `9150c60` (verified). Also Part 9: `36ba0a6` (messages as chat, meetings, `scripts/demo/progression.js`) — **not listed in the Steps table** but merged into Steps/09.
2. **Before:** All conversations started with the student; Student → Hub identity self-declared; inspector relayed full model text.
3. **Intent:** "Demonstrate that communication can begin on either side… a professor can also introduce a lesson while the student is idle" (Steps/09).
4. **Built:** `src/professor-agent.js` (:41244; `/author/{state,reset,lessons,chat}`), `src/professor-model.js`, `src/course-pack.js` (8 topics, 3 seed lessons, WSU references), `src/lessons.js` (media types, `sign`/`verify`, `contentHash`), `src/hub-lessons.js` (publish checks, deliveries, pump, queries, notices), `src/student-inbox.js` (Student inbound executor), `src/a2a-data.js` (`sendData`), `src/json-store.js`, `public/classroom.js`, `config/professor.example.json`, `test/professor.test.js`; later `src/meeting-times.js` (`36ba0a6`). Hub destination `marketing`; course `mkt-101`; `studentEndpoints`. Student inbound A2A on UI server: `/.well-known/agent-card.json` (“Student Agent”, skill `receive-course-lessons`), `/a2a/jsonrpc`. UI routes `/api/inbox`, `/api/inbox/:id/open|save`, `/api/notices/:id/seen`, `/api/professor/{chat,state,lessons}`; tab `/professor`. Signatures: publish, session challenge, `metadata.studentSignature` over `[studentId, contextId, messageId]`, delivery/query/notice/receipt. IDs `ls-…`, `dl-…`, `in-…`, `av-mkt-101`. Follow-ups carry `lessonDeliveryId` → `decidedBy: 'lesson'`.
5. **Technologies:** no new package (git diff of `package.json` adds only scripts `professor`, `professor:live`). Changes: reverse route as a new `message/send` (not push notifications), per-process HMAC keys for every Hub caller, JSON-file persistence (`data/hub-lessons.json`, `data/student-inbox.json`, `data/professor-outbox.json`), `sameOriginGuard` on dev routes.
6. **Changed / corrections:**
   - Professor view first built as a form → replaced by a chat; model decides kind/audience/title, code checks (`cad2e9d`, user feedback).
   - Lessons-only → lessons or messages, to one student or `all` (Hub expands enrollment); Sam added; classroom reset (`cad2e9d`).
   - Assistant interposed on every post → direct posts; assistant only on `@assistant`; cross-site guards; email-not-a-tag; "queued" once (`2814874`).
   - Port 4444; course questions reach the Professor (`course-questions` skill); `publicWords` (`9150c60`).
   - Messages as chat bubbles with Reply, `author` in content hash, `needs_professor`, meeting scheduling with times read by code (`36ba0a6`).
7. **Evidence:** professor.test.js (20) e.g. "a lesson the professor writes reaches an idle student who never started a conversation", "a lost acknowledgment is reconciled without a duplicate delivery", "a notification does not mark a lesson opened; only the student’s own action does", "malicious lesson text is only content…", "a web page on another site can’t reset the classroom…", "meetings: the assistant asks the professor for times…". Suite: 139 → 144 → 145 → 147 → **150** (counted per commit). Live walkthrough (5 agents on Haiku 5.5) ≈ $0.002; 14-scenario live e2e.
8. **Pitfall → lesson:** "Accepted by the Hub" ≠ "delivered" — "delivered" only after the Student commits the inbox entry; an uncertain delivery is queried before any re-send.
9. **Architecture after:**
   - Components: Browser (4 tabs) **[MODIFIED]**, UI server/Student Agent **[MODIFIED: inbound A2A endpoint + inbox]**, Student model, Hub **[MODIFIED: lessons, sessions]**, Hub router model, Tutor(+model), Library(+model), **Marketing 101 Professor [ADDED]**, **Professor model [ADDED]**, Anthropic API, data/*.json **[MODIFIED: + hub-lessons, student-inbox, professor-outbox]**, SSE.
   - Edges **[ADDED]**: Professor → Hub `A2A data part lesson-publish (signed)`; Hub → Student (UI server :4444 `/a2a/jsonrpc`) `A2A data parts lesson-delivery / lesson-query / course-available / session-challenge (hubSignature)`; Student → Hub `A2A data parts student-session, lesson-receipt`; Hub ↔ Professor `A2A: forwarded questions (+lessonId, signed student)` and control messages; Professor → Anthropic `HTTPS: answers, interpretProfessor, classifyPost`; UI server → Hub `/dev/agents/professor/author/*`, `/dev/classroom/reset` → Professor `/author/*` (HTTP dev proxy); Professor → Hub `SSE /viz/events`.
   - Edges **[MODIFIED]**: Student → Hub requests now require `metadata.studentSignature`; inspector telemetry structure-only by default.
10. **User action** (professor posts a lesson; idle Alex asks a follow-up):
    1. Professor types in `/professor` → `POST /api/professor/chat` → Hub `/dev/…/author/chat` → Professor `/author/chat`.
    2. Plain message = direct post; `classifyPost` names kind/title (`src/professor-agent.js`, `src/professor-model.js`).
    3. Professor `hubLink.sendSigned` → A2A `lesson-publish` to Hub (persisted in outbox).
    4. Hub verifies signature, course, enrollment, dedupe; creates deliveries (`src/hub-lessons.js`).
    5. Hub `sendData` `lesson-delivery` (signed) to Student endpoint.
    6. Student verifies, writes inbox to disk, replies `delivered` (`src/student-inbox.js`).
    7. Browser toast "New Marketing 101 lesson" → View lesson → `POST /api/inbox/:id/open` → signed receipt.
    8. "Ask about this lesson" → chip → message with `lessonDeliveryId` → Hub `lessonRoute` → Professor.
    9. Professor answers from that lesson; reply relayed to Alex.
11. **Code example** — `src/lessons.js:12-22`:
    ```js
    const MT = (name) => `application/vnd.a2a-spike.${name}+json`;
    export const LESSON_PUBLISH_MEDIA_TYPE = MT('lesson-publish');
    export const LESSON_STATUS_MEDIA_TYPE = MT('lesson-status');
    export const LESSON_DELIVERY_MEDIA_TYPE = MT('lesson-delivery');
    export const LESSON_QUERY_MEDIA_TYPE = MT('lesson-query');
    export const LESSON_RECEIPT_MEDIA_TYPE = MT('lesson-receipt');
    export const COURSE_AVAILABLE_MEDIA_TYPE = MT('course-available');
    export const STUDENT_SESSION_MEDIA_TYPE = MT('student-session');
    export const SESSION_CHALLENGE_MEDIA_TYPE = MT('session-challenge');
    export const HUB_LESSON_MEDIA_TYPES = new Set([LESSON_PUBLISH_MEDIA_TYPE, LESSON_STATUS_MEDIA_TYPE, LESSON_RECEIPT_MEDIA_TYPE, STUDENT_SESSION_MEDIA_TYPE]);
    export const STUDENT_INBOUND_MEDIA_TYPES = new Set([LESSON_DELIVERY_MEDIA_TYPE, LESSON_QUERY_MEDIA_TYPE, COURSE_AVAILABLE_MEDIA_TYPE, SESSION_CHALLENGE_MEDIA_TYPE]);
    ```
12. **Test:** `node --test test/professor.test.js` → 20 pass (mock Professor/router + scripted fake API). Full: `npm test` → 150. Live: `env -u ANTHROPIC_BASE_URL npm run demo:live`, open `http://127.0.0.1:4444/professor` and `/conversation`.
13. **Unknown:** README "Deliberately not included" still lists "whole-class broadcasts" although Part 9 supports class-wide posts (implemented as one delivery per enrolled student) — wording conflict.

## Step 10 — AG-UI between the agents and the screen

1. **Title / commits:** "AG-UI 1.0 between the agents and your screen". `cff915c` (Steps 10 and 11 together: they share `src/ui-server.js` and `public/app.js`), `fdfd6a3` (hash in the Steps table).
2. **Before:** The browser used the app's own endpoints — `POST /api/runs`, one SSE stream `/api/events` for every tab — and the Professor view polled its state.
3. **Intent:** "why not make AG-UI step 10 so we have the right infrastructure for filling forms from the UI"; scope "just the conversation, and the agent activity and the professor not the topology" (user, this session; Steps/10).
4. **Built:** `src/ag-ui-bridge.js` (app events → AG-UI: reply → TEXT_MESSAGE block + CUSTOM, telemetry → ACTIVITY_SNAPSHOT, form lifecycle → STATE_DELTA; runs, server-opened `srv-…` runs, history cut at run boundaries), `src/ag-ui-professor.js` (Professor state as STATE_SNAPSHOT; a message is a run), `src/ag-ui-stream-agent.js` (`StreamAgent`, `bufferedChannel`), `src/browser/ag-ui-entry.js`; UI server `POST /api/ag-ui/runs`, `GET /api/ui/stream` (monitor, student, professor channels), `/api/ag-ui/stream`, `/api/ag-ui/professor/{stream,runs}`; browser `monitor()` vs `handle()`.
5. **Technologies:** `@ag-ui/core`, `@ag-ui/client`, `@ag-ui/encoder` 1.0.3; `rxjs` 7.8.1, `zod` 3.25.76 (pinned, `package.json`).
6. **Changed / corrections (during the step):** `HttpAgent.connect()` is not implemented in 1.0.3 → `StreamAgent` overrides it; three streams per page hit the browser's 6-connection limit with two windows → one multiplexed `/api/ui/stream`; a plain Subject dropped events before subscription → `bufferedChannel`; the strip was wiped after reload → the monitor side clears it.
7. **Evidence:** `test/ag-ui.test.js` (13), e.g. "a chat question as AG-UI run input: valid events, the server's run ID, threadId = conversation, one block of reply text", "one connection per page: /api/ui/stream carries the monitor, student and professor channels". `scripts/browser-checks/same-screen.js`: before/after screens match.
8. **Pitfall → lesson:** one connection per page; verify what the installed package really implements.
9. **Architecture after:** Browser **[MODIFIED: AG-UI client, one connection]**, Student/UI server **[MODIFIED: AG-UI bridge]**; edges Browser → UI server `AG-UI run input` **[MODIFIED]**, UI server → Browser `one stream: AG-UI + monitor` **[MODIFIED]**. A2A, A2UI and the monitoring stream unchanged.
10. **Test:** `node --test test/ag-ui.test.js` → 13 pass.

## Step 11 — Fill out forms from the chat

1. **Title / commits:** `cff915c` (with Step 10).
2. **Before:** Values typed in the chat went to the university as a new message; the open form stayed empty.
3. **Intent:** "I want to be able to fill out the forms from the chat as well", "it should fill in the date on the form", "the final click should always be mine", "yes all fields on the form" (user, this session; Steps/11).
4. **Built:** `src/form-fill.js` (`formFields`, `codeFills`, `maskPersonal`, `checkFills`, `fillUpdates`, `fillNote`, `inReview`, `decideFill`); `planAndSend` fill block before planning; student event `form_filled`; `request_planned { action: 'fill' }`; run decision `student_fill`; `public/forms-ui.js` `openValues()` / `fill()`; strip and Topology labels.
5. **Technologies:** none new (AG-UI run `state`, A2UI `updateDataModel`).
6. **Changed / corrections (during the step):** the model skipped "next Monday" → a plain fill uses every code value; capitalised "I am" missed by the name mask → pattern fixed, names masked before emails; a date inside a question must not be filled.
7. **Evidence:** `test/form-fill.test.js` (9), e.g. "end to end: a tutoring form filled from the chat, nothing sent; then the student's own click submits it", "live (fake Messages API, scripted): fill_and_chat, invented values dropped, names/emails never sent, failure falls back". Full suite: 183.
8. **Pitfall → lesson:** values come from code; the model decides and names fields only.
9. **Architecture after:** Student **[MODIFIED: fills open forms]**; Student → model also decides fills; Browser → UI server run input carries form values.
10. **Test:** `node --test test/form-fill.test.js` → 9 pass. Owner decision pending: names/emails stay masked for the model.

---

## Model usage by step (who calls Anthropic)

| Agent | Gains model | Loses / changes |
| --- | --- | --- |
| Tutor | Step 4 (answers); Step 5 adds scope check; Step 6 adds intent outcome + form review | — |
| Student | Step 5 (router in UI server, `ROUTER_MODE=live`) | Step 7: router moved to Hub; Student's own model (`STUDENT_MODE`, clarify/capability/decline) added in the same step; Step 11: also decides whether a message fills an open form |
| Library | Step 5 (`7bc2e21`, evidence-verified answers); Step 6 intent + review; Step 8 loan UI composition | — |
| Hub | Step 7 (router) | — |
| Professor | Step 9 (answers, `interpretProfessor`, `classifyPost`) | — |

## SSE telemetry path by step

- Step 2–4: Tutor `/viz/events` → UI server → browser `/api/events`.
- Step 5–6: Tutor and Library `/viz/events` → UI server (relayed with `source`) → browser.
- Step 7+: specialists `/viz/events` → **Hub** (allowlist redaction, `topologyLabel`) → Hub `/viz/events` → UI server → browser; Hub `/viz/topology` snapshot. Step 9 adds the Professor feed; inspector structure-only.
- Step 10+: the browser gets the monitor feed as the `monitor` channel of `/api/ui/stream`, next to the AG-UI `student` and `professor` channels.

---

## Final architecture summary (after `36ba0a6`; Steps 10–11 below)

Processes (all `127.0.0.1`): **UI server** `src/ui-server.js` :4444 (Browser UI tabs `/conversation`, `/activity`, `/topology`, `/professor`; hosts **Student Agent** `student-alex` with its own model and an inbound A2A endpoint + persisted inbox `data/student-inbox.json`); **University Hub** `src/hub-agent.js` :41243 (public CSUF card, private registry, router model, form-ref mapping, chat/operation ledgers, lesson deliveries `data/hub-lessons.json`, telemetry relay/redaction, `/dev/*` proxy); **Tutor** :41241; **Library** :41242 (`data/library-loans.json`); **Marketing 101 Professor** :41244 (`data/professor-outbox.json`). Each model-using agent calls the **Anthropic Messages API** over HTTPS with its own configured model and key variable.

Edges: Browser ⇄ UI server (HTTP POST `/api/*`, SSE `/api/events`); Student ⇄ Hub (A2A JSON-RPC: signed chat, form actions with `formRef`, `student-session`, `lesson-receipt`; Hub → Student: `lesson-delivery`, `lesson-query`, `course-available`, `session-challenge`); Hub ⇄ Tutor/Library/Professor (A2A: forwarded requests with signed student; specialist → Hub control messages and `lesson-publish`); specialists → Hub → UI server (SSE telemetry); agents → Anthropic (HTTPS). No Student ↔ specialist edge exists.

Start: `npm run demo` (mock, 5 processes) or `env -u ANTHROPIC_BASE_URL npm run demo:live` (paid). Tests: `npm test` (150, no paid calls; `HUB_URL=http://127.0.0.1:9`).

After `cff915c` (Steps 10–11): Browser ⇄ UI server becomes AG-UI run input (`POST /api/ag-ui/runs`) and one multiplexed stream (`/api/ui/stream`); the Student agent fills open forms from the chat. `npm test`: 183.

## Global uncertainties / inconsistencies

- Steps/01–06 were first committed in `c81e566` (Part 6), so their "original prompt" text was assembled after the fact **[reconstructed]**.
- README lists `ajv` as "Dev only"; `package.json` has it in `dependencies` since `48b2fa6`.
- Steps table omits `36ba0a6` (Part 9 messages/meetings/audience demo).
- Live-check results for Steps 1–5 are not quantified in the repo **[unknown]**.
- Current test files are the final versions (ported onto the Hub stack in Step 7); per-step test titles above come from `git show <commit>:test/...`.
