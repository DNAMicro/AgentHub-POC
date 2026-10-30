# Step 10 — AG-UI between the agents and your screen

Time: about 90 minutes. Cost: free (tests use mocks). Optional live check: PAID, a few cents.

## What you'll see when it works

- Nothing new on screen — on purpose. The Conversation, Agent activity and Professor view look and behave exactly as after Step 9 (also after a reload and with several windows open).
- Under the hood, each question is an **AG-UI run**: `RUN_STARTED` → the reply as `TEXT_MESSAGE_START / CONTENT / END` → `RUN_FINISHED` (or `RUN_ERROR`), checked by the official `@ag-ui/client` before anything is drawn.
- Each browser page holds **one** connection (`/api/ui/stream`), so three windows open at once never block a request.

## Starting point

Step 9c must be done. Start from its committed code.

## Instructions for Claude (lead)

Use the three phases from Step 0: Contracts → parallel Build → Join and check.

1. Run `npm test` first and confirm it passes.
2. Install exactly: `npm install --save-exact @ag-ui/core@1.0.3 @ag-ui/client@1.0.3 @ag-ui/encoder@1.0.3 zod@3.25.76 rxjs@7.8.1`. Read the real types in `node_modules/@ag-ui/*/dist/*.d.ts`; event schemas are in `@ag-ui/core/schemas` (`EventSchemas`).
3. **Before any change, record the “before” screens** (Phase 3, step 1) — you need them to prove nothing changed.
4. Write the Phase 1 contracts yourself.
5. Start **all three tasks in the table in ONE message** with the Agent tool.
6. Join, run the checks, fix failures, append the CLAUDE.md notes and commit.

Don't stop to ask questions. Everything you need is in this file and Step 0.

## Phase 1 — Contracts (lead writes these first)

1. **Channels.** `/api/events` stays exactly as it is (Topology, the hop-by-hop strip and every existing test read it). AG-UI is a **second view of the same real events**; it never invents an event or reorders a run.
2. **`src/ag-ui-bridge.js` stub:** `createAgUiBridge({ bootId, historyLimit, hello })` → `{ push(appEvent), connect(req, res), close(), status() }`. `push` gets every published app event except heartbeats, with `topo` removed.
3. **`src/ag-ui-professor.js` stub:** `createProfessorAgUi({ bootId, getState, postChat, unreachable })` → `{ connect(req, res), startRun(input) → { status, json }, onAppEvent(appEvent), close() }`.
4. **`src/ag-ui-stream-agent.js` stub:** `export class StreamAgent extends HttpAgent` with constructor `{ streamUrl?, runsUrl?, events?, after?, bootId?, signal? }` and fields `lastId`, `bootId`, `bootChanged`; `export function bufferedChannel()` → `{ next(event), complete(), observable }`.
5. **Event IDs:** student channel `<bootId>:a<n>` (shared history), per-connection extras `<bootId>:c<conn>-<k>`, professor `<bootId>:p<n>`. Each AG-UI event carries its ID in `metadata.id`; the SSE `id:` line is written by hand (`EventEncoder.encodeSSE` writes only `data:`).
6. **Mapping (bridge):** `reply_received` → `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` (skip if empty), `TEXT_MESSAGE_END` (one block, `messageId: msg-<appId>`) + `CUSTOM reply_received` with the data minus `text` and `textMessageId`. `form_lifecycle` → `STATE_DELTA [{ op: 'add', path: '/forms/<formId>', value: data }]` with `metadata.appEvent` (the envelope). `form_received` → `STATE_DELTA` of `{ formId, workflowId, agentId, state: data.lifecycle }` (no `appEvent`) + `CUSTOM form_received`. Sources `hub`, `tutor`, `library`, `professor` → `ACTIVITY_SNAPSHOT { messageId: act-<appId>, activityType: source, content: appEvent }`. Everything else → `CUSTOM { name: type, value: appEvent }`.
7. **Routes (UI server):** `GET /api/ui/stream?monitor=<id>&student=<id>` (the page's one connection), `GET /api/ag-ui/stream`, `GET /api/ag-ui/professor/stream`, `POST /api/ag-ui/runs`, `POST /api/ag-ui/professor/runs` (both POSTs behind the existing origin guard). `/api/ui/stream` names each SSE event by channel: `monitor`, `monitor:hello`, `monitor:truncated`, `monitor:replayed`, `student`, `professor`, and writes no shared `id:` line.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/ag-ui-bridge.js`, `src/ag-ui-professor.js`, `src/ui-server.js`, `package.json` | The bridge, the Professor channel, the routes | `node -e "import('./src/ui-server.js')"` loads |
| B | sonnet | `src/ag-ui-stream-agent.js`, `src/browser/ag-ui-entry.js`, `public/app.js`, `public/classroom.js` | The client, the bundle, the browser split and the one connection | `npm run build:ui` and `node --check public/app.js public/classroom.js` pass |
| C | sonnet | `test/ag-ui.test.js` (new), `scripts/browser-checks/same-screen.js` (new) | Tests and the before/after screen check | Tests pass after the join |

### Task A — Server

1. **Run sequence (one per stream, shared by every tab).** The installed client's verifier refuses `RUN_STARTED` while a run is open and refuses any event outside a run; a violation ends the stream. So:
   - `run_started` (an app run) opens `RUN_STARTED { threadId: contextId, runId }` (closing an open run first); its terminal state closes it: `completed`/`uncertain` → `RUN_FINISHED { result: { state } }`, `failed` → `RUN_ERROR { code: 'failed' }`.
   - Events that arrive while a run is open go **inside it**.
   - Events between runs open a **server run** `RUN_STARTED { runId: srv-<uuid> }` + `CUSTOM server_run { cause }`, closed after ≈150 ms. If the first event's `runId` is a known finished app run (a reconcile), set `parentRunId`.
2. **History** bounded by `UI_HISTORY_LIMIT`, trimmed only by **whole runs** from the front, never cutting the open run.
3. **`connect`:** a private run first — `RUN_STARTED`, `STATE_SNAPSHOT { forms }`, `CUSTOM hello { bootId, resumed, ...statusBody() }`, `CUSTOM truncated` when history was cut, `RUN_FINISHED`. Then replay: a `Last-Event-ID` resume restarts at the `RUN_STARTED` of the run containing the cursor. Then `CUSTOM replayed` inside the open run, or in its own private run.
4. **`POST /api/ag-ui/runs`:** validate `threadId`, `runId`, `messages`; read **only the last user message**; `threadId` matching `CONTEXT_ID_PATTERN` = the conversation, anything else = a new one; `forwardedProps` carries `lessonDeliveryId`, `meetingSlot`, `capability`. Share one `startChatRun(body)` with `POST /api/runs`. The **server's** run ID comes back in the 202. The 64 KB body limit stays.
5. **Professor channel:** state `{ professor, error }` fetched through the Hub (`/dev/agents/professor/author/state`) every 3 s while a client is connected, and on `lesson_*`, `course_available`, professor `student_reply`, `conversation_reset`, `classroom_reset`; a `STATE_SNAPSHOT` only when it changed (inside the open run, or in its own short run). A message: `RUN_STARTED` → POST `/author/chat` → `CUSTOM professor_result { runId, ok, status, json }` → `STATE_SNAPSHOT` → `RUN_FINISHED` or `RUN_ERROR`; one at a time (409). A tab connecting mid-run first gets that run's events so far.
6. **`/api/ui/stream`:** call the monitor writer (the old `/api/events` handler as a function), `agui.connect` and `professorAgUi.connect` in that order, each with an adapter whose `write()` renames every SSE event to its channel and drops `id:` lines. The monitor's `hello` therefore always comes first.

### Task B — Browser

1. **`StreamAgent`** overrides `connect()` (`HttpAgent` in 1.0.3 doesn't implement it; `connectAgent()` swallows the error). From `events` or its own fetch: drop events already seen (by `metadata.id`) before they reach the verifier; track `lastId` (`:a` IDs only); a different `bootId` prefix → `bootChanged`, complete.
2. **`bufferedChannel()`** keeps events until the agent subscribes (the client subscribes a moment after `connectAgent()`; a plain Subject loses the opening snapshot, hello and the replay).
3. **Bundle:** `src/browser/ag-ui-entry.js` exports `StreamAgent`, `bufferedChannel`, `EventType`; `build:ui` gets a second esbuild entry → `public/vendor/ag-ui.js`.
4. **Split the event code.** `monitor(event)` = Topology (`topology.event`, `hubFeed`, `agentMode`, `runStarted`, `runState`, `studentCard`), the strip (`resetTimeline`, `flowStep` for the monitor's current run, the strip's error line) and the Hub telemetry badge; `applyTopology(snap, { topo, dom })` splits likewise. Remove those calls from `handle()`. **Only the monitor side clears the strip** (`clearStrip()` on `conversation_reset` and restart) — the two channels replay independently after a reload. Separate dedupe sets `seen` / `seenMonitor`.
5. **One connection loop:** `fetch('/api/ui/stream?monitor=…&student=…')`; dispatch by event name; on `monitor:hello` handle the hello (new `bootId` → `resetMonitor()`, `resetConversation()`, forget the cursors), then create the student `StreamAgent` (`events: studentChannel.observable, after, bootId`) and hand a professor `StreamAgent` to `classroom.attachProfessor()`. `fromAgUi(event)` turns AG-UI back into the app event `handle()` renders (text joined with `reply_received`, `ACTIVITY_SNAPSHOT.content`, `STATE_DELTA` with `metadata.appEvent`, `CUSTOM.value`); `hello`/`replayed` drive `formsUi.setReplaying`/`replayDone`. Trim the agent's messages (console entries add up). On a drop: complete the channels, keep the cursors, retry after 1 s. Abort the fetch on `beforeunload` **and** `pagehide`; reload on `pageshow` with `persisted`.
6. **Chat sends AG-UI run input:** `startRun({ text, contextId, ...forwardedProps })` posts `{ threadId: contextId ?? 'new', runId, messages: [{ id, role: 'user', content: text }], state: {}, tools: [], context: [], forwardedProps }` to `/api/ag-ui/runs`.
7. **Professor view:** no polling or fetching of `/api/professor/state` any more — render from the `STATE_SNAPSHOT`; send with `POST /api/ag-ui/professor/runs` and resolve on `CUSTOM professor_result` (it can arrive before the 202).

### Task C — Tests and the screen check

1. **`test/ag-ui.test.js`** (`startStack({ professor: true, hubEnv: { ROUTER_MODE: 'mock' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_MOCK_DELAY_MS: '1200' } })` — the stack's Tutor defaults to `fixed`, so set `mock` for the delay): every event validates against `EventSchemas`; run rules hold; the server's run ID wins; `threadId` = conversation; reply in one block; only the last user message read; 64 KB+ → 413; malformed → 400; activity events redacted, unique `messageId`s, no `topo`, no heartbeats; an idle lesson in a server run and on two tabs; a lesson during a slow run (`Explain the derivative of x cubed` — wording the mock router sends to the Tutor) lands inside it and the real client accepts the stream; `Last-Event-ID` resume at a run boundary; reload replays with the snapshot before any delta; the Professor channel; cross-site POSTs → 403; `/api/events` still carries reply text and `topo`; `/api/ui/stream` names every event by channel, `monitor:hello` first, no `id:` lines; a bridge unit test of a history cut; a server restart → `bootChanged`; a `bufferedChannel` delivers events emitted before the agent subscribes.
2. **`scripts/browser-checks/same-screen.js`:** a scripted session (fresh chat, a tutor answer, a clarification and its answer, a booking form and Cancel, a professor message, a lesson, a reply, a reload, Professor view, Agent activity, a second tab) that dumps each log's text (times, IDs, dates normalized), the state, badges and strip, plus screenshots.

## Phase 3 — Join and check (lead)

1. **Before any change** (on a separate fresh mock stack, `node scripts/demo/rehearsal-stack.js --ui 5444 --base 52240 --mock`): run `same-screen.js` twice on two fresh stacks and require the two outputs to be identical.
2. After the build: `npm run build:ui`, `npm test`, then `same-screen.js` on a fresh mock stack, compared with “before”. Expected difference: only the hidden Professor log being filled in before the Professor tab is opened.
3. Open three windows of the app and check a request still answers at once.

## Rules that apply to the whole step

- No visible change. A2A, A2UI and `/api/events` are unchanged.
- Every AG-UI event is inside a run; never two runs at once; snapshot before delta; resume only at run boundaries.
- One long-lived connection per page.

## Avoid these known problems

- Browsers allow 6 connections per server: three streams per page blocked every request once two windows were open. Multiplex.
- A plain rxjs Subject drops events emitted before the client subscribes: use `bufferedChannel()`.
- The strip was wiped by the AG-UI side's replay of “New conversation” after a reload: only the monitor side clears it.
- A form's first state is in `form_received`.
- On a reload the browser cuts the connection before `pagehide`: also abort on `beforeunload`, or the client logs a network error.
- `connectAgent()` on a plain `HttpAgent` does nothing: override `connect()`.
- Don't run two rehearsal stacks on the same ports; record before/after on fresh stacks (New conversation doesn't clear the Professor console).

## Done when

- `npm test` passes (13 tests in `test/ag-ui.test.js`).
- The before/after screen check shows only the expected difference.
- Three windows open, a request answers at once.

## CLAUDE.md notes

```
## Step 10 — AG-UI
- @ag-ui/core, client, encoder 1.0.3 (+ zod 3.25.76, rxjs 7.8.1). Schemas: @ag-ui/core/schemas.
- One connection per page: /api/ui/stream (monitor*, student, professor channels). Don't add a stream per feature.
- Run rules: everything inside a run; no overlapping runs; reply in one block; unique ACTIVITY messageIds; snapshot before delta; resume at run boundaries; write the SSE id: yourself.
- StreamAgent overrides connect() (not implemented in HttpAgent 1.0.3); feed it a bufferedChannel(). One agent = one verifier.
- monitor() owns Topology, the strip (and clears it) and the Hub badge; handle() owns chat, consoles, forms, inbox.
- POST /api/ag-ui/runs: last user message only; the server owns the run ID.
```

## Show it (optional)

- PAID (a few cents): `env -u ANTHROPIC_BASE_URL npm run demo:live`. Ask a question, reload, open a second window: everything looks as before. In the browser's network panel there is one `/api/ui/stream` connection per page.
