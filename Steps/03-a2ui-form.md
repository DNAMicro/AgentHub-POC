# Step 3 — A2UI form sent by the Tutor, submitted over A2A

> Final state: commits `d9a1e9b` and `3f31bb5`. Your original instructions are below, with later changes merged in; the closing section lists each change and why it was made.

Implement Part 3 of the existing two-agent spike: an A2UI form sent by Tutor Agent, completed by the student, and returned to Tutor Agent through A2A.

Inspect the existing project and run its tests first. Preserve the working two-agent A2A exchange and browser visualization. Do not replace them with a simulated transcript.

Form
- First name: required text.
- Last name: required text.
- Email: required, valid email format.
- Notes: optional multiline text.
- A clearly labeled Submit button.
Use fictional sample data only, such as Alex Student and alex@example.com.

Required flow
1. Student clicks “Request form” in the Student Agent panel.
2. Student Agent sends an A2A request to Tutor Agent asking for the student-details form.
3. Tutor Agent builds a valid A2UI description containing these fields, their data bindings, and the submit action.
4. Tutor Agent returns that structured description through A2A. Student Agent receives it, and the existing browser event stream delivers it to the student’s UI.
5. The browser renders the received A2UI description using a compatible renderer. Do not hardcode a separate HTML form that ignores the received description.
6. The student enters the values. Keep draft values local to the student view until Submit.
7. On Submit, validate the form and show inline errors. Do not send invalid data.
8. Send the submission action and values to the local Student Agent backend. It sends them to Tutor Agent through A2A, correlated with the original form and conversation.
9. Tutor Agent independently validates the submission, records the accepted values in memory, and returns an acknowledgment through A2A.
10. Show the actual received values in the Tutor Agent panel and the acknowledgment in the Student Agent panel. Mark the form submitted only after acceptance is confirmed.
Protocol requirements
- Check the current official A2UI documentation and its A2A integration guidance before implementing. Select and pin a compatible schema/catalog/renderer version and document the choice.
- Use actual A2UI messages and supported components, not invented JSON labeled A2UI.
- Use the appropriate structured A2A message or artifact mechanism for the UI payload, following the selected integration guidance.
- Document the mapping from the renderer’s submit event to the A2A submission message. Do not assume the protocols automatically wire themselves together.
- A2A carries agent messages; A2UI describes the interface; the browser event stream only visualizes real events and delivers UI updates.
- Preserve the existing Node.js/plain-JavaScript backend. Use the smallest compatible frontend integration needed for the renderer; explain any necessary frontend dependency before adding it.
Visible behavior
- Keep Student Agent and Tutor Agent panels.
- Show: form requested → Tutor received request → form sent → Student received form → waiting for student → submission sent → Tutor accepted → acknowledgment received.
- Emit these statuses from actual code paths, not timers pretending the exchange occurred.
- Include run, form, and available A2A conversation/message/task IDs in expandable details.
- If a task has already completed, do not attempt to resume it illegally; use a new correlated A2A message/task as supported by the chosen SDK.
Validation and reliability
- Trim required names and reject whitespace-only values.
- Validate email format, but do not claim that format validation proves the address exists.
- Apply reasonable length limits on both client and server.
- Accept only the expected fields and known submit action. Never execute code, HTML, or arbitrary URLs supplied in the UI payload.
- Disable double submission while pending. Use a submission ID so Tutor Agent processes a duplicate only once and returns the same acknowledgment.
- Browser reconnect must not submit or resend anything automatically.
- If delivery is uncertain, show that honestly rather than claiming success or silently retrying.
- If Tutor Agent is unavailable, show an error and preserve the student’s draft.
Scope
No LLM, API keys, paid calls, Hub, mailboxes, database, account system, deployment, or actual email sending. Keep services localhost-only. In-memory form/submission records are sufficient; clearly explain that restarting clears them.

Tests and deliverables
- Preserve existing A2A and browser-event tests.
- Test that the received payload validates against the chosen A2UI schema and actually drives the rendered form.
- Test a valid round trip and exact Tutor receipt of all four values.
- Test missing/whitespace names, invalid email, unexpected fields/actions, duplicate submission, unavailable Tutor Agent, and browser reconnect without resubmission.
- Verify that editing fields alone does not send draft values to Tutor Agent.
- Exercise the full browser flow if tools are available; otherwise disclose that browser verification is unperformed.
- Update the README with startup commands, protocol versions, and a plain-English explanation of each hop.
Explain the plan, implement and test this enhancement, show actual results, then stop so I can understand Part 3 before we add anything else.


## Avoid these known problems (found while building this step)

- Pin A2UI **v0.9** (not v0.9.1) to match `@a2ui/lit` 0.14.0's registered catalog. A2UI parts set both `mediaType` and `metadata.mimeType` to `application/a2ui+json`.
- The renderer needs a small esbuild bundle to run in the browser; explain that dependency before adding it.
- The renderer refuses regexes its ReDoS detector considers unsafe (the check silently fails). Use catalog functions (`required`, `email`, `length`) and trivially safe patterns.
- The renderer adopts data-model values **by reference and mutates them**. `structuredClone` a payload before processing it again.
- Only a Button action sends anything (`sendDataModel: false`), so typing never leaks draft values.
- A completed A2A task can't be resumed ("terminal state"). Check with `GetTask` first, and otherwise send a new message in the same context with `referenceTaskIds`.
- The Student must **allowlist** the received A2UI payload (expected components, bindings and the one submit action) before rendering it.

---

## Enhancements merged into this step

- **Strict A2UI allowlist on the Student side** (security review after Step 3, commit `3f31bb5`): before handing a received A2UI payload to the renderer, the Student accepts only the expected components, data bindings and the single known submit action. Anything else is rejected, so a malicious or broken Tutor can't inject other UI, actions or URLs.
- **Replaced in Step 6** (conversational workflow forms): the “Request form” button, the `POST /api/forms` shortcut and the student-details form no longer exist. Forms now appear only when an agent decides to send one in reply to a chat message; the A2UI mechanics of this step (version pin, action mapping, task resume vs. new correlated message, delivery outcomes, payload allowlist) still apply. Rebuilding: run Step 3 as written, then Step 6 replaces its entry point.
