# Step 15 — PeopleSoft over MCP: where the time-off request is really stored

Time: about 90 minutes. Cost: free (tests use mocks and the local fake). Optional live check: PAID, a few cents.

(Numbered 15 because 12 and 13 are reserved by the guardrails design and 14 is the HR Agent.)

## What you'll see when it works

- In **Faculty view**, file time off exactly as in Step 14. The card looks the same. The receipt now carries a request number from PeopleSoft, like `ABS-000101` (Step 14 used `TO-…`).
- Open **Topology**. Below the HR Agent there is a rounded **PeopleSoft** tile (a small database icon, “PeopleSoft”, “MCP SERVER”, a ✦ sparkle) joined to HR by a dash-dot line labelled **MCP**. It has no circle and no model box.
- Press Submit. A hexagon pulse runs down the MCP line, the tile shows “● Working…” with a twinkling sparkle and a sweeping light, then “✓ Saved” and “✓ Connected”. The event list says “tools/call create_absence_request” and “Saved as ABS-000101”.
- Click the tile. It says “PeopleSoft — demo stand-in”, lists three tools, and shows no internal step names.
- Stop only PeopleSoft and press Submit. The chat says “PeopleSoft didn't answer. Nothing is filed until it confirms — press Submit again; it won't file twice.” Start it again, press Submit once more, and exactly one request is filed.

## Starting point

Steps 0–11 and 14 are done and `npm test` passes. `npm run demo` currently starts six processes; after this step it starts seven. Install the new package: `npm install --save-exact @modelcontextprotocol/sdk@1.32.1`, then run `npm install` once more and check `npm ls zod` shows one version (3.25.76).

## Instructions for Claude (lead)

Use the three phases from Step 0: Contracts → parallel Build → Join and check.

1. Run `npm test` first and confirm it passes.
2. Write the Phase 1 contracts yourself.
3. Start **all four tasks in the table in ONE message** with the Agent tool.
4. Join, run the checks, fix failures, append the CLAUDE.md notes and commit `Part 15: seven processes, docs and Step 15`.

Don't stop to ask questions. Everything you need is in this file and Step 0. **Never run anything on ports 4444 or 41241–41246 if a demo is already running there.**

## Phase 1 — Contracts (lead writes these first)

1. **`src/timeouts.js` (new, no imports):** `TIMEOUTS = Object.freeze({ peoplesoftPlannerMs: 8000, hrToolChoiceMs: 8000, hrAbsenceModelMs: 30000, hrPeopleSoftCallMs: 12000, hubStaffActionMs: 25000, hubFormActionMs: 8000, hubDispatchMs: 60000, professorStaffClassifierMs: 10000, professorStaffMs: 65000, hubAuthorProxyMs: 80000, uiProfessorCallMs: 85000 })`. A test checks that every outer wait is longer than everything inside it.
2. **`src/peoplesoft-store.js`:** `REFUSAL_CODES = ['not_enough','holiday_boundary','no_workdays','too_long','overlap','bad_reason','operation_reused','unknown_staff','bad_hours','reset_during_call']`; `createPeopleSoftStore({ now })` → `{ staff(id), balances(staffId), requests(staffId), file(staffId, values, operationId, steps), stored(operationId), reset() }`. `src/leave-rules.js` exports `planAbsence` (the Step 14 `plan` rules, now taking `{ standardHours, balances }`).
3. **`src/peoplesoft-model.js`:** `PEOPLESOFT_MODE` (`mock` default | `live`, read at import), `STEP_MENU` = `check_balance`, `check_dates_and_holidays`, `check_overlap`, `apply_leave_policy`, `route_to_manager`, `notify_timekeeper`, `store_record`; `REQUIRED_STEPS` = `check_balance`, `check_dates_and_holidays`, `check_overlap`, `store_record`; `planSteps(values, { emit })` → `{ steps, by, model }`; `peoplesoftStatus()`.
4. **Events:** HR emits `mcp_call_started { tool, moment, operationId }`, `mcp_call_result { tool, moment, ok, code, outcome, recordId, stepCount, latencyMs }`, `mcp_tool_refused { tool, expected }`, and run-less `peoplesoft_session { status: 'connected' | 'unreachable' }`. Topology edge `hr-peoplesoft`; node `peoplesoft`.
5. **Exact sentences** (export from `src/hr-agent.js`): `PEOPLESOFT_UNAVAILABLE` = “PeopleSoft didn't answer. Nothing is filed until it confirms — press Submit again; it won't file twice.” and `PEOPLESOFT_UNAVAILABLE_CHAT` = “PeopleSoft didn't answer, so I can't show your leave right now. Nothing changed — ask again in a moment.”
6. **Colours:** `--ps` `#c2410c` (dark `#fb8a4c`), `--ps-tint` `#fff1e8` (dark `#3a2216`).

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/peoplesoft-mcp.js`, `src/peoplesoft-store.js`, `src/leave-rules.js`, `src/peoplesoft-model.js`, `test/peoplesoft-store.test.js`, `test/peoplesoft-model.test.js`, `test/peoplesoft-mcp.test.js`, `test/support/harness.js` (`startPeopleSoft`) | The PeopleSoft process, its store, rules and planner; delete `src/hr-store.js` | The three test files pass |
| B | sonnet | `src/hr-peoplesoft.js`, `src/hr-model.js` (`MOMENT_TOOL`, `chooseTool`), `src/hr-agent.js`, `src/form-host.js`, `src/hub-agent.js`, `src/professor-staff.js`, `src/timeouts.js`, `test/hr-peoplesoft.test.js`, `test/hr-peoplesoft-budget.test.js`, `test/timeouts.test.js`, `test/hr.test.js`, `test/support/fake-anthropic.js` (`toolChoiceReply`), `test/support/harness.js` (`startStack({ hr: true })`) | HR as the MCP client, the retry rules and the time budget | Those test files pass |
| C | sonnet | `src/topology.js`, `src/hub-agent.js` (`SAFE_FIELDS`), `src/ui-server.js` (`CONFIG_EVENTS`), `public/topology.js`, `public/styles.css`, `public/index.html`, `scripts/browser-checks/peoplesoft.js`, `test/topology-peoplesoft.test.js` | Topology labels and design F | `node --check public/topology.js` and the topology test |
| D | sonnet | `scripts/start-all.js`, `package.json`, `scripts/demo/rehearsal-stack.js`, `README.md` | Seven processes, the token, the scripts | `node --check scripts/start-all.js` |

Tasks B, C and D need A's exports and the contracts above. Each task writes against the contracts; the lead joins them.

### Task A — details

1. **Server:** `127.0.0.1:41246` (`PORT`), MCP SDK 1.32.1 over Streamable HTTP, one session per client. Bearer token `PEOPLESOFT_TOKEN` is required (exit with a message that does not print it if missing); wrong or no header → 401 (`timingSafeEqual`). Host guard on all routes. Malformed JSON → 400 `{ error: 'bad_request' }`. On SIGTERM close every MCP session first. Startup lines: `PeopleSoft MCP server (demo stand-in) listening on http://127.0.0.1:<port>` and `[PeopleSoft] mode: <mode>, planner: <model>`; live also logs `API host: …`.
2. **Tools (zod arguments; dates must be real calendar dates; partial hours > 0 and ≤ 24):** `get_leave_balances { staffId }`, `list_absence_requests { staffId }`, `create_absence_request { staffId, absenceType, absenceReason, beginDate, endDate, partial, operationId }`. Every tool description says it is a demo stand-in.
3. **Create:** a known operationId goes straight to `store.file(..., [])` with no model call (a reused id with different values → `operation_reused`). Otherwise `planSteps`, then `store.file(...)`. The store re-checks everything (balance, dates and holidays, overlap with the same person's filed requests, hours) in one synchronous check-and-write. Request ids `ABS-000101`, `ABS-000102`, …; reset restarts the counter. The result is `isError` with `{ code, reason }` for a refusal. Steps are stored with the record, never shown. Filing deducts nothing from the balance (owner's decision: no tracking beyond memory, like library loans).
4. **Planner:** mock returns `apply_leave_policy`, `route_to_manager` plus the required steps (`by: 'mock'`, model `'mock heuristic'`). Live: Haiku 5.5, 400 tokens, 8 s (`PEOPLESOFT_MODEL_TIMEOUT_MS`), `maxRetries: 0`, no fallback; schema `{ steps: enum(menu)[] }`. Code adds the required steps, drops unknown names, de-duplicates. A model failure gives the required steps only.
5. **Test-only:** with `PEOPLESOFT_TEST_HOOKS=1`: `GET /test/records` and `PEOPLESOFT_TEST_DELAY_MS`. `POST /dev/reset` reseeds and is origin-guarded.

### Task B — details

1. **Link:** `createPeopleSoftLink({ url, token, emit, timeoutMs = 12000 })` → `balances`, `requests`, `file`, `reset`, `records`, `close`. Lazy connect (SDK `Client` + `StreamableHTTPClientTransport`, bearer header), `tools/list` cached per connection. For each call: `chooseTool({ moment, tools, emit })`; if the pick is not `MOMENT_TOOL[moment]`, emit `mcp_tool_refused` and make no call. Otherwise `mcp_call_started` → `callTool` → `mcp_call_result`. Code builds the arguments.
2. **Outcomes:** `ok`; `refused { code, reason }` (keep `code` only if it is in `REFUSAL_CODES`, else null); `unavailable` (401, no session, connection refused); `uncertain` (timeout, any other mid-call error). Strip the receipt's `steps` in the link; report only `stepCount`.
3. **One deadline** covers connect, `tools/list`, a reconnect and the call; it starts after the tool choice. **Reconnect once, only on HTTP 404/400 (session unknown).** Never retry after a timeout.
4. **`chooseTool`:** `MOMENT_TOOL = { balances: 'get_leave_balances', requests: 'list_absence_requests', file: 'create_absence_request' }`. Mock: the moment's tool, labelled. Live: one `callModel` (schema `{ tool: enum(tools) }`, purpose `choose PeopleSoft tool`, 8 s via `HR_TOOL_CHOICE_TIMEOUT_MS`); the prompt ends with `HR needs to: <moment in plain words>`. A failure gives `tool: null` (no call, no fallback).
5. **HR agent:** remove every `store.*` use. Card issue and re-issue call `balances`; a balance question calls `balances`; a requests question calls `requests`; Submit calls `file`. `unknown_staff` → “HR serves university staff only.” Balances unavailable → the card opens without balances and the problem “PeopleSoft didn't answer, so the balance isn't shown.” Submit `refused` → the card reopens with the reason. Submit `unavailable`/`uncertain` → `PEOPLESOFT_UNAVAILABLE`, marked `retryable` and `unknownOutcome`. Wrong tool at Submit → “Nothing was filed — HR's AI chose the wrong PeopleSoft tool. Press Submit again.” Chat: `PEOPLESOFT_UNAVAILABLE_CHAT`. `/dev/hr/reset` closes cards, then calls PeopleSoft's reset (502 `{ status: 'failed', peoplesoft: 'unavailable' }` if that fails). Log the URL and whether the token is configured; never the token.
6. **Never cache unconfirmed results:** `form-host` does not store a `retryable` result in `operations` and returns `retryable: true`; the Hub clears `record.promise` for it and passes `retryable` on; the Faculty agent turns it into `outcome_unknown` (not definite) with HR's sentence.
7. **Time budget:** Hub staff actions wait `hubStaffActionMs`, other form actions keep `hubFormActionMs`; use the table values for the rest.
8. **Harness:** `startStack({ hr: true })` always starts PeopleSoft on a pre-picked port with a random token and gives HR `PEOPLESOFT_URL`/`PEOPLESOFT_TOKEN`; `startHr` alone points at the closed port 9, never 41246; add `stopProcess(p)` (check `exitCode`/`signalCode` before awaiting `exit`).

### Task C — details

1. **Labels (`src/topology.js`):** node `peoplesoft`; edge `hr-peoplesoft`; `mcp_call_started` → “tools/call <tool>”; `mcp_call_result` → “Saved as <recordId>”, “PeopleSoft answered”, “PeopleSoft refused (<code>)”, or “PeopleSoft didn't answer” (unavailable/uncertain); `mcp_tool_refused` stays inside HR; `peoplesoft_session` sets the pill. Labels never contain staff words.
2. **Allowlist:** `SAFE_FIELDS` gains `tool`, `moment`, `recordId`, `stepCount`, `expected`. `peoplesoft_session` joins `CONFIG_EVENTS` in the UI server.
3. **Design F (`public/topology.js`):** `NODES.peoplesoft = { x: 770, y: 890, w: 176, h: 80, kind: 'system' }`, a rounded tile (rx 16) with a database icon at the left, “PeopleSoft” / “MCP SERVER”, a ✦ sparkle top right, a sweep gradient clipped to the tile, a status pill under it (y 64). No circle, no orbit, no `llm-peoplesoft`. The viewBox is `0 0 1100 990`. Animated parts sit in positioned `<g>`s.
4. **Edge:** dash-dot `14 4 2 4`, lane gap 7, label **MCP**, hexagon pulses (`M-4,-7 L4,-7 L8,0 L4,7 L-4,7 L-8,0 Z`) captioned `tools/call`. Lanes leaving HR start below its status pill.
5. **Busy:** from the “tool attempted” pulse to the matching result, at least 1.2 s and at most 30 s; pill “● Working…”; after “Saved…” the pill shows “✓ Saved” for 3 s, then “✓ Connected” / “✕ Unreachable” / “○ Not connected yet” (“? Unknown” while the live view is down). Reduced motion (OS setting or the checkbox) stops both animations.
6. **Pulse order:** the spacing between pulses carries across 100 ms batches (`nextSlot`). A label for an edge the page does not draw is ignored, never thrown on.
7. **Details panel:** “PeopleSoft — demo stand-in”, “Reached only by the HR Agent, over MCP. Fictional data.”, status, last call, the three tool names. The edge panel: “MCP tool calls from the HR Agent to PeopleSoft (demo stand-in), not A2A.” A legend row for the MCP line. No step names anywhere.
8. **Browser check** `scripts/browser-checks/peoplesoft.js`: 36 checks (node, class, no circle/orbit/disc, no model box, tile size, icon, sparkle, sweep, edge, viewBox, aria-label, legend, layout, a real filing lights the lane and shows Working then Saved then Connected, details text, no step names, reduced motion both ways, dark colours). Screenshots `ps-1` to `ps-5`.

### Task D — details

1. **`scripts/start-all.js`:** a seventh process `psoft` → `src/peoplesoft-mcp.js` with `PEOPLESOFT_MODE` live when `DEMO_MODE=live`. Make `PEOPLESOFT_TOKEN` with `randomBytes(24).toString('hex')` on every start; give it to `psoft` and `hr` only and remove any inherited `PEOPLESOFT_TOKEN` from the others. Never print it. Start message: “Starting seven processes: …”.
2. **`package.json`:** `peoplesoft` (`node src/peoplesoft-mcp.js`) and `peoplesoft:live`.
3. **Rehearsal stack:** PeopleSoft at base+6 with its own random token (HR and PeopleSoft only), HR gets `PEOPLESOFT_URL`, port 41246 is forbidden, and “rehearsal ready” waits for PeopleSoft's listening line.
4. **README:** a “Part 15” section, the new row in the process table, the env variables, the file table.

## Phase 3 — Join and check (lead)

1. `npm run build:ui`, then `npm test` (run files one at a time with `--test-timeout` while building; use `--test-force-exit` when iterating, because a test that fails before closing its server can hang).
2. Prove the token wiring without the demo ports: `PEOPLESOFT_TOKEN=x PORT=52111 node src/peoplesoft-mcp.js &`, then `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:52111/mcp` must print `401`; stop it by PID.
3. On a **separate stack**, never the running demo: `node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock`, then `playwright-cli -s=ps open http://127.0.0.1:5544/faculty` and `playwright-cli -s=ps run-code "$(cat scripts/browser-checks/peoplesoft.js)"`. Expect 36 of 36. Open every screenshot and look at it.
4. Live (PAID, cents), only when no other demo is on those ports: `env -u ANTHROPIC_BASE_URL npm run demo:live` (the startup lines say `API host: api.anthropic.com` and seven processes start). Run at least 20 scenarios: an approval, `not_enough`, `overlap`, a holiday boundary, PeopleSoft stopped and restarted, a second Submit after “didn't answer”, a balance question, New conversation. Fix anything you find.

## Rules that apply to the whole step

- The model proposes, code decides: dates, hours, balances, pass or fail and tool arguments come from code. HR's AI names a tool; code checks it. PeopleSoft's AI names steps from the menu; code adds the required ones and runs them.
- PeopleSoft is a demo stand-in and says so. It never looks like an agent and has no model box. The UI never shows the wrapper's steps.
- Only HR can call PeopleSoft (the per-start token). Never print or log the token.
- Everything binds to `127.0.0.1`. Records are in memory only; nothing under `data/`.
- No automatic retry of a filing. The one exception is a reconnect when the session is unknown.
- Dependency versions pinned exactly.

## Avoid these known problems

- Don't draw PeopleSoft as a lone cylinder (it reads as a direct database connection), a cylinder with a ring, or a hexagon with tool chips (too complex). Use design F.
- Don't give PeopleSoft a circle, an orbit ring or a model box. It must not be mistaken for an agent.
- Don't use amber; it is too close to the Hub's gold. Use `--ps`.
- Wrap animated SVG parts in a positioned `<g>`; a CSS transform overrides an SVG `transform` attribute.
- A reused operation id with different values is `operation_reused`, never the old receipt. Check the stored operation before the planner.
- Keep the time limits nested (the table in `src/timeouts.js`). The MCP deadline starts after the tool choice.
- Chat questions use the chat sentence, not “press Submit again”.
- A wrong tool pick is a definite “nothing was filed”, not cached.
- Never cache an unconfirmed Submit at the form host, the Hub or the Faculty agent.
- Close the MCP sessions on SIGTERM or PeopleSoft will not exit.
- Reconnect once, only when the session is unknown. Never retry after a timeout.
- Accept a refusal code only from the nine; anything else is null.
- Strip the receipt's `steps` before the card, chat, Faculty, A2A and telemetry.
- Add `tool`, `moment`, `recordId`, `stepCount`, `expected` to `SAFE_FIELDS` and `peoplesoft_session` to `CONFIG_EVENTS`.
- Carry pulse spacing across batches; ignore labels for edges the page does not draw.
- A test HR must point at a test PeopleSoft or port 9, never 41246. Never run on 4444 or 41241–41246 while a demo runs there.
- After installing the MCP SDK, run `npm install` a second time if Express fails to load (missing `body-parser`).

## Done when

- `npm test` passes (the new files are `peoplesoft-store`, `peoplesoft-model`, `peoplesoft-mcp`, `hr-peoplesoft`, `hr-peoplesoft-budget`, `topology-peoplesoft` and `timeouts`).
- The browser check passes 36 of 36 and the screenshots match the description above.
- `npm run demo` prints “Starting seven processes”, and a POST to `http://127.0.0.1:41246/mcp` with no token returns 401.

## CLAUDE.md notes

```
## Part 15 (PeopleSoft over MCP) notes
- PeopleSoft stand-in (src/peoplesoft-mcp.js, :41246, npm run peoplesoft / peoplesoft:live, PEOPLESOFT_MODE mock|live) is a fictional demo stand-in, MCP SDK 1.32.1, Streamable HTTP, bearer token PEOPLESOFT_TOKEN (start-all makes a random one per start, gives it to psoft and hr only, never prints it). Records are in memory only (src/peoplesoft-store.js); src/hr-store.js is gone.
- Three tools: get_leave_balances, list_absence_requests, create_absence_request (idempotent by operationId). HR's AI chooses the tool at both moments (card issue, Submit); MOMENT_TOOL decides which tool is allowed; a mismatch makes no call (mcp_tool_refused). PeopleSoft's planner picks steps from a fixed menu; code adds the four required steps and runs them.
- Nine refusal codes (REFUSAL_CODES); a code outside the set becomes null. Unavailable/uncertain: exact Submit and chat sentences. retryable/unknownOutcome results are never cached (form-host, Hub, Faculty). Reconnect once only when the session is unknown.
- Nested time budget in src/timeouts.js: 8 / 8 / 12 / 25 / 65 / 80 / 85 s; change together.
- Receipt steps are stripped in the link. Telemetry: mcp_call_started, mcp_call_result, mcp_tool_refused, peoplesoft_session (in CONFIG_EVENTS); SAFE_FIELDS gains tool, moment, recordId, stepCount, expected.
- Topology design F: tile, sparkle, sweep, dash-dot MCP line; no circle, no model box, no step names.
- startStack({ hr: true }) starts PeopleSoft with a random token; a test HR never follows 41246. Browser check scripts/browser-checks/peoplesoft.js runs on a separate rehearsal stack.
```

## Show it (optional)

- PAID (a few cents): `env -u ANTHROPIC_BASE_URL npm run demo:live`, open the Faculty view and Topology side by side, and file “My grandmother passed away, I need this Thursday and Friday.” Watch HR's model box light, then the MCP line, then the PeopleSoft tile working.
- Stop PeopleSoft by its PID, press Submit, read the “didn't answer” sentence, start it again and press Submit once more.

## Enhancements merged into this step

- **Design F** replaced six rounds of drawings (your words in `Steps/15-peoplesoft-mcp.md`): a rounded tile with a database icon, sparkle and sweep, and a dash-dot MCP line, with no agent look and no model box.
- **Ask the AI at both moments**: HR's AI picks the tool when the card opens and at Submit.
- **Retry rules from the reviews**: unconfirmed results are never cached, one reconnect only for an unknown session, the MCP deadline starts after the tool choice, and the time limits are nested.
- **Fixes from the browser check**: pulse order across batches, and unknown edges ignored.
- Renamed what the audience sees (2026-11-04): the agent is “Marketing 101 Faculty”, the tab is “Faculty view” (/faculty; /professor still opens it), and the person is “Dr. Dabirian” (was “Professor Amir”), because “Professor” confused the audience. Code names, files, settings and commands keep “professor”. Students may still type “professor”: keep accepting it (the Student agent treats a title word — professor, faculty, instructor, Dr. — as naming whoever the last reply named with a title).
