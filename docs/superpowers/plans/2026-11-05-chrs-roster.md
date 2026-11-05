# CHRS Roster (Part 17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A staff-only CHRS agent with its own PeopleSoft student-records stand-in; "show me my class roster" shows a
CSUF-style Class Roster card; every class notice gets its recipients from CHRS; "notify everyone that …" sends to all 25.

**Architecture:** Mirrors Part 15 (HR + PeopleSoft over MCP). Two new processes (`src/chrs-agent.js` :41248,
`src/student-records-mcp.js` :41249). The Hub's signed staff path gains a signed `service` field and a Hub-signed
`roster_lookup`; `hub-lessons` expands `all` from CHRS. The Faculty desk recognizes roster and notify-everyone requests in code.

**Spec:** `docs/superpowers/specs/2026-11-05-chrs-roster-design.md` (binding) and its approved mockup
`docs/superpowers/specs/2026-11-05-chrs-roster-mockup.html`. Read both, and CLAUDE.md Parts 9, 14, 15, 16.

## Global Constraints
- Ports: CHRS 41248, student records 41249; `STUDENT_RECORDS_TOKEN` random per start (start-all), only to `records` and `chrs`, `timingSafeEqual`, never logged.
- Modes read at import: `CHRS_MODE`, `STUDENT_RECORDS_MODE` (mock | live). `maxRetries: 0`, no fallback model, `toLlmError`.
- Fictional data only: IDs `888xxxxxx`, emails `@csu.fullerton.example`; 25 rows exactly as the mockup; studentIds `student-alex`, `student-sam`, else `student-<first>-<last>`.
- Class header values exactly as the spec ("MKTG 351 - 01 (12351) Principles of Marketing (Lecture)", "MoTuWeThFr 10:00AM - 10:50AM", Capacity 35, Enrolled 25…).
- Exact copy: "I couldn't get your class roster just now. Try again in a moment."; "I couldn't get your class list just now, so nothing was sent. Try again in a moment."; "Sent to all 25 students in Marketing 351." (count from the roster); "What should I tell your class?"; "Ask again to see your roster."; footer "Fictional demo records. For your class only — student records are private (FERPA)."; summary "Delivered to N · M not online yet — they'll get it when they are"; "Show all 25 students"; header "25 students · 1 online".
- Nothing the faculty member sees names MCP, tools, Hub, "student agent" or "AI chose". Roster never in telemetry/logs/data files; counts only.
- Privacy guard (Part 14) runs before notify-everyone and on the open-card path.
- Never touch ports 4444, 41241–41249 (owner's live demo) or data/*.json in tests; commit after each task, never push.

## Review Focus
1. CHRS down when a quiz is published → nothing sent, plain sentence, publish retry works (Task 3 test).
2. "notify everyone that I'm sick, no class" → UNSURE, nothing posted (Task 4 test).
3. A tagged single student not on the roster → refused (Task 3 test).
4. Roster data never in `/api/ui/stream` monitor events or Hub telemetry (Task 4 test: search for a roster email/ID).
5. Restart of the Faculty agent → roster card says "Ask again to see your roster." (Task 4 test).

### Task 1: Student-records store, MCP server, planner
Files: create `src/student-records-store.js`, `src/student-records-model.js`, `src/student-records-mcp.js`; harness `startStudentRecords(env)`, `STUDENT_RECORDS_READY = /PeopleSoft student records MCP server \(demo stand-in\) listening on (http:\/\/127\.0\.0\.1:\d+)/`; package.json `records`, `records:live`; timeouts `studentRecordsPlannerMs: 8000`. Mirror `src/peoplesoft-*.js`.
Tool `get_class_roster { courseId, instructorStaffId }` → `{ roster: { class: {...header}, rows: [...25] }, stepCount }` (steps stripped by the client); refusals `not_instructor` (staffId ≠ `staff-dabirian`), `unknown_course` (≠ `mkt-351`). Token required; `/dev/reset`; `STUDENT_RECORDS_TEST_HOOKS`.
Tests `test/student-records-*.test.js`: one tool listed with "Demo stand-in for PeopleSoft student records:" prefix; 25 rows sorted by last name, exact header values, Alex and Sam present with their studentIds; refusals; wrong token 401; token/student data never on stdout.

### Task 2: CHRS agent
Files: create `src/chrs-agent.js`, `src/chrs-model.js` (`CHRS_MOMENT_TOOL = { roster: 'get_class_roster' }`, `chooseRecordsTool`), `src/chrs-records.js` (link shaped like `src/hr-peoplesoft.js`, warm at start, `studentdb_session`); `src/config.js` peer `chrs` + destination `chrs` (`audience: 'staff'`, name 'CHRS'); harness `startStack({ chrs: true })` (starts records + CHRS on pre-picked ports with a random token; default CHRS URL for others = closed port 9); `scripts/start-all.js` (ten processes, token only to records + chrs; start records before chrs) and `scripts/demo/rehearsal-stack.js` (base+8, base+9; forbid 41248/41249); timeouts `chrsToolChoiceMs: 8000`, `chrsRecordsCallMs: 12000` + order test.
CHRS answers two typed data parts on the staff path: a staff request with `service: 'chrs'` and `kind: 'roster'` (verified staff signature) → `{ roster }` or a plain-text failure; a `roster_lookup` signed by the Hub's own key → `{ studentIds, count }` (names not needed by the Hub; the Hub's delivery names come from the roster rows' "First Last"). Refuses everything else ("CHRS serves university staff only.").
Tests: verified staff request → roster; unsigned → refused; records down → the plain sentence; wrong tool pick → plain sentence, no call; roster_lookup with the Hub key → 25 ids; with a staff key → refused.

### Task 3: Hub — service routing and roster-driven deliveries
Files: `src/staff.js` (signed fields gain `service`), `src/hub-agent.js` (route by `service`, default `hr`; `roster_lookup` client with 60 s per-course cache cleared on classroom reset; SAFE_FIELDS `rosterCount`, `service`), `src/hub-lessons.js` (`all` → CHRS roster ids; tagged ids must be on the roster; `roster_unavailable` refusal; delivery names from roster), `src/config.js` (keep `enrolled` = session-allowed students; add `studentNames` for the 25 or take names from the roster).
Tests (on `startStack({ professor: true, chrs: true })`): a post to all → 25 deliveries (Alex delivered, 24 queued); CHRS stopped → `roster_unavailable`, nothing delivered; tagged non-roster id refused; HR staff requests unchanged (all existing hub-staff tests green); classroom reset clears the cache.

### Task 4: Faculty — roster card, notify everyone, delivery summary data
Files: `src/professor-agent.js`, `src/professor-staff.js` (or a new `src/professor-roster.js`): `asksRoster` (code) before the staff desk, after the quiz desk → staff request `service: 'chrs'`; roster kept in memory (`rosterCard` in `/author/state` WITHOUT emails/IDs? — no: the card needs them; serve the full roster only via `GET /author/roster` (Faculty view only, like the quiz draft), state carries `{ rosterId, count, at }`); `notifyEveryone(text)` recognizer + privacy guard + direct post to `all`; reply copy per Global Constraints; outbox keeps outcome text only; Hub proxy line + UI route `GET /api/professor/roster`.
Tests: roster request → card state + exact reply; restart → "Ask again to see your roster."; notify-everyone variants (5) → post to all with the stripped text; "notify everyone that I'm sick, no class" → UNSURE; empty → "What should I tell your class?"; roster emails/IDs absent from the UI stream monitor and Hub telemetry.

### Task 5: Browser — roster card, delivery summary, header
Files: `public/classroom.js` (+ a `public/roster-ui.js` if it keeps classroom.js manageable), `public/quiz-ui.js` (published card summary), `public/styles.css` (`--chrs` tokens light/dark; card CSS from the mockup).
Card exactly the approved screen 1 (header block, counts, "Enrolled Students" grid, scroll inside the card, footer). Delivery summary + fold for > 3 students on every post / quiz / cancellation card. Header "25 students · 1 online". textContent only; card kept in place across redraws (like `hr.li`).
Browser check `scripts/browser-checks/chrs-roster.js` on a mock rehearsal stack: roster card values (25 rows, first "Aguilar,Mariana", Alex and Sam rows, header strings), notify-everyone summary "Delivered to 1 · 24 not online yet…", fold shows 25 rows, quiz published card summary; screenshots compared with the mockup.

### Task 6: Topology
Files: `public/topology.js`, `public/index.html` (viewBox 0 0 1100 1285, aria-label), `public/app.js` (agentColor chrs), `src/topology.js` (labels for source `chrs` MCP events on `chrs-studentdb`, `studentdb_session`, Hub `roster_lookup` hops), `src/ui-server.js` CONFIG_EVENTS, browser checks `peoplesoft.js`/`canvas-quiz.js` geometry updates.
Positions exactly as the spec. Tests in `test/topology-chrs.test.js`; screenshot compared with mockup screen 4.

### Task 7: Docs and demos
CLAUDE.md Part 17 notes (+ "ten processes"), README, `Steps/17-chrs-roster.md` + index (owner's prompts verbatim, enhancements, avoid list), Exercise sync, `scripts/demo/walkthrough/scene-17.js` + `npm run demo:build`, progression entry. `npm test` green.
