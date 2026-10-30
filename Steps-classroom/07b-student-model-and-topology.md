# Step 7b — Seeing it live: the Student's own model, tabs and topology

Time: about 90 minutes. Cost: free (tests use mocks). Optional live check: PAID, a few cents.

## What you'll see when it works

- The page has three tabs, each with its own address: `/conversation`, `/activity`, `/topology`.
- A nine-step hop-by-hop strip lights up live for every question, in the color of the agent doing each step.
- The Topology tab shows Student ↔ Hub ↔ Tutor/Library, each agent with its own model box. Pulses move only for real events.
- A vague question ("I need help") gets a clarifying question from your own Student agent. Nothing is sent until you answer.
- "How do I fix my toilet plumbing?" is answered by the Student agent itself (live mode). Nothing goes to the university.

## Starting point

Step 7a must be done: the Hub, registry, config files, hub-link, `startStack`, and the Hub relaying specialist feeds through `redactTelemetry`.

Start from the committed code of Step 7a.

## Instructions for Claude (lead)

Use the three phases from Step 0: Contracts → parallel Build → Join and check.

1. Run `npm test` first and confirm it passes.
2. Write the Phase 1 contracts yourself.
3. Start **all four tasks in the table in ONE message** with the Agent tool.
4. Join, run the checks, fix failures, append the CLAUDE.md notes and commit.

Don't stop to ask questions. Everything you need is in this file and Step 0.

## Phase 1 — Contracts (lead writes these first)

1. **`src/student-assistant.js` stub exports:** `STUDENT_MODE` (`process.env.STUDENT_MODE ?? 'off'`; throw on anything but `off`/`mock`/`live`), `PURPOSE = 'clarify & choose capability'`, `studentAssistantStatus()` → `{ mode, model, keyConfigured }`, `matchCapabilities(question, capabilities)` → `[{ id, name, terms }]`, `planRequest(args)`.
2. **Plan result:** `{ text, action: 'send' | 'clarify' | 'decline', capability: id | null, by, reason, relation?, clarificationQuestion?, matched?, likely?, model?, usage?, requestId?, error? }`. `by` is one of `off`, `context`, `uncertain`, `rule`, `heuristic`, `model`, `model_failed`.
3. **Student events** (`source: 'student'`): `request_planned { action, capability, capabilityName, by, reason, relation, matched, model, usage, error }`, `clarification_asked { question, text, contextId }`, `request_declined { question, text, contextId }`, and `model_call_started` / `model_response_received` / `model_call_failed` with `purpose: PURPOSE`. Hub event: `capability_rejected { operationId, capability, reason }`.
4. **`src/topology.js` stub:** `topologyLabel(event)` → `null`, or `{ edge, from, to, category, phase, label, operationId }`, or an inside-node label `{ edge: null, node, from: node, to: node, category, phase, label, operationId }`.
   - Edges: `student-hub`, `hub-tutor`, `hub-library`, `student-model`, `hub-model`, `tutor-model`, `library-model`.
   - Categories: `request`, `form`, `registration`, `card`, `heartbeat`, `routing`, `model`.
   - Phases: `attempted`, `accepted`, `processing`, `completed`, `failed`, `unknown`.
5. **Browser event shape** (UI → browser SSE): `{ seq, id: '<bootId>:<seq>', at, source, type, runId, data, topo? }`. `topo` is `topologyLabel(event)` when not null.
6. **`public/topology.js` stub:** `createTopology({ svg, detail, list, count, traceSelect, truncatedNote, clockEl, controls, onActivity, agentColor })` returning at least `{ event(ev, { live }), snapshot(topology), status(agentId, data), feed(connected), studentBusy(busy) }`.
7. **Page element IDs** shared by Tasks C and D: `#message`, `#send`, `#student-log`, `#live-banner`, tabs `#tab-conversation`, `#tab-activity`, `#tab-topology`, views `#view-conversation`, `#view-activity`, `#view-topology`, topology controls `#topo-heartbeats`, `#topo-reduce`, `#topo-pause`, and the graph `<svg id="topo" class="topo" viewBox="0 0 1100 660">`. Task C writes that `<svg>` (with its `viewBox`) in `public/index.html`; `public/topology.js` draws into it and never sets the `viewBox`.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/student-assistant.js`, `src/ui-server.js`, `src/hub-agent.js`, `src/router.js`, `src/tutor-model.js`, `scripts/start-all.js`, `package.json` (scripts) | The Student planner, `planAndSend`, Hub capability handling, redaction allowlist, resumable event stream, tab routes | `node -e "import('./src/student-assistant.js').then(m=>console.log(m.STUDENT_MODE))"` prints `off`; `PORT=0 node src/hub-agent.js` still starts |
| B | haiku | `src/topology.js`, `public/topology.js` | Server-side labels and the live SVG graph | `node -e "import('./src/topology.js').then(m=>console.log(m.topologyLabel({source:'hub',type:'forward_attempted',data:{agentId:'tutor'}}).edge))"` prints `hub-tutor` |
| C | haiku | `public/app.js`, `public/index.html`, `public/styles.css`, `scripts/browser-checks/chat-scroll.js` | Tabs, hop-by-hop strip, consoles, composer keys, spinner, `followBottom`, the topology `<svg>` | `node --check public/app.js` and `node --check scripts/browser-checks/chat-scroll.js` pass; `grep -c 'viewBox="0 0 1100 660"' public/index.html` prints at least `1` |
| D | sonnet | `test/student-model.test.js` (new), `test/hub.test.js`, `test/ui.test.js` | Tests for this step | Tests pass after the join |

### Task A — Student planner, Hub changes, event stream

**Planner (`src/student-assistant.js`):**

1. Read `STUDENT_MODE` at import. In `live`, load `.env` once (`loadDotenvOnce`). Use `callModel`, `modelName`, `keyConfigured`, `toLlmError` from `src/llm.js`.
2. `matchCapabilities`: multi-word tags (like "study room") match as phrases. Single words match with `tokenize` / `near`, exported from `src/router.js` (export them if Step 5 didn't).
3. Check order in `planCore`: `off` → send (`by: 'off'`). A reply to the university's own question → send as-is (`context`). Export `asksStudent(reply)`: take the reply's last sentence; true if it ends with "?" **or** is an invitation ending with a period — regex `\b(if you(['’]d like| would like| want| tell me| let me know)|let me know|tell me (which|what|more|if)|please (tell|say|choose|pick|reply))\b` (e.g. "If you tell me which book you meant, I can explain its reason in more detail."). A question in the middle followed by a plain last sentence is false. An unsure answer to our question → send (`uncertain`). Exactly one capability matched → send with `capability: null` (`rule`) — **the Hub's router decides**. Then mock or live.
4. `UNSURE` regex covers "I don't know", "not sure", "no idea", "idk", "unsure", "dunno", "either", "whichever", "maybe", "can't say". Match both apostrophes: `don['’]?t`, `can['’]?t`.
5. **Mock** (labelled heuristic): clarify only when nothing matched and the question has fewer than two meaningful words. Otherwise send with no capability (`heuristic`). Mock never declines.
6. **Live:** one structured call, 400 output tokens, `STUDENT_MODEL_TIMEOUT_MS` (default 30000), the last 4 turns. Schema enum `action`: `send`, `decline`, plus `clarify` only while a clarification is still allowed. `capability` enum: the card's IDs plus `none`.
7. The prompt gives capabilities (id, name, description, examples), recent turns, whether clarifying is allowed, and the latest message, each in its own tag. It treats them as data and never outputs URLs.
   - Everything it writes is shown as is: it speaks to the student as "you", never "the student", and never describes its reasoning.
   - Small talk ("hi", "thanks!!") is not declined: reply kindly and, if allowed, clarify with a friendly question.
   - For clarify only `clarification_question` is shown: put greetings and explanations there. "How do I use this?" → one sentence (type what you need in your own words; it goes to the right service), then the question.
   - "What do i do now?" / "did it work?" right after a reply → send to the capability that replied.
8. Code validates the result. Unknown IDs become `null`. `clarify` needs a non-empty question and permission. `decline` needs a non-empty reason.
9. Live failure: emit `model_call_failed`, return send with no capability, `by: 'model_failed'`. Never another model.
10. **Pending clarification:** `planRequest({ pending })` with `pending = { original, clarificationQuestion }`. Every answer is sent as `original + '\n' + askedLine(clarificationQuestion) + '\n' + reply`, where `askedLine(q)` = `(Your Student agent asked: “q”)` — so whoever receives "yes" knows what it answers. An `UNSURE` reply → send that text (`answers_question`, `by: 'uncertain'`), no model call.
    - Put `askedLine(q)` and `withoutAsked(text)` (removes that one line) in `src/router.js`, next to `tokenize`/`near`. Keyword matching must skip the line — the one-capability rule in `planCore` matches `withoutAsked(question)`, and the Hub's mock router strips it before counting — because the question names every option.
11. Mock with pending: 3+ meaningful words that match exactly one capability, not opening like a continuation (`with`, `for`, `about`, `the`, `my`, `yes`, `both`, `that`, …), is a `new_request` sent alone. Otherwise `answers_question`.
12. Live with pending: the same single call returns `relation: 'answers_question' | 'new_request'` (field in the schema only while pending; prompt adds `<pending_clarification>`). Picking one of the offered options ("my library book", "the tutoring one") is `answers_question`. After an answer, the Student may not ask again.
    - **Bare "yes" to an either/or question** (in code, before mock/live): answer matches `^\s*(yes|yeah|yep|yup|sure|ok(ay)?|y|right|correct|please)\s*[.!]*\s*$` and the question contains `\bor\b` → return `{ text: reply, action: 'clarify', by: 'rule', relation: 'answers_question', reasked: true, clarificationQuestion: 'Which one do you mean? ' + question }`. If `pending.reasked` is already set → send the combined text with no capability (`by: 'uncertain'`). A "yes" to a yes/no question is a normal answer.
    - Live prompt, also: a message that names something from the university's last reply (a book or loan it listed, a day, a room — even misspelled, "claculus" after a loan list) continues that conversation: send to the capability that replied, don't clarify.

**UI server (`src/ui-server.js`):**

13. Call `useModel(cfg.model)` at startup. Keep per-conversation state `{ turns, pending }` (6 turns). `followsQuestion` = `asksStudent(lastTurn.answer)`.
    - **History keeps the start and the end of each reply.** Add `briefReply(text, head = 200, tail = 300)` to `src/llm.js`: unchanged when ≤ 503 characters, else first 200 + " … " + last 300. Store every reply in `turns` as `briefReply(text)`, and use it for the `Reply:` lines in the Student's prompt. Also replace Step 5's 300-character snippet with `briefReply` in the Hub's `conv.turns` (both places) and the router's `Reply:` line, and use it for every earlier reply in a model prompt: the Tutor's scope-check history (`briefReply(m.content, 250, 350)`), the Library classifier's recent conversation. Replies end with their question or invitation; a head cut drops it.
    - Put `asksStudent` in `src/router.js` (the Student re-exports it). The mock router's "yes" continuation uses `asksStudent(lastTurn.answer)`.
    - **Hub router prompt** (`src/router.js`), add: when the latest reply asked or invited something, a short answer or a message naming one of the items/options/topics it listed (even misspelled) goes to the service that replied, with the skill it used — a new topic only when it clearly asks for something else; never clarify a message that plainly answers the latest turn; "yes/no/sure" → the service that asked, or the one service the Hub's own clarification offered; a bare "yes/ok/sure" to the Hub's own clarification offering two or more options → clarify again, naming the options.
    - **Library classifier prompt** (`src/library-model.js`), add: a message that just names one of the items its last reply listed ("claculus" after a loan list) continues that loan conversation → `my_loans`, not a clarification.
14. `planAndSend(runId, run)` runs before `sendChat` for new chat runs only, never for reconcile. Each run keeps the typed words (`typed`) apart from the text sent.
15. Publish `request_planned`. On `clarify`: store `pending = { original: plan.reasked ? run.pending.original : run.text, clarificationQuestion, reasked }` (a re-ask keeps the student's original message), publish `clarification_asked`, complete the run with `decision: 'student_clarify'`. Nothing is sent.
16. On `decline`: text = reason + " The university can help with: Tutoring and Library services." (names from the card). Add it to the turns, publish `request_declined`, complete with `decision: 'student_decline'`.
17. On `send` with a capability: pass `metadata.requestedCapability`.
18. Publish the Student's status as `agent_status` (`agentId: 'student'`) and include it in `hello` and `/api/status` (`agents.student`).
19. Startup log: `[UI] Student model: <mode>` (live adds `(<model>), API key (<VAR>): configured|NOT SET, API host: …`).
20. **Tab routes:** serve `index.html` at exactly `/conversation`, `/activity`, `/topology`. `/` serves the page too (static). Any other path → 404.
21. **Event stream:** every published event gets `id: <bootId>:<seq>` and is written with an SSE `id:` line. Add `topo` from `topologyLabel`.
22. History is bounded by `UI_HISTORY_LIMIT` (default 1000). Heartbeats (`EPHEMERAL`) are sent live but never stored.
23. `GET /api/events` reads `Last-Event-ID` (or `?after=`). Same `bootId` and a cursor still in history → send only the missed events (`hello.resumed: true`).
24. Unknown boot or a too-old cursor → full replay plus an `event: truncated` `{ missed, kept }`. Also send `truncated` when history has dropped events. End every replay with `event: replayed`.
25. **Hub (`src/hub-agent.js`):** `metadata.requestedCapability` is honoured only if it is one of `cfg.destinations`' IDs. Map it to that destination's worker, skip the router call, record `decidedBy: 'student'`, and still apply the readiness check.
26. Any other value → emit `capability_rejected` and route as usual.
27. **Redaction allowlist:** replace `redactTelemetry`'s body. Keep the names `SAFE_FIELDS` and `CONFIG_EVENT_TYPES` (Step 8 extends them).
28. `CONFIG_EVENT_TYPES = new Set(['status', 'skills_saved', 'card_notification', 'hub_registration'])` pass unchanged. Never exempt an event because it lacks a `runId`.
29. `SAFE_FIELDS`: `runId, operationId, hubOperationId, formId, formRef, workflowId, taskId, contextId, messageId, inReplyTo, requestId, agentId, skillId, actionName, policyRevision, revision, status, outcome, verdict, stage, decision, mode, model, purpose, by, code, kind, final, lookup, duplicate, repeat, acknowledged, unavailable, truncated, stopReason, taskState, resumedTask, violates, handler, reviewer, latencyMs, earlierMessages, chars, usage, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, tutor, library`.
30. Every other field is masked: strings → `[n chars redacted]`, arrays → `[n items redacted]`, objects → each key `[redacted]`. Safe nested objects follow the same rules up to depth 2.
31. A `receipt` becomes `{ requestId, bookingId, status }`.
32. `HUB_TELEMETRY_SHOW_CONTENT=1` turns redaction off.
33. **Tutor:** make sure `scope_check_started` carries `mode` and `scope_checked` carries `usage` for live calls (`src/tutor-model.js`).
34. **Launcher/scripts:** in `scripts/start-all.js`, the `ui` process gets `STUDENT_MODE: live ? 'live' : 'mock'`. Set the 7b scripts from Step 0: `ui`, `ui:live`.

### Task B — Labels and the live graph

**`src/topology.js`:**

1. Label only events listed here. Labels carry only IDs and fixed text, never message content.
2. Edge rule: a hop with `model` at one end → `<caller>-model`. A hop touching `student` → `student-hub`. Otherwise `hub-<specialist>`. There is no Student↔specialist edge.
3. Model calls are hops **only for live calls** (`mode === 'live'` or a `claude…` model). Mock models stay inside the agent. `model_call_failed` with `code: 'missing_credentials'` stays inside (no call was made). A `timeout` is phase `unknown`.
4. Tutor `scope_check_started` is a model hop only with `mode: 'live'`; `scope_checked` only with `usage`.
5. Student: `request_planned` (inside: "Obvious — the Hub routes it", "Student chose Library services (its model)", "Student decided to ask you first", "Not a university service — Student answers itself"), `clarification_asked`, `request_declined`, `card_discovered` (a hop only when it has a `reason`), `request_sent`, `reply_received`, `tutor_error`, `form_received`, `request_failed`, `form_action_sent`, `form_action_result`, `form_action_failed`, and its model calls.
6. Hub: every event in Step 7a's Contract 5, plus `capability_rejected`. `route_decided` reads "Routed to library (Student’s choice)" when `decidedBy === 'student'`, or "Not routed: <decision>".
7. Specialists: `message_received`, `intent_decided`, `model_call_reused`, `answer_checked`, `reply_published`, `form_sent`, `form_action_received`, `form_review`, `form_action_result`, `form_reply_sent`, `hub_registration`, `skills_saved`, `card_notification`, model calls, scope checks.
8. Keep the specialist set (`tutor`, `library`) in one table, so a later step can add an agent.

**`public/topology.js`:**

9. The graph uses the final layout now, so Step 9a only adds the Professor. The `viewBox` is `0 0 1100 660`, set on `<svg id="topo">` in `public/index.html` by Task C (not by this file). Agents are circles: student (130, 330, r 60, "Student agent", "You"), hub (450, 330, r 76, "University Hub", "Front door and router"), tutor (770, 110, r 60, "Tutor Agent", "Tutoring specialist"), library (770, 550, r 60, "Library Agent", "Library specialist"). Leave the slot at (770, 330) between Tutor and Library empty: Step 9a puts the Professor there.
10. One model box per agent (184×74 rounded rectangles, `w: 184, h: 74`): `llm-student` (130, 110), `llm-hub` (450, 110), `llm-tutor` (985, 110), `llm-library` (985, 550), named "Student’s model", "Hub router’s model", "Tutor’s model", "Library’s model". No shared provider node. Leave (985, 330) empty for Step 9a's `llm-professor`.
11. Edges: A2A solid (`student-hub`, `hub-tutor`, `hub-library`), HTTPS dashed `5 5` (the four `-model` edges). Labels "A2A" / "HTTPS". Never draw Student↔specialist.
12. One lane per direction, offset ±9 px, **both computed from the a→b direction**. Trim lanes at the circle radius or the box border.
13. Node data lives in one table, so a later step can add a node.
14. Node pills: "✓ Ready", "⚠ Heartbeat late", "✕ Unreachable", "○ Not registered", "⏸ Disabled", "✕ Card refused", plus "✓ Online", "↻ Waiting for reply", "↻ Relaying (n)", "↻ Working (n)". Heartbeat age "♥ 3s ago". Hub shows "router: <mode>".
15. Model box status is a text line with an icon prefix: "○ Off", "○ In-process, no network", "⚠ No API key set", "↻ Call in flight (n)", "○ No calls yet", "✓ Last call answered", "? Last call timed out", "✕ Last call failed". `STUDENT_MODE=off` shows "○ Off" with a dimmed line.
16. Colors (light): student `#2b59c3`, Hub `#9a6300` (dark `#e3b04b`), tutor `#8a3fa8`, library `#16765e`, model `#5b6472` (dark `#aab4c2`). Color = the agent that sent it.
17. Animate only labelled **live** events. Buffer ~350 ms, sort by `at`, stagger 170 ms. Shape = category; fill = phase. Failed/unknown stop halfway with ✕ / ?.
18. Reduced motion (OS setting, toggleable) shows a static mark at the lane's middle. Replayed history fills the list and node state without animating.
19. Controls: Show heartbeats (off by default), Reduce motion, Pause, trace selector. Selecting a trace highlights only its path.
20. Side panel: details for the clicked node, edge or model box, and an event list (newest first, by `at`, max 300) with event ID, operation ID, time, source, destination, type and phase.
21. Hub details show destination → worker mappings. Model box details: who uses it, what for, mode, model, whether a key is set (never the value), calls, in flight, failures, last call (purpose, outcome, latency, tokens).
22. Legend: Question or answer · Form or form action · Registration · Agent Card · Heartbeat · Model call (dashed line = HTTPS, not A2A) | Sent · Received · Result returned · Failed · Outcome unknown. Note (class `legend-note`): "Color = the agent that sent it. Pulses appear only for events the agents reported."
23. Show latency only for a model call, as measured by the agent that made it. Never probe the provider.
24. Nodes and edges are keyboard-focusable. Status always has text and an icon, not only color.

### Task C — Tabs, strip, consoles and chat

1. **Tabs** are links: `<a href="/topology" role="tab">`. A plain click switches in place and `pushState`s. Cmd/Ctrl/Shift/Alt or middle click is left to the browser. Arrow keys and Home/End switch with `replaceState`. Back/Forward (`popstate`) switch tabs. `/` opens Conversation; no remembered tab.
2. A pulse dot on the Topology tab shows activity while it's hidden.
3. Agent activity: consoles for Student, Hub, Tutor, Library. The Student console shows "Plan: …" (send to X / send as-is / clarify first / answer here) with how it was decided, and its model calls. The Hub console shows "Routed → library (Student’s choice)" and "Capability not recognised".
4. **Hop-by-hop strip:** `STEPS.chat` has nine steps, each `[key, label, note]`, marked only by its real event:
   - `student:request_planned` Student checked · `student:request_sent` Student sent · `hub:message_received` Hub received · `hub:route_decided` Agent identified · `hub:forward_attempted` Hub forwarded · `specialist:message_received` Specialist received · `specialist:reply_published` Specialist replied · `hub:forward_completed` Hub got the reply · `student:reply_received` Student received.
   - Aliases: `student:tutor_error` and `student:form_received` → `student:reply_received`; `specialist:form_sent` → `specialist:reply_published`. `tutor`/`library` sources map to `specialist`.
5. `STEPS.form_action` has seven steps: `student:form_action_sent`, `hub:form_action_received`, `hub:form_forwarded`, `specialist:form_action_received`, `specialist:form_reply_sent`, `hub:form_result_relayed`, `student:form_action_result`.
6. The strip resets for every new question and every form action.
7. Each step `<li>` has `data-step`, `data-state` (`pending` | `done` | `skipped` | `failed` | `unknown`), `data-actor` and `data-active`. `markStep` never moves a settled step back.
8. `updateActiveStep`: while a run is in flight, the first pending step gets `data-active="true"`, `aria-current="step"` and "in progress…". Other pending steps say "not yet".
9. Done steps fill with a tint of the acting agent's color and show "✓" beside the name and the time. Specialist steps take the color of the service the Hub chose (`setSpecialist`).
10. `flowStep` writes what really happened:
    - Student checked → "obvious — the Hub routes it" / "needs Library services (its model)" / "asked you to clarify first" / "reply to the university — sent as-is".
    - Agent identified → "→ library (Student’s choice)" or "not routed: not supported". Specialist steps show the service name.
11. `skipSteps` marks steps the flow didn't take, with the reason:
    - Hub answered itself → the four specialist-leg steps "skipped — Hub answered itself (not supported)".
    - Student clarified → every later step "not sent — your Student agent asked you first". Declined → "not sent — your Student agent answered (not offered)".
    - `forward_failed` → that hop failed/unknown, specialist steps skipped. `request_failed` → "Student sent" failed/unknown, the rest skipped.
    - A refused form action or a stored result (`form_action_duplicate`) → the forwarding steps skipped.
12. Steps are at least 100 px wide; all nine fit at desktop width. Grid children use `minmax(0, 1fr)`. Reduced motion stops the pulse. Replay after reload rebuilds the strip.
13. Chat items: the held question ("You (held by your Student agent, not sent yet)") and "Your Student agent asks". A decline shows "You (not sent — answered by your Student agent)" and "Your Student agent — not offered by the university".
14. "Live view disconnected" is a banner (`#live-banner`) separate from agent status. The graph greys out; agents aren't marked offline.
14b. **The chat fills the window's height at every width.** While the Conversation or Professor view shows, `body` is exactly `100dvh` (`body:has(#view-conversation:not([hidden]), #view-professor:not([hidden]))`); grid rows `minmax(420px, 1fr) auto` (phones ≤720 px: `minmax(80dvh, 1fr)`). Never give the chat a fixed or capped height such as `min(76dvh, 820px)`: a tall window then shows an empty band under it.
15. **`followBottom(log)`** for the chat and all four consoles:
    - While the reader is within 40 px of the bottom, stay at the newest item on every size change (a `ResizeObserver` on each child, attached by a `MutationObserver`).
    - An upward wheel, touch drag, ArrowUp/PageUp/Home, or a scroll that lowers `scrollTop` stops following.
    - Scrolling back to the bottom, sending a message, New conversation, or "Edit and retry" follows again (`follow.get(log).pin()`).
    - No other code sets `scrollTop`. Expose `window.__chatFollow` (read-only) for the browser check.
16. **Composer:** Enter sends; Shift+Enter adds a line. Leave Enter alone when `e.isComposing` or `keyCode === 229`. Clear the box at once on send; put the text back if the request can't start, and show the error. Blank messages aren't sent. While busy, Enter does nothing. The textarea has `aria-keyshortcuts="Enter"` and a description of both keys.
17. **Spinner:** after a chat question has been in flight 1 s, add a last chat item "Waiting for an answer…" with a spinning ring (`role="status"`). It stays last.
18. Remove it on `reply_received`, `tutor_error`, `request_failed`, `form_received`, `clarification_asked`, `request_declined`, or when the run leaves its busy state. Never show it again for that question. Form actions don't use it. A reload mid-question shows it again. Reduced motion keeps the ring still.
19. Browser dedupes by `seq` and resets on a new `bootId`. Use `textContent` only.
20. **`scripts/browser-checks/chat-scroll.js`:** a `playwright-cli run-code` function. It checks, by measuring the gap to the bottom: text answers, a tall form, scroll-up-while-answering, resume, send-while-up, consoles, reload replay, tab switch and phone width. Running it is optional and needs a browser and `playwright-cli`; if none is available, say so.
21. **Topology `<svg>`** in `#view-topology` of `public/index.html`: `<svg id="topo" class="topo" viewBox="0 0 1100 660" role="group" aria-label="…">`. This task owns the `viewBox`; Task B's `public/topology.js` draws into the element and does not set it.

### Task D — Tests

1. **New `test/student-model.test.js`** (Hub `ROUTER_MODE=mock`, UI `STUDENT_MODE=mock` unless noted) checks:
   - Planner rules: an obvious question is decided by rule with no model; unclear ones are not.
   - Topology: the Student's live model calls are labelled on `student-model`.
   - The Hub card has one public skill per capability, with no worker names or URLs.
   - An obvious question goes on as-is and the Hub's router decides.
   - An unclear question: the Student asks first, nothing is sent; the answer is sent as question + `(Your Student agent asked: “…”)` + answer, and the Hub's mock router still routes it by the answer (`with renewing a library book` → Library).
   - `briefReply` keeps the start and end of the real 554-character loan reply (ends "If you tell me which book you meant, I can explain its reason in more detail."), bounded ≤ 520; short replies unchanged.
   - A bare "yes" to an either/or question: asked once more ("Which one do you mean? …", `by: 'rule'`, no model call); a second "yes" → `uncertain`; a yes/no question accepts "yes"; "yes, the library loan" is not re-asked. End to end (mock): "I need help" → "yes" → asked again, nothing sent → "with renewing a library book" → sent with the original message and the re-asked question → Library.
   - `asksStudent`: true for a trailing "?", that invitation, "Let me know which one you want.", "Tell me which book you meant.", "If you’d like, I can show another example."; false for a plain statement, `''`, and "Your loan is due 2026-11-20. Is that ok? It cannot be renewed." After that loan reply, "claculus" plans `send` / `by: 'context'`.
   - The Hub ignores an unknown `requestedCapability` (`capability_rejected`) and routes itself.
   - Live mode against `test/support/fake-anthropic.js` (placeholder key, its own key variable, `ANTHROPIC_BASE_URL`): the model chooses a capability and the Hub honours it (`decidedBy: 'student'`).
   - Live mode: clarify, model failure (`by: 'model_failed'`, still sent), decline answered by the Student with nothing sent, an unsure model (`none`) and an "I don’t know" answer both go to the Hub.
2. **Add to `test/hub.test.js`:**
   - Every labelled hop is on an allowed edge (the seven edges or `null`), never Student↔specialist. Content is redacted by default.
   - The stream resumes by `Last-Event-ID` with only missed events; a too-old cursor or `UI_HISTORY_LIMIT` overflow announces `truncated`; heartbeats are live-only.
   - A model line appears only for real live calls, on the caller's own edge (mock and `missing_credentials` stay inside).
   - Redaction unit test: receipts reduce to ID and status; model reasons and unknown fields are masked; an event with no `runId` is still redacted; config event types pass.
3. **Add to `test/ui.test.js`:** `/conversation`, `/activity`, `/topology` and `/` serve the page; other paths are 404.
4. No test calls the real API. Mock traffic is labelled as mocked.

## Phase 3 — Join and check (lead)

1. Check that `src/ui-server.js` imports `topologyLabel` and `planRequest`, and `public/app.js` uses the Contract 6 API. Then run `npm test`. Fix failures in the owning file.
2. (Optional — needs a browser; if none is available, say so.) Run `npm run demo`. Open `http://127.0.0.1:4444/conversation`. Ask a library question, "How do I fix my plumbing?" (Hub answers itself in mock), and "I need help" (the mock Student clarifies). Watch the strip and the Topology tab.

## Rules that apply to the whole step

1. Three channels stay separate: A2A carries agent messages; A2UI travels inside A2A; SSE telemetry only reports real events. Never synthesize an event.
2. Only real events mark strip steps or animate pulses. Never infer a hop from timing.
3. The Student names only a public capability ID. The Hub owns destinations and still checks readiness.
4. Anything uncertain goes to the Hub. The Student declines only when its live model is confident.
5. Redact by allowlist. Exempt by event type, never by a missing field.
6. Refresh, reconnect, replay or filters never send A2A messages or resubmit forms.
7. Never show an API key; say only whether one is set.

## Avoid these known problems

- The Student agent's words are shown as is: speak to the student as "you", never describe its reasoning; answer greetings and thanks kindly; for clarify only `clarification_question` is shown, so put greetings and "how do I use this?" explanations there; "what do i do now?" after a reply goes to the service that replied.
- A keyword is not a routing decision. "The reading for my calculus course" mentions calculus but is a library request. One match means "obvious — let the Hub decide".
- A pending clarifying question must not swallow the next message. Decide whether it answers the question or is a new request.
- Keep the end of a reply in history, not just the start. A 300-character head cut dropped a Library reply's closing "If you tell me which book you meant…", so "claculus" lost its meaning and the Student asked "tutoring or your library loan?". Use `briefReply`.
- A bare "yes" to an either/or question is not a choice. The Student's model picked tutoring and logged "You chose Calculus tutoring" when the student meant the book; the Hub's router did the same with its own question. Ask once more, then let the Hub decide.
- Every hop must understand a follow-up. Once the Student and Hub passed "claculus" on, the Library asked "catalog or your own loan?" because its classifier also cut its own loan list to 300 characters and only treated "the first one"-style replies as follow-ups.
- An invitation ending with a period is a question too. A "?"-only check missed it. Use `asksStudent` on the last sentence.
- Send the Student's clarifying question with the answer. "claculus\nyes" reached the Tutor with "no prior context explaining what the student is agreeing to". Keyword heuristics must skip the asked line, or "tutoring or library?" makes every answer look like both.
- Don't make the Hub say what the Student already knows. Let a confident Student decline.
- Don't treat every "model" event as provider traffic. Decide from mode/model; `missing_credentials` means no call.
- Specialist telemetry arrives after the Hub's. Buffer and sort by `at`; in tests, wait for events.
- Don't draw one shared provider node. One model box per agent.
- Model boxes are rectangles: trim at the border, status as a text line, every status with an icon prefix.
- The strip must not widen the page (`minmax(0, 1fr)`). Keep step status short; the ✓ goes beside the name.
- Scrolling once on append doesn't keep a chat at the bottom; A2UI forms render after insertion. Follow size changes, and stop when the reader scrolls up.
- A barely visible strip isn't a live flow: fill done steps with color, highlight the active step, give skipped steps a reason.
- Redacted lists arrive as "[n items redacted]". The browser must show that count, not crash.

## Done when

- `npm test` → all tests pass, 0 failed.
- `node --test test/student-model.test.js` and `node --test test/hub.test.js` pass.
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4444/topology` prints `200` and `/nope` prints `404` (with `npm run demo` running).
- Manual browser check (optional — needs a browser; if none is available, say so) with `npm run demo`:
  - A routed question fills all nine steps in agent colors, with an in-progress highlight that moves.
  - A Hub-answered question shows the specialist leg skipped with the reason.
  - "I need help" shows the held question, "Your Student agent asks", and every later step "not sent".
  - Enter sends and clears; Shift+Enter adds a line; a blank Enter sends nothing.
  - Topology: a calculus question pulses Student → Hub → Tutor → Hub → Student only. Reduce motion and keyboard focus work.

Then append the "CLAUDE.md notes" below to `CLAUDE.md` and commit `Step 7b: Seeing it live`.

## CLAUDE.md notes

```markdown
## Step 7b — Student model, tabs, topology
- STUDENT_MODE off (default) / mock / live, read at import. One capability match = obvious → sent as-is, the Hub's router decides. Otherwise the Student's model sends + capability (metadata.requestedCapability), clarifies (pending → answers_question | new_request), or declines (live, confident only). UNSURE answers and model failures go to the Hub.
- An answer to the Student's clarifying question is sent as held message + `(Your Student agent asked: “…”)` + answer (askedLine/withoutAsked in router.js; keyword heuristics skip that line). A reply goes on as-is when asksStudent(last reply): last sentence ends with “?” or is an invitation. Histories keep replies as briefReply (src/llm.js: first 200 + last 300 chars), never a head cut — in every model prompt (Student, router, Tutor scope check, Library, loans, Professor). A bare "yes" to an either/or question is re-asked once (code), then goes to the Hub undecided; the router and Library prompts treat naming an item from the last reply as a follow-up.
- The Hub honours only its own destination IDs (decidedBy 'student', readiness still checked); else capability_rejected.
- src/topology.js labels events; the browser animates only labelled live events (~350 ms buffer, sorted by `at`). Model hops only for live calls, at each caller's own box (llm-student/hub/tutor/library).
- Strip: real events only (STEPS, flowStep, markStep, skipSteps, updateActiveStep); data-state + data-active.
- Telemetry redaction is an allowlist (SAFE_FIELDS, CONFIG_EVENT_TYPES) unless HUB_TELEMETRY_SHOW_CONTENT=1.
- Event IDs <bootId>:<seq>; Last-Event-ID resumes; UI_HISTORY_LIMIT bounds history with a truncated notice; heartbeats are never stored.
- Don't cap the chat's height; it fills the window (check a tall window, a short one and a phone).
- Logs scroll only through followBottom; never set scrollTop directly. Re-check with scripts/browser-checks/chat-scroll.js after chat UI changes.
```

## Show it (optional)

- Free: `npm run demo`, then open `/conversation`, `/activity` and `/topology` in separate browser tabs.
- Scroll check (optional — needs a browser and `playwright-cli`; install with `npm i -g @playwright/cli` if you want it; if no browser is available, say so). Free with `npm run demo`: `playwright-cli -s=check open http://127.0.0.1:4444/conversation`, then `playwright-cli -s=check run-code "$(cat scripts/browser-checks/chat-scroll.js)"`.
- PAID (a few cents): `env -u ANTHROPIC_BASE_URL npm run demo:live`. Try "Where would I get the reading for chapter three of my calculus course?" (Library), "Can someone go over chapter three with me before Friday?" (clarify), and "How do I fix my toilet plumbing?" (Student declines). Each startup line must say `API host: api.anthropic.com`.
- A later step adds a Professor node. Keep the node and edge tables data-driven so that's a table entry, not a rewrite.
