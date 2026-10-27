# Step 9c — Professor chat, messages with replies, `@assistant`, meeting times

Time: about 60 minutes. Cost: free (tests use mocks and a scripted fake model). Optional live check: PAID, a few cents.

## What you'll see when it works

- A fourth tab, **Professor view** (`/professor`), is a real chat, not a form. "@alex your homework is late" goes straight to Alex. With no tag it goes to the whole class: Alex Delivered, Sam Queued at Hub.
- The message appears in Alex's chat as a bubble with **↩ Reply**. Alex's reply goes to the professor in person. The professor answers Alex alone with **↩ Reply**.
- "@assistant write a lesson about pricing and send it to everyone" → the course assistant writes and sends it, after code checks.
- "@assistant schedule a meeting with Alex" → it asks for times → "Tuesday 2pm or Wednesday 10:30am" → Alex gets two time buttons → a click books one.

## Starting point

Step 9b is done: lessons travel Professor → Hub → Student, the inbox works, and Student requests are signed. Start from the committed code of Step 9b.

## Instructions for Claude (lead)

Work in the three phases from Step 0. Write the Phase 1 contracts yourself. Then start **all three tasks in ONE message** with the Agent tool (models as in the table). Give each subagent this file, `00-setup-and-contracts.md` and its task row. Then join, run "Done when", append the CLAUDE.md notes and commit.

## Phase 1 — Contracts (lead writes these first)

1. **Chat API** (Professor, proxied by the Hub and the UI server):
   - `POST /author/chat { operationId, text, replyTo? }` → 200 `{ action: 'post'|'answer'|'clarify'|'error', reply, post: { key } | null, check, model, kind }`.
   - 400: malformed `operationId`, blank text, text over 4000 chars, or `replyTo` not enrolled ("That student isn't in this class.").
   - 409 while another chat message is being worked on. A repeated `operationId` returns the stored outcome with `duplicate: true`.
2. **Outbox** gains `chat: []`, `chatOps: {}`, `meetings: {}`, `pendingMeeting: null`. Keep the last 200 chat entries. Entry shapes:
   - professor: `{ id: '<op>:p', role: 'professor', text, at, toAssistant, replyTo?, postKey?, problem? }`;
   - assistant: `{ id: '<op>:a', role: 'assistant', text, at, action, postKey, model }`;
   - a student's reply: `{ id: '<messageId>:s', role: 'student', at, studentId, text, about, relayed }`;
   - the assistant's answer to it: `{ id: '<messageId>:r', role: 'assistant', action: 'answer_student', at, to, about, text, model, needsProfessor, onBehalf, failed?, meeting? }`.
3. `GET /author/state` adds `chat`. Each post adds `meetingState: [{ label, bookedBy }]` or `null`.
4. **Meeting** shape: `{ meetingId: 'mt-<12>', slots: [{ slotId: 's1'…'s6', start: 'YYYY-MM-DDTHH:MM', label }] }`. It is covered by `contentHash(title, text, kind, author, meeting)` from Step 9b. Don't change that formula.
5. **`src/meeting-times.js`** exports (stubs first): `MEETING_TZ = 'America/Los_Angeles'`, `labelOf(start)`, `slotsIn(text, { now = new Date(), max = 6 })`, `validMeeting(meeting)`. It stays dependency-free.
6. Professor reply metadata: `professor.outcome` may also be `relayed`, `needs_professor` or `meeting`. Add `onBehalf: true` when the assistant answered for the professor, and `meeting: { meetingId, status, slotId }` for a pick.
7. New Professor events: `student_reply`, `meeting_choice`, `professor_chat`.
8. An outbox file saved by Step 9b has none of the new fields. When loading the outbox, fill in any missing field with its empty default (`chat: []`, `chatOps: {}`, `meetings: {}`, `pendingMeeting: null`). Never crash on an older file, and never ask the student to delete data.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/professor-agent.js`, `src/professor-model.js` | Chat backend, direct posts, `@assistant`, checks, replies, booking | `PORT=0 node src/professor-agent.js` starts; `/author/chat` answers |
| B | haiku | `src/meeting-times.js`, `src/hub-lessons.js`, `src/hub-agent.js`, `src/student-inbox.js`, `src/ui-server.js`, `test/professor.test.js` | Time reader, meeting checks on every hop, chat proxies, tests | `node --test --test-name-pattern="meeting times come only from the professor’s words" test/professor.test.js` passes (a pure unit test of `src/meeting-times.js`; the rest of `test/professor.test.js` runs in Phase 3) |
| C | haiku | `public/classroom.js`, `public/app.js`, `public/index.html`, `public/styles.css` | Professor tab, student message bubbles, Reply, time buttons | `node --check public/classroom.js` and `node --check public/app.js` pass |

### Task A — Professor chat backend

**Direct posts (no `@assistant`)** — the professor speaks to students; the assistant stays silent.

1. `ASSISTANT_TAG = /(^|\s)@assistant\b[\s,:]*/i`. Without it, the message is a direct post.
2. `tagsIn(text, roster)` (in `src/professor-model.js`) → `{ tagged, named }`. A tag is `@<first name>` or `@<studentId>` at the start or after whitespace, so the `@` in `alex@example.com` is not a tag. `named` = first name or full name as a whole word.
3. Strip the leading tags. Send the rest **exactly as written**.
4. Nothing left → "Write the message after the tag — nothing was sent."
5. An unknown leading tag ("@zed") sends nothing: "There's no @zed in Marketing 101, so nothing was sent."
6. `audience` = the tagged ids joined with commas, or `all` when nobody is tagged.
7. `classifyPost({ text })` only names the post: `{ kind: 'lesson'|'message', title }`.
   - Live: one small structured call (300 tokens).
   - Mock, no key, or any failure: a heuristic (lesson only if teaching words and over 160 chars; title = first sentence, ≤ 60 chars).
   - Naming never blocks the post.
8. Post with `createPost({ source: 'chat', verbatim: true, author: 'professor' })`. Store `postKey` (or `problem`) on the professor's own chat entry. Add no assistant entry.
9. **`replyTo`** (the professor answering one student): a `message` to that student only, title `Reply: <first sentence>` (≤ 60 chars), no naming call. "@assistant …" while replying is still a request to the assistant.

**`@assistant`**:

10. `interpretProfessor({ text, roster, seeds, posts, recent, emit })` makes one structured call on the request with the tag removed. Schema: `action` (`post|answer|clarify|schedule`), `reply`, `kind`, `audience`, `title`, `content`, `content_is_verbatim`, `seed_id`. Unknown action → `clarify`.
11. Its input: the roster (names and tags), the course lessons, the class data (posts with per-student state, newest first, ≤ 8), the recent chat (≤ 6) and the request. Students and lesson text are data, not instructions.
12. Prompt: copy the professor's words exactly when they wrote text for students. Otherwise write faithfully in the professor's voice, adding **no** facts, dates, rules or consequences. For `schedule`, never write times.
13. Mock (labelled `(Mock mode — no model.)`) heuristic:
    - a question about who opened/read/received → a status summary of the latest post;
    - meet/meeting/schedule/office hours with a student or the class → `schedule`;
    - him/her/them without a tag or "everyone" → `clarify`;
    - a course-lesson title → that seed;
    - else a post to the tag or `all`.
14. A model error → `action: 'error'`, "I couldn't work that out right now (…). Nothing was sent."

**`checkPost(decision, said, roster, recentChat)` — code checks before anything is sent:**

15. **Audience** (`resolveAudience`, shared with `schedule`): tags the professor wrote win over the model. One tag → that student; several → all of them. Say so in the reply ("sent to Alex Student, whom you tagged"). This doesn't apply when the words say everyone, everybody, all students, the class, whole class or all of you.
16. No valid audience → "Who should get it — one student (tag them, like @alex) or the whole class?"
17. A single student the professor didn't tag or name → "Should this go to Sam Student only? Tag them (@sam) or say "everyone"."
18. **Course lesson** (`seed_id`): text = objective, explanation, example and "Check your understanding: …" from the course pack, never the model. Title from the pack, kind `lesson`. Unknown seed → "I couldn't find that course lesson. Which one do you mean?"
19. Empty text → "What should it say?"
20. **Verbatim** is believed only if the normalized text appears in the professor's words (this message or their recent chat lines). Otherwise `verbatim: false`.
21. **Dates**: any date in the text (`datesIn`) that isn't in the professor's words (or the seed) → refused: "I'd have had to add a date you didn't give, so I didn't send it. …".
22. Every refusal is `action: 'clarify'` with a `check` code (`unknown_audience`, `untagged_student`, `unknown_seed`, `empty`, `invented_date`). Then post with `createPost({ source: 'chat', author: 'assistant', verbatim, seedId })`.

**The chat turn (`professorChat`)**:

23. Work on one message at a time (`chatBusy`; 409 otherwise).
24. Push the professor's entry first. Then do the direct post, assistant turn or meeting offer. Then store the outcome in `chatOps[operationId]` and emit `professor_chat`.
25. A classroom reset during a turn must not lose the professor's line. Count resets (`resetGeneration`). If one happened mid-turn, put the entry back above its reply.
26. `POST /author/reset` also clears `chat`, `chatOps`, `meetings`, `pendingMeeting` and the remembered conversations.

**Replies from students (`handleChat`, with the Hub-attached post)**:

27. Who answers depends on who wrote the post (`author`, signed in the content hash):
    - the professor's own **message** → relayed in person: no model call. Reply "Sent to your professor. Their answer will appear here in your chat." with `outcome: 'relayed'`;
    - the assistant's **message** → `professorReply({ onBehalf: true })`. The assistant speaks for the professor and calls them "the professor";
    - a **lesson** → answered from the lesson, as in Step 9b.
28. On behalf, anything only the professor can decide (an extension, an exception, a grade, a personal arrangement, anything the posts don't settle) → `needs_professor`. Say it was passed on; never decide it. Accept `needs_professor` **only** when `onBehalf`.
29. Mock `onBehalf`: a labelled keyword heuristic (extension, exception, grade, make-up, more time, "until Friday" …) → `needs_professor`.
30. `recordReply(messageId, student, answer)` writes the student's line (and the answer, if any) into the professor's chat, once per incoming message id. A failed answer is recorded with `failed` and `needsProfessor`. Emit `student_reply`.
31. Plain course questions (no post attached) are not copied into the professor's chat.
32. **`postedTo(student)`**: with no post attached, give `professorReply` this professor's posts to that Hub-verified student. Newest first, latest revision of each, at most 5. Never another student's posts. Their dates count as given.
33. Prompt additions: a message is the professor's own announcement. Answer only from what it says, never "ask your professor", never internal labels.

**Meetings**:

34. `schedule` → `resolveAudience`, then `slotsIn(request)`. Times found → offer them. No times → save `pendingMeeting = { audience, at }` and ask: "When can Alex come? Give me a few times — for example "Tue 2pm, Wed 10:30am" — and I'll send them to choose from. Just write the times; no need to tag me." (`check: 'needs_times'`).
35. The professor's next message that has no `@` at the start and no `replyTo`, within 15 minutes and containing times, answers the pending question.
36. `offerMeeting`: store `meetings[meetingId] = { meetingId, slots, audience, bookings: {}, byStudent: {}, createdAt }` and clear `pendingMeeting`.
37. The offer is a `message` by the `assistant`, titled "Meeting with the professor", text "The professor would like to meet with you. Pick the time that works for you:" plus one "• <label>" line per slot and "(Pacific Time.)". `verbatim: false`; `meeting` attached.
38. `bookSlot(meetingId, slotId, student)` is a **synchronous check-and-set inside one `outbox.update`** (no await between check and write):
    - not an offered slot → `unknown`;
    - this student already booked the same slot → the same booking; another slot → `already`;
    - the slot is taken → `taken`, listing the times still open; none left → `needsProfessor: true`;
    - else book it: "Booked: <label> (Pacific Time) with the professor. Demo booking — no calendar invite is sent."
39. A pick arrives as a reply with `metadata.meetingSlot`. Reply with `outcome: 'meeting'`, record it in the professor's chat, emit `meeting_choice`.

### Task B — Meeting times, hop checks, proxies and tests

1. `slotsIn(text, { now, max })` reads times **only from the professor's words**:
   - days: weekdays (the next one; a passed time today rolls to next week), "today", "tomorrow", "Oct 28", "10/28" (a past date rolls to next year);
   - times: "2pm", "2:30 pm", "14:00", "noon".
2. Split on `.`, `;` and newlines. A day applies to times after it in that piece (or before it, "2pm on Tuesday"). A time with no day is not a slot — don't guess.
3. Drop past times and duplicates. Sort, keep at most 6, number them `s1`…`s6`. Times are in `MEETING_TZ`.
4. `labelOf('2026-10-27T14:00')` → `Tue, Oct 27, 2:00 PM`.
5. `validMeeting(m)`: `null` is valid. Otherwise `meetingId` matches `/^mt-[\w-]{6,40}$/`, 1–6 slots, `slotId` matches `/^s[1-6]$/`, `start` matches `YYYY-MM-DDTHH:MM`, and `label === labelOf(start)`.
6. `src/hub-lessons.js`: reject a publish as `malformed` when `!validMeeting(meeting)` or a meeting is on a non-`message` post. `lessonRoute` also returns `slotIds`.
7. `src/hub-agent.js`: forward `metadata.meetingSlot` downstream only when it is one of that student's own lesson route `slotIds`.
8. `src/hub-agent.js`: add `POST /dev/agents/:agentId/author/chat` (proxy, 60 s, `sameOriginGuard` like every non-GET `/dev` route).
9. `src/student-inbox.js`: reject a delivery whose meeting fails `validMeeting` (`bad_meeting`).
10. `src/ui-server.js`: `POST /api/runs` accepts `meetingSlot` only together with a `lessonDeliveryId` whose inbox entry offers that slot. Otherwise 400 "That isn't one of the offered times."
11. `src/ui-server.js`: add `POST /api/professor/chat` (proxy, 65 s) and serve `index.html` at `/professor`.
12. When the run carries `lessonDeliveryId`, the `request_planned` reason for a message says the university routes it back to whoever sent it.
13. `test/professor.test.js` adds (mock Professor and router unless noted; label it plumbing, not judgment):
    - **chat, mock**: "@alex …" → Alex only; no tag → the class; two tags → both; a course lesson by name → pack text, origin seed; "Tell him I liked his work" → clarify; "who has opened…?" → answer; the same `operationId` twice → one post;
    - **`@assistant`, scripted live** (fake Messages API, placeholder key, `TUTOR_LOAD_DOTENV=0`):
      - an untagged student → clarify, nothing sent;
      - an invented date → refused;
      - text claimed verbatim but rewritten → `verbatim: false`;
      - "@assistant @alex …" with model audience `all` → `student-alex`, "whom you tagged";
    - **course question from posts** (scripted live): the prompt contains the professor's post to Alex, never a post only to Sam;
    - **replies**:
      - a professor message reaches Alex's chat (`lesson_received` with text);
      - Alex's reply → `outcome: 'relayed'`, no model call, in the professor's chat;
      - `replyTo: 'student-alex'` → a message to Alex only; an unenrolled `replyTo` → 400;
      - a reply to an assistant message → `onBehalf`; an extension request → `needs_professor`, flagged;
    - **meetings**:
      - no times → `clarify`, `check: 'needs_times'`;
      - "Tuesday 2pm or Wednesday 10:30am" → an offer with exactly `slotsIn` of those words;
      - `s1` → booked; `s1` again → booked; `s2` → `already`; `s9` → 400 at the UI server;
      - a class offer: Alex books `s1`; Sam (`signedStudent`) picking `s1` → `taken`, and the professor is told;
    - **time reader**, in a test titled exactly `meeting times come only from the professor’s words` (curly apostrophe, as in the real file), with a fixed `now = 2026-10-27T05:40:00Z` (Monday 22:40 Pacific): "Tuesday 2pm or Wednesday 10:30am" → Tue Oct 27 2:00 PM, Wed Oct 28 10:30 AM; "tomorrow at 2pm or 4pm" → two Tue slots; "Monday 9am" → Mon Nov 2; "today 9am" → none; "come and see me at 2pm" → none; "10/29 3:15 pm; Thu 14:00" → Thu Oct 29 2:00 PM and 3:15 PM;
    - **cross-site**: `POST /dev/agents/professor/author/chat` with a foreign `Origin` → 403.

### Task C — Browser

**Professor view** (`public/classroom.js` professor section, `index.html`, `styles.css`):

1. A fourth tab "Professor view" at `/professor`. The other three tabs stay. One chat panel shaped like the student's.
2. Header "Marketing 101 — Professor", the course note, and the roster ("Alex Student", "Sam Student"). Each name has a presence dot: online / "Student agent not connected — posts queue at the Hub".
3. Data comes from `GET /api/professor/state`. Refresh every 3 s while visible and on lesson events.
4. The professor's lines are on the right. A direct post shows as "You → Alex Student" or "You → the whole class (2)", with its kind tag, title and **one line per student**.
5. Student lines: Sending…, Queued at Hub (with why), Delivered, Opened, Being confirmed, Failed. Also "Refused by the Hub: <reason>" and "Not confirmed by the Hub yet — it will be retried." A direct post that failed shows "Not sent" with the reason.
6. "Course assistant" replies on the left (with the model name in live mode). If it sent something, add a **post card**: Lesson/Message tag, title, "to the whole class (N)" or "to <name>", the exact text, the origin line and per-student states.
7. Origin lines: "Your words", "Written from your instruction — read it before students do", or "Course lesson, as written in the course pack". Meeting cards list each time as "Booked by <name>" or "Open".
8. A student's reply shows as "Alex Student → you · re: "<title>"" (relayed) or "→ course assistant", with **↩ Reply**.
9. An assistant answer shows as "Course assistant → Alex Student (for you)". When it handed over or failed, add "Needs your answer — the assistant didn't decide this." and a Reply button.
10. Reply sets the chip "Replying to <name> — only they get it". The next send carries `replyTo`.
11. Composer: Enter sends, Shift+Enter is a new line, IME composition is left alone. Blank does nothing; one message at a time; text stays on failure.
12. Keep the draft in `localStorage` (try/catch). A retry of the same text reuses its `operationId`.
13. **@-tag suggestions**: `@assistant` first, then roster students **by first name**. Arrow keys move; Enter or Tab picks.
14. Open on the newest message and follow the bottom with `followBottom`. Don't show the student's toasts while the Professor view is visible.
15. No lesson/message switch, recipient picker or title field. The professor only chats.

**Student side** (`public/app.js`, `public/classroom.js`):

16. A delivered `message` bubble is labelled "<professorName> → you" (or "→ the whole class"), with " · course assistant" when `author` is `assistant`.
17. Each bubble gets **↩ Reply**. Reply sets the chip "Replying to: <sender>". The next message carries `lessonDeliveryId`, then the chip clears (one reply). A lesson's "About" chip stays.
18. A message counts as **opened** once it has really been seen. Use an `IntersectionObserver` at ≥ 60 % visible while `document.visibilityState === 'visible'`, then call `POST /api/inbox/:id/open`. Re-check on `visibilitychange`.
19. A meeting offer shows one plain `<button>` per slot inside the bubble (group `aria-label="Pick a meeting time"`). These are chat buttons built from the signed `meeting` data, not an A2UI form.
20. A click sends "I'll take <label>." with `lessonDeliveryId` and `meetingSlot`.
21. When the reply's `professor.meeting.status` is `booked` or `already`, mark the booked slot (✓, `aria-pressed="true"`) and disable the other buttons.
22. A relayed reply shows a small note "Sent to Marketing 101 Professor" with the text, and no answer bubble. An on-behalf answer is labelled "… · course assistant, for the professor".
23. All text uses `textContent`. Every new element styled with `display` also gets `[hidden] { display: none }`.

## Phase 3 — Join and check (lead)

1. Check that `src/professor-agent.js` imports `slotsIn` from `src/meeting-times.js` and `classifyPost`, `interpretProfessor`, `tagsIn` from `src/professor-model.js`.
2. Run `node --test test/professor.test.js`, then `npm test`. Fix failures in the owning files.
3. Run `npm run demo` with the data left over from Step 9b. It must load without errors (Phase 1, item 8). Then do the browser checks below (optional — needs a browser; if none is available, say so).

## Rules that apply to the whole step

1. The Professor view is a **chat, never a form**.
2. The only buttons in a student's chat bubble are ↩ Reply and meeting-time buttons. The Professor still answers in text, with no A2UI forms.
3. A post is sent only when the professor sends a chat message. Never on typing, blur, autosave or a model suggestion.
4. A model never supplies recipients, dates or meeting times that code hasn't checked. Times come only from `slotsIn` on the professor's words.
5. Tags the professor wrote always win. A single recipient must be tagged or named.
6. Course-lesson text comes from the course pack, never the model.
7. `author` and `meeting` are inside the content hash, so a post can't be relabelled or its times changed on the way.
8. Lesson and message text is untrusted content: shown as text, never acted on. The prompts mark it as data.
9. Booking stays a synchronous check-and-set. Demo bookings only: no calendar invites, email or SMS.
10. Never run reset checks on a demo someone is using. Use a separate stack with temp data files.

## Avoid these known problems

- Don't put an assistant between the professor and the class. A plain message gets no assistant reply.
- An email address is not a tag. Tag suggestions match first names (every id starts with `student-`; both surnames are "Student").
- Don't give the model a label it can repeat ("The active message says…").
- A course lesson's origin is not "Your words".
- Don't let the assistant stop at "I can't schedule meetings", or decide extensions, exceptions or grades.

## Done when

- `npm test` → all tests pass, 0 failed. `node --test test/professor.test.js` passes.
- `npm run demo`, browser at `http://127.0.0.1:4444/professor` (optional — needs a browser; if none is available, say so):
  - "Homework is late" (no tag) → "You → the whole class (2)": Alex Delivered, Sam Queued at Hub;
  - "@alex please send me your positioning draft" → Alex only; "@zed hi" → nothing sent;
  - in the Conversation tab Alex's bubble has ↩ Reply; scrolling it into view turns the professor's line to Opened; Alex's reply shows in the Professor view with Reply; the professor's reply reaches Alex only;
  - "@assistant send the evidence-before-assumptions lesson to the class" → a post card marked "Course lesson, as written in the course pack";
  - "@assistant schedule a meeting with @alex" → asks for times → "Tuesday 2pm or Wednesday 10:30am" → two buttons in Alex's chat → a click books it; the card shows "Booked by Alex Student" and "Open";
  - pressing Enter twice quickly makes one post.

Then append the "CLAUDE.md notes" below to `CLAUDE.md` and commit `Step 9c: Professor chat, replies and meetings`.

## CLAUDE.md notes

```markdown
## Step 9c (Professor chat, replies, meetings)
- Professor view = chat at /professor, never a form. No @assistant → direct post (professor's words; tags at start or after whitespace pick students, else `all`); classifyPost only names kind/title.
- @assistant → POST /author/chat → interpretProfessor → checkPost (tag wins; single recipient tagged/named; verbatim only if really the professor's words; no new dates; course lessons from the pack) → createPost.
- Post `author` (professor | assistant) and `meeting` are inside contentHash.
- Messages are chat bubbles with ↩ Reply (lessonDeliveryId, chip clears after one send); opened via IntersectionObserver. Lessons stay in the inbox.
- Reply to the professor's own message → relayed (no model, outcome 'relayed'). Reply to the assistant's → onBehalf; needs_professor accepted only then. recordReply copies every delivery-linked exchange into the professor's chat; replyTo answers one student.
- Meetings: schedule never carries times; slotsIn (src/meeting-times.js) reads them from the professor's words (none → ask, pendingMeeting). validMeeting at Professor, Hub, Student. bookSlot is a synchronous check-and-set.
- Without an attached post, the Professor gets postedTo (≤5 of its own posts to that Hub-verified student).
```

## Show it (optional)

- Free: `npm run demo`, then open the Professor view and the Conversation tab in two windows.
- PAID live check (a few cents): `env -u ANTHROPIC_BASE_URL npm run demo:live`. Try "@assistant tell @alex that his marketing homework is late". Then, as Alex, reply "Can I get an extension until Friday?". The assistant should pass it to the professor, and the Professor view should show "Needs your answer".
