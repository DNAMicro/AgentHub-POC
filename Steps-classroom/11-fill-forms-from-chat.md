# Step 11 — Fill out forms from the chat

Time: about 75 minutes. Cost: free (tests use mocks). Optional live check: PAID, a few cents.

## What you'll see when it works

- With a renewal form open, type “november 20” in the chat: the form's date picker shows 11/20/2026. No new form appears, and nothing is sent to the university.
- Type “october 10”: nothing is filled, and the note says the date is outside the permitted range (and that it read “the next October 10”).
- “I'm Alex Student, alex@example.com, next Monday mornings, I need help with the chain rule” fills every field of the tutoring form. You press the button yourself.
- A question while a form is open is answered as usual; “make it 1 hour — and is there a printer in the library?” does both.

## Starting point

Step 10 must be done (AG-UI run input carries `state`). Start from its committed code.

## Instructions for Claude (lead)

Use the three phases from Step 0: Contracts → parallel Build → Join and check.

1. Run `npm test` first and confirm it passes.
2. Write the Phase 1 contracts yourself.
3. Start **all three tasks in the table in ONE message** with the Agent tool.
4. Join, run the checks, fix failures, append the CLAUDE.md notes and commit.

Don't stop to ask questions. Everything you need is in this file and Step 0.

## Phase 1 — Contracts (lead writes these first)

1. **`src/form-fill.js` stub exports:** `FILL_PURPOSE = 'fill your form from the chat'`, `formFields(form, { now })`, `codeFills(text, fields, { now })`, `maskPersonal(text)`, `checkFills(form, fields, fills, current, { now })` → `{ accepted, rejected: [{ field, label, reason }] }`, `fillUpdates(form, fields, accepted, current)`, `fillNote(fields, accepted, rejected)`, `inReview(form)`, `decideFill({ text, forms, values, mode, now, onModelEvent })` → `{ action: 'chat' }` or `{ action: 'fill' | 'fill_and_chat', question, results: [{ form, fields, accepted, rejected, updates, note }], by, model, usage, proposals }`.
2. **Field descriptor:** `{ field, path, label, kind: 'text' | 'email' | 'date' | 'time' | 'choice' | 'number', options?, min?, max?, rule?, personal?, loanId?, words? }`. Tutoring and booking paths are `/form/<field>`. Choice values are arrays. A generated loan surface gives one field per renew button: `returnDate:<loanId>`, the bound picker's path, min and max.
3. **Student event** `form_filled { formId, workflowId, contextId, question, fields: [names], rejected: [{ field, reason }], note, updates, by }`, plus `request_planned { action: 'fill', sent: 'nothing' | 'question', … }`. A fill run ends with state `completed` and `decision: 'student_fill'`.
4. **Browser API:** `formsUi.openValues()` → `{ [formId]: { workflowId, values } }` (editing forms only); `formsUi.fill(formId, updates, note)`.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/form-fill.js` | Fields, parsing, checks, updates, the live decision | `node -e "import('./src/form-fill.js')"` loads |
| B | sonnet | `src/ui-server.js`, `public/forms-ui.js`, `public/app.js`, `src/topology.js` | Wiring, run state, the browser, strip and Topology labels | `node --check public/app.js public/forms-ui.js` |
| C | sonnet | `test/form-fill.test.js` (new) | Tests | Tests pass after the join |

### Task A — `src/form-fill.js`

1. **`formFields`:** tutoring has firstName, lastName, email (`personal`), preferredDate (min today, max +60, weekdays), period (morning/afternoon), specificTime (09:00–17:00), notes. Booking has firstName, lastName, email (`personal`), date (up to 14 days), room (`ROOMS`), duration (`1 hour`/`2 hours` → `'60'`/`'120'`), groupSize, and `slot` only once the surface has a `slot` ChoicePicker (its options). For `loan-renewal`, use every Button whose `action.event` is `renewLoan` with a literal `loanId` and a `returnDate` path bound to a DateTimeInput. `words` = the texts around it, to tell loans apart.
2. **`codeFills`:**
   - email: by pattern;
   - names: `(?:[Mm]y name is|I am|I['’]m|[Tt]his is|[Nn]ame is|[Nn]ame:)` + capitalized words, or `First Last, email@…`;
   - dates: `parseStatedDate`; times: `parseStatedTime`;
   - period: `mornings?` / `afternoons?`; room: `room a|b|c`; duration: `2 hours` / `1 hour`;
   - group size: `N people`, `group of N`, `for N` (not before am/pm/hours);
   - slot: an option label that starts with the time;
   - notes: after `help with` / `notes:`.
3. **`maskPersonal`:** replace names (the name-before-email pattern FIRST, because it needs the email) with `[name]`, then emails with `[email]`.
4. **`checkFills`:** merge the fills into the current values (known fields only) and run `validateTutoringRequest` / `validateBooking`. Accept the fills whose field has no error; the others go to `rejected` with the validator's reason. For loans, the value must be a date within min/max. If the parsed year is later than today's, say “(the next October 10)”.
5. **`fillUpdates`:** one `{ version: 'v0.9', updateDataModel: { surfaceId: formId, path, value } }` per accepted field, plus `/form/slot = []` when a booking criterion changed and a slot was picked.
6. **`inReview(form)`:** the latest `root` component's children include `review_actions`.
7. **`decideFill`:**
   - Live: one `callModel` (400 tokens, structured: `action`, `fills [{ field (enum), value }]`, `question`) with the non-personal fields and `maskPersonal(text)`. Report `model_call_*` with `purpose: FILL_PURPOSE`. On failure, emit `model_call_failed` and fall back to the heuristic (`by: 'model_failed'`).
   - Heuristic: values found and no “?” → fill.
   - **Values always come from `codeFills`.** In a plain fill, use every code value. In `fill_and_chat`, use only fields the model named with the same value (dates/times by parsing the model's words, choices by label or value). Personal fields come from code always. Notes from the model only if they appear word for word in the message.
   - Several loan pickers: fill only the one whose loan id or title words appear in the message; otherwise note “Which loan should get that date?”.
   - A booking in review: an empty update with the note “press “Back to edit” first”.

### Task B — Wiring and browser

1. **`planAndSend`**, after the lesson/course early return: collect the forms of `run.contextId` that are `editing` and not in flight. If there are any and no `run.pending`, call `decideFill` with `run.formValues` and `studentAssistantStatus().mode`.
   - On a fill: publish `form_filled` per result, then `request_planned { action: 'fill' }`.
   - `fill` → `setState(completed, { decision: 'student_fill' })` and return.
   - `fill_and_chat` → set `run.text` and `run.typed` to the question and continue planning.
2. **`formValuesOf(input)`:** known form IDs only, plain string/number values or string arrays. `startChatRun` stores `run.formValues`. `/api/ag-ui/runs` passes `state.forms.<id>.values`; `/api/runs` passes `formValues`.
3. **`formsUi.openValues()`** reads `surface.dataModel.get('/form')`. **`formsUi.fill()`** processes `structuredClone(updates)` on the open surface and shows the note in the form. `startRun` sends `state: { forms: formsUi.openValues() }`.
4. **`handle()` `form_filled`:**
   - chat item “You (not sent — used to fill your form)” with `data.question`;
   - “Your Student agent filled in your form” (or “— about your form”) with the note;
   - `formsUi.fill(…)`;
   - a Student console line (field names only).
   - In the `request_planned` console line, handle `action: 'fill'`: label “Plan: fill your form — nothing sent” (or “Plan: fill your form, then send your question” when `sent === 'question'`), never the default “send as-is / the Hub routes it”.
   - Add `form_filled` to the `answerArrived` list.
5. **Strip** (`flowStep`): `request_planned` action `fill` → “filled your form — nothing sent” (or “filled your form, then sent your question”), and skip the later steps with “not sent — your Student agent filled your form” unless `sent === 'question'`. **Topology labels:** “Student filled your form from the chat (nothing sent)”; `form_filled` → “Student filled N fields of your form”.

### Task C — Tests

Unit (fixed `NOW` = a Thursday):
- fields for each workflow and a generated loan surface;
- `codeFills` for a tutoring sentence, a booking sentence and “November 20”;
- `maskPersonal`;
- a weekend date, an out-of-hours time, a group over the room's capacity and an out-of-range loan date are refused with their reasons;
- the slot is cleared when a criterion changes;
- `inReview`, and back to edit;
- “which loan?” with two loans, and the named one is filled;
- heuristic: “?” → chat; nothing to fill → chat.

Live, against `test/support/fake-anthropic.js` (`respondWith(() => messageReply(JSON.stringify({...})))` — `messageReply` already returns `{ status, json }`):
- `fill_and_chat` returns the question and fills the named field;
- an invented date is dropped;
- personal fields come from code;
- the prompt contains `[email]` and `[name]`, never the real values;
- a plain fill keeps a code value the model skipped;
- `fill_and_chat` doesn't fill a date read from the question;
- a 500 falls back to the heuristic.

End to end (mock stack, `POST /api/runs` with `formValues`):
- a tutoring form is filled from one message with no `request_sent` and no Hub `message_received`, the decision is `student_fill`, then the student's own `submitTutoringRequest` is processed;
- a booking: date, duration and room are filled, groupSize is refused (“holds up to 4”), and a later question is sent to the university.

## Phase 3 — Join and check (lead)

1. `npm run build:ui`, then `npm test`.
2. Live on a separate stack (`node scripts/demo/rehearsal-stack.js --ui 5444 --base 52240`), in a browser:
   - “I need to renew my calculus book” → “november 20” → the date shows 11/20/2026 and no new form appears;
   - “october 10” → refused with the range;
   - press Renew → renewed to Nov 20;
   - then the tutoring and booking flows above.

## Rules that apply to the whole step

- The final click is always the student's. A fill is never sent to the university.
- Values come from code; the model never adds a value the student didn't give.
- Names and emails are hidden from the model.

## Avoid these known problems

- Live, the model skipped “next Monday”: in a plain fill, don't require the model to confirm what the code read.
- In `fill_and_chat`, a date in the question (“…open on Sunday?”) must not be filled.
- “I am” is capitalized; mask names before emails.
- `parseStatedDate` reads a past day as next year: say so in the note.
- In demo scripts, `items.last()` moves: pin a chat item with `items.nth(i)`.
- A fill's plan line must not fall through to “Plan: send as-is — the Hub routes it”: nothing went to the Hub.

## Done when

- `npm test` passes (9 tests in `test/form-fill.test.js`).
- The live browser flows above work, and the console shows no errors.

## CLAUDE.md notes

```
## Step 11 — Fill forms from the chat
- src/form-fill.js decideFill runs in planAndSend before planning when a form of this conversation is editing (not in flight, no pending clarification). Fill = UI-local (no Hub), decision student_fill; fill_and_chat sends only the question.
- Values always from code; the model only decides and names fields (fill_and_chat: model-named fields only). Names/emails masked for the model, filled by code.
- Checked by the form's validators; refused values explained; never fill a booking in review. Updates are A2UI updateDataModel in form_filled.
- The browser sends state.forms.<id>.values with each AG-UI run (formsUi.openValues()).
```

## Show it (optional)

- PAID (a few cents): `env -u ANTHROPIC_BASE_URL npm run demo:live`. Ask to renew your calculus book, type “november 20” in the chat, and watch the date picker. Then press Renew yourself.
