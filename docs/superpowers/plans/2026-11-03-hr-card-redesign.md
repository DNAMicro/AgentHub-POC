# HR Time-off Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the HR time-off card on the real CHRS absence name + reason list, with two dropdowns, a 3-second summary, part days worked out from the hours, ⓘ notices, a 12-month department-chair sample person, and balances/requests answered in the chat.

**Architecture:** A new dependency-free shared module (`src/absence-types.js`, also served to the browser) holds the 51 pairs and the pure time-off arithmetic, so the HR Agent, the validators and the browser's live summary agree. The A2UI card keeps standard 0.9 components (two filterable ChoicePickers); the dropdown look, the summary and the ⓘ tooltips are drawn by `public/classroom.js` + CSS around HR's surface, as the current card's headline and balance already are.

**Tech Stack:** Node ESM (no TypeScript), `@a2ui/lit` 0.14.0 / A2UI v0.9, node:test, playwright-cli for browser checks.

**Spec:** `docs/superpowers/specs/2026-11-02-hr-agent-time-off-design.md` — §12 (2026-11-03 revision) is binding where it differs from earlier sections. Approved mockup: `docs/superpowers/specs/2026-11-03-hr-card-redesign.html`. Data: `docs/superpowers/specs/2026-11-03-absence-types.psv` (51 lines `TYPE|Name|REASON|Reason`).

## Global Constraints

- Read `CLAUDE.md` (Part 14 notes) first; every rule there still applies: model proposes, code decides; R1 a wrong date/hour is worse than null; nothing posted or filed on a guess; HR records in memory only; all servers on 127.0.0.1; no new dependencies; browser text via `textContent` only (no `innerHTML`).
- `src/forms.js` and `src/absence-types.js` stay dependency-free (both are served to the browser under `/shared/`).
- Absence data comes only from the `.psv` file's 51 rows, verbatim (names, codes, reason text). Display text for the professor uses the names/reasons as written there.
- Standard day = 8 hours. Balances (synthetic): vacation 96, sick 120, personalHoliday 8. Credit types: `VAC`→`vacation`, `SCK`→`sick`, `PHL`→`personalHoliday`; all other types use no credit.
- Sample person: `staff-amir`, display name “Professor Amir”, role “Department chair”, appointment “12-month”.
- Copy (exact): privacy ⓘ — `Your manager, your timekeeper and Payroll Services can read this note. For anything confidential, talk to your manager directly.`; proof ⓘ — `JRY`: `Your manager will need a copy of your jury summons or certificate of service.`, `WTS`: `Your manager will need a copy of the subpoena.`, `MLA`: `Your manager will need a copy of your military orders.`; spread question — `Is that {first} on {firstDay} and the rest in full, or {each} each day?`
- Tests run with `PATH=/opt/homebrew/opt/node/bin:$PATH`. Never touch `data/*.json`. Never start servers on the real ports (41241–41245, 4444); the user's live demo runs there.
- **Do not commit** (the owner has not asked for commits on this build). Each “Commit” step below means: stop and report the files you changed; the controller snapshots them on a private ref.
- Between Task 2 and Task 5 the full suite is expected to be red in HR files the later tasks own; each task runs the test files it lists. Task 9 runs everything.

## Review Focus

1. A follow-up that changes the name on an open card (“actually make it sick leave”) must clear a reason that does not belong to the new name — Task 5 test `follow-up name change clears a foreign reason`.
2. A message naming a relative not in the reason list (“my cousin passed away”) must give Bereavement + `OTH` Other, never a closer-looking relative — Task 4 test `cousin maps to Other`.
3. Hours typed on the card that fit both spreads (12 h over Thu–Fri) with no words to decide must not be filed as either — Task 2 test `ambiguous spread is ask` and Task 5 test `ambiguous card hours ask in chat`.
4. A stale reason value posted by an old browser (`absenceReason` not in the type's list) must be refused by every validator — Task 3 test `reason from another type is refused`.
5. The balance-question route must not open a card or file anything (“how much sick leave do I have?”) — Task 7 test `balance question gets text, no card`.

---

### Task 1: Shared absence list and time-off arithmetic

**Files:**
- Create: `src/absence-types.js`
- Modify: `src/ui-server.js` (serve `/shared/absence-types.js` next to `/shared/forms.js`, line ~251)
- Test: `test/absence-types.test.js`

**Interfaces:**
- Produces (all named exports, no imports):
  - `ABSENCE_TYPES: { type, name, code, reason }[]` — the 51 rows in file order.
  - `absenceNames(): { type, name }[]` — 34, order of first appearance.
  - `reasonsOf(type): { type, name, code, reason }[]`; `isPair(type, code): boolean`; `nameOf(type): string|null`.
  - `defaultReason(type): string|null` — the code when the type has one reason, or exactly one reason whose text equals the name; else null.
  - `titleOf(type, code): { title: string, subtitle: string|null }` — subtitle is the reason unless it equals the name or is `None`/`none`.
  - `CREDIT_OF_TYPE = { VAC: 'vacation', SCK: 'sick', PHL: 'personalHoliday' }`; `CREDIT_LABEL = { vacation: 'vacation', sick: 'sick leave', personalHoliday: 'personal holiday' }`.
  - `PROOF: { JRY, WTS, MLA }` and `NOTE_PRIVACY` (exact copy in Global Constraints).
  - `HOLIDAYS` (moved from `src/hr-store.js`: `['2026-11-11','2026-11-26','2026-11-27','2026-12-25']`), `STANDARD_DAY = 8`, `MAX_SPAN_DAYS = 400`.
  - `workdays(begin: 'YYYY-MM-DD', end): string[]` — Mon–Fri minus HOLIDAYS, inclusive; `[]` for bad input or end < begin; bounded by MAX_SPAN_DAYS (move the store's implementation; it needs its own `addDays`).
  - `spreadOf(days: number, hours: number, words: 'start_day_only'|'all_days'|null): { mode: 'full'|'one_day'|'start_day_only'|'all_days'|'ask'|'invalid', first?: number, each?: number }` — rules in spec §12 “Partial days”. `invalid` when hours ≤ 0, hours > 8·days, or no rule fits.
  - `daysText(hours): string` — `"13½ days"`, `"¼ day"`, `"1 day"`, `"2 days"`, `"14¾ days"`; quarters only (other fractions: hours with one decimal, e.g. `"1.4 days"`).
  - `whenText({ beginDate, endDate, hours, spread, startAt?, side? }): string` — plain text, no markup; uses `shortDate` (move from hr-store, “Thu, Nov 5”). Shapes: full `Thu, Nov 5 to Fri, Nov 6, 2 days`; one day partial `Fri, Nov 6, 2 hours, from 15:00` (side `arrive`: `until 10:00`; no clock when startAt unknown); start_day_only `Thu, Nov 5 from 12:00 (4 hours), then Fri, Nov 6 in full` (3+ days: `then the next 2 days in full`); all_days `Mon, Nov 9 to Wed, Nov 11, 4 hours each day`; ask `Thu, Nov 5 to Fri, Nov 6, 12 hours`.

- [ ] **Step 1: Write failing tests** in `test/absence-types.test.js`:
```js
assert.equal(ABSENCE_TYPES.length, 51); assert.equal(absenceNames().length, 34);
assert.deepEqual(reasonsOf('SCK').map((r) => r.code), ['BRV', 'FAM', 'SCK']);
assert.equal(defaultReason('VAC'), 'VAC'); assert.equal(defaultReason('JRY'), 'JRY'); assert.equal(defaultReason('OTH'), '10');
assert.equal(defaultReason('BRV'), null); assert.equal(defaultReason('SCK'), null);
assert.deepEqual(titleOf('BRV', 'GGP'), { title: 'Bereavement', subtitle: 'Grandparent/Great Grandparent' });
assert.deepEqual(titleOf('CFR', 'NON'), { title: 'California Family Rights Act', subtitle: null });
assert.equal(isPair('VAC', 'GGP'), false);
assert.deepEqual(workdays('2026-11-10', '2026-11-12'), ['2026-11-10', '2026-11-12']); // Nov 11 holiday
assert.deepEqual(spreadOf(2, 16, null), { mode: 'full' });
assert.deepEqual(spreadOf(1, 2, null), { mode: 'one_day', first: 2 });
assert.deepEqual(spreadOf(2, 12, null), { mode: 'ask' });                       // "ambiguous spread is ask"
assert.deepEqual(spreadOf(2, 12, 'start_day_only'), { mode: 'start_day_only', first: 4 });
assert.deepEqual(spreadOf(3, 12, null), { mode: 'all_days', each: 4 });        // 12 ≤ 16: only all-days fits
assert.equal(spreadOf(2, 20, null).mode, 'invalid');
assert.equal(daysText(116), '14½ days'); assert.equal(daysText(2), '¼ day'); assert.equal(daysText(8), '1 day');
assert.equal(whenText({ beginDate: '2026-11-05', endDate: '2026-11-06', hours: 12, spread: { mode: 'start_day_only', first: 4 }, startAt: '12:00' }), 'Thu, Nov 5 from 12:00 (4 hours), then Fri, Nov 6 in full');
```
- [ ] **Step 2:** Run `node --test test/absence-types.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement `src/absence-types.js` with the 51 rows copied verbatim from the `.psv`; add the `/shared/absence-types.js` route (same pattern as `/shared/forms.js`).
- [ ] **Step 4:** Run the test → PASS. Run `node --test test/ui.test.js` → PASS (route addition only).
- [ ] **Step 5: Commit** `src/absence-types.js src/ui-server.js test/absence-types.test.js` — “HR: shared absence list (51 CHRS pairs) and time-off arithmetic”.

### Task 2: HR store on types, reasons and two partial spreads

**Files:**
- Modify: `src/hr-store.js`
- Test: `test/hr-store.test.js`

**Interfaces:**
- Consumes: Task 1 (`HOLIDAYS`, `workdays`, `shortDate`, `CREDIT_OF_TYPE`, `CREDIT_LABEL`, `isPair`, `nameOf`, `MAX_SPAN_DAYS`, `STANDARD_DAY`). `hr-store` re-exports `HOLIDAYS` and `shortDate` for existing importers.
- Produces:
  - `plan(staffId, { absenceType, beginDate, endDate, partial }) → { ok, hours, days, credit: { type, now, after } | null } | { ok:false, code, reason, ... }` — `partial` is `null`, `{ mode: 'start_day_only', hours }` (first day only) or `{ mode: 'all_days', hours }` (every workday); both: 0 < hours < standardHours else `bad_hours`. Holiday-boundary, `too_long`, `no_workdays`, `not_enough` unchanged (message: `Not enough sick leave: 16 hours needed, 8 left.`).
  - `submit(staffId, { absenceType, absenceReason, beginDate, endDate, partial }, operationId)` — refuses `!isPair(type, reason)` with code `bad_reason`; receipt `{ requestId, absenceType, absenceReason, absenceName, reasonText, beginDate, endDate, hours, status: 'sent_to_manager' }`; the operation key includes the reason.
  - `balances(staffId) → { vacation, sick, personalHoliday } | null`; `requests(staffId) → receipt[]` (newest first).
  - Staff record adds `role: 'Department chair'`, `appointment: '12-month'`.

- [ ] **Step 1: Update/add tests** (replace `absenceName` with `absenceType`/`absenceReason` across the file), including:
```js
assert.equal(store.plan('staff-amir', { absenceType: 'SCK', beginDate: '2026-11-09', endDate: '2026-11-11', partial: { mode: 'all_days', hours: 4 } }).hours, 8); // Nov 11 holiday → 2 workdays × 4
assert.equal(store.submit('staff-amir', { absenceType: 'VAC', absenceReason: 'GGP', beginDate: '2026-11-06', endDate: '2026-11-06' }, 'op1').code, 'bad_reason'); // "reason from another type is refused"
assert.deepEqual(store.balances('staff-amir'), { vacation: 96, sick: 120, personalHoliday: 8 });
```
- [ ] **Step 2:** `node --test test/hr-store.test.js` → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `src/hr-store.js test/hr-store.test.js` — “HR store: absence type + reason, all-days partials, balances and requests”.

### Task 3: The card (A2UI) and its validators

**Files:**
- Modify: `src/forms.js` (remove `ABSENCE_NAMES`, `CREDIT_OF`, `RELATIONSHIP_REQUIRED`, `RELATIONSHIP_LABEL`; rework `staff-time-off`, `validateTimeOff`, `checkTimeOffValues`, `buildTimeOffForm`)
- Test: `test/hr-form.test.js` (and the A2UI schema validation it already runs)

**Interfaces:**
- Consumes: Task 1 (`absenceNames`, `reasonsOf`, `isPair`, `defaultReason`, `workdays`, `spreadOf`).
- Produces:
  - Card fields `['absenceType', 'absenceReason', 'beginDate', 'endDate', 'hours', 'note']`. ChoicePicker values are one-element arrays of codes (`['BRV']`, `['GGP']`).
  - `reasonPicker(type: string|null) → A2UI component` — id `absenceReason`, `ChoicePicker`, `filterable: true`, `displayStyle: 'chips'`, `variant: 'mutuallyExclusive'`, options `reasonsOf(type)` as `{ label: reason, value: code }` (empty array for null). Used by `buildTimeOffForm` and by the browser (Task 6) to swap the options with `updateComponents`.
  - `buildTimeOffForm(surfaceId, { prefill, missing })` — components (ids): `absenceType` (ChoicePicker, filterable chips, 34 options `{ label: name, value: type }`, label `Absence name`), `absenceReason` (`reasonPicker`), `beginDate`, `endDate` (DateTimeInput date-only), `hours` (TextField numeric), `note` (TextField longText, label `Note for your manager (optional)`), buttons `submit_button` (`Submit request`) / `cancel_button`. Submit's check: both pickers non-empty. No relationship component.
  - `validateTimeOff(input)` — errors keys: `absenceType` (`Choose an absence name.`), `absenceReason` (`Choose a reason.` when empty or not a pair of the type), `beginDate`, `endDate`, `hours` (also `invalid` spread → `These hours don't fit the dates.`), `note` (≤ 1000). Unknown keys refused (`checkKeys`).
  - `checkTimeOffValues(input)` — same per-field rules, keys as above.

- [ ] **Step 1: Tests:** builder output validates against the v0.9 schema; `absenceType` has 34 options and `filterable: true`; `reasonPicker('SCK').options.map((o) => o.value)` is `['BRV','FAM','SCK']`; no component with id `relationship`; `validateTimeOff({ absenceType: ['VAC'], absenceReason: ['GGP'], ... }).errors.absenceReason === 'Choose a reason.'`; hours `12` over `2026-11-05..06` validates (the spread question is asked by HR, not refused); hours `20` over the same days → `These hours don't fit the dates.`; an extra key `relationship` → refused.
- [ ] **Step 2:** `node --test test/hr-form.test.js` → FAIL. **Step 3:** implement. **Step 4:** → PASS; also `node --test test/form.test.js test/booking.test.js` → PASS (other workflows untouched).
- [ ] **Step 5: Commit** `src/forms.js test/hr-form.test.js` — “HR card: absence name + reason dropdowns (A2UI ChoicePicker), no relationship row”.

### Task 4: Reading the request (name + reason, partial days)

**Files:**
- Modify: `src/hr-model.js`, `src/hr-intent.js`
- Test: `test/hr-intent.test.js`, `test/hr.test.js` (mock-mode cases)

**Interfaces:**
- Consumes: Task 1, Task 2 (`plan`), Task 3 field names.
- Produces:
  - `chooseAbsence({ text, emit }) → { absenceType, absenceReason, quote, note, model, error? }` — live schema `pair` enum = the 51 `"TYPE:CODE"` keys + `''`; code verifies: quote in the words; for `BRV` and `SCK:FAM` the reason comes from `reasonForRelative(text)` (code, from the professor's own words), never from the model; `BRV` with no relative named → reason `''`; `SCK` with no relative → `SCK`; any other type → the model's reason if `isPair`, else `defaultReason(type)`.
  - `reasonForRelative(text): string|null` — fixed map: grandmother/grandfather/grandparent/great-grand… → `GGP`; grandchild/grandson/granddaughter → `AGC`; son/daughter/child/kid → `ASD`; aunt/uncle → `AUN`; son-in-law/daughter-in-law → `CIL`; mother-in-law/father-in-law/parent-in-law (step- forms too) → `PIL`; mother/father/mom/dad/parent/stepmother/stepfather → `PSP`; sister/brother/sibling/sister-in-law/brother-in-law → `SBS`; wife/husband/spouse/partner → `SDP`; cousin/niece/nephew → `OTH`. Longest match wins (“mother-in-law” before “mother”). For `SCK` any of these words → `FAM`.
  - `readRequest({ text, now, emit }) → { prefill: { absenceType, absenceReason, beginDate, endDate }, partial, startAt?, side?, quote, missing, datesUnclear?, error? }` — `missing` ⊆ `['absenceType','absenceReason','dates']`.
  - Partial over several days (new, R1-strict): `start_day_only` only when the message's single hour cue (Rule A) sits in the same clause as the **first** day of the range and the remaining days are named as out/off (“leaving at noon on Thursday and I'll be out Friday”); `all_days` only from an explicit “N hours each/every/a day”. Any other hour cue in a multi-day message → `partial: null` and `missing` gains nothing (full days; the professor sees the hours on the card).
  - Mock heuristic (labelled) mirrors the live outcome for: passed away/funeral/died → `BRV`; sick/ill/not feeling well/doctor → `SCK` (`FAM` when a relative is named with it); jury → `JRY`; conference/workshop/training → `PDL`; personal holiday → `PHL`; vacation/trip → `VAC`; otherwise `''`.

- [ ] **Step 1: Tests** (each by name): `grandmother maps to GGP` (`reasonForRelative('my grandmother passed away') === 'GGP'`); `mother-in-law before mother` (`'PIL'`); `cousin maps to Other` (`chooseAbsence` mock on “my cousin passed away” → `{ absenceType: 'BRV', absenceReason: 'OTH' }`); `funeral with no relative leaves reason empty` (→ `BRV`, `''`, missing has `absenceReason`); `sick with my son is family care` (→ `SCK`/`FAM`); `noon Thursday out Friday is start day only` (`readRequest` text “I'm not feeling well, I'm leaving at noon on Thursday and I'll be out Friday” with now 2026-11-03 → dates 11-05..11-06, `partial: { mode: 'start_day_only', hours: 4 }`, `startAt: '12:00'`); `four hours each day` (“4 hours each day Mon to Wed next week” → `all_days` 4); `two cues over two days gives full days` (“leaving at noon Thursday and at 3 Friday” → `partial: null`). Keep every existing Rule A single-day test green.
- [ ] **Step 2:** run both files → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `src/hr-model.js src/hr-intent.js test/hr-intent.test.js test/hr.test.js` — “HR reading: name + reason from the words, relatives to CHRS reasons, multi-day part days”.

### Task 5: HR Agent card data, merges and the staff path

**Files:**
- Modify: `src/hr-agent.js`, `src/professor-staff.js` (`receiptText`, card-values keys), `src/staff.js` (`cardValues` keys), `src/ui-server.js` (`/api/professor/hr/actions` field list), `src/hub-agent.js` only if it names HR fields
- Test: `test/hr.test.js`, `test/hub-staff.test.js`, `test/professor-staff.test.js`, `test/hr-ui.test.js`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `hrCard` (in the card's `extra`): `{ title, subtitle, when, why, intro, question, problem, missing, credit: { type, label, now, after } | null, proof: string|null, balances: { vacation, sick, personalHoliday }, spread: { mode, first?, each? }, startAt: string|null, side: string|null }` — `why` = `Picked from what you wrote: “{quote}”.`; `missing` ⊆ `['absenceType','absenceReason','dates','spread']`; `question` for `spread` uses the Global Constraints copy, e.g. `Is that 4 hours on Thu, Nov 5 and the rest in full, or 6 hours each day?`.
  - Follow-up merge: reason cleared when the (new) type does not list it, then `defaultReason`; a relative named in the follow-up fills the reason when the current type is `BRV` (or `SCK` → `FAM`); an answer to the spread question (“the first day only” / “each day” / “first day”) sets `start_day_only` / `all_days`.
  - `receiptText(r)`: `Sent to your manager for a decision. Request {id}: {absenceName} ({reasonText}), {dates}, {hours} hours.` — the reason in parentheses only when `titleOf` gives a subtitle.
  - Logs: redact `note` and `absenceReason` (it can be a relationship); never log chat text.

- [ ] **Step 1: Tests:** `follow-up name change clears a foreign reason` (card BRV/GGP, follow-up “actually make it sick leave” → `absenceType: SCK`, reason `''`, missing `absenceReason`); `ambiguous card hours ask in chat` (card values hours 12 over Thu–Fri, no words → `missing` has `spread`, `question` as above, nothing filed); `spread answer first day` (“the first day only” → `start_day_only` 4, submit receipt hours 12); staff signature/route tests unchanged in substance, field names updated; `hr-ui` posts `{ absenceType: ['SCK'], absenceReason: ['SCK'], ... }` and gets a receipt.
- [ ] **Step 2:** run the four files → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5: Commit** the listed files — “HR Agent: name + reason card data, spread question, staff path field names”.

### Task 6: The card in the browser (summary, dropdowns, ⓘ)

**Files:**
- Modify: `public/classroom.js` (HR section ~lines 310–430), `public/styles.css` (`.hr-card` block ~720–790)
- Modify: `scripts/browser-checks/hr-card.js`
- Test: `test/hr-ui.test.js` (DOM-free parts only); browser check below

**Interfaces:**
- Consumes: `hrCard` (Task 5), `/shared/absence-types.js` (Task 1), `reasonPicker` from `/shared/forms.js` (Task 3).
- Produces (DOM contract for checks): `.hr-card` contains `.hr-slip` (`.hr-what`, `.hr-why`, `.hr-when`, `.hr-left` with `.hr-left-n`, `.hr-bar` with `.hr-keep`/`.hr-use`, `.hr-bar-labels`, or `.hr-free`), then HR's `a2ui-surface`, then `.hr-because`; ⓘ = `.hr-info > button[aria-describedby] + [role=tooltip]`.
  - Live summary: subscribe to the surface data model (`/absenceType`, `/absenceReason`, `/beginDate`, `/endDate`, `/hours`) and recompute title/subtitle/when/left from the shared module + `hrCard.balances` (server values stay authoritative on Submit).
  - Name change: send `updateComponents` with `reasonPicker(newType)` and set `/absenceReason` to `[defaultReason(newType)]` or `[]`.
  - Dropdown behaviour (CSS in the approved mockup, adapted to `.hr-card a2ui-choicepicker`): closed shows only the selected chip (or a placeholder button `Choose…`), click opens the renderer's `.a2ui-filter-input` + list, picking closes, Esc/outside click closes; placeholder for an empty name is amber when `absenceType` is missing.
  - ⓘ: hover, focus and tap (click toggles `aria-expanded`); privacy ⓘ after the note label; proof ⓘ after the title for `PROOF` types.
  - Submit disabled until both pickers have a value (bind via the existing `/ui/submitLocked` pattern or the Button check from Task 3).

- [ ] **Step 1:** Update `scripts/browser-checks/hr-card.js` to assert on a separate mock stack: grandmother card shows `.hr-what` “Bereavement”, `.hr-why` “Grandparent/Great Grandparent”, `.hr-free` text; open the name dropdown, type `sick`, pick `Sick Leave` → reason list is exactly `Bereavement, Family Care, Sick Personal`, `.hr-left` becomes `13 days of sick leave left after this`; Esc closes; hovering the note ⓘ shows the privacy text; no console errors.
- [ ] **Step 2:** Run it (playwright-cli) → FAIL. **Step 3:** implement. **Step 4:** run → PASS; look at its screenshots; `node --test test/hr-ui.test.js` → PASS.
- [ ] **Step 5: Commit** `public/classroom.js public/styles.css scripts/browser-checks/hr-card.js` (+ test if changed) — “Professor view: redesigned HR card (3-second summary, dropdowns, ⓘ notes)”.

### Task 7: Balances and requests in the chat

**Files:**
- Modify: `src/hr-agent.js`, `src/hr-intent.js` (`asksBalance(text)`, `asksRequests(text)`), `src/professor-staff.js` / `src/professor-model.js` (route these questions to HR as staff requests, mock and live)
- Test: `test/hr.test.js`, `test/professor-staff.test.js`

**Interfaces:**
- `asksBalance(text): 'vacation'|'sick'|'personalHoliday'|'all'|null` — e.g. “how much sick leave do I have?”, “what's my vacation balance”, “my leave balances”; `asksRequests(text): boolean` — “show my requests”, “what have I filed”.
- HR answers as text, no card, nothing filed: `You have 15 days (120 hours) of sick leave.`; all: one line per credit; requests: `You have no time-off requests.` or one line per receipt `TO-…: Bereavement (Grandparent/Great Grandparent), Thu, Nov 5 to Fri, Nov 6, 16 hours — sent to your manager.`
- The desk: a message where `asksBalance || asksRequests` is true is a `staff_request` (no unsure question), in mock and live.

- [ ] **Step 1: Tests:** `balance question gets text, no card` (reply text exact as above; no `formRef`; HR request count unchanged); `requests list after submit`; desk routes “how much sick leave do I have?” to HR in mock mode.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** — “HR: balances and requests answered in the chat”.

### Task 8: Documentation

**Files:**
- Modify: `Steps/14-hr-agent-time-off.md`, `Steps-classroom/14-hr-agent-time-off.md`, `Steps/README.md`, `Steps-classroom/README.md` (only if the index text changes), `README.md` (Part 14 section), `CLAUDE.md` (Part 14 notes: replace the relationship/ABSENCE_NAMES rules with the type+reason, spread, ⓘ, summary rules; keep everything else)
- Copy the two Step 14 files to `/Users/farsheed/Documents/MyApps/AgentHub-Exercise/` at the same relative paths (do not commit there).

- [ ] **Step 1:** Rewrite the Step 14 prompts so running them rebuilds the current card (CLAUDE.md “Steps folder” rule): merge the owner's 2026-11-03 decisions into the instructions; add every bug found during Tasks 1–7 to “Avoid these known problems”; add “Enhancements merged into this step” entries (real list, dropdowns, 3-second summary, part days from hours, ⓘ, 12-month chair, chat balances).
- [ ] **Step 2:** `grep -n "Relationship\|ABSENCE_NAMES\|Sick – Self\|Bereavement/Funeral" CLAUDE.md README.md Steps/14-hr-agent-time-off.md Steps-classroom/14-hr-agent-time-off.md` → only historical mentions in the “Enhancements merged” sections.
- [ ] **Step 3: Commit** the POC doc files — “Docs: HR card redesign (Step 14, README, CLAUDE.md)”.

### Task 9: Whole-suite and live verification

- [ ] **Step 1:** `PATH=/opt/homebrew/opt/node/bin:$PATH npm test` → all pass (report the count).
- [ ] **Step 2:** `npm run build:ui` → OK.
- [ ] **Step 3 (controller, not a subagent):** restart the user's live demo from this branch (`env -u ANTHROPIC_BASE_URL npm run demo:live`, startup lines say `API host: api.anthropic.com`), run the headed walkthrough on http://127.0.0.1:4444 (grandmother → submit; leaving at noon Thursday + out Friday; “I need Friday off” → answer “vacation” in chat; 12 hours typed on a Thu–Fri card → spread question; “how much sick leave do I have?”; class message; student refused by HR), and look at every screenshot.
