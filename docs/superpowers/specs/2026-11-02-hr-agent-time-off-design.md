# HR Agent — staff time off from the Professor chat (design)

Date: 2026-11-02 · Branch: `HRAgent` · Status: draft for the owner's approval (builder-check answers merged)

## 1. Intent and why

CSUF staff request absences in CHRS ("Requesting/Entering Absences",
https://csuf-erp.screenstepslive.com/m/117407/l/1746491-requesting-entering-absences): portal → Employee
Homepage → CSU Time → Request Absence → Absence Name → Reason → Begin/End Date → Partial Days (All Days /
Start Day Only + hours) → **Forecast** (required credit check) → OK → Comments / Attachment → Submit → Yes →
success message → emails when approved, denied or returned.

The owner's words: *"today's system is too many fields and steps — the goal is to make this as agentic as
possible and simulate how simple the process can be."*

So: Professor Amir says, in his own chat, that he needs time off. The University Hub sends that to a new
**HR Agent** (like the Library Agent), which fills every CHRS field it can from his words, runs the Forecast
itself, and shows **one clean card**. He checks it, fixes anything in place, and presses Submit. HR then
says the request was **sent to his manager** — that's the end of the flow.

## 2. Goals

1. A professor files time off by saying it in the **Professor view chat** — no tag, no separate screen.
2. The **Hub's router** decides it belongs to HR (a new destination with a time-off skill).
3. HR fills the **required fields** intelligently from context, including picking the right **Absence name
   from the CHRS list** (e.g. "my grandmother passed away" → *Bereavement/Funeral*; "I'm not feeling well"
   → *Sick – Self*).
4. One card (approved mockup, §6): every field editable in place, required fields marked, the relevant
   **leave balance** shown before/after, Submit.
5. Something HR can't infer → the card shows that field empty and highlighted **and** HR asks in the chat;
   the professor can answer in either place (chat answer fills the card).
6. After Submit: a receipt in which HR says the request was **sent to his manager** for a decision. No
   manager is simulated (owner: "the HR Agent can just say its sent and that is it").
7. HR serves **staff only**. A student (or anyone not Hub-verified as staff) is refused politely.

## 3. Non-goals (this step)

- No manager: no manager agent, person node or approval/denial. HR's receipt says it was sent; that's all.
- No real CHRS, portal, email, or attachments upload. (Where CHRS would ask for an attachment — e.g. Jury
  Duty — the card says what the manager will need; nothing is uploaded.)
- No other HR services yet. The HR Agent is built so more staff skills can be added later; only
  **time off** is built now.
- No saving to disk (see constraints).

## 4. Anti-goals (would be a failure even if it "works")

- A time-off request — especially sick or bereavement — **posted to students**.
- An absence name, date, relationship or hour count **the professor didn't say and code can't derive**.
- HR acting for a student, or for a staff member other than the Hub-verified one.
- More steps than today's card: no "Change" buttons, no wizard pages, no confirm-again dialog.

## 5. The flow (decided by the owner unless marked *my call*)

```
Professor view chat ──► Professor console: "is this a request for himself as staff?"
     │  yes                      unsure → asks: "File this as time off with HR, tell the class, or both?"
     │                           no → today's behaviour (direct post / @assistant)
     ▼
Professor agent ──signed A2A──► University Hub ──router──► HR Agent (time-off skill)
                                                              │ fills fields, Forecast, card (A2UI)
Professor view ◄── card relayed ◄── Hub ◄─────────────────────┘
     │ edit in place / answer in chat / Submit
     ▼
HR Agent records the request (memory) ──► receipt in chat: "Sent to your manager for a decision"
```

- **Detection** (owner): a message is a staff request when the professor asks for something **for
  himself** ("I want to file for time off", "I need Friday off", "I was sick yesterday afternoon"). It runs
  before a plain message is posted. **If unsure, ask** — never post and never file on a guess.
  *My call:* the check is a model judgement in live mode and a labelled heuristic in mock mode, like the
  other classifiers; it returns `staff_request | class_message | unsure`.
- **"Both"** (owner agreed a leave request must never reach students as written): HR gets the request;
  the class gets only a short neutral note with no reason (e.g. "No class on Friday, Nov 6"), which the
  professor sees and approves before it is posted. *My call* on the mechanism: the note goes through
  today's `@assistant` post path and its checks (no reason, no dates he didn't write).
- **Saved like other messages** (owner: "should be treated like other messages"): the HR exchange (his
  message, HR's question, the card's outcome, the receipt) is kept in the Professor chat exactly as other
  messages are today — saved in `data/professor-outbox.json` and part of the recent chat the Professor's
  model sees. *My call:* the card itself is stored as its outcome text, not as live form state.
- **Identity** *(my call, follows the project's trust rules)*: the professor's staff identity comes only
  from the Hub. The Professor agent sends the request signed with its registration key (as it does for
  lesson publishes); the Hub maps that agent to its staff record (config: e.g. `staff-amir`, "Professor
  Amir", manager) and forwards to HR with a Hub signature over the staff id, as it signs students for the
  Library. HR accepts only a valid Hub-signed **staff** caller.
- **Routing** (owner): the Hub's router sends it to the HR destination. *My call:* a professor-originated
  request may only be routed to staff destinations (HR); a student-originated one never reaches HR — the
  Hub refuses it with plain wording, and HR also re-checks.

## 6. The card (owner-approved mockup)

Approved file, kept in the repo: [`2026-11-02-hr-card-mockup.html`](2026-11-02-hr-card-mockup.html) (a
byte-for-byte copy of the brainstorm file `.superpowers/brainstorm/76555-1793667686/content/hr-card-v4.html`,
which is local and git-ignored). It is version **B's fields** in a **clean layout** with **A's balance bar**.
As built, two things differ from the mockup because of A2UI v0.9: the Absence name is chips (the basic
catalog's ChoicePicker has no dropdown) and the dates are two rows (Begin, End). The Relationship row is
always on the card (a name picked on the card may need it); its star shows only while the chosen name needs it:

- Opening line in plain words ("I'm sorry for your loss. Here's your request. Check it and submit.").
- Headline: the Absence name; one line: when ("Thu, Nov 5 – Fri, Nov 6 · 2 full days"); one line: why
  ("Chosen because you said 'my grandmother passed away'.").
- One row per field, **editable in place** (no "Change" links — the owner: "that is another step"):
  Absence name (dropdown of the CHRS list), Dates (date pickers), Hours (number + "full days" / "from
  12:00"), Relationship (always shown; required only when the absence needs it), Note for manager (optional). A red `*` marks
  fields needed to submit.
- A balance bar for the credit type this request uses (now / after, striped portion = this request), or
  "doesn't use your vacation or sick hours" when it uses none.
- **Submit request** / **Cancel**. Nothing else.

**Fields → CHRS** (*my call* on wording; CHRS names from the CSUF page):

| Card row | CHRS field | How it's filled |
|---|---|---|
| Absence name | Absence Name | model picks from the fixed list; code checks it's on the list |
| Dates | Begin Date / End Date | code reads them from the words ("this Thursday and Friday", "today") |
| Hours | Partial Days + Duration | code: full days × standard day, or a partial day from the words ("leaving at noon" → Start Day Only, 4 h) |
| Relationship | Comments (required for Bereavement and Sick – Family Care / Sick – Bereavement, per CSUN's list) | only words the professor wrote ("my grandmother" → Grandmother) |
| Note for manager | Comments | optional, empty unless he gave one |
| — | Reason | left blank (CHRS: "if applicable") |
| — | Forecast | run by code on Submit and when the card is made; shown as the balance bar |

**Missing information** (owner): show the card with the field **empty and highlighted** **and** ask one
short question in the chat. This includes the **Absence name when he gave no reason** ("I need Friday
off") — HR never guesses Vacation; it leaves it empty and asks (owner: "Leave it to be filled in and the
chat asks for it"). The "Chosen because you said …" line quotes his words exactly (code checks the quote
is in his message); with no quote, the name is left empty. A chat answer fills the card (the Step 11 rule: code reads the value from the
words and the card's own validation runs); typing in the card works too.

## 7. Rules the code enforces (from the CHRS page and CSUN's absence-name list)

- An absence may not **begin or end on a campus holiday**; weekends and holidays inside the range are not
  counted.
- Hours = working days × the person's standard day (8 h in the sample), or the partial hours.
- **Forecast**: enough credits in the matching balance (Vacation, Sick, Personal Holiday); absences that
  use no credits (e.g. Bereavement/Funeral, Jury Duty) pass.
- Relationship required for Bereavement/Funeral, Sick – Family Care, Sick – Bereavement.
- Absence name only from the fixed list. Sample list *(my call: the employee-facing names from CSUN's
  "Absence Names" page, https://www.csun.edu/hr/payroll-operations-administration/entering-time-absences/absence-names,
  labelled "sample list from CSU CHRS")*: Vacation, Personal Holiday, Sick – Self, Sick – Family Care,
  Sick – Bereavement, Bereavement/Funeral, Jury Duty, Professional Development, Military Leave, Dock.
- Policy questions (e.g. who counts as immediate family) are **not** decided by the demo; they're for the
  manager.

## 8. After Submit (owner: "the HR Agent can just say its sent and that is it")

- HR records the request in memory and deducts nothing (the balance shows "after, once approved").
- Receipt in the professor's chat: request ID, absence, dates, hours, and "Sent to your manager for a
  decision." No manager agent, no manager hop on Topology, no approval.

## 9. Constraints

- **HR records in memory only** *(my call, from the owner's loan decision: "I don't want it to be saved
  anywhere because it messes up testing")*: staff, balances and requests live in the HR Agent's memory and
  reseed on start and on **New conversation** (the classroom reset). The Professor chat itself is saved as
  today (owner, §5).
- All project rules in CLAUDE.md apply: 127.0.0.1 only, pinned dependencies, real A2A between agents, A2UI
  for the card, AG-UI/SSE for the screen only; the model proposes, code decides; no hidden retries;
  fictional sample data; never log keys.
- **Privacy**: leave type, relationship and notes are sensitive. Telemetry to the browser follows the Hub's
  allowlist (IDs, status, timing); the inspector shows structure only unless
  `HUB_TELEMETRY_SHOW_CONTENT=1`. HR server logs redact the relationship and notes.
- Modes like the other agents: `HR_MODE=mock` (labelled heuristic, no network) for tests;
  `live` (Haiku via `callModel`, config `model`) for use. `demo:live` starts the HR Agent too.
- Tests use the fake Anthropic server and `startStack`; never touch `data/`.

## 10. What's left to the builder

- Ports, file names, media types, A2UI component layout and the exact model schema.
- How the Professor view renders the A2UI card (reuse the Student side's renderer/forms code where it
  fits).
- How "answer in chat" reaches the open card (reuse Step 11's form-fill approach where it fits).
- Topology drawing of the HR Agent.
- The Step file (both editions), README/CLAUDE.md updates, and syncing the Steps to AgentHub-Exercise.

## 11. Calls I made (for the owner to check)

1. Detection returns `staff_request | class_message | unsure`; model in live, labelled heuristic in mock.
2. Staff identity from the Hub's config + signature, not from the browser or the model.
3. Professor requests route only to staff destinations; HR refuses non-staff.
4. Sample absence-name list from CSUN; Reason left blank.
5. "Both": the class gets a neutral no-reason note the professor approves first, via the `@assistant` path.
6. Everything in memory, reset by New conversation.
7. Only the time-off skill now; HR designed for more staff skills later.
8. The chat keeps the card's outcome text, not live form state.
9. Sample staff record: Professor Amir (`staff-amir`), 8-hour standard day, Vacation 96 h, Sick 120 h,
   Personal Holiday 8 h; sample campus holidays list; manager named only in config text.

## 12. Revision, 2026-11-03 (owner-approved card redesign)

Approved mockup: [`2026-11-03-hr-card-redesign.html`](2026-11-03-hr-card-redesign.html). Real list:
[`2026-11-03-absence-types.psv`](2026-11-03-absence-types.psv) — the owner's “Absence Type and Reasons.xlsx”
(`ABS_TYPE_OPTN|type name|ABSENCE_REASON|reason`), 34 absence names, 51 name + reason pairs. This section
replaces §6's card and §7's sample list where they differ.

**Owner decisions (their words where quoted):**
- The absence name and reason come from the real list; a name repeats because it has several reasons.
- Two fields like CHRS: **Absence name**, then **Reason** listing only that name's reasons. “it needs to be an
  autocomplete dropdown”: both are the A2UI 0.9 **ChoicePicker** (`filterable: true`, `displayStyle: 'chips'`),
  drawn by our CSS + a small open/close script as a closed dropdown that opens into a search box and a list.
  The agent sends a standard ChoicePicker; no custom component, no protocol change.
- Changing the name clears a reason that does not belong to it. A name with one reason, or with a reason worded
  exactly like the name (Vacation → Vacation, Dock → Dock, Other → Other), fills that reason in; it can be changed.
  Bereavement and Sick Leave never get a guessed reason.
- The **Relationship** row is removed: for Bereavement the reason *is* the relationship (e.g. “my grandmother” →
  `GGP` Grandparent/Great Grandparent).
- **“I should be able to read it in no more than 3 seconds.”** The card opens with a shaded summary, top to bottom:
  *what* (absence name; the reason under it unless it repeats the name or is “None”), *when* (dates and length in
  words), *what's left* — one large number “N days of <leave> left after this”, one slim bar scaled to the current
  balance and labelled at both ends (“You have N days now” / “this request: N days”). No legend, no sample maximum,
  no day squares. A name that uses no balance says “<Name> doesn't use your vacation or sick leave.” Days are
  8 hours; quarter days show as ¼ ½ ¾.
- Below the summary, the form (single column, labels on top): Kind of leave (the two dropdowns side by side),
  Dates and hours (first day, “to”, last day, hours), Note for your manager (optional), Submit request / Cancel.
  Submit is disabled until a name and a reason are chosen.
- **Partial days come from the hours** — no field (owner: “cant we determine partial day from the hours?”). For
  N working days and H hours: H = 8N → full days; N = 1 → that one day; otherwise “first day partial, rest full”
  fits when 8(N−1) < H < 8N and “the same hours each day” fits when H/N < 8. When only one fits, use it. When both
  fit, the professor's words decide (“leaving at noon Thursday, out Friday” → first day partial); if they do not,
  HR asks in the chat which one — never guesses.
- **Notices are ⓘ icons** (hover, keyboard focus or tap): next to the note label — “Your manager, your timekeeper
  and Payroll Services can read this note. For anything confidential, talk to your manager directly.”; next to
  the name, only for names needing proof — Jury Duty: summons or certificate of service; Witness: subpoena;
  Military leave: orders. Nothing is uploaded.
- **Sample person**: Professor Amir is a **department chair on a 12-month appointment** (so earns vacation).
  Balances: vacation 96 h (earns 16 h a month), sick 120 h (8 h a month, no limit), personal holiday 8 h (one
  day a calendar year) — rates from CSU sources (CFA contract Art. 24; CSU benefits summary). Credit types:
  `VAC` → vacation, `SCK` → sick, `PHL` → personal holiday; every other name uses no balance.
- **View balances / View requests** (CHRS links) are answered **in the chat**, not on the card: “what's my sick
  balance?”, “show my requests”.
- CHRS fields checked against the reference page: Absence Name, Reason, Begin/End Date, Duration, Partial Days
  (from hours), Forecast (automatic: the summary + HR's check on Submit), Comments (note), Attachment (ⓘ hint
  only), Submit (no second “Yes” — owner's no-extra-steps rule), success message (receipt in chat; no email).
