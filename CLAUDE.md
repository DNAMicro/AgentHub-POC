# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A protocol-connectivity spike: two separate Node.js processes talk over the real A2A protocol (v1.0, JSON-RPC binding) using `@a2a-js/sdk` 1.3.0. `src/tutor-agent.js` is the A2A server (Agent B); `src/student-agent.js` is the A2A client (Agent A). Replies are deterministic — no LLM, API keys, or external services. See README.md for the request/response walkthrough.

## Commands

```bash
npm run tutor      # server on 127.0.0.1:41241 (override with PORT=...)
npm run student    # client; target with TUTOR_URL=http://127.0.0.1:...
npm test           # node:test; spawns the tutor as a child process on a free port
node --test --test-name-pattern="negative" test/   # run a single test by name
```

No build, lint, or TypeScript step — plain ESM JavaScript (`"type": "module"`).

## Architecture notes

- **Server layering**: `tutorExecutor` (business logic) → `DefaultRequestHandler` (protocol: assigns contextId/taskId, enforces event ordering) → `jsonRpcHandler` / `agentCardHandler` Express adapters. The executor's first published event must be `AgentEvent.message(...)` or `AgentEvent.task(...)`; it currently replies with a direct `Message` (no Task lifecycle).
- **Routes are mounted inside the `listen()` callback** so the Agent Card's `supportedInterfaces[].url` contains the real port. Tests rely on `PORT=0` and parse the `listening on http://127.0.0.1:<port>` stdout line — keep that log line format stable.
- **Client discovery**: the student resolves the card with `DefaultAgentCardResolver` (rather than `ClientFactory.createFromUrl`) so it can log the discovered card, then `ClientFactory.createFromAgentCard` picks the transport. `askTutor()` is exported and called directly by the tests; the `import.meta.url` guard makes each file both a module and a runnable process.
- **Traceability is tested**: the integration test matches the student's outgoing `messageId` against the tutor's `received message` log, so log output shape (`messageId: '<id>'`) is part of the test contract.

## SDK v1.x gotchas

The SDK's v1.0 types are protobuf-generated and differ from v0.3 examples found online:
- Text part in JS: `{ content: { $case: 'text', value }, mediaType, filename, metadata }` (wire JSON is just `{"text": ...}`). Not `{ kind: 'text', text }`.
- Roles are enums: `Role.ROLE_USER` / `Role.ROLE_AGENT`.
- Agent Card uses `supportedInterfaces[{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant }]`, not a top-level `url`.
- `sendMessage` takes a `SendMessageRequest` (`{ tenant, message, configuration, metadata }`) and returns `Message | Task`.
- npm package ships no samples; check `node_modules/@a2a-js/sdk/dist/**/*.d.ts` for exact shapes.

## Scope constraints

Intentionally limited to one request/one response. Do not add streaming, push notifications, a reverse server, continuous chat, hub/routing/mailboxes, UI, database, auth, or deployment unless explicitly asked. Server must stay bound to `127.0.0.1`. Keep dependency versions pinned exactly.
