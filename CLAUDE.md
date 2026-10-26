# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A protocol-connectivity spike: two separate Node.js processes talk over the real A2A protocol (v1.0, JSON-RPC binding) using `@a2a-js/sdk` 1.3.0. `src/tutor-agent.js` is the A2A server (Agent B); `src/student-agent.js` is the A2A client (Agent A). `src/ui-server.js` + `public/` add a browser monitor that hosts the Student in-process and visualizes the exchange. Part 3 adds an A2UI v0.9 form the Tutor sends inside A2A and the browser renders with the official `@a2ui/lit` renderer. Part 4 lets the Tutor answer chat with Claude Haiku 5.5 (`claude-haiku-5-5`, `@anthropic-ai/sdk` 1.3.0) in `TUTOR_MODE=live`; the default `fixed` mode keeps the deterministic Part 1 reply. Part 5 adds a deterministic **Library Agent** (`src/library-agent.js`, :41242), Student-side **routing** (`src/router.js`) over a **trusted registry** (`src/student-registry.js`), editable per-agent **skill configurations** (`src/skills.js`, `src/agent-settings.js`) with `agent_card_changed` notifications to the Student's own **A2A endpoint** (`src/student-endpoint.js`, :41240), and **scope enforcement** on the receiving agents. See README.md for the hop-by-hop walkthrough and version rationale.

## Commands

```bash
npm run tutor      # server on 127.0.0.1:41241 (override with PORT=...), fixed reply
npm run tutor:mock # deterministic fake model, no network
npm run tutor:live # Claude Haiku 5.5; key from env or .env (TUTOR_ENV_FILE to override) — PAID
npm run smoke:live # paid live smoke test; refuses unless LIVE_SMOKE_MAX_USD is set
npm run library    # Library Agent on 127.0.0.1:41242 (deterministic, sample fixture)
npm run student    # CLI client; target with TUTOR_URL=http://127.0.0.1:...
npm run ui         # builds bundle, then UI :3000 + Student A2A endpoint :41240 with the MOCK router
npm run ui:live    # same with the live Haiku router — PAID
npm run ui:direct  # no routing: Parts 2–4 behaviour (this is also the code default for ROUTER_MODE)
npm run eval:live  # paid Part 5 spot check; refuses unless LIVE_EVAL_MAX_USD is set
npm run build:ui   # esbuild bundle of the A2UI renderer only (output is gitignored)
npm test           # node:test; spawns tutor / UI server as child processes on free ports
node --test --test-name-pattern="duplicate" test/   # run tests by name
node --test test/form.test.js                       # run one file
```

Plain ESM JavaScript (`"type": "module"`), no lint/TypeScript. The only build step is the renderer bundle for the browser.

## Architecture notes

- **Server layering**: `tutorExecutor` (business logic) → `DefaultRequestHandler` (protocol: assigns contextId/taskId, enforces event ordering) → `jsonRpcHandler` / `agentCardHandler` Express adapters. Every executor call must publish `AgentEvent.message(...)` or `AgentEvent.task(...)` first — including follow-ups on an existing task (re-publish `ctx.task`, then `statusUpdate`).
- **Tutor routing** (`execute`): A2UI DataPart → `handleSubmission`; `metadata.request === 'student-details-form'` → `handleFormRequest`; otherwise → `handleChat` (Part 1 reply, log format unchanged).
- **Routes are mounted inside the `listen()` callback** so the Agent Card URL contains the real port. Tests rely on `PORT=0`/`UI_PORT=0` and parse the `listening on http://127.0.0.1:<port>` lines — keep those log lines stable. Host/Origin guards (`src/local-guard.js`) are likewise created there.
- **Log shape is a test contract**: tests match `messageId: '<id>'` in the Tutor's `received message` log and count `[Tutor Agent] recorded submission` blocks.
- **Three channels — keep them separate**: A2A carries all agent messages; A2UI describes the UI and travels inside A2A; the SSE stream (Tutor `/viz/events` → UI server → browser `/api/events`) only reports real events and delivers the received A2UI payload to the renderer. Never route agent messages over SSE or synthesize events agents didn't emit.
- **Form = one A2A task**: the form is returned as a Task in `INPUT_REQUIRED`; a submission resumes it with `taskId`. A completed task can't be resumed (SDK rejects: "terminal state"), so `submitForm()` checks `GetTask` first and otherwise sends a new message in the same `contextId` with `referenceTaskIds`. Tutor dedupes by `metadata.submissionId` and returns the stored ack.
- **Delivery outcomes** (`deliveryOutcome` in student-agent): failures before `sendMessage` starts or ECONNREFUSED → `not_delivered`; timeout/network error mid-send → `uncertain` (never auto-retried; retry must reuse the submissionId).
- **Validation runs in three places** from one module (`src/student-form.js`): A2UI `checks` (renderer), UI server, Tutor. The Tutor is authoritative. `student-form.js` must stay dependency-free — the browser imports it from `/shared/student-form.js`.
- **Run state lives in the UI server** (`NEXT_STATES`, forward-only). Tutor viz events arrive on a separate connection and may land *after* the A2A reply; tests must wait for them rather than assume ordering. Only POST endpoints start A2A requests; `GET /api/events` replays history (browser dedupes by `seq`, resets on new `bootId`).
- Browser renders its own text via `textContent` — don't introduce `innerHTML`.

## Part 4 (model) notes

- `src/tutor-model.js` reads `TUTOR_MODE` **at import time** (module constant). Set env before importing it (see `scripts/live-smoke.js`). Tests that need live behavior run a live-mode Tutor process against `test/support/fake-anthropic.js` via `ANTHROPIC_BASE_URL`, with a placeholder key and `TUTOR_LOAD_DOTENV=0` — never a real key, never real network.
- Never run paid calls (`smoke:live`, `tutor:live` with a real key) without the user's explicit spending approval. Never read, print, or log the key or the user's key files (`.env`, `.temp`); only report presence as a boolean.
- No hidden retries: `maxRetries: 0`, no fallback model, no canned answers on failure. Errors are mapped to sanitized codes (`toTutorError`); don't pass raw provider messages through.
- Duplicate-call protection is keyed by `(contextId, messageId)` in the Tutor's ledger; the Student reuses the same `messageId` only for reconciling an uncertain outcome. One in-flight model call per `contextId` (`busy` otherwise).
- History is per A2A `contextId`, text-only (no thinking blocks are replayed), append-only per completed exchange, bounded to 10 messages / 12,000 chars. Form data is never sent to the model.
- Haiku 5.5: no `temperature`/`top_p`/`top_k` (400 on API version 2026-10-21), thinking counts toward `max_tokens` (hence `effort: "low"` with the 800-token cap), always check `stop_reason` (`refusal`, `max_tokens`) before using content.
- Message contents are logged only when `LOG_CONTENT` is on (default on in fixed/mock — earlier tests read Tutor logs — off in live; `TUTOR_LOG_CONTENT` overrides). The UI server sets `STUDENT_LOG_CONTENT=0`.

## Part 5 (routing, skills, notifications, scope) notes

- Modes are read **at import time**: `TUTOR_MODE` (tutor-model), `ROUTER_MODE` (router; code default `direct` so Part 2–4 tests that spawn `src/ui-server.js` without env keep their behaviour), `TUTOR_SCOPE_ENFORCEMENT` (default on; Part 4 plumbing tests set `off` because scope checks add model calls).
- **Single source of truth**: a skill config → `buildCardSkills` (card), `buildScopeExtension` (`urn:a2a-spike:skill-scope:v1`, our documented extension — don't invent standard A2A fields), `policyFromConfig` (runtime). Save swaps all three atomically by mutating the live card object the SDK serves. Every skill must name an implemented `handler`; unknown handlers are rejected (advertising ≠ capability).
- **Trust boundaries**: destinations come only from `trustedPeers()`. Router output is validated by `validateDecision` (agent+skill must be in the live registry view); fetched cards by `validateCard` (name, single JSON-RPC 1.0 URL equal to the registered one, no security changes). Notification contents are hints only — never apply skills/URLs from them.
- Cards are fetched with `node:http`, not `fetch`: undici adds `Cache-Control: no-cache` to conditional requests, which makes Express return 200 instead of 304.
- **Express 5** calls the `app.listen` callback with the error (e.g. EADDRINUSE) — always check `err` first. The Student endpoint falls back to an ephemeral port if 41240 is taken.
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

## Scope constraints

Do not add token streaming, push notifications, multi-agent fan-out, a Hub/mailboxes, database, auth/accounts, real email sending, frontend frameworks, model tools, model-generated UI/code, or deployment unless explicitly asked. Only the Tutor (answers, scope checks) and the Student router call the LLM; the Library and form validation stay deterministic. All servers must stay bound to `127.0.0.1`. Records are in-memory by design. Keep dependency versions pinned exactly. Use fictional sample data only (e.g. Alex Student, alex@example.com).
