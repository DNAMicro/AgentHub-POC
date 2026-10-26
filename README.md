# A2A Spike: Student Agent ↔ University Hub ↔ Tutor Agent & Library Agent

A localhost spike built in parts:

1. Two agents, each in its own Node.js process, talk over the real **Agent-to-Agent (A2A) protocol**.
2. A browser monitor shows each exchange as it happens.
3. The Tutor sends an **A2UI** form, which the student fills in and submits.
4. The Tutor can answer with **Claude Haiku 5.5**.
5. Questions are **routed** to the Tutor Agent (calculus by default; its subjects are configurable) or the Library Agent based on their advertised skills. Each service **enforces** its own scope, and editing a service's skills **notifies** the router, which updates its routing.
6. The agents send **forms when asked in chat** (in-person tutoring requests, group study-room bookings).
7. A **University Hub** (“California State University Fullerton”, fictional local demo) sits between the Student and the specialists: the Student talks only to the Hub, which keeps a private registry, routes, forwards and relays over A2A. A **live topology** view animates the real traffic. See [Part 7](#part-7-the-university-hub-and-the-live-topology).

- SDK: [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) **1.3.0** (pinned exactly)
- Protocol: **A2A v1.0** ([spec](https://a2a-protocol.org/v1.0.0/specification/)), JSON-RPC binding
- Express **5.3.0** (peer dependency of the SDK's server adapter)
- Tutoring (Part 4): **Claude Haiku 5.5** (`claude-haiku-5-5`) via `@anthropic-ai/sdk` **1.3.0**, in live mode only. See [Part 4](#part-4-real-tutoring-answers-from-claude-haiku-55).
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

### Browser monitor: all four agents (Part 7)

```bash
npm run demo:live     # all four processes, Hub router + Tutor + Library on Claude Haiku 5.5 (paid; key from env or .env)
npm run demo          # the same with mock models and the mock router (no network, no cost)
```

`demo` runs `scripts/start-all.js`, which starts the four processes and prefixes their output; Ctrl+C stops them all (each specialist signs out from the Hub). To run them separately instead:

```bash
npm run hub:live      # University Hub on 127.0.0.1:41243 (live router; or hub = mock router, hub:direct = everything to tutoring)
npm run tutor:live    # Tutor Agent on 127.0.0.1:41241 (or tutor:mock / tutor) — registers with the Hub
npm run library:live  # Library Agent on 127.0.0.1:41242 (or library = mock) — registers with the Hub
npm run ui            # UI + Student Agent on 127.0.0.1:3000 — connects only to the Hub
```

Then open **http://127.0.0.1:3000**. Start order doesn't matter: specialists keep retrying registration, and the Student re-reads the Hub's card when the Hub appears.

**Build step.** `ui` and `demo` first build `public/vendor/a2ui.js`, the bundled A2UI renderer; `npm run build:ui` builds it on its own.

**Configuration.** Each agent reads an optional JSON file named by `STUDENT_CONFIG`, `HUB_CONFIG`, `TUTOR_CONFIG` or `LIBRARY_CONFIG` over built-in localhost defaults; examples are in `config/*.example.json`. Configuration is validated at startup and a bad file stops the process with a clear message. Secrets never go in these files: the Hub's model key is named by `model.apiKeyEnv`.

**Environment variables** (single-value overrides, mainly for tests):

| Variable | Changes |
| --- | --- |
| `UI_PORT`, `PORT` | The UI's port; an agent's port |
| `HUB_URL` | Where the Student and the specialists find the Hub |
| `TUTOR_URL`, `LIBRARY_URL` | The Hub's trusted endpoint for each specialist |
| `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_EXPIRY_MS` | Specialist heartbeat period; how long the Hub waits before marking one stale |
| `SPECIALIST_ENABLED=0` | Register a specialist as disabled (no requests are routed to it) |
| `HUB_TELEMETRY_SHOW_CONTENT=1` | Stop redacting message text and form values in the Hub's telemetry (off by default) |
| `ROUTER_MODE` | The Hub's router: `direct`, `mock` or `live` |
| `STUDENT_MODE` | The Student's own model: `off` (default), `mock` or `live`. It clarifies unclear questions and picks the capability for non-obvious ones (`demo` uses mock, `demo:live` live) |
| `STUDENT_MODEL`, `HUB_MODEL`, `TUTOR_MODEL`, `LIBRARY_MODEL` | Each agent's own model (overrides `model.name` in its config file). Supported: `claude-haiku-5-5` (default), `claude-sonnet-5-5`, `claude-opus-5-5`; anything else stops that agent at startup. Example: `TUTOR_MODEL=claude-sonnet-5-5 npm run demo:live` |

In the browser, the **Conversation** tab is your chat with the university; **Agent activity** shows one console per agent; **Topology** is the live graph. **Send** asks a question, which the Hub routes to one service or none. There is no form button: ask for something in plain words — “I’d like to arrange in-person help with calculus” or “I want to reserve a group study room” — and the receiving agent sends its form (Part 6). The ⚙ button on the Tutor and Library consoles opens their skill settings (proxied through the Hub's developer endpoint), and **Refresh skills** makes the Hub re-fetch both cards.

```bash
npm test   # starts the Tutor (and UI server) as child processes, runs all checks, stops them
```

## Files

| File | What it is |
| --- | --- |
| `src/tutor-agent.js` | **Agent B, the Tutor Agent.** An Express server that serves the Agent Card at `/.well-known/agent-card.json` and the A2A JSON-RPC endpoint at `/a2a/jsonrpc`. Its executor routes each message to one of three handlers: chat (fixed reply), form request (builds the A2UI form), or form submission (validate, de-duplicate, record, acknowledge). It also serves `/viz/events`, a read-only feed of its own events for the monitor. |
| `src/student-agent.js` | **Agent A, the Student Agent.** Three functions: `askTutor()` (chat), `requestForm()` (gets the A2UI form over A2A and checks it against an allowlist) and `submitForm()` (sends the renderer's submit action back over A2A). The UI server and the tests call these directly. |
| `src/forms.js` | Part 6: the two registered workflow forms in one place — their A2UI v0.9 templates and updates (slot options, review screen, `deleteSurface`), the validation rules (run separately by the browser, the UI server and the issuing agent), each workflow's allowlisted actions, the demo timezone/hours/rooms, and the allowlist the Student applies to every A2UI payload or update it receives. No dependencies, so the browser loads it too, from `/shared/forms.js`. |
| `src/form-intent.js` | Part 6: deterministic workflow heuristics (fixed/mock modes) and the prefill parser — prefill always comes from the student's own words, never from a model. |
| `src/form-host.js` | Part 6: the issuing side shared by Tutor and Library — sends a form as an A2A task, then accepts only that workflow's actions: correlation, form version, current skill check, operation-ID dedupe, then the agent's allowlisted handler. |
| `src/demo-store.js` | Part 6: in-memory demo records — tutoring requests, and the fictional room schedule with an atomic check-and-reserve. |
| `public/forms-ui.js` | Part 6: forms in the Student view — renders, removes on submit (`deleteSurface`), shows pending/receipt/recovery states, refreshes room availability, rebuilds the current state after a replay. |
| `src/tutor-model.js` | The Tutor's tutoring logic. Part 4 added the mode switch, system prompt, per-conversation history, request ledger and one-at-a-time rule. Part 5 added the scope layers: policy check, scope check, scope-bounded instructions, answer check and release check. |
| `src/llm.js` | Anthropic access for each model-using process: that agent's own model and key variable (`useModel`, set from its config at startup), explicit key, no retries, `effort: low`, optional JSON-schema structured output, and the mapping from SDK errors to sanitized codes. |
| `src/student-assistant.js` | The Student's own model step. Obvious questions (the words match exactly one of the Hub's public capabilities) go on as-is and the Hub routes them. For the rest, the Student's model either names a capability (tutoring / library) for the Hub to use, or asks you one clarifying question first and sends your question and answer together. |
| `src/models.js` | The models an agent may choose (each accepts exactly what `llm.js` sends) with their official prices; no dependencies, so the config loader validates names without the SDK. |
| `src/skills.js` | Part 5: the single skill configuration, its validation, and everything derived from it. That's the Agent Card skills, the documented scope extension and the runtime policy. |
| `src/agent-settings.js` | Part 5: one agent's skill settings. Holds the live configuration (swapped atomically on save), the local settings API (read, preview, save) and the `agent_card_changed` A2A notification (Part 7: sent to the Hub). |
| `src/library-agent.js`, `src/library-model.js`, `src/library-fixture.js` | Part 5: the **Library Agent**. Answers only from the saved **answer content** of its enabled skills (defaults are fictional sample data in the fixture). `LIBRARY_MODE=mock` (default) extracts the matching lines; `live` asks Haiku 5.5 and releases the answer only if its quoted evidence is found in that content. It performs no transactions. |
| `src/router.js` | Part 5: the routing decision, run by the Hub since Part 7. Live mode uses Haiku with structured output, mock mode a labelled heuristic, and code validates every decision against the registry. |
| `src/hub-agent.js` | Part 7: the **University Hub** — public card, control messages, routing, forwarding, form references, operation dedupe, telemetry relay (redacted) and the developer settings proxy. |
| `src/hub-registry.js` | Part 7: the Hub's **private registry** — allowlisted specialists, registration and takeover checks, heartbeats and expiry, card fetch/validation from the configured URL, separate readiness states. |
| `src/hub-link.js` | Part 7: a specialist's side of the Hub connection — register, heartbeat, sign out, card-change notice. |
| `src/cards.js` | Agent Card fetching (`node:http`, conditional, size-capped) and validation, used for specialist cards and the Hub's public card. |
| `src/config.js`, `config/*.example.json` | Part 7: per-agent configuration with startup validation. |
| `src/topology.js` | Part 7: labels each telemetry event with its connection, direction, category and phase for the topology view. |
| `public/topology.js` | Part 7: the live topology graph (SVG), traces, details, event list. |
| `scripts/start-all.js` | Part 7: starts all four processes (`npm run demo` / `demo:live`). |
| `scripts/live-eval.js` | Part 5's opt-in live spot check of routing and scope decisions. Paid; off unless `LIVE_EVAL_MAX_USD` is set. |
| `scripts/live-smoke.js` | The paid live smoke test, off unless `LIVE_SMOKE_MAX_USD` is set. |
| `.env.example` | Placeholder for your local `.env` (git-ignored). |
| `src/local-guard.js` | Host and Origin checks for both servers. They block DNS rebinding and cross-site POSTs to the localhost services. |
| `src/ui-server.js` | **UI backend.** Serves the page and hosts the Student Agent, which connects only to the Hub. Its routes: `POST /api/runs` (a chat to the Hub), `POST /api/forms/:id/actions`, `…/edit` and `…/reconcile` (to the Hub with the form reference; there is no route that creates a form), `GET`/`PUT /api/agents/:id/skills` (through the Hub's developer proxy) and `POST /api/registry/refresh`. It relays the Hub's telemetry, labels it for the topology, and decides each run's state. |
| `src/browser/a2ui-entry.js` | Entry point for the renderer bundle that esbuild writes to `public/vendor/a2ui.js` (generated, not committed). |
| `public/` | The browser page: `index.html`, `styles.css` and `app.js`. It shows only events the server sent and renders the received A2UI messages with the official renderer. Its own text goes through `textContent`. |
| `test/a2a.test.js` | The original A2A tests: the Agent Card, the exact reply, traceable process ↔ process logs, and a clear failure when the Tutor is down. |
| `test/ui.test.js` | Part 2 browser-event tests: the typed-message round trip, run-ID correlation, the double-submit guard, no resend on reconnect, the unavailable Tutor, and input validation. |
| `test/a2ui-render.test.js` | Gets both forms from real agents by chatting (and a real availability update), validates them against the official A2UI v0.9 JSON Schemas with format checks, renders them with the real Lit renderer in jsdom, and checks that rendering follows the description, typing sends nothing, Send emits a schema-valid action, the slot update applies in place, and `deleteSurface` unmounts the form. |
| `test/tutor-llm.test.js` | Part 4: the live SDK path against a local fake Anthropic API, plus mock mode. No paid calls. |
| `test/payload-policy.test.js` | The Student's allowlist for received A2UI payloads and updates, plus the shared validators (dates, weekdays, period/time, capacity, slot IDs) and action checks. |
| `test/skills.test.js` | Part 5 unit tests: skill validation, a single source for the card and policy, Library capability limits, router decision validation and trusted card validation. |
| `test/routing.test.js` | Part 5 routing with real processes: every example's **actual A2A destination**, no calls for clarify or unsupported, malicious choices failing closed, separate contexts per service, follow-ups, reconnects, an offline service, router errors, and the mock heuristic. |
| `test/scope.test.js` | Part 5 scope enforcement through **direct** A2A calls: physics, plumbing, mixed and override requests; topic switches; disabled skills; changes mid-request; the live check, answer and answer-check structure; the Library answering only from saved content (mock line extraction, live evidence check); and forms staying with their agent. |
| `test/card-refresh.test.js` | Part 5 reverse path: the settings API, save → ETag → A2A notification → re-fetch → routing change, duplicate and late notices, spoofed senders and notice URLs, an offline Student, and failed refresh with recovery. |
| `test/form.test.js` | Parts 3 + 6, tutoring workflow end to end: no form shortcut; natural language decides; removal → pending → receipt; invalid input sends nothing; the Tutor's own checks (forged/stale/uncorrelated); duplicates; one form per conversation and explicit replacement; replay never resurrects; cancel; disabled workflow; Edit and retry; confirmation pending + reconcile; privacy; localhost guards. |
| `test/booking.test.js` | Part 6, study-room workflow: routing to the Library, fixture-only availability with scheduling fields only, criteria changes, required review, forged/stale/mismatched slots, receipts, a concurrent double-booking race, and actions always going to the issuing agent. |
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

> **Since Part 6** there is no Request form button and no `POST /api/forms`: a form appears only when an agent decides to send one in reply to a chat message, and the student-details form was replaced by the tutoring-request form. The A2UI mechanics below (version choice, action mapping, delivery outcomes) still apply; see Part 6 for how a form starts and ends now.

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
4. **Student received form.** The Student checks the whole payload against an allowlist:
   - exactly one `createSurface`, sent first, and every message must target that same surface
   - only the basic catalog
   - only `Column`, `Text`, `TextField` and `Button`
   - only these functions, wherever they appear (checks, bound values, action contexts): `required`, `regex`, `length`, `email`, `and`, `or`, `not`
   - no `functionCall` anywhere, and every `action` must be exactly `{event}`, so no `openUrl` and no other local calls
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

## Part 4: real tutoring answers from Claude Haiku 5.5

The Tutor Agent can now answer chat questions with **Anthropic Claude Haiku 5.5** (`claude-haiku-5-5`), called through the official SDK `@anthropic-ai/sdk` **1.3.0** (pinned). That SDK line defaults to API version `2026-10-21`. Only the Tutor calls the model. The Student is still a deterministic A2A client, and forms are still checked by deterministic code (no model involved).

### Modes

| `TUTOR_MODE` | Start with | What answers chat | Network |
| --- | --- | --- | --- |
| `fixed` (default) | `npm run tutor` | The Part 1 fixed reply | none |
| `mock` | `npm run tutor:mock` | A deterministic fake model that repeats your question and the earlier one, to show history working | none |
| `live` | `npm run tutor:live` | Claude Haiku 5.5 | Anthropic API |

The browser header shows the active mode. In live mode, a notice under the chat box says what is sent to Anthropic.

### Your API key (you do this yourself, locally)

Never paste the key into a chat, an issue or source code. Only the Tutor process reads it.

1. Create your local env file and add the key in a text editor:
   ```bash
   cp .env.example .env
   # edit .env: ANTHROPIC_API_KEY=<your key>
   ```
   `.env` and `.temp` are git-ignored. If you already keep the key in another file, in the same `ANTHROPIC_API_KEY=...` format, point to it instead: `TUTOR_ENV_FILE=.temp npm run tutor:live`. An `ANTHROPIC_API_KEY` already exported in your shell takes precedence over the file.
2. Start it:
   ```bash
   npm run tutor:live     # terminal 1 — logs "API key: configured" or "NOT SET" (never the value)
   npm run ui             # terminal 2 → http://127.0.0.1:3000
   ```

The key is read only from the Tutor's environment. It is passed explicitly to the SDK, which then ignores any other credential source. It is never written into A2A messages, browser events, logs or error messages, and the tests check this (see below).

### Where A2A ends and the Anthropic call begins

```
Browser ─POST─▶ UI server / Student ══A2A SendMessage══▶ Tutor A2A executor ─HTTPS─▶ api.anthropic.com
                                     (contextId, messageId)      │   messages.create(claude-haiku-5-5)
Browser ◀─SSE── UI server / Student ◀═A2A reply (Message)═══ Tutor ◀─ complete response (no streaming)
```

1. You type a question. The browser POSTs it to the UI server, together with the current conversation ID.
2. The Student sends it to the Tutor as an A2A `SendMessage`. The conversation ID travels as the A2A `contextId`, and a fresh `messageId` serves as the request ID. **This is where A2A ends.**
3. The Tutor's executor looks up that conversation's earlier messages and calls `client.messages.create`. The call uses the server-side system prompt, at most the last 10 messages (12,000 characters) of history plus the new question, `max_tokens: 800`, `effort: "low"`, a 45 s timeout and no retries. **This is the Anthropic call.** It's ordinary HTTPS from the Tutor process and has nothing to do with A2A.
4. Haiku returns the complete response. The Tutor checks `stop_reason`: a refusal, or an output cap used up before any answer text, becomes a clear error instead of an answer.
5. The Tutor puts the text into an A2A reply `Message`. Its metadata holds the model name, latency, token usage and Anthropic's request ID. Or, on failure, a sanitized `tutorError` with a code and a message.
6. The Student receives it, and the browser shows the actual response along with the model and usage details.

The timeline shows real milestones: request sent → Tutor received → model call started → model response received → response sent → A2A response received. A failure shows up as a "Model error" with its code.

### What is, and isn't, sent to Anthropic

- **Sent:** the system prompt, your chat questions, and that conversation's earlier questions and answers.
- **Not sent:** form names, emails, notes, other conversations, or anything from another student's history.
- History is kept **in memory**, per conversation ID, so **restarting the Tutor clears it**. Click **New conversation** to start fresh.
- The system prompt tells the model to treat student messages and form notes as untrusted content, not as instructions.

### Cost and failure controls

- **Limits:** 800 output tokens per answer, 2,000-character questions, and bounded history.
- **One question at a time per conversation.** A second question while one is in progress gets a "busy" error and costs nothing.
- **No duplicate paid calls.** If the same `(contextId, messageId)` arrives again, from a retry or a race, the Tutor returns the stored or in-flight result. If the Student times out (`CHAT_TIMEOUT_MS`, default 60 s), the run becomes **uncertain**. **Check for answer** resends the *same* request ID, which collects the result without calling the model again. Reloading the page only replays events.
- **No hidden retries or fallbacks.** SDK retries are off (`maxRetries: 0`), there's no other model, and no canned answer stands in for a failure.
- **Sanitized errors:**

  | Code | When |
  | --- | --- |
  | `missing_credentials` | no key set; no request is attempted |
  | `authentication_failed` | 401 |
  | `permission_denied` | 403 |
  | `model_unavailable` | 404; no other model is substituted |
  | `rate_limited` | 429 |
  | `provider_unavailable` | 5xx or 529 |
  | `timeout` | the model call timed out |
  | `connection_failed` | couldn't reach Anthropic |
  | `refusal` | the model declined |
  | `truncated_no_text` | the output cap was used up before any answer text |

  Anthropic's request ID is shown when there is one. Raw provider messages are never passed on.
- **Logs:** model, latency, token counts, stop reason and request ID. Message contents stay out of logs in live mode, and the UI server never logs them. Fixed and mock modes still log content because the earlier tests read it. `TUTOR_LOG_CONTENT=0|1` overrides this.

### Tests (no paid calls)

`test/tutor-llm.test.js` runs a **live-mode Tutor against a local fake Anthropic Messages API** (`ANTHROPIC_BASE_URL`) with a placeholder key, plus a mock-mode Tutor. It covers:

- the exact request (model, cap, effort, system prompt, no sampling parameters, key only in the auth header)
- contextual follow-up, and isolation between conversations
- usage reporting, and logs without message contents
- every error code above, each with exactly one provider call
- the missing key (no call at all)
- duplicate, concurrent and busy requests
- uncertain-outcome reconciliation and reconnects
- mock mode
- Part 3 in live mode, with no form value reaching the model
- **the key never appearing** in frontend assets, browser events, `/api/status`, the Agent Card, or either server's logs

### Live smoke test (paid, off by default)

```bash
npm run smoke:live                          # prints the plan and pricing, then stops
LIVE_SMOKE_MAX_USD=0.01 npm run smoke:live  # runs, within your limit
```

It checks that `claude-haiku-5-5` is available to your account. That check uses the Models API, which isn't a billed generation, and the script stops if the model isn't available. It then asks one short calculus question and one follow-up in the same conversation, through the real Student → A2A → Tutor → Anthropic path, and prints both answers with token usage, latency, request IDs and estimated cost. Pricing comes from the [official pricing page](https://platform.claude.com/docs/en/about-claude/pricing), checked 2026-10-25: $0.10/MTok input and $0.50/MTok output for prompts up to 100K tokens. The worst case, estimated pessimistically, is about $0.0023 for both calls.

## Part 5: routing, editable skills, card-change notifications, scope enforcement

> **Part 7 moved three things out of the Student into the University Hub:** the router, the trusted registry, and the endpoint that receives `agent_card_changed` notices. The mechanics below are unchanged; read “Student” as “Hub” for them. The router modes are now set on the Hub (`npm run hub`, `hub:live`, `hub:direct`).

```
Browser ─▶ UI server :3000 ── hosts ──▶ Student Agent (router + trusted registry)
                                         ├── A2A client ══▶ Tutor Agent    :41241 (scope-checked; mock/live model)
                                         ├── A2A client ══▶ Library Agent  :41242 (answers from saved skill content)
                                         └── A2A server :41240 ◀══ agent_card_changed notices from Tutor / Library
```

### Routing is the application; A2A is the transport

A2A provides discovery (Agent Cards) and messaging. **It doesn't route by skill and doesn't enforce topic boundaries.** This project does both, in code:

1. **Trusted registry** (`src/student-registry.js`)
   - The Student only knows two agents: `tutor` and `library`. For each, a fixed allowlist holds the expected card name, card URL and JSON-RPC URL.
   - It fetches each card from the **registered** URL and keeps it only if the name, the single JSON-RPC 1.0 endpoint, and the (empty) security settings all match. A card that changes any of these is rejected, and the last good card is kept.
   - Outbound A2A always uses the validated card from the registry.
2. **Routing decision** (`src/router.js`)
   - The model sees only skill descriptions, as data: no URLs, ever.
   - It returns a JSON-schema decision:
     - `route`: an agent ID, a skill ID and a short reason;
     - `clarify`: a focused question;
     - `unsupported`: no connected service fits.
   - Code accepts `route` only if that agent and skill are registered and enabled right now. Anything else becomes "unsupported", and **nothing is sent**.
   - There's no fan-out or broadcast. If the chosen service is offline, that's reported and the question is not redirected to another service.
3. **Context**
   - Each student conversation keeps a **separate A2A `contextId` per service**, so the Tutor and the Library never share a context or task.
   - The router sees only the last few turns of *that* conversation, for follow-ups like "another example".
   - Only the question itself is sent to a service. No tutoring history or form details go to the Library.
4. **Forms**
   - Submissions always go to the agent that issued the form, the Tutor, using its recorded form, task and context IDs.
   - They're never routed by their Notes, and they're checked against the Tutor's *current* policy. If the form skill was disabled in the meantime, the submission gets a clear "no longer supported" error.

| Router mode | Command | What decides |
| --- | --- | --- |
| `mock` | `npm run ui` | A keyword heuristic over the registry's current skill tags. Labelled as such; it says nothing about real accuracy. |
| `live` | `npm run ui:live` | Claude Haiku 5.5 with structured output. About 1 paid call per question. |
| `direct` | `npm run ui:direct` | No routing: everything goes to the Tutor (Parts 2–4 behaviour). |

### Advertised skills vs. actual capability and permission

**One skill configuration per agent** (`src/skills.js`, held by `src/agent-settings.js` on that agent's own server) is the source for three things:

- **The Agent Card:** the standard `AgentSkill` fields (id, name, description, tags, examples).
- **Routing metadata:** the Student reads it from that card. Scope boundaries aren't standard A2A fields, so they travel in a documented, non-required extension, `urn:a2a-spike:skill-scope:v1` (under `capabilities.extensions`), along with the configuration's **revision**.
- **The runtime policy** the agent enforces.

Each skill also has **answer content** — a text box in the dialog holding the facts that skill answers from. It is private: it goes into the runtime policy, never onto the Agent Card.

| Agent | Answer content | Built-in |
| --- | --- | --- |
| Library | **Required** for enabled skills. The Library answers *only* from it, replying with just the relevant part (asking "hours on Mondays?" returns the Monday line, not the whole week). | — |
| Tutor | Optional reference notes added to the model's instructions; the Tutor also uses its own subject knowledge within the skill's scope. | `student-details-form` (the Part 3 A2UI form, handled by code; can be renamed or disabled, not duplicated) |

So you can add any number of skills — e.g. a "Study rooms" skill with its rules pasted in — and the agent can answer from them straight away. Saving an enabled Library skill with empty answer content is rejected: the agent would have nothing to answer from.

Editing a description or scope changes what's **declared and permitted**, not what's **proven**. The settings dialog and panels say whether a configuration "matches the tested default" or is "changed since tests — not verified".

**The gear dialog** (⚙) is a **local developer control**. It edits skills only: not identity, endpoints, credentials, security or protocol capabilities. It shows identity, every skill field, allowed scope and exclusions, Save, Cancel, field-level errors and a live **card preview**. A save carries the revision it started from, so a stale editor gets a 409 instead of overwriting newer changes.

### The reverse path: card-change notifications

On **Save**, the agent does these steps in order:

1. **Validate and swap atomically.** The configuration, runtime policy and served card change together.
2. **New card validator.** The card's content-hash **`ETag`** changes; the SDK serves it with `Cache-Control: no-cache`. The scope extension's `revision` goes up. This is a card-content revision, unrelated to the A2A protocol version (`1.0`).
3. **Notify.** The agent sends an **`agent_card_changed`** notification to the Student's A2A endpoint (`STUDENT_A2A_URL`, default `http://127.0.0.1:41240`) using a real A2A client.
   - It's a `DataPart` of type `application/vnd.a2a-spike.agent-card-changed+json`.
   - **This is our application convention carried by A2A, not a built-in A2A broadcast.**
   - It's one attempt with a 3 s timeout. If the Student is offline, the outcome is reported as **pending**; there's no retry loop.
4. **The Student handles it in code** (`src/student-endpoint.js`). No model sees it, and anything that isn't this notification type is rejected.
   - It checks the claimed `agentId` is in the registry.
   - It ignores **duplicate notice IDs**.
   - It **ignores** any URL or other unexpected field in the notice.
   - It then **re-fetches the card from the registered URL**, conditionally with `If-None-Match`, and coalesces overlapping refreshes. A late or out-of-order notice therefore always gets the *current* card (a 304 if nothing changed), never the notice's contents.
5. **Validate and replace.** The Student validates the card and replaces the registry entry atomically. New routing decisions use the new skills straight away.

The browser shows three separate outcomes, each from a real event: **configuration saved** (the agent), **notification delivered, pending or rejected** (the agent, from the Student's A2A acknowledgment), and **Student routing updated** (the Student's registry). The card revision, both sides' ETags and the last successful refresh are in each panel's expandable *Card details*.

**Recovery and reliability**

- The Student refreshes every registered card **at startup** and **whenever an agent's feed reconnects**, for example after an agent restart.
- **Refresh skills** in the Student panel refreshes manually.
- A failed refresh keeps the last good card, marks it **stale** with the error, and never invents skills.
- Agents also send a notice when they start.
- None of this makes model calls.

**Implementation note.** Node's `fetch` adds `Cache-Control: no-cache` to every conditional request, which makes Express ignore `If-None-Match`. So cards are fetched with `node:http`, which also caps their size and never follows redirects.

**Who sent a notification? (localhost limits).** The `agentId` in a notice is a **claim, not authentication**: any local process can send one. The design limits the damage to a harmless, deduplicated re-fetch of a card that's already registered. A notice can't add an agent, change an endpoint, deliver skills or grant permissions. Real deployments would need authenticated peers, such as mTLS or signed cards, which this spike doesn't provide or claim.

### Scope enforcement on the receiving services

Each service checks **its own current policy** on every request, including **direct A2A calls that bypass the router**. A stale Student registry therefore can't reach a removed skill.

**Tutor Agent** (`src/tutor-model.js`, calculus by default):

1. **Code:** if no tutoring skill is enabled, it declines and makes no model call. If the form skill is disabled, it refuses form requests and submissions.
2. **Scope check** before answering: Haiku, with structured output, classifies the request against the saved skills, allowed scope and exclusions. It returns `in_scope`, `out_of_scope` or `needs_clarification`.
   - **Out of scope** gets a short, server-written reply listing what the Tutor offers.
   - **Unclear or mixed** requests (for example "differentiate this and explain the mechanics") get a focused question, not an answer.
   - The earlier conversation can explain "another example", but **never authorizes a new topic**.
   - Requests to override the rules ("ignore your rules…") change nothing.
3. **The answer instructions** contain the same current scope.
4. **Answer check:** one structured check of the draft. If it materially strays outside scope, the draft is withheld and a safe scope reply is sent. There's no regeneration loop.
5. **Release check:** if the skills changed while the answer was being generated, it isn't released.

How "calculus" is bounded: limits, derivatives, integrals, calculus exercises, and the **algebra steps needed inside a calculus explanation** are in scope. Standalone physics (Newton's laws, mechanics, circuits), standalone non-calculus math, home repair or plumbing, and library services are out.

**Library Agent:** answers come only from the saved answer content of enabled skills.
- *Mock* (default): picks the best-matching skill by name/tags/description and returns the lines of its content that mention the question's specific words (e.g. "Monday"); a tie asks which one you mean. No calculation (it won't work out a due date).
- *Live*: one structured Haiku call returns `{verdict, skill_id, answer, evidence[]}`. Code releases the answer only if `skill_id` is an enabled skill and **every evidence line appears verbatim in that skill's content**; otherwise it's withheld. "Not covered" gets a fixed server reply instead of the model's guess. This catches invented facts, but the model's wording around verified lines (e.g. a computed due date) is still model output.
- It never claims a renewal or any other transaction.

**Limitations, honestly.**

- **Different strengths of guarantee.** Code-level checks (the Library evidence check, actions, schemas, enabled skills, the release check) are deterministic. The topic judgments (the scope check, answer check and router) come from a model and are **probabilistic**: they reduce off-topic answers but don't guarantee there are none.
- **Mock and test results.** The mock heuristic and the scripted fake-API tests prove the plumbing and the order of the layers, not the model's accuracy.
- **Live spot check.** `npm run eval:live` runs the routing examples and scope cases against real Haiku and reports mismatches. A few examples aren't a measurement.
- **Cost.** Live mode costs up to 3 model calls per in-scope answer (check, answer, answer check), plus 1 for routing in `ui:live`. Each has a 400–800-token output cap.

### Mock vs. live testing

| | Command | Paid? | What it shows |
| --- | --- | --- | --- |
| Automated tests | `npm test` | No | The real SDK paths against a local fake Anthropic API plus mock modes. Deterministic. |
| Live smoke (Part 4) | `LIVE_SMOKE_MAX_USD=… npm run smoke:live` | Yes, about $0.0023 worst case | Tutoring through A2A with a follow-up. |
| Live eval (Part 5) | `LIVE_EVAL_MAX_USD=… npm run eval:live` | Yes, about $0.0105 worst case for ~15 calls | Real router decisions and Tutor scope decisions, each compared with what we expected. |

### State and restarts (all in memory)

| Restarted | Lost |
| --- | --- |
| Tutor | Its skill edits (back to the defaults at revision 1), tutoring history, forms, tutoring requests, operation dedupe records, A2A tasks |
| Library | Its skill edits, forms, demo bookings (the fixture schedule comes back), operation dedupe records |
| UI server / Student | The registry (rebuilt by the startup refresh), routing context per conversation, event history |

Agents send a notice when they start, and the Student refreshes at startup and on feed reconnects, so the views converge again after any restart.

## Part 6: forms the agents decide to send

There's no form button. The student just asks, and the **receiving agent** decides.

### Intent → form → submission → handler → receipt

```
Student types "Can I meet a tutor about derivatives tomorrow afternoon?"
  → Student router picks a service (Part 5) ─ A2A ─▶ Tutor
       Tutor decides: answer | clarify | offer_tutoring_request_form | out_of_scope
         (live: one structured Haiku call; fixed/mock: a labelled heuristic)
       code checks: workflow is this agent's and enabled? client supports A2UI v0.9?
                    a form already open in this conversation? (then ask: continue or replace)
       prefill parsed from the student's words: date, afternoon  (never names, emails, notes)
  ◀─ A2A: Task INPUT_REQUIRED carrying the registered A2UI template
Browser renders it; drafts stay local.
Student presses "Send tutoring request"
  → browser validates; invalid → errors shown, nothing sent
  → valid → snapshot kept, form removed at once (deleteSurface), "Sending request…" shown
  ─ A2A (resumes the form's task, with an operation ID) ─▶ Tutor
       form host: correlated? current version? workflow still enabled? allowlisted action/button/fields?
                  operation ID seen? → return the stored result, run nothing
       validate → createTutoringRequest (allowlisted handler, once) → stored "Received — awaiting scheduling"
  ◀─ A2A: the handler's result + deleteSurface → read-only receipt
```

The study-room workflow is the same shape with a few extra steps:

- **Availability:** the Library's form looks up demo availability whenever date, room, duration or group size change. Only those four fields are sent. The times come from `listStudyRoomAvailability` (the fixture), never from a model.
- **Review:** "Review booking" returns a summary screen.
- **Confirm:** **Confirm demo booking** re-checks the slot and reserves it atomically. The check and the write happen in one synchronous step, so of two simultaneous confirmations exactly one wins.
- **Slot IDs:** they're opaque and specific to each form. A forged ID, or one taken from another form, is rejected, and no other time is ever substituted.
- **Conflicts:** if someone else takes the slot first, the student sees the conflict and refreshed alternatives.

### The form's lifecycle in the Student view

A form is part of the chat: it appears where the agent sent it, becomes a summary of what you sent when you submit, and the agent's reply follows it. Availability lookups and the review step stay inside the form (and show in the agent's panel). After **Edit and retry**, the failed attempt stays in place and the reopened form moves to the bottom.


`editing → submitting → accepted | rejected | confirmation_pending`, and `editing → cancelled | superseded`.

| State | What the student sees |
| --- | --- |
| editing | The live A2UI form |
| submitting | "Sending request…" / "Confirming booking…" — the editable form is already gone |
| accepted | Your submission as a read-only summary; the agent's confirmation follows it as the next chat message, with the receipt (request ID and preferences, or booking ID, room, date, times, timezone, "Demo booking") |
| rejected | The reason, and **Edit and retry**, which reopens the form with the saved values. After a room conflict, a new time must be chosen. |
| confirmation_pending | "Confirmation pending" and **Check status**, which resends the *same* operation ID. The agent returns the stored result or processes it once. No resubmission button appears until that's resolved. |
| cancelled / superseded | A compact record; no handler was called |

Removing the UI isn't deleting data: receipts, correlation and dedupe records are kept.

A reload or reconnect replays history, then sends a `replayed` marker. The browser rebuilds each form's *current* state, so a submitted, cancelled or superseded form never comes back, and late events for a closed form are ignored.

### What the agent does with submitted data

- **Understanding the request:** the model (or the heuristic) only chooses which allowed outcome applies.
- **Everything else is code:** validation, availability, reservation and the receipt text. The model can't invent workflows, rooms, times or a successful booking.
- **No re-routing:** form actions always go back to the agent that issued the form, using the recorded IDs, never based on the Notes text or the current topic.

### Demo data (fictional)

| | |
| --- | --- |
| Timezone | America/Los_Angeles (Pacific Time) |
| Tutoring | Monday–Friday 09:00–17:00; morning before 12:00; preferred date up to 60 days ahead |
| Rooms | Room A (4 people), Room B (6), Room C (10); 09:00–21:00; 1 or 2 hours; up to 14 days ahead |
| Fixture bookings | Every day: Room A 14:00–16:00, Room B 10:00–11:00, Room C 18:00–19:00 |

Nothing is sent anywhere: no email, calendar invitation, SMS or university system. A tutoring request never becomes "Appointment booked".

### Review before recording

After a submission passes the code checks, the issuing agent reviews **every field**: in live mode with one structured Claude Haiku 5.5 call, which sees the name, email, preferences and notes; in fixed/mock modes with a labelled heuristic.
- **Advisory only.** The review can only *flag*: contradictions (notes say "afternoons only", form says morning), notes unrelated to the form's purpose, likely email typos, placeholder values. It never accepts or rejects; code validation stays authoritative.
- **Nothing is recorded while flagged.** The form comes back at the bottom of the chat with the values and the flags; the student edits and sends again (reviewed again), or chooses **Send anyway**, which skips the review only for exactly the flagged values.
- **Fails open.** If the review call fails, the valid submission continues and the agent's panel says the review was unavailable.
- A known false positive ("the email doesn't match the name") is discarded in code.
- Availability lookups carry only scheduling fields; agent server logs redact names and emails.

### Limits, honestly

- **No durability:** state is in memory and there's no durable guarantee. A restart forgets forms, requests, bookings and dedupe records.
- **Decision accuracy:** live intent decisions are probabilistic. The mock heuristics are labelled stand-ins that prove the plumbing, not language understanding.
- **"Superseded" is per conversation:** two open browser tabs in the same conversation see the same lifecycle, because the UI server owns it.

## Part 7: the University Hub and the live topology

```
Browser ── SSE telemetry ── UI server (Student agent)
                                 │ A2A — the Student's only connection
                                 ▼
                 University Hub :41243  “California State University Fullerton”
                 private registry · router · destinations · form references · dedupe
                   │ A2A                              │ A2A
                   ▼                                  ▼
            Tutor Agent :41241                 Library Agent :41242
```

### Who knows what

- **The Student** knows one thing: the university's public card URL. It validates that card (name, one JSON-RPC 1.0 endpoint equal to the configured one, no security changes) and sends every chat message and form action there with its student ID (`student-alex`, fictional).
- **The Hub's public card** describes one skill, “University assistance”. Specialist names, cards and endpoints never appear on it or in anything the Student receives — replies carry only an attribution (`servedBy`).
- **The Hub's private registry** allowlists each specialist's identity, expected card name and trusted endpoint (configuration). It tracks registered, enabled, reachable, heartbeat freshness and card validity **separately**; only `ready` specialists receive work. Statuses: `ready`, `stale` (heartbeats stopped), `unreachable`, `disconnected` (never registered or signed out), `disabled`, `invalid_card`.
- **Destinations are server-owned.** `tutoring → tutor` and `library → library` come from the Hub's configuration. The router (Part 5's, moved into the Hub) picks a service and skill from the registry view; code validates the choice and maps it to its destination. A specialist can only be reached through its own destination; a new skill on it is routed only there.

### Registration, heartbeats and card changes

These are this application's conventions carried as typed A2A data parts (`src/hub-link.js`), not built-in A2A features:

1. A specialist starts, then sends `agent_register` with its configured identity, endpoint, card URL and a per-process instance ID.
2. The Hub checks the identity and endpoint against its allowlist, refuses a second live instance of the same identity (`identity_in_use`), then **fetches the card from its own configured URL** and validates it before marking the specialist ready.
3. Heartbeats follow every 3 s; after 10 s without one the specialist becomes `stale` and gets no new requests. A heartbeat from an instance the Hub doesn't know returns `not_registered`, and the specialist registers again (e.g. after a Hub restart).
4. A clean shutdown sends `agent_deregister`; a crash is caught by heartbeat expiry.
5. Saving skills sends `agent_card_changed` to the **Hub** (no longer to the Student). It is only a hint: the Hub re-fetches the current card from the configured URL, never applying anything from the message.

Identity on localhost is self-declared. The allowlist, configured endpoints and instance check limit what a local process can do, but this is not authentication.

### One request, hop by hop

1. Student → Hub: `message/send` in the Student↔Hub context (the conversation).
2. The Hub decides: **route**, **clarify**, **unsupported**, or **unavailable** (a supported request for a specialist that isn't ready). Only “route” dispatches.
3. Hub → specialist: a new A2A message with its own ID, in a separate Hub↔specialist context kept per conversation and specialist. The Hub's operation ID travels in metadata.
4. Specialist → Hub: an answer, or a form (a task in `INPUT_REQUIRED`).
5. Hub → Student: the answer as a message with attribution, or the form as the Hub's **own** task, carrying an opaque Hub form reference (`hf-…`).

A form action goes to the Hub with the form reference and an operation ID. The Hub checks that the reference exists, belongs to this student and this conversation, isn't expired or superseded, and matches the form, then forwards to the **issuing** specialist through the recorded mapping. It never re-routes by meaning. Operation IDs are deduplicated at the Hub (a stored result for an identical retry; a refusal for reuse with other values) and again at the specialist, which owns the effect. If the specialist doesn't confirm in time, the Hub reports `outcome_unknown`. The Student then shows “Confirmation pending” and offers only a reconcile with the same operation ID. Nothing retries on its own.

A repeated chat request (same Student request ID) is answered from the Hub's ledger: no second routing decision, no second dispatch.

### The browser: three tabs

Each tab has its own address, so you can open any of them in its own browser tab (Cmd/Ctrl-click or middle-click), bookmark it, or use Back/Forward: http://127.0.0.1:3000/conversation, http://127.0.0.1:3000/activity and http://127.0.0.1:3000/topology. The plain address http://127.0.0.1:3000/ always opens Conversation. Every browser tab follows the same live event stream.

- **Conversation:** you and the university. Press Enter to send (the box clears) and Shift+Enter for a new line. Replies are labelled with the service that produced them (“California State University Fullerton · Library Agent”), and the Hub's own replies (clarifying questions, “not supported”, “unavailable”) in its own color. The hop-by-hop strip below the chat shows the true flow of the current question and resets for the next one: nine steps (Student checked → … → Student received), the one in progress highlighted, each finished step filled in the color of the agent that did it with its time, and steps the flow didn't take marked skipped with the reason (for example “Hub answered itself (not supported)” or “not sent — your Student agent asked you first”). Failures show ✕, unknown outcomes ?.
- **Agent activity:** one console per agent — Student, Hub, Tutor, Library.
- **Topology:** a live switchboard. The Student is on the left, the Hub in the centre, and the Tutor and Library behind it; there is no Student↔specialist connection. Each connection has one lane per direction.
  - **Pulses** are drawn only for events the UI server labelled (`src/topology.js`) with a connection, a direction, a category (question/answer, form, registration, Agent Card, heartbeat) and a phase (sent, received, working, result returned, failed, outcome unknown). The color is the agent that sent it.
  - **Ordering:** the agents' feeds reach the browser on separate connections, so live events wait about 350 ms and play in the order the agents timestamped them. Replayed history fills the lists without animating.
  - **Nodes** show their status in words and icons, not color alone, plus heartbeat age and in-flight work.
  - **Each agent's own model** is a small box joined to that agent by a dashed HTTPS line: the Student's and the Hub router's models above them, the Tutor's and the Library's to their right. Each agent chooses its own mode, keeps its own key in its own process and calls the provider directly, so these are separate connections. A box shows the model ID and mode its agent reported, and pulses only for a real call that agent made (call started → replied / failed / timed out). Mock models run inside their agent, and a missing key fails before any call, so neither draws traffic. Status, calls in flight, and the last call's outcome, latency and tokens come only from calls that actually happened; nothing is sent just to check. The Student's model (`STUDENT_MODE=live`) runs only for questions whose words don't point to exactly one capability: it clarifies, picks the capability, or — when it's confident the university doesn't offer something (like home plumbing) — answers you itself without sending anything; anything uncertain, including “I don't know” to its question, goes to the Hub. The Hub still owns the destination (it accepts only its own public capability IDs and still checks readiness).
  - **Details:** click or press Enter on a node to see its details (the Hub's include its destination map); on a connection, its event timeline; pick a trace to highlight only the connections that request used.
  - **Controls:** heartbeats are hidden unless you ask for them. There are Reduce motion (on automatically with the OS setting) and Pause controls, and the event list is a readable alternative to the graph.
- **Live state:** if the browser's stream drops, a “Live view disconnected” banner appears and the graph greys out — separately from agent status. Events have IDs (`<boot>:<seq>`), so a reconnect gets only what it missed. Heartbeats aren't kept in history, and a notice says when history was truncated.

### Telemetry privacy

The Hub redacts message text, form values, review flags and errors from the specialists' telemetry before relaying it (`HUB_TELEMETRY_SHOW_CONTENT=1` turns that off for debugging). Topology labels carry only IDs and fixed text. The Hub logs no message text. Your own conversation still shows your messages and receipts, because it's yours.

### Limits, honestly

- **In memory:** a Hub restart forgets registrations (specialists re-register within a heartbeat), conversations, form references and dedupe records. Forms opened before a restart can't be used afterwards.
- **One Hub, one student identity** in the example configuration. Identities are self-declared on localhost.
- **Event timing:** live pulses are ordered by each agent's clock (all on one machine). Telemetry can lag the A2A reply by a few milliseconds; nothing is shown that didn't happen.

## Deliberately not included

Token streaming, push notifications, multi-agent fan-out (the Hub forwards each request to at most one specialist), authentication or authorization, mailboxes, a database, actually sending email, model-driven tools, and deployment. Each chat goes to at most one service as one A2A request and one response. Each form is one A2A task, opened by the agent's reply to a chat message and acted on only by its own allowlisted actions.
