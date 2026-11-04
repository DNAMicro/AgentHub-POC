# Canvas quiz over MCP — design (Part 16)

Date: 2026-11-04 · Branch: HRAgent · Status: draft for the owner's approval

Approved mockup (screens 1–6, approved 2026-11-04: “they are good”; Topology: “Looks good”):
`docs/superpowers/specs/2026-11-04-canvas-quiz-mockup.html` (a copy of the companion screen
`quiz-canvas-v9.html`; it links `public/styles.css`, so open it through a local web server from the repo root).

## Intent and why

At CSUF, quizzes live in **Canvas**, the learning management system (LMS). The demo should show the faculty
member's agent reaching Canvas over **MCP** (Model Context Protocol), the same way HR reaches PeopleSoft
(Part 15): Dr. Dabirian asks the course assistant for a quiz, the AI drafts it, he changes what he wants, and
only after he approves does it go to Canvas. Then the assistant asks whether to publish it, and the students
get a notification.

The owner's words: the faculty member's agent connects “via MCP to Canvas LMS similar to HR → PeopleSoft”;
if no topic is given the assistant lists “the topics that were covered in class”; the model drafts the quiz;
after approval it goes to Canvas (“Canvas is a simulation and Topology should show the call”); the faculty
member gets a confirmation and is asked about sending it to students “however its usually done”. Later:
“no action is needed to be taken a notification is just enough” (student side) and “Dr. Dabirian may make
changes to the quiz questions add/remove/edit”.

## Goals

1. **Topic first.** A quiz request without a topic gets the list of topics taught so far, grouped by exam unit
   (screen 1). The list comes from the course schedule in code, never from the AI.
2. **The AI drafts, he decides.** Faculty's model drafts original multiple-choice questions from that topic's
   course notes. On one card he can edit any question (text, four answers, which one is correct), remove it
   (with Undo), add a blank one, or ask the AI for one more (screen 2). Nothing reaches Canvas before Approve.
3. **Two MCP moments**, like Part 15: **Approve** creates the quiz in Canvas, saved *unpublished* (screen 3);
   **Publish** makes it visible (screen 4). Faculty's AI picks the Canvas tool at each moment; code checks the
   pick and builds the arguments.
4. **Canvas's wrapper has its own AI**, like PeopleSoft's: it plans the steps from a fixed menu; code adds the
   required ones and runs every step.
5. **Students are notified, nothing more.** After Publish, each enrolled student gets a notice through the Hub
   (the Part 9 post path) with honest per-student states. The notice has no button and no reply (screen 5).
6. **Topology shows the call** (screen 6): Canvas LMS is a system tile under Faculty's model, design F like
   PeopleSoft, with its own colour and icon.

## Anti-goals (a failure even if it works)

- Canvas looks like an agent (circle, orbit ring) or has a model box (`llm-canvas` must not exist), or the UI
  shows the wrapper's step names anywhere.
- Anything suggests this is Instructure's real Canvas: it is a fictional **demo stand-in** (startup line, tool
  descriptions, Topology details, card labels).
- A quiz question copied from Course Hero, Quizlet, Studocu or a test bank. Every question is drafted fresh
  from our own original notes.
- The answer key reaches a student, the Hub telemetry or a log.
- Something goes to Canvas, or a student is notified, without his explicit click (Approve, then Publish).
- A model decides a fact: topics taught, dates, points, counts and pass/fail of a check are code
  (project rule “model proposes, code decides”).
- Canned “thinking”: every animation comes from a real event.

## Course facts the design copies (from the owner's sources, read 2026-11-04)

- **Studocu**, Spring 2024 CSUF MKT 351 syllabus: textbook MKTG14 (Lamb, Hair & McDaniel); the schedule is
  **Topics 1–20 in MKTG14 chapter order**; three **Canvas exams**, 60 minutes, not cumulative —
  Exam 1 = Topics 1–7, Exam 2 = 8–14, Exam 3 = 15–20. (Weeks 1–3 were not public; Topics 1–3 follow the book.)
- **Course Hero** previews: a Canvas exam header “Points 150 · Questions 50 · Time Limit 60 Minutes” — **3 points
  per question**; chapter quizzes are **multiple choice** with 4–5 options.
- **Quizlet** (Fall 2024 MKT351): Canvas is used; timed multiple-choice exams.

So a Part 16 quiz is: multiple choice, **4 options, exactly one correct, 3 points each** (editable).
We take the *format and the topic names* only. The syllabus author's name, and every question in those sources,
stay out of the app.

## How it works (decided)

### Processes
An **eighth process**: `src/canvas-mcp.js`, “Canvas LMS — demo stand-in”, MCP over Streamable HTTP
(`@modelcontextprotocol/sdk` 1.32.1, already pinned), bound to `127.0.0.1:41247` (`PORT`), `npm run canvas`
(mock, labelled) / `canvas:live` (Haiku planner, paid). Quizzes in **memory only**: reseeded empty on start and
on New conversation (Faculty's `/author/reset` calls Canvas's `/dev/reset`). Nothing under `data/`.
Only the Faculty agent talks to it, with a per-start random **`CANVAS_TOKEN`** that `scripts/start-all.js`
makes and gives only to `canvas` and `professor` (removed from the others' environment; compared with
`timingSafeEqual`; never printed). The Hub does not register Canvas.

### The course schedule (code, not AI)
A new dependency-free module `src/course-schedule.js` (shared with the browser at `/shared/course-schedule.js`)
holds the fictional **Fall 2026** schedule: the 20 topics (number, MKTG14 name, exam unit, the date it is
taught) and, per topic, short **original notes** — about five key terms with our own one-line definitions. The
notes are the quiz model's only source. It is separate from `src/course-pack.js` (the Part 9 Q&A pack), which
stays as is.

| Unit | Topic: name — date taught (fictional Fall 2026, Tue/Thu) |
|---|---|
| Exam 1 | 1 An overview of marketing — Aug 25 · 2 Strategic planning for competitive advantage — Aug 27 · 3 Ethics & social responsibility — Sep 1 · 4 The marketing environment — Sep 8 · 5 Developing a global vision — Sep 10 · 6 Consumer decision making — Sep 15 · 7 Business marketing — Sep 17 (Exam 1 Sep 24) |
| Exam 2 | 8 Segmentation & targeting — Sep 29 · 9 Marketing research — Oct 1 · 10 Product concepts & branding — Oct 6 · 11 Developing & managing products — Oct 8 · 12 Services & nonprofit marketing — Oct 13 · 13 Distribution (place) — Oct 15 · 14 Retailing — Oct 20 (Exam 2 Oct 22) |
| Exam 3 | 15 Marketing communications — Oct 27 · 16 Advertising, PR & sales promotion — Nov 3 · 17 Personal selling — Nov 10 · 18 Social media — Nov 17 · 19 Pricing concepts — Nov 19 · 20 Marketing metrics — Dec 1 (Exam 3 in finals week) |

**Taught** = its date is on or before today (Pacific). On Nov 4 that is Topics 1–16, matching the mockup.
Before Aug 25 nothing is taught; after Dec 1 everything is. Code takes “today” from an injectable clock so
tests pin it.

### Flow, screen by screen

**1. The request.** Dr. Dabirian types `@assistant create a quiz for Marketing 351`. Code checks every
message (with or without `@assistant`) for a quiz request **first, before the staff desk** (`staffTurn` runs
first today, `src/professor-agent.js:319`): `asksQuiz` = a make/create/draft/write/give verb plus “quiz”, no
student tag. A match is a quiz turn even while an HR card is open (the words name a quiz, not time off), and a
waiting `pendingQuiz` answer (a chip tap or a topic number/name) is read here too — neither reaches HR, the
cancellation offer, the 10 s staff classifier, or goes out as a direct post. On a code match there is **no
interpret model call**: code reads the topic (its number — “Topic 8” — or a word from its name or key terms)
and the count (“8 questions”; 1–20; default 5). An `@assistant` message code does *not* match still goes to
`interpretProfessor`, which may return a new decision `quiz`; that path always answers with the topic list
(the named topic highlighted) and never drafts in the same turn, so one turn never holds two long model calls.
No topic → the assistant's fixed reply “Which topic should the quiz cover?
Here's what Marketing 351 has covered so far — through Topic N (date).” with the unit groups as chips.
Taught chips are tappable; later ones are disabled and show their date. A tap sends “Topic 8 · Segmentation &
targeting” as his message. The question is held (`pendingQuiz`, like `pendingMeeting`); his next message is read
by code for a topic number or name; anything else is handled as a new message and the question stays.

**2. The draft card.** Faculty's model (live) writes `count` questions from the topic's notes in one structured
call: each a question, four answers, the index of the correct one. Code checks every question
(`checkQuestion` in the shared module `src/quiz-rules.js`, also served at `/shared/quiz-rules.js`): question
10–300 characters, four non-empty answers up to 150 characters each, all four different, exactly one correct,
no repeated question, and no date the notes don't contain. A question that fails is dropped; if fewer than
`count` survive, one repair call names the failures; still short → the card says “The AI drafted N of M —
add or draft the rest.” Mock mode builds labelled questions from the notes' key terms (“Which term matches:
<definition>?”), clearly marked as the mock.

The card (native chat card in the Faculty view, like the hand-over card; not an A2UI form):
- Summary slip (readable in 3 seconds): title, “N questions · P points · T minutes · A attempt(s) · due …”,
  badge “Not in Canvas yet”, and “Drafted by claude-haiku-5-5 from the Topic 8 course notes — read every answer
  before approving.”
- Settings: title (default “Topic 8 Quiz: Segmentation & Targeting”), points each (default 3; 1–10), time
  limit (default 10 minutes; 1–120), due (default the **next Monday, 11:59 PM** Pacific; must be in the future
  and within the term, which ends Fri, Dec 18, 2026), attempts (default 1; 1–3).
- Questions, each tagged **AI draft**, **Edited by you** or **Added by you**, with Edit and Remove. Edit opens
  the question text and four answer fields with a radio for the correct one, and Done. Remove collapses it to
  “Question 3 removed — “…” · Undo”.
- “+ Add a question” (blank, opens in edit mode) and “✦ Draft one more with AI” (one model call for one
  question, told the existing ones so it doesn't repeat them).
- “Approve & post to Canvas” is disabled until every question passes `checkQuestion` and there is at least one;
  the check line says “✓ 5 questions ready · 15 points” or names the first problem. “Discard draft” closes the
  card; nothing is sent.

Edits live in the page until Approve; Approve sends the **whole final quiz**, which the UI server and then the
Faculty agent check again with the same module (the agent's check is the authoritative one). One open draft at
a time: a new quiz request while one is open gets “You have a draft open (Topic 8). Approve or discard it first.”

**Where the card's state lives (memory only).** The draft and the Canvas card (draft id, quiz number, published
or not) are in the Faculty agent's **memory**, never in `data/professor-outbox.json`: Canvas forgets its quizzes
on every start, so a saved “Publish” card could later publish a different quiz with the same number. The
outbox chat keeps only outcome text (“Saved in Canvas as quiz #4821”, “Published”, “Discarded”), like HR's
receipts. `/author/state` carries a `quizCard` summary (draft id, state, quiz number, counts — like `hrCard`)
**without questions or answers**: the Faculty channel reaches every page's stream, including the student's
`/conversation` page. The full draft with the correct answers is fetched only by the Faculty view with
`GET /author/quiz/:draftId` (through the Hub proxy and the UI server). A chat entry whose card is no longer in
memory draws as closed (“This draft was closed when the app restarted.”), like `hrRecord`.

**The card survives redraws.** `renderProfessor` rebuilds the chat list when its signature changes
(`public/classroom.js:670-678`), e.g. on every delivery-state poll. The quiz card's element is kept in place the
same way as the HR card's (`hr.li`), so edits in progress are never wiped. “Draft one more” returns the new
question in its HTTP response and the page merges it.

**3. Approve → saved unpublished.** His approval shows as his bubble (“You approved the quiz … (1 edited,
1 added, 1 removed by you)”), then “Saving to Canvas…”. Faculty's AI picks the tool (`chooseTool`, live: one
structured call, enum of the listed tools; mock: labelled heuristic); code checks the pick against
`MOMENT_TOOL` (approve → `create_quiz`) and builds the arguments from the checked quiz. Canvas confirms →
the Canvas card: “Saved in Canvas as an **unpublished** quiz — students can't see it yet.”, Canvas's quiz number
(“#4821 · MKTG 351 (Fall 2026)”), the facts, then “Publish it now? Publishing makes it visible in Canvas, and your
N students get a notification.” with **Publish & notify students** and **Keep as draft**.

**4. Publish.** A second MCP moment (publish → `publish_quiz`, same tool-choice check). Canvas confirms →
“● Published — … is open in Canvas (quiz #4821), due …”, then the notice is posted to `all` through the Hub and
the card shows each student's state as posts do today (Alex: Notified; Sam: Queued at Hub — their student
agent isn't connected). **Keep as draft** → “Kept as a draft in Canvas (quiz #4821). Nobody was notified.”; the
card keeps a “Publish & notify students” button until it is published or the app resets.

**5. The student's notice.** A Part 9 `message` post written by code (author `professor`, `verbatim: false`,
like the class-cancellation notice) with a new `quiz` field: `{ canvasQuizId, title, questions, points, minutes,
attempts, dueAt }` — facts only, never questions or answers. `contentHash` (`src/lessons.js:49`) gains a `quiz`
argument and uses the long form whenever a quiz is present (today a professor post without a meeting hashes
only title, text and kind, which would leave the quiz facts unprotected). Every place that carries `meeting`
carries `quiz` too: `validQuizNotice` beside `validMeeting` (Hub `hub-lessons.js:95`, Student inbox
`student-inbox.js:60-61`), the stored lesson (`:116`), the delivery (`:156`) and the `lesson_received`
payload (`student-inbox.js:72`). The Student chat shows it as
“Dr. Dabirian → the whole class”, a **Quiz** tag, the facts, and “Notice only — take it in Canvas”, plus a toast
“New quiz in Marketing 351”. No ↩ Reply on a quiz notice; it is marked opened when seen, like messages.

### MCP tools offered by Canvas
- `create_quiz { courseId, title, questions[], pointsEach, minutes, attempts, dueAt, operationId }` → `{ quizId,
  published: false, … }` or a refusal. Idempotent by `operationId`; synchronous check-and-write.
- `publish_quiz { courseId, quizId, operationId }` → `{ quizId, published: true }`. Publishing an already
  published quiz answers the same way (idempotent).
Quiz numbers start at 4821 on every start. `MOMENT_TOOL`: approve → `create_quiz`, publish → `publish_quiz`.

### Canvas's wrapper AI
On `create_quiz` its planner (`CANVAS_MODE` mock | live, read at import) picks steps from a fixed menu:
`check_questions`, `check_settings`, `check_due_date`, `check_course`, `store_quiz`, `set_unpublished`; code
always adds `check_questions`, `check_settings`, `check_due_date`, `store_quiz`, refuses unknown steps and runs
each. `publish_quiz` runs `check_quiz_exists`, `set_published`. Steps never leave Canvas (only a `stepCount`).
A failed plan still runs the required steps. `maxRetries: 0`, no fallback, errors through `toLlmError`.

**Refusal codes** (fixed set, only the code passes telemetry): `bad_question`, `bad_settings`, `due_in_past`,
`unknown_course`, `unknown_quiz`, `operation_reused`, `reset_during_call`.

### Failures (honest, never retried by itself)
| What happened | Approve shows | Publish shows |
|---|---|---|
| Canvas down / no session (`unavailable`) or timed out mid-call (`uncertain`) | “Canvas didn't answer. Nothing is posted until it confirms — press Approve again; it won't post twice.” | “Canvas didn't answer, so the quiz may still be unpublished and nobody was notified. Press Publish again; it won't publish twice.” |
| Faculty's AI picked the wrong tool | “Nothing was sent — Faculty's AI chose the wrong Canvas tool. Press Approve again.” | same, with Publish |
| Faculty's AI didn't answer the tool choice | “Faculty's AI couldn't choose a Canvas tool just now, so nothing was sent. Press Approve again.” | same, with Publish |
| Canvas refused | the card reopens with Canvas's plain sentence for that code | same |

Retries reuse the same `operationId`; unknown or retryable results are never cached at any layer (Part 15 rule).
Students are notified **only after Canvas confirmed the publish**, once per draft: the post's operationId is
`quiz-notice-<draftId>` (draft ids are random, so it matches the ID rule `/^[\w-]{6,80}$/` in
`src/lessons.js:31` and never collides with a saved operation after Canvas restarts its numbering at 4821). New conversation during a call: Canvas's reset generation refuses with
`reset_during_call`, and a closed card answers with its closed message, as in Part 15.

### Topology (approved, screen 6)
- New node `canvas`: kind `system`, name “Canvas LMS”, role “MCP SERVER”, a quiz-clipboard icon, colour moss
  `--lms` `#4d7c0f` / tint `#eef6dc` / ink `#365a09` (dark: `#a3d65c` / `#24301a` / `#c8ec98`), sparkle and
  sweep while busy, status pill (Not connected yet / ✓ Connected / ● Working… / Unreachable). New edge
  `professor-canvas`, MCP kind (dash-dot), hexagon pulse captioned `tools/call`.
- **Layout (approved positions, viewBox `0 0 1100 1029`):** Student (130,477), Hub (450,477), Student's model
  (130,227), Hub's model (450,227); agents in a column at x 710, evenly spaced: Tutor 95, Library 350, Faculty
  605, HR 860; the right column at x 985: Tutor's model 95, Library's model 350, Faculty's model 550,
  **Canvas 680** (176×80), HR's model 805, **PeopleSoft 935** (PeopleSoft moves from below HR to under HR's
  model). Each agent's HTTPS line goes up-right to its model; its MCP line goes down-right to its system.
- Faculty emits `mcp_call_started`, `mcp_call_result`, `mcp_tool_refused` and run-less `canvas_session`
  (connected | unreachable | not_configured, only on a change; added to the UI server's `CONFIG_EVENTS`).
  `src/topology.js` today hard-codes these three labels to HR → PeopleSoft (`:137-140`); they branch on the
  event's `source` (professor → `professor-canvas` with Canvas wording, hr → as today), and `hop()`/`edgeFor`
  and `NODE_NAMES` gain `canvas`. The quiz runs use `prof-<operationId>` run ids, or the UI server's
  `professorViewRun` (`ui-server.js:55-58`) drops their events. Faculty's draft calls already show as the Faculty → Faculty's model hop. Details
  panel: “Canvas LMS — demo stand-in”, its tools, last call; never step names.

### Telemetry and privacy
Run events carry ids, tool, moment, `quizId`, `questionCount`, `stepCount`, outcome and refusal code only — no
question or answer text, no title (unless `HUB_TELEMETRY_SHOW_CONTENT=1`). The Hub's `SAFE_FIELDS` gains
`quizId`, `questionCount`. Faculty and Canvas logs never print questions or answers. Staff-entry privacy guards
(Part 14) are unchanged.

### Routes (all non-GET routes origin-guarded, strict keys, id formats checked)
- Faculty agent: `POST /author/quiz-action` (`approve` with the full quiz, `publish`, `keep_draft`, `discard`,
  `one_more`; deduped by operationId for definite outcomes only) and `GET /author/quiz/:draftId`.
- Hub: two more lines in the explicit author proxy list (`hub-agent.js:768-773`):
  `/dev/agents/:agentId/author/quiz-action` and `/dev/agents/:agentId/author/quiz/:draftId`.
- UI server: `POST /api/professor/quiz/actions` (runs `checkQuiz` on approve) and
  `GET /api/professor/quiz/:draftId`, beside `/api/professor/hr/actions`.

### Starting without Canvas
The Faculty agent starts without `CANVAS_TOKEN` (Canvas shows “not configured” and Approve answers “Canvas isn't
connected, so nothing was sent.”), so `npm run professor` and `startStack({ professor: true })` keep working.
Without `CANVAS_URL` it uses the closed port 9 (like a stand-alone `startHr`), never a real :41247.
`startStack({ canvas: true })` starts Canvas on a pre-picked port with a random token.

### Timeouts (added to `src/timeouts.js`, nested like Part 15)
Canvas planner 8 s → Faculty tool choice 8 s → Faculty's MCP call 12 s → Hub author proxy 80 s → UI 85 s.
A quiz turn is budgeted as a whole and checked in `test/timeouts.test.js`: a code-matched request makes no
interpret call, the draft call gets 30 s and its one repair 20 s (50 s < 80 s); its token cap is raised for that
call only. The interpret path (45 s, `professor-model.js:21`) only lists topics, never drafts. “One more” gets 15 s.

## Decisions I made (marked for the owner to review)

1. **Default quiz:** 5 questions, 3 points each, 10 minutes, 1 attempt, due next Monday 11:59 PM — all editable
   on the card. (The course's exams are 50 questions; a topic quiz is a short check.)
2. **The schedule is fictional Fall 2026** (Tue/Thu dates above), so “taught so far” works on any demo day.
3. **Two Canvas tools, not three.** `create_quiz` and `publish_quiz` cover both moments; the AI's choice is still
   real (two tools offered at each moment).
4. **The draft card is a native card**, not an A2UI form: it is the Faculty agent's own screen, and add/remove/
   undo over a list is beyond the pinned A2UI basic catalog without model-generated UI.
5. **Edits stay in the page until Approve** (a reload shows the AI's draft again); the draft is in memory only.
6. **Keep as draft keeps the Publish button** on the card until published or reset.

## Changes from the builder check (2026-11-04)

A reviewer read this design against the code. All ten findings are folded in above: the notice's operation id
(1), card state in memory only (2), the card kept in place on redraw (3), quiz requests checked before the staff
desk (4), a whole-turn timeout budget (5), Topology labels per source (6), the content hash and every `meeting`
path carrying `quiz` (7), the routes and `prof-` run ids (8), no answer key in the shared stream (9), and
starting without Canvas (10). Also: the PeopleSoft browser check (`scripts/browser-checks/peoplesoft.js:48`,
viewBox `1100 990` and PeopleSoft's position) and the Topology `aria-label` in `public/index.html:168` change with
the new layout. Screen 1's mockup caption “Faculty's model only reads the request” becomes: on a request code
recognizes, no model call is needed until the draft.

## Owner's decision (2026-11-04): only topics already taught

Asked whether Dr. Dabirian may make a quiz ahead of time on a topic not yet taught, the owner answered: “only
topics already taught”. So:
- In the topic list, later topics are shown with their date but are disabled (as on screen 1).
- Typing one (“a quiz on pricing” on Nov 4) gets the fixed reply “Pricing concepts (Topic 19) is taught on
  Thu, Nov 19 — it hasn't been covered yet. Pick a covered topic.” followed by the list; no draft, no model call.
- Code enforces it at every hop, not only in the page: the Faculty agent refuses to draft, add “one more”, or
  approve a quiz whose topic is not taught by today (Pacific), and Canvas's `check_course` step does the same.
- Before the first class (Tue, Aug 25) the reply is “No Marketing 351 topics have been taught yet this term —
  the first class is Tue, Aug 25.”

## Left to the builder

Whether to extract a shared MCP client from `src/hr-peoplesoft.js` or copy its shape into
`src/professor-canvas.js`; the exact CSS; test layout (`startStack({ canvas: true })`, fake Anthropic replies
for the draft, “one more” and tool choice); the rehearsal stack port (base+7, forbid 41247); the browser check
`scripts/browser-checks/canvas-quiz.js` on a separate rehearsal stack; Step 16 file, README, CLAUDE.md Part 16
notes, and the audience demos (v2 walkthrough scene, v1 progression entry).
