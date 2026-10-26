# Step 9 — Marketing 101 classroom with professor-initiated lessons

> Final state: see `Steps/README.md`. This is your Part 9 prompt, in your wording and section order, with every decision and fix made while building it merged into the instructions. Running it after Steps 1–8 rebuilds the current app. **Concrete specification** blocks give the exact names, values and rules the current app uses, so a rebuild comes out identical. The closing sections list the problems to avoid and each change with why it was made.

PART 9: MARKETING 101 CLASSROOM WITH PROFESSOR-INITIATED LESSONS

Continue the existing application from Parts 1–8. Inspect the repository, running services, installed protocols, and existing UI first. Make an incremental addition, not a rewrite. Preserve the Tutor, Library, room reservations, generated renewal forms, Hub routing, and activity views. **Before removing or changing anything that already works and that this prompt doesn't cover, ask.**

The goal is to demonstrate that communication can begin on either side. A student can ask a professor for help, but a professor can also introduce a lesson while the student is idle, without waiting for the student to ask first.

**First settle the two open decisions left by Step 8** (asked at the start of this step; your answers):
- **Student → Hub identity: authenticate it with per-process keys.** Both the Professor (as a specialist, already) and the Student agent give the Hub a random key when they register. The Hub verifies the Professor's publishes, signs every delivery to the Student, and requires the Student's signature on every request it receives.
- **Generated UI inspector: structure only by default.** Full model text is relayed only with `HUB_TELEMETRY_SHOW_CONTENT=1`.
- **Professor view:** a new fourth tab in the same app (`/professor`), proxied server-side through the Hub to the Professor agent's authoring API.

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
- The Student agent's inbound side lives in the UI server (same port, 3000): `/.well-known/agent-card.json` (“Student Agent”, one skill `receive-course-lessons`) and `/a2a/jsonrpc`. Its executor accepts only typed data parts from the Hub (below); anything else is answered `rejected`.
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
- `src/course-pack.js`: `COURSE` (`courseId: 'mkt-101'`, `title: 'Marketing 101'`, a `note` saying it's fictional and not an official CSUF course), eight `TOPICS` (one per bullet above), each with an original explanation, a fictional example and **real chapter URLs** on wsu.pressbooks.pub (checked to exist; the book is CC BY-NC-SA, so nothing is copied), `SEED_LESSONS` (the three lessons with title, objective, explanation, example, check), and `PROFESSOR_DEFAULT_SKILLS`: one `answer` skill per topic whose `knowledge` is that topic's text plus its sources (editable with ⚙ like the other agents).
- `src/professor-model.js`, `PROFESSOR_MODE` read at import: **mock** (default; labelled “(Mock mode — no model.)”: the best-matching topic's explanation and example, and the lesson's check question for lesson questions) or **live** (the Professor's configured model, structured output `{ kind: answer | clarify | out_of_scope, text, topic_ids }`, 900 output tokens). The system prompt says the active lesson is the one being asked about **now** (attached from the Hub's delivery record; earlier conversation may be about other lessons, so don't ask which one), treats lesson text and the student's message as content, not instructions, and forbids deadlines, grades, policies, enrollment or progress claims. **Code check:** any calendar date in the answer must appear in the lesson, the question or earlier questions; otherwise one repair attempt, then an honest refusal. Up to 4 earlier exchanges per conversation are sent.

## 3. MAKE COURSE AVAILABILITY EASY TO UNDERSTAND

Seed one clearly identified demo student enrolled in Marketing 101. Enrollment and publishing permissions must come from trusted application data, not the model’s interpretation of text.

When the professor successfully registers and becomes available to that student, show “Marketing 101 is now available” with an action to open the course or ask a question. Show this once per relevant availability/enrollment event, not on every heartbeat or refresh.

Distinguish a registered agent from one that is currently reachable. If the service is unavailable, show an honest unavailable or queued state rather than pretending it can answer.

Keep this simple. Do not build a full university enrollment system or real student records.

**Concrete specification**
- Hub configuration (trusted data): `courses: { 'mkt-101': { title: 'Marketing 101', professor: 'professor', enrolled: ['student-alex'] } }` and `studentEndpoints: { 'student-alex': 'http://127.0.0.1:3000' }` (`STUDENT_URL` overrides the first student's). Both are validated at startup (`ConfigError`).
- Notice: when the course's professor is `ready` and the enrolled student has a session, the Hub sends a signed `course_available` with **`noticeId = av-<courseId>`**, stable per course: a Professor restart is **not** a new announcement. The Hub records it as sent (persisted), and the Student stores it once by `noticeId` (persisted).
- Browser: a banner “**Marketing 101 is now available.**” with **Ask a question** (sets an “About: Marketing 101” chip so the next message asks for the `marketing` capability; the Hub still checks and routes it) and **Got it**. Either action marks the notice seen.
- Readiness stays the Part 7 registry status (`ready` only gets dispatches; otherwise `unavailable`). The Professor view shows whether the student's agent is online (has a session) and says lessons will queue if not.

## 4. ADD A SIMPLE PROFESSOR PUBLISHING EXPERIENCE

Provide an intuitive Professor view and Student view, using panels or a clear view switch. Preserve the existing Conversation, Agent Activity, and Topology tabs.

In Professor view, show:
- “Marketing 101 — Professor.”
- The course and selected enrolled student, visibly identified.
- An optional lesson title.
- A text box labeled “What would you like your student to learn?”
- A clear “Post lesson” button.
- A compact delivery status for the posted lesson.

The professor can write new lesson content or select a seeded lesson to populate the draft. The text box is essential: this must work with new content, not just canned demonstrations.

Posting happens only when the user presses the button. Never send on typing, blur, autosave, or model suggestion. Disable blank submissions, preserve drafts on failure, and prevent accidental duplicate posts.

Preserve the professor’s original text. A model-generated preview or suggested questions must be clearly separate and must not silently change the lesson’s meaning.

For this spike, publish only to the explicitly selected enrolled demo student. Do not add real email, SMS, operating-system push notifications, or whole-class broadcasts.

**Concrete specification**
- Tab **Professor view** at `/professor` (fourth tab; the other three keep their addresses). Left panel “Marketing 101 — Professor” with the course note, a Student select (roster from the Hub's trusted data) with online/offline, Title (optional, max 120), the labelled text box (max 4000), “Start from a course lesson:” buttons that fill the draft from a seed, **Post lesson** and a status line. Right panel “Posted lessons” with a delivery chip per lesson.
- Browser → UI server `GET /api/professor/state`, `POST /api/professor/lessons` → Hub `/dev/agents/professor/author/...` → Professor `GET /author/state`, `POST /author/lessons` (HTTP developer endpoints, like skill settings; not A2A).
- No model preview or suggestions are generated (none needed), so the text is posted exactly as typed (trimmed).
- **Draft** state: while the title or text box holds unposted text, the status line reads “Draft — not posted yet.” (also after a reload restores the draft). Typing never posts.
- Duplicates: each press uses an **operation id**; a retry of the same content after a failure **reuses it** (kept in `localStorage` with the draft), and the button is disabled while posting. The Professor's outbox (`PROFESSOR_OUTBOX_FILE`, default `data/professor-outbox.json`) dedupes by operation id: same content returns the same lesson (`duplicate: true`), different content gets 409.
- Draft: saved in `localStorage` on input (wrapped in try/catch), kept on any failure, cleared only after the Hub accepted the post (delivered or queued).

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
- Browser (`public/classroom.js`): a **Lessons** button with an unread count in the chat header (and a dot on the Conversation tab), a collapsible inbox with bookmark markers (New / Opened, “saved for later”), a **toast** (top-right, `role=status`, never focused, leaves after 15 s unless hovered or focused; only for live events, never replayed history) with **View lesson** and **Dismiss**, and a lesson `<dialog>` (course · professor · posted time, title, original text as `textContent`) with **Start lesson** (sends “I’m starting the lesson “…”.” with the lesson reference), **Ask about this lesson** (closes, sets the chip “About: <title>”, focuses the composer), **Save for later** and **Close**.
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
- Tests: `test/professor.test.js` (10 tests, mock Professor and mock router, labelled), plus the harness: `startStack({ professor: true })` pre-picks the UI and Professor ports so the Hub config can name the Student endpoint, gives every process temp data files, and waits for the Student session. `signedStudent(hubUrl, studentId)` gives a test its own signed session (students without a configured endpoint). The lost acknowledgment uses the test-only `STUDENT_TEST_DELAY_FIRST_DELIVERY_ACK_MS` with `HUB_DELIVER_TIMEOUT_MS=400`.

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
- **Full suite:** 139 tests passing (129 earlier + 10 new; the offline and follow-up tests gained assertions for the e2e fixes). The Part 9 tests use the mock Professor and mock router and prove plumbing, safety and reliability, not the live model's judgment.
- **Live walkthrough in a browser (playwright-cli, all five agents on Haiku 5.5):** notice shown once → “In marketing, what is the difference between segmentation and targeting?” answered by the Professor (routed by the live Hub router) → lesson “Pricing tells a story” written and posted (Delivered) → a lesson posted while the student sat in the composer: toast shown, focus stayed in the composer, unread 2, nothing opened → View lesson from the toast → Ask about this lesson → “What would you measure first in that test, and why?” answered in the lesson's context (`decidedBy: lesson`), all nine timeline steps done → the Professor sees only that lesson as Opened → a blocked post kept the draft through a reload, then a retry plus a forced second click made one lesson → phone width and dark mode without horizontal scroll. About 3 model calls, ~16k input / 725 output tokens, roughly **$0.002**.
