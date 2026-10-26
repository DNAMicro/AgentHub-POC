# Step 1 — Two agents talking over A2A

> Final state: commits `79c6ef4` (spike) and `bd61b67` (CLAUDE.md). Your original instructions are below, with later changes merged in; the closing section lists each change and why it was made.

Build a minimal local spike that proves two agents can communicate using the actual Agent-to-Agent (A2A) protocol.

Goal
Agent A sends Agent B a message. Agent B responds through A2A, and Agent A receives and prints the response. This is a protocol connectivity test, not an AI intelligence test.

Technology
- Use Node.js and plain JavaScript.
- Use the official A2A JavaScript SDK. Check its current official documentation and supported protocol version before coding; pin the working package versions.
- Use two separate processes: Agent B as an A2A server and Agent A as an A2A client.
- Bind the server to localhost only.
- Use deterministic responses. No LLM, API keys, paid services, or account setup.
Required flow
1. Start Agent B, named “Tutor Agent,” exposing a valid Agent Card and A2A endpoint.
2. Start Agent A, named “Student Agent.” It discovers Agent B through its Agent Card.
3. Agent A sends: “Hello Tutor Agent. Can you help me with calculus?”
4. Agent B receives the message through its A2A handler and responds: “Hello Student Agent. Yes, I can help you with calculus.”
5. Agent A receives and prints the actual response returned by Agent B.
Important constraints
- Use the SDK’s real A2A client/server interfaces. Do not substitute a custom REST endpoint, direct function call, or fabricated transcript.
- Both processes must log their own received/sent messages. Include the available message, context, or task identifiers so the exchange can be traced.
- A response to Agent A’s request is sufficient. Do not build unsolicited push messages, a reverse server, or continuous chat yet.
- Do not add the Hub, mailboxes, routing, UI, A2UI, database, authentication system, deployment, or extra frameworks.
- Work in a new isolated project folder. Do not alter unrelated projects or machine settings.
Deliverables
- Complete runnable source and package lockfile.
- Simple commands to start Agent B and run Agent A.
- A README explaining each file and the request/response path in plain English.
- An integration test that starts the server, discovers its Agent Card, sends the message using the A2A client, and asserts the exact response.
- A negative test showing a clear connection failure when Agent B is unavailable, rather than printing a fake successful response.
Verification
Run the integration test and show the actual output from both processes. State the SDK and protocol versions used. If something cannot be tested, explicitly say so; do not label it passed.

Teaching style
Before coding, briefly explain the two processes and the path the message will take. Then implement this small spike. After it works, explain the key files and what happens at each step. Stop there so I can understand it before we add anything else.


## Avoid these known problems (found while building this step)

- `@a2a-js/sdk` 1.x uses the A2A **v1.0 protobuf-shaped** types, which differ from the v0.3 examples online: parts are `{ content: { $case: 'text' | 'data', value }, mediaType, filename, metadata }`, roles/states are enums (`Role.ROLE_USER`), and the Agent Card uses `supportedInterfaces[{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]`. Read the package's `.d.ts` files for exact shapes.
- The server executor must publish a message or task **first** on every call, or the SDK rejects the exchange.
- **Express 5 passes listen errors (e.g. EADDRINUSE) to the `app.listen` callback.** Check `err` before calling `server.address()`, or the server crashes when a port is taken.
- Mount routes inside the `listen` callback so the Agent Card URL contains the real port. Support `PORT=0` and keep a stable `listening on http://127.0.0.1:<port>` log line that tests can parse.
- Stop servers **by port** (`lsof -ti TCP:<port>`), never with broad `pkill` patterns. A broad pattern once killed the user's other dev servers.

---

## Enhancements merged into this step

- **CLAUDE.md for future sessions** (asked for after Step 1, via `/init`): after the spike works, add a `CLAUDE.md` with the commands, the architecture across files, and the A2A SDK v1.x gotchas (protobuf-shaped parts, enum roles/states, `supportedInterfaces` on the Agent Card). Commit it separately.
