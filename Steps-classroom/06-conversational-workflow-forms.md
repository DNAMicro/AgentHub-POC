# Step 6 — Conversational workflow forms (tutoring requests, study-room bookings)

Time: about 75 minutes. Cost: free (tests use mocks and the fake Anthropic API). Optional live check: PAID, a few cents.

## What you'll see when it works

- "Can I meet a tutor about derivatives tomorrow afternoon?" → the Tutor sends its form in the chat, with tomorrow and "Afternoon" filled in.
- "I want to reserve a group study room" → the Library sends a booking form with demo availability, review and "Confirm demo booking".
- On a valid Submit, the form turns at once into a read-only "You sent" summary. The agent's reply with the receipt follows as the next chat message.
- A likely mistake (for example `alex@gmial.com`) sends the form back filled in, with the flag, "Edit" and "Send anyway".
- The page uses the "switchboard" design: every line carries the color of the agent that produced it.

## Starting point

- Steps 1–5 must be done.
- Step 3 built the tutoring-request form (`WORKFLOWS['tutoring-request']` in `src/forms.js`, `src/form-host.js`). A **temporary deterministic chat trigger** in `src/tutor-agent.js` offers it.
- Step 5 gave each agent its skills, scope checks and the router (which already keeps 300-character reply snippets in recent turns).

Start from the committed code of Step 5.

## Instructions for Claude (lead)

You are the lead. Work in the three phases from Step 0:

1. **Contracts.** Write the shared pieces in Phase 1 yourself.
2. **Build.** Start **all four tasks in the table in ONE message** with the Agent tool, so they run in parallel. Give each subagent this file, `00-setup-and-contracts.md`, and its task row.
3. **Join and check.** Wire everything together, write `test/booking.test.js`, run every check in "Done when", fix failures, then commit.

First run `npm test`; Steps 1–5 must pass.

## Phase 1 — Contracts (lead writes these first)

1. In `src/forms.js`, add the new constants and the new workflow entry (Task A fills the builders):
   - `TIMEZONE`, `TIMEZONE_LABEL`, `TUTORING_HOURS` and `WORKFLOWS['tutoring-request']` already exist from Step 3. Keep them unchanged; the tutoring entry is repeated below only for reference.
   - New: `ROOMS`, `BOOKING` and `WORKFLOWS['study-room-booking']`.
   - `ROOMS = [{ id: 'room-a', name: 'Room A — Floor 2', capacity: 4 }, { id: 'room-b', name: 'Room B — Floor 2', capacity: 6 }, { id: 'room-c', name: 'Room C — Floor 3', capacity: 10 }]`.
   - `BOOKING = { open: '09:00', close: '21:00', durations: [60, 120], maxDaysAhead: 14, maxGroup: 10 }`.
   - `WORKFLOWS['tutoring-request']` (exists from Step 3, keep it):
     - `agentId: 'tutor'`, `skillId: 'in-person-tutoring-request'`, `finalAction: 'submitTutoringRequest'`, `pendingText: 'Sending request…'`;
     - actions `submitTutoringRequest { button: 'submit_button', fields: [firstName, lastName, email, preferredDate, period, specificTime, notes], final: true }` and `cancelForm { button: 'cancel_button', fields: [], cancel: true }`.
   - `WORKFLOWS['study-room-booking']` (new):
     - `agentId: 'library'`, `skillId: 'study-room-booking'`, title `Book a group study room`, `finalAction: 'confirmStudyRoomBooking'`, `pendingText: 'Confirming booking…'`;
     - actions `checkAvailability` (`check_button`, fields `date, room, duration, groupSize`), `reviewBooking` (`review_button`, all booking fields), `editBooking` (`edit_button`, none), `confirmStudyRoomBooking` (`confirm_button`, all booking fields, `final: true`), `cancelForm` (`cancel_button`, `cancel: true`);
     - all booking fields: `firstName, lastName, email, date, room, duration, groupSize, slot`.
2. **Intent outcome** (both agents): `'offer' | 'info' | 'clarify' | null`. Signatures in `src/form-intent.js`: `mockTutorIntent(q)`, `mockLibraryIntent(q)`, `wantsReplacement(q)`, `tutoringPrefill(q, now)`, `bookingPrefill(q, now)`, `parseStatedDate(q, now)`, `parseStatedTime(q)`.
3. **Handler result** (form-host actions): `{ status: 'accepted' | 'updated' | 'rejected' | 'conflict' | 'cancelled' | 'needs_review', message, errors?, flags?, receipt?, a2ui?, values? }`.
4. **Form metadata** on the issuing A2A message: `{ runId, agentId, formId, workflowId, formVersion, issuer, supersedes, prefilled: [fieldNames] }`. `formId` = A2UI `surfaceId` = `<workflowId>-<8 hex>`.
5. **Lifecycle event** (published by the UI server, `source: 'system'`, `type: 'form_lifecycle'`): `{ formId, workflowId, agentId, state, ...extra }`.
   - `state` is `editing | submitting | accepted | rejected | confirmation_pending | cancelled | superseded | refused`. `refused` (from Step 3) means the UI server would not show the form, e.g. its `workflowId` belongs to another agent.
   - `extra` may carry `submitted`, `operationId`, `receipt`, `errors`, `conflict`, `restored`, `review`, `flags`, `values`, `reason`, `by`, `reconcile`.
6. **Store, review and intent signatures** (stubs with these exact signatures, so every task can import them before the owning task finishes):
   - `createTutoringStore()` → `{ createTutoringRequest(values), count() }`;
   - `createRoomStore()` → `{ listStudyRoomAvailability({ date, room, duration }), isFree(slot), reserveStudyRoom({ room, date, start, duration, groupSize, contact }), count() }`;
   - `reviewGate({ form, workflowId, values, acknowledged, live, slotLabel, emit })` → `null` (proceed) or a `needs_review` result.
   - the `src/form-intent.js` functions from item 2 (they return `null` until Task A fills them).
7. **Agent viz events**: `intent_decided`, `form_sent`, `form_action_received`, `form_action_result`, `form_reply_sent`, `form_review`.
8. **UI routes**: `POST /api/forms/:formId/actions` with body `{ operationId, action, acknowledgeReview }`, `POST /api/forms/:formId/edit`, `POST /api/forms/:formId/reconcile`.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/forms.js`, `src/form-intent.js`, `test/payload-policy.test.js`, `test/a2ui-render.test.js` | Both form templates, updates, validation, intent and prefill | `node --test test/payload-policy.test.js` passes. (`test/a2ui-render.test.js` gets its form from a running Tutor, which Task C is editing; it runs in Phase 3.) |
| B | haiku | `src/form-host.js`, `src/demo-store.js`, `src/form-review.js` | One form per workflow, serialized actions, demo stores, advisory review | `node --check` passes on each owned `.js` file, and `node -e "import('./src/form-review.js').then(m=>m.reviewSubmission({workflowId:'tutoring-request',values:{email:'a@gmial.com'},live:false})).then(r=>console.log(r.flags.length))"` prints `1` |
| C | sonnet | `src/tutor-model.js`, `src/library-model.js`, `src/tutor-agent.js`, `src/library-agent.js`, `src/library-fixture.js` | Intent outcomes in each agent's existing call, form offers, action handlers, Library card A2UI extension | `node --check` passes on each owned `.js` file, and both agents start (`PORT=0`) and print their `listening on` lines with the Phase 1 stubs in place. Real form behaviour is checked in Phase 3 |
| D | sonnet | `src/ui-server.js`, `src/student-agent.js`, `public/forms-ui.js`, `public/app.js`, `public/index.html`, `public/styles.css`, `public/fonts/`, `test/form.test.js` | Form lifecycle, chat-item forms, the switchboard design | `UI_PORT=0 node src/ui-server.js` prints `[UI] listening on …`; `test/form.test.js` is written (it passes after Phase 3) |

### Task A — Forms and intent

1. **Tutoring form** (`buildTutoringForm(surfaceId, { prefill, now })`):
   - Title "Request an in-person calculus tutoring session".
   - Description "Tell us your preferences. This submits a request; it does not book a time."
   - Fields:
     - First name, Last name, Email (all required);
     - Preferred date: a date-only DateTimeInput, Monday–Friday, today up to 60 days ahead;
     - Preferred time of day: required Morning/Afternoon chips;
     - Preferred specific time: optional, time only;
     - Notes: required, multiline, labelled "Describe what you'd like help with.".
   - Show the timezone and the hours (09:00–17:00, morning before 12:00), and a demo note.
   - Buttons "Send tutoring request" (`submit_button`) and Cancel (`cancel_button`).
2. **Booking form** (`buildStudyRoomForm`):
   - Fields: First name, Last name, Email, Group size, Date (up to 14 days ahead), Room (chips with capacity), Duration (1 or 2 hours), a "Show available times" button (`check_button`), and a slot ChoicePicker labelled "Available start time (Demo availability)" with a note.
   - Buttons "Review booking" (`review_button`) and Cancel.
   - Show timezone, capacity and duration.
3. Updates (`updateComponents` / `updateDataModel` on the same surface, never a new surface):
   - `buildSlotUpdate(surfaceId, slots, note, keepSlot)`;
   - `buildReviewUpdate(surfaceId, lines)`: a review screen with "Confirm demo booking" (`confirm_button`) and "Back to edit" (`edit_button`);
   - `buildEditUpdate(surfaceId)`;
   - `buildDelete(surfaceId)` = `[{ version: 'v0.9', deleteSurface: { surfaceId } }]`.
4. Validation from one dependency-free module (the browser imports it):
   - `validateTutoringRequest`, `validateBookingCriteria`, `validateBooking`, `validateFinal(workflowId, context)`;
   - trim names and reject whitespace-only values; email format; length limits (name 100, email 254, notes 1000);
   - weekdays and date range; operating hours; period/time consistency; capacity; allowed durations.
5. `checkAction(message, { workflowId, surfaceId })`: only that workflow's actions, from their own button, with exactly their fields.
6. The payload policy allows only these components: Column, Row, Text, TextField, Button, ChoicePicker, DateTimeInput, Divider. Allowed functions: `required`, `regex`, `length`, `email`, `and`, `or`, `not`.
7. DateTimeInput `min`/`max` must be exactly `YYYY-MM-DD` (dates) or `HH:MM:SS` (times).
8. `src/form-intent.js` — **labelled heuristics** for fixed/mock modes:
   - Tutor: in-person words (`in-person`, `face-to-face`, `meet a tutor`, `tutoring session`) + a how/what question + info words → `info`.
   - Tutor: in-person words + a want word → `offer`.
   - Tutor: "I want tutoring" → `clarify`.
   - Library: a room word + "how do I book/reserve…" (without "I want") → `info`.
   - Library: a room word + reserve/book/schedule/get → `offer`.
   - Library: a room word + need/want → `clarify`.
   - "Where are the study rooms?" → `null` (a plain question).
   - `wantsReplacement`: replace / start over / new form / discard.
9. **Prefill is parsed only from the student's words**, in every mode:
   - dates: today, tomorrow, the day after tomorrow, weekday names, `Oct 30`, ISO dates;
   - morning/afternoon; a stated time (`3pm`, `14:30`);
   - group size ("for 5 people"); duration ("2 hours");
   - drop values outside the form's rules;
   - **never** prefill names, emails or notes.
10. Tests:
    - `payload-policy.test.js`: both forms pass the allowlist; forbidden functions, components and actions are rejected; validation edge cases.
    - `a2ui-render.test.js`: both forms and the slot update validate against the official v0.9 schemas **with format checks**; the slot update replaces options in place; `deleteSurface` unmounts the form and its handlers.

### Task B — Form host, stores, review

1. `src/form-host.js` additions:
   - `openForm(contextId, workflowId)` and `formForRequest(ctx)`. Keep a map from `contextId|messageId` of the chat request to the formId it produced.
   - `issue()`: a repeat of the same chat request re-sends the **same** open form, never a second one. `supersedes` marks the old form superseded and attaches its `deleteSurface` as a data part.
   - Send the form as a Task in `TASK_STATE_INPUT_REQUIRED`. Publish the task before any status update.
   - **Serialize actions per form**: a second action waits for the one in progress, then re-checks the state. Never reject it as "busy".
   - Check `isEnabled(workflowId)` against the **current** skills at every action.
   - Dedupe by `metadata.operationId`. The same values return the stored result; different values are rejected.
   - Pass `reviewAcknowledged: metadata.reviewAcknowledged === true` to handlers. On a closed form, append `buildDelete(formId)`.
   - Emit `form_action_result` (the handler outcome) **before** `form_reply_sent` (what went back over A2A).
2. `src/demo-store.js`:
   - `createTutoringStore()`: ID `TR-XXXXXXXX`, status "Received — awaiting scheduling".
   - `createRoomStore()`:
     - availability comes only from `listStudyRoomAvailability`: hourly starts from 09:00 to 21:00, minus fixed demo busy times (room-a 14:00–16:00, room-b 10:00–11:00, room-c 18:00–19:00) and existing bookings;
     - `reserveStudyRoom` is **synchronous check-and-set** (no `await` between the check and the write);
     - booking ID `BK-XXXXXXXX`; a taken slot returns `{ ok: false, reason: 'taken' }`.
3. `src/form-review.js`:
   - `reviewSubmission({ workflowId, values, live, slotLabel, emit })`. Live: one structured call (`flags: [{ field, message }]`, 500 tokens) with **every field**, including name and email.
   - Flag only contradictions, notes unrelated to the form's purpose, likely email-domain typos (gmial, hotmial), and placeholder values.
   - The prompt lists what never to flag: an email that doesn't contain the name, help before a deadline, values that agree. It says never to ask to "confirm", and to stay silent when unsure.
   - Code drops "email doesn't match the name" flags, and keeps at most 5 flags of 240 characters on known fields.
   - Mock: a labelled heuristic (typo domains, placeholders, a notes day or period that contradicts the choice).
   - A failed or keyless review **fails open**: return no flags with `unavailable` set, and emit `form_review`.
   - `reviewGate`: if `acknowledged` is set and the values exactly equal the reviewed values, skip the review. Otherwise review, and on flags store `reviewedKey`/`reviewFlags` and return `{ status: 'needs_review', message, flags }`.

### Task C — Agents

1. **Delete the Step 3 temporary chat trigger** in `src/tutor-agent.js`. Use `src/form-intent.js` instead.
2. Tutor live mode: add verdicts `offer_tutoring_request_form` and `tutoring_request_info` to the **existing scope-check call**. Never add an extra call.
   - The prompt says missing details are not a reason to clarify (the form collects them).
   - It says "explain a topic" is `in_scope`, not a form request.
   - When it's unclear whether the student wants an explanation now or a session → `needs_clarification`.
3. Tutor fixed/mock (or scope enforcement off): `mockTutorIntent` decides.
4. Library live mode: add verdicts `offer_study_room_booking_form` and `study_room_booking_info` to the **existing answer call**.
   - The prompt says "a room for study", "a room to study in", "a space for my study group" and "a group room" mean a study room → offer.
   - A bare "I need a room" → ask "Do you want to book a group study room?".
   - Missing details are not a reason to clarify.
5. Library mock: `mockLibraryIntent`. A "yes" right after the Library asked that question → offer.
6. The Library remembers its last 4 exchanges per `contextId` (in memory), only to understand short replies. Pass them as `recent`: an array of `{ question, answer }` objects, oldest first. This is the exact shape `answerFromKnowledge({ …, recent })` reads, and the same shape on both sides. Don't use `{ user, agent }` or `{ role, text }`.
7. The Library's Agent Card (`buildAgentCard` in `src/library-agent.js`) gets the same A2UI entries as the Tutor's card (Step 3, Task B):
   - `capabilities.extensions`: `[{ uri: A2UI_EXTENSION_URI, description: 'Sends A2UI v0.9 surfaces (basic catalog) and accepts A2UI actions.', required: false, params: { supportedCatalogIds: [BASIC_CATALOG_ID], acceptsInlineCatalogs: false } }]`;
   - `defaultInputModes: ['text/plain', A2UI_MIME_TYPE]`;
   - `defaultOutputModes: ['text/plain', A2UI_MIME_TYPE, 'application/json']`.
   Without it, `sendFormAction` refuses the Library's forms (the card must advertise the A2UI extension).
7a. Add the Library's built-in form skill `study-room-booking` (`kind: 'form'`) to `LIBRARY_DEFAULT_SKILLS`. Library rules become `{ answer: { knowledge: 'required' }, form: { id: 'study-room-booking' } }`.
8. Offering a form (both agents):
   - workflow disabled → fixed text;
   - client didn't declare A2UI v0.9 basic-catalog support (`metadata.a2uiClientCapabilities`) → fixed text;
   - an open form of this workflow in this conversation, not from the same request, and no replacement wanted → "continue or replace?" text;
   - otherwise `issue()` with the parsed prefill.
9. Fixed server texts for `info`, `clarify`, `disabled` and `alreadyOpen`. Tutor clarify: "Would you like me to explain a calculus topic here, or to request an in-person tutoring session?".
10. Tutor `submitTutoringRequest`:
    - validate, then `reviewGate`, then `createTutoringRequest` once;
    - reply `We received your request. A time slot will be sent based on your preferences.`;
    - receipt `{ requestId, status, preferences, timezone, demo: true, note }`;
    - never say "Appointment booked".
11. Library booking handlers:
    - Slot IDs are opaque, per form, and stable for the same time on that form.
    - `checkAvailability`: validate the criteria, then a slot update. If all four are filled but invalid, say why (e.g. capacity).
    - `reviewBooking`: validate, check the slot was offered on this form and matches room/date/duration, check it is still free, set `form.stage = 'review'`, send the review update.
    - `confirmStudyRoomBooking`: refuse unless `form.stage === 'review'`. Validate and check the slot. `reviewGate`. Then `reserveStudyRoom`.
    - A taken slot → `conflict` with refreshed alternatives. Never substitute another time or room.
    - Success → "Your group study room is booked." Receipt `{ bookingId, room, date, start, end, groupSize, timezone, demo: true, note }`.
12. Agent logs redact first name, last name and email in **every** mode.

### Task D — UI server, forms in chat, design

1. Remove any "Request form" button and any endpoint that creates a form directly.
2. `src/student-agent.js`:
   - report `form_received` with `formId, workflowId, formVersion, issuer, supersedes, prefilled, a2uiMessages`;
   - `sendFormAction` gains the option `acknowledgeReview = false`. New signature: `sendFormAction(baseUrl, { form, action, operationId, runId, acknowledgeReview = false, timeoutMs = SUBMIT_TIMEOUT_MS, onEvent = () => {} })`. When it is true, the message carries `metadata.reviewAcknowledged: true`.
3. `src/ui-server.js` owns the lifecycle (`form_lifecycle` events):
   - **Form-origin check**: refuse a form whose `workflowId` belongs to another agent (`lifecycle: 'refused'`).
   - A re-sent known form never makes a second copy.
   - A second editable form of the same workflow in the same conversation is not rendered (backstop).
   - `POST /api/forms/:formId/actions`:
     - accept only the keys `operationId`, `action`, `acknowledgeReview`, and run `checkAction`;
     - validate with `validateFinal` (final and review actions) or the criteria (lookups);
     - 409 while a request is in flight or the state is `confirmation_pending`;
     - Cancel → `cancelled`;
     - a final action → `submitting` with `submitted` values.
   - Results:
     - `accepted` → `accepted` with the receipt;
     - `needs_review` → `editing` with `restored, review, flags, values`;
     - any other refusal → `rejected` with `errors` (and `conflict` when the slot was taken);
     - not delivered → `rejected`;
     - uncertain → `confirmation_pending`.
   - `/edit` (only from `rejected`) → `editing` with the values that were sent. After a conflict, clear only the slot.
   - `/reconcile` (only from `confirmation_pending`) resends the **same** operation ID.
   - "New conversation" cancels open forms with `reason: 'new_conversation'`. No handler is called.
   - The `event: replayed` marker at the end of the `/api/events` history replay already exists from Step 3. Keep it.
4. `public/forms-ui.js`:
   - The form is a **chat item** ("Received from …") at full chat width. It says which fields were filled in from your message.
   - On a valid submit, remove the surface with the standard `deleteSurface`. Then show the read-only "You sent" summary with "Sending request…" / "Confirming booking…".
   - The reply with the receipt follows as the next message.
   - Rejected → reason + "Edit and retry" ("Choose another time" after a conflict). Flagged → flags, "Edit", "Send anyway" (`acknowledgeReview: true`). Pending → only "Check status".
   - A reopened form comes back **filled with the values that were sent**, from the event itself, and moves to the bottom of the chat after the agent's reply.
   - Only forms still `editing` after the `replayed` marker are drawn. Late events for closed forms are ignored.
   - Changing date, room, duration or group size clears the chosen time and triggers `checkAvailability`. Keep a pick that is still offered.
   - Lookups and review steps stay inside the form, not as chat messages. Label the lookup "scheduling fields only".
   - Agent panels show "Accepted", then "Sent" with the reply.
5. **Switchboard design** in `public/styles.css`:
   - Tokens (light / dark, follow the system setting): paper `#EEF1F5`/`#11151B`, surface `#FFFFFF`/`#181D25`, ink `#18202B`/`#E4E8EE`, graphite `#5A6676`/`#98A3B1`.
   - Agent colors: Student cobalt `#2B59C3`/`#86A2FF`, Tutor plum `#8A3FA8`/`#C99AE6`, Library spruce `#16765E`/`#4CC4A0`, router/system ochre `#9A6300`/`#E3B04B`.
   - Layout:
     - the chat (widest column) and the two agent panels fill the viewport and scroll on their own; the composer is pinned under the chat;
     - your messages are right bubbles, agents' replies sit on the left with a rule in the agent's color, and routing notes are small and centered;
     - agent panels are log lines (agent color for what it sent, graphite for what it received);
     - the timeline is a collapsible numbered strip;
     - tablets: chat on top, panels below; phones: everything stacks, no horizontal scroll.
   - Sentence-case labels. No all-caps eyebrows.
   - Theme forms through the renderer's `--a2ui-*` variables. Set `--a2ui-color-primary` and `--a2ui-color-on-primary` together, so selected chips are solid student color with readable text.
6. **Fonts**:
   - `public/fonts/atkinson-hyperlegible-next-latin.woff2` (Atkinson Hyperlegible Next, variable, Latin subset, © Braille Institute of America);
   - `public/fonts/ibm-plex-mono-400-latin.woff2` (IBM Plex Mono Regular, Latin subset, © IBM Corp., used only for IDs);
   - both are SIL Open Font License 1.1 and come from Google Fonts. Record that in `public/fonts/README.md`;
   - use `@font-face` with `font-display: swap`;
   - keep the fallback stacks `--font: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif` and `--mono: "IBM Plex Mono", ui-monospace, Menlo, monospace`;
   - **if you can't download the files, skip them.** The fallback stack works offline, and the page must still make no third-party requests.
7. Tests in `test/form.test.js` (through the UI, mock Tutor):
   - no request-form button or endpoint; request → form with stated preferences only; questions → answers; vague → clarify;
   - valid round trip: removed at once → pending → accepted, recorded once; invalid input sends nothing;
   - forged, wrong-form and stale actions rejected over A2A; duplicate operations; repeat asks, replace supersedes;
   - replay never resurrects or resubmits; Cancel; New conversation; disabled workflow;
   - Edit and retry restores values; confirmation pending → reconcile records once;
   - review: flagged → not recorded; Send anyway records exactly those values; changed values are reviewed again;
   - review: a forged acknowledgement doesn't skip it; a failed review doesn't block; the live review (fake API) sees all fields; the email/name flag is dropped;
   - serialized actions with a slow review record once; contact details redacted in logs.

## Phase 3 — Join and check (lead)

1. Check that the Tutor's default skills keep `in-person-tutoring-request` (`kind: 'form'`) and the Library's now include `study-room-booking`.
2. Check that the router (Step 5) gets reply snippets, so "yes" goes to the service that asked.
3. Write `test/booking.test.js` (mock router, through the UI):
   - a room request routes to the Library, which sends its form; "Where are the study rooms?" gets an answer;
   - availability comes only from the store, for scheduling fields only; changing criteria clears the slot;
   - review is required; forged, stale and mismatched slots are rejected without substitution;
   - confirming without review is refused and the form becomes recoverable;
   - "I need a room" → question → "yes" → form;
   - concurrent confirmations for one slot: exactly one booking; the other gets a conflict and alternatives;
   - form actions go to the issuing agent, whatever the conversation is about now.
4. The test helper that waits for a reply must also accept `form_sent`.
5. Run the checks in "Done when".

## Rules that apply to the whole step

1. The receiving agent decides whether to send a form; the browser never creates one.
2. The model picks only the outcome — never workflows, actions, URLs, templates, rooms or times.
3. Disabling a workflow's skill blocks new forms and actions on open ones.
4. One form = one A2A task; actions resume it with `taskId`. A completed task gets a new message with `referenceTaskIds`.
5. One validation module for browser, UI server and agent; the agent is authoritative.
6. Form actions always go to the issuing agent, never re-routed.
7. Never auto-resend. Reconcile uncertain outcomes by operation ID.
8. All in memory: a restart clears requests, bookings, forms and dedupe records. Fictional data; no real email or bookings.

## Avoid these known problems

- Tell the Tutor's model what became of its form. With only “[Sent the form]” in history, a later answer told the student to contact the tutoring center although the request had been received. On submit, add the request ID and status to that conversation's history; on cancel, “nothing was submitted”. Never the form's values.
- An agent that answers with a form publishes `form_sent`, not `reply_published`. Wait helpers must accept both.
- DateTimeInput `min`/`max`: `YYYY-MM-DD` or `HH:MM:SS`. Validate schemas with format checks on.
- "Where are the study rooms?" is a plain question; only "how do I book/reserve…" is booking info.
- Confirming without review is refused (`rejected`). Tests must review first.
- New conversation cancels open forms; tests needing several open forms use separate conversations.
- The same chat request must return the same form, not "you already have a form open".
- Lifecycle events can trail the HTTP response. Wait for events.
- Serialize actions per form; test it with a deliberately slow review.
- Keep check-and-reserve synchronous; the review runs before it.
- Tell the live model when to clarify **and** when not to.
- Short replies need context on both hops: router reply snippets and the Library's memory.
- Say why no availability appears when the criteria are invalid.
- Only the lookup is "scheduling fields only"; Review and Confirm carry contact details.
- Show the agent's reply, not just bookkeeping: "Sent" after "Accepted", plus a chat message with the receipt.
- Drive Edit-and-retry reordering from the reopen event, so reloads match.
- The chat fills the viewport height; forms use the full chat width.
- Selected chips need both `--a2ui-color-primary` and `--a2ui-color-on-primary`.
- The reopen event carries the values, so a reload keeps corrections.
- Keep the review's never-flag list and the code backstop, or Haiku over-flags.
- Watch `switch` fall-throughs: a misplaced `default:` ran the "skills saved" handler for every form event.
- Redact contact details in agent logs in every mode.

## Done when

- `npm test` → all tests pass, 0 failed, with no API key set.
- `node --test test/form.test.js test/booking.test.js test/a2ui-render.test.js test/payload-policy.test.js` passes.
- Manual check (optional — needs a browser; if none is available, say so) with `npm run tutor:mock`, `npm run library` and `ROUTER_MODE=mock npm run ui`:
  - in-person request → form with prefill → submit → "You sent" → receipt;
  - room booking → availability → review → confirm → receipt;
  - `alex@gmial.com` → flagged → Send anyway;
  - reload after each state shows the same chat;
  - light and dark; phone width with no horizontal scroll.
- Append the "CLAUDE.md notes" below to `CLAUDE.md` and commit `Step 6: Conversational workflow forms`.

## CLAUDE.md notes

```markdown
## Step 6 (conversational workflow forms)
- Workflows in src/forms.js WORKFLOWS: tutoring-request (Tutor skill in-person-tutoring-request), study-room-booking (Library skill study-room-booking). Actions allowlisted per button and fields.
- Prefill only from src/form-intent.js parsing the student's words; never names, emails or notes; never from model output.
- The UI server owns form_lifecycle: editing → submitting → accepted | rejected | confirmation_pending; editing → cancelled | superseded. The browser draws only forms still editing after the `replayed` marker.
- One editable form per workflow per conversation; the same request (messageId) gets the same form back (formForRequest).
- Form host serializes actions per form and dedupes by operationId.
- reserveStudyRoom is synchronous check-and-set; keep it that way. Review is required before confirm.
- reviewGate only flags; Send anyway (acknowledgeReview) skips it only for the exact reviewed values; failures fail open.
- DateTimeInput min/max: YYYY-MM-DD or HH:MM:SS.
- Agent logs redact names and emails in every mode.
```

## Show it (optional)

- Mock: `npm run tutor:mock`, `npm run library`, `ROUTER_MODE=mock npm run ui`, then open `http://127.0.0.1:4444`.
- **PAID live**: start the three servers with `env -u ANTHROPIC_BASE_URL` (`npm run tutor:live`, `npm run library:live`, `ROUTER_MODE=live npm run ui`). Try the tutor-meeting request, "I need a room" then "yes", and a clean and a faulty form. A reviewer that flags clean forms is a bug.
- **Optional, PAID, needs a browser and `playwright-cli`** (install with `npm i -g @playwright/cli` if you want it; if no browser is available, skip it and say so): a full browser pass against the live servers. Cover invalid input, repeat/replace, cancel, a disabled workflow, capacity, a slot conflict, an offline agent, confirmation pending, review flags, and reloads — at desktop and phone widths, light and dark. If you skip it, say that visual checks weren't done.
