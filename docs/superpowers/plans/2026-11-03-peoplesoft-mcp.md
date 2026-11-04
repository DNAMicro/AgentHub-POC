# PeopleSoft over MCP (Part 15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HR reaches a PeopleSoft stand-in over a real MCP connection — HR's AI chooses the tool, PeopleSoft's own AI plans the steps, code decides every fact — and Topology shows it as the approved design F.

**Architecture:** A seventh process, `src/peoplesoft-mcp.js` (MCP server, Streamable HTTP, 127.0.0.1:41246), owns staff, balances and requests (moved out of HR). HR becomes an MCP client (`src/hr-peoplesoft.js`): at each moment it asks its model which tool to use, code checks the pick and builds the arguments, then calls the tool. HR reports the calls in its own telemetry; the Hub labels them on a new `hr-peoplesoft` edge; the browser draws PeopleSoft as design F.

**Tech Stack:** Node ESM, Express 5.3.0, `@modelcontextprotocol/sdk` (pinned exactly), zod 3.25.76, Claude Haiku 5.5 via `callModel` (`src/llm.js`), node:test, playwright-cli browser checks.

**Spec:** `docs/superpowers/specs/2026-11-03-peoplesoft-mcp-design.md` (approved 2026-11-03). Approved look: option F in `.superpowers/brainstorm/27262-1793762277/content/peoplesoft-5-designs.html` (the `f(g)` builder and `.ps-f` CSS there are the reference drawing).

## Global Constraints

- PeopleSoft is a **demo stand-in**: say so in its details panel, startup log and tool descriptions. Fictional data only (Professor Amir, `staff-amir`).
- PeopleSoft never looks like an agent (no circle/orbit) and has **no model box**; its AI shows only as the tile's sparkle and sweep.
- The UI never shows the wrapper's steps (no step names on Topology, card or chat).
- Model proposes, code decides: dates, hours, balances, pass/fail and tool arguments come from code.
- `PEOPLESOFT_MODE` = `mock` | `live`, read at import; mock is a labelled heuristic (`'mock heuristic'`), no network.
- `maxRetries: 0`, no fallback model, no canned answers; errors through `toLlmError`.
- Never log keys, the PeopleSoft token or `callKey`; HR logs keep redacting absence name, reason and note.
- All servers bind `127.0.0.1`; every non-GET dev route is origin-guarded; Host guard on all routes.
- Records are in memory only (reseed on start and on New conversation); nothing under `data/`.
- Dependency versions pinned exactly.
- Refusal codes (fixed set): `not_enough`, `holiday_boundary`, `no_workdays`, `too_long`, `overlap`, `bad_reason`, `operation_reused`, `unknown_staff`.
- Step menu (fixed): `check_balance`, `check_dates_and_holidays`, `check_overlap`, `apply_leave_policy`, `route_to_manager`, `notify_timekeeper`, `store_record`. Required: `check_balance`, `check_dates_and_holidays`, `check_overlap`, `store_record`.
- PeopleSoft-unavailable sentence (exact): “PeopleSoft didn't answer. Nothing is filed until it confirms — press Submit again; it won't file twice.”
- Colours: `--ps` light `#c2410c`, dark `#fb8a4c`; `--ps-tint` light `#fff1e8`, dark `#3a2216`.

## Review Focus

1. PeopleSoft down while a card opens → the card still opens with a plain notice and no balance bar, never a crash or a hang (Task 4 test `card opens without balances when PeopleSoft is down`).
2. Submit times out at PeopleSoft but the record was written → pressing Submit again returns the same receipt, one record (Task 3 test `same operationId returns the stored receipt`, Task 4 test `uncertain submit then retry files once`).
3. A caller without the token (a browser, a student path) → 401, nothing read or written (Task 3 test `refuses calls without the token`).
4. HR's model names a tool that isn't allowed for the moment → no call is made, HR answers with a plain failure, nothing filed (Task 4 test `a wrong tool pick makes no call`).
5. New conversation while a card is open → PeopleSoft records reseed and the old card can't file into the fresh store (Task 4 test `reset reseeds PeopleSoft and closes the card`).

---

### Task 1: Shared leave rules and the PeopleSoft record store

**Files:**
- Create: `src/leave-rules.js`, `src/peoplesoft-store.js`, `test/peoplesoft-store.test.js`
- Delete: `src/hr-store.js`, `test/hr-store.test.js` (its tests move to the new file, renamed)
- Modify: `src/hr-intent.js` (import `HOLIDAYS` from `./absence-types.js` instead of `./hr-store.js`), `package.json` (+ `@modelcontextprotocol/sdk`)

**Interfaces:**
- Produces: `planAbsence(person: { standardHours, balances }, { absenceType, beginDate, endDate, partial }) -> { ok: true, hours, days, credit: { type, now, after } | null } | { ok: false, code, reason, hours?, days?, credit? }` — today's `plan()` body unchanged, minus the staff lookup.
- Produces: `createPeopleSoftStore({ now }) -> { staff(id), balances(id), requests(id), file(staffId, values, operationId, steps: string[]) -> { ok: true, receipt } | { ok: false, code, reason }, reset(), _records() }`. `receipt` = today's receipt plus `recordId: 'ABS-' + 6-digit counter starting at 000101` and `steps`.

- [ ] **Step 1: Pin the MCP SDK.** Run `npm view @modelcontextprotocol/sdk@1.32.1 version` then `npm install --save-exact @modelcontextprotocol/sdk@1.32.1`; check `package.json` shows `"1.32.1"` and `zod` stays `3.25.76` (`npm ls zod` has one version). If 1.32.1 fails Task 3's import check, use the newest version published at least two weeks earlier that passes, and note it in the commit.
- [ ] **Step 2: Move the tests.** `git mv test/hr-store.test.js test/peoplesoft-store.test.js`; change `createHrStore` → `createPeopleSoftStore` and `submit(...)` → `file(..., steps)` in every call; add:
```js
test('overlap: a request sharing a workday with a filed one is refused', () => {
  const s = createPeopleSoftStore();
  const v = { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-05', endDate: '2026-11-06', partial: null };
  assert.equal(s.file('staff-amir', v, 'op-1', ['store_record']).ok, true);
  const r = s.file('staff-amir', { ...v, beginDate: '2026-11-06', endDate: '2026-11-09' }, 'op-2', ['store_record']);
  assert.deepEqual([r.ok, r.code], [false, 'overlap']);
});
test('receipt carries a PeopleSoft record id and the steps run', () => {
  const r = createPeopleSoftStore().file('staff-amir', { absenceType: 'VAC', absenceReason: 'VAC', beginDate: '2026-11-06', endDate: '2026-11-06', partial: null }, 'op-1', ['check_balance', 'store_record']);
  assert.match(r.receipt.recordId, /^ABS-\d{6}$/);
  assert.deepEqual(r.receipt.steps, ['check_balance', 'store_record']);
  assert.equal(r.receipt.status, 'sent_to_manager');
});
test('planAbsence is the same rule HR uses', () => {
  assert.deepEqual(planAbsence({ standardHours: 8, balances: { vacation: 96, sick: 120, personalHoliday: 8 } }, { absenceType: 'VAC', beginDate: '2026-11-06', endDate: '2026-11-06' }), { ok: true, hours: 8, days: 1, credit: { type: 'vacation', now: 96, after: 88 } });
});
```
- [ ] **Step 3: Run** `PATH=/opt/homebrew/opt/node/bin:$PATH node --test test/peoplesoft-store.test.js` → FAIL (module not found).
- [ ] **Step 4: Implement** `src/leave-rules.js` (pure, imports only `absence-types.js` and `forms.js`'s `addDays`) and `src/peoplesoft-store.js` (seed, `file` = today's `submit` with the overlap check after `isPair`, synchronous check-and-write, operations in a `Map`). Delete `src/hr-store.js`.
- [ ] **Step 5: Run** the store test → PASS; `npm test` still fails only in `hr-agent`-dependent files (fixed in Task 4) — record which in the commit message.
- [ ] **Step 6: Commit** `Part 15: leave rules shared, PeopleSoft record store (overlap, record ids); pin MCP SDK`.

### Task 2: PeopleSoft's AI — the step planner

**Files:** Create `src/peoplesoft-model.js`, `test/peoplesoft-model.test.js`.

**Interfaces:**
- Produces: `PEOPLESOFT_MODE`, `STEP_MENU`, `REQUIRED_STEPS` (Global Constraints), `planSteps({ request: { absenceType, beginDate, endDate, hours }, emit }) -> Promise<{ steps: string[], by: 'model' | 'mock' | 'model_failed', model }>`; `peoplesoftStatus() -> { mode, model, keyConfigured }`.
- Rule: `steps` = every menu item that is required or picked by the model, in `STEP_MENU` order; unknown picks dropped. Mock picks `apply_leave_policy` and `route_to_manager` (labelled `'mock heuristic'`). Live: one `callModel` with schema `{ steps: { type: 'array', items: { enum: STEP_MENU } } }`, `maxTokens: 400`, purpose `'plan PeopleSoft steps'`; emits `model_call_started` / `model_response_received` / `model_call_failed` with `{ purpose, mode, model, usage }`. On failure: required steps + `route_to_manager`, `by: 'model_failed'`.

- [ ] **Step 1: Tests** (mock in-process; live against `startFakeAnthropic`, env set before a dynamic import as in `scripts/live-smoke.js`):
  `mock plan always holds the required steps in menu order`, `live: unknown and duplicate picks are dropped; required steps are added` (fake returns `{"steps":["notify_timekeeper","delete_everything","notify_timekeeper"]}` → `['check_balance','check_dates_and_holidays','check_overlap','notify_timekeeper','store_record']`), `live failure falls back to required + route_to_manager, by model_failed` (fake 500).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Part 15: PeopleSoft's AI plans the steps from a fixed menu; code adds the required ones`.

### Task 3: The PeopleSoft MCP server process

**Files:** Create `src/peoplesoft-mcp.js`, `test/peoplesoft-mcp.test.js`; modify `test/support/harness.js` (+ `startPeopleSoft(env)`).

**Interfaces:**
- Consumes: Task 1 store, Task 2 `planSteps`.
- Produces (process): env `PORT` (default 41246), `PEOPLESOFT_TOKEN` (required — refuse to start without it, exit 1 with a plain message), `PEOPLESOFT_TEST_HOOKS=1`. Log lines: `PeopleSoft MCP server (demo stand-in) listening on http://127.0.0.1:<port>` and the `API host:` line when live. Routes: `POST|GET|DELETE /mcp` (Streamable HTTP, stateful sessions, `Authorization: Bearer <token>` required → else 401 JSON `{ error: 'unauthorized' }`), `POST /dev/reset` (token-guarded, origin-guarded → `store.reset()`), `GET /test/records` (test hooks only).
- Produces (MCP tools, `McpServer.registerTool`, zod input schemas, every result has `structuredContent` and a JSON text block):
  - `get_leave_balances { staffId }` → `{ staffId, vacation, sick, personalHoliday }` or error `unknown_staff`.
  - `list_absence_requests { staffId }` → `{ requests: [...] }` (store `requests()` shape, no steps).
  - `create_absence_request { staffId, absenceType, absenceReason, beginDate, endDate, partial: { mode, hours } | null, operationId }` → runs `planSteps`, then `store.file(...)` → `{ receipt }`, or `isError: true` with `{ code, reason }`. A repeated `operationId` must not call the model again (check the store's operation map first).
  - Tool descriptions start with “Demo stand-in for PeopleSoft:”.

- [ ] **Step 1: Tests** (start the process with `startPeopleSoft({ PEOPLESOFT_TOKEN: 't', PEOPLESOFT_TEST_HOOKS: '1' })`, connect with the SDK `Client` + `StreamableHTTPClientTransport` and `requestInit: { headers: { Authorization: 'Bearer t' } }`):
  `lists exactly three tools`, `balances for staff-amir are 96/120/8`, `creates a request and lists it`, `same operationId returns the stored receipt` (two calls → one record in `/test/records`, same `recordId`), `refuses calls without the token` (raw `fetch` POST `/mcp` → 401), `refusal comes back as a tool error with a fixed code` (Nov 11 begin → `holiday_boundary`), `/dev/reset reseeds`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (routes mounted inside the `listen` callback like the other servers; check `err` first; `hostGuard(port)`, `sameOriginGuard(port)` from `src/local-guard.js`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Part 15: PeopleSoft stand-in MCP server (three tools, token, reset)`.

### Task 4: HR as MCP client; HR's AI chooses the tool

**Files:** Create `src/hr-peoplesoft.js`, `test/hr-peoplesoft.test.js`; modify `src/hr-model.js` (+ `chooseTool`), `src/hr-agent.js` (replace every `store.*` use: lines ~129, 150, 172, 215, 367, 374–375, 468, 476), `test/support/harness.js` (`startStack({ hr: true })` also starts PeopleSoft on a pre-picked port with a random token, gives HR `PEOPLESOFT_URL` + `PEOPLESOFT_TOKEN`, kills it with the stack), `test/support/fake-anthropic.js` (+ exported `toolChoiceReply(body)` that answers a tool-choice request with the tool its prompt names as expected), and existing live-HR tests' `respondWith` handlers (route tool-choice calls through `toolChoiceReply`).

**Interfaces:**
- Produces: `chooseTool({ moment: 'balances' | 'submit' | 'requests', tools: string[], emit }) -> Promise<{ tool: string | null, by: 'model' | 'mock' | 'model_failed', model }>` in `src/hr-model.js`. Live: one `callModel`, schema `{ tool: { enum: tools } }`, purpose `'choose PeopleSoft tool'`, system prompt names the moment in plain words. Mock: the moment's tool (`MOMENT_TOOL = { balances: 'get_leave_balances', submit: 'create_absence_request', requests: 'list_absence_requests' }`).
- Produces: `createPeopleSoftLink({ url, token, emit, timeoutMs = 20000 }) -> { balances(staffId, { runId }), requests(staffId, { runId }), file(staffId, values, operationId, { runId }), reset() }`. Each call: `tools/list` (cached per connection) → `chooseTool` → if `tool !== MOMENT_TOOL[moment]` emit `mcp_tool_refused` and return `{ ok: false, outcome: 'tool_refused' }` (no call) → emit `mcp_call_started { tool, moment, operationId }` → `callTool` → emit `mcp_call_result { tool, moment, ok, code, outcome, recordId, stepCount, latencyMs }` → return `{ ok: true, value } | { ok: false, outcome: 'refused', code, reason } | { ok: false, outcome: 'unavailable' | 'uncertain' }` (connection refused → `unavailable`; timeout or reset mid-call → `uncertain`). Connect lazily; on connect emit `peoplesoft_session { status: 'connected' | 'unreachable' }`.
- HR behaviour: card issue/re-issue fetches balances once (`state.balances`), `cardFor` stays synchronous and uses `planAbsence(person, …)` with them; balances unavailable → the card opens with `problem: 'PeopleSoft didn't answer, so the balance isn't shown.'` and `balances: null`. Submit → `link.file`; `refused` → card reopens with `reason` (as today); `unavailable`/`uncertain` → the exact sentence from Global Constraints, card stays open, same operationId on retry. Balance/requests chat answers go through the link. `/dev/hr/reset` → `link.reset()` (PeopleSoft `/dev/reset`) + `formHost.closeAll`. `/test/hr/requests` proxies PeopleSoft `/test/records` (keeps today's shape: `{ requests }`). Unknown staff (balances `unknown_staff`) → today's refusal text.

- [ ] **Step 1: Tests** in `test/hr-peoplesoft.test.js` on `startStack({ hr: true })` plus `professorStandIn(stack)`:
  `card issue calls get_leave_balances through MCP` (HR telemetry has `mcp_call_started { tool: 'get_leave_balances', moment: 'balances' }` before the card reply), `submit files in PeopleSoft and returns ABS record id` (`/test/hr/requests` has one record with `recordId`), `card opens without balances when PeopleSoft is down` (kill PeopleSoft first), `uncertain submit then retry files once` (PeopleSoft started with `PEOPLESOFT_TEST_DELAY_MS` > HR timeout via `hrEnv: { PEOPLESOFT_TIMEOUT_MS: '300' }`; first Submit → the exact sentence; second Submit same operationId → accepted, one record), `a wrong tool pick makes no call` (live HR + fake Anthropic answering `{ "tool": "list_absence_requests" }` at Submit → no `mcp_call_started`, nothing filed), `reset reseeds PeopleSoft and closes the card`.
  Add `PEOPLESOFT_TEST_DELAY_MS` (test hooks only) to Task 3's `create_absence_request` for this.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → all pass (existing HR, hub-staff and professor-staff tests now run through PeopleSoft).
- [ ] **Step 5: Commit** `Part 15: HR reaches PeopleSoft over MCP; HR's AI chooses the tool at both moments`.

### Task 5: Telemetry labels and the Hub allowlist

**Files:** Modify `src/topology.js`, `src/hub-agent.js` (`SAFE_FIELDS` + `'tool', 'moment', 'recordId', 'stepCount'`), `test/hub-staff.test.js` (or a new `test/topology-peoplesoft.test.js`).

**Interfaces:**
- `NODE_NAMES.peoplesoft = 'PeopleSoft (demo stand-in)'`; `hop()` returns edge `'hr-peoplesoft'` when `from` or `to` is `'peoplesoft'`.
- New HR labels (source `hr`): `mcp_call_started` → `hop('hr','peoplesoft','tool','attempted', 'tools/call ' + tool)`; `mcp_call_result` → `hop('peoplesoft','hr','tool', ok ? 'completed' : outcome === 'uncertain' ? 'unknown' : 'failed', ok ? (recordId ? 'Saved as ' + recordId : 'PeopleSoft answered') : outcome === 'refused' ? 'PeopleSoft refused (' + code + ')' : "PeopleSoft didn't answer")`; `mcp_tool_refused` → `inside('hr','tool','failed','HR’s AI picked a tool not allowed here — no call')`; `peoplesoft_session` → `hop('hr','peoplesoft','registration', status === 'connected' ? 'completed' : 'failed', status === 'connected' ? 'MCP session open' : 'PeopleSoft unreachable')`. The `'choose PeopleSoft tool'` model calls already label as `hr-model` hops.

- [ ] **Step 1: Tests** — unit: `topologyLabel({ source: 'hr', type: 'mcp_call_started', data: { tool: 'create_absence_request' } })` → `{ edge: 'hr-peoplesoft', from: 'hr', to: 'peoplesoft', category: 'tool', phase: 'attempted' }`; same for result ok/refused/uncertain; integration on a stack: the UI's monitor stream receives a labelled `hr-peoplesoft` event with `tool` intact and no absence words (search the staff-run events only, as Part 14 tests do).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `Part 15: Topology labels for MCP calls; allowlist tool fields`.

### Task 6: Topology draws PeopleSoft as design F

**Files:** Modify `public/topology.js`, `public/styles.css`, `public/index.html` (viewBox `0 0 1100 990`, aria-label mentions PeopleSoft), Create `scripts/browser-checks/peoplesoft.js`.

**Interfaces:**
- `NODES.peoplesoft = { x: 770, y: 890, w: 176, h: 80, kind: 'system', name: 'PeopleSoft', role: 'MCP server' }`; `EDGES['hr-peoplesoft'] = ['hr', 'peoplesoft']`; `EDGE_KIND` → `'mcp'` for it (dash-dot lanes `14 4 2 4`, label `MCP`); `shape('tool')` = the hexagon `M-4,-7 L4,-7 L8,0 L4,7 L-4,7 L-8,0 Z`; `CATEGORY_TEXT.tool = 'MCP tool call'`; legend row “MCP tool call (dash-dot line = MCP to PeopleSoft)”.
- Draw the node exactly as the mockup's `f(g)`: tile 176×80 rx 16, database icon at (-58, 2), name/sub shifted +14, sparkle at (68, -22), clip-path sweep; pill at y 64. Busy (class `busy`, set from an `hr-peoplesoft` attempted pulse until the matching completed/failed/unknown, or 30 s): sparkle twinkles, sweep runs, pill “● Working…”; after: “✓ Saved” for 3 s when the label starts with “Saved”, then the session status (“✓ Connected” / “✕ Unreachable” / “○ Not connected yet”). Reduced motion: no animation.
- Details panel for `peoplesoft`: “PeopleSoft — demo stand-in”, “Reached only by the HR Agent, over MCP. Fictional data.”, tools (the three names), last call (label + time). No step names.

- [ ] **Step 1: Write** `scripts/browser-checks/peoplesoft.js` (run on a separate stack, like `hr-card.js`): node exists with class `system` and no `.orbit`/`circle.disc`; no `llm-peoplesoft`; filing a request lights `[data-edge="hr-peoplesoft"]`, the node gets `busy`, then the pill reads “✓ Saved”; the event list has “tools/call create_absence_request” and “Saved as ABS-”; the details panel has no step names; screenshots `ps-1-rest.png`, `ps-2-busy.png`, `ps-3-saved.png`, dark mode `ps-4-dark.png`. Also rerun `scripts/browser-checks/hr-card.js` (must stay 77/77).
- [ ] **Step 2: Run it** → fails (no node). **Step 3: Implement.** **Step 4: Run** → all checks pass; look at every screenshot against the mockup.
- [ ] **Step 5: Commit** `Part 15: Topology shows PeopleSoft (design F) and the MCP line`.

### Task 7: Seven processes, configs and docs

**Files:** Modify `scripts/start-all.js` (seventh process `peoplesoft`, random `PEOPLESOFT_TOKEN` via `crypto.randomBytes(24).toString('hex')` given to `peoplesoft` and `hr` only, `PEOPLESOFT_MODE` live with `DEMO_MODE=live`, start message says seven), `scripts/demo/rehearsal-stack.js` (PeopleSoft at base+6, forbid 41246), `package.json` scripts (`peoplesoft`, `peoplesoft:live`), `README.md`, `CLAUDE.md` (intro sentence, Commands, a “Part 15 (PeopleSoft over MCP) notes” section, Scope constraints: PeopleSoft in `PEOPLESOFT_MODE=live` may call the LLM; seven processes), `Steps/15-peoplesoft-mcp.md`, `Steps-classroom/15-peoplesoft-mcp.md`, `Steps/README.md` table; copy both Step files to `../AgentHub-Exercise`.

- [ ] **Step 1:** `npm run demo` (mock) starts seven processes; `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:41246/mcp` → `401`. Stop it by PID.
- [ ] **Step 2:** Steps/15 = the owner's prompts verbatim (from this conversation: the PeopleSoft/MCP request, the “smart system” and “own AI” answers, “ask the AI at both moments”, design F) merged into instructions + “Avoid these known problems” (cylinder read as a direct DB; hexagon/tool chips too complex; agent look and a model box rejected; amber too close to the Hub's gold) + “Enhancements merged”.
- [ ] **Step 3:** `npm test` all pass. **Commit** `Part 15: seven processes, docs and Step 15`.

### Task 8: Live verification on the user's app

- [ ] Restart with `env -u ANTHROPIC_BASE_URL npm run demo:live`; all seven say `API host: api.anthropic.com` (PeopleSoft and HR included).
- [ ] Announce, then on http://127.0.0.1:4444 (visible browser): file a vacation day, a bereavement, an overlap (refused with the overlap sentence), a balance question and a “my requests” question; watch Topology: HR's model lights before each MCP call, the PeopleSoft tile sweeps, “Saved as ABS-…”. Screenshot each; check the student view shows no leave words.
- [ ] Report results with the six-section format; no commit without the owner's ask.
