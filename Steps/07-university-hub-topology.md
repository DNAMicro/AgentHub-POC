# Step 7 — University Hub orchestrator with live topology

> Final state: see `Steps/README.md`. This is your Part 7 prompt, in your wording and section order, with every change made while building it and every follow-up request since merged into the instructions themselves. Running it after Steps 1–6 rebuilds the current app. **Concrete specification** blocks give the exact names, values and layout the current app uses, so a rebuild comes out identical. The closing sections list the problems to avoid and each change with why it was made.

Part 7 — University Hub Orchestrator with Live Topology

Extend the existing Parts 1–6 spike. Inspect the implementation and run existing tests first. Preserve working A2A communication, LLM integration, editable Agent Cards, scope enforcement and intent-driven A2UI forms (including Part 6's advisory review and “Send anyway”). Do not rebuild from scratch. Explain the design before coding.

**Before removing or changing anything that already works and that this prompt doesn't explicitly cover, ask.** If a change would take away an existing capability as a side effect (for example, moving the router out of the Student removed the Student's only model use), say so before doing it and ask whether to keep it.

Goal

Introduce a University Hub between the Student, Tutor and Library agents. The Student connects only to the university. The Hub discovers the specialists, routes requests and relays responses. Add a dedicated browser Topology tab so I can see which agents are connected and follow actual messages and forms moving through them.

This is a localhost demonstration using fictional student data, not an official university service or production deployment.

## 1. Four-agent architecture

Run four separate agent services:
- Student Agent.
- University Hub Agent.
- Tutor Agent.
- Library Agent.

All specialist communication follows:
Student → Hub → Tutor or Library → Hub → Student.

Use real A2A exchanges on both legs. Do not substitute direct function calls, fabricated transcripts or browser-only simulations.

Remove specialist endpoints, private cards and department-selection logic from the Student. The Student can recognize its college relationship, and (section 5a) may ask for one of the university's **public capabilities** when a request isn't obvious, but only the Hub decides which internal specialist receives a request.

**Concrete specification**
- Processes, all bound to `127.0.0.1`: Student = hosted by the UI server `src/ui-server.js` (UI port 3000, identity `student-alex`, fictional); Hub = `src/hub-agent.js` (41243); Tutor = `src/tutor-agent.js` (41241); Library = `src/library-agent.js` (41242).
- The Hub reuses the Student's A2A client (`askTutor` / `sendFormAction` in `src/student-agent.js`) for its downstream leg. In the Hub, set `STUDENT_LOG_CONTENT=0` and relabel log lines via `A2A_CLIENT_LABEL`.
- Delete `src/student-endpoint.js` and `src/student-registry.js`; card fetching/validation moves to `src/cards.js` (`getCard(url, etag, timeoutMs)` with `node:http`, `validateCard`).
- `scripts/start-all.js` starts all four with prefixed output: `npm run demo` (mock router/models, `STUDENT_MODE=mock`) and `npm run demo:live` (`ROUTER_MODE`, `TUTOR_MODE`, `LIBRARY_MODE`, `STUDENT_MODE` all `live` — paid). Also `npm run hub` (mock router), `hub:live`, `hub:direct`, `ui` (`STUDENT_MODE=mock`), `ui:live` (`STUDENT_MODE=live`).

## 2. Public university identity and private specialist registry

The Hub's public Agent Card identifies it as “California State University Fullerton” and describes its university-assistance role. Include the required standards-compliant fields and actual supported input/output modes and protocol capabilities. Its skills are **one public skill per university capability** (logical destination) — `tutoring` (“Tutoring”) and `library` (“Library services”) — each with a public description, tags and examples taken from the Hub configuration, never worker names, endpoints or specialist cards. The card says it is a fictional local demo, not an official service.

The Student discovers this university card only. Do not expose the Tutor or Library cards as separate Student connections.

Maintain a private Hub registry containing each specialist's stable identity, trusted endpoint, current card, enabled skills, revision and availability.

The university role is a front door, not a claim to support every college request. Return a clarification, unsupported response or unavailable response when appropriate.

**Concrete specification**
- Card: JSON-RPC 1.0 interface at `/a2a/jsonrpc`, served at `/.well-known/agent-card.json` (`cache.maxAge: 0`); capabilities `streaming: false`, `pushNotifications: false`, the A2UI v0.9 extension (`https://a2ui.org/a2a-extension/a2ui/v0.9`, basic catalog, not required); input `text/plain` + `application/a2ui+json`; output those plus `application/json`.
- The Student validates the card it fetched from its configured card URL: expected name, exactly one JSON-RPC 1.0 interface equal to the configured endpoint, no security changes. It keeps the validated skills view (id, name, description, tags, examples) as its list of capabilities. It re-reads the card on startup, on send if missing, when the Hub feed reconnects, and on “Refresh skills”.
- Registry: `src/hub-registry.js` (`createHubRegistry`): `register`, `heartbeat`, `deregister`, `cardChanged`, `markReachable`, `routingView`, `snapshot`, coalesced `refresh`.

## 3. Connection configuration for every agent

Provide documented configuration examples and startup validation.

Student:
- Stable identity.
- Hub endpoint and public Agent Card URL.
- University relationship/scope.
- Timeouts and connection settings.
- Its own model configuration (section 5a).

Tutor and Library:
- Stable identity.
- Hub registration endpoint.
- Own A2A endpoint and Agent Card URL.
- Enabled state and heartbeat interval.
- Their own model configuration.

Hub:
- Public identity and endpoint.
- Allowlisted agent identities and endpoints.
- Internal destinations and routing policy (with each destination's public name, tags and examples for the card).
- Timeouts, heartbeat expiry and model configuration.

**Each agent sets its own model.** Every model-using agent (Student, Hub router, Tutor, Library) has `"model": { "name": …, "apiKeyEnv": "ANTHROPIC_API_KEY" }` in its own configuration and uses its own key variable in its own process. Allow only models checked against exactly what the app sends (effort `low`, structured output, no sampling parameters) and listed with their official price: `claude-haiku-5-5` (default), `claude-sonnet-5-5`, `claude-opus-5-5`. Anything else stops that agent at startup with a clear error listing the allowed models — never a fallback model.

Keep secrets server-side in environment references, never browser configuration, cards or logs. Do not create credentials or configure new persistent access. Invalid configuration must produce a clear error, not silently revert to direct Student-to-specialist routing.

**Concrete specification**
- `src/config.js`: `loadStudentConfig`, `loadSpecialistConfig(role)`, `loadHubConfig`, `ConfigError` (message `Invalid <Role> configuration:` + bullet list). Files: `STUDENT_CONFIG`, `HUB_CONFIG`, `TUTOR_CONFIG`, `LIBRARY_CONFIG`, merged over built-in localhost defaults; examples in `config/{student,hub,tutor,library}.example.json`.
- Checks: every URL localhost; the Student config refuses `tutorUrl`, `libraryUrl`, `specialists`, `peers`; Student `cardUrl` must be the Hub's own card URL; peers unique; destinations name allowlisted peers, one worker each; destination `tags`/`examples` are lists; `model.name` in the allowed list; `model.apiKeyEnv` matches `^[A-Z][A-Z0-9_]*$`; any `…key` field other than `apiKeyEnv` is refused (“Put the API key in the environment…”).
- Environment overrides: `HUB_URL`, `TUTOR_URL`, `LIBRARY_URL`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_EXPIRY_MS`, `HUB_DISPATCH_TIMEOUT_MS`, `HUB_FORM_TIMEOUT_MS`, `HUB_STUDENTS`, `CHAT_TIMEOUT_MS`, `SUBMIT_TIMEOUT_MS`, `SPECIALIST_ENABLED=0`, and `STUDENT_MODEL` / `HUB_MODEL` / `TUTOR_MODEL` / `LIBRARY_MODEL` (the error says “(set by TUTOR_MODEL)”).
- Defaults: heartbeat every 3000 ms, expiry 10000 ms; Hub timeouts dispatch 60000, form action 8000, card fetch 3000 ms; Student chat 60000, form action 8000 ms; Hub form references expire after 2 h (`HUB_FORM_TTL_MS`).
- `src/models.js` (no dependencies): `MODELS` with label and price per MTok — Haiku 5.5 $0.10 / $0.50 (prompts ≤100K tokens), Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20 — plus `DEFAULT_MODEL`, `DEFAULT_KEY_ENV`.
- `src/llm.js`: no model constant. `useModel({ name, apiKeyEnv })` is called once at startup by each process from its configuration; code reads `modelName()`, `keyEnvName()`, `priceOf()`, `costOf(usage, name)`. Error messages name the agent's actual model and key variable. Startup logs read like `API key (ANTHROPIC_API_KEY): configured, API host: api.anthropic.com` — the variable name, never the value. The paid scripts (`smoke:live`, `eval:live`) price their run from `TUTOR_MODEL`.

## 4. Registration, readiness and internal destinations

Tutor and Library register with the Hub. The Hub verifies the configured peer, retrieves its card from a trusted endpoint and validates it before enabling dispatch.

The Student establishes its own Hub session/connection without registering as a tutoring or library provider.

Track registration, reachability, enabled state and readiness separately. Registration alone must not mean “online.” Use heartbeats with an expiry policy. Reject unexpected endpoints, unregistered peers and duplicate identity takeover. Self-declared identity is not authentication.

For this spike, localhost A2A HTTP, registration and heartbeats are sufficient. Label the local trust model honestly. Do not claim persistent sockets, production authentication or laptop/NAT connectivity.

Keep minimal logical destinations such as “tutoring” and “library.” Each has server-owned routing scope and an assigned worker. This configuration is separate from the worker's prompt. Advertising a new skill must not automatically grant access to unrelated destinations.

Keep registration, registry storage and transport behind small interfaces so durable storage, authentication and outbound connectors can be added later. Do not build the full production mailbox or administrator platform now.

**Concrete specification**
- Control messages are **this application's conventions carried as typed A2A data parts** (`src/hub-link.js`, `createHubLink`), handled by the Hub executor before any student check: `application/vnd.a2a-spike.agent-register+json`, `…agent-heartbeat+json`, `…agent-deregister+json`, and `application/vnd.a2a-spike.agent-card-changed+json` (in `src/skills.js`).
- A specialist registers after it starts listening (identity, endpoint, card URL, per-process `instanceId`). Refusals: `unknown_peer`, `unexpected_endpoint`, `identity_in_use` (another live instance), malformed instance ID. A heartbeat from an unknown instance gets `not_registered` and the specialist registers again (covers a Hub restart). Sign out on SIGTERM/SIGINT (best effort); expiry covers a crash.
- The card is fetched from the **configured** URL (conditional, size-capped) and validated before `ready`; a failed refresh keeps the last good card.
- Derived status: `ready`, `stale`, `unreachable`, `disconnected`, `disabled`, `invalid_card`. Only `ready` gets new work.
- Destinations: `tutoring → tutor`, `library → library`. A specialist is reachable only through its own destination.

## 5. Hub-owned routing and specialist enforcement

Move the Part 5 bounded router into the Hub. Use the existing configured model (the Hub's own `model` setting) and validated structured decisions: route, clarify, unsupported or unavailable.

Examples:
- Explain derivatives → Tutor if calculus is enabled.
- Renew a library book → Library if supported.
- Find a calculus textbook → Library.
- Explain a derivative in a textbook → Tutor.
- Ambiguous request → clarification.
- Unadvertised physics or plumbing request → unsupported.
- Supported request with an unavailable specialist → unavailable.

Use current enabled skills, readiness and destination policy. Never let model output, user text or a card description supply an arbitrary URL. Do not silently fan out mixed requests.

Specialists independently enforce their current advertised scope and allowed operations. Recheck scope before an action or result is released if configuration changes during processing.

**Concrete specification**
- `src/router.js` (header now says it is the Hub's router): `ROUTER_MODE` `direct` (code default; everything to tutoring, for Part 2–4 style tests), `mock` (labelled heuristic over current skill tags), `live` (structured output). Per-conversation recent turns with reply snippets (6 kept, 4 sent), so “yes” after a clarifying question still works. `validateDecision` checks every decision against the registry view. Export `tokenize` and `near` (the Student reuses them).
- Only `route` dispatches. The Hub answers the other three itself in plain words — e.g. “Library Agent is not available right now (it isn’t connected).” — never a raw status code.
- The live router reports its call as `model_call_started` / `model_response_received` / `model_call_failed` with `purpose: 'routing'`.

## 5a. The Student's own model: clarify, and choose a capability when it isn't obvious

The Student has its own model (`STUDENT_MODE` = `off`, the code default / `mock` / `live`). Its job is to clarify unclear questions and, when it isn't obvious which capability a request needs, to choose one. It never chooses a specialist or an endpoint. Before sending a chat message:

- **Obvious** — the words match exactly one capability's public tags (or name): send the question as-is; **the Hub's router decides**. A keyword is not a decision (“the reading for my calculus course” mentions calculus but is a library request).
- **A reply to the university's own question** (its last reply in this conversation ended with “?”): send as-is; the Hub has that context.
- **Otherwise** (no capability matched, or several): `live` asks the Student's model for `send` + a capability ID from the card (or `none`), or `clarify` with one short, friendly question. The schema's enum is built from the card's capability IDs; code validates the result. `mock` is a labelled heuristic: it asks only when the question is nearly empty (fewer than two meaningful words and no match), and sends several-match questions to the Hub's own heuristic.
- **Clarify:** send nothing. Show the student's question as held (“You (held by your Student agent, not sent yet)”) and “Your Student agent asks”. The next message in that conversation may **answer** the question or be a **new request**:
  - In live mode, the same single model call returns `relation: answers_question | new_request` (the schema gets the field only while a question is pending; the prompt includes `<pending_clarification>` with the earlier message and the question).
  - **Answer:** send the held question + newline + the answer; the Student may not ask again about it.
  - **New request:** send the new message on its own; the held question is dropped. The Student console says which happened.
  - “I don't know”-style replies always go to the Hub with the held question.
  - Mock: a labelled heuristic — 3+ meaningful words that clearly match one capability, not opening like a continuation (“with…”, “for…”, “the…”, “yes”), is a new request.
- **Clearly not a university service** (the model is confident nothing listed covers it — home plumbing, car repair): the Student answers itself and sends nothing. The model returns `decline` with one plain sentence (without listing the capabilities); the Student adds “The university can help with: Tutoring and Library services.” The chat shows “You (not sent — answered by your Student agent)” and “Your Student agent — not offered by the university”; every later strip step is “not sent — your Student agent answered (not offered)”. Event `request_declined`.
- **Anything uncertain goes to the Hub:** the model unsure → `send` + `none`; and if the student answers the Student's clarifying question with “I don't know”, “not sure”, “no idea”, “idk”, “maybe”, “either”… (checked in code, straight and curly apostrophes, before any model call) → sent to the Hub with no capability (`by: 'uncertain'`), never declined or guessed. `mock` never declines.
- **Model failure:** fail open — send without a capability so the Hub routes it, visibly (`by: 'model_failed'`, `model_call_failed` event); never another model.
- The chosen capability travels as A2A message metadata `requestedCapability`. The Hub accepts only its own destination IDs, maps the ID to its configured worker, still applies the readiness check (→ `unavailable`), records `decidedBy: 'student'` and skips its router call. Any other value → `capability_rejected` event and the Hub routes as usual.

**Concrete specification**
- `src/student-assistant.js`: `STUDENT_MODE` (read at import), `matchCapabilities(question, capabilities)` (multi-word tags match as phrases; single words via `tokenize`/`near`), `planRequest({ question, capabilities, recentTurns, followsQuestion, clarifiedAlready, clarificationAnswer, onModelEvent })` → `{ action: send|clarify|decline, capability, by: off|context|uncertain|rule|heuristic|model|model_failed, reason, clarificationQuestion?, matched?, likely?, model?, usage?, requestId? }`. Order of checks: off → reply to the university's question → unsure answer to our question (`UNSURE`) → one-capability match → mock heuristic / live model. Schema `action` enum: `send`, `decline`, plus `clarify` only while a clarification is still allowed; a `decline` needs a non-empty reason, `studentAssistantStatus()`. Limits: 400 output tokens, `STUDENT_MODEL_TIMEOUT_MS` (30 s), 4 recent turns. Purpose label `clarify & choose capability`.
- In `src/ui-server.js`: `useModel(cfg.model)` at startup; `planAndSend` runs before `sendChat` (not on reconcile); per-conversation `{ turns, pending }`; each run keeps the student's own words (`typed`) separately from the text sent; publish `request_planned`, `clarification_asked` and `request_declined` (the decline reply is added to the conversation's turns, the run completes with `decision: 'student_decline'`); `agentStatus.student` is published as `agent_status` and included in `hello`/`/api/status`.
- Startup line: `[UI] Student model: live (claude-haiku-5-5), API key (ANTHROPIC_API_KEY): configured, API host: api.anthropic.com`.

## 6. Correlation and response relay

The Hub receives the specialist result and returns it through the Student's Hub conversation. Preserve useful source attribution without revealing private endpoints or cards.

Maintain a stable application operation ID and mappings for:
- Student identity and conversation.
- Student-to-Hub A2A task/context.
- Internal destination and specialist.
- Hub-to-specialist A2A task/context.

Upstream and downstream tasks belong to different servers. Do not blindly reuse their task IDs.

Forward only the context needed by the selected specialist. Isolate students and conversations. Avoid sharing unrelated tutoring history with Library or library history with Tutor.

Timeout or cancellation must not be presented as proof that a downstream action was rolled back.

**Concrete specification**
- The Student↔Hub `contextId` is the student's conversation. The Hub opens one downstream context per (conversation, specialist), sends its own message IDs and passes `hubOperationId` and `via` in metadata.
- Replies carry `servedBy`, `servedByName` and the Hub's decision (`decision`, `destination`, `reason`, `model`, `decidedBy`) — never endpoints.
- Repeats of the same Student request ID are answered from the Hub's `chatLedger` (keyed by upstream contextId + messageId) with no second routing or dispatch; this keeps Part 4's reconcile working (`request_repeat` event).

## 7. Preserve forms through the Hub

The receiving specialist still interprets the request and decides whether to offer its form. Do not introduce a “Request form” button or a browser shortcut that bypasses agent intent handling.

Tutor flow:
Student asks for in-person calculus help → Hub → Tutor → A2UI request form → Hub → Student.
Completed form → Hub → original Tutor workflow → verified request-received acknowledgment → Hub → Student.

Library flow:
Student asks to reserve a group study room → Hub → Library → availability-based A2UI form → Hub → Student.
Confirmed selection → Hub → original Library workflow → atomic demo booking → verified confirmation → Hub → Student.

Preserve all Part 6 fields, validation, fictional availability and request-versus-booking semantics. The Hub relays real A2UI payloads and authoritative outcomes; it must not fabricate booking success.

Use an opaque Hub-owned form/action reference mapped to the issuing specialist, student, conversation, workflow and downstream task. Submissions follow this mapping, not semantic routing again. Reject altered, expired, superseded and wrong-conversation references.

Valid submission immediately removes the editable form and shows pending status. Accepted submissions become read-only receipts. Known failures allow correction without losing values. Uncertain outcomes remain pending until reconciled. Reconnect and replay must never resurrect a submitted form or submit it again.

**Concrete specification**
- The Hub returns the specialist's form as **its own task** in `INPUT_REQUIRED` and records `hf-<uuid>` → student, conversation, workflow, issuer, downstream task/context, form ID and version. Actions must carry the `formRef`; the Hub refuses without forwarding when it is unknown or altered, from another student or conversation, expired, superseded, or aimed at a different surface. The Student's `registerForm` requires `issuer` and `formRef`.
- Operation-ID dedupe at the Hub (`operations`: stored result for an identical retry, refusal for reuse with different values) **and** at the specialist. The Hub caches only definite results. Hub statuses back to the Student: `outcome_unknown` (specialist didn't confirm in time → “Confirmation pending”, reconcile with the same operation ID only) and `not_delivered` (specialist unreachable → Edit and retry). Nothing retries automatically.
- Form cards and chat bubbles label replies the same way: “California State University Fullerton · Tutor Agent”.

## 8. Dynamic cards update the Hub

Keep Tutor and Library gear controls from Part 5.

On a skill change:
- Save the specialist configuration and publish its updated card.
- Notify the Hub using the application-level card-change convention.
- Hub verifies the sender, refetches the trusted card and atomically updates its registry.
- Future routing uses the updated eligible skills.

Do not send specialist cards to the Student. Its university connection stays stable.

Show configuration saved, notification pending and Hub refreshed separately. Deduplicate notifications and handle out-of-order updates by fetching current authoritative state. Removed skills remain blocked at the specialist even when Hub metadata is stale.

**Concrete specification**
- `src/agent-settings.js` takes `notify` (the hub link) instead of a Student URL; no startup notice. The Hub accepts a notice only from the registered instance, dedupes notice IDs, treats it as a hint and re-fetches the card (coalesced, conditional). If the Hub is offline the notice is reported pending; registering later makes the Hub fetch the current card.
- `card_refreshed` carries `revision`, `etag` and skills `{ id, name }` so the page never shows a stale ETag.
- Settings reach specialists only through the Hub's developer proxy (`/dev/agents/:id/skills`, `/dev/registry/refresh`); the browser never learns specialist URLs.

## 9. Browser tabs and views

Provide these clearly named tabs:
- Conversation: Student-facing university chat and forms.
- Agent Activity: four agent panels with actual received/sent events.
- Topology: live graph of connections and message flow.

**Each tab has its own address, so it can be opened in its own browser tab:** `/conversation`, `/activity`, `/topology`. The UI server serves the same page at exactly these three paths (anything else is 404). The tabs are real links (`<a href="/topology" role="tab">`). A plain click switches in place and pushes the address; Cmd/Ctrl/Shift/Alt or middle-click is left to the browser so it opens a new tab; arrow keys replace the address (no history flood); Back/Forward switch tabs. The plain address `/` always opens Conversation — no remembered last tab.

The Student-facing view shows only the university relationship and that student's conversation. Specialist registry details and full topology belong to the local developer view. Do not describe a browser tab distinction as production authorization.

**Concrete specification**
- Conversation: a **live nine-step hop-by-hop strip** that shows the true flow of the current question and resets for every new one (and for every form action, with its own seven steps). Chat steps, each marked only by its real event: Student checked (`request_planned`), Student sent, Hub received, Hub routed, Hub forwarded, specialist received, specialist replied, Hub got the reply, Student received.
  - **States:** pending (dashed, “not yet”) → **in progress** (the first unsettled step while the run is in flight: solid border, pulsing glow, “in progress…”, `aria-current="step"`) → **done** (filled with a tint of the color of the agent that did it, name in that color with “ ✓”, its time). The specialist steps take the color of the service the Hub actually chose. **Skipped** (dotted, faded, with the reason), **failed** (red, “✕ failed”), **unknown** (amber, “? outcome unknown”).
  - **Notes say what really happened:** Student checked → “obvious — the Hub routes it” / “needs Library services (model)” / “asked you to clarify first” / “reply to the university — sent as-is”; Hub routed → “→ library (Student's choice)” or “not routed: not supported”; specialist steps → the service's name.
  - **True flow, not a fixed path:** the Hub answered itself (clarify / unsupported / unavailable) → the four specialist-leg steps are “skipped — Hub answered itself (not supported)”; the Student asked you first → every later step is “not sent — your Student agent asked you first”; forward failed/timed out → that hop failed/unknown and the specialist steps skipped; request not delivered / no reply in time → “Student sent” failed/unknown and the rest skipped; a form action refused or answered from the Hub's stored result → the forwarding steps skipped.
  - Steps are at least 100 px wide so all nine fit at desktop width without scrolling. Reduced motion stops the pulse (the solid border and text still show the current step). Replay after a reload rebuilds the strip from the events.
- The Hub's own replies (clarify, unsupported, unavailable) use the Hub's color. The Student's held question and clarifying question appear as chat items.
- **The chat follows the bottom reliably** (`followBottom` in `public/app.js`, also used for the four agent consoles):
  - While the reader is at the bottom (within 40 px), the log stays at its newest item — on every **size change** of any item (a `ResizeObserver` on each child, attached by a `MutationObserver`), not only when an item is added. A2UI surfaces render asynchronously, and receipts, reopened forms and replays grow after insertion.
  - Scrolling **up** stops following: an upward wheel, touch drag or ArrowUp/PageUp/Home stops it at once, and a scroll event that lowers `scrollTop` does too. The reader is never pulled away from what they're reading.
  - Scrolling back to the bottom, **sending a message**, starting a new conversation, or the student's own form action that moves a form to the bottom (Edit and retry) follows again.
  - No other code sets `scrollTop` directly.
  - Repeatable browser check: `scripts/browser-checks/chat-scroll.js` (run with `playwright-cli run-code`). It covers 12 checks — text answers, a tall form, generated surfaces, scroll-up-while-answering, resume, send-while-up, consoles, reload replay, tab switch and phone width — each measuring the gap to the bottom.
- **Composer:** Enter sends; Shift+Enter starts a new line (an Enter that confirms an input-method composition — `isComposing` / keyCode 229 — is left alone). The text box is cleared as soon as a message is sent; if the request can't start (e.g. the server is unreachable) the text is put back and the error shown. Blank messages aren't sent, and while a question is in flight Enter does nothing (like the disabled Send button). The textarea has `aria-keyshortcuts="Enter"` and a description of both keys.
- **Waiting spinner in the chat:** when a chat question has been in flight for more than **1 second**, a small “Waiting for an answer…” item with a spinning ring (`role="status"`) appears as the last chat item (it stays last as other items arrive). It is removed the moment anything answers that question — `reply_received`, `tutor_error`, `request_failed`, `form_received`, `clarification_asked`, `request_declined` — or the run leaves its busy state, and never comes back for that question. Fast answers never show it; form actions don't use it. A reload while a question is still in flight shows it again. Reduced motion keeps the ring still (the text remains).
- Agent activity: consoles for Student, Hub, Tutor, Library. The Student console shows “Plan: …” (how: obvious from the words — the Hub routes it / decided by the Student's model / reply to the university's question / Student model off / failed) and the Student's model calls. The Hub console marks “Routed → library (Student's choice)” and “Capability not recognised”. The skills boxes compare “Advertised” with the “Hub's view”; propagation shows saved → notice delivered → Hub routing updated.
- Tabs follow WAI-ARIA (arrow keys, Home/End). Grid children use `minmax(0, 1fr)` so nothing widens the page.

## 10. Dedicated live Topology tab

Place the Hub in the center, Student on one side, and Tutor and Library on the other. Draw only configured relationships:
- Student ↔ Hub.
- Hub ↔ Tutor.
- Hub ↔ Library.

Never draw a direct Student-to-specialist link.

**Also show each agent's own model.** Every agent has its own small model box joined to it by a dashed HTTPS line (not A2A, not one shared provider node): the Student's and the Hub router's above them, the Tutor's and the Library's to their right. Each box shows the model ID and mode its agent reported and that agent's own call status; it pulses only for a real call that agent made. Each agent chooses its own mode and model and holds its own key, so these are separate connections. With `STUDENT_MODE=off` the Student's box reads “Off” and its line is dimmed.

Label the edges as logical A2A relationships, not persistent network sockets.

Each agent node shows:
- Display name, stable identity and role.
- Registered/unregistered state.
- Enabled/disabled state.
- Ready, stale, unreachable or disconnected status.
- Last heartbeat and card revision where applicable.
- Current activity and active/pending request counts.

Clicking a node opens its relevant details. The Hub's developer details include its internal destination-to-worker mappings. A model box's details show who uses it, what for, mode, model, provider, whether its key is set (never the value), calls seen, in flight, failures and the last call (purpose, outcome, latency, tokens).

Show status with text and icons as well as color. Include a clear legend. Keep the graph readable on smaller screens, support keyboard navigation and reduced motion, and provide an accessible event-list alternative.

**Concrete specification**
- `public/topology.js` (`createTopology`), SVG `viewBox="0 0 1100 540"`. Agents (circles): student (130, 260, r 60, “Student agent”, “You”); hub (450, 260, r 76, “University Hub”, “Front door and router”); tutor (770, 118, r 60); library (770, 402, r 60). Model boxes (184×74 rounded rectangles, slate `--model`): `llm-student` (130, 62), `llm-hub` (450, 62), `llm-tutor` (985, 118), `llm-library` (985, 402), named “Student's model”, “Hub router's model”, “Tutor's model”, “Library's model”.
- Edges: `student-hub`, `hub-tutor`, `hub-library` (A2A, solid) and `student-model`, `hub-model`, `tutor-model`, `library-model` (HTTPS, dashed 5 5). One lane per direction offset ±9 px, both measured on the a→b direction; lanes trimmed at circle radius or box border. Edge labels “A2A” / “HTTPS” (vertical edges: label to the right).
- Node status pills: “✓ Ready”, “⚠ Heartbeat late”, “✕ Unreachable”, “○ Not registered”, “⏸ Disabled”, “✕ Card refused”, plus “✓ Online”, “↻ Waiting for reply”, “↻ Relaying (n)”, “↻ Working (n)”; heartbeat age “♥ 3s ago”; Hub “router: live”. Model box status lines (always with an icon prefix): “○ Off”, “○ In-process, no network”, “⚠ No API key set”, “↻ Call in flight (n)”, “○ No calls yet”, “✓ Last call answered”, “? Last call timed out”, “✕ Last call failed”.
- Colors (light): student `#2b59c3`, Hub `#9a6300` (dark `#e3b04b`), tutor `#8a3fa8`, library `#16765e`, model `#5b6472` (dark `#aab4c2`). Color = the agent that sent it.
- Legend: Question or answer · Form or form action · Registration · Agent Card · Heartbeat · Model call (dashed line = HTTPS, not A2A) | Sent · Received · Result returned · Failed · Outcome unknown, and “Color = the agent that sent it. Pulses appear only for events the agents reported.”
- Controls: Show heartbeats (off), Reduce motion (follows the OS, toggleable), Pause, trace selector. Side panel: details + event list (newest first, timestamp order, max 300).

## 11. Show actual data flow on the graph

Animate a directional pulse or packet along an edge only when a corresponding backend event exists. Use labeled event categories for:
- Registration and card refresh.
- User request.
- Forwarded specialist request.
- Specialist response and Hub relay.
- A2UI form offer.
- Form submission.
- Confirmed workflow receipt.
- Error or uncertain outcome.
- Each agent's own model call.

Distinguish dispatch attempted, recipient accepted, processing, completed, failed and outcome unknown. A moving indicator must not falsely imply recipient acceptance or successful completion.

Keep heartbeat traffic subtle or filterable so it does not overwhelm meaningful activity. Do not run decorative traffic continuously.

Selecting a request highlights only its actual path. Concurrent requests remain separately identifiable. A calculus trace must visibly follow Student → Hub → Tutor → Hub → Student without highlighting Library.

Clicking an edge or trace opens a sanitized event timeline with event IDs, operation ID, timestamps, source, destination, event type and status. Include upstream/downstream task mappings and concise routing explanations, not hidden chain-of-thought.

Show measured latency only where the measurement is valid. Do not calculate misleading cross-service latency from unsynchronized clocks.

**Concrete specification**
- `src/topology.js` `topologyLabel(event)` labels events server-side: `{ edge, from, to, category, phase, label, operationId }` or an inside-node label `{ edge: null, node }`. Categories: request, form, registration, card, heartbeat, routing, model. Phases: attempted, accepted, processing, completed, failed, unknown. Labels carry only IDs and fixed text.
- Model calls (`model_call_started` / `model_response_received` / `model_call_failed`; the Tutor's live `scope_check_started` carries `mode`, `scope_checked` carries `usage`) become hops on `<caller>-model` with `from`/`to` `'model'` **only for live calls**. Mock models stay inside the agent; `missing_credentials` means no call was made. The browser draws the `'model'` end at the caller's own box. Never probe the provider to show its status.
- Student labels include `request_planned` (“Obvious — the Hub routes it”, “Student chose Library services (its model)”, “Student decided to ask you first”) and `clarification_asked`. Hub labels include `route_decided` (“Routed to library (Student's choice)”) and `capability_rejected`. `card_discovered` is a hop only when it carries a reason.
- The browser animates only labelled **live** events: buffer ~350 ms, sort by `at`, stagger 170 ms (specialist events reach it later, through the Hub). Shape = category; fill = phase; failed/unknown stop halfway with ✕ / ?. Reduced motion shows a static mark at the lane's middle. Replayed history fills the list and node state without animating.
- Latency is shown only for a model call, as measured by the agent that made it.

## 12. Read-only telemetry and reconnect behavior

Drive the topology from a server-owned event stream and authoritative state snapshot. SSE or WebSocket telemetry is acceptable; label this browser telemetry separately from A2A communication.

Every event needs a unique ID, operation correlation and enough ordering/causation information to interpret it. Bound retained event history and show when older history has been truncated.

Deduplicate replayed events and tolerate out-of-order arrival. Resume from an event cursor where supported; otherwise refresh the snapshot and visibly indicate any history gap.

If browser telemetry disconnects, show “Live view disconnected.” Do not declare every agent offline merely because the browser lost its stream.

Refreshing the page, reopening the tab, filtering, clearing the visible log or replaying a trace must never dispatch messages, resubmit forms or repeat bookings. Historical replay must be explicitly labeled and remain visualization-only.

Redact credentials, tokens, student emails, notes and form values from topology telemetry by default. Show message type, status and safe metadata, not unnecessary personal content.

**Concrete specification**
- The UI server follows only the Hub's `/viz/events`; the Hub relays each specialist's feed with `source: agentId` and replays each specialist's last `status`. The Hub also serves `/viz/topology` (snapshot with `feeds`).
- **Redaction is an allowlist** (`redactTelemetry` in `src/hub-agent.js`): in relayed specialist **run** events only known-safe fields pass — IDs, statuses, outcomes, verdicts, codes, modes, model, purpose, timings and token counts (nested `usage` / `tutor` / `library` follow the same rules). Everything else is masked (`[n chars redacted]`, `[n items redacted]`, or each key `[redacted]`): message text, form values, review flags, errors, model-written reasons and any field added later. A `receipt` is reduced to `{ requestId, bookingId, status }`. Only the named configuration event types — `status`, `skills_saved`, `card_notification`, `hub_registration` — pass unchanged (operator configuration, not student content). Never exempt an event because it has no `runId`: a request sent without one would get its content relayed. `HUB_TELEMETRY_SHOW_CONTENT=1` turns redaction off for debugging (tests that compare values set it). The Hub logs no message text. The student's own conversation still shows their messages and receipts.
- Event IDs `<bootId>:<seq>`; `Last-Event-ID` (or `?after=`) resumes with only missed events; an unknown boot or too-old cursor gets a full replay plus a `truncated` event. History bounded by `UI_HISTORY_LIMIT` (1000). Heartbeats are live-only (never in history). A `replayed` marker ends each replay. “Live view disconnected” is a banner separate from agent status; the graph greys out.

## 13. Reliability and scope limits

Deduplicate operation IDs at the Hub and effect-owning specialist. Duplicate delivery must not create a second tutoring request or booking. Reject reuse of an operation ID with a different payload.

Do not automatically retry an uncertain action outcome. Provide reconciliation against the recorded operation result. Prevent routing loops and unbounded forwarding (the Hub forwards each request to at most one configured specialist, and specialists never forward). Stop new dispatches to stale, disabled or disconnected specialists.

Keep local in-memory state acceptable for this spike, but document restart limitations. Do not claim durable recovery or exactly-once execution unless implemented and tested.

Use fictional data and localhost-only services. No external university systems, real reservations, email, deployment or new credential setup. Keep mock tests free. **Live model calls for normal use and verification need no pre-approved budget** (your standing instruction, which replaces “ask before running them”): run them, then report the calls, usage and cost. The scripted paid checks (`smoke:live`, `eval:live`) keep their `*_MAX_USD` gate. When something is handed over as ready, it runs in live mode.

## 14. Acceptance tests

Verify with actual backend and browser/network evidence:
- Student discovers only the public university card and makes no direct specialist calls.
- Calculus and library requests take the correct Hub-mediated paths in the topology.
- Requests and responses use real A2A on both legs.
- Ambiguous, unsupported and unavailable requests behave honestly.
- Stopping a specialist causes heartbeat expiry and blocks new dispatches.
- A card change updates Hub routing and the displayed revision without exposing private cards to Student.
- Both form workflows display offer, submission and receipt on their correct issuer-bound paths.
- Valid form submission removes the editable form; reconnect does not restore it.
- Wrong-student and wrong-conversation form actions are rejected.
- Duplicate application delivery produces one domain effect.
- Duplicate telemetry changes neither application state nor effect count.
- Refreshing, reconnecting and replaying traces never repeats a request or booking.
- Telemetry disconnection is distinguished from agent disconnection.
- Concurrent operations remain independently traceable.
- Failed and unknown outcomes never appear as confirmed success.
- Keyboard navigation, text statuses and reduced-motion mode work.
- Each agent's model is its own: a configured model and key variable reach the provider; unsupported models are refused at startup; model lines appear only for real live calls, on the caller's own line.
- The Student's model: obvious questions go on as-is; an unclear one is clarified with nothing sent, then sent as question + answer; a clearly unsupported one is answered by the Student with nothing sent; an “I don't know” answer goes to the Hub; a model-chosen capability is honored by the Hub; an unknown capability is ignored; a model failure falls back visibly.
- Each tab address serves the page; other paths are 404.
- A chat answer that takes more than 1 s shows the in-chat “Waiting for an answer…” spinner, which disappears when the answer arrives; a fast answer never shows it.
- In the chat box, Enter sends and clears the box; Shift+Enter adds a new line; a blank Enter sends nothing; a send that fails to start gives the text back — checked with real key presses in a browser.
- The hop-by-hop strip shows each question's true flow live (in-progress highlight, agent colors, skipped steps with reasons) and resets for the next question — checked in a real browser for a routed question, a Hub-answered one and a Student clarification.
- Parts 1–6 regression tests remain covered except intentionally replaced direct-routing behavior.

If a test uses mock traffic, label it as mocked. Do not claim browser verification from source inspection alone.

**Concrete specification**
- Port every Part 1–6 test onto the full stack with `startStack` (alias `startTrio`) in `test/support/harness.js`: it pre-picks specialist ports so the Hub configuration can name them, waits until the Hub follows each specialist's feed (`readyAgents` for deliberately disabled ones), kills the stack's **current** processes (a restarted one included) and kills everything if readiness fails. `npm test` sets `HUB_URL=http://127.0.0.1:9` so no test process registers with a real local Hub. Heartbeat expiry is 3 s in tests.
- New files: `test/hub.test.js` (isolation, routing outcomes, form-reference refusals, Hub-level unknown outcome reconciled once, stale/signed-out/disabled get nothing, concurrency, labels and redaction, resume/truncation/heartbeats, configuration validation incl. models, model-line labels) and `test/student-model.test.js` (planner rules, topology labels, capability card, obvious → Hub, clarify → combined send, unknown capability ignored, live Student model via the fake Messages API with its own model and key, clarify and failure in live mode, decline answered by the Student, unsure model and “I don’t know” sent to the Hub). Plus `card-refresh`, `ui` (incl. tab addresses), `tutor-llm` (incl. per-agent model and key variable), `routing`, `form`, `booking`, `skills` ported. Live-mode tests use `test/support/fake-anthropic.js` via `ANTHROPIC_BASE_URL` with placeholder keys — never real network. Final count: 115 tests (plus the redaction unit test in `hub.test.js`), all passing.
- Then run every scenario in a real browser with Playwright against the **live** servers (`env -u ANTHROPIC_BASE_URL npm run demo:live`) and report the cost.

## 15. Deliverables

Deliver runnable code, configuration examples for all four agents, startup commands, tests and a short architecture explanation. Pin compatible A2A/A2UI versions (`@a2a-js/sdk` 1.3.0, A2UI v0.9 with `@a2ui/lit` / `@a2ui/web_core` 0.14.0, `@anthropic-ai/sdk` 1.3.0, `express` 5.3.0 — exact versions) and explain registration, heartbeat and card-change conventions as application features, not automatic A2A functionality.

Include a walkthrough demonstrating a calculus question, a library question, both form workflows, a skill change and a specialist disconnect in the Topology tab — and the Student's model clarifying an unclear question and choosing a capability. Clearly distinguish implemented behavior from mocked behavior and future extension points. Update README.md (Part 7 section, run commands, environment table, files table) and CLAUDE.md (Part 7 notes). Stop after this spike.

Make sure the UI design is animated and shows as live reflecting the connection and data flow and direction of flow.

## Avoid these known problems (found while building this step)

**Process and communication**
- **Ask before removing or changing what already works.** Moving the router into the Hub also removed the Student's only model use, and that wasn't said — the user found out from the diagram. When a request is unclear about existing behaviour, ask; when a change removes something as a side effect, say so first.
- **Stop test processes by PID or port, never with a loose `pkill`.** On macOS (BSD `pkill`), options after the pattern become extra patterns: `pkill -f "src/library-agent.js" -n` killed the demo Library, and a similar misordered command SIGTERMed ~70 unrelated processes. Use `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`; if `pkill` is unavoidable, put every option before the pattern and dry-run with `pgrep -lf` first.
- **Start live servers with `env -u ANTHROPIC_BASE_URL`** from Claude Code: its shell points that variable at a proxy that answers with fake 429s. Each startup line must say `API host: api.anthropic.com`.
- **Use `gtimeout` (or `--test-timeout`) when running test files from a shell loop** — a hung child keeps `node --test` alive indefinitely.

**Routing and models**
- **Don't make the Hub say what the Student already knows.** Telling the Student's model “nothing fits → send it anyway, the university will say so” cost a Hub trip and a second model call for “how do I fix my toilet plumbing”. Let the Student decline when it's confident; send anything uncertain on.
- **A pending clarifying question must not swallow the next message.** The full e2e run asked “Renew my book and explain integrals” (the Student asked which first), then “I want to arrange in-person help with calculus next Tuesday morning” — which was joined to the held question and bounced back by the Hub. Decide whether the next message answers the question or is a new request.
- **Match typed text with both apostrophes.** “I don’t know” typed with a curly apostrophe didn't match `don'?t`; use `don['’]?t`.
- **A keyword match is not a routing decision.** With “one matching tag = obvious, choose it”, “Where would I get the reading for chapter three of my calculus course?” went to the Tutor (it mentions calculus) and was refused. Obvious requests go on unchanged so the Hub's intent-aware router decides; the Student's model decides only the non-obvious ones.
- **Never hard-code one model.** A single module constant made every agent share one model and made error messages, telemetry, status, cost and the paid scripts wrong as soon as one agent changed. Use the per-process `useModel()` / `modelName()`; read nothing model-specific at import time.
- **Only list models that accept the exact request.** Claude Haiku 4.5, for example, has no effort parameter; an unchecked name would fail on the first call. Refuse unlisted names at startup.
- **Fake-API test replies:** `messageReply()` already returns `{ status, json }` — passing it inside another `{ json: … }` produced an empty response and an `internal_error`.
- **Don't label every “model” event as provider traffic.** Mock-mode Tutor events use the same names; decide from the reported mode/model, and treat `missing_credentials` as no call. The Tutor's scope-check start event needs `mode`.

**Topology and browser**
- **Two direction lanes need one reference direction.** Computing each lane's sideways offset from its own direction flips the sign twice for the return lane, so both lanes landed on top of each other.
- **Specialist telemetry arrives later than the Hub's.** Buffer and sort by the agents' own timestamps; in tests, wait for events instead of assuming order.
- **Don't draw one shared provider node.** It suggested the agents share one connection and invited “why isn't the Student connected?”. Draw one model box per agent.
- **Model boxes are rectangles:** trim lanes at the box border (not a circle radius), keep their status as a text line rather than a pill (a pill sits on the vertical Hub lane), and give every status text an icon prefix — the accessible label strips the first word.
- **Card refresh events must carry the new ETag**, or the page shows a stale “Hub cached ETag” next to the right revision.
- **The hop-by-hop strip must not widen the page.** Grid children need `minmax(0, 1fr)`.
- **Reused CSS class names collide:** the legend's `.note` picked up the dialog's boxed note style (use `.legend-note`).
- **Don't show raw status codes to students** (“(disconnected)”); say what it means.
- **Scrolling once on append doesn't keep a chat at the bottom.** Forms rendered by the A2UI renderer finish after insertion, so the newest form ended 226–839 px below the view, and the unconditional scroll yanked readers who had scrolled up (scrollTop 1074 → 2687). Follow size changes while at the bottom; stop when the reader scrolls up. The browser check fails on the old code and passes on the fix (3 runs, 36/36).
- **A barely visible strip isn't a live flow.** Done steps only changed a dashed grey border to a thin green one, nothing showed the hop in progress, and steps the flow never took just said “not observed” — so asking a question looked like nothing happened. Fill steps in the acting agent's color, highlight the step in progress, and mark skipped steps with the reason.
- **Keep the strip's step status short.** A “✓ 11:14:01.154” line with `nowrap` widened every step and pushed step 9 off-screen; the check mark goes beside the step name instead.
- **Tabs that are buttons can't be opened in a new tab.** Make them links with real addresses, let modified clicks through, and serve the page at those paths.

**Hub, registry and tests**
- **Tests must wait until the Hub follows each specialist's telemetry feed**, not just until it's `ready`, or the first run's specialist events are missed.
- **Test helpers must kill the stack's current processes.** A restarted specialist captured in a closure was never killed and kept the runner alive for minutes. Also kill everything when a stack fails to become ready.
- **Pre-pick specialist ports.** The Hub's configuration must name each specialist's endpoint before it starts, so `PORT=0` can't be used for specialists in tests.
- **Test processes must not register with a real local Hub.** Default `HUB_URL` to a closed port in the test environment.
- **A deliberately disabled specialist never becomes ready** — let tests say which must be ready (`readyAgents`).
- **Takeover protection delays a restart:** a specialist restarted after a crash is refused (`identity_in_use`) until its old heartbeat expires.
- **Redact with an allowlist, not a denylist.** A list of “sensitive” field names let receipts (dates, times, room, group size, tutoring preferences) and model-written scope/intent reasons through, and would pass any new field too (found by a post-commit security review). The first fix exempted every event without a `runId`, which a second review caught: exempt event types by name, never by a missing field.
- **The Hub must not log or relay content.** Its reused A2A client logs message text unless told not to.
- **A Hub-answered reconcile carries no specialist “duplicate” marker** — assert on the Hub's `request_repeat` and a single dispatch.
- **Form-action failures need distinct Hub statuses:** `not_delivered` vs `outcome_unknown`; a plain “rejected” hid the difference.

---

## Enhancements merged into this step

- **No budget step; ready means live** (your standing instructions, which take precedence over the Part 7 prompt's “ask before live calls”): live checks ran and were reported, and the app is handed over in live mode.
- **Design decisions made while building:** control messages as typed A2A data parts handled before any student check; Hub-side chat-request and form-operation ledgers; forms returned as the Hub's own task; telemetry labelled server-side and redacted by default; specialist settings through a Hub developer proxy; the four-process launcher.
- **Live Playwright pass (original Part 7):** chat to both specialists, clarify → “yes” → form, unsupported, a full study-room booking with live review, a tutoring request with a flagged typo and Send anyway, a Library outage (unavailable, “Not registered”) and re-registration, a skill edit reaching the Hub in ~0.2 s, reload, reduced motion, keyboard, dark mode and phone width. It found and fixed the stale ETag, the raw status wording and the inconsistent form-card label.
- **The model provider in the topology** (“in the topology also have the model provider showing in there as well”): the Hub's live router reports its own calls, and provider traffic is drawn only for real live calls. Verified live: routing → scope check → answer, in order.
- **One model box per agent** (“seems like we need one small model provider connected to each agent because each one can set their own model”): the shared provider node became one box per agent with its own status, calls, failures and last call.
- **Model settable per agent** (“make the model settable per agent”): `model` block per agent, `<ROLE>_MODEL` overrides, own key variable, checked model list with prices (`src/models.js`), startup refusal for unknown models. Verified live with Hub on Haiku 5.5, Tutor on Sonnet 5.5 and Library on Opus 5.5 (about $0.024), then handed back on Haiku everywhere.
- **The Student's own model** (“add a model to the student to clarify questions and do smart routing based on capability … a request that is not obvious which agent it goes to”): the Hub card's capability skills, the Student planner, `requestedCapability` honored by the Hub, the `student-model` line. The first live run exposed the keyword-as-decision bug, fixed before handover. Verified live on Haiku 5.5: the calculus-reading question routed by the Hub to the Library; “Can someone go over chapter three with me before Friday?” clarified, then sent to Tutoring as the Student's choice.
- **A live hop-by-hop strip for every question** (“anything that I do on the chat should show the boxes highlighting on the hop by hop … this should reflect true flow for each chat question and be reset with the next one”): a ninth step for the Student's check, step states with the in-progress highlight, agent colors, notes from the real events, and skipped/failed/unknown steps with reasons. Verified live in the browser: a library question (in progress moved Hub routed → Specialist replied, all nine done, Library color), an unsupported question (specialist leg skipped, “Hub answered itself (not supported)”), a vague question (Student asked first, every later step “not sent”), reload replay, and all nine fitting without scrolling.
- **A separate address per tab** (“make each of the links have their own slug so it can be opened in its own tab”; you chose path slugs and “/ opens Conversation”): tabs became links to `/conversation`, `/activity`, `/topology`; the remembered last tab was removed at your choice. Verified in the browser: direct load, click, Back, Cmd-click into a new tab, arrow keys, root address.
- **Reliable scrolling to the bottom** (“there is scrolling issues with the chat interface that does not go to the bottom of the page reliably”): the bottom-follower above, plus a repeatable browser check. Verified with playwright-cli: the old code failed 4 of 12 checks, and the fix passed 12 of 12 in 3 consecutive runs.
- **In-chat spinner after 1 second** (“include a small in chat spinner if the answer is taking more than 1 second to arrive and clear it when the answer arrives”). Verified live: none at 0.5 s, shown at 1.5 s as the last chat item, gone when the Library's answer arrived.
- **Enter to send, Shift+Enter for a new line, and a cleared box after sending** (“when I hit enter on the chat box it should send, when I hit shift enter it goes to next line. Also after sending the text box should be cleared”). Verified in the browser with real key presses: blank Enter sends nothing, Shift+Enter gives two lines, Enter sends both lines and empties the box at once, and a failed start puts the text back.
- **The Student answers clearly unsupported questions itself** (you chose “option 1 … and if they say I dont know and are ambiguous it goes to university hub”): `decline` when the Student's model is confident; unsure model answers and “I don't know”-style replies to its clarifying question go to the Hub. Verified live: toilet plumbing answered by the Student with nothing sent; “chapter five” clarified; “I don’t know” sent to the Hub with no second Student model call.
- **Full e2e run with playwright-cli** (your request after Part 8): every Part 1–8 scenario plus new phrasings, live. It found the clarify-swallowing bug (fixed above) and a browser crash on redacted review flags (the flags list arrives as “[n items redacted]”; the Library console now says how many items, with details hidden, instead of crashing or claiming a flag).
- **Telemetry redaction became an allowlist** (automated security review after the Part 7 commit): receipts reduced to their ID, model reasons and unknown fields masked; configuration exempted by event type, not by a missing `runId` (second review); a unit test pins both.
- **Final state:** 115 tests passing; live stack on Haiku 5.5 for all four agents. Committed as “Add Part 7”, right after the separate Part 6 fix `99f4f38` (concurrent form submissions), followed by the redaction fixes `ecb79af` and `520b83a`.
