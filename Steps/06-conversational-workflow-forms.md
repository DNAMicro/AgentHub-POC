# Step 6 — Conversational workflow forms (tutoring requests, study-room bookings)

> Final state: see `Steps/README.md`. This is your Part 6 prompt with every later change merged into the instructions themselves — including the form review, forms as chat items, and the visual design — so running it after Steps 1–5 rebuilds the current app. The closing sections list the problems to avoid and each change with why it was made.

Implement Part 6: conversationally triggered A2UI workflows for in-person tutoring requests and group study-room bookings, with correct form dismissal after submission, an advisory model review before anything is recorded, and a clean chat-style UI where forms are part of the conversation.

Inspect the current implementation and run existing tests first. Preserve Parts 1–5: genuine A2A messaging, routing, editable Agent Cards and refresh notifications, scope enforcement, browser visualization, and safe Anthropic integration.

Do not assume prior features work without verification. Keep this a localhost spike with fictional availability and local demo records, not real university bookings or external communications.

The tutor is called **Tutor Agent** everywhere in the UI, registry display names and its card description — its subjects come from its editable skills (calculus is only the default). The Library is the **Library Agent**.

1. NO REQUEST-FORM BUTTONS
Remove the “Request form” button, the `POST /api/forms` shortcut and any dedicated button that directly creates either workflow’s form. The Part 3 student-details form is retired; the tutoring-request form replaces it. The student uses the normal message composer.

The receiving service agent, not the browser, decides whether a form is appropriate:
1. Student types a natural-language request.
2. Student Agent selects the appropriate service using its advertised skills and sends the request through A2A.
3. Tutor or Library interprets the request against its own enabled workflows.
4. If it meets the workflow’s requirements, that agent sends the corresponding A2UI form through A2A (an A2A Task in `INPUT_REQUIRED` carrying the registered A2UI template).
5. Student Agent checks the payload against its A2UI allowlist, and the browser renders it.

Each agent’s workflow is its reserved built-in form skill — Tutor: `in-person-tutoring-request`, Library: `study-room-booking` — visible, renameable and disableable in the ⚙ dialog. Disabling it blocks both new forms and actions on open ones.

Use the existing server-side Anthropic integration for bounded intent interpretation — as new outcomes in each agent's existing structured call (the Tutor's scope check, the Library's answer call), not an extra call. In fixed/mock modes a labelled deterministic heuristic decides. Validate the decision in code before sending a form. Allowed outcomes are answer, clarify, offer_tutoring_request_form, offer_study_room_booking_form (plus “explain how the workflow works”), or out_of_scope, restricted to the receiving service’s actual capabilities.

Prefill is parsed in code from the student’s own words (dates like “tomorrow”/“Friday”, morning/afternoon, a stated time, “for 5 people”, “2 hours”), never taken from model output. Never prefill names, emails or notes. Prefilled values remain visible and editable, and the form says which fields were filled in from the message.

Do not let model output invent workflows, actions, URLs, form templates, room IDs, or available times. Use registered, schema-valid A2UI templates populated with validated data.

Examples:
- “I want to arrange in-person help with calculus” → Tutor sends the tutoring request form.
- “Can I meet a tutor about derivatives tomorrow afternoon?” → Tutor sends the form, prefilling the date and “afternoon”.
- “Explain derivatives” → Tutor answers; no form.
- “How does in-person tutoring work?” → Tutor explains (fixed server text); no form.
- “I want to reserve a group study room” / “I need to schedule a room for study” → Library sends the scheduling form.
- “What are the library opening hours?” → Library answers; no form.
- A bare “I need a room” → the Library asks whether they want a group study room. A following “yes” opens the form: the router sees a short snippet of each service’s reply in its recent turns (so a short answer goes to the service that asked), and the Library remembers its own last few exchanges per conversation.
- “I want tutoring” → ask whether they want an explanation now or an in-person session.
Tell the live model both when to clarify (an unclear target such as a bare “room”) and when not to (missing details are collected by the form; “a room for study” clearly means a study room).

One editable form per workflow per conversation: if one is already open, ask whether to continue it or replace it; “replace the form” supersedes the old one. A repeat of the same chat request (same message ID, e.g. a reconcile) returns the same form, never a second one.

Normal Submit, Cancel, retry/recovery, date selection and final confirmation controls remain appropriate. It is the separate “Request form” shortcut that must disappear.

2. TUTORING REQUEST FORM
Title: “Request an in-person calculus tutoring session”
Description: “Tell us your preferences. This submits a request; it does not book a time.”

Fields:
- First name: required.
- Last name: required.
- Email: required, valid format.
- Preferred date: required (date picker; Monday–Friday, today up to 60 days ahead).
- Preferred time of day: required Morning/Afternoon choice (chips).
- Preferred specific time: optional (time picker).
- Notes: required multiline field labeled “Describe what you’d like help with.”
Show the configured timezone (America/Los_Angeles) and the boundaries (09:00–17:00; morning before 12:00). Validate date, operating hours, and consistency between the selected period and optional specific time. These are preferences, not confirmed appointment availability.

Submit button: “Send tutoring request.” Also a Cancel button.

On valid submission:
- Return the structured values through Student Agent and A2A to the issuing Tutor Agent.
- Tutor validates the form, current enabled workflow and values (code — authoritative).
- Then the advisory review (section 6) may send it back with flags; nothing is recorded while flagged.
- Invoke an allowlisted createTutoringRequest handler once per operation ID.
- Store the request with a request ID and status “Received — awaiting scheduling.”
- Only after successful storage, reply: “We received your request. A time slot will be sent based on your preferences.”
- In the Student chat: the submitted form becomes a read-only “You sent” summary, and the Tutor’s reply follows it as the next message with the receipt (request ID, status, preferences, timezone, demo note). The Tutor panel shows the accepted values, an “Accepted/recorded” entry, then a “Sent” entry with the reply it returned over A2A.
Clearly label this a demo request: no real email or later scheduling message will be sent by this spike. Never display “Appointment booked.”

3. LIBRARY STUDY-ROOM FORM
Title: “Book a group study room”

Fields:
- First name and last name: required.
- Email: required, valid format.
- Group size: required and within room capacity.
- Date: within the configured booking range (up to 14 days ahead).
- Room: from a small fictional room catalog (Room A 4 people, Room B 6, Room C 10).
- Duration (1 or 2 hours) and an available start-time selector.
Show timezone, capacity and duration. Label all availability “Demo availability.”

Availability must come from the server-side fixture and listStudyRoomAvailability handler, never from the LLM. Changing date, room, duration or group size clears the chosen time and refreshes valid slots automatically (only those four scheduling fields are sent); a “Show available times” button does the same. If all four are filled but invalid (e.g. 9 people for a 6-person room), say why no times are shown. If an availability answer arrives after the student already picked a time that is still offered, keep the pick. Slot IDs are opaque, issued per form, and stable for the same time on that form.

“Review booking” returns a readable review screen (a server-sent A2UI update); the final button there is “Confirm demo booking”, with “Back to edit”. The Library refuses a confirmation that didn’t go through review. Merely opening the form, editing a field, or selecting a slot must not reserve anything.

On confirmation:
- Return the structured submission through Student Agent and A2A to the issuing Library Agent.
- Validate the current workflow, form, fields and authoritative slot identity (offered on this form, matching room/date/duration).
- Advisory review (section 6); nothing is booked while flagged.
- Recheck availability and atomically reserve the slot in the local demo store (synchronous check-and-set).
- Generate a booking ID exactly once for the operation.
- Only after success, reply “Your group study room is booked,” with booking ID, room, date, start/end time, group size and timezone, clearly marked “Demo booking” — as the next chat message after the “You sent” summary; the Library panel shows “Accepted”, then “Sent”.
If the slot was taken, report the conflict and offer refreshed alternatives. Do not silently choose another time or room.

4. FORM LIFECYCLE AND FORMS AS CHAT ITEMS
Forms are part of the conversation, never a separate box under it:
- The form appears as a chat item where the agent sent it (“Received from …”), at full chat width.
- On a valid Submit/Confirm it immediately becomes a read-only “You sent” summary of the values, with a compact “Sending request…” / “Confirming booking…” status; the agent’s reply follows it as the next chat message.
- Lookups and review steps stay inside the form (and appear in the agent’s panel), not as chat messages.

Use an explicit lifecycle, owned by the UI server and broadcast as events:
editing → submitting → accepted
editing → submitting → rejected → (Edit and retry) → editing
editing → submitting → editing (flagged by the review: Edit, or Send anyway)
editing → submitting → confirmation_pending → (Check status) → submitting
editing → cancelled | superseded

Behavior:
- Invalid input: keep the form visible with the errors listed (inline errors from the renderer plus a summary). No submission is sent.
- Valid Submit/final confirmation: keep a recoverable snapshot, immediately remove the editable form, show the “You sent” summary and pending status.
- Accepted: the summary stays; the reply with the receipt follows. No active Submit button remains.
- Known rejection or confirmed failure before acceptance: show the reason and an explicit “Edit and retry” (“Choose another time” after a room conflict).
- Flagged by the review: the form comes back with the flags, “Edit” (change and send again — reviewed again) and “Send anyway”.
- Whenever a form is sent back for correction, it comes back **filled with the values that were sent** (after a room conflict: everything except the taken time), including after a page reload or in another tab — the reopen event itself carries the values. A record of the failed attempt stays where it was; the reopened form moves to the bottom of the chat, after the agent’s reply (driven by the reopen event, so a reload rebuilds the same order).
- Unknown outcome or timeout after possible acceptance: show “Confirmation pending” with only “Check status”, which resends the same operation ID. No new submission until reconciled.
- Cancel before submission: remove the editable form and mark it cancelled without calling the action handler. “New conversation” closes open forms the same way.
Distinguish UI removal from data deletion. Retain the records needed for receipts, correlation and deduplication.

5. CORRECT A2UI SURFACE LIFECYCLE
Use A2UI v0.9’s standard `deleteSurface` message (the pinned renderer deletes and disposes the surface) together with the UI server’s lifecycle. Do not invent a standard removal event.

Ensure the renderer actually unmounts the submitted surface and releases its handlers. A delayed UI event must not recreate or reactivate it. Browser reconnect or history replay must reconstruct the current state: the UI server ends its replay with a marker, and only forms still editing at that point are drawn (with their restored values and any review flags).

Assign each form a stable form ID (= surface ID), form version, issuing agent, workflow, conversation ID and operation IDs. Track completed/cancelled/superseded forms. Ignore stale duplicate render events for closed forms. The UI server refuses a form from an agent for another agent’s workflow.

A genuinely new request after completion may create a new form with new identifiers.

6. WHAT THE AGENT DOES WITH SUBMITTED DATA
Separate responsibilities:
- The receiving agent interprets the student’s request and chooses an allowed workflow.
- A2UI describes the interactive form.
- The student provides typed values.
- Server code validates (authoritative) and invokes an allowlisted handler.
- The handler returns the authoritative action result; the agent sends it back through A2A.

Advisory review before recording: after the code checks pass, the issuing agent reviews **every field** — in live mode one structured Claude Haiku 5.5 call that sees the name, email, preferences and notes; in fixed/mock modes a labelled heuristic. It may only **flag** likely mistakes the student would want to fix: contradictions (“afternoons only” but morning chosen), notes unrelated to the form’s purpose, likely email typos (gmial.com, hotmial.com), placeholder values. It never accepts or rejects. Tell the model explicitly what never to flag (an email that doesn’t contain the person’s name, help scheduled before a deadline, values that agree), never to ask to “confirm” consistent values, and to stay silent when unsure; code discards the “email doesn’t match the name” flag as a backstop. Flagged → nothing is recorded; the form returns with the flags. “Send anyway” skips the review only for exactly the flagged values (changed values are reviewed again). If the review call fails, the valid submission continues and the agent’s panel says the review was unavailable.

The LLM does not determine availability, bypass validation, execute Notes text, or invent a successful request/booking. Confirmation fields come from the handler; receipt text is deterministic.

Form actions always go to the issuing agent through the recorded correlation information. Never reroute them based on their Notes field or the latest conversational topic.

7. VALIDATION AND RELIABILITY
   - Validate in the browser, the UI server and the issuing agent from one shared, dependency-free module; the agent is authoritative.
   - Trim required names and reject whitespace-only values.
   - Validate email format without claiming the address exists or is verified.
   - Enforce lengths, formats, date range, weekdays, timezone, operating hours, duration and group capacity.
   - Reject unknown fields/actions, actions from the wrong button, wrong issuer/workflow/form IDs, stale versions and forged or mismatched slot IDs.
   - Recheck current enabled skills before executing an action.
   - Use stable operation IDs. Identical retries return the prior result; reuse of an operation ID with different values is rejected.
   - Prove room-slot exclusivity with an atomic server-side operation and a concurrency test, not only a disabled button.
   - Do not automatically resend on reconnect, refresh, card updates, duplicate UI events or double-clicks.
   - Reconcile uncertain outcomes by operation ID before retrying. Never report a timeout as proof that the action did not happen.
   - Drafts stay in the Student view until submitted. Availability lookups send only scheduling fields. The model review sees all fields (no privacy banner or “never sent to Anthropic” promise in the UI). Agent server logs redact names and emails.
   - Render text safely; never execute arbitrary HTML, JavaScript, URLs or instructions in messages, cards, form descriptions or field values.

8. SPIKE SCOPE
   - Localhost-only services and fictional data.
   - Preserve existing safe API-key configuration. Live use and live verification don't need a separate budget approval step; report calls, usage and cost afterwards. Hand the app over in live mode (mock is for automated tests).
   - Automated tests mock Anthropic (a local fake API for live paths) and make no paid calls.
   - In-memory demo store. Document that a restart clears requests, bookings, forms and deduplication records; no durable guarantees.
   - No real email, calendar invitations, SMS, university systems, payments, account setup, deployment or full Hub/mailbox build.

9. BROWSER EXPERIENCE AND VISUAL DESIGN
Use Anthropic’s frontend-design skill. Direction — a “switchboard”: every line carries the color of the agent that produced it, and position shows direction. One bold idea; everything else quiet.
- Color tokens (light / dark): paper `#EEF1F5`/`#11151B`, surface `#FFFFFF`/`#181D25`, ink `#18202B`/`#E4E8EE`, graphite `#5A6676`/`#98A3B1`; Student cobalt `#2B59C3`/`#86A2FF`, Tutor plum `#8A3FA8`/`#C99AE6`, Library spruce `#16765E`/`#4CC4A0`, router/system ochre `#9A6300`/`#E3B04B`. Follows the system light/dark setting.
- Type: Atkinson Hyperlegible Next for the UI, IBM Plex Mono only for IDs — self-hosted in `public/fonts/` (OFL) so the page makes no third-party requests. Sentence-case labels; no all-caps eyebrows or “A · B” joins.
- Layout: the chat (widest column) and the Tutor and Library panels fill the viewport and each scrolls on its own; the composer is pinned under the chat. In the chat your messages are bubbles on the right, agents’ replies on the left with a rule in the agent’s color, routing notes small and centered. Agent panels are plain log lines (agent color for what it sent, graphite for what it received), with a compact skills box. The activity timeline is a collapsible, numbered strip. On tablets the chat sits on top with the two agent panels below; on phones everything stacks with no horizontal scroll.
- Forms: themed through the renderer’s `--a2ui-*` CSS variables (its controls live in shadow DOM): roomy inputs, chips and buttons; selected chips solid in the student color with readable text in both themes.
- Keep Student, Tutor and Library panels showing actual messages and observable events; technical identifiers and payloads in expandable details. Show real failure and pending states without scripted success animations.

Demonstrate through ordinary typed chat:
- Student asks for in-person help; the Tutor sends the form; the student fills and submits it; it becomes the “You sent” summary immediately; the Tutor records it; its reply with the receipt follows.
- Student asks to reserve a group study room (or says “I need a room”, then “yes”); the Library sends the form; the student picks demo availability, reviews and confirms; the summary appears immediately; the confirmation with the booking receipt follows, in both views.
- A submission with a likely mistake comes back flagged with the values filled in; Edit or Send anyway.

10. ACCEPTANCE TESTS
Preserve Parts 1–5 and test:
- No dedicated Request form buttons or browser shortcuts directly invoke form creation.
- Natural-language action requests trigger the correct receiving agent’s form; prefill only from the student’s words.
- Informational questions do not automatically open a form; ambiguous requests ask for clarification; “yes” after the Library’s question opens the form.
- Disabled/out-of-scope workflows cannot generate or accept forms.
- Both A2UI forms and the availability update validate against the official schemas (with date/time format checks) and drive the rendered forms; `deleteSurface` unmounts the form.
- Valid submission immediately removes the editable surface and displays pending state; invalid input leaves the form visible and sends nothing.
- Success leaves only the read-only summary and the reply with the receipt, with no active duplicate submit control; the agent records first, then sends its reply.
- Known failure can restore entered values through explicit recovery; reopen events carry the values.
- The review: flagged submissions are not recorded and come back with values; “Send anyway” records exactly those values without another review; changed values are reviewed again; a forged acknowledgement doesn’t skip the review; a failed review never blocks; the live review sees all fields; the email/name false positive is discarded.
- Unknown outcomes prevent blind resubmission and reconcile correctly.
- Reconnect/history replay/delayed events cannot resurrect submitted, cancelled or superseded forms.
- Repeated requests do not create duplicate active forms or erase drafts silently; replace supersedes.
- Tutor records exactly one request and never claims an appointment was booked.
- Library uses authoritative fixture availability, requires review, and confirms only after a successful commit.
- Concurrent bookings for the same slot cannot both succeed; the loser gets alternatives without substitution.
- Stale/forged/mismatched selections fail; changing criteria invalidates incompatible slots.
- Duplicate operation handling, form-origin checks, log redaction and provider/service failures work correctly.
Run every scenario end to end in a real browser with Playwright against the live servers — not only happy paths: invalid input, mismatch errors, repeat/replace, cancel, disabled workflow + Edit and retry, New conversation, criteria changes, capacity, a real slot conflict, an offline agent, confirmation pending + Check status, review flags with Edit and Send anyway, and reloads after each closed or reopened state — at desktop and phone widths, in light and dark. If browser testing is unavailable, disclose that limitation rather than claiming visual verification.

Deliver updated source, startup commands, fixture/state documentation, actual test results and a plain-English explanation of intent → form → submission → review → handler → reply and the form lifecycle.

Explain the design before coding. Implement only this bounded enhancement, show verified results, then stop so I can understand Part 6 before we continue.

## Avoid these known problems (found while building this step)

- **Test helpers that wait for a reply must also accept a form.** An agent that answers with a form publishes `form_sent`, not `reply_published`; waiting only for the latter stalls every form test.
- **DateTimeInput `min`/`max` must match the schema’s formats exactly:** `YYYY-MM-DD` for dates and `HH:MM:SS` for times. The schema says `oneOf` date | time | date-time, so with format checking off a date matches two branches and fails. Validate in tests *with* format checks (the project registers date/time/date-time itself).
- **Informational vs. request heuristics:** “Where are the study rooms?” is a plain question, not a booking question — only treat “how do I book/reserve…” as booking info.
- **Confirming without the review step is refused by the Library**, which moves the form to `rejected` (recover with Edit and retry). Tests must review first.
- **“New conversation” closes the old conversation’s open forms** (cancelled, reason `new_conversation`, no handler called). Tests that need several open forms use separate conversations.
- **A repeat of the same chat request must return the same form**, not “you already have a form open” — otherwise reconciling an uncertain chat run breaks. Track which form each request produced.
- **Lifecycle events can arrive just after an HTTP response** (e.g. Edit and retry) — wait for events instead of asserting immediately.
- **Keep check-and-reserve synchronous** (no `await` between the availability check and the write); that is what makes the double-booking test pass. The review runs before it.
- **Tell the live model when to clarify, not only when not to** — and don’t over-correct: with only “missing details aren’t a reason to clarify”, Haiku sent the booking form for “I need a room”; after adding a clarify rule it also questioned “a room for study”. List the phrasings that clearly mean a study room.
- **Short replies need context on both hops.** “yes” to an agent’s question only works if the router sees a snippet of that agent’s reply and the agent remembers its own question for that conversation.
- **Say why no availability appears** when all criteria are filled but invalid (capacity), instead of silently skipping the lookup.
- **Label actions by what they really carry.** Only the availability lookup is “scheduling fields only”; Review and Confirm carry contact details too.
- **Show the agent’s reply, not just its bookkeeping:** a “Sent” entry after “Accepted” in the agent panel, and an ordinary “Received from …” chat message with the receipt. Without it a successful booking looked like the Library never answered.
- **Forms belong in the chat, in order** — a separate form box under the chat put the confirmation above the form. Drive Edit-and-retry reordering from the reopen event so reloads match.
- **Give forms room.** A form inside a short scrolling chat box was impossible to fill: the chat must fill the viewport height and forms use the full chat width.
- **Selected chips must be unmistakable.** The renderer draws a selected chip with the primary color and `--a2ui-color-on-primary` text; overriding only the background made selections invisible.
- **Keep a still-offered slot across lookups**, or a late availability answer silently clears the student’s pick.
- **Keep correction values through a replay.** Values held only in the tab, or dropped while history is replayed before the form is drawn, made reopened forms come back empty after a reload.
- **Haiku over-flags unless told exactly what not to flag** (it asked to “confirm” consistent values and flagged emails that “don’t match the name”); keep the never-flag list and the code backstop, and test the reviewer live with clean and faulty submissions — a reviewer that flags clean forms is worse than none.
- **Watch `switch` fall-throughs.** A `default:` placed above other cases without `break` ran the “skills saved” handler for every form event (“revision undefined”).
- **Contact details must be redacted in agent logs in every mode**, not only live mode (fixed/mock modes log message content for older tests).

---

## Enhancements merged into this step

- **No budget step; ready means live** (your standing instructions): live checks just run and are reported; the app is handed over in live mode.
- **Design decisions made while building**: the model decides only the outcome; prefill is parsed in code; the Part 3 student-details form and `POST /api/forms` are removed; each workflow is its agent’s reserved built-in form skill; the room form refreshes availability automatically; review is a server-sent A2UI update; slot IDs are opaque and per form.
- **Full Playwright pass of every scenario** (your request): run against the live servers; it found and fixed the capacity message, the review/lookup labels and the agent-reply visibility.
- **The Library’s confirmation must be visible** (your report: “no response to confirm came back”): agent panels show “Sent” after “Accepted”, and the Student shows the reply as a normal message.
- **Forms are part of the chat, in order** (your report): the form is a chat item, becomes “You sent” on submit, and the reply follows; “I need a room” → “yes” works via router reply snippets and Library memory.
- **UI redesign with the frontend-design skill** (your request: the form was impossible to fill): the switchboard design in section 9.
- **Model review of every field before recording** (your request), with all privacy items removed from the UI and docs; server-log redaction kept.
- **“Tutor Agent”, not “Calculus Tutor”** (your request): the tutor’s subjects are configurable.
- **Corrections keep the values that were sent** (your request), including after a reload.
