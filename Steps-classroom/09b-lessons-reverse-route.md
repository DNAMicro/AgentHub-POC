# Step 9b — Lessons on the reverse route, the Student's inbox, signed Student requests

Time: about 60 minutes. Cost: free (tests use mocks). Optional live check: PAID, a few cents.

## What you'll see when it works

- A lesson posted through the Professor's API travels Professor → Hub → Student as a **new** signed A2A `message/send` and lands in the idle student's persisted inbox.
- The student sees a toast "New Marketing 101 lesson", an unread badge on **Inbox**, and a lesson dialog. Follow-ups go to that lesson's professor.
- "Marketing 101 is now available." appears once. A post to `all` reaches Alex (Delivered) and queues for Sam (no Student agent).
- Every Student → Hub request is signed. Unsigned requests are refused.

## Starting point

Step 9a is done: the Professor runs behind the Hub and answers course questions. Start from the committed code of Step 9a.

## Instructions for Claude (lead)

Work in the three phases from Step 0. Write the Phase 1 files yourself. Then start **all four tasks in ONE message** with the Agent tool (models as in the table). Give each subagent this file, `00-setup-and-contracts.md` and its task row. Then join, run "Done when", append the CLAUDE.md notes and commit.

The Professor chat tab, `@assistant`, replies to messages and meetings come in Step 9c. Don't build them here.

## Phase 1 — Contracts (lead writes these first)

1. **`src/lessons.js`** (this step's contract; dependency-free apart from `node:crypto`):
   - `MT(name) = 'application/vnd.a2a-spike.' + name + '+json'`.
   - Media types: `LESSON_PUBLISH_MEDIA_TYPE` (`lesson-publish`), `LESSON_STATUS_MEDIA_TYPE` (`lesson-status`), `LESSON_DELIVERY_MEDIA_TYPE` (`lesson-delivery`), `LESSON_QUERY_MEDIA_TYPE` (`lesson-query`), `LESSON_RECEIPT_MEDIA_TYPE` (`lesson-receipt`), `COURSE_AVAILABLE_MEDIA_TYPE` (`course-available`), `STUDENT_SESSION_MEDIA_TYPE` (`student-session`), `SESSION_CHALLENGE_MEDIA_TYPE` (`session-challenge`).
   - `HUB_LESSON_MEDIA_TYPES` = publish, status, receipt, session. `STUDENT_INBOUND_MEDIA_TYPES` = delivery, query, course-available, challenge.
   - `LIMITS = { title: 120, text: 4000 }`. `POST_KINDS = ['lesson', 'message']`. `POST_AUTHORS = ['professor', 'assistant']`.
   - `AUDIENCE = /^(all|[a-z][a-z0-9-]{1,40}(,[a-z][a-z0-9-]{1,40}){0,49})$/` (`all`, one id, or up to 50 comma-separated ids). `ID = /^[\w-]{6,80}$/`.
   - `sign(key, fields)`: HMAC-SHA256 over `fields.map(f => String(f ?? '')).join('|')`, base64url.
   - `verify(key, fields, signature)`: false without a key or a string signature; otherwise a length check plus `timingSafeEqual`.
   - `contentHash(title, text, kind = 'lesson', author = 'professor', meeting = null)`: sha256 hex, first 32 chars. Hash `JSON.stringify([title ?? '', text ?? '', kind])` when `author === 'professor'` and there is no meeting. Otherwise hash `[title, text, kind, author, meetingPart(meeting)]`. `meetingPart` keeps `meetingId` and each slot's `{ slotId, start, label }`. This is the **only** content-hash formula. Step 9c uses its last two arguments.
   - `validateLesson({ kind = 'lesson', title, text })` → `{ ok: true, values: { kind, title, text } }` (trimmed) or `{ ok: false, errors }`. Kind must be in `POST_KINDS`, title ≤ 120, text non-empty and ≤ 4000.
   - `deliveryIdFor(lessonId, revision, studentId) = 'dl-' + sha256(`${lessonId}|${revision}|${studentId}`).hex.slice(0, 16)`.
2. **`src/json-store.js`**: `createJsonStore(file, initial)` → `{ get, update(fn), file }`. Load the file if it exists, else `structuredClone(initial)` and save. `update` runs `fn(state)` and saves synchronously (temp file + `renameSync`; create the folder first). No `await` inside.
3. **`src/a2a-data.js`**: `sendData(baseUrl, { mediaType, value, metadata = {}, contextId = '', timeoutMs = 5000 })`. Send one `message/send` with one data part. Cache one client per base URL; drop it after any failure.
   - Returns `{ ok: true, value }` (the reply's first data part) or `{ ok: false, outcome, error }`.
   - Card discovery failed or `ECONNREFUSED` → `outcome: 'not_delivered'`. Any other failure (timeout, connection lost) → `'uncertain'`.
4. **`src/hub-link.js`**: add `import { sign } from './lessons.js'` and `sendSigned(mediaType, value, fields)`. It sends `{ ...value, professorId: agentId, instanceId, signature: sign(callKey, [agentId, instanceId, ...fields]) }` with a 15 s timeout. It returns the Hub's typed reply, or `{ status: 'not_delivered' | 'uncertain', reason }`. Keep Step 8's `signStudent` where it is (`src/hub-registry.js` imports it from here).
5. **Signature field lists** (all with `sign`):
   - Professor publish: `['publish', operationId, lessonId, revision, courseId, kind, audience, contentHash]` (via `sendSigned`, which prepends `professorId, instanceId`).
   - Professor status read: `['status', nonce]`.
   - Session challenge proof: `['session', studentId, instanceId, nonce]`.
   - Student request: `metadata.studentSignature = sign(key, [studentId, contextId, messageId])`.
   - Receipt: `metadata.studentSignature = sign(key, [studentId, 'receipt', deliveryId, 'opened'])`.
   - Hub → Student (`metadata.hubSignature`, Student's session key): delivery `['delivery', studentId, deliveryId, lessonId, revision, contentHash]`, query `['query', studentId, deliveryId]`, notice `['notice', studentId, noticeId]`.
6. **Event names** (each side emits only its own):
   - Hub: `student_session`, `lesson_publish_received`, `lesson_rejected`, `lesson_delivery_attempted`, `lesson_delivered`, `lesson_queued`, `lesson_uncertain`, `lesson_reconciled`, `lesson_failed`, `lesson_opened`, `course_available_sent`, `classroom_reset`, `lesson_route_rejected`.
   - Both sides' `student_session` event carries `status` (`registered` | `rejected` | …) and `reason`, never `state`; the topology label reads `status`.
   - Student: `student_session`, `lesson_received`, `lesson_opened`, `course_available`, `inbox_reset`.
   - Professor: `lesson_posted`, `lesson_publish_result`, `lessons_reset`.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/hub-lessons.js`, `src/hub-agent.js`, `src/config.js`, `config/hub.example.json`, `src/topology.js`, `src/professor-agent.js` | Hub publishing, delivery, sessions, courses; Professor outbox and authoring API | `node -e "import('./src/hub-lessons.js')"` and `PORT=0 node src/professor-agent.js` start cleanly |
| B | sonnet | `src/student-inbox.js`, `src/ui-server.js`, `src/student-agent.js` | Student inbound endpoint, session, inbox APIs, signed requests, classroom reset | `UI_PORT=0 node src/ui-server.js` prints `[UI] listening on` |
| C | haiku | `public/classroom.js`, `public/app.js`, `public/index.html`, `public/styles.css`, `public/topology.js` | Inbox, notice banner, toast, lesson dialog, chips, message bubbles, lesson pulses | `node --check public/classroom.js`, `node --check public/app.js` and `node --check public/topology.js` pass |
| D | haiku | `test/support/harness.js`, `test/professor.test.js`, `test/hub.test.js`, `test/form.test.js`, `test/student-model.test.js` | Harness for the classroom, new tests, signed test students | `node --test test/professor.test.js` runs (after the join) |

### Task A — Hub and Professor publishing

**Hub configuration** (`src/config.js`, trusted data, validated with `ConfigError`):

1. Add `student-sam` to the Step 7a allowlist: `students: ['student-alex', 'student-sam']`. `studentNames: { 'student-alex': 'Alex Student', 'student-sam': 'Sam Student' }`.
2. `studentEndpoints: { 'student-alex': 'http://127.0.0.1:4444' }`. `STUDENT_URL` overrides the first student's endpoint. Each key must be a configured student; each URL must be localhost.
3. `courses: { 'mkt-101': { title: 'Marketing 101', professor: 'professor', enrolled: ['student-alex', 'student-sam'] } }`. The professor must be a peer; enrolled ids must be configured students. Mirror all of this in `config/hub.example.json`.

**`src/hub-lessons.js`** — `createLessonService({ cfg, registry, emit, file = HUB_LESSON_FILE ?? 'data/hub-lessons.json', deliverTimeoutMs = HUB_DELIVER_TIMEOUT_MS ?? 5000, retryMs = HUB_DELIVER_RETRY_MS ?? 3000 })`:

4. Store `{ lessons, operations, deliveries, notices }`. Keep student sessions **in memory only**: `studentId → { instanceId, callKey, since, unreachable? }`.
5. `registerStudent(msg)` checks in order: allowlisted (`unknown_student`); `instanceId` matches `ID` and `callKey` matches `/^[\w-]{40,64}$/` (`malformed`); `msg.endpoint` equals the configured endpoint, or both null (`unexpected_endpoint`).
6. A student without a configured endpoint can't be challenged. Refuse with `no_student_endpoint` unless `HUB_TEST_STUDENTS_WITHOUT_ENDPOINT=1`. Only tests set it.
7. With an endpoint, send a `session_challenge` (`{ studentId, instanceId, nonce }`) **to the configured endpoint** with `sendData`. Accept only if `verify(callKey, ['session', studentId, instanceId, nonce], reply.proof)`. Else `challenge_failed`.
8. On success: store the session, emit `student_session`, then (next tick) flush that student's deliveries and announce courses.
9. `verifyStudent(studentId, fields, signature)` → `'ok' | 'no_session' | 'bad_signature'`. It verifies `[studentId, ...fields]`.
10. `publish(msg)` checks in this order: registered professor instance (`unknown_professor`) → signature (`bad_signature`) → ids, integer revision ≥ 1, `AUDIENCE`, author (`malformed`) → course exists (`unknown_course`) → it teaches it (`not_course_professor`) → recipients enrolled (`recipient_not_enrolled`) → `validateLesson` (`invalid_content`) → operation dedupe (`operation_reused`) → revision immutability (`revision_conflict`).
11. Every rejection emits `lesson_rejected` and returns `{ status: 'rejected', reason, detail }`.
12. `audience: 'all'` expands to the course's `enrolled` list from **Hub config**, never from the professor.
13. A repeated `operationId` with identical content returns the stored outcome (`duplicate: true`). A revision (`lessonId#revision`) is immutable.
14. Create one `queued` delivery per recipient (`deliveryIdFor`). Emit `lesson_publish_received` (`audience`: `all | some | one`, `recipients`). Deliver all, then answer `{ status, lessonId, revision, deliveries: [{ studentId, deliveryId, state, reason, opened }] }`.
15. `status` is `delivered` when all are, else the first of `uncertain`, `queued`, `failed` present.
16. `deliver(id)` never runs twice at once for one delivery. No session, no endpoint or an `unreachable` session → `queued`, `lastError: 'student_offline'`; emit `lesson_queued` **only when it starts waiting**.
17. An `uncertain` delivery is **queried first** (`lesson_query`). If the Student has it, mark delivered and send nothing (`lesson_reconciled`, `found: true`).
18. Delivery value: `{ type: 'lesson_delivery', deliveryId, lessonId, revision, courseId, kind, author, meeting, toAll, courseTitle, professorId, professorName, title, text, postedAt, contentHash }`. Count `attempts`; emit `lesson_delivery_attempted`.
19. Reply `delivered` → `lesson_delivered`. Another reply → `failed` (`lesson_failed`). `not_delivered` → `queued` and the session becomes `unreachable`. `uncertain` → `lesson_uncertain`.
20. After every await, check the delivery still exists (a reset may have removed it). A pump every `retryMs` flushes queued/uncertain deliveries and announces courses.
21. `receipt(msg, signature)`: the delivery must exist and belong to `msg.studentId`. The signature must verify, and the event must be `opened`. Record `openedAt` once and emit `lesson_opened`.
22. `status(msg)` (Professor, signed `['status', nonce]`) → `{ status: 'ok', courses: [{ courseId, title, enrolled: [{ studentId, name, online }] }], deliveries: [...] }`. `online` = has a session that isn't unreachable.
23. `announceCourses()`: for each course whose professor is `ready`, and each enrolled student with a reachable session, send a signed `course_available`. Use `noticeId = 'av-' + courseId` (**stable**; a Professor restart is not a new announcement). Record `${noticeId}|${studentId}` as sent once the Student answers `ok`.
24. `lessonRoute(studentId, deliveryId)` → `{ professorId, lessonId, revision, courseId, title, kind, author }`, or null when the delivery isn't this student's.
25. `reset()` clears lessons, operations, deliveries and notices for every student. Sessions stay. Emit `classroom_reset`. Announce again after 300 ms.

**`src/hub-agent.js`**:

26. Handle `HUB_LESSON_MEDIA_TYPES` data parts right after Part 7 control messages, **before** any student check. Reply with a typed data part.
27. For student requests: after the allowlist check, require `lessons.verifyStudent(studentId, [msg.contextId, msg.messageId], msg.metadata?.studentSignature)`.
28. Refuse otherwise with a plain message ("Your student agent hasn't connected…" / "This request isn't signed by your student agent…") and `hub: { decision: 'rejected', reason }`.
29. `metadata.lessonDeliveryId` → `lessonRoute`. If found: `decision: 'route'`, the lesson's professor, `skillId: null`, `decidedBy: 'lesson'`. The reason names the lesson **id** and revision, never its title. Readiness is still checked.
30. A delivery id that isn't this student's emits `lesson_route_rejected` and routing continues normally.
31. Forward with `lessonId` and `lessonRevision` in metadata (only to that professor), next to Step 8's signed student.
32. Call `announceCourses()` when a professor's registry status becomes `ready`. Add `courses` and `lessons.snapshot()` (session student ids, delivery ids and states — never keys) to the topology snapshot.
33. Extend Step 7b's `SAFE_FIELDS` allowlist (don't re-create it): add `lessonId`, `deliveryId`, `inboxId`, `noticeId`, `courseId`, `attempt`, `found`, `kind`, `audience`, `recipients`. Titles and text stay redacted unless `HUB_TELEMETRY_SHOW_CONTENT=1`. Keep Step 8's structure-only inspector as it is.
34. Developer routes: `GET /dev/agents/:agentId/author/state` and `POST /dev/agents/:agentId/author/lessons` proxy to the peer's `/author/...` (60 s timeout).
35. `POST /dev/classroom/reset` runs `lessons.reset()`, then `POST <professor baseUrl>/author/reset` for each course professor, then `POST <library baseUrl>/dev/loans/reset` (the worker of `cfg.destinations.library`, 5 s timeout). It answers `{ status: 'reset', professors: { professor: 'reset' | 'HTTP <n>' | 'unreachable' }, library: 'reset' | 'HTTP <n>' | 'unreachable' | 'none' }`.
    - Loan store (Step 8's `src/loan-store.js`): add `reset()` → `state = { seededOn: today, loans: seed(today), operations: {} }`, then save. Library (`src/library-agent.js`): `POST /dev/loans/reset` behind `sameOriginGuard(port)` calls `loans.reset()`, clears `loanLedger` and `revisions`, logs `loans reset to the starting sample`, answers `{ status: 'reset' }`. So New conversation gives renewals back.
36. Apply `sameOriginGuard(port)` from `src/local-guard.js` (Step 2) to **every non-GET `/dev` route**. That includes the existing skill PUT/preview and `/dev/registry/refresh`.

**`src/topology.js`**: label every lesson event on a real edge (`student-hub` or `hub-professor`, category `lesson`). Never use Professor↔Student. For example, `lesson_delivery_attempted` is hub → student and `lesson_publish_received` is professor → hub. `lesson_queued`, `lesson_reconciled` and `classroom_reset` happen inside the Hub.

**`src/professor-agent.js`**:

37. Outbox: `createJsonStore(PROFESSOR_OUTBOX_FILE ?? 'data/professor-outbox.json', { lessons: {}, operations: {} })`. Key posts by `lessonId#revision`.
38. `createPost({ operationId, kind = 'lesson', title = '', text, audience, courseId = 'mkt-101', lessonId = null, source = 'api', verbatim = true, seedId = null, author = 'professor', meeting = null })`:
    - malformed id → 400; bad audience → 400; `validateLesson` errors → 400;
    - a known `operationId` with the same content → 200 `{ lesson, duplicate: true }`; different content → 409;
    - a `lessonId` makes a new revision (unknown → 404); otherwise a new `ls-<12 chars>` id, revision 1.
39. Store the record (`hubStatus: 'sending'`), emit `lesson_posted`, then call `sendSigned(LESSON_PUBLISH_MEDIA_TYPE, …)` with the Phase 1 fields.
40. The post counts as **Hub-accepted** (`hubAccepted`) when the ack has deliveries. Save `hubStatus`, `hubReason`, `recipients` (from the ack). Emit `lesson_publish_result`. Answer 422 if rejected, else 200 `{ lesson, ack: { status, reason, accepted, deliveries } }`.
41. `GET /author/state`: first re-send, with the **same operation id**, every post the Hub never accepted whose `hubStatus` is `uncertain` or `not_delivered`. Then return `{ course, roster, hubReachable, seeds, lessons }`. Each post carries its per-student deliveries from the signed status read.
42. `POST /author/lessons` → `createPost`. `POST /author/reset` clears the outbox and emits `lessons_reset`.
43. Guard every non-GET `/author` route with `sameOriginGuard`. The callers are servers and send no Origin.
44. Answering: when `metadata.lessonId` and `lessonRevision` name a post whose `recipients` include the Hub-verified student, pass that stored post as `lesson` to `professorReply` (the shape from Step 9a: `lessonId`, `revision`, `kind`, `title`, `text`; the model block holds only its title and text). Otherwise use no lesson. Put `lessonId` in `metadata.professor`.

### Task B — Student side

**`src/student-inbox.js`** — `createStudentInbox({ studentId, hubUrl, file = STUDENT_INBOX_FILE ?? 'data/student-inbox.json', emit, log })`:

1. Store `{ lessons (by deliveryId), notices, pendingReceipts }`. Make a random `instanceId` and a 32-byte base64url `callKey`, in memory only.
2. `register(endpoint)` sends `student_session { studentId, instanceId, endpoint, callKey }`. Emit `student_session`. Retry every 3 s until `registered`; then send pending receipts.
3. `signer({ contextId, messageId })` = `sign(callKey, [studentId, contextId, messageId])`.
4. Inbound `executor` accepts only `STUDENT_INBOUND_MEDIA_TYPES`. Anything else is answered `{ status: 'rejected', reason: 'This endpoint only accepts deliveries from the university.' }`.
5. **Challenge**: answer only for this `studentId` and `instanceId`, with `proof`.
6. **Delivery**: verify the Hub signature, kind and author; recompute `contentHash` (else `content_mismatch`). A known `deliveryId` with the same hash → `{ status: 'delivered', inboxId, duplicate: true }`; another hash → `conflict`.
7. Otherwise **write the entry to disk first**, then reply `{ status: 'delivered', inboxId: 'in-<12>' }`.
8. Emit `lesson_received` (ids, `kind`, `author`, `courseTitle`, `professorName`, `title`). A `message` also carries `text`, `toAll`, `postedAt`, `meeting`, because messages are shown in the chat.
9. **Query** → `{ has, inboxId }`. **Notice** → store once by `noticeId`, emit `course_available`, reply `ok`.
10. Test-only `STUDENT_TEST_DELAY_FIRST_DELIVERY_ACK_MS` holds the reply to the first committed delivery (a lost acknowledgment).
11. `markOpened(id)` sets `openedAt` once, queues a receipt, emits `lesson_opened`. Also `markSaved`, `markNoticeSeen`, `reset()` (emits `inbox_reset`), and `view()` → `{ lessons, notices, unread, unreadLessons }` (messages excluded from `unreadLessons`).

**`src/student-agent.js`**: `askTutor` and `sendFormAction` take `signer`. With a signer and no `contextId`, `askTutor` makes one (`randomUUID()`), because a server-assigned id can't be signed. Pass `signer` all the way into the inner `exchange()`. Set `message.metadata.studentSignature`.

**`src/ui-server.js`**:

12. Serve the Student's inbound side on the UI port, mounted inside `listen()`: card "Student Agent" (one skill `receive-course-lessons`) and `/a2a/jsonrpc` with `inbox.executor`.
13. `inbox.register(baseUrl)` at startup and whenever the Hub feed reconnects. Pass `signer: inbox.signer` on every chat and form action.
14. `POST /api/runs` accepts optional `lessonDeliveryId` (must be in the inbox, else 400 "Unknown lesson.") or `capability` (a Hub capability id). Either skips the planner: emit `request_planned` with `by: 'lesson' | 'course'` and forward it in metadata (`requestedCapability` for a course).
15. `GET /api/inbox` (`view()` plus `session`), `POST /api/inbox/:deliveryId/open` (the **only** way to mark opened), `POST /api/inbox/:deliveryId/save`, `POST /api/notices/:noticeId/seen`.
16. `GET /api/professor/state` and `POST /api/professor/lessons` proxy to the Hub's `/dev/agents/professor/author/...`. `/api/status` adds `student.session` and `student.inboxUnread`.
17. Add `lesson_posted`, `lesson_publish_result`, `lessons_reset` to `CONFIG_EVENTS`, or the browser never sees these run-less Professor events.
18. **New conversation** (`POST /api/conversation/new`), in this order:
    - publish `conversation_reset` (screens clear);
    - `inbox.reset()`;
    - `POST <hub>/dev/classroom/reset`;
    - publish `classroom_reset` with `classroom: 'reset' | 'hub_unreachable' | 'hub_error' | 'professor_unreachable'` and, separately, `loans` (the Hub's `library` answer, or `'unknown'` if the Hub wasn't reached). Answer `{ classroom, loans }`. The browser adds an error note only when `loans` isn't `reset`, `none` or `unknown`: "The library loans couldn’t be reset (…), so renewals used earlier still count."

### Task C — Browser

1. `public/classroom.js` exports `createClassroom({ sendChat, showConversation, focusComposer, followLog, onInboxChange })`. It returns `event(event, { live })`, `hasInboxItems()` and `composerContext()` (`{ lessonDeliveryId }`, `{ capability }` or `{}` for the next message).
2. Lesson text is content: set it with `textContent` only. Nothing in it is ever acted on.
3. **Inbox button** in the chat header with the unread **lesson** count. The Conversation tab gets a dot (`data-unread`) counting lessons and messages.
4. A collapsible inbox lists **lessons only**: New / Opened marker, title, course, time, "saved for later", and **View lesson**.
5. **Notice banner** "Marketing 101 is now available." with **Ask a question** and **Got it**. Ask sets the chip "About: Marketing 101" (capability `marketing`) and focuses the composer. Both mark the notice seen.
6. **Toast** for a new lesson: top-right, `role="status"`, never focused, "New Marketing 101 lesson", **View lesson** / **Dismiss**. It leaves after 15 s unless hovered or focused. Only live events, never replayed history.
7. **Lesson dialog** (`<dialog>`): "course · from professor · posted time", the title, the original text. Buttons:
   - **Start lesson** — sends "I'm starting the lesson "<title>"." with `lessonDeliveryId`;
   - **Ask about this lesson** — closes, sets the chip "About: <title>", focuses an empty composer;
   - **Save for later**; **Close**. Escape closes it.
8. Opening the dialog calls `POST /api/inbox/:id/open`. Toasts, deliveries and Save never mark anything opened.
9. While the chip is set, each message carries `lessonDeliveryId` (or `capability`). × or New conversation clears it.
10. A delivered **message** appears in the student's chat as its own bubble: "Marketing 101 Professor → you", or "→ the whole class" when `toAll`.
11. The composer has **no default text**, only the placeholder "Ask anything…".
12. Show New conversation whenever the inbox has anything. On `classroom_reset`, close the dialog and remove toasts and the chip. Explain only a partial reset in the chat; a clean reset shows nothing.
13. Student console lines for lesson events; Hub console lines for delivery events. The timeline marks a lesson route "(from your inbox)".
14. `public/topology.js`: a **bookmark** pulse shape for category `lesson`, in the legend as "Lesson or course notice".
15. Usable at phone width and by keyboard. Restrained animation. Every new element styled with `display` gets `[hidden] { display: none }`.

### Task D — Harness and tests

1. `startHub` gives `HUB_LESSON_FILE` a temp file and sets `HUB_TEST_STUDENTS_WITHOUT_ENDPOINT=1`. `startUi` gives `STUDENT_INBOX_FILE` a temp file. `startProfessor` gives `PROFESSOR_OUTBOX_FILE` a temp file. Never touch `data/*.json`.
2. `startStack` always pre-picks the UI port and gives the Hub `STUDENT_URL`, so the challenge reaches the test UI. Set `HUB_DELIVER_RETRY_MS=500`. Wait until `/api/status` shows `student.session === 'registered'`.
3. Add `signedStudent(hubUrl, studentId)`. It registers a session with `endpoint: null` and returns `{ metadata: { studentId }, signer }`. Use it only for students with no configured endpoint (for example `student-sam` via `HUB_STUDENTS`).
4. Update existing tests that called the Hub directly as `student-alex` (`test/hub.test.js`, `test/form.test.js`, `test/student-model.test.js`) to use `signedStudent`. A second UI for `student-alex` is now refused; such a test starts its own stack. This includes `test/ui.test.js`: any test there that starts another UI against the shared stack must start its own stack instead.
5. A stopped process may have `exitCode === null` (killed by a signal). Check `signalCode` too before awaiting `exit`.
6. `test/professor.test.js` (mock Professor and router; labelled plumbing, not judgment) checks:
   - a marketing question reaches the Professor through the Hub;
   - a lesson reaches an idle student who never chatted;
   - the notice appears once, also after restarts (`av-mkt-101`);
   - opening marks opened; a follow-up with `lessonDeliveryId` goes to its professor (`decidedBy: 'lesson'`); another student's delivery id is refused;
   - wrong course professor, unknown course, unenrolled recipient and a forged publish are rejected;
   - double post, restarts, reconnects and replay give one delivery;
   - Student offline → queued (session unreachable) → delivered on return; `/api/inbox` has it after a reload;
   - lost acknowledgment (`STUDENT_TEST_DELAY_FIRST_DELIVERY_ACK_MS`, `HUB_DELIVER_TIMEOUT_MS=400`) → reconciled, one entry;
   - a delivery never marks opened; hostile lesson text triggers nothing;
   - a `message` to `all`: Alex delivered, Sam queued; unknown kind or unenrolled audience refused;
   - `no_student_endpoint` when `HUB_TEST_STUDENTS_WITHOUT_ENDPOINT=0`;
   - New conversation clears inbox, Hub and Professor list; the notice returns once;
   - New conversation restores the sample loans through the Hub (`loans: 'reset'`; L-1001 back to version 1, no hold, 0 renewals) — in `test/loans.test.js`, using the `LIBRARY_TEST_HOOKS` hold hook to change a loan first; `loanStore.reset()` unit test: counts and due dates from today, stored operations cleared;
   - cross-site POSTs (`Origin: http://evil.example`) to `/dev/classroom/reset`, `/dev/registry/refresh`, `/author/reset`, `/author/lessons` → 403, nothing changes.
7. While the Student UI is down, tests post through the Professor's own `/author/lessons` (the proxy lives in the UI server).

## Phase 3 — Join and check (lead)

1. Confirm all three agents use the Phase 1 signature field lists.
2. Run `node --test test/professor.test.js`, then `npm test`. Fix failures in the owning files.
3. (Optional — needs a browser; if none is available, say so.) Run `npm run demo` and do the browser checks below.

## Rules that apply to the whole step

1. The reverse route is a **new** `message/send` with one typed data part, never a task-status push. These media types are this app's conventions, not standard A2A fields.
2. Endpoints come only from Hub configuration.
3. "Delivered" only after the inbox commit. "Opened" only from `POST /api/inbox/:id/open`. Reconcile uncertain deliveries before re-sending.
4. Dedupe at every hop: `operationId` at the Professor outbox and the Hub (persisted), `deliveryId` at the Student.
5. Keys are per process, in memory, exchanged over localhost. Never log, emit, snapshot or send them to the browser. This stops casual local spoofing, not a determined attacker.
6. Every non-GET `/dev/*` and `/author/*` route uses `sameOriginGuard`.
7. Never run resets against a demo someone is using. Use a separate stack with temp data files.
8. The Professor answers in text. This step adds no A2UI forms.

## Avoid these known problems

- `signer` added to `askTutor` but not passed into `exchange()` throws "signer is not defined" on every chat.
- Don't put the lesson title in `route_decided.reason`. It passes the telemetry allowlist.
- "Accepted by the Hub" is not "delivered". The Professor never re-sends a Hub-accepted post.
- A session isn't presence. Mark it unreachable on a refused connection.
- Publish `conversation_reset` **before** the reset, or the screen-clear erases the reset lines.
- `Object.assign(el, { dataset })` throws. Assign into `el.dataset`.
- In browser scripts, wait for the new message count, not just `state === 'completed'`.

## Done when

- `npm test` → all tests pass, 0 failed.
- `node --test test/professor.test.js` passes.
- `npm run demo`, browser at `http://127.0.0.1:4444` (optional — needs a browser; if none is available, say so):
  - the banner "Marketing 101 is now available." appears once; Got it hides it, and a reload doesn't bring it back;
  - `curl -s -X POST localhost:4444/api/professor/lessons -H 'Content-Type: application/json' -d '{"operationId":"op-demo-0001","audience":"all","title":"Customer value","text":"Customer value is what you get minus what it costs."}'` → Alex delivered, Sam queued; a toast appears without stealing focus;
  - View lesson → the dialog; Ask about this lesson → empty, focused composer with the chip; a follow-up is answered by the Professor;
  - repeating the same curl creates no second lesson;
  - New conversation empties the inbox, and the notice returns once.

Then append the "CLAUDE.md notes" below to `CLAUDE.md` and commit `Step 9b: Lessons on the reverse route`.

## CLAUDE.md notes

```markdown
## Step 9b (lessons, inbox, signed Student)
- Reverse route = new message/send with one typed data part (src/a2a-data.js sendData → {ok,value} | {ok:false,outcome}). Media types, sign/verify, contentHash (one 5-arg formula), deliveryIdFor ('|' separator) live in src/lessons.js.
- Hub handles HUB_LESSON_MEDIA_TYPES before any student check; the Student's inbound executor accepts only STUDENT_INBOUND_MEDIA_TYPES.
- Every Hub caller is signed: specialists (Step 8), Professor publishes (sendSigned), Student (session + challenge to configured studentEndpoints URL, then metadata.studentSignature over [studentId, contextId, messageId]). Unsigned student requests are refused.
- Tests calling the Hub directly use signedStudent (a student with no endpoint, e.g. student-sam via HUB_STUDENTS). HUB_TEST_STUDENTS_WITHOUT_ENDPOINT=1 only in tests.
- Delivered only after the inbox commit; opened only via POST /api/inbox/:id/open; uncertain → query before re-send; notice id av-<courseId>.
- 'all' is expanded by the Hub from courses[...].enrolled; never from the Professor.
- New conversation: conversation_reset → inbox.reset() → Hub /dev/classroom/reset (→ Professor /author/reset, → Library /dev/loans/reset: sample loans and renewal counts back) → classroom_reset { classroom, loans }. Sessions stay.
- Follow-ups carry lessonDeliveryId; the Hub routes by its own delivery record (decidedBy 'lesson'); reasons name the lesson by id only.
- Every non-GET /dev/* and /author/* route uses sameOriginGuard. Never run resets on the user's running demo.
```

## Show it (optional)

- Free: post with the curl above and watch the Topology tab: bookmark pulses Professor → Hub → Student.
- PAID (a few cents): `env -u ANTHROPIC_BASE_URL npm run demo:live`, post a lesson, open it and ask a follow-up. The answer stays on that lesson and invents no dates.
