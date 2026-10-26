# Step 2 — Browser monitor for the A2A exchange

> Final state: commit `dad775b`. Your original instructions are below, with later changes merged in; the closing section lists each change and why it was made.

Enhance the existing two-agent A2A spike with a simple browser UI so I can watch the agents communicate.

Keep the working A2A implementation. Inspect it first and run its existing tests before changing anything. If the exchange is not working, report that and fix the spike before adding the UI.

UI
- Show two clearly labeled panels side by side: Student Agent and Tutor Agent.
- Add a message input and Send button under Student Agent.
- Prefill: “Hello Tutor Agent. Can you help me with calculus?”
- Show each agent’s sent and received messages, timestamps, and available message/context/task IDs.
- Show a small activity timeline: request sent → Tutor Agent received → response sent → Student Agent received.
- Show real request state: idle, sending, waiting for response, completed, or failed.
- Keep the design clean, readable, and usable on a narrow screen.
How it must work
1. The browser submits the typed message to a small local UI backend.
2. That backend invokes Agent A’s existing A2A client.
3. Agent A sends the message to Agent B using the actual A2A protocol.
4. Agent B’s handler records receipt and returns its deterministic response through A2A.
5. Agent A records the received response.
6. The browser displays these actual events and messages as they occur.
Use server-sent events or a similarly simple local event stream to update the browser. This event stream is only for visualization; it must not replace A2A communication between the agents.

Truthful visualization
- Emit events from the code paths where sending, receipt, and completion actually happen.
- Do not invent agent messages, fake delivery confirmations, or animate predetermined success steps.
- Distinguish “send started” from confirmed receipt.
- Correlate events with a run ID so separate attempts cannot get mixed together.
- Show observable messages and statuses, not hidden model reasoning.
- If Tutor Agent is stopped, show the real error and never display a successful response.
- Reconnecting the browser must not resend the agent request.
Scope
- Continue using Node.js and plain JavaScript.
- Prefer plain HTML/CSS/JavaScript for this small UI unless the project already has a frontend.
- Preserve the two separate agent processes and official A2A SDK.
- Keep all servers bound to localhost.
- No LLM calls, API keys, Hub, mailboxes, database, A2UI, accounts, or deployment yet.
- Prevent accidental double submission while a request is in progress.
- Render messages as text, not executable HTML.
Deliverables and verification
- Updated runnable source and README with exact startup commands and browser address.
- Preserve the original integration test.
- Add tests for typed-message round-trip, event correlation, unavailable Tutor Agent, and no resend on browser reconnect.
- Start the app and exercise the complete flow in a real browser if browser tools are available. Otherwise clearly state that browser verification was not performed.
- Show actual test results and explain the difference between the A2A connection and the browser’s visualization connection.
Explain the small design before implementing it. After it works, walk me through the files and message flow, then stop so I can understand this enhancement before adding anything else.


## Avoid these known problems (found while building this step)

- Agent visualization events arrive on a **separate connection** and can land *after* the A2A reply. The UI and tests must wait for them, not assume an order.
- Browser reconnect replays history from the UI server (dedupe by sequence number, reset on a new server boot ID). Only POST endpoints may start A2A requests.
- Until Step 4 the Tutor deliberately returns one fixed reply, whatever the question. Say so in the UI and README so it isn't mistaken for a bug.

---

## Enhancements merged into this step

- **Keep the fixed reply for now.** After Step 2 you asked whether the Tutor always answers with a predefined message. Yes, by design. You chose to keep the deterministic reply until the model is added in Step 4.
- **Visual design (applied after Step 6, using Anthropic's frontend-design skill):** a “switchboard” look. Every line carries the color of the agent that produced it (Student cobalt, Tutor plum, Library spruce, router/system ochre) and position shows direction (your messages on the right). Panels fill the viewport and scroll on their own; the composer is pinned under the chat; agent panels are plain log lines, not card stacks. Type: Atkinson Hyperlegible Next for the UI, IBM Plex Mono only for IDs — both self-hosted in `public/fonts/` (OFL), so the page makes no third-party requests. Light and dark themes; stacks to one column on phones. Sentence-case labels; no all-caps eyebrows.

