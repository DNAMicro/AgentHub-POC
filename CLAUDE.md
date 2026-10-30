# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A protocol-connectivity spike: two separate Node.js processes talk over the real A2A protocol (v1.0, JSON-RPC binding) using `@a2a-js/sdk` 1.3.0. `src/tutor-agent.js` is the A2A server (Agent B); `src/student-agent.js` is the A2A client (Agent A). `src/ui-server.js` + `public/` add a browser monitor that hosts the Student in-process and visualizes the exchange. Part 3 adds an A2UI v0.9 form the Tutor sends inside A2A and the browser renders with the official `@a2ui/lit` renderer. Part 4 lets the Tutor answer chat with Claude Haiku 5.5 (`claude-haiku-5-5`, `@anthropic-ai/sdk` 1.3.0) in `TUTOR_MODE=live`; the default `fixed` mode keeps the deterministic Part 1 reply. Part 5 adds a deterministic **Library Agent** (`src/library-agent.js`, :41242), **routing** (`src/router.js`) over a trusted registry, editable per-agent **skill configurations** (`src/skills.js`, `src/agent-settings.js`) with `agent_card_changed` notifications (Part 7: to the Hub, not the Student), and **scope enforcement** on the receiving agents. Part 6 lets agents send A2UI workflow forms when asked in chat. Part 7 adds the **University Hub** (`src/hub-agent.js`, :41243, public name “California State University Fullerton”): the Student talks only to the Hub, which holds the private registry (`src/hub-registry.js`), runs the router, forwards/relays over A2A, maps forms by opaque `formRef`, and feeds the browser's tabs (Conversation, Agent activity, live Topology). Part 8 lets the Library's model compose loan-renewal UI from the A2UI catalog. Part 9 adds the **Marketing 101 Professor** (`src/professor-agent.js`, :41244) behind the Hub; it answers questions and **posts lessons** Professor → Hub → Student as new signed A2A interactions into the Student agent's persisted inbox (inbound endpoint on the UI server), with a fourth **Professor view** tab. See README.md for the hop-by-hop walkthrough and version rationale.

## Most important rule
- EVERYTHING you say must be based on evidence and not assumption.
- You must always check with your eyes anything you work on to ensure that the result matches what the tools output if not you must fix both the tools and the work Never realy on someone else's word..
- When asking question you must ask one question at a time in chat format so I have the opporunity to discuss and get clarification.
- Always timestamp your messages in the format of "%A, %b %d, %Y %I:%M %p %Z" based on the local machine's timezone.

## Before anything how to communicate
From now on, explain things in a plain-English tone. Easy to understand, like a clear explanation to a developer who knows the project but does not want dense technical language.
Rules:
- Use simple words and language.
- Always start by giving background and context.
- Avoid heavy jargon unless it is necessary.
- When you use a technical term, explain it briefly.
- Prefer short sentences.
- Explain what happened, why it matters, and what we should do next.
- Do not overuse words like "lever," "inert," "confounded," "axis," "governance
  fields," or "slot mechanics" unless you explain them simply.
- Replace abstract language with concrete meaning.
- Use small tables only when they make the answer clearer.
- Always end with a clear recommendation.
Format every update like this:
1. **What happened**
2. **What it means**
3. **What is risky**
4. **My recommendation**
5. **What I am going to do**
5. **Next prompt required from you*
When summarizing diagnostics, separate:
- facts we proved,
- guesses or interpretations,
- what still needs testing.
Keep the tone calm, clear, and practical. Do not sound like an academic paper or
internal research log.

## Commands

```bash
npm run tutor      # server on 127.0.0.1:41241 (override with PORT=...), fixed reply
npm run tutor:mock # deterministic fake model, no network
npm run tutor:live # Claude Haiku 5.5; key from env or .env (TUTOR_ENV_FILE to override) — PAID
npm run smoke:live # paid live smoke test; refuses unless LIVE_SMOKE_MAX_USD is set
npm run library    # Library Agent on 127.0.0.1:41242 (LIBRARY_MODE=mock: line extraction from saved content)
npm run library:live  # Library answers via Haiku 5.5 with code-verified evidence (paid)
npm run student    # Part 1 CLI client, talks straight to a Tutor (TUTOR_URL=http://127.0.0.1:..., not the Hub)
# Forms (Part 6): no form command — ask in chat, e.g. "I want to reserve a group study room"
npm run professor  # Marketing 101 Professor :41244 (mock, labelled); professor:live = Haiku (PAID)
npm run demo       # all five processes, mock models/router (scripts/start-all.js); demo:live = Haiku everywhere — PAID
npm run hub        # Hub :41243, mock router; hub:live (PAID) / hub:direct (everything to tutoring; code default)
npm run ui         # builds bundle, then UI :4444 hosting the Student (STUDENT_MODE=mock), which connects only to HUB_URL; ui:live = Student's own model live
npm run eval:live  # paid Part 5 spot check; refuses unless LIVE_EVAL_MAX_USD is set
npm run build:ui   # esbuild bundle of the A2UI renderer only (output is gitignored)
npm test           # node:test; spawns Hub/specialists/UI as child processes on free ports (HUB_URL defaults to a dead port)
node --test --test-name-pattern="duplicate" test/   # run tests by name
node --test test/form.test.js                       # run one file
# Audience demo of Steps 1–9 on the running app (live, ~12 min): see README "Audience demo"
playwright-cli -s=demo open --headed "http://127.0.0.1:4444/conversation" && playwright-cli -s=demo run-code "$(cat scripts/demo/progression.js)"
```

Each agent reads an optional JSON config (`STUDENT_CONFIG` / `HUB_CONFIG` / `TUTOR_CONFIG` / `LIBRARY_CONFIG` / `PROFESSOR_CONFIG`; examples in `config/*.example.json`) over built-in localhost defaults; a few env vars (`HUB_URL`, `TUTOR_URL`, `<ROLE>_MODEL`, …) override it. See `src/config.js`.

Plain ESM JavaScript (`"type": "module"`), no lint/TypeScript. The only build step is the renderer bundle for the browser.

## Stopping test processes (macOS)

- Prefer killing by PID or port: `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`, or save `$!` when backgrounding and `kill` that.
- If you must use `pkill`/`pgrep`, **all options go before the pattern**: `pkill -U "$(id -u)" -f 'src/ui-server\.js'`. BSD `pkill` stops option parsing at the first non-option, so `pkill -f "src/ui-server.js" -U $(id -u)` treats `-U` and `501` as extra patterns — on 2026-10-26 that SIGTERMed ~70 unrelated processes (Chrome/Claude/Codex GPU helpers, system extensions) and blanked every window.
- Never use short or generic `-f` patterns (`node`, `501`, `-U`). Dry-run with `pgrep -lf '<pattern>'` first and confirm only your own test processes match.

## Architecture notes

- **Server layering**: `tutorExecutor` (business logic) → `DefaultRequestHandler` (protocol: assigns contextId/taskId, enforces event ordering) → `jsonRpcHandler` / `agentCardHandler` Express adapters. Every executor call must publish `AgentEvent.message(...)` or `AgentEvent.task(...)` first — including follow-ups on an existing task (re-publish `ctx.task`, then `statusUpdate`).
- **Agent dispatch** (`execute`, Tutor and Library): A2UI DataPart → `formHost.handleAction` (src/form-host.js); otherwise chat → decide answer / clarify / offer the agent's own workflow form / out of scope. There is no "request form" message or endpoint (Part 6 removed `metadata.request` and `POST /api/forms`).
- **Routes are mounted inside the `listen()` callback** so the Agent Card URL contains the real port. Tests rely on `PORT=0`/`UI_PORT=0` and parse the `listening on http://127.0.0.1:<port>` lines — keep those log lines stable. Host/Origin guards (`src/local-guard.js`) are likewise created there.
- **Log shape is a test contract**: tests match `messageId: '<id>'` in the Tutor's `received message` log and count `recorded tutoring request` lines.
- **Three channels — keep them separate**: A2A carries all agent messages; A2UI describes the UI and travels inside A2A; the SSE stream (Tutor `/viz/events` → UI server → browser `/api/events`) only reports real events and delivers the received A2UI payload to the renderer. Never route agent messages over SSE or synthesize events agents didn't emit.
- **Form = one A2A task**: a chat reply that is a form is a Task in `INPUT_REQUIRED` (askTutor returns `{ form }`); every form action resumes it with `taskId`. A completed task can't be resumed (SDK rejects: "terminal state"), so `sendFormAction()` checks `GetTask` first and otherwise sends a new message in the same `contextId` with `referenceTaskIds`. The form host dedupes by `metadata.operationId` (same values → stored result; different values → rejected).
- **Delivery outcomes** (`deliveryOutcome` in student-agent): failures before `sendMessage` starts or ECONNREFUSED → `not_delivered`; timeout/network error mid-send → `uncertain` (never auto-retried; retry must reuse the submissionId).
- **Validation runs in three places** from one module (`src/forms.js`): browser (A2UI `checks` + `validateFinal`), UI server, issuing agent (authoritative). `forms.js` must stay dependency-free — the browser imports it from `/shared/forms.js`.
- **Run state lives in the UI server** (`NEXT_STATES`, forward-only). Tutor viz events arrive on a separate connection and may land *after* the A2A reply; tests must wait for them rather than assume ordering. Only POST endpoints start A2A requests; `GET /api/events` replays history (browser dedupes by `seq`, resets on new `bootId`).
- Browser renders its own text via `textContent` — don't introduce `innerHTML`.
- Logs scroll only through `followBottom` (`public/app.js`): never set `scrollTop` directly; call `follow.get(log).pin()` for the student's own actions. Re-check with `scripts/browser-checks/chat-scroll.js` (playwright-cli) after chat/form UI changes.

## Part 4 (model) notes

- `src/tutor-model.js` reads `TUTOR_MODE` **at import time** (module constant). Set env before importing it (see `scripts/live-smoke.js`). Tests that need live behavior run a live-mode Tutor process against `test/support/fake-anthropic.js` via `ANTHROPIC_BASE_URL`, with a placeholder key and `TUTOR_LOAD_DOTENV=0` — never a real key, never real network.
- **Ready = live.** When handing the running app to the user ("it's ready", "restart the servers"), run it in usage mode: `env -u ANTHROPIC_BASE_URL npm run demo:live` (all five processes live; since Part 7 the Hub and Professor must run too, so `tutor:live`/`library:live`/`ui:live` alone are not enough). Mock/fixed modes are for automated tests only; never leave the user on placeholder answers. Paid calls for normal use and verification don't need a pre-approved budget (the `smoke:live`/`eval:live` scripts still take their `*_MAX_USD` env gate).
- Start live servers with `env -u ANTHROPIC_BASE_URL` when launching from Claude Code: its shell sets that variable to a local proxy that answers with fake 429s. The startup line must say `API host: api.anthropic.com`.
- Never read, print, or log the key or the user's key files (`.env`, `.temp`); only report presence as a boolean.
- No hidden retries: `maxRetries: 0`, no fallback model, no canned answers on failure. Errors are mapped to sanitized codes (`toLlmError` in `src/llm.js`); don't pass raw provider messages through.
- Duplicate-call protection is keyed by `(contextId, messageId)` in the Tutor's ledger; the Student reuses the same `messageId` only for reconciling an uncertain outcome. One in-flight model call per `contextId` (`busy` otherwise).
- History is per A2A `contextId`, text-only (no thinking blocks are replayed), append-only per completed exchange (answers and the Tutor's own clarifying questions — never refusals or withheld drafts), bounded to 10 messages / 12,000 chars. Form data is never sent to the model.
- Haiku 5.5: no `temperature`/`top_p`/`top_k` (400 on API version 2026-10-21), thinking counts toward `max_tokens` (hence `effort: "low"` with the 800-token cap), always check `stop_reason` (`refusal`, `max_tokens`) before using content.
- Message contents are logged only when `LOG_CONTENT` is on (default on in fixed/mock — earlier tests read Tutor logs — off in live; `TUTOR_LOG_CONTENT` overrides). The UI server sets `STUDENT_LOG_CONTENT=0`.

## Part 5 (routing, skills, notifications, scope) notes

- Modes are read **at import time**: `TUTOR_MODE` (tutor-model), `ROUTER_MODE` (router; code default `direct` so Part 2–4 tests that spawn `src/ui-server.js` without env keep their behaviour), `TUTOR_SCOPE_ENFORCEMENT` (default on; Part 4 plumbing tests set `off` because scope checks add model calls).
- **Single source of truth**: a skill config → `buildCardSkills` (card), `buildScopeExtension` (`urn:a2a-spike:skill-scope:v1`, our documented extension — don't invent standard A2A fields), `policyFromConfig` (runtime). Save swaps all three atomically by mutating the live card object the SDK serves. Skills have no handlers: each has `kind` (`answer`, or `form` only for the reserved Tutor id `student-details-form`) and private `knowledge` ("answer content", never on the card). Per-agent `rules` decide whether knowledge is required (Library) or optional reference notes (Tutor). The Library answers only from that content (`src/library-model.js`): mock extracts lines; live must return evidence lines that code verifies verbatim before release.
- **Trust boundaries**: destinations come only from the Hub configuration (`loadHubConfig().peers`). Router output is validated by `validateDecision` (agent+skill must be in the live registry view); fetched cards by `validateCard` in `src/cards.js` (name, single JSON-RPC 1.0 URL equal to the registered one, no security changes). Notification contents are hints only — never apply skills/URLs from them.
- Cards are fetched with `node:http`, not `fetch`: undici adds `Cache-Control: no-cache` to conditional requests, which makes Express return 200 instead of 304.
- **Express 5** calls the `app.listen` callback with the error (e.g. EADDRINUSE) — always check `err` first.
- Agent viz events now come from both agents; the UI server relays them with `source: agentId`. Config events (`skills_saved`, `card_notification`) have `runId: null`. Tests use `chatVia` / `startTrio` in `test/support/harness.js` and assert the **actual destination** via the receiving agent's own `message_received` event and the reply's `servedBy` (from reply `metadata.agentId`).
- Mock classifiers/routers are labelled heuristics (term sets derived from the saved config); they prove plumbing, not accuracy. Live judgments are probabilistic — don't claim otherwise.
- Configuration changes and notifications must never trigger model calls.

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

## Audience demo (keep it current)

There are two demos. **v2, the live walkthrough** (`scripts/demo/live-walkthrough.js`, README "Live walkthrough"): a visible person uses the app in the left window while a `/topology` popup on the right animates each hop; it waits for the presenter's key after every moment (→/PageDown/Space next, N skip step, H hold), with no captions or slides. It is **generated**: edit `scripts/demo/walkthrough/frame.js` or `scene-N.js` (one `scenes.push({...})` each, using only the frame's helpers), then `npm run demo:build`. Rehearse with `node scripts/demo/rehearsal-stack.js --ui <port> --base <port>` (its own ports and temp data copies) and `?auto=4&shots=<dir>`; look at both windows' screenshots. Notes: playwright-cli pages are tabs of one window, so the right window is a `window.open` popup; run-code has no working `setTimeout`/`setInterval`, so the frame polls with `waitForTimeout`; type only through the frame's helpers (no `fill()`); every model-dependent moment must check what really happened with `seen()` and end honestly. `npm run demo:reset-loans` restores the loans before a talk (refuses while the Library runs).

**v1** `scripts/demo/progression.js` presents the build part by part (one `PARTS` entry per step: slide text + a `run` scene). When a new part ships, add its entry (and its pill in `STEPS`). Before handing it over, rehearse it **on a separate stack**, never the user's running demo: its default fresh start presses New conversation, which resets the classroom. Use `?shots=<dir>&pace=0.15` and look at the screenshots. Notes:
- run-code has no `URL` global: read the address through `page.evaluate(() => location…)`.
- A2UI field labels also appear in the form's error summary. Locate fields by the **first** matching label (`field()`).
- Submitting a form: wait until the button is detached (the form became its “You sent” summary) or “Send anyway” appears (`submit()`), not just until the run is idle.
- Highlights use `visibleBox`: the box is clipped to the scrolling chat, and a tall item is scrolled to its top.
- Live judgment varies, so every scene must handle the model answering in words or asking a clarifying question.

## Steps folder (keep it current)

`Steps/` holds one file per build step (`NN-short-name.md`) plus `Steps/README.md` (index table + rules for all steps). At the end of every step, and after any later enhancement to an existing step, write or update that step's file so it is the **final version's prompt**: the user's original wording with every enhancement merged into the instructions themselves (so running the steps in order rebuilds the current app), plus an "Avoid these known problems" section listing every bug, wrong assumption or user-reported issue hit during the step (written as instructions so a rebuild avoids it), followed by an "Enhancements merged into this step" section saying what changed and why. Add the new step to the README table. Take the original prompt from the user's message verbatim (drop "Copy this into Codex" lines).

## Part 6 (conversational workflow forms) notes

- Workflows live in `src/forms.js` (`WORKFLOWS`): `tutoring-request` (Tutor skill `in-person-tutoring-request`) and `study-room-booking` (Library skill `study-room-booking`). Each is the agent's reserved `kind: 'form'` skill; disabling it blocks both new forms and actions. Actions are allowlisted per workflow with their button ID and fields.
- **Prefill comes only from `src/form-intent.js` parsing the student's words** — never from model output; names/emails/notes are never prefilled. Live mode asks the model only for the outcome (new verdicts in the Tutor's scope check and the Library's structured call).
- **Form lifecycle is owned by the UI server** (`form_lifecycle` events): `editing → submitting → accepted | rejected | confirmation_pending`, `editing → cancelled | superseded`. The browser (`public/forms-ui.js`) removes the surface with the standard A2UI `deleteSurface` on a valid submit, and only re-renders forms still `editing` after the `replayed` SSE marker. Late events for closed forms are ignored.
- One editable form per workflow per conversation: the agent asks "continue or replace?" (`wantsReplacement`); the UI server also refuses to render a second one. A repeat of the same chat request (same messageId) gets the same form back (`formHost.formForRequest`).
- Room booking: availability only from `createRoomStore().listStudyRoomAvailability`; slot IDs are opaque and per form; `reserveStudyRoom` is synchronous check-and-set (no `await` between check and write) — keep it that way. Review is required before confirm.
- The test schema validator checks formats (date/time/date-time): DateTimeInput `min`/`max` must be `YYYY-MM-DD` or `HH:MM:SS`, otherwise the schema's `oneOf` fails.
- **Advisory review before recording** (`src/form-review.js`, `reviewGate`): after the code checks pass, the agent reviews all fields (live: Haiku with every field incl. name/email; otherwise a heuristic). It can only return `needs_review` with flags — the UI server reopens the form (`editing`, `review: true`); "Send anyway" (`acknowledgeReview`) skips the review only for the exact values already reviewed. Review failures fail open. Agent server logs still redact names/emails; lookups send scheduling fields only.

## Scope constraints

Do not add token streaming, push notifications, multi-agent fan-out (the Hub forwards to at most one specialist), mailboxes, database, auth/accounts, real email sending, frontend frameworks, model tools, model-generated code/HTML, or deployment unless explicitly asked. Model-generated UI exists only in Part 8 (Library loans), only from the validated catalog. Only the Student (`STUDENT_MODE=live`: clarifying and capability choice), the Tutor (answers, scope checks), the Hub's router, the Library in `LIBRARY_MODE=live` and the Professor in `PROFESSOR_MODE=live` call the LLM; form validation stays deterministic. All servers must stay bound to `127.0.0.1`. Records are in-memory by design, except the JSON files under `data/` (Part 8 loans; Part 9 Hub lessons, Student inbox, Professor outbox). Part 9's per-process signing keys and the Student's lesson inbox were explicitly requested — they are not accounts, real auth or a general mailbox. Keep dependency versions pinned exactly. Use fictional sample data only (e.g. Alex Student, alex@example.com).

## Part 7 (University Hub, topology) notes

- **Topology is fixed:** Student → Hub → Tutor/Library. The Student config (`src/config.js`) forbids specialist URLs; specialist endpoints come only from the Hub's configuration (`TUTOR_URL`/`LIBRARY_URL` override them). Configuration is validated at startup and throws `ConfigError` — never fall back to direct routing.
- **Control messages** (register, heartbeat, deregister, card changed) are typed A2A data parts handled by the Hub executor before any student check (`CONTROL_MEDIA_TYPES`). Registration requires the claimed endpoint to equal the configured one and refuses a second live instance; the card is fetched from the configured URL before `ready`. Registered ≠ ready: statuses are `ready`, `stale`, `unreachable`, `disconnected`, `disabled`, `invalid_card`, and only `ready` gets dispatches (otherwise the decision becomes `unavailable`).
- **Two A2A legs, separate IDs:** the Hub reuses `askTutor`/`sendFormAction` downstream with its own messageId and a per-(conversation, specialist) context. Chat repeats are answered from `chatLedger` (keyed by upstream contextId+messageId); form actions are deduped by operationId in `operations` (only definite results are cached — `outcome_unknown` is not, so a reconcile can forward again and the specialist dedupes).
- Form actions must carry `formRef`; the Hub checks student, conversation, expiry, supersession and surfaceId, then forwards to the recorded issuer. Hub replies to the Student use `status: 'outcome_unknown'` / `'not_delivered'`, which `sendFormAction` turns into `uncertain` / `not_delivered` errors.
- **Telemetry:** the UI server follows only the Hub's `/viz/events`; the Hub relays specialist feeds with `source: agentId`, **redacted by an allowlist** (`redactTelemetry`: safe IDs/status/timing fields only; receipts → ID and status; only the config event types status/skills_saved/card_notification/hub_registration pass unchanged — never exempt by missing runId) unless `HUB_TELEMETRY_SHOW_CONTENT=1` (tests that compare received values set it). `src/topology.js` labels events (edge, from/to, category, phase); the browser animates only labelled live events, buffered ~350 ms and sorted by `at`. Heartbeats are ephemeral (never in history). Event IDs are `<bootId>:<seq>`; `Last-Event-ID` resumes; `UI_HISTORY_LIMIT` bounds history with a `truncated` notice.
- Tests: use `startStack` (alias `startTrio`) — it pre-picks specialist ports so the Hub config can name them, waits until the Hub follows each specialist's feed, and kills its *current* processes (a restarted one included). Use `readyAgents` for deliberately disabled specialists. Telemetry may lag the A2A reply — wait for Hub/specialist events, don't assume order.
- **Model provider node:** the Hub (live router), Tutor and Library report `model_call_started` / `model_response_received` / `model_call_failed` (the Tutor's live scope check: `scope_check_started` with `mode`, `scope_checked` with `usage`). `src/topology.js` turns these into `<caller>-model` hops only for live calls (mock → inside the agent; `missing_credentials` → no call). The browser (`public/topology.js`) draws each `<caller>-model` hop at that caller's own model box (`llm-student`, `llm-hub`, `llm-tutor`, `llm-library`) — there is no shared provider node.
- **Student's own model** (`src/student-assistant.js`, `STUDENT_MODE` off (code default) / mock / live, read at import): before sending, `planAndSend` in ui-server matches the question against the Hub card's **capability skills** (one public skill per destination, built from `cfg.destinations` name/tags/examples — never worker names or URLs). Exactly one match = obvious → sent as-is, **the Hub's router decides** (a keyword is not intent: “reading for my calculus course” is a library request). Zero/several matches → the Student's model returns `send` + capability ID (or `none`) or `clarify`; a reply to the university's own question goes on unchanged (`asksStudent`: last sentence ends with “?” or is an invitation such as “If you tell me which book you meant…”). Every model-facing history (Student, Hub router, Tutor scope check, Library, loans, Professor) keeps each earlier reply as `briefReply` (src/llm.js: start + end) — never a head cut, which drops the closing question; the Student, router and Library prompts treat naming an item from the last reply (“claculus” after a loan list) as a follow-up to that service. A bare “yes” to an either/or clarifying question is re-asked once in code (`reasked`, keeps `pending.original`), then goes to the Hub undecided; the router re-asks on its own either/or question. A clarification holds the question (`conversations[ctx].pending = { original, clarificationQuestion }`); the next message is classified by `planRequest({ pending })` as `answers_question` (sent as question + `(Your Student agent asked: “…”)` + answer — `askedLine`/`withoutAsked` in router.js; keyword heuristics skip that line; at most one clarification) or `new_request` (sent alone) — live: the same single model call returns `relation`; mock: labelled heuristic; “I don't know” always → Hub with the held question. The capability travels as `metadata.requestedCapability`; the Hub honors only its own destination IDs (`decidedBy: 'student'`, no router call; readiness still checked), emits `capability_rejected` otherwise. Model failure fails open to the Hub's routing, visibly (`by: 'model_failed'`). A confident `decline` is answered by the Student itself (`request_declined`, nothing sent); an unsure model (`none`) or an “I don't know”-style answer to its clarifying question (`UNSURE` regex, by `uncertain`, no model call) goes to the Hub.
- **Per-agent model:** each model-using agent has `model: { name, apiKeyEnv }` in its config (`STUDENT_MODEL` / `HUB_MODEL` / `TUTOR_MODEL` / `LIBRARY_MODEL` override the name), validated against `src/models.js` and applied with `useModel()` at startup; code reads it via `modelName()` / `keyEnvName()` — never a module constant. Only list a model there after checking it accepts what `callModel` sends (effort `low`, structured output, no sampling params) and adding its official price. Unknown names are a `ConfigError`, never a fallback. Startup logs name the key *variable* (`API key (ANTHROPIC_API_KEY): configured`), never the value. Never probe the provider to show its status.
- **Hop-by-hop strip** (`public/app.js`: `STEPS`, `flowStep`, `markStep`, `skipSteps`, `updateActiveStep`): steps have `data-state` pending/done/skipped/failed/unknown and `data-active` for the step in progress; `flowStep` maps each real event to its step and marks steps the flow didn't take as skipped with the reason. Only real events mark steps — never infer one.
- Specialists sign out on SIGTERM; tests that need a crash use `SIGKILL` and wait for heartbeat expiry (3 s in tests).


## Part 8 (model-generated UI for loans) notes

- **Flow:** Library classification (`my_loans`, live verdict or the labelled `mockOwnLoans` heuristic — how-to questions stay with the knowledge skills) → `handleLoans` in `src/library-agent.js`: borrower = `hubLink.verifiedStudent(metadata, contextId)` — the conversation's owner as **signed by the Hub** (`hubSignature` = HMAC of `studentId|downstream contextId|hubOperationId` with the per-process `callKey` the specialist sent at registration; `registry.signFor`). Never from the model, the browser or a bare metadata field; unsigned/forged → no loan data. Never log, emit or snapshot `callKey`.
- **Responsibilities:** `src/loan-store.js` (authoritative facts, policy, idempotent persisted renewals; `LOAN_STORE_FILE`), `src/a2ui-catalog.js` (model-visible catalog generated from the installed `@a2ui/web_core` schemas; `validateGeneratedUi`), `src/loan-model.js` (one structured call → `answer | clarify | ui` with `components_json`/`data_model_json` strings; ≤2 repairs from validator errors; truthful fallback; mock = labelled text, never UI). Never add a template that the model selects by id.
- **Generated workflow** `WORKFLOWS['loan-renewal']` (`generated: true`) has operation contracts, no fixed buttons: `checkAction(..., { buttons: surfaceButtons(messages) })` is required everywhere (form host, UI server). `checkFormPayloadPolicy/UpdatePolicy(..., { workflowId })` widen the component/function set only for generated workflows (`GENERATED_COMPONENTS`, `GENERATED_FUNCTIONS`: basic catalog minus Image/Video/AudioPlayer/openUrl).
- **Validator rules** (keep them deterministic): official JSON Schema; allowed set; registered operations with exact inputs; renew button = literal ELIGIBLE loanId + returnDate bound to a date-only DateTimeInput whose min/max equal `permittedReturnDates`; no input starting at a backend due date; no Slider/TextField supplying operation inputs; dates only from loan data (incl. any day inside an eligible loan's permitted range) or the student's words (`datesIn`, year-insensitive); no Markdown; refs/root/cycles; ≤80 components, depth ≤10, ≤48 KB.
- **Form host:** `issue({ payload, version, data, extra })` for generated surfaces; handlers receive `operationId` and `trusted` (incoming metadata). `renewLoan` re-checks the borrower against `form.data.borrowerId` and the version captured at generation (`form.data.renewable`).
- **Skills:** a second built-in form skill per agent is allowed (`rules.form = { ids: [...] }`, `formIdsOf`); the Library's are `study-room-booking` and `book-loans`.
- **Telemetry:** `ui_generated` carries `inspector` (exempted by type+field in the Hub's allowlist — agent output and synthetic loan facts only), `loan_operation`; receipts reduce to `{ requestId, bookingId, renewalId, status }`; `prefilled` passes only as a list of field names.
- **Tests:** `test/loans.test.js`; scripted model output via the fake Messages API (label it: plumbing, not judgment). Every test Library gets `LOAN_STORE_FILE=freshLoanStore()` (harness) — never the demo's file. The Hub's MOCK router needs unambiguous library wording ("my borrowed library book"); natural phrasings are checked live.

## Part 9 (Marketing 101 Professor, reverse route) notes

- **Reverse route = a new `message/send`** with one typed data part (`src/a2a-data.js` `sendData` → `{ ok, value }` or `{ ok: false, outcome: not_delivered | uncertain }`), never a task-status push. Media types and HMAC helpers are in `src/lessons.js`; the Hub handles `HUB_LESSON_MEDIA_TYPES` before any student check, the Student's inbound executor (`src/student-inbox.js`) accepts only `STUDENT_INBOUND_MEDIA_TYPES`.
- **Every Hub caller is signed** with a per-process key given at registration (memory only): specialists (Part 8), the Professor's publishes (`hubLink.sendSigned`), and the Student (session via `student_session` + a **challenge to the configured `studentEndpoints` URL**; then `metadata.studentSignature` over `[studentId, contextId, messageId]`). Unsigned student requests are refused. A signed request must choose its own `contextId` (`askTutor` does when given `signer`). Never log or emit keys.
- **Tests that call the Hub directly** must use `signedStudent(hubUrl, id)` from the harness (a student with no configured endpoint, e.g. `student-sam` via `HUB_STUDENTS`); `student-alex`'s session belongs to the UI. A second UI for the same student is refused — start its own stack.
- `startStack({ professor: true })` pre-picks the UI and Professor ports (Hub gets `STUDENT_URL`/`PROFESSOR_URL`), gives each process temp `HUB_LESSON_FILE` / `STUDENT_INBOX_FILE` / `PROFESSOR_OUTBOX_FILE`, and waits for `student.session === 'registered'`. Never let tests touch `data/*.json`.
- **Honest states:** "delivered" only after the Student commits the inbox entry (`createJsonStore` writes before the reply); "opened" only from `POST /api/inbox/:id/open`; uncertain deliveries are **queried before re-sending**. Operation ids dedupe at the Professor outbox and the Hub (persisted); `deliveryId` dedupes at the Student. The availability notice id is stable per course (`av-<courseId>`).
- **Professor view = chat**, never a form. Without `@assistant` a message is a **direct post** (`directPost`: the professor's words, to tagged students — tags start the message or follow whitespace, so emails aren't tags — or `all`; `classifyPost` only names kind/title) shown on the professor's own bubble. With `@assistant`: `POST /author/chat` → `interpretProfessor` (model decides post/answer/clarify, kind, audience, title, content; mock is a labelled heuristic) → `checkPost` (professor's tag wins; single recipient must be tagged/named; verbatim only if really the professor's words; no dates the professor didn't write; course lessons from the pack) → `createPost`. Chat is persisted in the outbox; one message at a time; operationId dedupes.
- **Every non-GET developer route is origin-guarded** (Hub `/dev/*`, Professor `/author/*`): `sameOriginGuard` refuses cross-site browser POSTs; server callers send no Origin. Keep this when adding routes.
- `lesson_queued` is emitted once per delivery when it starts waiting (not every retry cycle).
- **Don't run reset/destructive checks on the user's running demo** — start a separate stack (`startStack`, temp data files) instead.
- **Posts** have `kind` (`lesson` | `message`) and `audience` (`all` | one or several comma-separated enrolled student ids). The Hub expands `all` from `cfg.courses[...].enrolled` (never a list from the Professor) into one delivery per student; acks carry `deliveries[]`; the Professor view shows per-student states. Demo roster: student-alex (UI) + student-sam (enrolled, no endpoint → always queued). Registration without a configured endpoint is refused (`no_student_endpoint`) unless `HUB_TEST_STUDENTS_WITHOUT_ENDPOINT=1` (harness sets it).
- **New conversation = classroom reset** (demo): UI publishes `conversation_reset` first (screens clear), then `inbox.reset()`, Hub `POST /dev/classroom/reset` (clears lessons/operations/deliveries/notices for every student, re-announces once, calls each professor's `POST /author/reset`), then publishes `classroom_reset` with the outcome. Sessions stay; in-flight deliveries check their record still exists before writing.
- **Follow-ups** carry `lessonDeliveryId`; the Hub routes by its own delivery record (`lessonRoute`, `decidedBy: 'lesson'`), never by keywords or the student's claim. The route reason names the lesson by **id** only — `reason` passes telemetry, titles must not.
- A `deliveryId` in the publish ack = **Hub accepted** (`hubAccepted`); only an unanswered Professor→Hub leg is "not confirmed" and re-sent. A refused connection marks the Student session `unreachable` (offline in the roster, no retries until it re-registers).
- **Messages are chat, lessons are inbox.** A delivered `message` renders as a chat bubble (from `lesson_received`, which carries its text) with ↩ Reply (`lessonDeliveryId`, chip clears after one send) and is marked opened when seen (IntersectionObserver); the inbox lists lessons only. Posts carry `author` (`professor` | `assistant`), inside `contentHash` (unchanged for the professor's own posts). A reply to the professor's own message is **relayed** (no model; `professor.outcome: 'relayed'`) into the professor's chat (`role: 'student'`); a reply to the assistant's message is answered `onBehalf` (may return `needs_professor`, accepted only then); every delivery-linked exchange is copied into the professor's chat (`recordReply`). The professor answers one student with `replyTo` on `/author/chat`.
- **Meetings:** the assistant's `schedule` decision never carries times — `slotsIn` (`src/meeting-times.js`) reads them from the professor's words (none → ask, `pendingMeeting`). The offer is an assistant `message` with `meeting` (validated by `validMeeting`, inside `contentHash`); a pick is `meetingSlot` on a lesson-routed reply, booked by `bookSlot` (synchronous check-and-set; keep it that way).
- Without an attached lesson the Professor still gets **its own recent posts to that Hub-verified student** (`postedTo`, ≤5) for course questions. Router text the student reads goes through `publicWords` (public service names, never agent names).
- Lesson text is content: `textContent` only, no actions from it; the Professor's prompt marks it untrusted and code rejects dates not in the lesson/question.
- Run-less specialist events reach the browser only if listed in the UI server's `CONFIG_EVENTS` (`lesson_posted`, `lesson_publish_result` added).
- Inspector (`ui_generated.inspector`) is **structure only** by default (`structureOnly` in hub-agent); full text only with `HUB_TELEMETRY_SHOW_CONTENT=1`.
- Killing a test process with a signal leaves `exitCode === null`; check `signalCode` before awaiting `exit`.
