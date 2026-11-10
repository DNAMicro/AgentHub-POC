# Step 20 — Side by side: Student, Topology and Faculty in one view

> Final state: see `Steps/README.md`. This is your Part 20 request, in your own words, with every decision made while designing and building it merged into the instructions. Running it after Steps 1–19 rebuilds the current app.

## Your original request

> Many times for presentation purposes we show the student and faculty with the topology together propose a view that can show the three next to each other. student should be on the left, topology on the middle and faculty chat on the right. Also rename the conversation menu to student since conversation is ambiguous. This will enable someone to see the process in its entirety in one view. This should be the default view. Keep the individual links still.

## Your decisions while designing it (merged into the instructions below)

- You approved the mockup: `docs/superpowers/specs/2026-11-10-side-by-side-mockup.html`.

## Instructions

1. **A new first tab “Side by side”** (`#tab-trio`, `href="/"`, `aria-controls="view-conversation view-topology view-professor"`). It is the default: `/` and `/side-by-side` open it, and sign-in sends people there (`DEFAULT_NEXT = '/'` in `src/auth-gate.js`). It has no panel of its own; it shows the three existing views at once, all live: type as the student on the left, as Dr. Dabirian on the right, and watch each hop in the middle.
2. **“Conversation” is renamed “Student”** (`#tab-conversation`, `href="/student"`). The old addresses still work: `/conversation` → Student, `/professor` → Faculty view (`ALIASES` in `public/app.js`). `/activity`, `/topology`, `/faculty` are unchanged. The UI server serves `index.html` for `/side-by-side`, `/student`, `/conversation`, `/activity`, `/topology`, `/faculty`, `/professor`; the sign-in gate lists them as pages.
3. **Layout** (`public/styles.css`, `body[data-layout="trio"]`, set by `showTab`): the views sit in `<main class="desk">`, a three-column grid `minmax(300px, 1fr) | minmax(380px, 1.35fr) | minmax(300px, 1fr)`, ordered Student, Topology, Faculty, filling the window height (columns scroll inside). Each column has a small head (“Student — what the student sees”, “Topology — every hop, live”, “Faculty — what the faculty member sees”) with an “Open ↗” link to its own view in a new browser tab (“Open full Topology ↗”). Left out here (each is on its own view): the Hop by hop strip, the Topology's Details/Events list and its full legend (replaced by one short legend line). Narrow columns put each panel head's description on its own row. Below 1100 px the three stack (chats 80 % of the screen high, the Topology 75 %).
4. **What “shown” means.** `showTab` un-hides every panel in the tab's `aria-controls`; the Topology's tab dot is cleared when the Topology is visible, and the Faculty view's “shown” hooks (`classroom.professorShown`: names, @-suggestions, quiz key) run whenever the Faculty column is visible — so they also run on the default page (only signed-in people see it). `showConversation` / `focusComposer` switch tabs only when the student view is hidden.
5. **Guide** (`public/guide.html`): the app opens Side by side; the Student section says “Student tab (or the left of Side by side)”.
6. **Tests:** `test/ui.test.js` (the tab links, `/` selects Side by side, every address serves the page), `test/auth.test.js` (sign-in goes to `/`).

## Avoid these known problems

- In the stacked layout (≤ 1100 px) give every column an explicit height and turn off `flex: 1` / `min-height: 0`; otherwise the Topology and Faculty columns collapse to nothing and their heads overlap.
- Don't look a tab's panel up with `getElementById(aria-controls)`: Side by side controls three panels — split the attribute.
- Narrow columns squeeze the panel heads' three-column grid into one word per line; move `.role` to its own row in the trio layout.

## Enhancements merged into this step

- None yet.
