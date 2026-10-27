# Step 9 — Marketing 101 classroom with professor-initiated lessons

> Final state: see `Steps/README.md`. This is your Part 9 prompt, in your wording and section order, with every decision and fix made while building it merged into the instructions. Running it after Steps 1–8 rebuilds the current app. **Concrete specification** blocks give the exact names, values and rules the current app uses, so a rebuild comes out identical. The closing sections list the problems to avoid and each change with why it was made.

PART 9: MARKETING 101 CLASSROOM WITH PROFESSOR-INITIATED LESSONS

Continue the existing application from Parts 1–8. Inspect the repository, running services, installed protocols, and existing UI first. Make an incremental addition, not a rewrite. Preserve the Tutor, Library, room reservations, generated renewal forms, Hub routing, and activity views. **Before removing or changing anything that already works and that this prompt doesn't cover, ask.**

The goal is to demonstrate that communication can begin on either side. A student can ask a professor for help, but a professor can also introduce a lesson while the student is idle, without waiting for the student to ask first.

**First settle the two open decisions left by Step 8** (asked at the start of this step; your answers):
- **Student → Hub identity: authenticate it with per-process keys.** Both the Professor (as a specialist, already) and the Student agent give the Hub a random key when they register. The Hub verifies the Professor's publishes, signs every delivery to the Student, and requires the Student's signature on every request it receives.
- **Generated UI inspector: structure only by default.** Full model text is relayed only with `HUB_TELEMETRY_SHOW_CONTENT=1`.
- **Professor view:** a new fourth tab in the same app (`/professor`), proxied server-side through the Hub to the Professor agent's authoring API. Confirmed again at the end of the step (“keep it as a tab”): don't move it to the Professor's own address.

## 1. ADD ONE MARKETING 101 PROFESSOR AGENT

Create one new agent named “Marketing 101 Professor.” It represents a fictional introductory university classroom and registers with the existing University Hub as a private specialist.

Its Agent Card should clearly describe its real capabilities: explaining introductory marketing concepts, discussing course lessons, working through examples, and helping students check their understanding. Do not advertise capabilities that are not implemented.

Update the Hub’s public capabilities and Student UI so the student can discover that Marketing 101 help is available. Preserve the existing public University Hub / CSUF-facing identity and private specialist registry. Do not expose direct specialist routing to the Student merely to make the demonstration work.

Use two genuine routes:
- Student → Hub → Marketing 101 Professor → Hub → Student.
- Marketing 101 Professor → Hub → Student for a new lesson.

If the Student service currently only sends requests, add the smallest compatible inbound A2A capability. Do not fake incoming lessons through a frontend shortcut or a direct Professor-to-Student browser call.

**Concrete specification**
- `src/professor-agent.js`, port **41244** (`npm run professor` mock, `npm run professor:live`), log prefix `[Marketing 101 Professor]`, ready line `listening on http://127.0.0.1:<port>`. It reuses the specialist plumbing: `createSkillService` (rules `{ answer: { knowledge: 'required' } }`), `createHubLink` (registration, heartbeats, card-change notices), `/viz/events`, and the Host guard.
- Config: `loadSpecialistConfig('professor')` (`PROFESSOR_CONFIG`, `PROFESSOR_MODEL`, `config/professor.example.json`). The Hub's defaults add the peer `{ agentId: 'professor', expectedName: 'Marketing 101 Professor', baseUrl: 'http://127.0.0.1:41244' }` (`PROFESSOR_URL` overrides) and the public destination **`marketing`** (worker `professor`, name “Marketing 101”, tags marketing / segmentation / targeting / positioning / branding / pricing / promotion / customer value / lesson). “marketing” is removed from the tutoring tags.
- The Student agent's inbound side lives in the UI server (same port, 4444): `/.well-known/agent-card.json` (“Student Agent”, one skill `receive-course-lessons`) and `/a2a/jsonrpc`. Its executor accepts only typed data parts from the Hub (below); anything else is answered `rejected`.
- `scripts/start-all.js` starts five processes; `demo:live` runs the Professor live.

## 2. SEED A REALISTIC INTRODUCTORY COURSE

Use a small, original course knowledge pack covering:
- Marketing, customer needs, and customer value.
- Consumer and organizational buying behavior.
- Marketing research and testing assumptions.
- Segmentation, targeting, and positioning.
- Products, services, and branding.
- Pricing fundamentals.
- Distribution and access to customers.
- Promotion, digital communication, measurement, and ethical marketing.

Use academic sources to establish the scope, such as Washington State University’s Core Principles of Marketing:
https://wsu.pressbooks.pub/marketing/

Write short original explanations and fictional examples with source references. Do not copy or ingest entire textbooks. Do not claim that this is an official CSUF course or approved curriculum.

Seed three useful lessons:
- “Marketing is more than advertising,” using a fictional campus café launching a breakfast option.
- “One product, different needs,” using reusable bottles and different customer priorities.
- “Evidence before assumptions,” using a student meal service deciding whether customers want delivery.

Each lesson should have a title, learning objective, short explanation, example, and a question that checks understanding.

The professor should use the existing configured model to answer naturally from course material and the active lesson. It should ask a focused question when information is missing and avoid inventing real deadlines, grades, policies, or student progress.

**Concrete specification**
- `src/course-pack.js`: `COURSE` (`courseId: 'mkt-101'`, `title: 'Marketing 101'`, a `note` saying it's fictional and not an official CSUF course), eight `TOPICS` (one per bullet above), each with an original explanation, a fictional example and **real chapter URLs** on wsu.pressbooks.pub (checked to exist; the book is CC BY-NC-SA, so nothing is copied), `SEED_LESSONS` (the three lessons with title, objective, explanation, example, check), and `PROFESSOR_DEFAULT_SKILLS`: one `answer` skill per topic whose `knowledge` is that topic's text plus its sources, plus a ninth skill, **`course-questions`** (“Questions about the course”: homework, assignments, late work, the lessons and messages the professor posted), whose knowledge says to answer only from those posts and otherwise say plainly the information isn't there (editable with ⚙ like the other agents). Without it a course question matched no advertised skill, so the Hub's router invented one and the Hub refused it.
- `src/professor-model.js`, `PROFESSOR_MODE` read at import: **mock** (default; labelled “(Mock mode — no model.)”: the best-matching topic's explanation and example, and the lesson's check question for lesson questions) or **live** (the Professor's configured model, structured output `{ kind: answer | clarify | out_of_scope, text, topic_ids }`, 900 output tokens). The system prompt says the active lesson is the one being asked about **now** (attached from the Hub's delivery record; earlier conversation may be about other lessons, so don't ask which one), treats lesson text and the student's message as content, not instructions, and forbids deadlines, grades, policies, enrollment or progress claims. Questions about the course itself (homework, deadlines, late work, its messages) are **in scope**: answer from the attached message, or else from **the professor's recent posts to this student** (`postedTo`: up to 5, newest first, latest revision, only posts the Hub accepted a delivery for to that Hub-verified student — never another student's), otherwise say plainly the information isn't there. Dates in those posts count as given. **Code check:** any calendar date in the answer must appear in the lesson, the question or earlier questions; otherwise one repair attempt, then an honest refusal. Up to 4 earlier exchanges per conversation are sent.

## 3. MAKE COURSE AVAILABILITY EASY TO UNDERSTAND

Seed one clearly identified demo student enrolled in Marketing 101. Enrollment and publishing permissions must come from trusted application data, not the model’s interpretation of text.

When the professor successfully registers and becomes available to that student, show “Marketing 101 is now available” with an action to open the course or ask a question. Show this once per relevant availability/enrollment event, not on every heartbeat or refresh.

Distinguish a registered agent from one that is currently reachable. If the service is unavailable, show an honest unavailable or queued state rather than pretending it can answer.

Keep this simple. Do not build a full university enrollment system or real student records.

**Concrete specification**
- Hub configuration (trusted data): `courses: { 'mkt-101': { title: 'Marketing 101', professor: 'professor', enrolled: ['student-alex'] } }` and `studentEndpoints: { 'student-alex': 'http://127.0.0.1:4444' }` (`STUDENT_URL` overrides the first student's). Both are validated at startup (`ConfigError`).
- Notice: when the course's professor is `ready` and the enrolled student has a session, the Hub sends a signed `course_available` with **`noticeId = av-<courseId>`**, stable per course: a Professor restart is **not** a new announcement. The Hub records it as sent (persisted), and the Student stores it once by `noticeId` (persisted).
- Browser: a banner “**Marketing 101 is now available.**” with **Ask a question** (sets an “About: Marketing 101” chip so the next message asks for the `marketing` capability; the Hub still checks and routes it) and **Got it**. Either action marks the notice seen.
- Readiness stays the Part 7 registry status (`ready` only gets dispatches; otherwise `unavailable`). The Professor view shows whether the student's agent is online (has a session) and says lessons will queue if not.

## 4. ADD A PROFESSOR CHAT (NOT A FORM)

Provide an intuitive Professor view and Student view, using a clear view switch. Preserve the existing Conversation, Agent Activity, and Topology tabs.

**The Professor view is a real AI chat — the same experience as the student's, not a form being submitted.** The professor talks to students directly: a message is just sent — as the professor's own message, to the tagged student(s) (“@alex”, “@alex @sam”) or to the whole class when nobody is tagged — with no assistant reply in between. The system quietly decides whether it is a lesson or a message (any message to students, for example “Homework is late”) and gives it a title. **The course assistant acts only when the professor says “@assistant do x”**, for example “@assistant write a lesson about pricing and send it to everyone”, “@assistant send the evidence-before-assumptions lesson to the class” or “@assistant who has opened my last message?”; it asks one short question when something essential is unclear. Do not show lesson/message switches, recipient pickers or title fields.

Show “Marketing 101 — Professor”, the course, and the class (each enrolled student, visibly identified, with whether their Student agent is connected). The chat must work with new content, not just canned demonstrations; the professor can also ask for one of the course lessons by name.

Sending happens only when the professor sends a chat message (Enter or Send). Never send on typing, blur, autosave, or model suggestion. Blank messages do nothing, unsent text is kept on failure, and a repeated send never makes a second post.

Preserve the professor's original text: when the professor wrote the words for students, those exact words are sent. When the professor gave an instruction instead (“tell everyone the homework is late”), the text the system wrote is shown, clearly labelled as written from the instruction, and must not add facts, dates, rules or consequences.

Posts go to one enrolled student or to all students in the course, because a lesson is usually for everyone in the class. Do not add real email, SMS or operating-system push notifications.

**New conversation resets everyone's messages so the demo can start again:** the lessons and messages clear out for every student, and the professor sends them again.

**Concrete specification**
- **Direct posts (no @assistant):** the professor's words go out exactly as written (minus leading tags), to the tagged students (`audience` = their ids, comma-separated, each must be enrolled) or `all`; an unknown leading tag (“@zed”) sends nothing and says so; an `@` inside an email address is not a tag (a tag starts the message or follows a space). `classifyPost` (one small structured call; heuristic fallback, and a failure never blocks the post) only names it: `lesson` | `message` and a title. The post appears as the professor's own bubble (“You → Alex Student”, “You → the whole class (2)”) with its kind, title and each student's state — no assistant bubble.
- Tab **Professor view** at `/professor` (fourth tab). One chat panel shaped like the student's: header “Marketing 101 — Professor”, the course note, and the roster (“Alex Student”, “Sam Student” with a presence dot); the professor's messages on the right, the **Course assistant**'s replies on the left (labelled with the model in live mode), and, for **@assistant** requests only, the **Course assistant**'s reply with, if it sent something, a **post card**: Lesson/Message tag, title, “to the whole class (N)” or “to <name>”, the exact text sent, its origin (“Your words”, “Written from your instruction — read it before students do”, or “Course lesson, as written in the course pack”), and **one line per student** with its own state (Delivered, Opened, Queued at Hub with why, Being confirmed, Failed). Composer: Enter sends, Shift+Enter new line, **@-tag suggestions** from the roster by first name, with **@assistant** first (arrow keys, Enter/Tab to pick), the draft kept in `localStorage`. The chat opens on the newest message and follows the bottom like the student's (`followBottom`). Student toasts are not shown while the Professor view is visible.
- Browser → UI server `POST /api/professor/chat` `{ operationId, text }` and `GET /api/professor/state` → Hub `/dev/agents/professor/author/{chat,state}` → Professor `POST /author/chat`, `GET /author/state` (HTTP developer endpoints, like skill settings; not A2A). The state includes the chat (persisted in the outbox, last 200 entries).
- **With @assistant the model decides** (`interpretProfessor` in `src/professor-model.js`, one structured call, on the request without the @assistant tag): `action` post | answer | clarify, `reply`, and for a post `kind`, `audience` (`all` or a roster id), `title`, `content`, `content_is_verbatim`, `seed_id` (a course lesson). It gets the roster (names and tags), the course lessons, the class data (posts with per-student state, newest first) and the recent chat. Mock mode is a labelled heuristic (“(Mock mode — no model.)”: @tag → that student, “everyone/class” → all, a course-lesson title → that lesson, “him/her/them” → clarify, a status question → a summary).
- **Code checks every decision** before anything is sent (`checkPost` in `src/professor-agent.js`): tags the professor wrote win over the model's audience (one or several students; the reply says so); a single student must be tagged or named in the professor's words, otherwise a question (“Should this go to Sam only?”); a course lesson's text comes from the course pack, not the model; “verbatim” is believed only if the text really appears in the professor's words (otherwise labelled as written from the instruction); any date in the text that the professor didn't write → refused with a question; empty text → “What should it say?”. Then the post goes through the same `createPost` as the typed API.
- One chat message is worked on at a time (409 otherwise); a repeated send with the same `operationId` returns the stored outcome (one post, however often it is sent).
- Browser/typed API kept for tests and tools: `POST /author/lessons` `{ operationId, kind, title, text, audience }`.
- **Audience** (`kind`: `lesson` | `message`; `audience`: `all`, one student id, or several comma-separated ids — `AUDIENCE` in `src/lessons.js`, at most 50): for the whole class the Professor sends `audience: 'all'`, never a list; **the Hub expands it from its own enrollment** and creates one delivery per enrolled student (`deliveryIdFor(lessonId, revision, studentId)`), each queued, delivered, opened or failed on its own. Every named student must be enrolled. The publish signature covers `kind` and `audience`, and `contentHash(title, text, kind)` covers the kind, so a signed lesson can't be re-labelled as a message.
- Demo roster (Hub config `studentNames`): **Alex Student** (student-alex, the Student agent at :4444) and **Sam Student** (student-sam, enrolled, no Student agent), so a post to all shows one delivered and one honestly queued. Nobody can register as a student without a configured endpoint (it couldn't be challenged): `no_student_endpoint`; tests opt in with `HUB_TEST_STUDENTS_WITHOUT_ENDPOINT=1` (the harness sets it).
- Outbox (`PROFESSOR_OUTBOX_FILE`, default `data/professor-outbox.json`): posts (with `source`, `verbatim`, `seedId`), operations, chat, chat operations.
- **Classroom reset (New conversation):** `POST /api/conversation/new` first publishes `conversation_reset` (the screens clear), then:
  1. clears this Student's inbox (`inbox.reset()`: lessons, messages, notices, pending receipts; `inbox_reset`);
  2. calls the Hub's developer endpoint `POST /dev/classroom/reset`, which clears its lessons, operations, deliveries and notices for **every** student (`classroom_reset`), asks each course's professor to clear its posts and chat (`POST /author/reset` on the configured peer URL; `lessons_reset`; an unsent draft in the browser stays), and announces the course again once;
  3. publishes `classroom_reset` from the UI with the outcome `reset | hub_unreachable | hub_error | professor_unreachable`. A clean reset shows nothing in the chat (your request: “remove this, there is no reason for it”); only a partial reset is explained there.

  Student sessions stay. A delivery in flight during a reset is dropped (the Hub checks the record still exists before writing). The browser closes an open lesson, removes toasts and the chip, and refreshes the inbox and the Professor view. New conversation is shown whenever the inbox has anything in it.

## 5. IMPLEMENT TRUE REVERSE AGENT COMMUNICATION

The Professor initiates a new A2A interaction with the Hub. The Hub verifies the professor’s publishing permission, course, and student enrollment, then delivers through the registered Student agent’s inbound endpoint.

Use a typed, server-validated application operation for publishing a lesson. Include stable lesson, revision, recipient, and delivery identities, plus the original text and server timestamp. These are application conventions carried through the supported A2A mechanism, not invented standard protocol fields.

Resolve identities and endpoints server-side. Agent Cards describe capabilities; they do not prove identity or permission. Preserve existing enabled-skill checks and clearly label the limits of local demo authentication.

Keep separate message/task identities for each hop, with a correlation mapping for the overall delivery.

Important: A2A task-status push notifications are not the same as initiating a new lesson. Use the installed compatible protocol’s normal interaction mechanism for the new delivery. Do not fabricate a task-progress callback for a task that never existed.

Reference the official specification while respecting the repository’s installed version:
https://a2a-protocol.org/v1.0.1/specification/

Do not automatically upgrade the SDK or protocol just because newer documentation exists.

**Concrete specification**
- Mechanism: an ordinary `message/send` with one **typed data part** (`src/a2a-data.js` `sendData`), answered with a typed data part. Media types (`src/lessons.js`): `application/vnd.a2a-spike.lesson-publish+json`, `…lesson-status+json`, `…lesson-receipt+json`, `…student-session+json` (to the Hub; handled before any student check, like Part 7's control messages) and `…lesson-delivery+json`, `…lesson-query+json`, `…course-available+json`, `…session-challenge+json` (to the Student).
- **Signatures** (`sign`/`verify`: HMAC-SHA256, base64url, over fields joined with `|`, timing-safe compare):
  - Professor → Hub publish: `sign(callKey, [professorId, instanceId, 'publish', operationId, lessonId, revision, courseId, recipient, contentHash])`, with the key the Professor gave at registration (`hubLink.sendSigned`, 15 s timeout).
  - Student session: the Student sends `{ studentId, instanceId, endpoint, callKey }`; the Hub accepts only an allowlisted student, only `endpoint` **equal to the configured one**, and only after a **challenge** sent to that configured endpoint is answered with `sign(callKey, ['session', studentId, instanceId, nonce])`. This prevents another local process from registering as the student first. A student with no configured endpoint may register without a challenge (used by tests only).
  - Student → Hub requests: `metadata.studentSignature = sign(key, [studentId, contextId, messageId])`. A signed request names its own `contextId` (`askTutor` generates one), because a server-assigned one couldn't be signed. The Hub refuses unsigned or wrongly signed requests with a plain message.
  - Hub → Student: delivery `['delivery', studentId, deliveryId, lessonId, revision, contentHash]`, query `['query', studentId, deliveryId]`, notice `['notice', studentId, noticeId]`. The Student also checks `contentHash` against the title and text.
  - Receipt: `['receipt', deliveryId, 'opened']` with the Student's key.
- IDs: `lessonId` `ls-…` (the Professor's), `revision` 1, 2… (immutable: the same lesson and revision with other content → `revision_conflict`), `deliveryId = 'dl-' + sha256(lessonId#revision#studentId)[0..16]`, `inboxId` `in-…` (the Student's), and the Professor's `operationId`. Each hop has its own A2A message ID and context. The Hub's delivery record is the correlation mapping.
- The Hub's checks, in order: registered professor instance with a valid signature (`unknown_professor` / `bad_signature`) → well-formed ids → course exists (`unknown_course`) → the professor teaches it (`not_course_professor`) → recipient enrolled (`recipient_not_enrolled`) → content valid → operation dedupe (`operation_reused`) → revision immutability. The Hub store is `HUB_LESSON_FILE` (default `data/hub-lessons.json`). Student sessions are in memory only (a Hub restart means the Student registers again, which it does when the Hub's feed reconnects).
- Limits, said plainly in the README: keys are per-process, in memory, exchanged over localhost HTTP at registration. This stops casual spoofing by other local processes, not a determined local attacker, and is not production security.

## 6. MAKE THE STUDENT EXPERIENCE FEEL NATURAL

A new lesson should create:
- A persistent inbox item under Marketing 101.
- An unread badge.
- A small, accessible notification: “New Marketing 101 lesson.”
- A “View lesson” action that opens that exact lesson.

Show the course, professor, time, title, and original message. Offer clear actions such as “Start lesson,” “Ask about this lesson,” and “Save for later.” Suggested questions must never auto-send.

Do not steal keyboard focus, replace an unfinished form, erase a conversation, or interrupt a student who is working with another agent. Make the layout usable on smaller screens and by keyboard, with readable states and restrained animation.

Opening the lesson should preserve its course and professor context. “Ask about this lesson” must route through the Hub to the correct professor using the trusted lesson association, rather than guessing from keywords. Use a new task when appropriate rather than reopening a completed delivery task.

The professor can explain, ask a check-for-understanding question, or use supported catalog-based A2UI when helpful. Do not force every lesson or question into a form.

**Concrete specification**
- Student inbox: `STUDENT_INBOX_FILE` (default `data/student-inbox.json`), `{ lessons (by deliveryId), notices, pendingReceipts }`. APIs: `GET /api/inbox` (`lessons`, `notices`, `unread`, `session`), `POST /api/inbox/:deliveryId/open`, `POST /api/inbox/:deliveryId/save`, `POST /api/notices/:noticeId/seen`.
- Inbox items show **Lesson** or **Message** and “to the whole class” for posts to all; a message's toast reads “New message from <professor>” with **View message**, and its view has no Start lesson and offers **Ask about this message**. The Professor's prompt treats a message as its own announcement: answer only from what it says, in the first person, never “ask your professor”, never mention internal labels.
- The chat's message box has **no default text** (only its placeholder), so “Ask about this lesson” leaves an empty, focused box.
- Browser (`public/classroom.js`): an **Inbox** button with an unread count in the chat header (and a dot on the Conversation tab), a collapsible inbox with bookmark markers (New / Opened, “saved for later”), a **toast** (top-right, `role=status`, never focused, leaves after 15 s unless hovered or focused; only for live events, never replayed history) with **View lesson** and **Dismiss**, and a lesson `<dialog>` (course · professor · posted time, title, original text as `textContent`) with **Start lesson** (sends “I’m starting the lesson “…”.” with the lesson reference), **Ask about this lesson** (closes, sets the chip “About: <title>”, focuses the composer), **Save for later** and **Close**.
- “Opened” is sent only from `POST …/open` (opening the lesson). Toasts, deliveries and Save never mark it.
- Follow-ups: while the chip is set, every message carries `lessonDeliveryId`. The UI server checks it exists in the inbox and skips the Student planner. The Hub resolves it with its **own delivery record** for that student (`lessonRoute`) → `decidedBy: 'lesson'` (reason names the lesson **id**, never its title, because it travels in telemetry; the browser labels it “(lesson you received)”), destination the lesson's professor, and passes `lessonId`/`lessonRevision` downstream with the signed student. The Professor uses the lesson only if its outbox shows it was posted to that student. A delivery id from another student is refused (`lesson_route_rejected`). The chip clears on New conversation or ×.
- The Professor answers in text (no forms in this step).

## 7. MAKE DELIVERY RELIABLE AND HONEST

Reuse existing persistence where possible to maintain an outbox and Student inbox.

Show distinct states:
- Draft.
- Queued at Hub.
- Delivered to Student inbox.
- Opened in Student UI.
- Failed or delivery uncertain, with an explanation.

“Delivered” requires a committed Student inbox entry. “Opened” requires an actual user interaction. Neither means the student understood or completed the lesson. An accepted A2A request alone is not proof of delivery.

Use stable operation IDs and persisted deduplication. A double-click, reconnect, replay, or repeated request must not create duplicate lessons. Reusing an ID with different content should fail clearly. Do not assume A2A guarantees exactly-once delivery.

If the student’s browser is closed but the backend receives the lesson, retain it for the next visit. If the Student service is offline, keep delivery queued and do not mark it delivered. Reconcile uncertain outcomes before attempting delivery again.

Keep original lessons and revisions distinguishable. Replayed telemetry must never republish content.

**Concrete specification**
- Persistence: `src/json-store.js` (`createJsonStore(file, initial)` → `get`, `update(fn)`; atomic temp file + rename), used by the Hub (`HUB_LESSON_FILE`), the Student inbox and the Professor outbox. All under the git-ignored `data/`.
- The Student writes the inbox entry to disk **before** replying `{ status: 'delivered', inboxId }`. Only that reply marks the delivery delivered.
- Delivery outcomes at the Hub: Student not connected or connection refused → **queued** (`student_offline` / the error); timeout or connection lost mid-request → **uncertain**; refused by the Student → **failed** with its reason. A pump (`HUB_DELIVER_RETRY_MS`, default 3000) retries queued and uncertain deliveries. Registration of the student flushes immediately. An **uncertain** delivery is first **queried** (`lesson_query`): if the Student has it, it is marked delivered with nothing re-sent (`lesson_reconciled found: true`); otherwise it is sent again. The Student also answers a repeated delivery with its existing entry (no second entry).
- Publish ack to the Professor: `{ status: delivered | queued | uncertain | failed | rejected, reason, lessonId, revision, deliveryId }`. A `deliveryId` means the Hub **accepted** the lesson (`hubAccepted`, `ack.accepted`); from then on delivery to the student is the Hub's job, and the Professor view says “Posted — …” (queued, delivered, “the Hub is confirming delivery”, or refused by the student's agent). Only when the Professor→Hub leg itself got no answer (no `deliveryId`) does it show “Not confirmed by the Hub”, keep the draft, and re-send with the **same operation id** the next time its state is read (the Hub dedupes).
- An endpoint that **refuses the connection** marks the Student's session `unreachable` at the Hub. The roster shows the student offline, and the Hub stops attempting until the Student registers again (registration delivers immediately). This avoids a request against a dead endpoint every few seconds and a false “online”.
- Professor view chips: Sending… · Queued at Hub (explained) · Delivered · Opened by the student · Delivery uncertain — the Hub is checking with the student · Failed · Refused by the Hub (reason) · Not confirmed by the Hub — will retry. The draft is the text box itself.
- Receipts: “opened” is queued in the inbox (`pendingReceipts`) and sent when the session is up. The Hub records `openedAt` once.

## 8. KEEP THE CONTENT AND ROUTING SAFE

Professor text is lesson content, not authority to change settings, run tools, reveal private data, enroll people, or contact arbitrary recipients. Treat instructions embedded in lessons as untrusted input.

Only allowed publishing actions and enrolled recipients may be used. Reject forged professor identities, unauthorized courses, and recipient or endpoint substitutions on the server.

Use fictional data. Keep credentials server-side and out of browser payloads, logs, and the activity inspector. Do not claim this learning spike provides production university security.

**Concrete specification**
- Lesson text is stored and shown verbatim as text. The only thing it can cause is being read: the Student endpoint has no action for it, the follow-up goes to its professor as a question, and the Professor's prompt marks it as content.
- Endpoints come from Hub configuration only; the Student's claimed endpoint must equal the configured one.
- Keys never appear in logs, events, snapshots, cards or the browser (the topology snapshot lists only which students have a session).
- Telemetry: the Hub's redaction allowlist adds `lessonId`, `deliveryId`, `inboxId`, `noticeId`, `courseId`, `attempt`, `found`. Lesson titles and text never leave the Hub's feed unless `HUB_TELEMETRY_SHOW_CONTENT=1`. The Student's own events (in its own UI) include the title.
- Generated UI inspector (decision above): by default `structureOnly` keeps component types, ids, children, bindings (`path`), action names and contexts, `min`/`max` and flags, and masks every other string as `[N chars redacted]`. Validation results and backend loan facts stay.

## 9. SHOW THE FLOW AND TEST THE DEMONSTRATION

Extend the topology with the Marketing 101 Professor connected only to the Hub. Show real events for Professor → Hub → Student, then Student → Hub → Professor when the student responds. Do not animate successful delivery without real evidence.

Add tests demonstrating:
- A marketing question reaches the professor through the Hub.
- A new professor-written lesson arrives while the student is idle and has never initiated a conversation.
- Course availability appears without repeated notifications.
- The notification opens the correct lesson and follow-up questions preserve its context.
- Wrong professor, course, or unenrolled recipient is rejected.
- Double-clicks, restarts, reconnects, and event replay produce one delivery.
- Offline Student service queues correctly; offline browser receives persisted lessons on return.
- A lost acknowledgment is reconciled without duplicate delivery.
- A toast does not falsely mark a lesson opened or completed.
- Malicious lesson text cannot trigger unrelated actions.
- Earlier Tutor, Library, reservation, renewal-form, and Hub features still work.

Finish with an easy walkthrough: make the course available, ask a marketing question, write a new lesson in Professor view, post it, switch to the idle Student view, open the notification, and ask a follow-up. This is a demonstration sequence, not hardcoded conversational logic.

Explain the changed files and how the reverse route works. Show real test results and browser/network evidence where available. Label mocked tests honestly. Live checks run without a budget step (standing rule); report calls, tokens and cost afterwards.

Do not change the course agenda or presentation as part of this implementation.

**Concrete specification**
- Topology (`public/topology.js`): Professor node (x 770, y 330) between Tutor (y 110) and Library (y 550), its own model box, edge `hub-professor`, viewBox `0 0 1100 660`, colour `--professor` (berry `#a3315a` / dark `#f08aae`), and a **bookmark** pulse shape for the `lesson` category (in the legend as “Lesson or course notice”). `src/topology.js` labels every lesson event on a real edge (`hub-professor` or `student-hub`), never Professor↔Student.
- Agent activity: a fifth console for the Professor (with ⚙ skills) and lesson lines in the Hub and Student consoles.
- Tests: `test/professor.test.js` (16 tests, mock Professor and mock router, labelled; the @assistant checks use scripted model output through the fake Messages API — plumbing, not judgment), plus the harness: `startStack({ professor: true })` pre-picks the UI and Professor ports so the Hub config can name the Student endpoint, gives every process temp data files, and waits for the Student session. `signedStudent(hubUrl, studentId)` gives a test its own signed session (students without a configured endpoint). The lost acknowledgment uses the test-only `STUDENT_TEST_DELAY_FIRST_DELIVERY_ACK_MS` with `HUB_DELIVER_TIMEOUT_MS=400`.

---

## Avoid these known problems (found while building this step)

- **Signing breaks direct test calls.** Eight existing tests called the Hub directly as `student-alex`; once requests must be signed, give tests their own signed student (`signedStudent`) instead of sharing the UI's identity. A second UI for the same student is now correctly refused (its endpoint isn't the configured one), so a test that needs a differently configured UI starts its own stack.
- **A server-assigned contextId can't be signed.** `askTutor` sent `contextId: ''` and the server filled it in after signing. A signed request must choose its own context id.
- **Pass new options all the way down.** `signer` was added to `askTutor`'s options but not passed to the inner `exchange()`, which threw “signer is not defined” (every chat failed).
- **A notice id that includes a process instance repeats on every restart.** Use a stable id per course (`av-mkt-101`).
- **The UI server drops run-less specialist events it doesn't know.** Add the Professor's `lesson_posted` / `lesson_publish_result` to `CONFIG_EVENTS`, or the browser never sees them.
- **A process killed by a signal has `exitCode === null`.** Check `signalCode` too before waiting for `exit`, or a second stop waits forever (a 60 s hang in the offline test).
- **When the Student UI is down, so is the Professor view** (it's served by the same UI server). Tests of the offline case post to the Professor's own API.
- **`dataset` can't be assigned.** `Object.assign(el, { dataset })` throws in module code; assign into `el.dataset` instead. (The posted list stayed empty in the browser.)
- **A `display` rule overrides `hidden`.** Add `[hidden] { display: none }` for every new element styled with `display`. (The Lessons button showed with an empty inbox.)
- **Don't put toasts where the composer is.** Bottom-right covered the Send button; they go top-right.
- **“Tutoring and Library services and Marketing 101”.** Join capability names with `Intl.ListFormat`.
- **Waiting on `state === 'completed'` in browser checks can match the previous run.** Wait for the new message count as well.
- **Don't put the lesson title in the Hub's routing reason.** `route_decided.reason` passes the telemetry allowlist, so “A question about the lesson “<title>”” leaked titles to the browser feed (found in the e2e). Name the lesson by id.
- **Tell the model which lesson is current.** With an earlier lesson in the same conversation, the live Professor asked “which lesson do you mean?” instead of answering about the attached one (found in the e2e).
- **“Accepted by the Hub” is not “delivered”, and an uncertain *delivery* is not an uncertain *post*.** The first Professor view told the professor to press Post again when the Hub had the lesson and was reconciling with the Student (found by reading the code during the e2e). Record `hubAccepted` and word the states separately.
- **A session isn't presence.** After the Student stopped, the Hub still listed it as online and retried the dead endpoint every 3 s (11 attempts in the e2e). Mark the session unreachable on a refused connection.
- **Show the Draft state.** The prompt lists it; the first version had no visible draft indicator.
- **Waiting in a browser script:** Playwright's `run-code` body runs in Node, so `document` or `crypto` there fail; use `page.evaluate` for page code and plain values (`Date.now()`) for ids.
- **Never take a recipient list from the professor for “all”.** The Hub resolves the class from its own enrollment; otherwise a post could reach anyone the sender names.
- **A student with no endpoint can't be challenged**, so in normal runs nobody may register as them (the earlier “allowed, for tests” path would let any local process collect Sam's messages).
- **The model echoed prompt labels** (“The active message says…”) and told the student to “ask your professor” — it is the professor. Tell it to speak in the first person and never name internal labels.
- **Clear the screen before the reset, not after.** The first version published `conversation_reset` after the Hub and Professor had reset, so the page's screen-clear erased their own “reset” lines from the consoles (found in the e2e). Publish `conversation_reset` first and the result as a separate `classroom_reset`.
- **Don't leave a test course behind.** An e2e run that started the Hub with a made-up course taught by the Tutor really announced “Calculus is now available — new lessons from Tutor Agent” to the demo student, and it stayed in the persisted inbox. Use a separate data file for such runs, or reset afterwards.
- **Guard every state-changing developer route against cross-site requests.** The Hub's `/dev` router (classroom reset, professor chat and posts, skill saves, card refresh) and the Professor's `/author` POSTs had only the Host check, so any web page open in the browser could fire a simple POST at `127.0.0.1` and reset the classroom or post as the professor (automated security review). Apply `sameOriginGuard` to every non-GET route there; the legitimate callers are servers and send no Origin header (test: cross-site requests get 403 and nothing changes).
- **A reset can race a professor chat turn.** A message being worked on during a reset lost the professor's own line while its reply and post survived. Count resets and put the professor's message back above its reply when one happened mid-turn.
- **Never run destructive checks against the app the user is using.** A verification run pressed New conversation on the live demo while the user was posting in the Professor chat, wiping their posts. Use a separate test stack (ports and data files) for checks that reset or delete.
- **Don't put an assistant between the professor and the class.** The first chat answered every message with “Sending … to …” plus a separate card — a double message (your feedback). A plain message is the professor speaking: send it and show its delivery on the professor's own bubble; the assistant speaks only when addressed with @assistant.
- **An email address is not a tag.** “…email alex@example.com…” was refused as “no @example in Marketing 101” (found in the e2e). A tag starts the message or follows whitespace.
- **Report “queued” once.** The Hub emitted “Lesson queued — Student agent offline” for every waiting delivery on every 3-second retry cycle, flooding the consoles, topology and history (found in the e2e). Emit it when a delivery starts waiting.
- **Don't give the model a label it can repeat.** “The active message says …” kept appearing until the data block itself was named the way the professor speaks (“your message to this student”).
- **Don't build the professor's side as a form.** The first Professor view had Lesson/Message switches, a recipient picker, a title field and a text box — an “old form-based system” (your feedback). The professor chats; the model decides kind, audience and title, and code checks it.
- **Tag suggestions must match first names.** Every student id starts with “student-” and both demo surnames are “Student”, so “@s” suggested both students and Enter picked Alex (found in the live e2e).
- **Label where a post's words came from.** A course lesson sent from the chat was first labelled “Your words”.
- **Don't show the student's toasts in the professor's view** (same browser, different role).
- **A course question isn't a library question because it says “return” or “late”.** “Can I return my homework late for marketing class” matched Tutoring (homework), Library (return) and Marketing 101 (marketing); the Student's model then asked “a library book, or a marketing class question?” although the student had named the class (your report). Its prompt only described tutoring and library, and the Professor advertised only subject topics, so with the Student's model off the Hub's router named a skill that doesn't exist and refused. Tell the Student's model and the Hub's router that a question about a named course (homework, assignments, deadlines, its messages) goes to that course, and that naming the course settles it; say so in the course's public description; give the Professor a real skill for course questions; and let the Professor answer them honestly instead of calling them out of scope.
- **The Professor must know what it told this student.** Asked from the chat (not through “Ask about this message”), it said it had no late-work rule although it had posted “Homework is late” to the class. Give it its own recent posts to that student.
- **Don't let agent names reach the student's chat.** The live router asked “Calculus (Tutor Agent) or Marketing 101 (Marketing 101 Professor)?”. Give the router each service's public name, tell it to use that, and replace any agent name in the reason or clarifying question in code (`publicWords` in `src/router.js`; ordinary words such as “library” are left alone).
- **Fetch the WSU book with a browser user agent.** The site returns 403 to plain fetchers; check every chapter URL exists before citing it.

## Enhancements merged into this step

- **Decisions asked before building (your answers):** a new Professor tab in the same app; per-process keys for the Professor and the Student; inspector structure only by default. These settle Step 8's two open decisions.
- **Standing rules applied:** no budget step for live checks (the prompt asked for one; your standing rule overrides it), hand over in live mode, ask before removing or changing what works.
- **Session challenge** (security, my addition): accepting the Student's key at registration on trust would let any local process register first. The Hub instead proves the registrant serves the configured endpoint.
- **Availability notice action:** “Ask a question” sets a Marketing 101 chip that asks for the course's public capability (added after re-reading the prompt's “action to open the course or ask a question”).
- **Capability list wording** (“Tutoring, Library services, and Marketing 101”) when the Student declines a request.
- **Full e2e with playwright-cli, live (your request after the first write-up),** every agent run as its own process so it could be stopped and restarted. 14 scenarios:
  1. the notice once across reloads;
  2. marketing questions (router, the notice's “Ask a question”, grades/exam dates not invented, an off-topic decline);
  3. the Professor view (keyboard, roster, blank post blocked, course lesson fills the draft, double-click → one lesson, a blocked post keeps the draft through a reload and retries with the same operation id);
  4. an idle student with an open tutoring form and a half-typed message (toast, focus, form and text untouched, unread +1, not opened, no title in Hub telemetry);
  5. opening, Escape, Start lesson, follow-ups including a calculus-sounding one, Save;
  6. hostile lesson text (rendered as text, nothing triggered, one run, no Tutor/Library/form/loan traffic);
  7. Hub and Professor restarts (everything persisted, sessions re-registered, no repeat notice);
  8. the fixes re-checked;
  9. the Student offline → queued (offline, no retry noise) → delivered on return, with the reconnecting browser showing it;
  10. a lost acknowledgment (uncertain → reconciled → Delivered, 1 attempt, 1 copy);
  11. tampered posts and forgeries refused;
  12. topology (Professor only on the Hub, bookmark pulses), consoles and the Professor's ⚙;
  13. regressions with signed requests (tutoring form TR receipt, room booking BK receipt, generated loan renewal RN receipt, inspector structure-only);
  14. Tutor and Library answers and phone width + dark mode with the toast and dialog.

  No JavaScript errors; console errors were only the deliberate outages and refusals. Fixes from it are listed under “Avoid these known problems”. The scenario scripts live in the session scratchpad, not the repo.
- **Lessons or messages, to one student or all** (your request after the e2e: “this should not be just about a lesson it should be any message to the student and an option to send to all students since a lesson will be for everyone in the class”): kind + audience on the post, Hub-side expansion to one delivery per enrolled student, per-student states in the Professor view, a second fictional student (Sam, enrolled, no agent), message wording in the Student view, and the endpoint-less registration gate. Tests: a message to all (Alex delivered, Sam queued, follow-up as a message, unknown kind and unenrolled audience refused) and the registration gate. Live e2e: “Homework is late” to all → 1 delivered, 1 queued; Alex opened it and asked; the Professor view showed Alex Opened, Sam Queued; a lesson to Alex only; a second message's toast and a first-person reply.
- **The Professor view is a chat** (your feedback: “It should just be a regular chat. It should be an identical student experience for the professor. … If they are going to send it to a specific person, maybe through a tagging mechanism. … this is an intelligent, smart system. It should not be like an old form-based system.”): the form was replaced by a chat; the Professor's model decides post / answer / clarify, kind, audience (@tags, names, “everyone”) and title; code checks recipients, verbatim claims and dates; post cards show exactly what was sent, its origin and each student's state; @-tag suggestions; display names in the Hub roster. Tests: the chat on the labelled mock (tags, everyone, a course lesson, a vague request, two tags, a status question, a repeated send) and on scripted live decisions (untagged recipient refused, invented date refused, a rewrite labelled, the professor's tag wins). Live e2e (Haiku 5.5): the homework change to the class in the professor's words (Alex delivered, Sam queued), “@alex please send me your positioning draft” to Alex only, a course lesson by name, “Tell him I liked his work” → a question, “Who has opened the homework message so far?” answered from the delivery data; Alex opened the tagged message and asked about it; the professor's chat then showed Opened.
- **Direct posts; the assistant only on @assistant** (your feedback: “why is there a double message if the professor is sending it should just send it there unless the professor says @assistant do x such as write a course about x and send it to everyone”), plus several tagged students per post; then a **full live e2e on a separate test stack** (ports 4300–4304, own data — the demo you were using was not touched), 7 batches: notice and student questions; the professor chat (class, @alex, @alex @sam, unknown tag, @-suggestions, Shift+Enter, @assistant writing, a course lesson, a vague request, a status question, a failed send kept and retried with the same operation id, a double Enter → one post); the idle student (toast, focus, open form and half-typed text kept, unread +1); opening, Start lesson, follow-ups, Save, Escape; hostile text; Student offline → queued (offline, 1 attempt) → delivered; a lost acknowledgment reconciled (1 attempt, 1 copy); Hub/Professor/UI restarts (everything persisted, 1 notice); 10 cross-site routes refused, forgeries and tampered posts refused; topology and consoles; the tutoring form (TR receipt), a room booking (BK receipt), a generated loan renewal (RN receipt) with the inspector structure-only; Tutor and Library answers; phone width + dark mode; the classroom reset. Fixes from it: email addresses as tags, the “queued” flood, the echoed label.
- **No default text in the message box** (your request: “when I click on ‘Ask about this lesson’ the default message on the text box that says Explain the derivative of x squared should clear up. Actually just clear that default message completely”): the composer starts empty with its placeholder (“Ask anything…”), so Ask about this lesson leaves an empty, focused box with the About chip.
- **New conversation resets the classroom** (your request: “the lessons should clear out for a student when I clear the conversation they should be resent by the teacher. Clear conversation resets everyones messages so we can start again”): Student inbox, Hub records for every student and the Professor's posted list; the notice comes back once; the professor sends again. Test added; checked live (3 items and a toast cleared, notice back, a message re-sent: 1 delivered, 1 queued).
- **No note after a clean reset** (your request: “remove this there is no reason for it”, about “New conversation — Every student's lessons and messages were cleared…” in the professor's chat): a clean reset leaves the chat empty; only a partial reset (Hub or Professor unreachable) still says what wasn't cleared, so it isn't mistaken for a full one. Checked on the separate test stack: inbox 3 → 0 items, chat 0 messages, no note.
- **The app runs on port 4444 by default, not 3000** (your request: “Make this application run on port 4444 permanently by default not 3000”): the UI server's default (`UI_PORT` still overrides it), the Hub's trusted Student endpoint (`studentEndpoints` in `src/config.js` and `config/hub.example.json` — it must equal the UI's address, or the session challenge fails), `npm run demo`'s banner, the chat-scroll browser check and the docs (Steps 7 and 9 give 4444 as the UI port). Tests are unaffected: they pick free ports.
- **Course questions reach the Professor** (your report: “the question needs to go to the professor and the suggestion from the student llm was to return a book something is not right”): the Student's planner and the Hub's router now route a question about a named course to that course, the Marketing 101 public description mentions homework, assignments and the professor's messages, the Professor advertises a ninth skill `course-questions`, and its answer prompt treats course questions as in scope (answered from its message, otherwise “I don't have that information”, never a guessed rule). Checked live on the separate test stack (ports 4300–4304; your demo untouched). With your Student agent's model on: “Can I return my homework late for marketing class” and “can i submit my marketing class homework late” → Marketing 101 → Professor. With the Student's model off, so the Hub's router decides alone: that question, “Can I hand in my marketing homework a day late?” and “When is the marketing assignment due?” → Professor. Unchanged: “Can I return my library book late?” and “When is my library book due?” → Library; calculus homework → Tutor; “Can you help with my homework?” → “Which course is the homework for?”; a kitchen-sink question declined.
- **The Professor answers from its own posts, and the Hub's questions use public names** (your go-ahead: “yes fix both”): without an attached message the Professor now sees its latest posts to the asking student; the router gets `publicName` and code rewrites agent names in student-facing words. Tests: a scripted live Professor answers from a class message and never sees a post to another student; `publicWords` rewrites “(Tutor Agent)” and leaves “the library” alone. Live on the test stack: after “Everyone, you can hand in this week's homework late, no penalty.”, “Can I hand in my marketing homework late?” → “Yes. In my message … no penalty”; “Can you help with my homework?” → “Which course is the homework for? … Marketing 101 or your calculus work with the Tutoring service?”.
- **Full suite:** 147 tests passing (after the course-question fixes); 145 (after direct posts, the cross-site guards and the e2e fixes); 144 after the professor chat; 142 after the reset; 141 after the messages/audience change; 139 before (129 earlier + 10 new; the offline and follow-up tests gained assertions for the e2e fixes). The Part 9 tests use the mock Professor and mock router and prove plumbing, safety and reliability, not the live model's judgment.
- **Live walkthrough in a browser (playwright-cli, all five agents on Haiku 5.5):** notice shown once → “In marketing, what is the difference between segmentation and targeting?” answered by the Professor (routed by the live Hub router) → lesson “Pricing tells a story” written and posted (Delivered) → a lesson posted while the student sat in the composer: toast shown, focus stayed in the composer, unread 2, nothing opened → View lesson from the toast → Ask about this lesson → “What would you measure first in that test, and why?” answered in the lesson's context (`decidedBy: lesson`), all nine timeline steps done → the Professor sees only that lesson as Opened → a blocked post kept the draft through a reload, then a retry plus a forced second click made one lesson → phone width and dark mode without horizontal scroll. About 3 model calls, ~16k input / 725 output tokens, roughly **$0.002**.
