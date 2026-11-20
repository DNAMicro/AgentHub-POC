# Step 21 — Topology that dims what is idle and zooms to what is in use

> Final state: see `Steps/README.md`. This is your Part 21 request, in your own words, with every decision made while designing and building it merged into the instructions. Running it after Steps 1–20 rebuilds the current app.

## Your original request

> create a branch called TopologySimplification … brainstorm ways to keep the full Topology but make only the items used prominent … (then, on the mockup) I want another option that is a combination of c and E … when I select a lens it should show the objects related to it and the diagram should zoom to show that only so people can read it. then when I start it it will show things highlighting like before. if I dont select a lens things are dimmed just like now and when I select to run a scenario the diagram zooms again to show the related objects connecting … implement option F but keep the same dynamic nature as today’s make sure the zoom is as much as possible to enable clear reading

## Your decisions while designing it (merged into the instructions below)

- You chose version F of the mockup `docs/superpowers/specs/2026-11-14-topology-simplification-mockup.html` (“Lenses that zoom in”).
- It stays live: nothing is scripted. The frame follows the events the agents really report, exactly as the pulses do.
- The zoom is as tight as the parts allow.

## Instructions

1. **Keep the whole Topology** (same 17 parts, same places, same pulses, pills, details and event list). Only two things are added: dimming and zoom.
2. **At rest** every part is drawn quiet: grey, half strength, still named (`data-quiet="true"`, `svg[data-focus="rest"]`). **A part with a problem is never quiet** (status `unreachable`, `invalid_card`, `stale`).
3. **Two side buttons** in the Topology toolbar (`.topo-lenses button[data-lens]`, `aria-pressed`): “Student services” (Student, Hub, Tutor, Library, Faculty and their model boxes) and “Staff services” (Hub, Faculty, HR, Campus Agent, their model boxes and the three record systems). Pressing one puts its parts in colour, steps the rest back (opacity 0.2) and zooms until that side fills the frame. Pressing it again shows everything.
4. **Live traffic with no side chosen:** every part a drawn pulse touches (never heartbeats) goes into colour and the frame closes in on the parts touched so far, growing hop by hop (`svg[data-focus="run"]`). It stays for 6 s after the last hop (`RUN_LINGER_MS`), longer while something is still working (the Student is waiting, the Hub is relaying, a model or tool call is in flight), never more than 45 s without a hop (`RUN_MAX_MS`); then it returns to rest.
5. **Traffic with a side chosen:** if every part touched is inside the side, the side stays and the pulses play inside it. If not, the side is switched off and the frame follows the traffic.
6. **A selected trace** frames its own parts (its existing dimming is kept). Selecting a trace that does not fit the chosen side switches the side off.
7. **“Zoom to activity”** tick box (`#topo-zoom`, on by default): off keeps the full picture and only dims.
8. **How the zoom works:** only the SVG's `viewBox` changes (animated 550 ms, snapped with Reduce motion or the system setting). No part moves. The frame is the tightest box around the parts, including each part's status pill and caption, plus 12 units; a lone part gets at least 420 × 320 (`public/topology-focus.js`: `LENSES`, `inLens`, `extent`, `frameOf`; pure, no DOM).
9. **Tests:** `test/topology-focus.test.js` (the two sides' members, frames hold every part and stay inside the drawing). Look at it in a browser on a separate rehearsal stack: rest, both sides, a student request, a staff request, a trace, dark mode.

## Avoid these known problems

- Don't frame from a scripted list of stops: the live page only knows a stop when its event arrives. Grow the frame from the pulses.
- Count a part as touched when its pulse is **drawn** (after the 350 ms buffer), not when the event arrives, or the frame moves before the pulse does.
- Heartbeats must not start a zoom, or the frame never rests when “Show heartbeats” is on.
- A model call can take many seconds with no pulse: don't zoom out while something is still in flight.
- Read the full frame from the SVG's own `viewBox` attribute (`0 0 1100 1285`); `scripts/browser-checks/peoplesoft.js` checks that value at rest.
- The quiet rule must not also apply while a trace is selected (`.topo:not(.tracing)`), or the trace is dimmed twice.
- A request that crosses the whole map (Student → Hub → Tutor and its model) is about as wide as the drawing, so in the narrow Side by side column it gains little; the full Topology tab gains more. Closer zoom there needs a tighter layout of those parts.

## Enhancements merged into this step

- None yet.
