# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A protocol-connectivity spike: two separate Node.js processes talk over the real A2A protocol (v1.0, JSON-RPC binding) using `@a2a-js/sdk` 1.3.0. `src/tutor-agent.js` is the A2A server (Agent B); `src/student-agent.js` is the A2A client (Agent A). `src/ui-server.js` + `public/` add a browser monitor that hosts the Student in-process and visualizes the exchange. Part 3 adds an A2UI v0.9 form the Tutor sends inside A2A and the browser renders with the official `@a2ui/lit` renderer. Replies are deterministic — no LLM, API keys, or external services. See README.md for the hop-by-hop walkthrough and version rationale.

## Commands

```bash
npm run tutor      # server on 127.0.0.1:41241 (override with PORT=...)
npm run student    # client; target with TUTOR_URL=http://127.0.0.1:...
npm run ui         # builds public/vendor/a2ui.js, then monitor on http://127.0.0.1:3000 (UI_PORT, TUTOR_URL); needs the tutor running
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

Do not add streaming, push notifications, a reverse server, continuous chat, hub/routing/mailboxes, database, auth/accounts, real email sending, frontend frameworks, or deployment unless explicitly asked. All servers must stay bound to `127.0.0.1`. Records are in-memory by design. Keep dependency versions pinned exactly. Use fictional sample data only (e.g. Alex Student, alex@example.com).
