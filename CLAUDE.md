# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A protocol-connectivity spike: two separate Node.js processes talk over the real A2A protocol (v1.0, JSON-RPC binding) using `@a2a-js/sdk` 1.3.0. `src/tutor-agent.js` is the A2A server (Agent B); `src/student-agent.js` is the A2A client (Agent A). `src/ui-server.js` + `public/` add a browser monitor that hosts the Student in-process and visualizes the exchange. Replies are deterministic — no LLM, API keys, or external services. See README.md for the request/response walkthrough.

## Commands

```bash
npm run tutor      # server on 127.0.0.1:41241 (override with PORT=...)
npm run student    # client; target with TUTOR_URL=http://127.0.0.1:...
npm run ui         # browser monitor on http://127.0.0.1:3000 (UI_PORT, TUTOR_URL); needs the tutor running
npm test           # node:test; spawns tutor / UI server as child processes on free ports
node --test --test-name-pattern="negative" test/   # run a single test by name
```

No build, lint, or TypeScript step — plain ESM JavaScript (`"type": "module"`).

## Architecture notes

- **Server layering**: `tutorExecutor` (business logic) → `DefaultRequestHandler` (protocol: assigns contextId/taskId, enforces event ordering) → `jsonRpcHandler` / `agentCardHandler` Express adapters. The executor's first published event must be `AgentEvent.message(...)` or `AgentEvent.task(...)`; it currently replies with a direct `Message` (no Task lifecycle).
- **Routes are mounted inside the `listen()` callback** so the Agent Card's `supportedInterfaces[].url` contains the real port. Tests rely on `PORT=0` and parse the `listening on http://127.0.0.1:<port>` stdout line — keep that log line format stable.
- **Client discovery**: the student resolves the card with `DefaultAgentCardResolver` (rather than `ClientFactory.createFromUrl`) so it can log the discovered card, then `ClientFactory.createFromAgentCard` picks the transport. `askTutor()` is exported and called directly by the tests; the `import.meta.url` guard makes each file both a module and a runnable process.
- **Traceability is tested**: the integration tests match the student's outgoing `messageId` against the tutor's `received message` log, so log output shape (`messageId: '<id>'`) is part of the test contract. The UI tests also parse `[UI] listening on http://...`.
- **Two connection types — keep them separate**: A2A (`askTutor()` → Tutor JSON-RPC) carries all agent messages. Visualization is read-only SSE: Tutor `/viz/events` → UI server → browser `/api/events`. Never route agent messages over the visualization path or synthesize events the agents didn't emit.
- **Run correlation**: the UI's `runId` rides in A2A `Message.metadata` (and back in the reply's metadata); the Tutor tags viz events with it, and the UI server drops Tutor events for runs it didn't start (e.g. CLI runs).
- **Run state lives in the UI server** (`NEXT_STATES` forward-only). `waiting` is set only by the Tutor's `message_received` event, which travels on a separate connection and often arrives *after* the A2A reply — so `sending → completed` is a legitimate sequence, and tests must wait for Tutor events rather than assume they precede completion.
- **Only `POST /api/runs` starts an A2A request.** `GET /api/events` replays history (browser dedupes by `seq`, resets on new `bootId`), so reconnects can't resend. A server-side 409 guards double submission in addition to the disabled button.
- Browser renders all message content via `textContent` — don't introduce `innerHTML`.

## SDK v1.x gotchas

The SDK's v1.0 types are protobuf-generated and differ from v0.3 examples found online:
- Text part in JS: `{ content: { $case: 'text', value }, mediaType, filename, metadata }` (wire JSON is just `{"text": ...}`). Not `{ kind: 'text', text }`.
- Roles are enums: `Role.ROLE_USER` / `Role.ROLE_AGENT`.
- Agent Card uses `supportedInterfaces[{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant }]`, not a top-level `url`.
- `sendMessage` takes a `SendMessageRequest` (`{ tenant, message, configuration, metadata }`) and returns `Message | Task`.
- npm package ships no samples; check `node_modules/@a2a-js/sdk/dist/**/*.d.ts` for exact shapes.

## Scope constraints

Intentionally limited to one A2A request/response per run. Do not add streaming, push notifications, a reverse server, continuous chat, hub/routing/mailboxes, A2UI, database, auth, frontend frameworks, or deployment unless explicitly asked. All servers must stay bound to `127.0.0.1`. Keep dependency versions pinned exactly.
