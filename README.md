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

```bash
npm test   # starts the Tutor as a child process, runs all checks, stops it
```

## Files

| File | What it is |
| --- | --- |
| `src/tutor-agent.js` | **Agent B, the Tutor Agent.** An Express server that serves the Agent Card at `/.well-known/agent-card.json` and the A2A JSON-RPC endpoint at `/a2a/jsonrpc`. `tutorExecutor` holds its logic: log the incoming message, publish a fixed reply. |
| `src/student-agent.js` | **Agent A, the Student Agent.** Fetches the Tutor's Agent Card, builds an SDK client from it, sends one message and prints the reply. `askTutor()` is exported so the test can call the same code. |
| `test/a2a.test.js` | Starts the Tutor as a real separate process on a free port. Checks the Agent Card, the exact reply through the SDK client, a full Student-process ↔ Tutor-process run (matching message IDs in both logs), and a clear failure when the Tutor is down. |
| `package.json` / `package-lock.json` | Pinned dependencies and the `tutor` / `student` / `test` scripts. |

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

## Deliberately not included

Streaming, Tasks and their lifecycle, push notifications, a reverse server,
multi-turn chat, auth, routing and UI. This is one request and one response.
