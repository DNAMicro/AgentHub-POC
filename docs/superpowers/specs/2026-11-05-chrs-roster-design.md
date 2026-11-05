# CHRS — class roster and roster-driven notices — design (Part 17)

Date: 2026-11-05 · Branch: HRAgent · Status: approved by the owner (mockup approved 2026-11-04 23:3x: "approved build it")

Approved mockup: `docs/superpowers/specs/2026-11-05-chrs-roster-mockup.html` (companion screen `chrs-v5.html`;
links `public/styles.css`, open through a local web server from the repo root).

## Intent (owner's words)

"Add another agent called CHRS with a peoplesoft database similar to the one in HR. The purpose of this agent is to
service student information. The scenario is that a Faculty will ask show me my class roster and then it should output
(simulated) of 25 people with the following fields “Last Name, First Name, Student Level, Major” … Also we have student
notification on several scenarios such as quiz or time off and for the system to know which people to send it to it
needs to query the CHRS to get the roster to send the message to." Later: the roster is **look only**; the agent is
called **CHRS** on screen; make the roster look like the CSUF Faculty Center Class Roster
(https://csuf-erp.screenstepslive.com/m/70024/l/754400-accessing-your-class-roster); "there should be an option for the
faculty to say notify everyone of …. and it should then be sent to all of them".

## Goals

1. **"show me my class roster"** in the Faculty view → one look-only card laid out like the CSUF Faculty Center
   *Class Roster*: header (term, class, meeting row, instructor), Enrollment Status / Capacity / Enrolled, then the
   **Enrolled Students** grid: #, ID, Name ("Last,First"), Email, Pronouns, Units, Program and Plan, Academic Level.
   25 fictional students; Alex Student and Sam Student are two of them.
2. **Every class notice gets its recipients from CHRS** (quiz notices, class cancellations, posts to the whole class,
   "notify everyone"). The fixed `enrolled: ['student-alex','student-sam']` list stops deciding who gets a notice.
3. **"notify everyone that / of / about …"** (and "notify all (my) students …", "let the class know …", "tell everyone …")
   sends the words after the opening, as his message, to all 25 at once — no preview.
4. **Topology** (approved screen 4): CHRS is a fifth staff-only agent (indigo) with its own model box and its own
   PeopleSoft tile "Student records" under the model; dash-dot MCP line; agents stay 255 apart; the picture grows taller.
5. Everything the faculty member sees reads like a normal employee experience (owner's rule, 2026-11-04): no MCP,
   tool, Hub, "student agent" or "AI chose" talk in what he sees.

## Anti-goals

- A real student, real CWID or real email. Every record is fictional: IDs `888xxxxxx`, emails `@csu.fullerton.example`.
- The roster reaching a student, the Hub telemetry (counts only), logs, or `data/*.json`.
- Actions on the roster (Notify checkboxes, Select All, Photo, Printer Friendly) — look only.
- A private staff word (illness, leave, relative) going to the class through "notify everyone" — the Part 14 privacy
  rule applies: first person + leave/illness words → the existing "HR, the class, or both?" question.
- A notice silently sent to a stale list when CHRS can't answer: nothing is sent and he is told plainly.

## How it works (decided — my calls marked ★)

### Processes ★
Two new processes, mirroring HR + PeopleSoft (Part 15):
- `src/chrs-agent.js` — **CHRS**, A2A agent, `127.0.0.1:41248`, staff only (`audience: 'staff'`, never on the
  student card or router). `CHRS_MODE` mock | live (its AI picks the student-records tool, like HR's `chooseTool`;
  code checks the pick with `MOMENT_TOOL`).
- `src/student-records-mcp.js` — **PeopleSoft student records** demo stand-in, MCP Streamable HTTP, `127.0.0.1:41249`,
  per-start random `STUDENT_RECORDS_TOKEN` given only to `chrs` (and the test harness). Memory only, seeded on start.
  Tools: `get_class_roster { courseId, instructorStaffId }` → the header + 25 rows; refuses `not_instructor`
  (only the course's own instructor), `unknown_course`. A small wrapper planner (`STUDENT_RECORDS_MODE`, fixed menu
  `check_instructor`, `check_term`, `read_enrollment`, `mask_private_fields`; code adds the required ones) keeps the
  Topology sparkle honest. Ten processes in `npm run demo`.

### The data ★ (`src/student-records-store.js`, dependency-free, fictional)
- Class: Fall 2026 · Regular Academic Session · California State University, Fullerton · Undergraduate;
  **MKTG 351 - 01 (12351) Principles of Marketing (Lecture)**; Days and Times **MoTuWeThFr 10:00AM - 10:50AM** (every
  weekday — matches the Part 14 class-day rule used by cancellation offers); Room Mihaylo Hall 1xxx; Instructor
  Dr. Dabirian; Dates 08/24/2026 - 12/18/2026. Enrollment Status Enrolled · Capacity 35 · Enrolled 25.
- 25 rows as in the mockup (Aguilar,Mariana … Yamamoto,Hana; Student,Alex; Student,Sam), sorted by last name;
  Units 3.00; Program and Plan "Undergraduate Program - <plan> <degree>"; Academic Level Sophomore/Junior/Senior.
  Each row has a `studentId`: `student-alex`, `student-sam`, others `student-<first>-<last>` (lowercase).
  Student names keep they/them in every sentence about a student.

### Roster request (faculty → CHRS)
- The Faculty desk recognizes a roster request in **code** (`asksRoster`: roster / class list / who is in / enrolled
  students / my students list; no student tag), before the staff desk and after the quiz desk — no model call.
- The Hub's signed staff path gains a **service** field (`'hr' | 'chrs'`), signed; the Hub routes to that staff
  destination (today it takes the first ready staff destination). Requests without `service` stay HR (back-compatible).
- CHRS verifies the Hub's staff signature (as HR does), its AI picks `get_class_roster` (code checks), calls the
  student-records server, and answers one typed data part `{ roster }`. Outcomes as Part 15: unavailable / uncertain /
  wrong tool / tool choice failed → plain text: "I couldn't get your class roster just now. Try again in a moment."
- **Faculty view card** "CHRS · Class roster": exactly the approved screen 1. The roster lives in the Faculty agent's
  memory (like the quiz draft); the outbox chat keeps only "Class roster · 25 students". After a restart the card says
  "Ask again to see your roster." Footer: "Fictional demo records. For your class only — student records are private (FERPA)."

### Roster-driven notices
- The Hub expands `audience: 'all'` by asking CHRS for the course roster (`roster_lookup` on the staff path, signed by
  the Hub itself; CHRS checks the Hub's own key), then creates one delivery per roster student. A tagged single
  student must be on the roster. The Hub caches the roster for the course in memory for 60 s ★ and refreshes it on
  classroom reset.
- CHRS unavailable → the post is refused with code `roster_unavailable`; the faculty member sees "I couldn't get your
  class list just now, so nothing was sent. Try again in a moment." Never a fallback list.
- Students without a registered student agent are **queued** exactly as Sam is today; the Student registration rule
  (`no_student_endpoint`) is unchanged — the 23 never connect in this demo, honestly "not online yet".
- `cfg.courses[...].enrolled` remains only as the list of students allowed a Student-agent **session** (Alex, Sam).
- Delivery display (all posts, quiz notices, cancellations): when more than 3 students, the card leads with a summary
  "Delivered to N · M not online yet — they'll get it when they are" (counts from the deliveries; "Opened" counts as
  delivered) and folds the rows under "Show all 25 students". ≤3 students: rows as today.
- The Faculty view header's roster pills become "25 students · 1 online" ★.

### "Notify everyone"
- Code recognizes the opening (`notify|tell|let … know|inform` + `everyone|everybody|all (my )?students|the (whole )?class`
  + optional `that|of|about|:`); the rest (capitalized, trailing period added) is sent to `all` as his message
  (`verbatim: true`, author professor; title from the existing `classifyPost`). Reply: "Sent to all 25 students in
  Marketing 351." (count from the roster). Empty rest → "What should I tell your class?". Privacy guard first.
- With an HR card open it follows the open-card rule (a class announcement posts; first person + leave words → ask).

### Topology (approved screen 4)
Nodes: `chrs` (710, 1115, indigo `--chrs` #4338ca / dark #a5b4fc, "CHRS" / "Staff only"), `llm-chrs` (985, 1060),
`studentdb` system tile (985, 1190, PeopleSoft colours `--ps`, db icon, "PeopleSoft" / "STUDENT RECORDS");
Student/Hub y 605, their models y 355; viewBox `0 0 1100 1285`. Edges `hub-chrs` (A2A), `chrs-model`, `chrs-studentdb`
(MCP). Events `mcp_call_*` from source `chrs` label on `chrs-studentdb`; `studentdb_session` like `peoplesoft_session`
(warmed at start). Hub `roster_lookup` hops show Hub → CHRS. Labels name counts only ("Roster: 25 students").

### Telemetry and privacy
Run events carry ids, counts (`rosterCount`), outcome and codes only; never names, IDs or emails. Hub SAFE_FIELDS gains
`rosterCount`, `service`. CHRS and the records server never log student data.

### Timeouts
Records planner 8 s → CHRS tool choice 8 s → CHRS MCP call 12 s → Hub staff dispatch (existing) ; Hub roster lookup
for a post 15 s (inside the Professor's publish wait). Added to `src/timeouts.js` and its order test.

## Left to the builder
File layout beyond the names above; how much of `hr-peoplesoft.js` to share; tests (`startStack({ chrs: true })`);
rehearsal stack ports base+8/base+9; browser check `scripts/browser-checks/chrs-roster.js`; Steps/17, README, CLAUDE.md
Part 17 notes; demo scenes.
