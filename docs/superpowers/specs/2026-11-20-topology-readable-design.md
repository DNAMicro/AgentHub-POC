# Topology: a readable map with filters by function — design

Date: 2026-11-20 · Branch: `TopologySimplification` · Status: waiting for the owner's approval
Mockup: `docs/superpowers/specs/2026-11-20-topology-readable-mockup.html` (Way 4, with “Show one function”)

## Why

The audience is most impressed when they see how the services are connected and then watch the map come alive
when a message is sent (owner, 2026-11-20). Today's map gets in the way of both:

- In the Side by side view the drawing is shown at 56% of its size. Agent names come out at 8.3 px.
- 76 pieces of text are on the map at rest.

Part 21 (dim idle parts, zoom by cropping) did not fix this. The owner: “I am still not happy with the zoom or
how we reduce complexity without loosing the details that makes this demo so powerful”. Cropping removes the
connected campus at the moment it comes alive, and the parts of one request are too far apart for a crop to
enlarge the text.

## Goals

1. The whole campus stays on screen, connected and in colour, at all times.
2. Names are readable in the Side by side view: about 16 px (measured in the mockup: 15.7 px).
3. At rest the map is calm: one name per part (25 pieces of text in the mockup).
4. Nothing is lost: every detail shown today is still one action away, and appears by itself when a part is in use.
5. The call to a model is still a hop you can watch travel along a line.
6. A presenter can bring one function forward (for example Time off) without hiding the rest.

## Not goals

- No zoom that follows live traffic, and no grey rest state. The frame moves only when the presenter chooses a function.
- No scripted or inferred animation: pulses still come only from real, server-labelled events.
- No change to the events, the labels, the side list, traces, or the details panel's content.
- No new server code. This is browser-only (`public/`).

## Anti-goals (would make this a failure)

- A part with a problem that looks healthy because its status is hidden.
- A request whose parts stay faint because a filter is on.
- Text that overlaps a neighbour while a request runs.
- A model name or “AI” wording on a person-facing screen (Topology may show model names; nothing else changes).

## Approaches considered

| Way | What | Names | Text at rest | Outcome |
|---|---|---|---|---|
| Part 21 | Dim idle parts, crop to activity | 8.3 px at rest | 76 | Rejected by the owner |
| 1 | Names only at rest, nothing moves | 11.7 px | 25 | Gain too small |
| 2 | Tighter map, models as badges, all text stays | 11.2 px | 55 | Liked for the visible model |
| 3 | Tighter map + names only, models as badges | 15.7 px | 18 | Liked for the simple labels; model call too small |
| **4** | **Tighter map + names only + a small model box with a line** | **15.7 px** | **25** | **Chosen by the owner** |

Owner: “I like a combination of 2 and 3 … On the model I still want to see when the message is sent to it like we
had before but the box can be small and no details in it”, then “give me the full design now with filtering
based on function”.

## The design

### 1. The map (layout)

`viewBox 0 0 845 959` (was `0 0 1100 1285`). Positions, centre x / y:

| Part | x | y | Its model box |
|---|---|---|---|
| Student agent (r 60) | 95 | 479 | 95, 330 |
| University Hub (r 76) | 312 | 479 | 312, 312 |
| Tutor Agent (r 56) | 545 | 105 | 675, 25 |
| Library Agent | 545 | 292 | 675, 212 |
| Faculty | 545 | 479 | 675, 399 |
| HR Agent | 545 | 666 | 675, 586 |
| Campus Agent | 545 | 853 | 675, 773 |
| Canvas LMS (tile 184 × 80) | 748 | 479 | — |
| PeopleSoft CHRS (HR) | 748 | 666 | — |
| PeopleSoft Campus Solutions | 748 | 853 | — |

- Each record system sits beside the agent that uses it, on the same row. The MCP line is short and horizontal.
- Each model is a small box (86 × 34): a sparkle and the word “Model”. Nothing else is written in it.
  A dashed line joins it to its agent, with one lane each way, and pulses travel on it as today.
- The 16 connections and their meaning do not change.
- The earlier anti-goals stay: no `llm-` box for a record system, no circle or orbit on a tile, no step names.

### 2. What is written on a part

| | At rest | Shown as well when “revealed” |
|---|---|---|
| Agent | Name, large (two lines where needed), green ready dot | Status pill; role line (on pointing only) |
| Hub | “University Hub”, ready dot | Status pill; role |
| Record system | Name, ready dot | Status pill, “MCP SERVER” |
| Model box | “Model” | Busy look only (marching outline, sparkle) |
| Line | No label | “A2A” or “MCP” (model lines are never labelled) |

A part is **revealed** when any of these is true:

1. It is in use: a drawn pulse touched it, until 6 s after the last hop, or longer while it is still working
   (45 s at most). Heartbeats never count.
2. The pointer is on it, or it has keyboard focus, or it is the selected part.
3. Its status is not healthy (`unreachable`, `invalid_card`, `stale`, `disconnected`, `disabled`, `unknown`; a
   record system that is not `connected`). A problem is always written out and its ready dot is replaced by the pill.
4. It belongs to the chosen function (section 4).
5. “Show all details” is ticked (section 5).

The caption that flashes above a part during a request stays. For a model call, the caption sits on the agent
(for example “Reading the absence”), because the small box carries no words.

Everything removed from the map is still in the details panel when a part is clicked: role, heartbeat age, model
name and mode, the uses of the model, session state, tools, the latest events.

### 3. Coming alive

Unchanged from today: pulses, lit lanes in the sender's colour, the busy orbit, the tile's sweep and sparkle, the
status pill's “working” text, the 350 ms buffer and ordering. The only additions are the reveal rule above and its
fade (0.25 s, none with Reduce motion).

### 4. Filter by function

A row of buttons in the Topology toolbar (replaces “Student services / Staff services”), one pressed at a time:

| Button | Parts (each agent's model comes with it) |
|---|---|
| Everything (default) | all |
| Tutoring | Student agent, Hub, Tutor Agent |
| Library | Student agent, Hub, Library Agent |
| Course and quizzes | Student agent, Hub, Faculty, Canvas LMS |
| Time off | Faculty, Hub, HR Agent, PeopleSoft CHRS (HR) |
| Class roster | Faculty, Hub, Campus Agent, PeopleSoft Campus Solutions |

- The chosen function's parts are revealed (status and role written out) and their lines labelled.
- **The frame zooms in on those parts** (owner, 2026-11-20: “zoom should still happen when I select a function”).
  Only the `viewBox` is animated (550 ms, snapped with Reduce motion); nothing is redrawn or moved. The frame is the
  tightest box around the function's parts, their pills and captions, kept inside the drawing.
- Every other part stays in its place, faint and grey (opacity 0.22). Those inside the frame are still visible.
- **Truth wins over the filter:** a part that is really in use is never faint. A part with a problem outside the function is a silhouette like the rest, with its status still written, faint (owner, 2026-11-20, after the first build left every unhealthy part in colour). When a drawn
  pulse touches a part outside the chosen function, the filter switches off and the frame returns to the whole
  campus, so nothing in use is ever off screen.
- Pressing the chosen button again, or “Everything”, clears it. The choice is not saved between page loads.

Agent name size measured in the mockup (Side by side frame, 630 × 715; today's map shows 8.3 px):

| Function | Name size | Against the whole new map (15.7 px) |
|---|---|---|
| Everything | 15.7 px | — |
| Tutoring | 18.3 px | 1.17 × |
| Library | 18.3 px | 1.17 × |
| Course and quizzes | 15.9 px | 1.01 × (its parts span the full width, so there is nothing to crop) |
| Time off | 21.0 px | 1.34 × |
| Class roster | 21.0 px | 1.34 × |
- A selected trace keeps its own highlight as today and takes over from the filter while it is selected.

These six are my proposal for what “function” means. The lists are one table in code and easy to change.

### 5. Toolbar

- New tick box “Show all details”, off by default: every part is revealed, for a technical audience.
- Removed: “Zoom to activity”.
- Kept: Show heartbeats, Reduce motion, Pause animation, Trace.

### 6. Where it applies

Both the Side by side view and the full Topology tab use the same map and the same rules. In the full tab the
stage is larger, so the same map is simply drawn larger. The stacked layout at 1100 px and below is unchanged.

## What changes in code

- `public/topology.js`: new positions and `viewBox`; small model box; two-line names; ready dot; reveal rule in
  `renderNodes` / `pulse`; the viewBox animation now runs only for a chosen function; remove the run-mode zoom, the
  rest-state dimming and the two side buttons.
- `public/topology-focus.js`: the function table and `inFunction(id)`; `frameOf` and `extent` stay, updated for the
  new shapes (small model box, role line under the pill).
- `public/index.html`: `viewBox`, the six filter buttons, “Show all details”.
- `public/styles.css`: larger name sizes, reveal and fade rules; remove the Part 21 quiet rules.
- `public/app.js`: wire the new controls.
- `test/topology-focus.test.js`: rewritten for the function table.
- `Steps/21-…md`, `Steps/README.md`, `CLAUDE.md` Part 21 notes: rewritten to this design.

## Checks before it is called done

- Measured in the real app: agent names at least 15 px in Side by side on a 1680 × 980 window.
- Screenshots looked at: rest, each of the six filters, a live student request, a live roster request, a live
  time-off request, dark mode, the full Topology tab, a specialist stopped (problem shown at rest).
- No text overlaps a neighbour during those requests (the mockup still has two near-misses to fix: the “MCP” label
  beside a tile, and a role line close to the next model box).
- `npm test` in full, and the browser checks that read the Topology (`peoplesoft.js`, `canvas-quiz.js`,
  `chrs-roster.js`) on a separate rehearsal stack. Both demo scripts read the Topology and are rehearsed after.

## Risks

- The line to a specialist's model is short (about 45 units), so that pulse travels a smaller distance than today.
- The layouts approved in Parts 15, 16 and 17 change. Their mockups will no longer match the app.
- Browser checks or demo scenes that expect a status pill to be visible at rest may need “Show all details” ticked.

## Left to the builder

Exact font sizes per name, the fade timings, and the fine placement of line labels, provided the checks above pass.
