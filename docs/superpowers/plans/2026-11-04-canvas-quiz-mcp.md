# Canvas Quiz over MCP (Part 16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dr. Dabirian asks the course assistant for a quiz; the AI drafts it from a taught topic, he edits it, and on his approval the Faculty agent creates it in a Canvas LMS demo stand-in over MCP (unpublished), publishes it on a second click, and the Hub notifies every enrolled student.

**Architecture:** An eighth process, `src/canvas-mcp.js`, mirrors the Part 15 PeopleSoft stand-in (MCP Streamable HTTP, per-start token, wrapper AI that plans steps from a fixed menu, memory only). The Faculty agent (code name `professor`) gains a quiz desk (`src/professor-quiz.js`) checked before the staff desk, a Canvas link (`src/professor-canvas.js`) shaped like `src/hr-peoplesoft.js`, and two shared dependency-free modules (`src/course-schedule.js`, `src/quiz-rules.js`) used by the browser, the UI server, the agent and Canvas. The notice reuses the Part 9 post path with a new `quiz` field.

**Tech Stack:** Node ESM, `@modelcontextprotocol/sdk` 1.32.1, `@anthropic-ai/sdk` via `src/llm.js` `callModel`, Express 5, `node:test`, playwright-cli for browser checks.

**Spec:** `docs/superpowers/specs/2026-11-04-canvas-quiz-mcp-design.md` (approved 2026-11-04). Mockup: `docs/superpowers/specs/2026-11-04-canvas-quiz-mockup.html`. Read both before any task.

## Global Constraints

- Canvas stand-in: `127.0.0.1:41247` (`PORT`), `npm run canvas` (mock) / `canvas:live` (paid); startup line `Canvas LMS MCP server (demo stand-in) listening on http://127.0.0.1:<port>`.
- `CANVAS_TOKEN`: made by `scripts/start-all.js` with `crypto.randomBytes(24).toString('hex')` per start, given only to `canvas` and `professor`; compared with `timingSafeEqual`; never printed or logged.
- Memory only: Canvas quizzes, Faculty drafts and Canvas cards. Nothing new under `data/`. The outbox chat keeps outcome text only.
- Modes read at import: `CANVAS_MODE` (mock | live), `PROFESSOR_MODE` unchanged. `maxRetries: 0`, no fallback model, errors via `toLlmError`. Haiku 5.5: no sampling params, check `stop_reason`.
- Quiz format: multiple choice, 4 answers, exactly one correct; defaults 5 questions, 3 points each (1–10), 10 minutes (1–120), 1 attempt (1–3), due next Monday 11:59 PM Pacific, within the term (ends Fri, Dec 18, 2026); 1–20 questions.
- Question check: question 10–300 chars, four non-empty answers ≤150 chars, all four different, exactly one correct, no repeated question.
- Only topics taught by today (Pacific) — owner's decision. Enforced in the page, the UI server, the Faculty agent and Canvas.
- Canvas tools: `create_quiz`, `publish_quiz`. `CANVAS_MOMENT_TOOL = { approve: 'create_quiz', publish: 'publish_quiz' }`.
- Canvas step menu: `check_questions`, `check_settings`, `check_due_date`, `check_course`, `store_quiz`, `set_unpublished`; required: `check_questions`, `check_settings`, `check_due_date`, `store_quiz`. Publish runs `check_quiz_exists`, `set_published`.
- Canvas refusal codes (fixed): `bad_question`, `bad_settings`, `due_in_past`, `unknown_course`, `unknown_quiz`, `operation_reused`, `reset_during_call`, `not_taught`.
- Quiz numbers start at 4821 on every Canvas start. Course label “MKTG 351 (Fall 2026)”.
- Exact copy (from the spec, verbatim): topic question “Which topic should the quiz cover? Here's what Marketing 351 has covered so far — through Topic N (date).”; “Saved in Canvas as an unpublished quiz — students can't see it yet.”; “Publish it now? Publishing makes it visible in Canvas, and your N students get a notification.”; “Kept as a draft in Canvas (quiz #N). Nobody was notified.”; “You have a draft open (Topic N). Approve or discard it first.”; “This draft was closed when the app restarted.”; the four failure rows of the spec's Failures table; the untaught reply and the before-term reply from “Owner's decision”.
- Never show step names; never send questions, answers or titles in telemetry (unless `HUB_TELEMETRY_SHOW_CONTENT=1`); the answer key never reaches the Student or the shared stream.
- Questions are ORIGINAL, drafted from our own notes; never copy from Course Hero, Quizlet, Studocu or test banks; never name the real syllabus author.
- On screen it's “Faculty”, “Dr. Dabirian”, “Marketing 351”, “Canvas LMS”; code names keep `professor`.
- Browser renders with `textContent` only. Pin dependency versions exactly. Servers bind 127.0.0.1.
- Commit after every task (never push). Co-Authored-By trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A delivery poll arrives while he is editing** → his edits stay (card element kept in place). Test in Task 9 browser check: edit a question, wait 4 s, edit text still there.
2. **He presses Approve twice, or again after “Canvas didn't answer”** → one quiz in Canvas. Test in Task 7: same operationId twice → one record in `GET /test/quizzes`.
3. **New conversation while a draft or Canvas card is open** → card closes with “This draft was closed when the app restarted.”, Canvas empty, numbering back at 4821, a later notice still goes out (no operationId collision). Test in Task 7.
4. **A typed request names an untaught topic, or a hand-made POST approves one** → refused at the agent, not just the page. Test in Task 7 (`not_taught` at `/author/quiz-action`) and Task 3 (Canvas `not_taught`).
5. **The student page's stream during a draft** → no correct-answer indexes in `/api/ui/stream` events. Test in Task 7: read the professor-channel snapshot, assert no `correct` key anywhere.

---

### Task 1: Course schedule and quiz rules (shared, dependency-free)

**Files:**
- Create: `src/course-schedule.js`, `src/quiz-rules.js`
- Modify: `src/ui-server.js` (serve both at `/shared/course-schedule.js`, `/shared/quiz-rules.js`, next to `/shared/absence-types.js`)
- Test: `test/quiz-rules.test.js`

**Interfaces:**
- Produces (`src/course-schedule.js`, no imports):
  - `TERM = { label: 'Fall 2026', start: '2026-08-25', end: '2026-12-18' }`
  - `TOPICS`: 20 × `{ n, name, unit (1|2|3), taught: 'YYYY-MM-DD', tags: string[], notes: [{ term, definition }] }` — names and dates exactly as the spec's table; ~5 notes per topic, original wording, definition ≤140 chars.
  - `UNITS = [{ unit: 1, from: 1, to: 7, exam: '2026-09-24' }, { unit: 2, from: 8, to: 14, exam: '2026-10-22' }, { unit: 3, from: 15, to: 20, exam: null }]`
  - `pacificDate(now: Date) -> 'YYYY-MM-DD'`; `taughtTopics(now) -> TOPICS[]`; `isTaught(n, now) -> boolean`
  - `topicFromWords(text) -> n | null` (number “Topic 8”/“topic 8”, or a word from name/tags/note terms; null when two topics match equally)
  - `countFromWords(text) -> 1..20 | null`; `asksQuiz(text) -> boolean` (verb make/create/draft/write/give/build + “quiz”; false if a `@student` tag other than `@assistant` is present)
  - `dayLabel('2026-11-03') -> 'Tue, Nov 3'`
- Produces (`src/quiz-rules.js`, imports only `./course-schedule.js`):
  - `QUIZ_LIMITS = { questions: [1, 20], points: [1, 10], minutes: [1, 120], attempts: [1, 3], questionChars: [10, 300], answerChars: 150 }`
  - `defaultSettings(topicN, now) -> { title: 'Topic 8 Quiz: Segmentation & Targeting', pointsEach: 3, minutes: 10, attempts: 1, dueAt: ISO string }` (title-cased topic name; due = next Monday after today, 23:59 America/Los_Angeles)
  - `checkQuestion(q) -> { ok: true } | { ok: false, problem: string }` where `q = { text, answers: [4 strings], correct: 0..3 }`
  - `checkQuiz(quiz, now) -> { ok: true, quiz } | { ok: false, code: 'bad_question'|'bad_settings'|'due_in_past'|'not_taught', problem, index? }` where `quiz = { topic, title, pointsEach, minutes, attempts, dueAt, questions[] }`; rejects unknown keys; checks repeated questions.
  - `summaryLine(quiz) -> '5 questions · 15 points · 10 minutes · 1 attempt · due Mon, Nov 9, 11:59 PM'`

- [ ] **Step 1: Write the failing tests** in `test/quiz-rules.test.js`:

```js
const NOV4 = new Date('2026-11-04T20:00:00Z');
test('taught on Nov 4 = Topics 1–16', () => assert.deepEqual(taughtTopics(NOV4).map((t) => t.n), [...Array(16)].map((_, i) => i + 1)));
test('nothing taught before Aug 25; all after Dec 1', () => { assert.equal(taughtTopics(new Date('2026-08-24T20:00:00Z')).length, 0); assert.equal(taughtTopics(new Date('2026-12-02T20:00:00Z')).length, 20); });
test('Pacific date, not UTC', () => assert.equal(pacificDate(new Date('2026-11-04T06:30:00Z')), '2026-11-03'));
test('topic from words', () => { assert.equal(topicFromWords('a quiz on Topic 8'), 8); assert.equal(topicFromWords('quiz on pricing'), 19); assert.equal(topicFromWords('create a quiz for Marketing 351'), null); });
test('count from words', () => { assert.equal(countFromWords('segmentation, 8 questions'), 8); assert.equal(countFromWords('quiz'), null); assert.equal(countFromWords('40 questions'), null); });
test('asksQuiz', () => { assert.ok(asksQuiz('@assistant create a quiz for Marketing 351')); assert.ok(!asksQuiz('the quiz was hard')); assert.ok(!asksQuiz('@student-alex make a quiz')); });
test('defaults for Topic 8 on Nov 4', () => assert.deepEqual(defaultSettings(8, NOV4), { title: 'Topic 8 Quiz: Segmentation & Targeting', pointsEach: 3, minutes: 10, attempts: 1, dueAt: '2026-11-10T07:59:00.000Z' }));
test('checkQuestion: exactly one correct, four different answers', () => { /* ok case; 3 answers; duplicate answer; correct: 4; 9-char text → each ok:false */ });
test('checkQuiz: untaught topic → not_taught; past due → due_in_past; points 11 → bad_settings; repeated question → bad_question with index; extra key → bad_settings', () => { /* … */ });
test('summaryLine', () => assert.equal(summaryLine({ ...defaultSettings(8, NOV4), questions: Array(5).fill(Q) }), '5 questions · 15 points · 10 minutes · 1 attempt · due Mon, Nov 9, 11:59 PM'));
test('every topic has 4–6 original notes and a unique name', () => { /* 20 topics, notes length 4..6, definitions ≤140 */ });
```

- [ ] **Step 2: Run** `node --test test/quiz-rules.test.js` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement both modules.** Pacific dates via `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`. Write the 20 topics' notes yourself (textbook-standard concepts, your own one-line definitions). Add the two `/shared/*` routes in `src/ui-server.js` the same way `/shared/absence-types.js` is served.
- [ ] **Step 4: Run** `node --test test/quiz-rules.test.js` — Expected: PASS. Then `curl -s 127.0.0.1:<ui>/shared/quiz-rules.js | head -3` on a mock UI shows the module.
- [ ] **Step 5: Commit** — `git commit -m "Part 16: course schedule (Fall 2026) and shared quiz rules"`.

---

### Task 2: Canvas store and planner

**Files:**
- Create: `src/canvas-store.js`, `src/canvas-model.js`
- Test: `test/canvas-store.test.js`, `test/canvas-model.test.js`

**Interfaces:**
- Consumes: `checkQuiz`, `isTaught` (Task 1).
- Produces:
  - `CANVAS_REFUSAL_CODES` (the 8 codes in Global Constraints) in `canvas-store.js`.
  - `createCanvasStore({ now }) -> { generation(), create({ courseId, quiz, operationId, generation }), publish({ courseId, quizId, operationId }), list(), reset() }`. `create` → `{ ok: true, quiz: { quizId: 4821, courseId: 'mkt-351', courseLabel: 'MKTG 351 (Fall 2026)', published: false, title, questionCount, pointsTotal, minutes, attempts, dueAt } }` or `{ ok: false, code, reason }`. Synchronous check-and-write; operations in a `Map`; same operationId + same quiz → same answer; different quiz → `operation_reused`; stale generation → `reset_during_call`; courseId ≠ `mkt-351` → `unknown_course`. `publish` idempotent; unknown id → `unknown_quiz`. `reset()` empties, bumps generation, numbering back to 4821.
  - `canvas-model.js`: `CANVAS_MODE`, `STEP_MENU`, `REQUIRED_STEPS` (Global Constraints), `canvasStatus()`, `planSteps({ quiz, emit }) -> { steps: string[], by: 'model'|'mock'|'model_failed' }` (live: one structured call, enum of STEP_MENU; code adds required steps, drops unknown, keeps `store_quiz` last). Model timeout `TIMEOUTS.canvasPlannerMs` (Task 4 adds it; use 8000 via import).

- [ ] **Step 1: Write failing tests** mirroring `test/peoplesoft-store.test.js` / `test/peoplesoft-model.test.js`: first create → 4821, second → 4822; repeat operationId returns same quizId; changed quiz same id → `operation_reused`; untaught topic → `not_taught`; reset → list empty and next id 4821; generation captured before reset → `reset_during_call`; publish twice → both `published: true`; publish 9999 → `unknown_quiz`. Planner mock returns required steps in order; live with fake model returning `['set_unpublished','bogus']` → steps contain all required + `set_unpublished`, no `bogus`, `store_quiz` last; model 500 → `by: 'model_failed'` and still required steps.
- [ ] **Step 2: Run** `node --test test/canvas-store.test.js test/canvas-model.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** both files, copying the shape of `src/peoplesoft-store.js` and `src/peoplesoft-model.js`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `"Part 16: Canvas stand-in store and wrapper planner"`.

---

### Task 3: Canvas MCP server process

**Files:**
- Create: `src/canvas-mcp.js`
- Modify: `package.json` (scripts `canvas`, `canvas:live`), `test/support/harness.js` (`CANVAS_READY`, `startCanvas(env)`)
- Test: `test/canvas-mcp.test.js`

**Interfaces:**
- Consumes: Task 2 store and planner.
- Produces: `startCanvasServer({ port = 41247, token = process.env.CANVAS_TOKEN })`; MCP at `/mcp` with Bearer token; tools `create_quiz { courseId, quiz, operationId }` and `publish_quiz { courseId, quizId, operationId }`, each description starting `Demo stand-in for Canvas LMS:`; results as `structuredContent` (+ same JSON in `content[0].text`), refusals `isError: true` with `{ code, reason }`; the receipt includes `steps` (stripped by the Faculty link) and `stepCount`. `POST /dev/reset` (token-guarded, like PeopleSoft's), `GET /test/quizzes` only with `CANVAS_TEST_HOOKS=1`, `CANVAS_TEST_DELAY_MS`. Exits without a token. Closes MCP sessions on SIGTERM. Reads the create generation **before** `planSteps`.
- Harness: `export const CANVAS_READY = /Canvas LMS MCP server \(demo stand-in\) listening on (http:\/\/127\.0\.0\.1:\d+)/; export async function startCanvas(env)`.

- [ ] **Step 1: Write failing tests** copying `test/peoplesoft-mcp.test.js`'s shape: lists exactly two tools with the stand-in prefix; wrong token → 401; create then publish returns 4821 unpublished then published; `/dev/reset` resets numbering; `GET /test/quizzes` absent without the hook; no token → process exits non-zero with a line that doesn't contain any token; stdout never contains the token or a question text.
- [ ] **Step 2: Run** `node --test test/canvas-mcp.test.js` — FAIL.
- [ ] **Step 3: Implement** `src/canvas-mcp.js` from `src/peoplesoft-mcp.js`'s structure (local guard, `timingSafeEqual`, session map).
- [ ] **Step 4: Run** — PASS. Also `npm test` still green for `test/peoplesoft-mcp.test.js`.
- [ ] **Step 5: Commit** — `"Part 16: Canvas LMS stand-in MCP server (eighth process)"`.

---

### Task 4: Faculty's Canvas link and tool choice

**Files:**
- Create: `src/professor-canvas.js`
- Modify: `src/professor-model.js` (add `CANVAS_MOMENT_TOOL`, `chooseCanvasTool`), `src/timeouts.js`, `test/timeouts.test.js`, `test/support/fake-anthropic.js` (`canvasToolReply`)
- Test: `test/professor-canvas.test.js`

**Interfaces:**
- Produces:
  - `TIMEOUTS` additions: `canvasPlannerMs: 8000`, `professorCanvasToolChoiceMs: 8000`, `professorCanvasCallMs: 12000`, `professorQuizDraftMs: 30000`, `professorQuizRepairMs: 20000`, `professorQuizOneMoreMs: 15000`. `test/timeouts.test.js` asserts: planner < call; tool choice + call < `hubAuthorProxyMs`; draft + repair < `hubAuthorProxyMs`; one more < `hubAuthorProxyMs`.
  - `chooseCanvasTool({ moment: 'approve'|'publish', tools, emit }) -> { tool | null, by, model }` — same contract as `chooseTool` in `src/hr-model.js:239`, Faculty wording (“You are the Marketing 351 Faculty agent… You reach Canvas LMS (a demo stand-in)…”).
  - `createCanvasLink({ url, token, emit, timeoutMs, callFloorMs })` → `{ createQuiz({ quiz, operationId, isClosed }), publishQuiz({ quizId, operationId, isClosed }), close() }`, each returning the outcome set of `src/hr-peoplesoft.js:6-12` (`refused` codes kept only if in `CANVAS_REFUSAL_CODES`), steps stripped (`stepCount` kept). No token → `{ ok: false, outcome: 'not_configured' }` with no network call. Emits `canvas_session` (connected | unreachable | not_configured, only on change), `mcp_tool_refused`, `mcp_call_started { tool, moment }`, `mcp_call_result { ok, outcome, code, quizId, stepCount }`.
  - Decide in this task: extract a shared `src/mcp-link.js` from `hr-peoplesoft.js` only if both links pass their full tests unchanged; otherwise copy the shape. Either way `test/hr-peoplesoft.test.js` must stay green.

- [ ] **Step 1: Write failing tests** with `startCanvas` + `PROFESSOR_MODE` mock and live-with-fake: approve picks `create_quiz` and returns 4821; fake picks `publish_quiz` at approve → `tool_refused`, Canvas has 0 quizzes; fake 500 at tool choice → `tool_choice_failed`; Canvas stopped → `unavailable`; `CANVAS_TEST_DELAY_MS` beyond budget → `uncertain`; Canvas restarted (session unknown) → reconnect once and succeed; no token → `not_configured`, no `mcp_call_started`; `isClosed()` true → `closed`, no call; receipt has no `steps`.
- [ ] **Step 2: Run** `node --test test/professor-canvas.test.js test/timeouts.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those plus `node --test test/hr-peoplesoft.test.js` — PASS.
- [ ] **Step 5: Commit** — `"Part 16: Faculty's Canvas link and tool choice; timeout budget"`.

---

### Task 5: Quiz drafting (Faculty's model)

**Files:**
- Create: `src/quiz-model.js`
- Modify: `test/support/fake-anthropic.js` (`quizDraftReply(body, questions)`)
- Test: `test/quiz-model.test.js`

**Interfaces:**
- Consumes: `TOPICS`, `checkQuestion` (Task 1), timeouts (Task 4).
- Produces:
  - `draftQuiz({ topic: n, count, emit }) -> { questions: [{ text, answers, correct, origin: 'ai' }], by: 'model'|'mock'|'model_failed', model, short: number }` — live: one structured call (schema: array of `{ text, answers: string[4], correct: integer 0..3 }`), prompt holds ONLY that topic's notes as data and says “write original questions; never copy from any source”; drop questions failing `checkQuestion` or containing a date not in the notes; if fewer than `count`, ONE repair call naming the failures; `short = count - kept`. Token cap raised for this call only. Emits `model_call_started { purpose: 'draft quiz' }` etc.
  - `draftOne({ topic, existing: string[], emit }) -> { question | null, by, model }` — one question, told the existing question texts; repeats rejected.
  - Mock (`PROFESSOR_MODE=mock`): questions “Which term matches: <definition>?” with the right term and three other terms of the same topic; `by: 'mock'`, model label `mock (labelled heuristic)`.

- [ ] **Step 1: Write failing tests**: mock Topic 8 count 5 → 5 questions all passing `checkQuestion`, deterministic; live fake returns 5 good → 5, one call; fake returns 3 good + 2 bad then repair returns 2 good → 5, two calls; repair still bad → `short: 2`; fake `stop_reason: 'max_tokens'` → `model_failed`; prompt body sent to the fake contains Topic 8's note terms and no other topic's; `draftOne` with an existing text equal to the fake's answer → `question: null`.
- [ ] **Step 2: Run** `node --test test/quiz-model.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `"Part 16: AI quiz drafting from the topic's notes (mock labelled)"`.

---

### Task 6: The quiz notice on the post path

**Files:**
- Modify: `src/lessons.js` (`contentHash(..., quiz)`, `validQuizNotice`), `src/hub-lessons.js` (`:90-95`, `:116`, `:156`, `:247`), `src/student-inbox.js` (`:60-61`, `:72`), `src/professor-agent.js` (`createPost({ …, quiz = null })`)
- Test: add to `test/professor.test.js` (or new `test/quiz-notice.test.js`)

**Interfaces:**
- Produces: `validQuizNotice(q) -> boolean` — null, or exactly `{ canvasQuizId: int ≥1, title: 1–120 chars, questions: 1–20, points: int, minutes: 1–120, attempts: 1–3, dueAt: ISO }`, only with `kind === 'message'`; any extra key (e.g. `correct`, `answers`) → false. `contentHash(title, text, kind, author, meeting, quiz)` uses the long form when `meeting || quiz`; existing hashes unchanged otherwise (assert an old hash in the test). `lesson_received` carries `quiz`.

- [ ] **Step 1: Write failing tests**: old professor post hash unchanged; a quiz notice to `all` on `startStack({ professor: true })` reaches Alex's inbox with `quiz` intact and Sam as queued; a notice with `quiz.correct` is rejected `malformed` at the Hub; a tampered `quiz.dueAt` fails the Student's hash check.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**, following every place `meeting` flows today.
- [ ] **Step 4: Run** the new tests plus `node --test test/professor.test.js` — PASS.
- [ ] **Step 5: Commit** — `"Part 16: quiz notices travel the Part 9 post path (hashed, validated)"`.

---

### Task 7: The Faculty quiz desk, routes and reset

**Files:**
- Create: `src/professor-quiz.js`
- Modify: `src/professor-agent.js` (call the desk before `staffTurn` at `:319`; routes; `/author/state` `quizCard`; `/author/reset` also calls Canvas `/dev/reset` and closes cards), `src/professor-model.js` (`interpretProfessor` decision `quiz` with `topic`), `src/hub-agent.js` (two proxy lines at `:768-773`), `src/ui-server.js` (`POST /api/professor/quiz/actions`, `GET /api/professor/quiz/:draftId`), `test/support/harness.js` (`startStack({ canvas: true })` → `stack.canvas`, `stack.canvasToken`; professor gets `CANVAS_URL`/`CANVAS_TOKEN`; without it `CANVAS_URL=http://127.0.0.1:9`)
- Test: `test/professor-quiz.test.js`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `createQuizDesk({ canvas, createPost, now, emit })` → `{ turn(said, ctx) -> reply | null, action(body) -> result, draft(draftId) -> fullDraft | null, card() -> quizCard | null, reset() }`. `turn` returns null when the message isn't a quiz request or a `pendingQuiz` answer.
  - Replies: `{ action: 'quiz_topics', reply, topics: { taughtThrough, units: [{ unit, from, to, topics: [{ n, name, taught, date }] }] }, highlight }`, `{ action: 'quiz_draft', draftId, reply }`, or fixed text (untaught, before-term, draft already open).
  - `quizCard` (in `/author/state`): `{ draftId, topic, state: 'draft'|'saving'|'saved'|'publishing'|'published'|'kept'|'closed', canvasQuizId, questionCount, pointsTotal, deliveries? }` — **no questions, answers or `correct`**.
  - `POST /author/quiz-action` body `{ draftId, operationId, action: 'approve'|'publish'|'keep_draft'|'discard'|'one_more', quiz? }` (strict keys; origin-guarded; deduped by `quiz:<operationId>` for definite outcomes only). Approve re-runs `checkQuiz` (authoritative) and then `canvas.createQuiz`; publish → `canvas.publishQuiz` then `createPost({ operationId: 'quiz-notice-' + draftId, kind: 'message', title: 'New quiz', text, audience: 'all', verbatim: false, quiz })`. Runs use `prof-<operationId>` ids. Failure copy per the spec's table.
  - `GET /author/quiz/:draftId` → the full draft with `correct` (Faculty view only).
  - Outbox chat entries: `role: 'assistant'`, `quiz: { draftId }` + outcome text only.

- [ ] **Step 1: Write failing tests** on `startStack({ professor: true, canvas: true })` with a pinned clock (`PROFESSOR_NOW=2026-11-04T20:00:00Z`, read only when `PROFESSOR_TEST_HOOKS=1`):
  - “@assistant create a quiz for Marketing 351” → `quiz_topics`, taught through 16, no model call (mock counter unchanged), no HR call even with an HR card open (`hr: true`).
  - “Topic 8” afterwards → `quiz_draft`; plain “make a quiz on segmentation, 8 questions” → draft of 8.
  - “a quiz on pricing” → exact untaught reply; `PROFESSOR_NOW=2026-08-20…` → before-term reply.
  - Second request with a draft open → exact “You have a draft open (Topic 8)…”.
  - Approve with the full quiz → `saved`, quizId 4821; approve again same operationId → still one quiz in Canvas `/test/quizzes` (Review Focus 2); approve with topic 19 via direct POST → `not_taught`, nothing in Canvas (Review Focus 4).
  - Publish → Canvas published, Alex's inbox has the notice with `quiz` and no `correct` key; Sam queued.
  - Keep as draft → exact copy; publish later still works.
  - Canvas stopped → approve gives the exact “Canvas didn't answer…” copy, retry after restart files once.
  - `/author/state` and the UI stream's professor snapshot contain no `correct` key anywhere (Review Focus 5).
  - New conversation mid-draft → card `closed`, entry text “This draft was closed when the app restarted.”, Canvas empty, next approve → 4821 and its notice is delivered (Review Focus 3).
  - Telemetry for `prof-` runs contains no question text, title or answers.
- [ ] **Step 2: Run** `node --test test/professor-quiz.test.js` — FAIL.
- [ ] **Step 3: Implement** the desk, routes, proxy lines, UI routes and harness option.
- [ ] **Step 4: Run** the new file plus `node --test test/professor.test.js test/professor-staff.test.js test/hub-staff.test.js test/hr.test.js` — PASS.
- [ ] **Step 5: Commit** — `"Part 16: Faculty quiz desk — topics, draft, approve, publish, notify"`.

---

### Task 8: Topology — Canvas node and the approved layout

**Files:**
- Modify: `src/topology.js` (labels branch on `source`; `canvas` in `hop()`/`edgeFor`/`NODE_NAMES`), `public/topology.js` (positions, `canvas` node, `professor-canvas` edge, MCP kind, quiz-clipboard icon, details text), `public/index.html:168` (viewBox `0 0 1100 1029`, aria-label adds “Canvas LMS (a demo stand-in system), reached only by the Faculty agent over MCP”), `public/styles.css` (`--lms` tokens light/dark), `src/ui-server.js` (`CONFIG_EVENTS` += `canvas_session`), `scripts/browser-checks/peoplesoft.js:48,66` (new viewBox and position)
- Test: `test/topology-canvas.test.js`

**Interfaces:**
- Consumes: event names from Task 4.
- Produces: exact positions from the spec's Topology section (copy them; the approved scratch copy is `/private/tmp/claude-501/-Users-farsheed-Documents-MyApps-AgentHub-POC/1c947cd5-ba51-43cf-9406-0d28eee3e2dc/scratchpad/pub/topology.js` if it still exists). Colours `--lms #4d7c0f`, tint `#eef6dc`, ink `#365a09`; dark `#a3d65c` / `#24301a` / `#c8ec98`. Labels: `mcp_call_started` from professor → `tools/call create_quiz` on `professor-canvas`; result ok → `Saved as quiz #4821` / `Published quiz #4821`; refused → `Canvas refused (<code>)`; else “Canvas didn't answer”; tool refused → “Faculty’s AI picked a tool not allowed here — no call” / “Faculty’s AI didn’t answer — no call”.

- [ ] **Step 1: Write failing tests** like `test/topology-peoplesoft.test.js`: professor-sourced MCP events label on `professor-canvas`, hr-sourced still on `hr-peoplesoft`; no `llm-canvas` node; `canvas_session` passes the UI server's config filter.
- [ ] **Step 2: Run** `node --test test/topology-canvas.test.js test/topology-peoplesoft.test.js` — FAIL on the first.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS. Then on a mock rehearsal stack (`node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock`, after Task 10 adds base+7; until then start Canvas by hand) take a playwright-cli screenshot of `/topology` and compare it by eye with screen 6 of the mockup: Canvas under Faculty's model, PeopleSoft under HR's model, equal gaps. Run `scripts/browser-checks/peoplesoft.js` — all checks pass.
- [ ] **Step 5: Commit** — `"Part 16: Topology — Canvas LMS tile under Faculty's model; approved layout"`.

---

### Task 9: Faculty view and student chat UI

**Files:**
- Modify: `public/classroom.js` (topic chips message, draft card kept in place like `hr.li`, Canvas card, published card with per-student states, closed-card drawing; student-side quiz notice with **Quiz** tag, facts, “Notice only — take it in Canvas”, no ↩ Reply, toast “New quiz in Marketing 351”), `public/styles.css` (card styles from the mockup's `<style>` block, adapted to existing tokens)
- Create: `scripts/browser-checks/canvas-quiz.js`

**Interfaces:**
- Consumes: `/shared/course-schedule.js`, `/shared/quiz-rules.js` (Task 1); `POST /api/professor/quiz/actions`, `GET /api/professor/quiz/:draftId` (Task 7); `quizCard` in the Professor snapshot; `lesson_received.quiz`.
- Card behaviour (from the mockup, screen 2): summary slip recomputed live with `summaryLine`; settings row; per-question tags AI draft / Edited by you / Added by you; Edit (textarea + 4 inputs + radios + Done); Remove → “Question N removed — “…” · Undo”; “+ Add a question”; “✦ Draft one more with AI” (merges the response's question); Approve disabled until `checkQuiz` passes, check line “✓ N questions ready · P points” or the first problem; Discard. Approve's bubble: “You approved the quiz … (X edited, Y added, Z removed by you)”. All text via `textContent`.

- [ ] **Step 1: Write the browser check** `scripts/browser-checks/canvas-quiz.js` (playwright-cli run-code, same style as `scripts/browser-checks/peoplesoft.js`), run on a separate mock rehearsal stack, never the user's demo. Checks: chips 1–16 enabled, 17–20 disabled with dates; tap 8 → draft card with 5 questions; edit Q2 text, wait 4 s (≥1 snapshot poll), text still edited (Review Focus 1); remove Q3 + Undo restores it; remove Q3 again; add a question → Approve disabled with a problem line until four answers and a correct one are set; one more → 6 questions; Approve → “Saved in Canvas as an unpublished quiz…” with #4821; Publish → Published card, Alex “Notified”, Sam “Queued at Hub”; `/conversation` shows the Quiz notice, no Reply button, toast text; the page's DOM nowhere contains a `correct` marker on the student page; dark mode screenshot of the card readable.
- [ ] **Step 2: Run it** against the stack — Expected: FAIL (UI missing).
- [ ] **Step 3: Implement** the UI.
- [ ] **Step 4: Run it** — all checks PASS. Take screenshots of screens 1–5 and compare each by eye with the mockup; fix differences.
- [ ] **Step 5: Commit** — `"Part 16: Faculty view quiz card, Canvas cards and the student's quiz notice"`.

---

### Task 10: Eight processes, docs and demos

**Files:**
- Modify: `scripts/start-all.js` (Canvas eighth; `CANVAS_TOKEN` to `canvas` and `professor` only; `demo:live` sets `CANVAS_MODE=live`), `scripts/demo/rehearsal-stack.js` (Canvas at base+7, forbid 41247), `package.json`, `README.md`, `CLAUDE.md` (Part 16 notes section; “eight processes”; Scope constraints list Canvas's planner as a model user), `Steps/16-canvas-quiz-mcp.md` + `Steps/README.md` row (owner's original Part 16 prompt verbatim + every enhancement + “Avoid these known problems” incl. the ten builder-check findings + “Enhancements merged”), `scripts/demo/walkthrough/scene-16.js` + `npm run demo:build`, `scripts/demo/progression.js` (PARTS/STEPS entry), `../AgentHub-Exercise` Steps sync.

- [ ] **Step 1: Run** `npm test` — Expected: all green (record the count).
- [ ] **Step 2: Implement** the start scripts; `npm run demo` (mock) prints eight “listening on” lines including Canvas at 41247 and never prints the token (`grep -c` of the token in the log = 0).
- [ ] **Step 3: Write the docs and demo scenes.** Scene 16 handles the model answering in words or asking a clarifying question, and checks every model-dependent moment with `seen()`.
- [ ] **Step 4: Live check on the user's app** (announce first): stop the demo by PID, `env -u ANTHROPIC_BASE_URL npm run demo:live`, confirm “API host: api.anthropic.com”; in the Faculty view at http://127.0.0.1:4444/faculty run the whole flow with Topic 8; look at each screen and Topology; rehearse scene 16 with `?auto=4&shots=<dir>` and look at both windows' screenshots.
- [ ] **Step 5: Commit** — `"Part 16: eight processes, docs, Step 16, demo scenes"` (and the Exercise sync commit).
