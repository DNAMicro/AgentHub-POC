# Step 17 — CHRS: a class roster, and notices that go to the real class list

> Final state: see `Steps/README.md`. This is your Part 17 request, in your wording, with every decision and fix made while building it merged into the instructions. Running it after Steps 1–11 and 14–16 rebuilds the current app. **Concrete specification** blocks give the exact names, values and rules the current app uses. The closing sections list the problems to avoid and each change with why it was made.

## Your original request

> Add another agent called CHRS with a peoplesoft database similar to the one in HR. The purpose of this agent is to service student infromation. The scenario is that a Faculty will ask show me my class roster and then it should output (simulated) of 25 people with the following fields “Last Name, First Name, Student Level, Major” you can fill the the data with ficticous ifnromation. Also we have student notification on several scenarios such as quiz or time off and for the system to know which people to send it to it needs to query the CHRS to ge tthe roster to send the message to. design and show me the design for approval

## Your decisions while designing and building it (merged into the instructions below)

- The roster is look-only: *“just look at it”* — no Notify checkboxes, Select All, Photo or Printer Friendly.
- The name on screen is **“CHRS”**.
- Make the roster look real: *“https://csuf-erp.screenstepslive.com/m/70024/l/754400-accessing-your-class-roster here is the instructions on how roster looks like and instructions for it lets make it a bit more realistic like this”* — so the card follows the CSUF Faculty Center Class Roster (header, enrollment status, grid with ID, Name, Email, Pronouns, Units, Program and Plan, Academic Level).
- Notify: *“there should be an option for the faculty to say notify everyone of …. and it should then be sent to all of them”*.
- Design approval and build: *“approved build it and once built do a full test look at it from the view point of the faculty make sure the copy makes sense. At least run through 50 various scenarios and fix any issues dont stop until its fully done and fixed”*.
- Builder's own calls (you approved the design): the number is 17; CHRS is a fifth staff-only agent on port 41248 and the student records are a tenth process on 41249; every student has a fictional `888xxxxxx` ID; the 25 students keep they/them in every sentence; Alex Student and Sam Student are two of them; Days and Times are every weekday so Step 14's class-day rule stays true; the Hub keeps the roster for 60 seconds.

## What you get

- In the **Faculty view** type `show me my class roster`. One card, “CHRS · Class roster”, laid out like the CSUF Faculty Center roster: term, class (MKTG 351 - 01, Principles of Marketing), meeting row, instructor (Dr. Dabirian), Enrollment Status / Capacity 35 / Enrolled 25, then 25 fictional students sorted by last name. Look only.
- Type `notify everyone that the midterm review session moves to Thursday`. It is sent, as his own words and with no preview, to all 25: “Sent to all 25 students in Marketing 351.” Alex sees it in the Conversation; 24 are “not online yet” and get it when they are. The delivery card reads “Delivered to 1 · 24 not online yet — they'll get it when they are” with the rows folded under “Show all 25 students”.
- Quiz notices (Step 16), class cancellations (Step 14) and every post to the whole class now take their recipients from CHRS. If CHRS can't answer, nothing is sent and he is told plainly.
- The Faculty view header says “25 students · 1 online” once the real count is known.
- **Topology** has a fifth staff agent, **CHRS** (indigo, “Staff only”), with its own model box and its own **Student records** tile (database icon, “PeopleSoft”) under the model, joined by a dash-dot MCP line. Hub → CHRS lookups light up the Hub–CHRS edge.

## Starting point

Steps 1–11 and 14–16 are done and `npm test` passes. `npm run demo` starts eight processes; after this step it starts ten. No new package.

## 1. The student records stand-in (`src/student-records-mcp.js`, `src/student-records-store.js`, `src/student-records-model.js`)

**Concrete specification**
- A new process on `127.0.0.1:41249` (`PORT` overrides). `npm run records` (mock) and `npm run records:live` (Haiku planner, paid, `STUDENT_RECORDS_MODE`, read at import). It says it is a fictional demo stand-in in its startup line and tool description. Built exactly like PeopleSoft (Step 15): MCP SDK 1.32.1 over Streamable HTTP, bearer `STUDENT_RECORDS_TOKEN` required (exits without it, never printed), `timingSafeEqual`, host guard, SIGTERM closes every session. `POST /dev/reset`. `STUDENT_RECORDS_TEST_HOOKS=1` enables `GET /test/state`.
- One tool: `get_class_roster { courseId, instructorStaffId }` → `{ roster: { class, rows }, stepCount }`. Refusals checked before the planner: `unknown_course`, `not_instructor` (only the course's own instructor).
- The wrapper planner picks from the fixed menu `check_instructor`, `check_term`, `read_enrollment`, `mask_private_fields`; code adds the required ones and runs each. Steps never leave this process (only `stepCount`).
- The data (dependency-free, fictional): Fall 2026, Regular Academic Session, California State University, Fullerton, Undergraduate; MKTG 351 - 01 (12351) Principles of Marketing (Lecture); Days and Times `MoTuWeThFr 10:00AM - 10:50AM`; Instructor Dr. Dabirian; Dates 08/24/2026 - 12/18/2026; Enrollment Status Enrolled, Capacity 35, Enrolled 25. 25 rows sorted by last name (Aguilar,Mariana … Yamamoto,Hana, with Student,Alex and Student,Sam), each with `studentId` (`student-alex`, `student-sam`, others `student-<first>-<last>`), 9-digit ID `888xxxxxx`, name `Last,First`, email `@csu.fullerton.example`, pronouns, units 3.00, program, plan, degree, academic level (Sophomore, Junior or Senior). Memory only; nothing under `data/`.

## 2. CHRS (`src/chrs-agent.js`, `src/chrs-model.js`, `src/chrs-records.js`)

**Concrete specification**
- An A2A agent on `127.0.0.1:41248` (`npm run chrs`, `chrs:live`, `CHRS_MODE` mock | live read at import; `CHRS_MODEL`, `CHRS_URL`). Registers with the Hub as a **staff-only** destination (`audience: 'staff'`): not on the public card, not in the student router, a `requestedCapability` naming it is rejected. One `answer` skill, `class-roster` (the Hub marks a card with no skills `disabled`).
- It verifies the Hub's staff signature itself (as HR does) and answers “CHRS serves university staff only.” otherwise. Its AI picks the tool (`chooseRecordsTool`, `CHRS_MOMENT_TOOL`; live: one structured call, 8 s; mock: labelled); code checks the pick, builds the arguments (instructor id from the signature, never words or model) and calls the records server (`src/chrs-records.js`: lazy connect, warm at start, `studentdb_session` only on a change, reconnect once only when the session is unknown, never retry after a timeout; unavailable / uncertain / refused by structure, as in Steps 15 and 16). `STUDENT_RECORDS_URL` defaults to `http://127.0.0.1:41249` in the CHRS process (`npm run demo` relies on it); the test harness's `startChrs` passes the closed port 9.
- Two typed A2A data parts from the Hub: `roster_request` (signed with the Hub's staff signature; reply `{ roster }` or `{ text }`) and `roster_lookup` (signed by the Hub's own key, below; reply `{ studentIds, names, count }` or `{ error, text }`). Failure text for a roster request: “I couldn't get your class roster just now. Try again in a moment.”

## 3. The Hub: signed `service` and roster-driven deliveries (`src/staff.js`, `src/hub-agent.js`, `src/hub-roster.js`, `src/hub-lessons.js`, `src/hub-link.js`, `src/hub-registry.js`, `src/config.js`)

**Concrete specification**
- The staff request gains `service` (`'hr' | 'chrs'`), a **signed field** added only when present (old HR signatures stay valid); part of the dedupe hash. The Hub validates it against its configured staff destinations (`unknown_service`; missing means HR). The roster request takes its course from the sender's configuration, never from the request.
- `roster_lookup` is signed by the Hub's own key (HMAC with CHRS's `callKey`, prefix `roster-lookup|`, covering course, instructor and operation id; each must match `/^[\w-]{1,64}$/`). CHRS refuses unsigned or student-signed lookups.
- `src/hub-roster.js`: one lookup per course, shared in-flight, **60 s memory cache** (`HUB_ROSTER_TTL_MS`), cleared by classroom reset. **`status()` reads the cache only** (the Faculty view polls every 3 s and a poll must never cause a paid lookup): `rosterCount` and `onlineCount` are null until a post or roster request fetched it, and null when unavailable.
- Posts: `audience: 'all'` expands to one delivery per roster student; a tagged student must be on the roster (one fresh lookup before refusing with `recipient_not_enrolled`, re-fetching only when the first roster came from the cache). CHRS unavailable → the post is refused with `roster_unavailable` — **no fallback list**, nothing stored. `cfg.courses[...].enrolled` is now only the list of students allowed a Student session (Alex, Sam). Students without a Student agent are queued exactly as Sam is (`no_student_endpoint` unchanged). The Hub's delivery views for the Faculty agent carry the roster `name`; the Hub remembers the name of every student it addressed a post to (`deliveredNames`, memory only, cleared by the classroom reset), so a name never turns into a raw id after the 60 s cache expires.
- Hub `SAFE_FIELDS` gained `rosterCount`, `service`. The Hub's roster request carries a `runId` so CHRS's own events reach the Topology.

## 4. The Faculty desk (`src/professor-roster.js`, `src/professor-agent.js`, `src/professor-staff.js`, `src/professor-quiz.js`)

**Concrete specification**
- `asksRoster` recognises a roster request in code (roster, class list, who is in, enrolled students; no student tag), after the quiz desk and before the staff desk. No model call. The rows live only in the desk (`card`); the chat keeps “Class roster · 25 students”; `/author/state` carries `{ rosterId, count, at }`; `GET /author/roster` serves the rows (UI: `GET /api/professor/roster`). After a restart, or a reset in flight, the card says “Ask again to see your roster.”
- **Notify everyone** (`notifyEveryone`): notify / tell / inform / let … know + everyone / everybody / all (my) students / the (whole) class, optionally followed by `that`, `of`, `about` or `:`. “that …” and “: …” send the rest (capitalized, full stop added) to `all` as his own words (`verbatim`, author professor, no preview): “Sent to all 25 students in Marketing 351.” An empty rest asks “What should I tell your class?”. **“about X” / “of X” never post a fragment**: the assistant asks “What should I tell your class about X?” and his next plain reply goes to all 25 (15-minute wait; “never mind” or “cancel” drops it; first person plus leave words asks the Step 14 “HR, the class, or both?” question; re-armed if the post fails).
- “Tell everyone to read chapter 5 before Thursday” sends “Please read chapter 5 before Thursday.” (`to <verb>` right after the opening → `Please <verb>`).
- **What would go to the class gets the same check as a plain class message** (`checkClassPost`): the rest of a notify sentence and the reply to “What should I tell your class about X?”. An illness, leave or relative word, with or without I/my (“Dr. Dabirian is sick today, no class”, “because of a family emergency”, “the funeral is Friday”) → the Step 14 “Should I file this as time off with HR, tell the class, or both?” question, the whole message held (“class” then posts the stripped text). With an HR card open, first person or a card-edit word is asked about. Otherwise the staff classifier (mock heuristic, live model) must say `class_message`; anything else is asked. While “tell your class about X” waits and an HR card is open, a card edit (“make it Dec 7 instead”, `openCardTakes`) goes to HR and the question keeps waiting.
- **A waiting cancellation offer** blocks neither a roster request nor a notify with something to say: “Notify everyone that the review session is in room 204” posts “The review session is in room 204.” and the offer stays open for its yes or no. A bare “notify everyone” or “yes” still answers the offer. A class post held for the HR / class / both question after the offer is answered first. A staff answer such as “tell the class” is never read as a new roster or notify request (`staffHolding()`).
- **CHRS can't answer:** “I couldn't get your class list just now, so nothing was sent. Try again in a moment.” A quiz publish says “Published in Canvas, but I couldn't get your class list, so students weren't told yet. Press Publish again in a moment — they're notified only once.” (never drop “published”). A yes to a cancellation offer, a post offer or a held “class” answer that fails this way is put back so a second yes works once CHRS is back.
- No model call for a roster request or a notify opening; roster replies with rows are `retryable` and never cached at any layer (Step 15 rule).

## 5. The browser (`public/roster-ui.js`, `public/classroom.js`, `public/quiz-ui.js`, `public/styles.css`, `public/app.js`)

**Concrete specification**
- `roster-ui.js`: the “CHRS · Class roster” card, native (not A2UI), `textContent` only, drawn from the chat entry. Rows are fetched only while the Faculty view is shown and dropped when another tab shows (the student page never fetches or holds them); a 404 shows “Ask again to see your roster.”; a failed load retries on the next render. The element is kept across redraws. Footer: “Fictional demo records. For your class only — student records are private (FERPA).” Look only. Styles use new `--chrs` tokens (indigo `#4338ca`, dark `#a5b4fc`).
- **Names only in the Faculty view.** `/author/state` (pushed to every page's stream) carries student ids, never classmates' names. The Faculty view fetches `GET /api/professor/roster/names` (Faculty → Hub proxy `/dev/agents/:id/author/roster/names` → `/author/roster/names`; `GET /author/roster` also returns `names`) only while its tab shows, maps `studentId → "First Last"` in the browser, and clears the names when the tab hides (like the quiz key). Unknown → “A student”, and the waiting text “Not delivered yet — this student isn't online. It will arrive when they are.”; known → “Not delivered yet — Mariana isn't online. It will arrive when they are.”
- Delivery list (`deliveryList`, used by posts, cancellations and the quiz card): more than 3 students → “Delivered to N” + “M not online yet — they'll get it when they are” (+ “N could not be delivered” when some failed) and the rows under a `<details>` “Show all N students” that stays open across redraws; 3 or fewer → rows. “Opened” counts as delivered.
- **The header count waits for the real count.** “25 students · 1 online” appears only once the roster count is known (the last known count is kept after the cache expires; before any fetch the header shows only “Marketing 351”; never the 2-person session list). The quiz publish prompt says “your students” until the count is known, then the number.

## 6. Topology (`public/topology.js`, `public/index.html`, `src/topology.js`, `src/ui-server.js`, `public/app.js`)

**Concrete specification** (approved mockup `docs/superpowers/specs/2026-11-05-chrs-roster-mockup.html`, screen 4; viewBox `0 0 1100 1285`)
- Nodes: `chrs` (710, 1115; indigo `--chrs`, “CHRS” / “Staff only”), `llm-chrs` (985, 1060), system tile `studentdb` (985, 1190; PeopleSoft colours, database icon, “PeopleSoft” / “STUDENT RECORDS”; no “Saved” flash). Student and Hub move to y 605 and their models to y 355; the agents stay 255 apart; the picture grows taller. Edges `hub-chrs` (A2A), `chrs-model`, `chrs-studentdb` (MCP).
- Labels (`src/topology.js`, counts only): “Hub asked CHRS for the class roster”, “Roster: 25 students” (Hub and CHRS legs), “tools/call get_class_roster”, “MCP session open”; `studentdb_session` is run-less, in `CONFIG_EVENTS` and the on-change filter. **Anti-goals:** no `llm-studentdb`, no circle or orbit on the tile, no step names. A label for a node the page doesn't draw is ignored (warn once), never thrown.

## 7. Ten processes (`scripts/start-all.js`, `package.json`, `scripts/demo/rehearsal-stack.js`, `src/timeouts.js`, `test/support/harness.js`)

**Concrete specification**
- `scripts/start-all.js` starts the Hub, Tutor, Library, Professor, HR, PeopleSoft, Canvas, student records, CHRS and UI. `STUDENT_RECORDS_TOKEN` is made with `randomBytes(24)` on every start and given to `records` and `chrs` only (records first). The rehearsal stack puts records at base+8 and CHRS at base+9 and forbids 41241–41249.
- **Nested timeouts:** records planner 8 s → CHRS tool choice 8 s → CHRS MCP call 12 s → Hub roster lookup 22 s → Professor publish 40 s (was 15 s) → Hub author proxy 100 s → UI 105 s (were 80 / 85 s). Add `professorModelMs: 45000` (`PROFESSOR_MODEL_TIMEOUT_MS`, the Faculty model naming a post or reading an @assistant message) and assert proxy > staff classifier + model + publish (10 + 45 + 40 = 95 s) and UI > proxy in `test/timeouts.test.js`.
- `/author/state` re-publishes posts whose outcome is unknown **in the background**, one at a time per post; the 3-second poll never waits on a publish.
- Harness: `startStack({ chrs: true })` starts the records server and CHRS on pre-picked ports with a random token and gives the Hub `CHRS_URL`; `professor: true` starts CHRS by default (`chrs: false` opts out); a stand-alone CHRS defaults to the closed port 9.

## 8. Tests and checks

- Unit and process tests: `test/student-records-store.test.js`, `student-records-model.test.js`, `student-records-mcp.test.js`, `chrs.test.js`, `hub-roster.test.js`, `professor-roster.test.js`, `topology-chrs.test.js`, `timeouts.test.js`. Existing tests change because the roster is now the authority: a post to `all` has 25 deliveries (Alex delivered, 24 queued; `lesson_queued` once per waiting student).
- Privacy tests: no roster email, 888 ID or name in the monitor stream, Hub telemetry, state or any process log.
- Browser check `scripts/browser-checks/chrs-roster.js` (34 checks) on a **separate** rehearsal stack: `node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock --now 2026-11-04T20:00:00Z`, never on the running demo. Look at every screenshot against the mockup.
- Demos: `scripts/demo/walkthrough/scene-17.js` (v2, then `npm run demo:build`) and the Part 17 entry in `scripts/demo/progression.js` (v1). Each checks what really happened and ends honestly.
- The faculty-viewpoint run: at least 50 varied scenarios (roster asks, every notify opening, privacy cases, CHRS down, open HR card, retry), reading the copy as Dr. Dabirian would.

## Avoid these known problems

1. **The 3-second status poll must never trigger a CHRS lookup.** The Faculty view polls the Hub; `status()` once fetched the roster, so every poll was a paid call. Read the cache only; counts are null until a post or roster request fetched it.
2. **A cancellation offer must survive `roster_unavailable`.** The offer was cleared as soon as the answer was read, so after “Try again in a moment” a second “yes” had nothing to answer. Re-arm the offer, the post offer and a held “class” answer when the post fails for lack of a list, and test a second yes once CHRS is back.
3. **The quiz-publish text must still say “published”.** The generic “nothing was sent” made it sound as if Canvas did nothing, so he might publish twice. Use the quiz-specific sentence in section 4.
4. **Never post a fragment for “about X”.** “Inform the whole class about the midterm review” sent “The midterm review.” to 25 students. Ask “What should I tell your class about …?” and send his next reply.
5. **No stale “2 students”.** The publish prompt and the header used the two-person session list. Say “your students” and show no count until the roster count is known; keep the last known count after the 60 s cache expires.
6. **No header chips before the count.** Show only “Marketing 351” until the real count arrives.
7. **The Hub's roster request needs a `runId`.** Without it CHRS's own events (received, MCP call, reply) never reached the Topology.
8. **Identical event rows.** Two PeopleSoft tiles produced rows that both read “→ PeopleSoft”. The student records rows say “Student records”.
9. **No raw id in a route label.** Show the public name (“CHRS”), never the agent id.
10. **A node the page doesn't draw must not crash the stream.** An event for `chrs` before the node existed threw and put the live stream in a reconnect loop, which blocked the Faculty view. Ignore it and warn once per id.
11. **Roster IDs in the Hub are names and ids only.** Never emails or 888 IDs in the Hub, its telemetry or logs; the rows reach only the Faculty view, only while it is shown.
12. **A poll must not carry old rows.** Drop the roster rows from the page when another tab shows; a failed load retries on the next render.
13. **A reset in flight leaves no roster card.** Use a generation guard; the card says “Ask again to see your roster.”
14. **Keep the online count when the Hub's view is missing.** Don't overwrite a known online count with 0.
15. **The timeout budget must nest.** The spec's 15 s lookup could not sit inside CHRS's own 20 s; use 22 s for the lookup and 40 s for the Professor's publish, and test the order.
16. **A tagged single student also needs CHRS.** A tagged student must be on the roster; CHRS down refuses the post. Don't add a fallback list.
17. **Sign the `service` field only when present** so old three-field HR signatures stay valid, and include it in the dedupe hash.
18. **Don't let a staff answer start a new request.** “Tell the class” after the held-message question must not be read as a notify opening (`staffHolding()`).
19. **Full `npm test` under load can fail `hr-peoplesoft` “M3 session status” or “forged publishes”.** Re-run the file alone before blaming the change.
20. **Check by eye.** Open every screenshot against the mockup; a passing check is not a substitute.
21. **“Notify everyone” must not skip the privacy check.** “Notify everyone that Dr. Dabirian is sick today, no class” went to 25 students while the same words without the opening were asked about. Run the plain path's check (illness/leave/relative words, the open-card rule, the staff classifier) on the rest of the sentence and on the reply to “What should I tell your class about X?”.
22. **A waiting cancellation offer must not turn “notify everyone that …” into a raw post.** It sent “Notify everyone that the review session is in room 204” verbatim with no “Sent to all 25 …”. Handle notify with content under a cancellation offer and keep the offer open.
23. **Delivery names must never become raw ids.** After the Hub's 60 s cache expired rows read “student-mariana-aguilar isn't online”. Keep a memory-only id → name map in the Hub for students it delivered to; fall back to “A student” / “this student”, never the id.
24. **The timeout chain must include the Faculty model.** Model 45 s + publish 40 s exceeded the 80 s proxy. Add `professorModelMs`, test the sum, raise proxy/UI to 100/105 s.
25. **“Tell everyone to read chapter 5” sent “To read chapter 5 before Thursday.”** Turn `to <verb>` into “Please <verb> …”.
26. **Classmates' names must not ride the shared state.** Delivery names were in `/author/state`, which reaches the student's page too. Serve names only through the Faculty view's roster fetch and drop them when the tab hides. Fictional ids (`student-<first>-<last>`) do appear in `data/` files and recipients (owner ruling); names, emails and 888 IDs do not.
27. **Docs: `STUDENT_RECORDS_URL` defaults to 41249** in the CHRS process (only the harness uses port 9); a rebuild that followed “port 9” broke `npm run demo`. And the README's “not built” list must not claim whole-class notices are missing.
28. **An HR card edit during “what should I tell your class about …?”** (“make it Dec 7 instead”) was posted to 25 students. Check the open card first (`openCardTakes`).
29. **The status poll must not wait on re-publishing.** It re-sent every uncertain post in sequence, each up to 40 s; polls every 3 s stacked. Re-publish in the background with an in-flight guard.
30. **Remove dead wiring.** The quiz desk's unused `roster` parameter (and the Faculty agent's `lastRoster`) were removed.

## Enhancements merged into this step

- **Design (2026-11-04/05):** the owner asked to see a design first, then approved the mockup (“approved build it”). The look follows the CSUF Faculty Center Class Roster page he linked; the roster is look-only; the name on screen is CHRS. Merged as sections 1, 2 and 5.
- **“Notify everyone”:** the owner's request for an option to notify all of them; merged as section 4 (with the privacy guard and the about/of rule added after review).
- **Roster-driven notices:** every class notice takes its recipients from CHRS (sections 3 and 4); the fixed two-student list only decides who can have a Student session.
- **Task 3 review:** the status poll reads the cache only; budgets added to the central order test; the stranger-tag lookup count; coded lookup failures.
- **Task 4 review:** the offer is re-armed on `roster_unavailable`; the quiz text keeps “published”; “about/of” asks instead of posting a fragment; reset guard; `classSafe` flag rename.
- **Task 5 review:** no stale “2 students”; no header before the count; failed-delivery pill; roster load retry; Topology warns once.
- **Task 6:** layout from screen 4; the Hub's roster request gained a `runId`; distinct “Student records” event rows; public route label.
- **Faculty-viewpoint run (≥ 50 scenarios):** run after the build to read the copy as Dr. Dabirian would; its fixes are merged into the sections above.
- **Final whole-branch review (2026-11-05):** notify-everyone gets the plain path's privacy check; notify works under a cancellation offer; delivery names survive the Hub cache and leave the shared state (owner Ruling 5: names only through the Faculty view's roster fetch); the timeout chain includes the Faculty model (proxy 100 s, UI 105 s); “tell everyone to …” becomes “Please …”; an HR edit during the tell-question goes to HR; background re-publish; docs corrected (records URL default, “not built” list). Merged into sections 2–5 and 7 and problems 21–30.
