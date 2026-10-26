# A2A Spike: Student Agent ↔ Tutor Agent

A minimal test of whether two agents in separate Node.js processes can talk
using the real **Agent-to-Agent (A2A) protocol**. No LLM, no API keys: the
Tutor's reply is a fixed string.

- SDK: [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) **1.3.0** (pinned exactly)
- Protocol: **A2A v1.0** ([spec](https://a2a-protocol.org/v1.0.0/specification/)), JSON-RPC binding
- Express **5.3.0** (peer dependency of the SDK's server adapter)
- Forms (Part 3): **A2UI v0.9** with the official renderer `@a2ui/lit` **0.14.0** and `@a2ui/web_core` **0.14.0**, plus `lit` **3.3.3**. See [the version choice](#a2ui-version-choice).
- Dev only: `esbuild` 0.28.2 (bundles the renderer for the browser), `jsdom` 30.1.2 (renders the form in tests), `ajv` 8.20.0 (checks payloads against the official A2UI JSON Schemas)
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

Then open **http://127.0.0.1:3000**. `npm run ui` first builds `public/vendor/a2ui.js`, the bundled A2UI renderer; you can also build it on its own with `npm run build:ui`. Use `UI_PORT=...` to change the UI port; `TUTOR_URL` works here too.

In the browser, **Send** runs the Part 1/2 chat exchange. **Request form** runs the Part 3 A2UI form flow.

```bash
npm test   # starts the Tutor (and UI server) as child processes, runs all checks, stops them
```

## Files

| File | What it is |
| --- | --- |
| `src/tutor-agent.js` | **Agent B, the Tutor Agent.** An Express server that serves the Agent Card at `/.well-known/agent-card.json` and the A2A JSON-RPC endpoint at `/a2a/jsonrpc`. Its executor routes each message to one of three handlers: chat (fixed reply), form request (builds the A2UI form), or form submission (validate, de-duplicate, record, acknowledge). It also serves `/viz/events`, a read-only feed of its own events for the monitor. |
| `src/student-agent.js` | **Agent A, the Student Agent.** Three functions: `askTutor()` (chat), `requestForm()` (gets the A2UI form over A2A and checks it against an allowlist) and `submitForm()` (sends the renderer's submit action back over A2A). The UI server and the tests call these directly. |
| `src/student-form.js` | The form definition, in one place: the A2UI v0.9 messages the Tutor builds, the validation rules (run separately by the browser, the UI server and the Tutor), and the allowlist the Student applies to any A2UI payload it receives. It has no dependencies, so the browser loads it too, from `/shared/student-form.js`. |
| `src/local-guard.js` | Host and Origin checks for both servers. They block DNS rebinding and cross-site POSTs to the localhost services. |
| `src/ui-server.js` | **UI backend.** Serves the page and hosts the Student Agent. `POST /api/runs` runs a chat exchange. `POST /api/forms` requests a form, and `POST /api/forms/:formId/submissions` forwards a submission. It relays the Tutor's feed, streams events to the browser on `GET /api/events`, and decides each run's state. |
| `src/browser/a2ui-entry.js` | Entry point for the renderer bundle that esbuild writes to `public/vendor/a2ui.js` (generated, not committed). |
| `public/` | The browser page: `index.html`, `styles.css` and `app.js`. It shows only events the server sent and renders the received A2UI messages with the official renderer. Its own text goes through `textContent`. |
| `test/a2a.test.js` | The original A2A tests: the Agent Card, the exact reply, traceable process ↔ process logs, and a clear failure when the Tutor is down. |
| `test/ui.test.js` | Part 2 browser-event tests: the typed-message round trip, run-ID correlation, the double-submit guard, no resend on reconnect, the unavailable Tutor, and input validation. |
| `test/a2ui-render.test.js` | Gets the form from a real Tutor over A2A and validates it against the official A2UI v0.9 JSON Schemas. Then renders it with the real Lit renderer in jsdom, and checks that the rendering follows the description, that typing sends nothing, that Submit emits a schema-valid action, and that inline errors and locking work. |
| `test/form.test.js` | Part 3 end to end with real processes: the valid round trip with exact values, invalid data refused by the UI server and by the Tutor on its own, unexpected fields and actions, duplicate submissions, reconnect without resubmitting, an unavailable Tutor, uncertain delivery with retry, and the localhost guards. |
| `package.json` / `package-lock.json` | Pinned dependencies and the `tutor` / `student` / `ui` / `build:ui` / `test` scripts. |

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

## Part 3: an A2UI form over A2A

Three protocols or channels are involved, and each has one job:

- **A2A** carries every agent message: the form request, the form, the submission and the acknowledgment.
- **A2UI** describes the interface: which fields, how they bind to data, what the Submit button does. It travels *inside* A2A messages.
- **The browser event stream** (SSE) shows real events and hands the received A2UI description to the browser renderer. Nothing on it goes to the Tutor.

### A2UI version choice

| | Chosen | Why |
| --- | --- | --- |
| A2UI protocol | **v0.9** (`"version": "v0.9"`) | a2ui.org lists v0.9.1 as the current release and v0.9 as the previous stable one. But the newest official renderer (`@a2ui/lit` 0.14.0) registers the **v0.9** basic catalog, and `@a2ui/web_core` 0.14.0 ships **v0.9** JSON Schemas. Using v0.9 means the schema, the catalog and the renderer all match. v1.0 is only a release candidate, and the Lit renderer doesn't support it. |
| Catalog | `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json` | Has everything the form needs: `Column`, `Text`, `TextField` (with the `longText` variant for Notes), `Button`, and the `required`, `regex`, `email`, `length`, `and`/`or`/`not` check functions. |
| A2A extension | `https://a2ui.org/a2a-extension/a2ui/v0.9` | Declared in the Tutor's Agent Card (`capabilities.extensions`, with `supportedCatalogIds`). The Student sends it in the `A2A-Extensions` header and lists `a2uiClientCapabilities` in the message metadata. |
| Renderer | `@a2ui/lit` 0.14.0 (web components) | Official, and works from a plain-JS page. Its bare-name imports (`lit`, `zod` and others) can't load directly in a browser, so esbuild bundles them into one file. That's the only frontend build step. |

**A2A version mismatch.** The A2UI extension spec's examples use A2A v0.3 part shapes (`kind: "data"`, `metadata.mimeType`). This project uses A2A v1.0, where a `Part` has its own `mediaType` field. A2UI parts here set **both** `mediaType` and `metadata.mimeType` to `application/a2ui+json`, and the receiving side accepts either.

### The form flow, hop by hop

```
Browser            UI server / Student Agent                        Tutor Agent
   │ POST /api/forms     │                                                │
   │────────────────────▶│ A2A SendMessage  metadata.request=student-details-form
   │                     │   + a2uiClientCapabilities, A2A-Extensions header ─▶│ builds A2UI form
   │                     │◀─ Task INPUT_REQUIRED, status message = DataPart ───│ (createSurface,
   │◀─ SSE form_received ─│   application/a2ui+json [3 A2UI messages]          │  updateComponents,
   │  (A2UI messages)     │   (checked against an allowlist first)              │  updateDataModel)
   │ renderer draws form; │                                                     │
   │ drafts stay local    │                                                     │
   │ Submit → A2UI action │                                                     │
   │ POST …/submissions ─▶│ validates again; A2A SendMessage taskId=<form task> │
   │  {submissionId,      │   DataPart [{version, action}], metadata.submissionId ▶│ validates on its own,
   │   action}            │◀─ Task COMPLETED, ack (text + JSON) ────────────────│ de-dupes, records
   │◀─ SSE ack_received ──│                                                     │
```

1. **Form requested.** The Student sends an A2A message whose metadata says `request: 'student-details-form'` and lists its A2UI capabilities (v0.9, basic catalog).
2. **Tutor received request.** The Tutor checks that the client supports the basic catalog, then builds three A2UI messages:
   - `createSurface`: the surface ID is the form ID, `sendDataModel: false`
   - `updateComponents`: the four TextFields bound to `/form/firstName`, `/form/lastName`, `/form/email` and `/form/notes`, plus a Submit button whose `action.event` sends those four paths
   - `updateDataModel`: empty values, plus local UI flags
3. **Form sent.** The Tutor creates an A2A **Task** in state `INPUT_REQUIRED`. The task's status message holds a `DataPart` (`application/a2ui+json`) containing the three messages. The task stays open waiting for the student.
4. **Student received form.** The Student checks the payload against an allowlist:
   - only `Column`, `Text`, `TextField` and `Button`
   - only server-event actions (no `openUrl` or other local function calls)
   - only the basic catalog
   - at most 64 KB

   The UI server then hands it to the browser over SSE.
5. **Waiting for student.** The official renderer draws the form from those messages. Typing updates **only the renderer's local data model**, and nothing is sent until Submit. A full page reload re-renders the form from the server's event history, but anything typed and not yet submitted is lost.
6. **Submission sent.** See the mapping below. The UI server checks the same rules again before anything goes over A2A.
7. **Tutor accepted.** The Tutor runs its own checks, records the trimmed values in memory under the `submissionId`, and completes the task. The Tutor panel shows the values exactly as received.
8. **Acknowledgment received.** The completed task's status message carries the acknowledgment: text plus JSON with `ackId`, `submissionId` and `recordedAt`. Only then does the browser mark the form as submitted.

### From the renderer's submit event to the A2A message

The protocols don't connect to each other on their own. The mapping is explicit code:

| Step | Where | What |
| --- | --- | --- |
| Renderer emits an `action` | `MessageProcessor` callback in `public/app.js` | `{name: "submitStudentDetails", surfaceId, sourceComponentId: "submit_button", timestamp, context: {firstName, lastName, email, notes}}`. The four values come from the Button's `action.event.context` path bindings. |
| Browser gate | `onFormAction` | Sets `/ui/submitAttempted = true`, so the renderer shows its inline errors. Runs `validateSubmission()`. If anything fails, it stops: **nothing is sent**. Otherwise it creates a `submissionId`, sets `/ui/submitLocked = true` (the form's Button check then disables Submit), and POSTs `{submissionId, action}`. |
| UI server gate | `POST /api/forms/:formId/submissions` | Accepts only the expected body and action keys, the known action name, matching surface and button IDs, and valid values. Refuses a second submit while one is pending. |
| A2A message | `submitForm()` | Builds a user `Message` whose `DataPart` (`application/a2ui+json`) contains `[{version: "v0.9", action}]`, a v0.9 client-to-server message. `metadata` carries `{submissionId, formId, runId}`. If `GetTask` shows the form task is still `INPUT_REQUIRED`, the message **resumes it** (`taskId`). If the task has completed, the message **doesn't resume it**, because resuming a completed task is illegal. Instead it uses the same `contextId` with `referenceTaskIds: [formTaskId]`. |
| Tutor | `handleSubmission()` | Accepts only the known action, the four fields and the length limits, and rejects a blank or whitespace-only name. Its email check only tests the format; it doesn't prove the address exists. The message must belong to the form's task and conversation. **Invalid:** the task stays `INPUT_REQUIRED` and the errors are returned. **Repeated `submissionId`:** the stored acknowledgment is returned and nothing is recorded. **Same `submissionId` with different content:** rejected. |

### Delivery outcomes

| What happened | Shown as | Draft |
| --- | --- | --- |
| Connection refused, or the failure happened before the submission message was sent | **Not delivered**, with the real reason | Kept; Submit is enabled again |
| `sendMessage` timed out (`SUBMIT_TIMEOUT_MS`, default 5 s) | **Delivery uncertain**: the Tutor may or may not have it. No automatic retry. A **Retry submission** button resends the *same* `submissionId`, so it's recorded at most once. | Kept; Submit stays locked |
| The Tutor rejected the values | **Rejected**, with the Tutor's field errors | Kept; the same task is still open |
| The Tutor accepted | **Submitted**, after the acknowledgment arrives | Locked |

**Records are kept in memory.** The Tutor's form and submission records, the A2A task store, and the UI server's event history are all in memory, so **restarting a process clears them**. If the Tutor restarts while a form is open, submitting fails with *not delivered: the Tutor Agent no longer knows this form*. Request a new form after a restart.

Test hooks, off unless set: `TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS` makes the Tutor process its first submission slowly, and `SUBMIT_TIMEOUT_MS` shortens the Student's timeout. The tests use them to create a real uncertain delivery.

### Known limitations

- **Renderer accessibility:** the official TextField draws a `<label>` that isn't linked to its input, so screen readers announce the fields without names.
- **Markdown off:** the renderer's `Text` component would render Markdown if `@a2ui/markdown-it` were installed. It isn't, so text shows as plain text and the console logs one warning about it. This also means no Markdown in a payload ever becomes HTML.
- **Custom regex checks:** a regex in an A2UI check that the renderer's ReDoS detector considers unsafe is reported as a failing check. That's why the form uses the catalog's built-in `email` function for the email check.
- **`npm audit`** reports a high-severity zod advisory (memory exhaustion when validating oversized collections). `@a2ui/web_core` and `@a2ui/lit` depend on the affected zod 3.x, and there's no fixed version of them yet. Exposure here is limited: zod runs only in the browser renderer, its only input is the A2UI payload from the local Tutor, and the Student rejects any payload over 64 KB before it reaches the browser. The Node servers don't use zod.

## Deliberately not included

Streaming, push notifications, a reverse server, continuous chat, auth, routing, a Hub, mailboxes, a database, actually sending email, and deployment. Each chat click is one A2A request and one response. Each form is one task: request, then submit.
