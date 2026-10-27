# Live demo, version 2 — design

Date: 2026-10-27. Status: draft for approval.

## Intent and the why

The audience is a room of **students who will rebuild this project themselves**, running the `Steps/` prompts one at a time. Before (or while) they do, the presenter shows them what the finished app does, step by step, so they know what each prompt is aiming at.

The first demo (`scripts/demo/progression.js`) missed: it was **slides and captions**, not someone actually using the app. Version 2 must look like **a real person using the real app**: the mouse moves to a field, clicks, types at human speed, presses Send, waits, scrolls, fills in a form field by field, switches tabs. The presenter talks over it live; the screen does not explain itself.

The architecture is the point of the course, so **every message must be seen travelling through the Topology view as it happens** (Student → Hub → Tutor / Library / Professor, and each agent's own model box).

## Goals

- A real, live walkthrough of the finished app, in Step order 1 → 9, using the major scenarios below.
- Two browser windows **side by side**, both visible all the time:
  - **Left:** the app at `/conversation` (and `/professor`'s tab — whichever tab the scenario needs). All typing, clicking and form filling happens here.
  - **Right:** the app at `/topology`, animating each hop at the moment it happens.
- A small, unobtrusive **step label** (e.g. “Step 6 · Workflow forms”) so students can see which Step each moment belongs to.
- **Presenter-paced:** after each *moment* (one human action and the app's response to it) the demo stops and waits for the presenter's key press (→ / PageDown / clicker). It never advances on a timer.
- Human-like input: visible mouse movement to the target, real clicks, per-character typing at a readable speed, natural short pauses before Send.
- Runs against the live app (`npm run demo:live`), real model calls.

## Non-goals

- Not every scenario — the **major** ones only (list below).
- No narration text on screen: the presenter talks.
- No showing an agent going offline (it would mean killing a server mid-talk). Left out by the designer's call; the presenter can raise it.
- No changes to the app itself to make the demo work (the demo drives the app; it does not alter it).

## Anti-goals (a failure even if it technically works)

- Full-screen slides, title cards, caption/explanation boxes or spotlight overlays covering the app. (This is exactly what v1 got wrong.)
- Faking anything: injected events, pre-recorded replies, calling HTTP/API endpoints instead of using the UI, setting input values directly instead of typing. If a person couldn't do it with mouse and keyboard in the app, the demo doesn't do it.
- Running ahead of the presenter.
- The Topology window missing the start of a flow (e.g. because it was hidden or the demo switched to it late).

## The scenarios (major ones, in order)

| Step | What the “person” does on screen (left), while Topology (right) animates |
|---|---|
| 1 · A2A connectivity | Asks a simple question. Then opens **Agent activity** to show the real A2A message out and reply back. |
| 2 · Browser monitor | Asks another question while the hop-by-hop strip lights up step by step. |
| 3 · A2UI form | Gets a form; types a **bad email** → the form shows its error; fixes it; submits; the form becomes its “You sent” summary. |
| 4 · Haiku tutor | Asks a real tutoring question, then a follow-up that only makes sense with history (“can you give me an example of that?”). |
| 5 · Routing, skills, scope | Asks a library question → routed to the Library. Asks something off-topic → politely declined. Opens the **skills editor**, adds a fact to a skill's answer content, saves, asks again → the new answer uses it. |
| 6 · Workflow forms | “I want to reserve a group study room” → form prefilled from their words → picks a slot → review → confirm. Then a tutoring request where the advisory review flags something → presses **Send anyway**. |
| 7 · Hub and topology | Asks a vague question → the Student's own model asks a clarifying question → the person answers → the hops animate to the chosen service. |
| 8 · Generated loan UI | “Show my borrowed library books” → the Library's model builds the screen → renews a loan → opens the Generated UI inspector. |
| 9 · Professor | Switches the left window to the **Professor** tab and posts a lesson to the class → back to the student: inbox toast, opens the lesson, asks about it. The professor messages Alex; Alex replies (↩ Reply). The professor uses `@assistant` to offer meeting times; Alex picks one. |

Topology shows the forward route (Student → Hub → specialist) for Steps 1–8 and the reverse route (Professor → Hub → Student) in Step 9.

## Decided by the user

- Audience: students rebuilding from the Steps prompts.
- Each moment shows **which Step** it belongs to.
- **Real use of the app**, not slides and captions.
- The presenter **talks over it live**.
- **Major scenarios**, not every one; the list above (presented by the designer, user added the topology requirement and did not strike anything).
- Topology flow visible as it happens, **side by side** with the app.
- **Wait for the presenter's key press after each moment.**
- **One key press = one meaningful result** (e.g. "asks for tutoring, form appears"; "fills name + bad email, clicks Submit, error shows"; "fixes email, submits, form becomes You sent"), about 3–6 presses per step. Chosen by the user on 2026-10-27.
- **Make it a version 2**: keep `scripts/demo/progression.js` (v1) as it is; v2 is a separate script.

## Designer's calls (not confirmed by the user)

- (Moved to "Decided by the user": one key press = one meaningful result.)
- Keys: → / PageDown / Space = next moment; `N` = skip to the next step; `H` = toggle hold (while held, only `H` is accepted). The pre-talk loan reset is a separate command that restores `data/library-loans.before-e2e.json`. Step 5's skill edit is undone on screen at the end of the scene.

- Live models: every scene must cope with the model answering differently (answering in words where a form was expected, asking a clarifying question, declining). The demo carries on with what the app actually did — it never fakes the expected outcome. If a moment fails outright, it stops at that moment (as always, waiting for the key) so the presenter can talk through it, then continues with the next step.
- Step label: small, in a corner, outside the app's working area; never covers controls. It is the only addition on screen besides the visible mouse cursor.
- A visible mouse cursor indicator is drawn (headed Chromium doesn't show automation's pointer), so students can follow where the “person” is about to click.
- Fresh start by default: presses **New conversation** at the beginning (which also resets the classroom, as in v1), so every run starts clean. An option keeps the current conversation.
- Step 8 renews for real. Renewals run out (2 per loan); when no loan is renewable the app explains why, and that is shown as-is (still a real scenario).
- Steps 1–4 run on the final app, so the Hub is always in the path. The presenter explains that live (“this is where it ends up”).
- Name: `scripts/demo/live-walkthrough.js` (v2); README gets a v2 section alongside v1; CLAUDE.md's “Audience demo” note and `Steps/README.md`'s rule mention both.
- Options in the query string like v1 where useful (`from`, `to`, `fresh`, typing speed).

## Constraints

- Drive the browser with **`playwright-cli`** like v1 (`run-code`), against the user's running live stack on `127.0.0.1:4444`. All servers stay on `127.0.0.1`.
- Rehearse **on a separate stack**, never the user's running demo (fresh start resets the classroom). Look at screenshots of every moment before handing it over (evidence rule in CLAUDE.md).
- Only real UI actions. No `fill()`-style value injection for text the person types; type character by character.
- Respect existing app rules: the browser renders text via `textContent`; the demo doesn't modify the app's DOM except its own overlay layer (step label, cursor, presenter key handling).
- Fictional data only (Alex Student, alex@example.com).
- Two windows side by side need window positioning (e.g. CDP `Browser.setWindowBounds`) so both fit one projector screen.

## Left to the builder

- Exact wording typed in each scenario (keep it natural and short; must reliably trigger the intended behaviour live, e.g. the Hub's routing and the review flag in Step 6).
- Typing speed and mouse movement style.
- How the presenter key reaches the script when focus is in either window.
- Window sizes for a 1920×1080 projector, and how the Topology window is kept readable.
- How to detect “the moment is finished” for each scenario (the app's own signals: reply rendered, form state, run idle, topology hop finished).
