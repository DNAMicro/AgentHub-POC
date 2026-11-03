# HR Agent (staff time off) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Professor Amir asks for time off in the Professor view chat; the Hub routes it to a new staff-only HR Agent, which fills the CHRS absence fields from his words, runs the Forecast, and shows one edit-in-place card; Submit records it and HR says it was sent to his manager.

**Architecture:** A sixth process `src/hr-agent.js` (like the Library Agent) with an in-memory store. A new **staff path** through the Hub: the Professor agent sends a signed staff data part (like lesson publishes), the Hub verifies it, maps the professor to a staff record, routes only to staff destinations, forwards to HR over A2A with a Hub staff signature, and answers the Professor with a data part carrying HR's text/card. The Professor view renders the fixed A2UI card with the vendored renderer.

**Tech Stack:** Node ESM, `@a2a-js/sdk` 1.3.0, A2UI v0.9 (`@a2ui/lit` vendored bundle), `@anthropic-ai/sdk` via `src/llm.js` `callModel`, node:test, playwright-cli for browser checks.

**Spec:** `docs/superpowers/specs/2026-11-02-hr-agent-time-off-design.md` (owner-approved 2026-11-02). Card mockup: `.superpowers/brainstorm/76555-1793667686/content/hr-card-v4.html` (git-ignored; copy its CSS where noted).

## Global Constraints

- **Project rule:** every "Commit" step runs only after the owner says to commit; until then, stop at the passing tests and report.

- All servers bind `127.0.0.1`; HR default port **41245** (`PORT` env; `HR_URL` overrides the Hub's peer URL).
- Dependencies pinned exactly; **no new dependencies**.
- HR records (staff, balances, requests) **in memory only**; reseed on start and on New conversation. Never write `data/`.
- The Professor chat stores HR exchanges like other messages (owner): saved in the outbox, visible to the Professor model's recent context. The open card's live state is memory only; the chat keeps its outcome text.
- Model proposes, code decides: absence name only from `ABSENCE_NAMES`; its "because" quote and any relationship must appear in the professor's words (case-insensitive substring); dates/hours only from code. No reason given → Absence name empty and asked.
- HR serves **staff only**: Hub-signed staff caller; students never reach HR (not on the Hub card, not in the student router, refused if forced).
- No manager simulation: receipt text **"Sent to your manager for a decision."**
- Unsure staff vs class → ask: **"Should I file this as time off with HR, tell the class, or both?"** Nothing posted or filed on a guess.
- "Both": the class gets only code-built neutral text **"Professor Amir is out on <Day, Mon D>."** (range: "… out <Day, Mon D> – <Day, Mon D>."), posted only after the professor replies yes.
- Modes: `HR_MODE` `mock` (labelled heuristic, default) | `live`; `PROFESSOR_MODE` drives the staff classifier. `maxRetries: 0`, sanitized errors, never log keys or `callKey`.
- Telemetry: HR content (absence name, relationship, note, words) never leaves through the Hub's allowlist unless `HUB_TELEMETRY_SHOW_CONTENT=1`; HR server logs redact relationship and note.
- Fictional sample data only. Card copy (fixed): intro "Here's your request. Check it and submit." (bereavement prefix "I'm sorry for your loss. ", sick prefix "Feel better soon. "), why line "Chosen because you said “<quote>”.", buttons "Submit request" / "Cancel".

## Review Focus

1. **A message that is both leave and class news** ("I'm sick, cancel Friday's class") → classified `unsure`, the question above is asked, nothing posted, nothing filed. Test in Task 6.
2. **A range that begins or ends on a campus holiday, or spans a weekend** → begin/end on a holiday refused with "An absence can't begin or end on a campus holiday (<date>).", weekends/holidays inside not counted in hours. Test in Task 2.
3. **Past absences** ("I was sick yesterday afternoon") → date = yesterday, Start Day Only, 4 hours ("afternoon"). Test in Task 3.
4. **Not enough credits** → Forecast fails; the card shows "Not enough <type> hours: <need> needed, <have> left." and Submit is refused with the same text. Test in Task 2 (store) and Task 4 (action).
5. **A student asking for time off** ("I need time off from class next week") → never routed to HR (HR absent from the student routing view and Hub card; a forced `requestedCapability: 'hr'` is rejected). Test in Task 5.

---

### Task 1: The time-off form contract (shared, dependency-free)

**Files:**
- Modify: `src/forms.js` (exports near `WORKFLOWS` 31–67, `validateFinal` 244)
- Test: `test/hr-form.test.js`

**Interfaces:**
- Produces (all exported from `src/forms.js`, browser-safe):
  - `ABSENCE_NAMES`: `['Vacation','Personal Holiday','Sick – Self','Sick – Family Care','Sick – Bereavement','Bereavement/Funeral','Jury Duty','Professional Development','Military Leave','Dock']` (en dash U+2013 as in CHRS).
  - `CREDIT_OF`: `{ 'Vacation':'vacation', 'Personal Holiday':'personalHoliday', 'Sick – Self':'sick', 'Sick – Family Care':'sick', 'Sick – Bereavement':'sick' }` (others use no credits).
  - `RELATIONSHIP_REQUIRED`: `new Set(['Bereavement/Funeral','Sick – Family Care','Sick – Bereavement'])`.
  - `WORKFLOWS['staff-time-off']` = `{ id:'staff-time-off', agentId:'hr', skillId:'staff-time-off', title:'Time off request', finalAction:'submitTimeOff', pendingText:'Sending your request…', actions:{ submitTimeOff:{ button:'submit_button', fields:['absenceName','beginDate','endDate','hours','relationship','note'], final:true }, cancelForm:{ button:'cancel_button', fields:[], cancel:true } } }`.
  - `buildTimeOffForm(surfaceId, { prefill = {}, missing = [] }) → A2UI messages[]`: Column of rows — ChoicePicker `absenceName` (options = `ABSENCE_NAMES`, single), DateTimeInput `beginDate` / `endDate` (date only), TextField `hours`, TextField `relationship` (only when `prefill.absenceName` ∈ `RELATIONSHIP_REQUIRED` or `'relationship'` ∈ missing), TextField `note` (label "Note for manager"), Buttons `submit_button` "Submit request" / `cancel_button` "Cancel". Labels end with " *" for required fields. Data model paths `/absenceName` … `/note`. Uses only the fixed-form component/function set.
  - `validateFinal('staff-time-off', values) → { ok, errors: { field: message } }`: name ∈ list; dates `YYYY-MM-DD`, begin ≤ end; hours number > 0 and ≤ 24 × days; relationship non-empty when required.

- [ ] **Step 1: Write the failing tests** in `test/hr-form.test.js`:
  - `buildTimeOffForm` output passes the A2UI schema (`test/support/a2ui-schema.js`) and `checkFormPayloadPolicy(msgs, { workflowId:'staff-time-off' })` returns ok.
  - Relationship field present for `prefill.absenceName:'Bereavement/Funeral'`, absent for `'Vacation'`.
  - `validateFinal` errors: `{absenceName:''}` → `errors.absenceName`; begin `2026-11-06` end `2026-11-05` → `errors.endDate`; Bereavement without relationship → `errors.relationship`; a complete Sick – Self 4 h request → `ok: true`.
  - `checkAction` with `sourceComponentId:'submit_button'` and the six fields → ok.
- [ ] **Step 2: Run** `PATH=/opt/homebrew/opt/node/bin:$PATH node --test test/hr-form.test.js` — Expected: FAIL (exports missing).
- [ ] **Step 3: Implement** the exports above in `src/forms.js`; keep the file dependency-free.
- [ ] **Step 4: Run** the same command plus `node --test test/form.test.js test/booking.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/forms.js test/hr-form.test.js && git commit -m "HR: time-off form contract (absence names, card, validation)"`

---

### Task 2: HR store — staff, holidays, hours, Forecast, requests (memory only)

**Files:**
- Create: `src/hr-store.js`
- Test: `test/hr-store.test.js`

**Interfaces:**
- Consumes: `ABSENCE_NAMES`, `CREDIT_OF` (Task 1); `addDays`, `todayIn` from `src/forms.js`.
- Produces: `createHrStore({ now = () => new Date() } = {})` returning
  - `staff(staffId) → { staffId, name, standardHours, balances:{ vacation, sick, personalHoliday } } | null` — fixture: `staff-amir`, "Professor Amir", 8, `{ vacation:96, sick:120, personalHoliday:8 }`.
  - `HOLIDAYS` (exported const): `['2026-11-11','2026-11-26','2026-11-27','2026-12-25']` labelled "sample campus holidays".
  - `workdays(begin, end) → string[]` (skip Sat/Sun and holidays).
  - `plan(staffId, { absenceName, beginDate, endDate, partial }) → { ok, code?, reason?, hours, days, credit:{ type, now, after } | null }` where `partial` is `null | { mode:'start_day_only', hours }`; codes `holiday_boundary`, `no_workdays`, `not_enough`.
  - `submit(staffId, values, operationId) → { ok, receipt:{ requestId:'TO-XXXXXXXX', absenceName, beginDate, endDate, hours, status:'sent_to_manager' } } | { ok:false, code, reason }` — idempotent by operationId; deducts nothing.
  - `reset()`; `_records()` (test hook).
- [ ] **Step 1: Write failing tests**: begin `2026-11-11` → `code:'holiday_boundary'`, reason exactly "An absence can't begin or end on a campus holiday (Wed, Nov 11)."; `2026-11-10`→`2026-11-12` Vacation → `days:2, hours:16`; Fri `2026-11-06`→Mon `2026-11-09` → `days:2`; Vacation 13 days (104 h) → `code:'not_enough'`, reason "Not enough vacation hours: 104 needed, 96 left."; Bereavement/Funeral → `credit:null`, ok; Sick – Self partial 4 h → `credit:{type:'sick', now:120, after:116}`; same operationId twice → same receipt; `reset()` clears requests; nothing written (no `fs` import: assert `readFileSync('src/hr-store.js','utf8')` doesn't match `/node:fs|writeFile/`).
- [ ] **Step 2: Run** `node --test test/hr-store.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/hr-store.js` (synchronous check-and-write in `submit`, like `renewLoan`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `"HR: in-memory staff store with holidays and Forecast"`

---

### Task 3: Reading the request — dates, partial days, absence name

**Files:**
- Create: `src/hr-intent.js` (code reading), `src/hr-model.js` (model choice + verification)
- Test: `test/hr-intent.test.js`

**Interfaces:**
- Produces:
  - `readDates(text, now) → { beginDate, endDate } | null` — today/tomorrow/yesterday; weekday names ("Friday"/"this Friday" = next occurrence incl. today → upcoming; "next Friday" = the one in the following week; "last Friday" = past); lists "Thursday and Friday" → first..last; ranges "Nov 10 to Nov 12", "Monday through Wednesday"; explicit `11/5`, `Nov 5`.
  - `readPartial(text) → { mode:'start_day_only', hours } | null` — "leaving at noon"/"at 1pm"/"after 2:30" → `17:00 − time`; "morning" or "afternoon" or "half day" → 4 (afternoon after a stated time uses that time); "for 2 hours" → 2.
  - `chooseAbsence({ text, emit }) → { absenceName, quote, relationship, note, model }` (in `hr-model.js`): live = one structured `callModel` (schema: `absence_name` enum of `ABSENCE_NAMES` plus `""`, `quote`, `relationship`, `note`); mock = labelled heuristic (passed away|funeral|died → Bereavement/Funeral; sick|ill|not feeling well|doctor → Sick – Self, or Sick – Family Care when "my <relative> is sick"; jury → Jury Duty; conference|workshop|training → Professional Development; vacation|trip → Vacation; "personal holiday" → Personal Holiday; else `""`). **Code then drops** a name not in the list, and drops name+quote when the quote isn't in `text`; drops a relationship not in `text`.
  - `readRequest({ text, now, emit }) → { prefill:{ absenceName, beginDate, endDate, hours?, relationship, note }, partial, quote, missing:[field…] }` combining the above; `missing` lists required fields still empty.
- [ ] **Step 1: Write failing tests** (now = 2026-11-02 Mon, 09:00 local): "this Thursday and Friday" → 11-05..11-06; "next Friday" → 11-13; "Friday" → 11-06; "today" → 11-02; with now = Tue 2026-11-03, "I was sick yesterday afternoon" → 11-02..11-02, partial `{hours:4}` ("afternoon") (Review Focus 3); "leaving at noon today" → partial `{hours:5}`; "a few days next week" → `null`; mock `chooseAbsence` for "My grandmother passed away" → Bereavement/Funeral, quote "grandmother passed away", relationship "grandmother"; "I need Friday off" → `absenceName:''` and `missing` contains `absenceName`; live via fake Anthropic returning `absence_name:'Bereavement Leave'` → dropped (not on list); returning quote "my uncle died" for text without it → name dropped.
- [ ] **Step 2: Run** `node --test test/hr-intent.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** both files (`hr-model.js` reads `HR_MODE` at import, like `library-model.js:14`; `hrStatus()` like `libraryStatus()`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `"HR: read dates, partial days and the absence name from the words"`

---

### Task 4: The HR Agent process

**Files:**
- Create: `src/hr-agent.js`, `config/hr.example.json`
- Modify: `src/config.js:82-87` (`SPECIALISTS` add `hr: { port:41245, displayName:'HR Agent', … }`), `src/hub-link.js` (add `verifiedStaff`), `package.json` (`"hr": "node src/hr-agent.js"`, `"hr:live": "HR_MODE=live node src/hr-agent.js"`), `test/support/harness.js` (`HR_READY`, `startHr(env)`, `startStack({ hr=false, hrPort, hrEnv })`, include in `kill()`, `signedStaff(hubUrl)` helper used in Task 5)
- Test: `test/hr.test.js`

**Interfaces:**
- Consumes: Tasks 1–3; `createFormHost`, `createSkillService`, `createHubLink` as in `library-agent.js:381-425`.
- Produces:
  - `hubLink.verifiedStaff(metadata, contextId) → staffId | null` — checks `metadata.callerKind === 'staff'` and HMAC over `` `staff|${staffId}|${contextId}|${hubOperationId}` `` (a student signature never verifies as staff).
  - Card: one form skill `staff-time-off` (rules `form.ids`) so the registry marks HR `ready`.
  - Chat dispatch: unverified → text "HR serves university staff only." (`hr.outcome:'refused'`); time-off request → `readRequest` → `store.plan` → `formHost.issue(ctx, bus, { workflowId:'staff-time-off', prefill, runId, intro, extra:{ hrCard:{ title, when, why, balance, missing } } })`; a chat message while that staff member's card is open → re-read, merge non-empty values, re-issue with `supersedes` (fills the card from chat); with `missing` non-empty also reply text asking for the first missing field: absenceName → "What kind of time off is this — for example vacation, sick, or a personal holiday?", dates → "Which day or days?", relationship → "Who in your family is it for?".
  - Action `submitTimeOff`: re-verify staff (`trusted`), `validateFinal`, `store.plan`, `store.submit` → `{ status:'accepted', message:'Sent to your manager for a decision.', receipt }`; refusals → `{ status:'rejected', errors }`.
  - `POST /dev/hr/reset` (origin-guarded) → `store.reset()`; with `HR_TEST_HOOKS=1` `GET /test/hr/requests`.
  - Viz events like the Library (`source:'hr'`), logs redact relationship/note.
- [ ] **Step 1: Write failing tests** in `test/hr.test.js` using `startStack({ hr:true, library:false })` and `signedStaff`: unsigned chat → refused text; a student-signed metadata → refused; staff "My grandmother passed away, I need this Thursday and Friday" → INPUT_REQUIRED task with `hrCard.title 'Bereavement/Funeral'` and prefill relationship "grandmother"; "I need Friday off" → card with `missing:['absenceName']` and the question text; follow-up "it's a vacation day" → re-issued card with Vacation; submit with 104 h Vacation → rejected with the Forecast text (Review Focus 4); valid submit → accepted, message "Sent to your manager for a decision.", `/test/hr/requests` has 1; `/dev/hr/reset` → 0.
- [ ] **Step 2: Run** `node --test test/hr.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the files and modifications above.
- [ ] **Step 4: Run** `node --test test/hr.test.js test/loans.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `"HR Agent: staff-only time-off skill with an edit-in-place card"`

---

### Task 5: The Hub's staff path

**Files:**
- Create: `src/staff.js` (media types + reply shapes)
- Modify: `src/config.js` (`loadHubConfig`: `peers` + `{agentId:'hr', …, baseUrl:'http://127.0.0.1:41245'}`, `destinations.hr = { worker:'hr', audience:'staff', name:'Human Resources', description:'Staff services: time off and absences.' }`, `staff: { professor: { staffId:'staff-amir', name:'Professor Amir' } }`), `config/hub.example.json`, `src/hub-lessons.js` (export `verifyAgentSignature(registry, msg, fields)` from the current `verifyProfessor`), `src/hub-registry.js` (`signStaffFor(agentId, { staffId, contextId, operationId })`), `src/hub-agent.js` (handle staff parts before line 155; exclude `audience:'staff'` destinations from `services()`, the Hub card skills and `requestedCapability`; classroom reset also POSTs `${hr}/dev/hr/reset`; `SAFE_FIELDS` additions: `hrOutcome`, `formRef`, `workflowId`), `src/hub-link.js` (`sendSigned(mediaType, value, fields, { timeoutMs = 15000 } = {})`)
- Test: `test/hub-staff.test.js`

**Interfaces:**
- Produces (`src/staff.js`): `STAFF_REQUEST_MEDIA_TYPE` = `application/vnd.a2a-spike.staff-request+json` (`{ type:'staff_request', operationId, conversationId, text }`, signed fields `['staff-request', operationId, conversationId]`), `STAFF_ACTION_MEDIA_TYPE` = `…staff-action+json` (`{ type:'staff_action', operationId, formRef, action }`, fields `['staff-action', operationId, formRef]`), `HUB_STAFF_MEDIA_TYPES` set. Hub reply data part: `{ status:'ok'|'refused'|'not_delivered'|'outcome_unknown', reply?: { text, servedBy:'hr', formRef?, a2ui?, hrCard?, receipt?, closed? }, reason? }`.
- Hub behaviour: verify with `verifyAgentSignature`; staffId = `cfg.staff[professorId].staffId` (unknown → `refused`); routing = the only ready staff destination (`decidedBy:'staff'`, no router call); forward with `askTutor(..., { metadata:{ hubOperationId, via, staffId, callerKind:'staff', hubSignature: registry.signStaffFor('hr', …) } })`; form replies get a `formRef` mapped to `{ staffId, conversationId, agentId:'hr', downstream… }`; actions check staffId + conversationId + TTL then `sendFormAction`; dedupe by operationId. Emits `staff_request_received`, `route_decided`, `relay_sent` with `runId: 'staff-'+operationId`.
- [ ] **Step 1: Write failing tests** with `startStack({ hr:true, professor:true })`: a professor-signed staff request returns `status:'ok'` with `hrCard`; a bad signature → `refused`; Review Focus 5 — `chatVia` as student-alex "I need time off from class next week" never yields `servedBy:'hr'`, the Hub card skills contain no `hr`, and `requestedCapability:'hr'` → `capability_rejected`; staff action Submit through the Hub → receipt; the same operationId twice → one request in `/test/hr/requests`.
- [ ] **Step 2: Run** `node --test test/hub-staff.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/hub-staff.test.js test/hub.test.js test/routing.test.js test/student-model.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `"Hub: signed staff path to HR; HR hidden from students"`

---

### Task 6: Professor agent — spot staff requests, ask when unsure, relay the card

**Files:**
- Create: `src/professor-staff.js`
- Modify: `src/professor-model.js` (`classifyStaff`), `src/professor-agent.js` (`professorChat` 288–328: call `staffTurn` first; `/author/hr-action`; `/author/state` adds `hrCard`; `/author/reset` clears staff state)
- Test: `test/professor-staff.test.js`

**Interfaces:**
- Produces:
  - `classifyStaff({ text, emit }) → { kind:'staff_request'|'class_message'|'unsure', model }` — live structured call; mock labelled heuristic: first-person leave words (`I|I'm|my`) + (time off|day off|sick|out|passed away|funeral|vacation|leave) → staff; plus class words (class|lecture|students|cancel) → unsure; else class.
  - `staffTurn({ operationId, text, hubLink, outbox }) → result | null` (null = not a staff turn, continue as today). States kept in memory: `pendingChoice` (after asking the unsure question; next message "HR"/"file it" → staff, "class" → today's path, "both" → staff then offer note), `openCard` (formRef, a2ui, hrCard), `pendingNote` (text awaiting "yes"). While `openCard` is open, any message that isn't `@assistant` goes to HR as a follow-up (fills the card).
  - Chat entries: `{ id:`${op}:h`, role:'hr', text, at, formRef?, closed? }`; the card itself is not stored (outcome text is).
  - `POST /author/hr-action { operationId, formRef, action }` → `sendSigned(STAFF_ACTION_MEDIA_TYPE, …, { timeoutMs:60000 })`; on accepted, appends `role:'hr'` receipt text "Sent to your manager for a decision. Request <id>: <name>, <dates>, <hours> h." and clears `openCard`; on "both" then appends the note offer "Want me to tell the class: “Professor Amir is out on Fri, Nov 6.”? Reply yes to post it."
- [ ] **Step 1: Write failing tests** (`startStack({ professor:true, hr:true })`, posting to `/api/professor/chat`): Review Focus 1 — "I'm sick, cancel Friday's class" → reply is the unsure question, no post created, `/test/hr/requests` empty; "Read chapter 4 before Friday" → posted as today; "I want to file for time off. My grandmother passed away, I need this Thursday and Friday" → state `hrCard.title 'Bereavement/Funeral'`, no post; follow-up "it's for a vacation day" after "I need Friday off" → card Vacation; `/author/hr-action` submit → chat has the receipt text; "both" + "yes" → one class post with text "Professor Amir is out on Fri, Nov 6.".
- [ ] **Step 2: Run** `node --test test/professor-staff.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/professor-staff.test.js test/professor.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `"Professor: file staff time off with HR from the chat; ask when unsure"`

---

### Task 7: The card on screen, Topology, and running it all

**Files:**
- Modify: `src/ui-server.js` (`POST /api/professor/hr/actions` → Hub `/dev/agents/professor/author/hr-action`; let `staff-` run events and HR viz through `relayEvent`), `src/hub-agent.js` dev proxy route for `/author/hr-action`, `src/ag-ui-professor.js` (snapshot carries `hrCard`), `public/classroom.js` (render `role:'hr'` bubbles; render the open card: header title/when/why from `hrCard`, balance bar from `hrCard.balance`, A2UI surface via `MessageProcessor` from `./vendor/a2ui.js`, missing fields highlighted; Submit/Cancel → `/api/professor/hr/actions`), `public/styles.css` (`--hr: #1f6f8b`, card rules from the mockup), `src/topology.js` + `public/topology.js` + `public/index.html` (node `hr`, edges `hub-hr`, `hr-model`, four specialists in the right column), `public/app.js` (`agentColor`, `AGENT_NAMES`), `scripts/start-all.js` (sixth process `['hr','src/hr-agent.js',{ HR_MODE }]`, banner), `scripts/browser-checks/hr-card.js` (new playwright-cli check)
- Test: `test/hr-ui.test.js` (server routes) + browser check

**Interfaces:**
- Consumes: Task 6 `/author/hr-action`, `hrCard` in `/author/state`.
- [ ] **Step 1: Write failing test**: through the UI server, `/api/professor/chat` grandmother message then `GET /api/professor/state` has `hrCard`; `POST /api/professor/hr/actions` submit → state chat has the receipt; a cross-site Origin POST → 403.
- [ ] **Step 2: Run** `node --test test/hr-ui.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the modifications.
- [ ] **Step 4: Run** `PATH=/opt/homebrew/opt/node/bin:$PATH npm test` — Expected: all pass, 0 failed.
- [ ] **Step 5: Browser check** on a separate stack (`node scripts/demo/rehearsal-stack.js` ports or `startStack`), `playwright-cli -s=hr run-code "$(cat scripts/browser-checks/hr-card.js)"`: screenshots of the Professor view card (bereavement, sick partial, missing name), Submit receipt, Topology hop hub→hr. **Look at every screenshot**; the card must match the approved mockup layout.
- [ ] **Step 6: Commit** `"HR card in the Professor view; HR on Topology; demo starts six processes"`

---

### Task 8: Docs, Steps, live check, Exercise sync

**Files:**
- Create: `Steps/14-hr-agent-time-off.md`, `Steps-classroom/14-hr-agent-time-off.md` (*my call: 14, because 12 and 13 are reserved by the guardrails design*)
- Modify: `Steps/README.md`, `Steps-classroom/README.md`, `README.md` (HR section, ports table, env vars `HR_MODE`, `HR_URL`, `HR_TEST_HOOKS`), `CLAUDE.md` (Part 14 notes: staff path, staff-only, memory-only, commands `npm run hr` / `hr:live`, six processes in `demo:live`)
- [ ] **Step 1:** Write both Step files: the owner's original request verbatim, the merged instructions from this plan, "Avoid these known problems" (everything hit while building), "Enhancements merged".
- [ ] **Step 2: Live check** on the user's machine: `env -u ANTHROPIC_BASE_URL npm run demo:live` (startup lines say `API host: api.anthropic.com`, six processes), in a hidden playwright session: bereavement, sick-at-noon, "I need Friday off" (asks), "I'm sick, cancel Friday's class" (asks), a student asking for time off (not HR). Screenshot and look at each.
- [ ] **Step 3:** Copy the new/changed Step files and companion-site content (if touched) to `/Users/farsheed/Documents/MyApps/AgentHub-Exercise`; `diff -rq` shows no differences in `Steps/` and `Steps-classroom/`.
- [ ] **Step 4: Commit** (both repos, only when the owner asks) `"Step 14: HR Agent — staff time off from the Professor chat"`
