# Step 1 — Two agents talking over A2A

Time: about 15 minutes. Cost: free (no model calls, no API key).

## What you'll see when it works

- `npm run tutor` prints `[Tutor Agent] listening on http://127.0.0.1:41241`.
- In a second terminal, `npm run student` discovers the Tutor's Agent Card, sends "Hello Tutor Agent. Can you help me with calculus?" and prints `Tutor Agent replied: Hello Student Agent. Yes, I can help you with calculus.`
- With the Tutor stopped, `npm run student` prints a clear connection error and exits with code 1. It never prints a reply.

## Starting point

Step 0 must be done: pinned packages installed, folders created, `CLAUDE.md` written. Start from the committed code of Step 0.

## Instructions for Claude (lead)

This step is small. There is nothing to split, so **you build it alone**. Do not start subagents. Work through the phases below in order, then run the "Done when" checks.

Before coding, explain the two processes and the message path in two or three plain sentences.

This is a protocol test, not an AI test. Use only the real SDK client and server. No custom REST endpoint, direct function call or made-up transcript.

## Phase 1 — Contracts (lead writes these first)

1. `src/tutor-agent.js` exports `TUTOR_REPLY = 'Hello Student Agent. Yes, I can help you with calculus.'` and `startTutorServer({ port = 41241 } = {})`, which resolves to `{ server, baseUrl }`.
2. `src/student-agent.js` exports `STUDENT_MESSAGE = 'Hello Tutor Agent. Can you help me with calculus?'` and `askTutor(baseUrl, text = STUDENT_MESSAGE)`, which resolves to `{ messageId, contextId, taskId, text }`.
3. The Tutor's A2A endpoint is `/a2a/jsonrpc`. Its Agent Card is served at `/.well-known/agent-card.json` (the SDK constant `AGENT_CARD_PATH`).
4. Add the npm scripts `"tutor": "node src/tutor-agent.js"` and `"student": "node src/student-agent.js"`.

## Phase 2 — Build

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| Lead only | (lead) | `src/tutor-agent.js`, `src/student-agent.js`, `test/support/harness.js`, `test/a2a.test.js`, `package.json` | The Tutor server, the Student client, the test helpers and the tests | `npm test` passes |

### Tutor Agent (`src/tutor-agent.js`)

1. Build it with Express 5 and the SDK's server layers: an executor (business logic) → `DefaultRequestHandler` with `InMemoryTaskStore` → the Express adapters `agentCardHandler` and `jsonRpcHandler` (with `UserBuilder.noAuthentication`).
2. The Agent Card has `name: 'Tutor Agent'`, one skill `calculus-help`, and `capabilities: { streaming: false, pushNotifications: false, extensions: [] }`.
3. The card lists exactly one interface: `supportedInterfaces: [{ url: 'http://127.0.0.1:<port>/a2a/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }]`. There is no top-level `url`.
4. Listen on `127.0.0.1` only. Read the port from `PORT` (default 41241). `PORT=0` must pick a free port.
5. Call `app.listen(port, '127.0.0.1', (err) => …)`. Express 5 passes listen errors such as `EADDRINUSE` to this callback. Check `err` first and reject.
6. Mount the card and JSON-RPC routes **inside** the listen callback, after reading `server.address().port`. That way the card URL has the real port.
7. When run directly, print `[Tutor Agent] listening on http://127.0.0.1:<port>` and then the Agent Card URL.
8. In `execute(requestContext, eventBus)`, first log `received message` with `{ messageId, contextId, taskId, text }` of the incoming message.
9. Then build a reply `Message` with `role: Role.ROLE_AGENT`, the request's `contextId`, `taskId: ''`, and one text part holding `TUTOR_REPLY`.
10. Log `sending reply` with `{ messageId, contextId, inReplyTo, text }`.
11. Call `eventBus.publish(AgentEvent.message(reply))` and then `eventBus.finished()`. Every executor call must publish a message or task first, or the SDK rejects the exchange.
12. The reply is always `TUTOR_REPLY`, whatever the question. It is deterministic on purpose. There is no model yet.
13. Tutor log lines start with `[Tutor Agent]`. Log objects with `console.log`, so Node prints `messageId: '<id>'`. Tests match that text.

### Student Agent (`src/student-agent.js`)

1. `askTutor` discovers the card with `new DefaultAgentCardResolver().resolve(baseUrl)` and logs `discovered Agent Card` with the name and interfaces.
2. It creates the client with `new ClientFactory().createFromAgentCard(card)`. The factory picks the transport from `supportedInterfaces`.
3. It builds a user message: new `messageId` (`randomUUID()`), `contextId: ''` (the server starts a new context), `role: Role.ROLE_USER`, one text part.
4. Parts use the v1.0 shape: `{ content: { $case: 'text', value }, mediaType: 'text/plain', filename: '', metadata: undefined }`.
5. Log `sending message` with `{ messageId, text }` before sending.
6. Call `client.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined })`.
7. The result is a `Message` or a `Task`. If it is not an agent `Message`, throw. Never invent a reply.
8. Log `received reply` and return `{ messageId, contextId, taskId, text }`.
9. Student log lines start with `[Student Agent]`.
10. When run directly, use `TUTOR_URL` (default `http://127.0.0.1:41241`). On success print `Tutor Agent replied: <text>`.
11. On failure print to stderr `[Student Agent] FAILED to reach Tutor Agent at <url>: <message> (<cause code>)` and set `process.exitCode = 1`. The cause code for a stopped Tutor is `ECONNREFUSED`.

### Test helpers (`test/support/harness.js`)

1. `startProcess(script, env, readyPattern)` spawns `node <script>` with the extra env. It collects stdout and stderr.
2. It returns `{ proc, ready, output }`. `ready` resolves with the first capture group of `readyPattern`. It rejects if the process exits early, including the output in the error.
3. `TUTOR_READY = /listening on (http:\/\/127\.0\.0\.1:\d+)/`.
4. `startTutor(env = {})` starts `src/tutor-agent.js` with `PORT: '0'`, waits for `ready`, and sets `tutor.url`.
5. `unusedPort()` opens a server on port 0, reads the port, closes it, and returns the port. Use it to get a dead address.

### Tests (`test/a2a.test.js`)

Start one real Tutor with `startTutor()`; kill it in `after()`. Check:

1. **Card discovery:** `GET <url>/.well-known/agent-card.json` returns 200, `name` is `Tutor Agent`, and `supportedInterfaces` deep-equals `[{ url: '<url>/a2a/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }]`.
2. **Exact reply:** `askTutor(url)` returns text equal to the literal `'Hello Student Agent. Yes, I can help you with calculus.'`. Also check `TUTOR_REPLY` equals that literal. The reply has a `messageId` and a server-assigned `contextId`.
3. **Two processes, traceable logs:** run `src/student-agent.js` as a child process with `TUTOR_URL`. Its stdout contains `Tutor Agent replied: …`.
4. Take the `messageId` from the Student's `sending message` line. The Tutor's output must contain `messageId: '<that id>'` and the text of `STUDENT_MESSAGE`.
5. **Negative:** with `TUTOR_URL` pointing at `unusedPort()`, `askTutor` rejects with `err.cause.code === 'ECONNREFUSED'`.
6. The Student process exits with code 1. Its stderr matches `/FAILED to reach Tutor Agent .*ECONNREFUSED/`. Its stdout does not contain `Tutor Agent replied`.

## Phase 3 — Join and check (lead)

1. Run `npm test`. Fix failures until it passes.
2. Run the Tutor and the Student by hand (see "Show it"). Show the real output of both processes.
3. State the versions used: `@a2a-js/sdk` 1.3.0, A2A protocol 1.0, JSON-RPC binding. Never label something passed that you didn't test.

## Rules that apply to the whole step

1. Both processes bind to `127.0.0.1` only.
2. No LLM, no API key, no paid service.
3. No Hub, routing, UI, A2UI, database, auth, push messages, reverse server or continuous chat yet. One request, one reply.
4. Keep the `[Tutor Agent] listening on http://127.0.0.1:<port>` line exactly. Tests parse it.
5. Keep the Tutor's `received message` log shape. Later tests match `messageId: '<id>'` in it.

## Avoid these known problems

- Don't copy A2A examples from the web. Most are for protocol v0.3. SDK 1.3.0 uses v1.0 shapes: `$case` parts, enum roles, `supportedInterfaces`. Check `node_modules/@a2a-js/sdk/dist/**/*.d.ts`.
- Don't call `server.address()` before checking the listen callback's `err`. A taken port would crash the server.
- Don't mount routes before `listen()`. The card URL would carry the wrong port.
- Don't stop servers with broad `pkill` patterns. Stop them by port with `lsof -tiTCP:<port> -sTCP:LISTEN`.

## Done when

- `npm test` → all tests pass, 0 failed.
- `npm run tutor` prints `[Tutor Agent] listening on http://127.0.0.1:41241`.
- `npm run student` prints `Tutor Agent replied: Hello Student Agent. Yes, I can help you with calculus.`
- With the Tutor stopped, `npm run student` prints the `FAILED to reach Tutor Agent … ECONNREFUSED` error and exits with code 1.

Then append the "CLAUDE.md notes" below to `CLAUDE.md` and commit `Step 1: Two agents talking over A2A`.

## CLAUDE.md notes

```markdown
## Step 1 (A2A connectivity)
- src/tutor-agent.js = A2A server (Agent B, port 41241). src/student-agent.js = A2A client (Agent A).
- Server layering: executor (logic) → DefaultRequestHandler (protocol) → agentCardHandler / jsonRpcHandler.
- Every executor call must publish AgentEvent.message(...) or AgentEvent.task(...) first.
- Routes are mounted inside the app.listen callback so the Agent Card URL has the real port. Check the callback's err first (Express 5).
- Keep the "[Tutor Agent] listening on http://127.0.0.1:<port>" line and the "received message" log with messageId: '<id>'. Tests parse both.
- The Tutor's reply is fixed (TUTOR_REPLY) until Step 4 adds the model.
- Tests start real processes through test/support/harness.js (startProcess, startTutor, unusedPort) with PORT=0.
```

## Show it (optional)

```bash
npm run tutor                      # terminal 1
npm run student                    # terminal 2: prints the Tutor's reply
kill $(lsof -tiTCP:41241 -sTCP:LISTEN)
npm run student                    # now fails with ECONNREFUSED, exit code 1
```

The `messageId` in the Student's `sending message` line matches the Tutor's `received message` line.
