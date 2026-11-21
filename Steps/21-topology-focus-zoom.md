# Step 21 — A Topology you can read: one name per part, filters by function

> Final state: see `Steps/README.md`. This is your Part 21 request, in your own words, with every decision made while designing and building it merged into the instructions. Running it after Steps 1–20 rebuilds the current app.

## Your original request

> create a branch called TopologySimplification … brainstorm ways to keep the full Topology but make only the items used prominent … implement option F but keep the same dynamic nature as today’s make sure the zoom is as much as possible to enable clear reading … I am still not happy with the zoom or how we reduce complexity without loosing the details that makes this demo so powerful … the audience is most impressed when they see how the services are connected together and then become alive when a message is sent … looks too busy and very hard to read the text … I like a combination of 2 and 3, 2 for showing the model more promenantly and 3 for making labels simple. On the model I still want to see when the message is sent to it like we had before but the box can be small and no details in it … give me the full design now with filtering based on function … zoom should still happen when I select a function

## Your decisions while designing it (merged into the instructions below)

- The whole campus stays on screen, connected and in colour. No grey rest state, no zoom that follows traffic.
- You chose Way 4 of the mockup `docs/superpowers/specs/2026-11-20-topology-readable-mockup.html`; design `docs/superpowers/specs/2026-11-20-topology-readable-design.md` (approved 2026-11-20).
- Each model is a small box that says only “Model”, with a line the pulse travels along.
- Six filters by function; choosing one zooms to its parts.

## Instructions

1. **A tighter map, shaped like its panel:** `viewBox 0 0 845 959`. Student agent (105, 468) and University Hub (312, 468) on the left; the five specialists in a column at x 530, 184 apart (y 100, 284, 468, 652, 836). Each record system (tile 184 × 80) sits beside the agent that uses it, at x 744 on the same row. Each agent's model is a small box (86 × 34): above the Student (105, 319) and the Hub (312, 301), and up and to the right of each specialist (675, y − 74). The 16 connections do not change. No model box for a record system, no circle or orbit on a tile, no step names.
2. **At rest a part shows its name and a green “ready” dot.** Agent names are large and on one or two lines inside the circle (`big` in `NODES`; 21 px, Hub 23 px). A model box shows a sparkle and the word “Model”, nothing else; its model name and call state stay in its label and the details panel, and a problem shows as the box's colour.
3. **The small lines are written out when a part is revealed** (`data-reveal="true"`): the status pill, a tile's “MCP SERVER”, the “A2A” / “MCP” label on a line (model lines are never labelled). A part is revealed when (a) a drawn pulse touched it — never a heartbeat — until 6 s after the last hop (`RUN_LINGER_MS`), longer while something is still working, 45 s at most (`RUN_MAX_MS`); (b) it is not healthy (any status but `ready`); (c) it is selected; (d) it belongs to the chosen function; (e) “Show all details” (`#topo-details`) is ticked; and, in CSS, while the pointer or keyboard focus is on it. Role and heartbeat sit on one line under the pill (`.node-more`, `data-more`): shown for (c), (d), (e) and pointing only.
4. **Coming alive is unchanged:** pulses only from server-labelled events after the 350 ms buffer, lit lanes, busy orbit, the tile's sweep. Captions sit in a top layer (`#topo-captions`) so a neighbour never covers them; a model call's caption is said by its agent, because the box carries no words.
5. **Filter by function** (`.topo-functions button[data-function]`, `aria-pressed`; table `FUNCTIONS` in `public/topology-focus.js`; each agent's model comes with it):

   | Button | Parts |
   |---|---|
   | Everything (`data-function=""`) | all |
   | Tutoring | Student agent, Hub, Tutor Agent |
   | Library | Student agent, Hub, Library Agent |
   | Course and quizzes | Student agent, Hub, Faculty, Canvas LMS |
   | Time off | Faculty, Hub, HR Agent, PeopleSoft CHRS (HR) |
   | Class roster | Faculty, Hub, Campus Agent, PeopleSoft Campus Solutions |

   Choosing one reveals its parts, fades the others in place (`data-quiet="true"`, opacity 0.22, grey) and **zooms the frame to its parts**: only the `viewBox` is animated (550 ms, snapped with Reduce motion), to the tightest box around the parts with their pills and captions (`frameOf`, `extent`). Pressing it again, or Everything, shows the whole campus.
6. **Outside the chosen function every part is a silhouette** (grey, faint), whatever its status: a stopped agent outside the function is a faint shape with a faint “Not registered”, not a coloured one. Only real use brings a part back.
7. **The filter follows the request.** Once the presenter has chosen a function, a drawn pulse (or a selected trace) that touches a part outside it moves the filter, and the zoom, to the one function those parts fit (`followTo`, `fitting` in `public/topology.js`): Tutoring is chosen, the student asks a course question, the filter becomes “Course and quizzes”. The parts touched since the last switch are remembered (`focus.trail`); when no function fits them all it is a new request and only the latest hop counts. While several functions fit (Faculty → Hub alone fits three) or none does, the whole campus shows and the filter keeps following, closing in as soon as one fits. A sign-in, sign-out or card change never picks a function; outside the chosen one it only opens the frame. Pressing Everything (or the chosen button again) stops following: with Everything chosen the frame never moves.
8. **“Follow the conversation”** (a seventh button, `data-mode="auto"`, **the mode the page opens in**; `setAuto` in `public/topology.js`): at rest the whole campus is zoomed out and every part is a grey silhouette. A request colours only the parts its drawn pulses really touch, and the frame closes in without chasing each hop (`turnParts` in `public/topology-focus.js`): while the request is still being routed (Student and Hub only) the whole campus stays; with one specialist in play the frame holds that specialist with everything it connects to (the Hub, its own model, its record system) plus the parts touched; with two specialists it is the one function they fit (Time off, Class roster), else the whole campus. When the request is over (6 s after the last hop, 45 s at most) the map is zoomed out and grey again. **A part touched in a turn stays in colour, and inside the frame, until the whole turn ends**: when the parts fit no single function (a quiz publish reaches Canvas, then the Campus Agent), the frame opens to the whole campus; nothing goes grey before the turn is over. The linger (6 s) counts from the last hop and from the moment the work stopped, whichever is later. A sign-in or card change colours its parts but never moves the frame. Pressing the button again, or any other filter, leaves the mode.
9. **Zoom like a map:** `−`, `+` and `Fit` in the toolbar (`#topo-zoom-out`, `#topo-zoom-in`, `#topo-zoom-fit`), the mouse wheel over the map (towards the pointer) and dragging to move. It changes only the `viewBox`, never outside the drawing, never narrower than 240 units. The presenter's own zoom holds (`focus.manual`) until Fit or a filter button; while it holds, no automatic zoom runs. A drag is not a click on a part.
10. **Toolbar:** the six buttons, “Follow the conversation”, the zoom buttons, “Show all details”, Show heartbeats, Reduce motion, Pause animation, Trace. There is no “Zoom to activity” and there are no side buttons.
11. **Tests:** `test/topology-focus.test.js` (every part with its pill and caption is inside the drawing; each function's members; a button per function; frames hold their parts). Look at it in a browser on a separate rehearsal stack: rest, a student request, a roster request, each function, a request outside the chosen function, Show all details, the full Topology tab, dark mode.

## Avoid these known problems

- **Do not crop or dim to reduce clutter.** The first build dimmed idle parts and cropped to live traffic; the owner rejected it. The audience must see the connected campus while it comes alive. The parts of one request sit far apart, so a crop barely enlarges the text.
- Text size comes from how the drawing fits its panel. The old 1100 × 1285 drawing was shown at 56% in Side by side (names 8.3 px). Shape the drawing like the panel and write the names large.
- Every part, with its pill, the line under it and its caption, must be inside the `viewBox`; the test checks it (the first try put the Campus Agent's lines and the Tutor's model box outside).
- A model call needs a line long enough for the pulse to travel: keep the specialists' column left of the model boxes and tiles (x 530 against 675 and 744), or the lanes shrink to their arrowheads.
- A model shown as a badge on its agent cannot show a message travelling to it; the owner asked for the box and line back.
- The Student sits at the left edge: its caption starts at the edge, not centred, or a long one is cut.
- Count a part as touched when its pulse is **drawn**, not when the event arrives. Heartbeats never reveal a part.
- Do not exempt unhealthy parts from the function fade: when many parts are unhealthy (or a stale snapshot says so) the filter then fades nothing. A sign-out or registration is itself a drawn pulse, so it already brings the whole campus back when it happens.
- Do not frame only the parts touched so far: one agent and its model fill the panel and its record system is cut off, and every new hop moves the frame (a quiz publish: four moves in six seconds). Frame where the turn can go next (`turnParts`).
- Faculty + Canvas alone “fit” Course and quizzes, whose frame widens to the Student for nothing: with one specialist in play, use its own surroundings, not the function's frame.
- The “finished” event arrives about 350 ms before its pulses are drawn. After a long silent wait (a model working for 10 s) the map would rest in that gap, then relight for the reply: count the linger from the moment the work stopped too (`focus.lastBusy`).
- “make a quiz” (the topic list) and other answers written by code report no event, so nothing lights for them. Do not invent a pulse.
- Scripts that screenshot the map now see grey silhouettes at rest: press Everything first when a picture needs the campus in colour. The status text is still in the page.
- A mouse press focuses the line or part under it; when a drag starts, drop that focus, or a focus box is left on the map.
- A request that only reaches a clarifying question (the Hub asks “Library services or Marketing 351?”) touches no specialist, so the filter rightly stays where it was.
- “Course and quizzes” runs from the Student to Canvas, the full width of the map, so its zoom gains almost nothing. Say so; do not hide it.
- Scripts that read a status pill still find its text (it is in the page, only transparent at rest). Scripts that screenshot the map at rest show names only; tick “Show all details” for the full text.
- `scripts/browser-checks/peoplesoft.js` checks the `viewBox` and the tile size: keep them in step (`0 0 845 959`, `184×80`).
- `npm test` passes a folder to `node --test`, which Node 22 refuses (“Cannot find module …/test”). Run `HUB_URL=http://127.0.0.1:9 node --test test/*.test.js` there.

## Enhancements merged into this step

- **2026-11-21, “Follow the conversation” is the default.** The owner: “Make “follow the conversation” the default selected mode”. The page opens grey and zoomed out; Everything (the whole campus in colour) is one press away. The choice is still not saved between page loads.

- **2026-11-21, a full live check of “Follow the conversation”.** The owner tried “make a quiz” and it “did not seem right”. Fourteen scenarios were recorded on a live rehearsal stack (what is in colour and the `viewBox`, every 80 ms). Three faults were fixed: the frame filled the panel with Faculty alone and cut Canvas off; a quiz Approve or Publish moved the frame three or four times in a few seconds; a loans request went grey just before its reply arrived.

- **2026-11-21, colour lasts the whole turn.** The first build of “Follow the conversation” turned the earlier parts grey when a turn reached a part no function fits. The owner: “if a node gets activated while in a run it should stay colored until the whole session turn ends”.

- **2026-11-21, “Follow the conversation” and map zoom.** The owner: “I want a mode that everything is grayed out and depending on what I say it zooms in and activates the nodes that are activated and when its done it will go to default mode of zoomed out and grayed out”, then “I want zoom buttons like a map where I can use mouse or + - buttons to zoom in and out”. It is a mode the presenter switches on; the map's default (whole campus in colour) is unchanged.

- **2026-11-20, the filter follows the request.** At first a request outside the chosen function switched the filter to Everything. The owner: “when I then switched to a topic that was not about tutoring it changed to “Everything” instead of the one related to that question/function and only zooming into the ones related to that”.

- **2026-11-20, silhouettes whatever the status.** The first build kept any part that was not “ready” in full colour with a function chosen. On a server whose page showed every agent “Not registered” (the stale snapshot bug, Step 7), nothing faded at all, and the owner said: “the ones that are not part of that function should not be colored and highlighted they should be a siloute”. Now only a part really in use is exempt.

- **2026-11-20, the readable map replaces dim-and-zoom.** The first version (grey rest state, two side buttons, a frame that followed live traffic, “Zoom to activity”) was replaced the same day by this design, because it made the map quieter but not readable and took the connected campus away while it came alive.
