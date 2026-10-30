# Steps — classroom edition

These prompts rebuild the AgentHub app from an empty folder, one step at a time, in Claude Code. They were written for a classroom:

- **Cheap to run.** The lead session runs on Sonnet 5.5 and the build tasks run on Haiku 5.5 subagents. Every step passes its checks without an Anthropic API key, because tests use a local fake. Live model checks are optional and cost cents.
- **Fast.** Inside each step, independent tasks run as **parallel subagents**, which leaves class time for teaching.
- **Exact.** File names, ports, versions and scripts are fixed in [Step 0](00-setup-and-contracts.md), so every student's build lines up with the next step.

The original build record, in the user's own wording with every enhancement merged, is in [`../Steps/`](../Steps/README.md). This edition is derived from it and checked against the finished app's code. Where the two editions differ, follow this one.

## How to run a step

1. **Before Step 0, once:** get a project folder that contains this `Steps-classroom/` folder. Either clone the AgentHub-Exercise repo (it already has it), or make an empty folder and copy this whole folder into it (`cp -R Steps-classroom <your-folder>/`). Later steps tell Claude and its subagents to read `Steps-classroom/00-setup-and-contracts.md`, so it must be inside the project.
2. Open Claude Code in your project folder. Use Sonnet 5.5 as the main model (`/model`).
3. Paste the whole step file as your message.
4. Claude acts as the lead and works in three phases:
   1. It writes the step's shared contracts.
   2. It starts the step's tasks as parallel Haiku subagents.
   3. It joins the pieces and runs the "Done when" checks.
5. The step is done when every check in its **Done when** section passes and Claude has committed `Step N: …`.
6. Don't skip steps. Each step starts from the previous step's committed code.

## The steps

| Step | File | What it adds | Parallel tasks |
| --- | --- | --- | --- |
| 0 | [00-setup-and-contracts.md](00-setup-and-contracts.md) | Pinned packages, folders, CLAUDE.md, and the names every later step uses | — |
| 1 | [01-a2a-connectivity.md](01-a2a-connectivity.md) | Student Agent ↔ Tutor Agent over the real A2A protocol | — |
| 2 | [02-browser-monitor.md](02-browser-monitor.md) | Browser page that shows the real A2A exchange through a separate event stream; localhost guards | 2 |
| 3 | [03-a2ui-form.md](03-a2ui-form.md) | The Tutor sends an A2UI v0.9 form inside A2A; the browser renders it with the official renderer; submit goes back over A2A | 3 |
| 4 | [04-haiku-tutor.md](04-haiku-tutor.md) | The Tutor answers with Claude Haiku 5.5 (fixed / mock / live), conversation history, New conversation | 3 |
| 5 | [05-routing-skills-scope.md](05-routing-skills-scope.md) | Library Agent, routing, editable skills with answer content, card-change notifications, scope enforcement | 4 |
| 6 | [06-conversational-workflow-forms.md](06-conversational-workflow-forms.md) | Agents send forms when asked in chat (tutoring request, study-room booking), prefill, advisory review, form lifecycle, the switchboard design | 4 |
| 7a | [07a-university-hub.md](07a-university-hub.md) | The University Hub in the middle: registry, readiness, routing, forwarding, form references | 4 |
| 7b | [07b-student-model-and-topology.md](07b-student-model-and-topology.md) | The Student's own model, three browser tabs, the live animated topology, telemetry redaction | 4 |
| 8 | [08-model-generated-ui-loans.md](08-model-generated-ui-loans.md) | The Library's model composes loan-renewal screens from the A2UI catalog, with deterministic validation | 4 |
| 9a | [09a-professor-agent.md](09a-professor-agent.md) | Marketing 101 Professor behind the Hub; students ask it course questions | 4 |
| 9b | [09b-lessons-reverse-route.md](09b-lessons-reverse-route.md) | Professor → Hub → Student lessons as new signed A2A messages, the Student's inbox, signed Student requests | 4 |
| 9c | [09c-professor-chat-and-meetings.md](09c-professor-chat-and-meetings.md) | Professor chat tab, messages as chat with replies, `@assistant`, meeting times | 3 |
| 10 | [10-ag-ui.md](10-ag-ui.md) | AG-UI 1.0 between the agents and the screen: one connection per page, AG-UI runs, shared form state; nothing visible changes | 3 |
| 11 | [11-fill-forms-from-chat.md](11-fill-forms-from-chat.md) | Fill out an open form from the chat: values read by code, checked by the form's rules, names/emails hidden from the model, nothing sent until you press the button | 3 |

## What changed from the original steps, and why

- **Step 0 is new.** The original steps never named files, ports or scripts until Step 7, which then said "delete `src/student-endpoint.js`". A rebuild can't follow that. Step 0 fixes every name up front.
- **Contradictions with the code are fixed.** Examples:
  - Step 9 listed one enrolled student instead of two.
  - It used the wrong separator in the delivery-ID formula.
  - It gave three different content-hash formulas.
  - It gave a wrong test count.
  - Step 7 described `demo:live` wrongly.
  - The Host/Origin guards that Step 9 assumed were never specified.
- **No throwaway work.**
  - Step 3 builds the tutoring-request form that the finished app really uses, instead of a "student details" form and button that Step 6 deleted.
  - Step 5 keeps its routing in `src/router.js`, so Step 7a only moves the call into the Hub.
- **Things moved to where they're needed.**
  - The switchboard visual design moved from Step 2 to Step 6, when the agents it styles exist.
  - The per-agent model choice moved to Step 4.
  - The Generated UI inspector shows structure only by default from Step 8 on.
- **Big steps are split.**
  - Step 7 (about 9,000 words) is now 7a and 7b.
  - Step 9 (about 10,000 words) is now 9a, 9b and 9c.
- **Written for cheaper models.**
  - One rule per line.
  - The final rule only, with no history of how it changed.
  - Exact names, and a runnable "Done when" for every step.
  - Each step's "Avoid these known problems" items are kept, written as rules.
- **Not included:** the presenter's audience demo scripts. They are the instructor's tools, not part of the student build.
