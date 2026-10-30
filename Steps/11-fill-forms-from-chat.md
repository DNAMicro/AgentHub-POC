# Step 11 — Fill out forms from the chat

> Final state: see `Steps/README.md`. Your Part 11 prompt, in your wording, with the adversarial review and every decision and fix made while building merged into the instructions. Requires Step 10 (AG-UI).

PART 11: FILL OUT FORMS FROM THE CHAT

Your words: “I want to be able to fill out the forms from the chat as well.” Asked what should happen when a form is open and you type something like “November 20”: “it should fill in the date on the form.” Whether the app should ever press the button: “the final click should always be mine.” Which fields: “yes all fields on the form.” The description below: “looks right.”

Continue from Step 10. Inspect the repository first; add to it, don't rewrite.

## 1. What the student gets

- While a form is open in the conversation, the student can type values in the chat instead of clicking into the form — “November 20”, “I'm Alex Student, alex@example.com, mornings work best”, “room B, 2 hours, 4 people”.
- The open form **stays where it is** and its fields update in place. A message that fills the form is **not sent to the university**, so no agent replaces the form. (Seen live: “october 10” while a loan surface was open made the Library generate a new surface and mark the old one “Superseded”.)
- Works for **all fields on all three forms**: the in-person tutoring request (first name, last name, email, preferred date, morning/afternoon, specific time, notes), the study-room booking (first name, last name, email, date, room, duration, group size; the start time once times are shown) and the Library's generated loan-renewal surface (new return date).
- **The app never submits.** The student always presses Renew / Submit / Show available times / Review / Confirm.
- A value the form wouldn't accept (Oct 10 when only Nov 3–23 is allowed; a weekend or out-of-hours tutoring time; a room that doesn't exist; a group too big for the room) is **not** filled in. The chat says why, with the allowed values or range, and the form keeps its current value.
- A message that isn't about the open form is handled as normal chat. A message that both fills and asks (“November 20 — and when is the library open?”) does both: the fill first, then only the question is sent.
- After filling, a short note from the student's own agent says what changed, for example “Filled in: New return date → 2026-11-20.”

## 2. How it works

- **Current values travel in AG-UI's run `state`** (Step 10): when the student sends a chat message, the browser includes each open form's current values in the run input's `state` (`forms.<formId>.values`). The UI server uses them only to decide and check the fill; nothing is trusted at submit time beyond today's validation.
- **Filling is an A2UI `updateDataModel`** that the Student agent builds and sends to the screen inside an AG-UI `CUSTOM` event of the run (A2UI owns the form's data model; `structuredClone` before applying — the renderer mutates what it's given). Nothing goes to the Hub. The run emits a real `form_filled` event (on `/api/events` too, so the hop-by-hop strip shows “filled your form — nothing sent” and Topology draws only the Student's own model call, if any).
- **Which fields:** for the two known workflows, the fields and their rules come from `src/forms.js` (`WORKFLOWS`, `validateFinal`, `validateBookingCriteria`, the hours/weekday/capacity rules); for the generated loan surface, from the surface itself (each input with a data-model path, its label, kind and `min`/`max`). A loan surface with several eligible loans has one return-date picker per loan: fill the one for the loan the student names, or the only one; otherwise ask which loan in one short question.
- **Deciding fill vs. chat** (`src/form-fill.js`, `decideFill`): `STUDENT_MODE=live`: one structured call to the Student's own model (purpose `fill your form from the chat`) with the open forms' non-personal fields (id, label, kind, option labels, limits) and the message returns `chat`, `fill` or `fill_and_chat` (field → value as the student said it, plus the question text). `mock`, `off` and a failed model call: a labelled heuristic — values found and no “?” → fill.
- **Values always come from the code.** In a plain `fill` the whole message is about the form, so every value the code reads is used — the model may skip one (live, it skipped “next Monday”). In `fill_and_chat` the code could read a value out of the question (“…open on Sunday?”), so only fields the model also named, with the same value, are filled (dates/times compared by parsing the model's words; choices by option label or value). Personal fields (names, emails) are filled by code alone.
- **No invented values:** a model value is accepted only if a code parser reads the **same** value from the student's message (dates via `parseStatedDate` — note it moves a past month/day to next year; times via `parseStatedTime`; emails by pattern; choice labels/IDs and numbers; “2 hours” → `["120"]` — choice fields hold arrays), or, for names and notes, if it appears **word for word** in the message. Anything else is dropped and reported.
- **When filling is refused:** only a form in `editing` can be filled — not while submitting, `confirmation_pending`, rejected-awaiting-edit, or a booking already **in review** (in review = the form's current surface — its `a2uiMessages` plus `updates` — has `confirm_button`/`edit_button` and no `review_button`, read with `surfaceButtons`) (the Library confirms the values sent, not the ones shown: a fill there would book details the student never reviewed; the chat says “press Edit first”). Changing the booking's date, room, duration or group size clears the picked start time (`/form/slot`), as clicking does today. The start time can be filled only after “Show available times” has listed the times, by the label shown.
- **Precedence:** a reply chip (↩ Reply to a professor message), a meeting-time pick and a pending clarifying question keep their current meaning; filling is considered only when a form is open and the message is about it.
- **This changes an earlier rule on purpose:** until now names, emails and notes were never prefilled from the student's words (Part 6). Now they may be filled — only into a form the student is looking at, only from the student's own message, never submitted for them. **Names and emails are hidden from the model** (`maskPersonal`: “I am Alex Student, alex@example.com” → “I am [name] [name], [email]”; the name-before-email pattern runs first, because it needs the email). Code alone fills them (“my name is / I am / I'm / this is / name:” + capitalized words, or “First Last, email@…”). This is the privacy-safe default while your decision on sending them to the model is open; allowing it later only removes the mask. Fills aren't stored on the server, so a reload drops them — exactly like values typed into the form today. Filled **values** never appear in server logs, in Hub telemetry or in Agent activity consoles — only the field names.

- **What the student sees:** “You (not sent — used to fill your form)” with their words, then “Your Student agent filled in your form — Filled in: New return date (L-1001) → 2026-11-20. Check the form, then press its button yourself.” (the same note inside the form). A refused value: “Not filled — New return date (L-1001): 2027-10-10 (the next October 10) is outside the permitted range 2026-11-03 to 2026-11-23.” The strip shows “Student checked — filled your form — nothing sent” and every later step skipped; Topology: “Student filled your form from the chat (nothing sent)”. On the booking form a fill of date/room/duration/group size refreshes availability exactly as clicking does.
- **Run state:** the browser sends `state.forms.<formId>.values` (`formsUi.openValues()`) with each AG-UI run; `POST /api/runs` takes `formValues` (tests). The UI server keeps only known forms' plain values.

## 3. Tests and checks

- Unit: fields and rules for each workflow and a generated loan surface (one and several pickers); the value checks (date range, weekday/hours, options, capacity, email); invented values rejected; parser agreement; `fill_and_chat` split; refusal states (submitting, review, pending); slot cleared on criteria change.
- Integration (mock and `off`): with a loan surface open, “November 20” fills the date, nothing reaches the Hub, the form stays `editing`, the note appears, `form_filled` is on both streams; “October 10” fills nothing and explains the range; the student's own Renew click renews once. Same for a tutoring form (name, email, date, period) and a booking form (date, room, duration, group size; a time after “Show available times”). A non-form question while a form is open is sent and answered; a `fill_and_chat` message does both.
- Live with the fake Messages API (labelled plumbing, not judgment) and a real live check on a **separate stack**.
- Full end-to-end playwright-cli run of the whole app (every earlier step's flows too) on a separate stack, then hand the app back in live mode.

## 4. Docs and demos

README (“Fill forms from the chat”), CLAUDE.md (Part 11 notes, including the changed prefill rule), `Steps/README.md`, the classroom edition (`Steps-classroom/11-*.md`), the companion site, `scripts/demo/progression.js` and a live-walkthrough scene. Sync the step files to AgentHub-Exercise.

## Avoid these known problems

- **Read dates the way people type them.** “11/10” with a renewal form open wasn't read (the parser knew only “november 10” and `YYYY-MM-DD`), so the message went to the Library, which replaced the form with an empty one (user report, 2026-10-30). `parseStatedDate` also reads US month/day (“11/10”, “11/10/26”, “11/10/2026”) and “10 November” — never inside math (“x^1/2”, “3/4x”); impossible dates (“2/30”) are none.
- **Don't require the model to confirm what the code read in a plain fill**: live, it skipped “next Monday” and the date was silently not filled. Scope to the model's fields only in `fill_and_chat`.
- **Explain a next-year date**: `parseStatedDate` reads “october 10” after October 10 as next year; say “(the next October 10)” or the year surprises.
- **Name patterns: “I am” is capitalized** (the intro words must match either case; the name words must be capitalized), and mask names before emails.
- **In demo scripts, pin a chat item by index** (`items.nth(i)`): `items.last()` is live and moved to the refusal note, so “click Renew” timed out.
- **Give a fill its own plan line.** The Student console showed a fill's `request_planned` as “Plan: send as-is — No capability chosen; the Hub routes it”, although nothing went to the Hub (found while taking the companion-site screenshots). Handle `action: 'fill'`: “Plan: fill your form — nothing sent”, or “Plan: fill your form, then send your question” when `sent` is `question` (the question then gets its own normal plan line).
- **A booking fill triggers the form's own availability lookup.** Since Part 6 the booking form looks up demo times 0.5 s after date, room, duration or group size change — typed or filled — sending only those four values (no name or email) and reserving nothing. The chat message itself still goes nowhere.
- **Fake Messages API:** `messageReply()` already returns `{ status, json }` — don't wrap it in another `{ json }` (the code then sees a failed call and falls back, which hides the test's intent).

- (Seen live before this step) A chat message while a loan surface was open made the Library generate a new surface and supersede the old one. A filling message is not sent at all.
- (From the review) The surface's own `checks` don't carry the real rules (weekdays, hours, capacity): use the `forms.js` validators for the known workflows.
- (From the review) Never fill a booking in review; clear the start time when the criteria change.
- (Carried) Every hop must understand a follow-up; histories keep the start and end of replies (`briefReply`). Run browser and reset checks on a separate stack, never on the user's running demo.

## Enhancements merged into this step

- **Numeric dates** (2026-10-30, your report): “11/10”, “11/10/2026” and “10 november” fill the open renewal form; “what is the derivative of x^1/2?” is still answered as a question. Checked live in a real browser on your app.
- **Fill plan line fixed** (2026-10-30, your request): the Student console now says “Plan: fill your form — nothing sent” / “… then send your question”. Checked live in a real browser: a renewal fill, a booking fill with a question (the question got its own “send as-is” line), and a plain question (unchanged).

- **Built and checked (2026-10-29):** 183 tests pass (9 in `test/form-fill.test.js`); live on a rehearsal stack: your scenario (“I need to renew my calculus book” → “november 20” fills the date, no new form → “october 10” refused with the range → your click renews to Nov 20), a tutoring request filled from one message and recorded on your click, a booking filled with a question answered while it stays open, and fill + question in one message; the slide demo's Part 11 and the walkthrough's Scene 11.
- **Adversarial review before building** (your request): folded in the run-`state` route for current values, `updateDataModel` for filling, the real validators, the review-stage and slot rules, the invented-value rule, `fill_and_chat`, precedence, `STUDENT_MODE=off`, several loan pickers, and keeping filled values out of logs and telemetry. Defaults taken from your earlier answers: filling and asking in one message does both; no fills during booking review. The names/emails-to-model question was asked; until you decide, they are masked and filled by code.
