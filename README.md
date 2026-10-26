# A2A Spike: Student Agent ↔ Tutor Agent

A minimal test of whether two agents in separate Node.js processes can talk
using the real **Agent-to-Agent (A2A) protocol**. No LLM, no API keys: the
Tutor's reply is a fixed string.

- SDK: [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) **1.3.0** (pinned exactly)
- Protocol: **A2A v1.0** ([spec](https://a2a-protocol.org/v1.0.0/specification/)), JSON-RPC binding
- Express **5.3.0** (peer dependency of the SDK's server adapter)
- Node.js 20+ (verified on 26.11.1)

## Run it

```bash
npm install

# terminal 1 — Agent B (server), binds to 127.0.0.1:41241
npm run tutor

# terminal 2 — Agent A (client)
npm run student
```

Use `PORT=...` to change the Tutor's port and `TUTOR_URL=http://127.0.0.1:...` to point the Student elsewhere.

### Browser monitor

```bash
# terminal 1 — Agent B
npm run tutor

# terminal 2 — UI server (hosts the Student Agent), binds to 127.0.0.1:3000
npm run ui
```

Then open **http://127.0.0.1:3000**. Use `UI_PORT=...` to change the UI port; `TUTOR_URL` works here too.

```bash
npm test   # starts the Tutor (and UI server) as child processes, runs all checks, stops them
```

## Files

| File | What it is |
| --- | --- |
| `src/tutor-agent.js` | **Agent B, the Tutor Agent.** An Express server that serves the Agent Card at `/.well-known/agent-card.json` and the A2A JSON-RPC endpoint at `/a2a/jsonrpc`. `tutorExecutor` holds its logic: log the incoming message, publish a fixed reply. It also serves `/viz/events`, a read-only feed of its own receive and publish events for the monitor. |
| `src/student-agent.js` | **Agent A, the Student Agent.** Fetches the Tutor's Agent Card, builds an SDK client from it, sends one message and prints the reply. `askTutor(url, text, { runId, onEvent })` is exported so the UI server and the tests can call the same code. |
| `src/ui-server.js` | **UI backend.** Serves the page, starts a run on `POST /api/runs` by calling `askTutor()`, relays the Tutor's feed, and streams every event to the browser on `GET /api/events`. It decides the run state and rejects a second submission while one is in flight. |
| `public/` | The browser page: `index.html`, `styles.css` and `app.js`. It shows only events the server sent, and renders all text with `textContent`. |
| `test/a2a.test.js` | The original A2A tests: the Agent Card, the exact reply, traceable process ↔ process logs, and a clear failure when the Tutor is down. |
| `test/ui.test.js` | Runs the Tutor and UI server as real processes. Covers the typed-message round trip, run-ID correlation across runs, the double-submit guard, no resend on reconnect, the unavailable-Tutor case, and input validation. |
| `package.json` / `package-lock.json` | Pinned dependencies and the `tutor` / `student` / `ui` / `test` scripts. |

## How a message gets there and back

1. **Tutor starts.** It listens on `127.0.0.1` only and builds its **Agent Card**, a JSON description of itself. The card's `supportedInterfaces` says: "I speak A2A `1.0` over `JSONRPC` at `http://127.0.0.1:41241/a2a/jsonrpc`."
2. **Student discovers the Tutor.** It sends `GET /.well-known/agent-card.json`, which is the standard A2A discovery path. It only needs the base URL; the endpoint address comes from the card.
3. **Student picks a transport.** `ClientFactory` compares the card's interfaces with the transports it supports and chooses JSON-RPC.
4. **Student sends.** `client.sendMessage(...)` sends a JSON-RPC request with method `SendMessage`. The body carries a `Message` with `role: ROLE_USER`, a fresh `messageId`, and one text part.
5. **Tutor's SDK handles the protocol.** The `jsonRpcHandler` middleware decodes the request. The SDK's `DefaultRequestHandler` then assigns a `contextId` (a conversation ID) and a `taskId`, and calls `tutorExecutor.execute()`.
6. **Tutor replies.** The executor logs what it got and publishes a `Message` with `role: ROLE_AGENT` and the same `contextId` on the event bus. Because it's a direct message and not a Task, the handler returns it straight away as the JSON-RPC result.
7. **Student receives.** The SDK client decodes the result and gets back a `Message`. The Student checks that it is an agent message and prints its text.

To trace one exchange, match IDs across the two logs. The Student's outgoing `messageId` shows up in the Tutor's `received message` line. The Tutor's reply `messageId` and `contextId` show up in the Student's `received reply` line.

The raw request and response on the wire:

```text
→ POST /a2a/jsonrpc
  {"jsonrpc":"2.0","id":1,"method":"SendMessage",
   "params":{"message":{"messageId":"…","role":"ROLE_USER","parts":[{"text":"Hello Tutor Agent. Can you help me with calculus?"}]}}}
← {"jsonrpc":"2.0","id":1,"result":{"message":{"messageId":"…","contextId":"…","role":"ROLE_AGENT",
   "parts":[{"text":"Hello Student Agent. Yes, I can help you with calculus.","mediaType":"text/plain"}]}}}
```

## The browser monitor: two kinds of connection

```
 Browser ──POST /api/runs──▶  UI server (hosts Student Agent)  ══ A2A JSON-RPC ══▶  Tutor Agent process
   ▲                           │                                                  │
   └──SSE /api/events◀─────────┴◀────────── SSE /viz/events (read-only) ──────────┘
```

- **A2A connection (double line):** the real agent-to-agent communication. It is the same `askTutor()` → `SendMessage` path as the CLI. Messages and replies travel only here.
- **Visualization connection (single lines):** reports of what each agent observed. The Tutor emits `message_received` and `reply_published` from inside its executor. The Student emits `request_sent`, `reply_received` or `request_failed` from inside `askTutor()`. The UI server relays these to the browser. No agent message travels on this connection, and the browser can't send anything over it.

What happens when you click **Send**:

1. The browser sends `POST /api/runs` with the typed text. The server creates a `runId` and publishes `run_started` and state `sending`.
2. The UI server calls `askTutor(text, { runId })`. The Student fetches the Agent Card and emits `request_sent` just before calling `sendMessage`. This means the send has started; it does not confirm delivery.
3. The A2A message carries `metadata: { runId }`.
4. The Tutor's executor receives the message, reads the `runId` from that message, and emits `message_received`. When the UI server sees this, it sets state `waiting`. This is the only confirmation of receipt, and it comes from the Tutor process itself.
5. The Tutor publishes its reply, which also carries the `runId` in its metadata, and emits `reply_published`.
6. `sendMessage` returns the reply. The Student emits `reply_received`, and the server sets state `completed`. On any error it emits `request_failed` and sets state `failed`.

Notes on reading the monitor:

- **`waiting` is often skipped.** On localhost the whole exchange takes a few milliseconds. The A2A reply often arrives before the Tutor's `message_received` event has come through its separate feed. The server never moves a finished run backwards, and the Tutor's steps still appear on the timeline with the Tutor's own timestamps.
- **With the Tutor stopped,** the run fails at Agent Card discovery, so even "Request sent" is marked *not observed*. That's accurate: `sendMessage` was never called.
- **Reloading the page** replays the server's event history over `GET /api/events`. Only `POST /api/runs` can start an A2A request, so a reconnect can never send anything to the Tutor.

## Deliberately not included

Streaming, Tasks and their lifecycle, push notifications, a reverse server,
multi-turn chat, auth, routing, a Hub and a database. Each click is one A2A request and one response.
