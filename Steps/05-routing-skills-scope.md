# Step 5 — Routing, Library Agent, editable skills, scope enforcement

> Final state: commits `020018c` (Part 5), `7bc2e21` (answer content + dialog redesign) and `5cc671d` (live-mode fixes). Your original instructions are below, with later changes merged in; the closing section lists each change and why it was made.

Implement Part 5 of this project: intelligent routing between Tutor and Library agents, editable Agent Cards, automatic card-refresh notifications, and enforcement of each agent’s advertised scope.

Inspect the existing project and run its tests first. Preserve Parts 1–4: actual A2A communication, browser visualization, the A2UI form round trip, and server-side Anthropic integration. Do not assume previous functionality works without verifying it.

GOAL
A student asks a question. Student Agent selects the appropriate registered service using its advertised skills, sends the request through A2A, and displays the actual response. Editing a service’s skills updates its Agent Card, notifies Student Agent, refreshes routing, and changes the receiving service’s allowed scope consistently.
1. THREE AGENTS
Student Agent
- Receives the human student’s question.
- Discovers the registered Tutor and Library services through their Agent Cards.
- Uses Anthropic Haiku 5.5 for a bounded routing decision.
- Sends the question only to the selected service.
- Receives service responses and skill-change notifications.
Tutor Agent (calculus by default)
- A separate A2A service process.
- Initially advertises calculus tutoring: limits, derivatives, integrals, and calculus exercises.
- Retains the existing Anthropic-backed tutoring behavior, now explicitly restricted to its enabled skills.
- Preserves the existing A2UI student-details form and submission acknowledgment.
Library Agent
- A separate A2A service process.
- Initially advertises library hours, borrowing, renewals guidance, returns guidance, and finding library resources.
- Answers ONLY from the saved "answer content" of its enabled skills (see section 5). The default content is a small fictional policy/catalog fixture, clearly labeled sample data.
- It replies with just the part that answers the question. Asking "what are the hours on Mondays?" returns the Monday line, not the whole week. It works out simple results from the content, e.g. a due date from a stated loan period and the date borrowed, using today's date for a missing year.
- Two modes: `mock` (default for tests; deterministic line extraction, no model) and `live` (Haiku 5.5). In live mode the model must return the exact supporting lines ("evidence"), and code releases the answer only if every evidence line appears verbatim in that skill's saved content. Otherwise the answer is withheld. "Not covered by the content" gets a fixed server reply, not the model's guess.
- Does not invent real university policies, book availability, or successful renewals. It provides guidance, not real transactions.
Keep the existing Node.js/plain-JavaScript stack and official A2A SDK. Check current official documentation and pin working dependency/protocol versions. Do not add the full Hub, mailboxes, account system, database, deployment, or unrelated frameworks.
2. TRUSTED SERVICE REGISTRY AND DISCOVERY
Configure a local allowlist with stable Tutor and Library agent IDs and their Agent Card URLs. Student Agent fetches the real cards and validates them.

Use the cards’ skill descriptions for routing, but retain trusted configuration for identity and network destinations. The model must never choose an arbitrary URL. Reject unexpected endpoints or protocol/security changes instead of silently accepting them.

A2A provides agent discovery and communication; the application implements selection. Do not claim that A2A automatically routes by skill or enforces topic boundaries.
3. INTELLIGENT ROUTING
Use the existing official Anthropic SDK server-side with claude-haiku-5-5, verifying current availability. Do not silently substitute another model.

Require a validated structured routing decision:
- route: select a registered agent ID and a short user-facing reason.
- clarify: ask a focused question; call neither service.
- unsupported: explain that no connected service fits; call neither service.
A skill covers its listed subjects AND their standard concepts, methods, frameworks and sub-topics, even when not named word for word (e.g. SWOT analysis within a "Marketing" skill; the chain rule within calculus). Anything a skill explicitly excludes stays excluded. Don't require a skill to "clearly" list the exact topic.

Code validates the decision and resolves the endpoint from the trusted registry. Treat student text and card descriptions as data, not instructions to change routing policy.

Expected examples:
- “Explain the derivative of x squared” → Tutor.
- “How do I renew a borrowed book?” → Library.
- “Where can I find a calculus textbook?” → Library, because the intent is finding a resource.
- “Explain the derivative example in my library book” → Tutor, because the intent is tutoring.
- “I need help” → clarification.
- “How do I repair a leaking faucet?” → unsupported.
- “Explain Newton’s laws” → unsupported when neither agent advertises physics.
- A request combining a renewal and a calculus explanation → ask which to handle first. No multi-agent fan-out yet.
Do not broadcast a question to both services to find out which answers. If the selected service is offline, report that; do not redirect to an unrelated service.
4. CONTEXT AND FORM OWNERSHIP
Use bounded, isolated conversation history to understand follow-ups. “Can you give another example?” should continue with Tutor when context clearly establishes that meaning. An explicit new library question can switch to Library; uncertainty requires clarification.

Keep A2A context/task IDs separate for each remote service. Never reuse Tutor’s task ID with Library. If a task is terminal, use a new correlated message/task as required by the SDK rather than attempting an invalid resume.

Forward only relevant context. Do not send an entire tutoring history or contact-form details to Library merely because the student switches topics.

A2UI form submissions always return to the agent that issued the form, using recorded agent/form/conversation IDs. They must not be semantically rerouted based on their Notes field. Validate submissions against the current applicable form/action policy; if that action is no longer supported, return a clear error rather than redirecting it.
5. GEAR ICON AND SKILL SETTINGS
Add an accessible “Edit agent skills” gear button to Tutor and Library panels.

The dialog must show:
- Agent name and stable identity.
- Enabled skills with stable skill IDs.
- Skill names, descriptions, tags, and example questions.
- Explicit allowed scope and exclusions.
- An "answer content" text box per skill (see below).
- Save, Cancel, validation errors, and a preview of the resulting Agent Card.

Make the dialog easy to fill in:
- Each skill is a collapsible card with an Enabled switch in its header (name, ID and status shown when collapsed).
- Fields grouped into sections: Basics (name, description, skill ID), Answer content, Boundaries (covers / does not cover), and Routing hints (tags, example questions), each with short help text and example placeholders.
- For a new skill, the ID is generated from the name (editable until saved, fixed afterwards). "Add a skill" opens the new card and focuses its Name field.
- Server validation errors appear inline under the field they belong to, plus a count at the top. They clear as you type.
- A sticky footer with Save/Cancel and an "Unsaved changes" indicator. Cancel or Esc asks before discarding edits.
- The Agent Card preview is collapsed by default.
Keep endpoint URLs, authentication, credentials, identity, and protocol capabilities out of this editor. It edits skills, not permissions or network destinations.

Use one server-owned skill configuration as the source for:
- The advertised Agent Card.
- Routing metadata.
- The receiving agent’s runtime scope policy.
Do not maintain conflicting copies. Include only schema-supported fields in the Agent Card; application-specific scope boundaries belong in local configuration or a properly documented extension, not invented standard fields.

Skills have no "handler" setting. Each skill has a kind (an answer skill, or the Tutor's built-in student-details form, which is handled by code, may be renamed or disabled, and can't be duplicated or removed) and private answer content:
- The answer content is never put on the Agent Card. It goes only into the runtime policy.
- Library: answer content is required for every enabled skill, because the agent answers only from it. Saving an enabled Library skill with empty content is rejected ("the agent would have nothing to answer from"). Any number of skills may be added, including several on related topics.
- Tutor: answer content is optional reference notes added to the model's instructions; the Tutor also uses its own subject knowledge within the skill's boundaries.
Distinguish configured scope from tested capability: the dialog and panels say whether a configuration matches the tested default.

For this localhost spike, label settings as local developer controls. Do not claim production authentication or authorization. Do not expose the app publicly.
6. REAL CARD-CHANGE NOTIFICATIONS
Implement the reverse path explicitly: Student Agent must also expose a localhost A2A receiving endpoint. Tutor and Library use real A2A clients to notify it.

On Save:
1. Validate and atomically update the service’s skill configuration and runtime policy.
2. Serve the updated Agent Card with a changed content validator, such as an ETag, and an application revision if needed. Do not confuse the A2A protocol version with a card-content revision.
3. Send a structured agent_card_changed notification to Student’s configured A2A endpoint.
4. Student handles this application-level notification in code, not as a tutoring question or an LLM instruction.
5. Student checks it against the registered peer configuration and re-fetches the card from the already registered URL.
6. Validate the fetched card, then atomically replace the routing registry entry.
7. Show the successful refresh and newly advertised skills in the browser.
The notification is only a hint to refresh. It does not grant permissions, prove a skill works, or authorize a replacement URL.

This is our application convention carried by A2A, not a built-in A2A skill-change broadcast. Document the limits of peer identification in the localhost-only test. A sender ID inside message content is not authentication. Do not create credentials or broaden persistent access without approval.
7. REFRESH RELIABILITY
   - Show configuration saved, notification received, and Student routing updated as separate outcomes.
   - Do not claim Student learned the update merely because Save succeeded.
   - Deduplicate notification IDs and coalesce refreshes.
   - Handle delayed/out-of-order notifications by fetching the current card rather than applying message contents.
   - Use appropriate HTTP cache revalidation so a notification does not just return a stale cached card.
   - If Student is offline, report propagation as pending. Refresh registered cards on Student startup/reconnect and provide a manual Refresh skills button.
   - Avoid infinite retries, notification loops, or repeated paid model calls for configuration changes.
   - A failed refresh must not invent new skills. Show stale/error state; the receiving agent’s current policy remains authoritative for execution.
   - Skill removal must take effect on the receiving service even if Student’s cached card is stale.
8. ENFORCE CURRENT ADVERTISED SCOPE
Every receiving service checks its own current enabled skills before answering, including direct A2A calls that bypass Student’s router.

A calculus-only Tutor must decline a standalone physics or plumbing request even though the underlying LLM may know about those subjects.

Use these layers:
- Server code enforces supported operation IDs, skill IDs, actions, and schemas.
- A conservative semantic check evaluates free-text requests against the saved skill configuration before answer generation: in_scope, out_of_scope, or needs_clarification.
- Out-of-scope requests get a short scope response, not a substantive answer.
- Uncertain requests get a focused clarification question.
- The answer-generation instructions use the same current scope.
- Check generated answers for material scope violations before release. If the check fails, return a safe scope response without an unlimited regeneration loop.
For Library responses, answer only from the enabled skills' saved answer content rather than inventing facts; in live mode release only evidence-verified answers.

Answers must not mention internal configuration: no skill names, skill IDs, or which skill applied. Just answer.

Student messages, form notes, and “ignore your rules” instructions cannot change server policy. Earlier in-scope conversation does not authorize an unrelated new topic.

Define the scope sensibly: necessary algebra within a calculus explanation may be allowed; a standalone physics lesson is not. For a mixed request, clarify or explicitly restrict the answer to the supported portion.

If no skills are enabled, the service must not become a general assistant. Recheck the current policy before dispatching actions or releasing a response if settings changed while a request was running.

Be honest: LLM-based semantic checks are probabilistic. Do not claim perfect topic enforcement from system prompts, a few passing examples, or mock tests. Code-level action restrictions and model topic judgments are different guarantees.
9. BROWSER UI
Keep three clear panels: Student Agent, Tutor Agent, and Library Agent. Call the tutor “Tutor Agent” everywhere in the UI (not “Calculus Tutor”): its subjects come from its editable skills, and calculus is only the default.

Show:
- The student’s question.
- Routing state and selected service with a short explanation, not hidden reasoning.
- Actual sent/received events and the correct service’s response.
- Clarification/unsupported states without fake service activity.
- Gear settings for Tutor and Library.
- Current advertised skills and Student’s cached view of those skills.
- Save → notification → refresh progression.
- Card validator/revision and last successful refresh in expandable details.
- Explicit mock/live mode for the router, the Tutor and the Library.
- "New conversation" clears every panel (Student, Tutor and Library) and the timeline.
- Mock word matching (tests only) should tolerate small typos ("derivitive" ~ "derivative") without matching different words.
Use real events from the agent processes. Do not fake successful routing, message delivery, refresh, or responses with timers. The browser event stream remains visualization only; agent messages and notifications use A2A.
10. SECURITY, COST AND FAILURE HANDLING
    - Keep all services localhost-only.
    - Keep ANTHROPIC_API_KEY in server-side environment configuration. Never print, commit, copy into messages, or expose it in browser assets/events/logs.
    - Reuse the existing safe key setup; do not create or configure credentials on my behalf.
    - Bound model inputs, history, output, concurrency, and any scope-check calls.
    - Live use and live verification don't need a separate planned-calls/budget approval step; report calls, usage and cost afterwards. The scripted live eval keeps its max-spend env gate (`LIVE_EVAL_MAX_USD`).
    - When the app is handed over as ready, all three model users (router, Tutor, Library) run in live mode. Mock is for automated tests only.
    - Start live servers without an inherited `ANTHROPIC_BASE_URL`; print the API host at startup. On a real 429, log which Anthropic limit was hit (rate-limit headers), not the key.
    - Automated tests use mocked providers and make no paid calls by default.
    - Preserve request/submission IDs, deduplication, timeouts, and honest uncertain-outcome handling. No blind retries or automatic resends on browser reconnect.
    - Render messages as text, not executable HTML. Do not execute arbitrary code or URLs from agent cards, notifications, model output, or A2UI descriptions.
11. ACCEPTANCE TESTS
Preserve Parts 1–4 tests and add:
- All routing examples above, asserting the actual A2A destination.
- Clarification/unsupported decisions call neither service.
- Unknown agent IDs and malicious destination URLs fail without outbound requests.
- Follow-up context, explicit topic switching, and conversation isolation.
- A2UI submissions stay with their issuing agent.
- Direct Tutor requests for physics, plumbing, mixed topics, and prompt-injection attempts are declined or clarified appropriately.
- Skill settings Save/Cancel and invalid input.
- Card, routing metadata, and runtime policy derive from one configuration.
- An enabled Library skill without answer content is rejected; answer content never appears on the card.
- Library mock answers return only the relevant lines (Monday hours → just the Monday line); a newly added skill is answered from its saved content.
- Library live path (against a fake API): answers released only when every evidence line is in the saved content; invented evidence, missing evidence, unknown skill IDs and "not in knowledge" are withheld or get the fixed reply.
- Mock matching tolerates small typos but not different words.
- Actual reverse A2A notification, card fetch, and routing-registry update.
- Duplicate/out-of-order notifications, offline Student, failed refresh, and manual/startup recovery.
- Removed skills rejected server-side despite stale Student metadata.
- Skill changes during an in-flight request do not release now-disallowed output/actions.
- Missing provider key, provider errors, unavailable service, duplicate requests, and browser reconnect without duplicate paid calls.
Separate deterministic/mock tests from opt-in live routing and scope evaluations. Run the live examples (the scripted eval keeps its max-spend env gate) and report observed choices, refusals, errors, and usage honestly. Mocked classifier results do not establish real model accuracy.
12. DELIVERABLES AND STOPPING POINT
Deliver complete runnable source, pinned dependencies, startup commands for all agents and the browser, and an updated README explaining:
- Routing versus A2A transport.
- Agent Card advertisement versus actual capability and permission.
- The reverse notification endpoint and trusted refresh process.
- Current scope enforcement and its limitations.
- Mock versus live testing.
- In-memory state and what is lost on restart.
Use in-memory state for this spike and clearly document restart behavior; do not add a database just for this part.

Demonstrate in the browser when tools are available, in live mode: calculus routes to Tutor, borrowing routes to Library, unsupported physics is declined, and changing a supported skill through the gear updates the card and Student’s routing view (saved → notification delivered → Student updated). Also add a new skill (e.g. Marketing tutoring on the Tutor, or one with pasted answer content on the Library) and show that a related question such as "What is SWOT analysis?" routes to it and is answered. Disclose if browser verification is unavailable.

Explain the design before coding. Implement this bounded enhancement, run tests, show actual results, explain the key files and message path, then stop so I can understand Part 5 before we add anything else.


## Avoid these known problems (found while building this step)

- Fetch Agent Cards with `node:http`, **not `fetch`**. Node's fetch (undici) adds `Cache-Control: no-cache` to conditional requests, so Express returns 200 instead of 304 and revalidation never happens.
- Keep earlier steps' tests unchanged in behavior: the router's code default is `direct` (no routing), and Step 4's plumbing tests set `TUTOR_SCOPE_ENFORCEMENT=off`, because scope checks add model calls.
- Mock heuristics (tests only) must:
  - match word stems ("limit" ~ "limits") and small typos ("derivitive" ~ "derivative"), but not different words;
  - check prompt-injection phrases **before** allowed words ("ignore your rules" contains the allowed word "rules");
  - not let an exclusion that names the allowed subject block it: "math outside calculus" must not exclude *calculus*;
  - weight earlier words higher, so "renew a borrowed book" picks Renewals, not Borrowing.
- Live judgments: a skill covers its subjects' standard concepts and frameworks (SWOT within marketing), so don't require a "clear" literal match. Answers never mention skill names or IDs.
- Never tie skills to fixed "handlers". A user must be able to add several related skills; each answers from its own answer content.
- The Tutor's startup notice reports `pending` if the Student isn't running yet. That's expected: the Student re-fetches all registered cards when it starts.
- Skills live **in memory**. Before restarting a server for the user, warn that their saved skills will be lost, and re-apply them through the normal save path afterwards (or offer file persistence).
- "New conversation" clears **every** agent panel, not just the Tutor's.
- Live checks take several seconds (router plus up to three Tutor calls); use generous timeouts when scripting them.

---

## Enhancements merged into this step

- **Library panel clears too** (your report): "New conversation" cleared the Tutor panel but not the Library's. Every panel now clears.
- **Handlers removed, answer content added** (your request): adding "borrowing-book" failed because its handler was already used and there was no way to choose none. Skills no longer have handlers. Each has an answer content box the agent reads to answer, replying with only the relevant part (Monday's hours, not the whole week).
- **Skills dialog redesign** (your request: "the form is pretty hard to fill"): collapsible cards with switches, grouped sections with help text, IDs generated from names, inline errors, unsaved-changes indicator, confirm before discarding.
- **Library interprets, not just quotes** (your report): in mock mode, asking when a book borrowed on Oct 20 is due returned the rules. Live mode now works out "due back on November 10" and gets today's date so a missing year resolves. The quoted rule is verified; the arithmetic itself is the model's.
- **Ready means live** (your instruction): the app was left in mock mode, giving placeholder answers. Anything handed over runs live; mock is for tests only.
- **Fake rate limit** (your report): the 429 came from a local proxy inherited through `ANTHROPIC_BASE_URL`, not your Anthropic limits. Live servers now start without it and log the API host.
- **Typo tolerance** (your report): the mock scope check rejected "derivitive". Mock matching now allows small typos.
- **Routing too strict** (your report): with a Marketing skill saved, "What is SWOT analysis?" was declined. The card update and notification had worked; the router required a "clear" literal fit. Router and Tutor scope check now count a subject's standard concepts and frameworks. Tutor answers no longer mention skill names or IDs.
- **Named “Tutor Agent”, not “Calculus Tutor”** (your request): the tutor's subjects are configurable in the ⚙ dialog (calculus is just the default skill), so the UI, the Student's registry display name and the Tutor's card description use the neutral name.
