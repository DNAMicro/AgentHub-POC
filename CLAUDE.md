# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A protocol-connectivity spike: two separate Node.js processes talk over the real A2A protocol (v1.0, JSON-RPC binding) using `@a2a-js/sdk` 1.3.0. `src/tutor-agent.js` is the A2A server (Agent B); `src/student-agent.js` is the A2A client (Agent A). `src/ui-server.js` + `public/` add a browser monitor that hosts the Student in-process and visualizes the exchange. Part 3 adds an A2UI v0.9 form the Tutor sends inside A2A and the browser renders with the official `@a2ui/lit` renderer. Part 4 lets the Tutor answer chat with Claude Haiku 5.5 (`claude-haiku-5-5`, `@anthropic-ai/sdk` 1.3.0) in `TUTOR_MODE=live`; the default `fixed` mode keeps the deterministic Part 1 reply. Part 5 adds a deterministic **Library Agent** (`src/library-agent.js`, :41242), **routing** (`src/router.js`) over a trusted registry, editable per-agent **skill configurations** (`src/skills.js`, `src/agent-settings.js`) with `agent_card_changed` notifications (Part 7: to the Hub, not the Student), and **scope enforcement** on the receiving agents. Part 6 lets agents send A2UI workflow forms when asked in chat. Part 7 adds the **University Hub** (`src/hub-agent.js`, :41243, public name “California State University Fullerton”): the Student talks only to the Hub, which holds the private registry (`src/hub-registry.js`), runs the router, forwards/relays over A2A, maps forms by opaque `formRef`, and feeds the browser's three tabs (Conversation, Agent activity, live Topology). See README.md for the hop-by-hop walkthrough and version rationale.

## Commands

```bash
npm run tutor      # server on 127.0.0.1:41241 (override with PORT=...), fixed reply
npm run tutor:mock # deterministic fake model, no network
npm run tutor:live # Claude Haiku 5.5; key from env or .env (TUTOR_ENV_FILE to override) — PAID
npm run smoke:live # paid live smoke test; refuses unless LIVE_SMOKE_MAX_USD is set
npm run library    # Library Agent on 127.0.0.1:41242 (LIBRARY_MODE=mock: line extraction from saved content)
npm run library:live  # Library answers via Haiku 5.5 with code-verified evidence (paid)
npm run student    # CLI client; target with TUTOR_URL=http://127.0.0.1:...
# Forms (Part 6): no form command — ask in chat, e.g. "I want to reserve a group study room"
npm run demo       # all four processes, mock models/router (scripts/start-all.js); demo:live = Haiku everywhere — PAID
npm run hub        # Hub :41243, mock router; hub:live (PAID) / hub:direct (everything to tutoring; code default)
npm run ui         # builds bundle, then UI :3000 hosting the Student, which connects only to HUB_URL
npm run eval:live  # paid Part 5 spot check; refuses unless LIVE_EVAL_MAX_USD is set
npm run build:ui   # esbuild bundle of the A2UI renderer only (output is gitignored)
npm test           # node:test; spawns Hub/specialists/UI as child processes on free ports (HUB_URL defaults to a dead port)
node --test --test-name-pattern="duplicate" test/   # run tests by name
node --test test/form.test.js                       # run one file
```

Plain ESM JavaScript (`"type": "module"`), no lint/TypeScript. The only build step is the renderer bundle for the browser.

## Stopping test processes (macOS)

- Prefer killing by PID or port: `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`, or save `$!` when backgrounding and `kill` that.
- If you must use `pkill`/`pgrep`, **all options go before the pattern**: `pkill -U "$(id -u)" -f 'src/ui-server\.js'`. BSD `pkill` stops option parsing at the first non-option, so `pkill -f "src/ui-server.js" -U $(id -u)` treats `-U` and `501` as extra patterns — on 2026-10-26 that SIGTERMed ~70 unrelated processes (Chrome/Claude/Codex GPU helpers, system extensions) and blanked every window.
- Never use short or generic `-f` patterns (`node`, `501`, `-U`). Dry-run with `pgrep -lf '<pattern>'` first and confirm only your own test processes match.

## Architecture notes

- **Server layering**: `tutorExecutor` (business logic) → `DefaultRequestHandler` (protocol: assigns contextId/taskId, enforces event ordering) → `jsonRpcHandler` / `agentCardHandler` Express adapters. Every executor call must publish `AgentEvent.message(...)` or `AgentEvent.task(...)` first — including follow-ups on an existing task (re-publish `ctx.task`, then `statusUpdate`).
- **Agent dispatch** (`execute`, Tutor and Library): A2UI DataPart → `formHost.handleAction` (src/form-host.js); otherwise chat → decide answer / clarify / offer the agent's own workflow form / out of scope. There is no "request form" message or endpoint (Part 6 removed `metadata.request` and `POST /api/forms`).
- **Routes are mounted inside the `listen()` callback** so the Agent Card URL contains the real port. Tests rely on `PORT=0`/`UI_PORT=0` and parse the `listening on http://127.0.0.1:<port>` lines — keep those log lines stable. Host/Origin guards (`src/local-guard.js`) are likewise created there.
- **Log shape is a test contract**: tests match `messageId: '<id>'` in the Tutor's `received message` log and count `[Tutor Agent] recorded submission` blocks.
- **Three channels — keep them separate**: A2A carries all agent messages; A2UI describes the UI and travels inside A2A; the SSE stream (Tutor `/viz/events` → UI server → browser `/api/events`) only reports real events and delivers the received A2UI payload to the renderer. Never route agent messages over SSE or synthesize events agents didn't emit.
- **Form = one A2A task**: a chat reply that is a form is a Task in `INPUT_REQUIRED` (askTutor returns `{ form }`); every form action resumes it with `taskId`. A completed task can't be resumed (SDK rejects: "terminal state"), so `sendFormAction()` checks `GetTask` first and otherwise sends a new message in the same `contextId` with `referenceTaskIds`. The form host dedupes by `metadata.operationId` (same values → stored result; different values → rejected).
- **Delivery outcomes** (`deliveryOutcome` in student-agent): failures before `sendMessage` starts or ECONNREFUSED → `not_delivered`; timeout/network error mid-send → `uncertain` (never auto-retried; retry must reuse the submissionId).
- **Validation runs in three places** from one module (`src/forms.js`): browser (A2UI `checks` + `validateFinal`), UI server, issuing agent (authoritative). `forms.js` must stay dependency-free — the browser imports it from `/shared/forms.js`.
- **Run state lives in the UI server** (`NEXT_STATES`, forward-only). Tutor viz events arrive on a separate connection and may land *after* the A2A reply; tests must wait for them rather than assume ordering. Only POST endpoints start A2A requests; `GET /api/events` replays history (browser dedupes by `seq`, resets on new `bootId`).
- Browser renders its own text via `textContent` — don't introduce `innerHTML`.

## Part 4 (model) notes

- `src/tutor-model.js` reads `TUTOR_MODE` **at import time** (module constant). Set env before importing it (see `scripts/live-smoke.js`). Tests that need live behavior run a live-mode Tutor process against `test/support/fake-anthropic.js` via `ANTHROPIC_BASE_URL`, with a placeholder key and `TUTOR_LOAD_DOTENV=0` — never a real key, never real network.
- **Ready = live.** When handing the running app to the user ("it's ready", "restart the servers"), run it in usage mode: `tutor:live`, `library:live`, `ui:live`. Mock/fixed modes are for automated tests only; never leave the user on placeholder answers. Paid calls for normal use and verification don't need a pre-approved budget (the `smoke:live`/`eval:live` scripts still take their `*_MAX_USD` env gate).
- Start live servers with `env -u ANTHROPIC_BASE_URL` when launching from Claude Code: its shell sets that variable to a local proxy that answers with fake 429s. The startup line must say `API host: api.anthropic.com`.
- Never read, print, or log the key or the user's key files (`.env`, `.temp`); only report presence as a boolean.
- No hidden retries: `maxRetries: 0`, no fallback model, no canned answers on failure. Errors are mapped to sanitized codes (`toTutorError`); don't pass raw provider messages through.
- Duplicate-call protection is keyed by `(contextId, messageId)` in the Tutor's ledger; the Student reuses the same `messageId` only for reconciling an uncertain outcome. One in-flight model call per `contextId` (`busy` otherwise).
- History is per A2A `contextId`, text-only (no thinking blocks are replayed), append-only per completed exchange, bounded to 10 messages / 12,000 chars. Form data is never sent to the model.
- Haiku 5.5: no `temperature`/`top_p`/`top_k` (400 on API version 2026-10-21), thinking counts toward `max_tokens` (hence `effort: "low"` with the 800-token cap), always check `stop_reason` (`refusal`, `max_tokens`) before using content.
- Message contents are logged only when `LOG_CONTENT` is on (default on in fixed/mock — earlier tests read Tutor logs — off in live; `TUTOR_LOG_CONTENT` overrides). The UI server sets `STUDENT_LOG_CONTENT=0`.

## Part 5 (routing, skills, notifications, scope) notes

- Modes are read **at import time**: `TUTOR_MODE` (tutor-model), `ROUTER_MODE` (router; code default `direct` so Part 2–4 tests that spawn `src/ui-server.js` without env keep their behaviour), `TUTOR_SCOPE_ENFORCEMENT` (default on; Part 4 plumbing tests set `off` because scope checks add model calls).
- **Single source of truth**: a skill config → `buildCardSkills` (card), `buildScopeExtension` (`urn:a2a-spike:skill-scope:v1`, our documented extension — don't invent standard A2A fields), `policyFromConfig` (runtime). Save swaps all three atomically by mutating the live card object the SDK serves. Skills have no handlers: each has `kind` (`answer`, or `form` only for the reserved Tutor id `student-details-form`) and private `knowledge` ("answer content", never on the card). Per-agent `rules` decide whether knowledge is required (Library) or optional reference notes (Tutor). The Library answers only from that content (`src/library-model.js`): mock extracts lines; live must return evidence lines that code verifies verbatim before release.
- **Trust boundaries**: destinations come only from the Hub configuration (`loadHubConfig().peers`). Router output is validated by `validateDecision` (agent+skill must be in the live registry view); fetched cards by `validateCard` in `src/cards.js` (name, single JSON-RPC 1.0 URL equal to the registered one, no security changes). Notification contents are hints only — never apply skills/URLs from them.
- Cards are fetched with `node:http`, not `fetch`: undici adds `Cache-Control: no-cache` to conditional requests, which makes Express return 200 instead of 304.
- **Express 5** calls the `app.listen` callback with the error (e.g. EADDRINUSE) — always check `err` first.
- Agent viz events now come from both agents; the UI server relays them with `source: agentId`. Config events (`skills_saved`, `card_notification`) have `runId: null`. Tests use `chatVia` / `startTrio` in `test/support/harness.js` and assert the **actual destination** via the receiving agent's own `message_received` event and the reply's `servedBy` (from reply `metadata.agentId`).
- Mock classifiers/routers are labelled heuristics (term sets derived from the saved config); they prove plumbing, not accuracy. Live judgments are probabilistic — don't claim otherwise.
- Configuration changes and notifications must never trigger model calls.

## A2UI gotchas

- Pinned to **v0.9** (not v0.9.1) because `@a2ui/lit` 0.14.0 registers the v0_9 basic catalog and web_core ships v0_9 JSON schemas. Messages use `"version": "v0.9"`; extension URI `https://a2ui.org/a2a-extension/a2ui/v0.9`.
- A2UI parts set both `mediaType` and `metadata.mimeType` to `application/a2ui+json` (A2A v1.0 field vs. the extension spec's v0.3-era wording); `isA2uiPart` accepts either.
- The renderer refuses regexes its ReDoS detector deems unsafe and reports the check as failed — prefer catalog functions (`email`, `required`, `length`) and trivially safe patterns.
- Check visibility is gated by `/ui/submitAttempted`; Submit is disabled via a Button check on `/ui/submitLocked`. These are client-local data-model flags set by `public/app.js`.
- The renderer adopts `updateDataModel` values by reference and mutates them — `structuredClone` before re-processing the same payload (see `test/a2ui-render.test.js`).
- Schema validation (`test/support/a2ui-schema.js`) binds the protocol schemas' generic `catalog.json` ref to the basic catalog and registers `client_to_server.json` (which has no `$id`) explicitly. The JSON files aren't in web_core's `exports`; they're read from the package directory.
- Rendering tests need jsdom globals, so they live in their own test file (node:test runs each file in a separate process).

## SDK v1.x gotchas

The SDK's v1.0 types are protobuf-generated and differ from v0.3 examples found online:
- Parts in JS: `{ content: { $case: 'text' | 'data', value }, mediaType, filename, metadata }` (wire JSON is just `{"text": ...}` / `{"data": ...}`).
- Roles/states are enums: `Role.ROLE_USER`, `TaskState.TASK_STATE_INPUT_REQUIRED`, etc.
- Agent Card uses `supportedInterfaces[{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant }]`, not a top-level `url`.
- `sendMessage(request, { signal, serviceParameters })` returns `Message | Task`; `serviceParameters` become HTTP headers (`HTTP_EXTENSION_HEADER` = `A2A-Extensions`).
- npm package ships no samples; check `node_modules/@a2a-js/sdk/dist/**/*.d.ts` for exact shapes.

## Steps folder (keep it current)

`Steps/` holds one file per build step (`NN-short-name.md`) plus `Steps/README.md` (index table + rules for all steps). At the end of every step, and after any later enhancement to an existing step, write or update that step's file so it is the **final version's prompt**: the user's original wording with every enhancement merged into the instructions themselves (so running the steps in order rebuilds the current app), plus an "Avoid these known problems" section listing every bug, wrong assumption or user-reported issue hit during the step (written as instructions so a rebuild avoids it), followed by an "Enhancements merged into this step" section saying what changed and why. Add the new step to the README table. Take the original prompt from the user's message verbatim (drop "Copy this into Codex" lines).

## Part 6 (conversational workflow forms) notes

- Workflows live in `src/forms.js` (`WORKFLOWS`): `tutoring-request` (Tutor skill `in-person-tutoring-request`) and `study-room-booking` (Library skill `study-room-booking`). Each is the agent's reserved `kind: 'form'` skill; disabling it blocks both new forms and actions. Actions are allowlisted per workflow with their button ID and fields.
- **Prefill comes only from `src/form-intent.js` parsing the student's words** — never from model output; names/emails/notes are never prefilled. Live mode asks the model only for the outcome (new verdicts in the Tutor's scope check and the Library's structured call).
- **Form lifecycle is owned by the UI server** (`form_lifecycle` events): `editing → submitting → accepted | rejected | confirmation_pending`, `editing → cancelled | superseded`. The browser (`public/forms-ui.js`) removes the surface with the standard A2UI `deleteSurface` on a valid submit, and only re-renders forms still `editing` after the `replayed` SSE marker. Late events for closed forms are ignored.
- One editable form per workflow per conversation: the agent asks "continue or replace?" (`wantsReplacement`); the UI server also refuses to render a second one. A repeat of the same chat request (same messageId) gets the same form back (`formHost.formForRequest`).
- Room booking: availability only from `createRoomStore().listStudyRoomAvailability`; slot IDs are opaque and per form; `reserveStudyRoom` is synchronous check-and-set (no `await` between check and write) — keep it that way. Review is required before confirm.
- The test schema validator checks formats (date/time/date-time): DateTimeInput `min`/`max` must be `YYYY-MM-DD` or `HH:MM:SS`, otherwise the schema's `oneOf` fails.
- **Advisory review before recording** (`src/form-review.js`, `reviewGate`): after the code checks pass, the agent reviews all fields (live: Haiku with every field incl. name/email; otherwise a heuristic). It can only return `needs_review` with flags — the UI server reopens the form (`editing`, `review: true`); "Send anyway" (`acknowledgeReview`) skips the review only for the exact values already reviewed. Review failures fail open. Agent server logs still redact names/emails; lookups send scheduling fields only.

## Scope constraints

Do not add token streaming, push notifications, multi-agent fan-out (the Hub forwards to at most one specialist), mailboxes, database, auth/accounts, real email sending, frontend frameworks, model tools, model-generated UI/code, or deployment unless explicitly asked. Only the Student (`STUDENT_MODE=live`: clarifying and capability choice), the Tutor (answers, scope checks), the Hub's router, and the Library in `LIBRARY_MODE=live` call the LLM; form validation stays deterministic. All servers must stay bound to `127.0.0.1`. Records are in-memory by design. Keep dependency versions pinned exactly. Use fictional sample data only (e.g. Alex Student, alex@example.com).

## Part 7 (University Hub, topology) notes

- **Topology is fixed:** Student → Hub → Tutor/Library. The Student config (`src/config.js`) forbids specialist URLs; specialist endpoints come only from the Hub's configuration (`TUTOR_URL`/`LIBRARY_URL` override them). Configuration is validated at startup and throws `ConfigError` — never fall back to direct routing.
- **Control messages** (register, heartbeat, deregister, card changed) are typed A2A data parts handled by the Hub executor before any student check (`CONTROL_MEDIA_TYPES`). Registration requires the claimed endpoint to equal the configured one and refuses a second live instance; the card is fetched from the configured URL before `ready`. Registered ≠ ready: statuses are `ready`, `stale`, `unreachable`, `disconnected`, `disabled`, `invalid_card`, and only `ready` gets dispatches (otherwise the decision becomes `unavailable`).
- **Two A2A legs, separate IDs:** the Hub reuses `askTutor`/`sendFormAction` downstream with its own messageId and a per-(conversation, specialist) context. Chat repeats are answered from `chatLedger` (keyed by upstream contextId+messageId); form actions are deduped by operationId in `operations` (only definite results are cached — `outcome_unknown` is not, so a reconcile can forward again and the specialist dedupes).
- Form actions must carry `formRef`; the Hub checks student, conversation, expiry, supersession and surfaceId, then forwards to the recorded issuer. Hub replies to the Student use `status: 'outcome_unknown'` / `'not_delivered'`, which `sendFormAction` turns into `uncertain` / `not_delivered` errors.
- **Telemetry:** the UI server follows only the Hub's `/viz/events`; the Hub relays specialist feeds with `source: agentId`, **redacted by an allowlist** (`redactTelemetry`: safe IDs/status/timing fields only; receipts → ID and status; run-less config events unchanged) unless `HUB_TELEMETRY_SHOW_CONTENT=1` (tests that compare received values set it). `src/topology.js` labels events (edge, from/to, category, phase); the browser animates only labelled live events, buffered ~350 ms and sorted by `at`. Heartbeats are ephemeral (never in history). Event IDs are `<bootId>:<seq>`; `Last-Event-ID` resumes; `UI_HISTORY_LIMIT` bounds history with a `truncated` notice.
- Tests: use `startStack` (alias `startTrio`) — it pre-picks specialist ports so the Hub config can name them, waits until the Hub follows each specialist's feed, and kills its *current* processes (a restarted one included). Use `readyAgents` for deliberately disabled specialists. Telemetry may lag the A2A reply — wait for Hub/specialist events, don't assume order.
- **Model provider node:** the Hub (live router), Tutor and Library report `model_call_started` / `model_response_received` / `model_call_failed` (the Tutor's live scope check: `scope_check_started` with `mode`, `scope_checked` with `usage`). `src/topology.js` turns these into `<caller>-model` hops only for live calls (mock → inside the agent; `missing_credentials` → no call). The browser (`public/topology.js`) draws each `<caller>-model` hop at that caller's own model box (`llm-student`, `llm-hub`, `llm-tutor`, `llm-library`) — there is no shared provider node. - **Student's own model** (`src/student-assistant.js`, `STUDENT_MODE` off (code default) / mock / live, read at import): before sending, `planAndSend` in ui-server matches the question against the Hub card's **capability skills** (one public skill per destination, built from `cfg.destinations` name/tags/examples — never worker names or URLs). Exactly one match = obvious → sent as-is, **the Hub's router decides** (a keyword is not intent: “reading for my calculus course” is a library request). Zero/several matches → the Student's model returns `send` + capability ID (or `none`) or `clarify`; a reply to the university's own question goes on unchanged. A clarification holds the question (`conversations[ctx].pending`) and the next message in that context is sent as question + answer; at most one clarification. The capability travels as `metadata.requestedCapability`; the Hub honors only its own destination IDs (`decidedBy: 'student'`, no router call; readiness still checked), emits `capability_rejected` otherwise. Model failure fails open to the Hub's routing, visibly (`by: 'model_failed'`).
- **Per-agent model:** each model-using agent has `model: { name, apiKeyEnv }` in its config (`STUDENT_MODEL` / `HUB_MODEL` / `TUTOR_MODEL` / `LIBRARY_MODEL` override the name), validated against `src/models.js` and applied with `useModel()` at startup; code reads it via `modelName()` / `keyEnvName()` — never a module constant. Only list a model there after checking it accepts what `callModel` sends (effort `low`, structured output, no sampling params) and adding its official price. Unknown names are a `ConfigError`, never a fallback. Startup logs name the key *variable* (`API key (ANTHROPIC_API_KEY): configured`), never the value. Never probe the provider to show its status.
- **Hop-by-hop strip** (`public/app.js`: `STEPS`, `flowStep`, `markStep`, `skipSteps`, `updateActiveStep`): steps have `data-state` pending/done/skipped/failed/unknown and `data-active` for the step in progress; `flowStep` maps each real event to its step and marks steps the flow didn't take as skipped with the reason. Only real events mark steps — never infer one.
- Specialists sign out on SIGTERM; tests that need a crash use `SIGKILL` and wait for heartbeat expiry (3 s in tests).

