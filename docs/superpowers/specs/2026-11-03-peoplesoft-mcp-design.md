# PeopleSoft over MCP — design (Part 15)

Date: 2026-11-03 · Branch: HRAgent · Status: draft for the owner's approval

## Intent and why

Time-off requests at CSUF live in PeopleSoft. The demo should show that the HR Agent reaches PeopleSoft
over a real **MCP** (Model Context Protocol) connection, and that the system behind it is **smart, not a
plain database**: HR's AI decides to use the PeopleSoft tool, and PeopleSoft sits behind a wrapper with
its own AI that decides how to carry the request out (checks, workflow, storing the record).

The owner's words: “the AI will make the decision to use the tool that connects to peoplesoft but the data
is dynamic and there is a wrapper around people soft that gets activated … It can invoke workflows and
validation.” The wrapper uses “its own AI”. The UI “should not show any of that complexity … just show that
there is more to it than just a database the same way we do the agent animation.”

## Goals

1. **Two moments go through MCP** (owner's choice): working out “what's left” (balances) and Submit.
2. **HR's AI decides** to call the PeopleSoft tool; code checks the choice before anything runs.
3. **The PeopleSoft wrapper has its own AI** that decides how to handle a request; code runs every step.
4. **Topology shows design F** (approved mockup: `.superpowers/brainstorm/27262-1793762277/content/peoplesoft-5-designs.html`,
   option F): a rounded tile below HR with a database icon, “PeopleSoft”, “MCP SERVER”, an AI sparkle ✦ in the
   corner, a status pill under it. While a call is worked on, the sparkle twinkles and a light sweeps across
   the tile. A dash-dot line labelled **MCP** connects HR and PeopleSoft; pulses on it use a hexagon shape
   captioned `tools/call`.
5. The rest of Topology is unchanged.

## Anti-goals (a failure even if it works)

- PeopleSoft looks like an agent (no circle, no orbit ring like the agents) or has a model box. Its AI is shown
  only by the sparkle and sweep.
- The UI shows the wrapper's internal steps (checks, workflow names) on Topology or in the card.
- Anything suggests this is Oracle's real PeopleSoft: it is a fictional **demo stand-in**, labelled so in its
  details and logs.
- Canned “thinking”: every animation step comes from a real event the processes emitted.
- A model decides a fact: dates, hours, balances and pass/fail of a check stay code-decided (project rule
  “model proposes, code decides”).

## Constraints (from the project)

- New process **PeopleSoft stand-in MCP server**, `src/peoplesoft-mcp.js`, bound to `127.0.0.1`, default port
  **41246**, started by `scripts/start-all.js` (seven processes). Records in memory only (reseed on start and on
  New conversation), never in `data/`.
- MCP via the official TypeScript SDK `@modelcontextprotocol/sdk`, pinned exactly to **1.32.1** (released
  2026-10-05; works with the pinned `zod` 3.25.76). Streamable HTTP transport.
- Models: Claude Haiku 5.5 (`claude-haiku-5-5`) through the existing `callModel` path, `maxRetries: 0`, no
  canned answers on failure, sanitized error codes. `PEOPLESOFT_MODE` = `mock` (labelled heuristic, no network)
  | `live`, read at import. `HR_MODE` keeps its meaning.
- Never log keys; HR content redaction rules stay (absence name, reason and note are never logged).
- Telemetry: real events only; the Hub's allowlist redaction applies to the new events.

## How it works (decided)

### Data moves to PeopleSoft
The staff, balances and time-off requests that live in `src/hr-store.js` move into the PeopleSoft stand-in.
HR keeps no copy. HR still reads the words, fills the card and decides dates/hours/spread as today (the
absence list and date reading are unchanged).

### MCP tools offered by PeopleSoft
- `get_leave_balances { staffId }` → `{ vacation, sick, personalHoliday }` hours.
- `create_absence_request { staffId, absenceType, absenceReason, beginDate, endDate, partial, operationId }`
  → the receipt (as today, with PeopleSoft's own record ID, e.g. `ABS-000123`) or a refusal with a reason.
  Idempotent by `operationId`; synchronous check-and-write inside the server (no `await` between check and write).

HR's existing `plan()` needs (hours, Forecast) are computed from balances fetched with `get_leave_balances`.

### HR's AI decides to use the tool
At the two moments, HR asks its model (live) which PeopleSoft tool fits, giving it the tool list from the
MCP `tools/list`. The model returns a tool name only. Code checks the name is in the list and is allowed
for that moment, then builds the arguments itself from the card's checked values — the model never supplies
arguments. Mock: a labelled heuristic picks the obvious tool.

### The wrapper's AI decides how
On `create_absence_request`, the wrapper asks its model (live) for a plan: which steps from a fixed menu to run
and in what order. Code always adds the required steps (balance, dates/holidays, overlap) whatever the model
says, refuses unknown steps, and runs each step itself. The plan and step results are stored with the record
(“dynamic storage”) and returned to HR as a short summary HR does **not** show in the UI (logs/details only,
redacted as today).

Menu (my call, editable): `check_balance`, `check_dates_and_holidays`, `check_overlap`, `apply_leave_policy`,
`route_to_manager`, `notify_timekeeper`, `store_record`.

### What the audience sees (Topology)
Real events drive it: HR → its model (choose tool) → `tools/call` pulse down the MCP line → PeopleSoft tile busy
(sparkle + sweep, pill “● Working…”) while the wrapper's AI and steps run → result pulse back (“✓ Saved”) →
HR → Hub. Event list rows name the MCP call (“HR Agent → PeopleSoft · tools/call create_absence_request”, result
“Saved as ABS-000123”). Clicking PeopleSoft opens details: demo stand-in, MCP, its tools, last call. The
wrapper's model calls show only as the tile's sparkle/sweep — no model box, no model hop.

The card and receipt look as today; the receipt may add the PeopleSoft record ID.

## Decisions from the builder check (my calls, marked for the owner to review)

1. **Rules stay in HR, data moves.** HR keeps today's date, holiday, workday, hours and Forecast rules
   (`plan()` logic, now fed by fetched balances) so the card still updates instantly on every edit with no
   network call. The wrapper re-checks the facts at Submit (it is the authority for the record).
2. **When “what's left” goes through MCP:** when a card is issued or re-issued by a follow-up, and when the
   professor asks a balance question in chat. Not on each card edit (those reuse the balances fetched for
   that card). **Owner's decision (2026-11-03): “ask the AI at both moments”** — HR's AI chooses the tool both
   when the card is issued/re-issued (balances) and at Submit (create the request), so the audience sees HR's
   model light up before each MCP call (about 1–2 s and one paid call more per card).
3. **A third tool, `list_absence_requests { staffId }`**, keeps the chat “my requests” answer working. With
   three tools, HR's AI has a real choice at each moment; code accepts only the tool allowed for that moment.
4. **Refusals use a fixed code set** (`not_enough`, `holiday_boundary`, `no_workdays`, `too_long`, `overlap`,
   `bad_reason`, `operation_reused`, `unknown_staff`) plus one plain sentence; the card reopens with that
   sentence as today. Only the code passes the Hub's telemetry allowlist. PeopleSoft down or timing out →
   “PeopleSoft didn't answer. Nothing is filed until it confirms — press Submit again; it won't file twice.”
   (same operationId; never an automatic retry).
5. **Status stays `sent_to_manager`.** `route_to_manager` / `notify_timekeeper` are recorded steps only.
6. **Overlap = refused:** a new request sharing any workday with one of the same person's filed requests.
7. **Only HR can call PeopleSoft:** a per-start random token that `start-all` (and the test harness) gives to
   both processes; PeopleSoft refuses other callers. Bound to 127.0.0.1 with the Host/Origin guard.
   `staffId` is trusted because only HR (which got it from the Hub's signed staff path) holds the token.
8. **The Hub doesn't register PeopleSoft.** It is HR's private backend; HR reports its MCP calls and
   PeopleSoft's busy/result events in its own telemetry feed, and the Hub's topology labels them on a new
   `hr-peoplesoft` edge.
9. **SDK pin is verified at plan time** (exports, Streamable HTTP server/client, zod 3.25.76); if 1.32.1 fails,
   the plan picks the newest version at least two weeks old that works.

## Left to the builder

File layout inside `src/`, event names (keep `mcp_*` naming), how the Hub relays/labels the new feed,
test layout (`startStack({ peoplesoft: true })`, fake Anthropic for live paths), the rehearsal stack port
(base+6), and the exact CSS.
