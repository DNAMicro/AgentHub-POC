# Step 15 — PeopleSoft over MCP: where the time-off request is really stored

> Final state: see `Steps/README.md`. This is your Part 15 request, in your wording, with every decision and fix made while building it merged into the instructions. Running it after Steps 1–11 and 14 rebuilds the current app. **Concrete specification** blocks give the exact names, values and rules the current app uses. The closing sections list the problems to avoid and each change with why it was made. (12 and 13 are reserved by the guardrails design.)

## Your original request

> the data of the time off request is stored in peoplesoft I want to demonstrate that there is an MCP connection from the HR agent to PeopleSoft show me a design on how that iwll look

## Your decisions while designing it (merged into the instructions below)

- When it goes through MCP: *“when the timeoff is submitted or when the timeoff left is calculated”*.
- The design rounds (Topology): *“we are not using squares for the agent I dont want the current design to diminish its great as is show me how it would be with MCP added”*; *“Maybe add a circle around the peopleSoft that turns when it gets activated similar to the agents”*; *“reduce the database to fit properly into the circle and also make it fit better in the diagram”*; *“this does not make it feel like its an MCP connection it just feels like a direct db connection”*; *“No I dont like it at all”*.
- The smart system: *“I want them to feel that there is AI involved in the process and it is a smart system not a dumb system”*; *“The AI will make the decision to use the tool that connects to peoplesoft but the data is dynamic and there is a wrapper around people soft that gets activated that makes the data storage be done in a dynamic manner rather than a simple query againt it. It can invoke workflows and validation.”*; and for the wrapper: *“it own AI”*.
- What the screen shows: *“it should not show any of that complexity the UI should just show that there is more to it than just a database the same way we do the agent animation”*.
- The rule that settled the look: *“oh no its not right it cant be mistaken with an agent and it cant have a model tied to it. Create 5 design varations for me to select from”*, then *“add a database icon inside the E and call it variation F”*, then *“F is the right design implement it”*.
- Who asks the AI: *“ask the AI at both moments”* (HR's AI chooses the PeopleSoft tool when the card opens and again at Submit).
- Verification: *“After you are done run at least 20 difference scenarios to make sure they all work if you find an issue fix it”*.
- Builder's own calls (you approved the design): the number is 15; PeopleSoft is a fictional demo stand-in; HR keeps no copy of the data; only HR can call PeopleSoft.

## What you get

- In the **Professor view**, ask for time off exactly as in Step 14. The card opens with the same look. The only differences are behind it, and on **Topology**.
- On Topology, below the HR Agent, there is a rounded **PeopleSoft** tile with a small database icon, the words “PeopleSoft” and “MCP SERVER”, and a ✦ sparkle in its corner. A dash-dot line labelled **MCP** joins HR to it. It has no circle, no orbit and no model box, so it can't be mistaken for an agent.
- When the card opens, then when you press Submit, a hexagon pulse runs down the MCP line, the tile shows “● Working…” while the sparkle twinkles and a light sweeps across it, and then it shows “✓ Saved” and “✓ Connected”. The event list names the call (“tools/call create_absence_request”, “Saved as ABS-000101”).
- Click the tile: “PeopleSoft — demo stand-in”, who can reach it, its status, the last call and its three tools. No internal step names anywhere.
- Stop PeopleSoft and press Submit: “PeopleSoft didn't answer. Nothing is filed until it confirms — press Submit again; it won't file twice.” Start it again and press Submit once more: it files one request.

## Starting point

Steps 1–11 and 14 must be done. `npm run demo` currently starts six processes; after this step it starts seven.

## 1. Add the PeopleSoft stand-in (`src/peoplesoft-mcp.js`)

**Concrete specification**
- A new process on `127.0.0.1:41246` (`PORT` overrides). `npm run peoplesoft` (mock) and `npm run peoplesoft:live`. It says it is a **demo stand-in** in its startup line and in every tool description. Fictional data only (Professor Amir, `staff-amir`).
- MCP with `@modelcontextprotocol/sdk` **1.32.1** (pinned exactly; it works with `zod` 3.25.76; `npm ls zod` must show one version), Streamable HTTP, one session per client. A request with no or a wrong `Authorization: Bearer <PEOPLESOFT_TOKEN>` header gets **401**. The token is required: with none set the process exits with a message that does not print it. Compare with `timingSafeEqual`.
- Host guard on every route; bound to `127.0.0.1`; malformed JSON gets 400 `{ error: 'bad_request' }`. On SIGTERM close every MCP session first, or the process will not exit.
- Three tools, with arguments checked by `zod` (dates must be real calendar dates; partial hours positive and at most 24):
  - `get_leave_balances { staffId }` -> `{ vacation, sick, personalHoliday }` (hours).
  - `list_absence_requests { staffId }` -> the filed requests.
  - `create_absence_request { staffId, absenceType, absenceReason, beginDate, endDate, partial, operationId }` -> the receipt (request id `ABS-000101`, `ABS-000102`, …) or a refusal.
- Test-only: with `PEOPLESOFT_TEST_HOOKS=1` there is `GET /test/records` and `PEOPLESOFT_TEST_DELAY_MS` (delays the answer to a new filing after it is written). `POST /dev/reset` reseeds.
- The staff, balances and requests that were in `src/hr-store.js` move to `src/peoplesoft-store.js` (`createPeopleSoftStore`) and `src/leave-rules.js` (`planAbsence`: dates, holidays, workdays, hours, Forecast). **Delete `src/hr-store.js`.** Memory only; reseed on start and on reset; nothing under `data/`. `file(staffId, values, operationId, steps, { generation })` is a synchronous check-and-write (no `await` between check and write), keyed by operationId in a `Map`. The store has a **reset generation** (`generation()`, raised by `reset()`): `create_absence_request` reads it before it awaits the planner and passes it to `file`, which refuses with `reset_during_call` if a reset came in between, so New conversation during a Submit can't file the old request into the fresh records.
- **Ten refusal codes** (`REFUSAL_CODES`, exported from the store): `not_enough`, `holiday_boundary`, `no_workdays`, `too_long`, `overlap`, `bad_reason`, `operation_reused`, `unknown_staff`, `bad_hours`, `reset_during_call`. A refusal is `isError` with `{ code, reason }`. Overlap means a new request sharing any workday with one already filed for the same person (checked after the plan). A known operationId with different values is `operation_reused`; the same values return the stored receipt.

## 2. PeopleSoft's own AI (`src/peoplesoft-model.js`)

**Concrete specification**
- `PEOPLESOFT_MODE` = `mock` (default) | `live`, read at import. Mock is labelled `'mock heuristic'` and uses no network. Live is Claude Haiku 5.5 through `callModel` with `maxRetries: 0`, no fallback model, no canned answer on failure, errors through `toLlmError`, 8 s limit (`PEOPLESOFT_MODEL_TIMEOUT_MS`).
- `planSteps` asks for a plan from a **fixed menu**: `check_balance`, `check_dates_and_holidays`, `check_overlap`, `apply_leave_policy`, `route_to_manager`, `notify_timekeeper`, `store_record`. Code always adds the required four (`check_balance`, `check_dates_and_holidays`, `check_overlap`, `store_record`), refuses unknown names, and runs every step itself. A failed plan still files with the required steps only. A known operationId skips the planner (no model call).
- The plan and step results are stored with the record. They never reach the screen (see section 4).

## 3. HR as the MCP client (`src/hr-peoplesoft.js`, `src/hr-model.js`, `src/hr-agent.js`)

**Concrete specification**
- `createPeopleSoftLink({ url, token, emit, timeoutMs })` -> `balances`, `requests`, `file`, `reset`, `records`, `close`. It connects lazily (SDK `Client` + `StreamableHTTPClientTransport`, bearer token in the request headers) and caches `tools/list` per connection.
- **HR's AI chooses the tool at both moments** (`chooseTool` in `src/hr-model.js`): live, one structured call whose schema is an enum of the listed tools, purpose `choose PeopleSoft tool`, 8 s (`HR_TOOL_CHOICE_TIMEOUT_MS`); mock, the obvious tool, labelled. It returns a tool name only. `MOMENT_TOOL` says which tool each moment may use (card issue and balance question -> `get_leave_balances`, requests question -> `list_absence_requests`, Submit -> `create_absence_request`). Code compares the pick with `MOMENT_TOOL`; a mismatch emits `mcp_tool_refused` and makes **no call**. Code builds the arguments from the card's checked values. A failed tool choice (`model_failed`: timeout, rate limit, provider error, no key) makes no call either, and it is **not** a wrong pick: the link returns `tool_choice_failed` and emits `mcp_tool_refused { by: 'model_failed' }`.
- Outcomes of a call: `ok`, `tool_refused`, `tool_choice_failed`, `closed` (the caller's `isClosed()` said the card closed meanwhile; checked before the tool choice and right before the call), `refused { code, reason }` (the code is kept only if it is in `REFUSAL_CODES`, else null), `unavailable` (401, no session, connection refused), `uncertain` (timeout or any other error mid-call). The receipt's `steps` are removed in the link (`withoutSteps`); only `stepCount` is reported.
- **One shared deadline** (12 s, `PEOPLESOFT_TIMEOUT_MS`) covers connect, `tools/list`, a reconnect and the call. It starts after the tool choice. The call keeps a **floor of the planner's limit + 2 s** (`CALL_FLOOR_MS`, 10 s), so the connect may use only what is left (2 s, never under 1 s); a slower connect is `unavailable`, never a call cut short in the middle of PeopleSoft's planner. **Reconnect once, and only when the session is unknown** (HTTP 404/400 after PeopleSoft restarted: the tool provably never ran). Never retry after a timeout.
- HR calls `get_leave_balances` when a card is issued or re-issued and for a balance question; it does not call on each edit (the browser recomputes the summary from the fetched balances). Submit calls `create_absence_request`. A requests question calls `list_absence_requests`. HR keeps no copy of the data.
- Exact sentences:
  - Submit, unavailable or uncertain: **“PeopleSoft didn't answer. Nothing is filed until it confirms — press Submit again; it won't file twice.”**
  - Chat question, unavailable or uncertain: **“PeopleSoft didn't answer, so I can't show your leave right now. Nothing changed — ask again in a moment.”**
  - Card opened without balances: “PeopleSoft didn't answer, so the balance isn't shown.” (credit checks are skipped; PeopleSoft checks at Submit).
  - Wrong tool pick: “Nothing was filed — HR's AI chose the wrong PeopleSoft tool. Press Submit again.” (balance question: “HR's AI didn't choose the balance tool, so the balance isn't shown.”)
  - HR's AI didn't answer the tool choice: Submit **“HR's AI couldn't choose a PeopleSoft tool just now, so nothing was filed. Press Submit again.”** (definite, retryable, not cached); card **“HR's AI couldn't choose a PeopleSoft tool just now, so the balance isn't shown.”**; chat **“HR's AI couldn't reach PeopleSoft just now, so I can't show your leave. Nothing changed — ask again in a moment.”**
- **A card closed during its Submit stays closed.** HR passes `isClosed` (the card is no longer `awaiting_input`) into `peoplesoft.file` and checks it again after the call returns: a closed card answers with its closed message, never a receipt. `src/form-host.js` changes a form's state only while it is still `awaiting_input`.
- **Unconfirmed results are never cached.** HR marks them `retryable` / `unknownOutcome`. `src/form-host.js` does not store them in `operations`, the Hub clears `record.promise`, and the Professor turns them into `outcome_unknown` (not definite), which the browser keeps the operationId for. Without this, a second Submit with the same operationId gets the first answer and never reaches PeopleSoft.
- `/dev/hr/reset` closes every card, then calls PeopleSoft's reset; if PeopleSoft fails it answers 502 `{ status: 'failed', peoplesoft: 'unavailable' }`. `GET /test/hr/requests` (with `HR_TEST_HOOKS=1`) proxies PeopleSoft's `/test/records`. HR logs the URL and only whether the token is configured, never the token. HR logs still redact the absence name, reason and note.
- The staff check is one balances call per message; `unknown_staff` -> “HR serves university staff only.”

## 4. The time budget (`src/timeouts.js`)

**Concrete specification** (no imports; each outer wait is longer than everything inside it; `test/timeouts.test.js` checks the order; each value can be overridden by its env variable)

| Hop | Limit |
| --- | --- |
| PeopleSoft's planner | 8 s |
| HR's tool choice | 8 s |
| HR's PeopleSoft call (connect + call, counted from after the tool choice; the call keeps at least planner + 2 s = 10 s) | 12 s |
| Hub -> HR staff action | 25 s (students keep 8 s) |
| Hub -> specialist chat / staff request | 60 s |
| Professor -> Hub staff wait | 65 s |
| Professor's own staff-or-class model call | 10 s |
| Hub proxy -> Professor `/author/*` | 80 s |
| UI server -> Hub proxy | 85 s |

## 5. Telemetry and Topology labels (`src/hr-peoplesoft.js`, `src/topology.js`, `src/hub-agent.js`, `src/ui-server.js`)

**Concrete specification**
- HR emits `mcp_call_started { tool, moment, operationId }`, `mcp_call_result { tool, moment, ok, code, outcome, recordId, stepCount, latencyMs }`, `mcp_tool_refused { tool, moment, expected, by }` (all with the caller's run id) and `peoplesoft_session { status: connected | unreachable }` (no run id; only when the status changes: unreachable after a failed connect or a call that ended `unavailable`, connected after a connect or a call PeopleSoft answered — the pill follows it).
- The Hub's allowlist (`SAFE_FIELDS`) gains `tool`, `moment`, `recordId`, `stepCount`, `expected`, `unknownOutcome` (`by` is already there). The code passes only if it is a fixed refusal code. Nothing else about the request passes.
- Add `peoplesoft_session` to the UI server's `CONFIG_EVENTS`, or the tile stays on “Not connected yet”.
- `src/topology.js`: node name `peoplesoft`, edge `hr-peoplesoft`, labels for the call (“tools/call create_absence_request”), the result (“Saved as ABS-000101”, “PeopleSoft refused (not_enough)”, “PeopleSoft didn't answer”), the refused pick (inside HR: “HR's AI picked a tool not allowed here — no call”, or “HR's AI didn't answer — no call” when `by` is `model_failed`) and the session. An unconfirmed Submit is **unknown** (amber) on every hop: HR's `form_action_result` and the Hub's `form_result_relayed` and `relay_sent` carry `unknownOutcome` and are labelled phase `unknown` (“outcome unknown”), never red “rejected”. Labels contain a tool name, a record id or a fixed code, never staff words.

## 6. Topology shows PeopleSoft (design F) (`public/topology.js`, `public/styles.css`, `public/index.html`)

**Concrete specification**
- Node `peoplesoft`: `{ x: 770, y: 890, w: 176, h: 80, kind: 'system' }`, a rounded tile 176 x 80 (rx 16) below HR with a database icon at the left, “PeopleSoft” and “MCP SERVER”, a ✦ sparkle in the top right and a status pill under it. **No circle, no orbit ring, no model box (there is no `llm-peoplesoft`).** The viewBox grows to `0 0 1100 990`.
- The edge `hr-peoplesoft` is a dash-dot line (`14 4 2 4`), two lanes with a gap of 7, labelled **MCP**; pulses on it are hexagons (`M-4,-7 L4,-7 L8,0 L4,7 L-4,7 L-8,0 Z`) captioned `tools/call`. Lanes leaving HR start below its status pill. Captions go to the left of the tile.
- Busy: the tile gets `busy` from the `tool attempted` pulse until the matching result, for at least 1.2 s and at most 30 s. While busy, the sparkle twinkles and a light sweeps across the tile (clipped to it); the pill says “● Working…”. After a result starting with “Saved” the pill says “✓ Saved” for 3 s, then the session status: “✓ Connected”, “✕ Unreachable” or “○ Not connected yet” (“? Unknown” while the live view is down).
- Colours: `--ps` light `#c2410c`, dark `#fb8a4c`; `--ps-tint` light `#fff1e8`, dark `#3a2216`. (Amber was too close to the Hub's gold.)
- Reduced motion: the OS setting stops the animation; the Reduce motion checkbox adds `.still` to the node, which stops both animations.
- Details panel: “PeopleSoft — demo stand-in”, “Reached only by the HR Agent, over MCP. Fictional data.”, status, last call (label + time), and the three tool names. **No step names anywhere.** The edge panel says “MCP tool calls from the HR Agent to PeopleSoft (demo stand-in), not A2A.” The legend gets a row “MCP tool call (dash-dot line = MCP to PeopleSoft)”.
- Pulses play in agent-timestamp order; the spacing between pulses carries over from one 100 ms batch to the next (`nextSlot`). A label for an edge the page does not draw is ignored, never thrown on.
- Animated parts (`.spark`, `.sweep`) sit inside positioned `<g>` elements.

## 7. Seven processes (`scripts/start-all.js`, `package.json`, `scripts/demo/rehearsal-stack.js`)

**Concrete specification**
- `scripts/start-all.js` starts a seventh process `psoft` (`src/peoplesoft-mcp.js`, `PEOPLESOFT_MODE` live with `DEMO_MODE=live`, else mock). It makes `PEOPLESOFT_TOKEN` with `crypto.randomBytes(24).toString('hex')` on every start and gives it to `psoft` and `hr` **only**: remove any `PEOPLESOFT_TOKEN` already in the environment from every other process. Never print it. The start message says “Starting seven processes: …”.
- `package.json`: `peoplesoft` and `peoplesoft:live`.
- The rehearsal stack starts PeopleSoft at base+6 with its own random token (HR and PeopleSoft only), gives HR `PEOPLESOFT_URL`, forbids port 41246, and waits for PeopleSoft's listening line before it prints “rehearsal ready”.
- Test harness: `startStack({ hr: true })` always starts PeopleSoft on a pre-picked port with a random token (`stack.peoplesoft`, `stack.peoplesoftToken`) and gives HR `PEOPLESOFT_URL` and `PEOPLESOFT_TOKEN` (a test HR must never follow a real PeopleSoft on 41246); `startHr` alone defaults `PEOPLESOFT_URL` to the closed port 9. Add `stopProcess(p)` (checks `exitCode`/`signalCode` before awaiting `exit`) and `toolChoiceReply` to the fake Anthropic server.

## 8. Tests and checks

- New: `test/peoplesoft-store.test.js`, `peoplesoft-model.test.js`, `peoplesoft-mcp.test.js`, `hr-peoplesoft.test.js`, `hr-peoplesoft-budget.test.js`, `topology-peoplesoft.test.js`, `timeouts.test.js`. `test/hr.test.js` starts its own PeopleSoft. The old `hr-store` test moved to the PeopleSoft store test.
- `scripts/browser-checks/peoplesoft.js` (37 checks) on a **separate** rehearsal stack: `node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock`, then `playwright-cli -s=ps open http://127.0.0.1:5544/professor` and `playwright-cli -s=ps run-code "$(cat scripts/browser-checks/peoplesoft.js)"`. Open every screenshot (ps-1 to ps-5).
- Live run, as you asked (at least 20 scenarios): approvals, refusals (`not_enough`, `overlap`, a holiday boundary), PeopleSoft down and back up, a second press after “didn't answer”, a wrong tool pick, reset, a restart in the middle. Fix anything found.

## 9. Docs

README “Part 15”, the CLAUDE.md “Part 15 (PeopleSoft over MCP) notes”, this file and the two README tables.

## Avoid these known problems

- **A cylinder alone reads as a direct database connection** (your words: “this does not make it feel like its an MCP connection it just feels like a direct db connection”). Show the MCP line, the hexagon `tools/call` pulses and the words “MCP SERVER”.
- **Too much drawing is worse.** A cylinder with a turning ring, and a hexagon with tool chips, were both too complex. Design F is the rounded tile with a small database icon, a sparkle and a sweep.
- **Never draw PeopleSoft like an agent.** A circle, an orbit ring or its own model box was rejected (“it cant be mistaken with an agent and it cant have a model tied to it”). Its AI shows only as the sparkle and the sweep.
- **Don't use an amber colour.** It was too close to the Hub's gold; use the orange `--ps`.
- **In the SVG, a CSS animation `transform` overrides the SVG `transform` attribute.** Wrap animated parts in a positioned `<g>`.
- **A reused operation id with different values must be refused as `operation_reused`.** Returning the earlier receipt hid the mismatch. Check the stored operation before the planner (no model call).
- **Put the timeouts in the right order.** The Hub (8 s) once gave up before HR's tool choice plus the MCP call (20 s), so the PeopleSoft sentence never showed. Every outer wait must be longer than everything inside it (section 4). The MCP deadline must start after the tool choice, or a slow choice shortens the call.
- **Chat questions need their own sentence.** “press Submit again” makes no sense in the chat; use the chat sentence.
- **A wrong tool pick must say so honestly.** It is a definite rejection (“nothing was filed”), not an unknown outcome, and it is not cached.
- **Don't cache an unconfirmed Submit** at the form host, the Hub or the Professor. Otherwise the retry never reaches PeopleSoft and the first “didn't answer” sticks forever.
- **PeopleSoft must close its MCP sessions on SIGTERM.** An open stream kept the process alive.
- **Reconnect once, only when the session is unknown.** After a PeopleSoft restart HR's session is stale (404/400, the tool never ran). Never retry after a timeout: the filing may have happened.
- **Accept a refusal code only from the fixed set** of ten (including `bad_hours` and `reset_during_call`). Anything else is null; the code, never the sentence, goes to telemetry.
- **Strip the receipt's `steps`** before the card, chat, Professor, A2A and telemetry. Step names on screen are an anti-goal.
- **The Hub's allowlist hides new fields.** Add `tool`, `moment`, `recordId`, `stepCount` and `expected` to `SAFE_FIELDS`, or Topology labels show “[n chars redacted]”. Add `peoplesoft_session` to `CONFIG_EVENTS`, or the pill never leaves “Not connected yet”.
- **Pulses could play out of order.** The stagger restarted at 0 for each 100 ms batch, so an MCP answer could play before its call and the tile stayed on “Working…”. Carry the spacing across batches.
- **An unknown edge must not throw.** A label for an edge the page doesn't draw froze the Professor chat at “Sending…” and left a stale operation id in localStorage (“operation ID already used with different values”). Ignore it; a fresh browser session clears the stale attempt.
- **A test HR must never follow the real PeopleSoft.** Always give HR a test PeopleSoft or the closed port 9, never 41246. Never run `npm run demo` (or anything on 4444 or 41241–41246) while the owner's demo runs.
- **After `npm install` of the MCP SDK, Express once failed to load (no `body-parser`).** Run `npm install` again. A hung first `npm test` came from this.
- **`node --test` can hang when a test fails before closing its server.** Use `--test-force-exit` while iterating.
- **Never print or log the PeopleSoft token** or HR's `callKey`.
- **New conversation during a Submit filed the old card into the fresh records** (final review). Form-host checked the card once, before HR awaited its AI and PeopleSoft awaited its planner; the reset reseeded PeopleSoft, then the old call wrote into it and form-host turned the closed card into “accepted”. Use the store's reset generation, HR's `isClosed` check before and after the call, and let form-host change only an open form.
- **A failed tool-choice model call was reported as “HR's AI chose the wrong PeopleSoft tool”.** A slow or rate-limited provider is not a wrong pick: return `tool_choice_failed` and say “HR's AI couldn't choose a PeopleSoft tool just now …”.
- **An unconfirmed Submit showed red “rejected” on the HR and Hub hops** while the PeopleSoft hop showed amber “unknown”. Carry `unknownOutcome` to every hop's event and label it `unknown`.
- **The pill kept saying “✓ Connected” after a call failed on an open session.** Report `unreachable` when a call ends `unavailable`, and `connected` again on the next success.
- **A slow connect could leave the call less time than PeopleSoft's planner** (the floor was 1 s). Keep a floor of planner + 2 s for the call inside the same 12 s.

## Done when

- `npm test` passes and `node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock` plus the browser check give 37 of 37.
- `npm run demo` prints “Starting seven processes”, and `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:41246/mcp` prints `401`.
- A Submit from the Professor view shows a request number from PeopleSoft, and Topology shows the MCP line lighting up and the tile working.

## Enhancements merged into this step

- **Design (your words above).** From a first idea (“show me a design”) through six rounds to design F: a rounded tile with a database icon, sparkle and sweep, and a dash-dot MCP line. Rejected on the way: squares for agents, a circle around PeopleSoft, a lone cylinder, a cylinder with a turning ring, a hexagon with tool chips, anything agent-like or with a model box.
- **Smart system.** HR's AI picks the tool at both moments (“ask the AI at both moments”), and PeopleSoft's wrapper has its own AI that plans steps from a fixed menu; code decides every fact.
- **Third tool and nine codes.** `list_absence_requests` keeps the chat “my requests” answer working and gives HR's AI a real choice. `bad_hours` joined the refusal codes because it was already a code-decided refusal.
- **Retry honesty (from the reviews).** `retryable` results are never cached; the MCP deadline starts after the tool choice; one reconnect only for an unknown session.
- **Time budget.** Staff actions got their own 25 s limit, and every outer wait was lengthened (section 4).
- **Topology fixes (from the browser check).** Pulse order across batches, and unknown edges ignored.
- **Final-review fixes.** New conversation during a Submit can't file (reset generation, `reset_during_call`, HR's closed check, form-host keeps a closed form closed); honest words when HR's AI doesn't answer the tool choice (`tool_choice_failed`); an unconfirmed Submit is amber “unknown” on every hop; the PeopleSoft pill follows failed and recovered calls; the call keeps a floor of planner + 2 s.
