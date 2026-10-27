# Step 3 — A2UI form sent by the Tutor, submitted over A2A

Time: about 60 minutes. Cost: free (no model calls in this step).

## What you'll see when it works

- You type "I want to arrange in-person help with calculus" in the chat.
- The Tutor answers with a real A2UI v0.9 form inside an A2A Task. The browser draws it with the official `@a2ui/lit` renderer.
- You fill it in and press "Send tutoring request". The form becomes a read-only "You sent" summary.
- The Tutor panel shows the exact values it received. The chat shows its acknowledgment with a `TR-…` receipt.

## Starting point

Steps 1 and 2 are done: Tutor A2A server, Student client (`src/student-agent.js`), UI server with `POST /api/runs`, the event stream `GET /api/events`, the guards in `src/local-guard.js`, and the browser page. Start from the committed code of Step 2.

## Instructions for Claude (lead)

Work in the three phases from Step 0: **Contracts → parallel Build → Join and check.** Start **all tasks in the table in ONE message** with the Agent tool. Give each subagent this file, `00-setup-and-contracts.md` and its task row.

The form is the **tutoring-request** workflow, which the finished app keeps. Do not build any other form, any "Request form" button, or any endpoint that creates a form. A form appears only because the Tutor chose to send one in reply to a chat message.

## Phase 1 — Contracts (lead writes these first)

1. **Scripts.** Add `build:ui` and change `ui` exactly as in Step 0's script table.
2. **`src/forms.js` skeleton** with these exact constants and stubs for Task A's exports:
   - `A2UI_VERSION = 'v0.9'`, `A2UI_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v0.9'`, `A2UI_MIME_TYPE = 'application/a2ui+json'`
   - `BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'`, `MAX_A2UI_PAYLOAD_BYTES = 64 * 1024`
   - `TIMEZONE = 'America/Los_Angeles'`, `TIMEZONE_LABEL = 'Pacific Time (America/Los_Angeles)'`
   - `TUTORING_HOURS = { open: '09:00', noon: '12:00', close: '17:00', days: 'Monday–Friday', maxDaysAhead: 60 }`
   - `TUTORING_FIELDS = ['firstName', 'lastName', 'email', 'preferredDate', 'period', 'specificTime', 'notes']`
   - `WORKFLOWS`:
     ```js
     'tutoring-request': {
       id: 'tutoring-request', agentId: 'tutor', skillId: 'in-person-tutoring-request',
       title: 'Request an in-person calculus tutoring session',
       finalAction: 'submitTutoringRequest', pendingText: 'Sending request…',
       actions: {
         submitTutoringRequest: { button: 'submit_button', fields: TUTORING_FIELDS, final: true },
         cancelForm: { button: 'cancel_button', fields: [], cancel: true },
       },
     }
     ```
3. **Temporary trigger.** In `src/tutor-agent.js`, export `wantsTutoringForm(text)`: true when the text matches `/\b(tutoring request|in[- ]person)\b/i`. Comment it: `// Temporary Step 3 trigger. Step 6 replaces it with src/form-intent.js.`
4. **A2A shapes** (as a comment at the top of `src/form-host.js`):
   - A form reply is a Task in `TASK_STATE_INPUT_REQUIRED`. Status message parts: `[text intro, A2UI part]`. Metadata: `{ runId, agentId, formId, workflowId, formVersion: 1, issuer: agentId, supersedes: null, prefilled: [] }`.
   - An A2UI part: `{ content: { $case: 'data', value: messages }, mediaType: A2UI_MIME_TYPE, metadata: { mimeType: A2UI_MIME_TYPE }, filename: '' }`.
   - A form action is a user Message with one A2UI part `[{ version: 'v0.9', action }]` and metadata `{ runId, operationId, formId, formVersion }`.
   - The action reply has parts `[text, application/json body, optional A2UI update]`. Body: `{ status, formId, operationId, workflowId, message, errors?, receipt?, duplicate? }`. Status: `accepted`, `rejected` or `cancelled`.
   - `formId` = A2UI `surfaceId` = `tutoring-request-<8 hex>`.
5. **Events.** Tutor: `form_sent`, `form_action_received`, `form_action_result`, `form_reply_sent`. Student: `form_received`, `form_action_sent`, `form_action_result`, `form_action_failed`. UI server: `form_lifecycle` `{ formId, workflowId, agentId, state, … }` with states `editing`, `submitting`, `accepted`, `rejected`, `confirmation_pending`, `cancelled`, `refused`.
6. **UI server endpoints** (POSTs behind the existing Origin guard): `GET /shared/forms.js`; `POST /api/forms/:formId/actions` `{ operationId, action }` → `202 { runId, operationId }` / `400 { errors }` / `404` / `409 { error }`; `POST /api/forms/:formId/edit` → `200 { formId, a2uiMessages, updates, values }` / `409`; `POST /api/forms/:formId/reconcile` → `202` / `409`.
7. **Harness helpers** in `test/support/harness.js`:
   - `formVia(ui, stream, text)`: POST `/api/runs` with `{ text }`, wait for `completed` or `failed`, return `{ runId, events, form }` (`form` = `form_received` data or `null`). No `contextId` yet: `/api/runs` does not accept one until Step 4, which adds the `contextId` parameter here.
   - `formAction(ui, formId, name, button, context, operationId = crypto.randomUUID())` posts `action: { name, surfaceId: formId, sourceComponentId: button, timestamp, context }`.
   - `lifecycleOf`, `lastLifecycle(events, formId)`, `waitLifecycle(stream, formId, states, timeout = 5000)`, `actionResults(events, formId, name)`.
   - `openStream` also sets `stream.replayed = true` when the `replayed` event arrives.
8. **Student client stub** in `src/student-agent.js`, so Task C can import it before Task B finishes: `const SUBMIT_TIMEOUT_MS = Number(process.env.SUBMIT_TIMEOUT_MS ?? 5000);` and `export async function sendFormAction(baseUrl, { form, action, operationId, runId, timeoutMs = SUBMIT_TIMEOUT_MS, onEvent = () => {} }) { throw new Error('sendFormAction: not built yet'); }`. Task B replaces the body and keeps the signature.

## Phase 2 — Build (parallel subagents)

| Task | Model | Files it owns | Builds | Done when |
|---|---|---|---|---|
| A | sonnet | `src/forms.js`, `test/support/a2ui-schema.js`, `test/support/render-form.js`, `test/payload-policy.test.js`, `test/a2ui-render.test.js` | Template, validation, allowlist, schema and render tests | `node --test test/payload-policy.test.js` passes |
| B | haiku | `src/form-host.js`, `src/tutor-agent.js`, `src/student-agent.js`, `test/form.test.js` | Form = one A2A task, actions, dedupe, Student client side | `node --check` passes on each owned `.js` file and the "A2A" tests in `test/form.test.js` are written (they need Task A's `forms.js`; they run in Phase 3) |
| C | haiku | `src/browser/a2ui-entry.js`, `public/forms-ui.js`, `src/ui-server.js`, `public/app.js`, `public/index.html`, `public/styles.css` | Renderer bundle, forms in the chat, UI server routes and lifecycle | `npm run build:ui` succeeds and `node -e "import('./src/ui-server.js')"` loads |

### Task A — forms.js and its tests

1. `src/forms.js` has **no imports**. The browser, the UI server and the Tutor all load it.
2. Export date helpers: `todayIn(now, timeZone = TIMEZONE)` → `YYYY-MM-DD`, `addDays(date, n)`, `minutes('HH:MM')`, `hhmm(mins)`, `prettyDate(date)`.
3. `validateTutoringRequest(input, { now })` → `{ ok: true, values }` or `{ ok: false, errors }`, keyed by field (`_form` for structure).
4. Unknown fields → `_form: 'Unexpected field(s): …'`.
5. Names: trimmed, required, at most 100 characters. Whitespace-only fails.
6. Email: trimmed, required, at most 254, matches `/^[^\s@.]+(\.[^\s@.]+)*@[^\s@.]+(\.[^\s@.]+)+$/`. Message: "Enter a valid email format, like alex@example.com." It checks format only.
7. `preferredDate`: a real date, today to 60 days ahead in `TIMEZONE`, Monday–Friday. Take the date part of an ISO value.
8. `period`: a list with exactly one of `morning` / `afternoon`.
9. `specificTime`: optional `HH:MM`, 09:00–17:00. Morning is before 12:00; afternoon is 12:00 or later. Take `HH:MM` from an ISO value.
10. `notes`: required ("Describe what you’d like help with."), at most 1000 characters.
11. `validateFinal(workflowId, context)` calls the workflow's validator; unknown → `_form: 'Unknown workflow.'`.
12. `checkAction(message, { workflowId, surfaceId })` → `{ ok: true, name, spec, context }` or `{ ok: false, error }`. Reject a non-`v0.9` message, an unknown action, another surface, a `sourceComponentId` that isn't the action's own button, and context keys outside its `fields`.
13. `buildTutoringForm(surfaceId, { prefill = {}, now })` returns three messages:
    - `createSurface` with `catalogId: BASIC_CATALOG_ID`, `sendDataModel: false`.
    - `updateComponents`: a `root` Column with children `title` (h3), `description` ("Tell us your preferences. This submits a request; it does not book a time."), `hours` (caption: timezone, days, hours), `first_name`, `last_name`, `email`, `preferred_date`, `period`, `specific_time`, `notes`, `demo_note`, `actions` (Row of `submit_button`, `cancel_button`).
    - `updateDataModel` at `/`: `{ form: { firstName: '', lastName: '', email: '', preferredDate, period: [], specificTime, notes: '' }, ui: { submitAttempted: false, submitLocked: false } }`. Only date, period and time can be prefilled (Step 6 supplies them).
14. Components:
    - TextFields bind `{ path: '/form/<field>' }`. Notes is `longText`, labelled "Describe what you’d like help with."
    - `preferred_date`: DateTimeInput, date only, `min` today and `max` today + 60 as `YYYY-MM-DD`.
    - `period`: ChoicePicker, `mutuallyExclusive`, `displayStyle: 'chips'`, options Morning/`morning`, Afternoon/`afternoon`.
    - `specific_time`: DateTimeInput, time only, `min: '09:00:00'`, `max: '17:00:00'`.
    - Buttons have a Text child `<id>_label`: "Send tutoring request" (`primary`), "Cancel" (`borderless`). Action: `{ event: { name, context } }`, context mapping each field to `{ path: '/form/<field>' }`.
15. Checks:
    - Field checks show only after a submit attempt: `or(not(/ui/submitAttempted), rule)`.
    - Use catalog functions `required`, `length`, `email`. "Not blank" is `regex` with pattern `\S`. No custom email regex for the renderer.
    - Every Button has the check `not(/ui/submitLocked)` ("Please wait."), so the renderer disables it while locked.
16. Student-side allowlist. Components: `Column, Row, Text, TextField, Button, ChoicePicker, DateTimeInput, Divider`. Functions: `required, regex, length, email, and, or, not`.
17. `checkFormPayloadPolicy(messages)` returns an error string or `null`. It rejects:
    - an empty payload, or one over 64 KB;
    - anything but exactly one `createSurface`, placed first;
    - a `surfaceId` not matching `/^[\w-]{1,100}$/`, or messages for another surface;
    - another catalog, or a version other than `v0.9`;
    - message kinds other than `createSurface`, `updateComponents`, `updateDataModel`;
    - other components; any `functionCall` or non-allowed `call` anywhere; any `action` that isn't exactly `{ event }`.
18. `checkFormUpdatePolicy(messages, surfaceId)`: the same rules for updates to an existing form. It allows `updateComponents`, `updateDataModel`, `deleteSurface`, never `createSurface`.
19. Also export `buildDelete(surfaceId)` → `[{ version: 'v0.9', deleteSurface: { surfaceId } }]`, and `isA2uiPart(part)`: a data part whose `mediaType` **or** `metadata.mimeType` is `application/a2ui+json`.
20. `test/support/a2ui-schema.js`:
    - Read the v0.9 schemas from `node_modules/@a2ui/web_core/src/v0_9/schemas/` (they aren't in the package's `exports`).
    - Ajv 2020, `validateFormats: true`. Add formats `date`, `time` (seconds required), `date-time`; `uri` always valid.
    - Bind `https://a2ui.org/specification/v0_9/catalog.json` to the basic catalog.
    - Register `client_to_server.json` (no `$id`) under `https://a2ui.org/specification/v0_9/client_to_server.json`.
    - Export `validateServerToClientList` and `validateClientToServerList` (each returns `null` or errors).
21. `test/support/render-form.js`: `setupDom()` copies jsdom globals onto `globalThis`, **then** imports `@a2ui/lit`, `basicCatalog` (`@a2ui/lit/v0_9`) and `MessageProcessor` (`@a2ui/web_core/v0_9`). Also export `settle()` and `queryAllDeep(root, selector)` (searches open shadow roots).
22. `test/payload-policy.test.js` checks: the tutoring form passes; `openUrl` or `formatString` hidden in a check, a bound text or an action context is rejected; each rejection rule in items 17–18; every validation rule; `checkAction`'s rules.
23. `test/a2ui-render.test.js` is its **own file** (jsdom globals). It starts a Tutor (`startTutor()`) and gets the form by real A2A: `askTutor(url, 'I want to arrange in-person help with calculus')`. It checks:
    - the payload validates against the official schemas; a copy with a `Blink` component doesn't;
    - the renderer draws the title, labels and both buttons from the received description;
    - typing produces no action;
    - "Send tutoring request" emits one action that passes `validateClientToServerList`, with the bound values;
    - inline errors appear after `/ui/submitAttempted` is set;
    - `deleteSurface` removes the form;
    - the Send button is disabled while `/ui/submitLocked` is true.
24. Always pass `structuredClone(messages)` to `processMessages`.

### Task B — form host, Tutor wiring, Student client

1. `src/form-host.js` exports `createFormHost({ agentId, workflows, isEnabled, emitViz, log, logValues })`. `workflows`: `{ [id]: { build, actions: { [name]: async (form, context, tools) => result } } }`.
2. It returns `{ issue, handleAction, openForm, formForRequest, clientSupportsForms, form }`.
3. `clientSupportsForms(message)`: `metadata.a2uiClientCapabilities['v0.9'].supportedCatalogIds` includes `BASIC_CATALOG_ID`.
4. `issue(ctx, bus, { workflowId, prefill = {}, runId, intro })`:
   - The same chat request (`contextId|messageId`) seen again while its form is open → re-publish that Task and emit `form_sent` with `repeat: true`. Never a second form.
   - Otherwise store `{ workflowId, version: 1, taskId, contextId, state: 'awaiting_input', message, a2ui }`, publish `AgentEvent.task(...)` in `INPUT_REQUIRED`, call `bus.finished()`, emit `form_sent`.
5. `handleAction(ctx, bus, runId, part)` emits `form_action_received` with `{ messageId, contextId, taskId, formId, operationId, actionName, resumedTask, workflowId, final, receivedValues }`. Then it rejects:
   - an operation ID not matching `/^[\w-]{8,100}$/`, an unknown form, or a stale `formVersion`;
   - an uncorrelated action. A resumed task must be the form's task. A new message must list it in `referenceTaskIds` with the same `contextId`.
6. One action per form at a time. A second action **waits** for the first, then runs its checks on the new state. Never reply "busy": both requests resume the same task, so that reply would reach the first client too.
7. Dedupe by `metadata.operationId`. Same form, action and values → the stored body with `duplicate: true`, nothing re-run. Different values → reject ("This operation ID was already used with different values.").
8. Then reject a form no longer `awaiting_input`, a disabled workflow (`isEnabled`), or a failed `checkAction`. Otherwise call the handler.
9. A final `accepted` result sets `accepted`; a cancel sets `cancelled`. A closed form's reply includes `buildDelete(formId)`.
10. Store **every handler result** by operation ID — `accepted`, `rejected` (for example invalid values) and `cancelled` alike — so a retry with the same ID gets the same answer. Only the early refusals in items 5, 7 and 8 are not stored. A corrected resubmit uses a new operation ID. Emit `form_action_result`, reply, then emit `form_reply_sent` `{ formId, operationId, actionName, status, text, receipt, duplicate, taskState, contextId }`.
11. Replying: when resuming, publish `AgentEvent.task(ctx.task)` first, then `AgentEvent.statusUpdate(...)` with `INPUT_REQUIRED` (open) or `COMPLETED` (closed). For a new message, publish `AgentEvent.message(...)`.
12. Keep at most 1,000 forms, operations and request records.
13. Tutor Agent Card:
    - Add `capabilities.extensions`: `{ uri: A2UI_EXTENSION_URI, required: false, params: { supportedCatalogIds: [BASIC_CATALOG_ID], acceptsInlineCatalogs: false } }`.
    - Add `A2UI_MIME_TYPE` to both default modes, and `application/json` to `defaultOutputModes`.
14. Tutor `execute`: an A2UI part → `formHost.handleAction`. Otherwise chat: `wantsTutoringForm(text)` → offer the form; else the Step 1 reply.
15. Offering: if the client didn't declare A2UI support, reply in text "I can send an in-person tutoring request form, but your client didn’t declare A2UI v0.9 support, so I can’t show it." Otherwise `issue(...)` with intro "Here is the in-person tutoring request form. Fill it in and press “Send tutoring request”."
16. `submitTutoringRequest`:
    - Invalid → `{ status: 'rejected', message: 'Please correct the highlighted fields.', errors }`.
    - Valid → `createTutoringRequest(values)`, a local in-memory `Map` in `tutor-agent.js` (Step 6 moves it to `src/demo-store.js`). Record: `{ requestId: 'TR-' + 8 uppercase hex, status: 'Received — awaiting scheduling', contact, preferences: { preferredDate, period, specificTime, notes } }`.
    - Log `recorded tutoring request` with the `requestId`.
    - Return `{ status: 'accepted', message: TUTORING_ACK, values, receipt: { requestId, status, preferences, timezone: TIMEZONE_LABEL, demo: true, note: 'Demo request — this spike sends no email or scheduling message.' } }`.
    - Export `TUTORING_ACK = 'We received your request. A time slot will be sent based on your preferences.'`. Never say "Appointment booked".
17. `cancelForm` → `{ status: 'cancelled', message: 'Form cancelled. Nothing was submitted.' }`.
18. Test hook: `TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS` delays only the first form action.
19. Tutor logs always show `firstName`, `lastName` and `email` as `[redacted]`.
20. `src/student-agent.js`: every chat message carries `metadata.a2uiClientCapabilities = { 'v0.9': { supportedCatalogIds: [BASIC_CATALOG_ID] } }` and `serviceParameters: { [HTTP_EXTENSION_HEADER]: A2UI_EXTENSION_URI }`.
21. When `askTutor` gets a Task in `INPUT_REQUIRED` with an A2UI part, run `checkFormPayloadPolicy` **before anything renders** (failure throws "Rejected A2UI payload: …"). Return the reply with `form: { formId, workflowId, formVersion, issuer, prefilled, taskId, contextId, messageId, a2uiMessages }` and emit `form_received`.
22. `sendFormAction(baseUrl, { form, action, operationId, runId, timeoutMs = SUBMIT_TIMEOUT_MS, onEvent })`:
    - The card must advertise the A2UI extension.
    - `GetTask` for `form.taskId`. Still `INPUT_REQUIRED` → resume with `taskId`. Otherwise send a new message in the same `contextId` with `referenceTaskIds: [form.taskId]`.
    - Emit `form_action_sent` with `mode: 'resume-task' | 'new-message-referencing-task'`.
    - Check any update with `checkFormUpdatePolicy`. Return `{ body, a2uiUpdate, duplicate, … }` and emit `form_action_result`; on failure emit `form_action_failed`.
    - `SUBMIT_TIMEOUT_MS` defaults to 5000.
23. `deliveryOutcome(err, sendStarted)`, used by `askTutor` and `sendFormAction`:
    - before the send started, or `ECONNREFUSED` → `not_delivered`;
    - timeout, abort or `fetch failed` while sending → `uncertain`;
    - otherwise → `rejected`.
    Set `err.outcome`; `askTutor` puts it in `request_failed`. Never retry automatically.
24. `test/form.test.js`: tests that call the Tutor directly have "A2A" in their title. They check: invalid values, a forged button, a wrong `surfaceId` and an uncorrelated action are rejected; an action on a completed form uses `new-message-referencing-task` and gets the stored result; two operation IDs on one form record once.

### Task C — renderer bundle, browser forms, UI server

1. `src/browser/a2ui-entry.js`: `import '@a2ui/lit';`, then `export { basicCatalog } from '@a2ui/lit/v0_9'` and `export { MessageProcessor } from '@a2ui/web_core/v0_9'`. `npm run build:ui` writes `public/vendor/a2ui.js` (git-ignored).
2. `public/forms-ui.js` exports `createFormsUi({ log, agentName, onChange, pinToBottom })`. It imports `./vendor/a2ui.js` and `/shared/forms.js`. It returns `received`, `lifecycle`, `actionResult`, `actionFailed`, `setReplaying`, `replayDone`, `clear`, and a `busy` getter.
3. A form is a **chat item** where it arrived ("Received from Tutor Agent"): intro, surface, notice line, "IDs" `<details>`.
4. Mount: `new MessageProcessor([basicCatalog], onAction)`, `processMessages(structuredClone(a2uiMessages))`, and an `<a2ui-surface>` with `surface = processor.model.getSurface(formId)`. Unmount with the standard `deleteSurface` message (the renderer disposes the surface).
5. `onAction(action)`:
   - Ignore forms that aren't `editing`.
   - Final action: set `/ui/submitAttempted`, run `validateFinal`. Failure → list errors, send nothing.
   - Valid → snapshot values, unmount at once, show a "You sent" summary with "Sending request…", then POST `{ operationId: crypto.randomUUID(), action }`. If the POST fails, mount again with the snapshot and show the errors.
   - Cancel → unmount and POST it.
6. `lifecycle(data)`:
   - `submitting` → summary with pending text. `accepted` → summary only; the Tutor's reply follows as the next chat message.
   - `rejected` → the reason and an **"Edit and retry"** button: POST `/edit`, mount with the returned values.
   - `confirmation_pending` → "Confirmation pending" with only a **"Check status"** button (POST `/reconcile`).
   - `cancelled` → "Cancelled — nothing was submitted."
7. During replay, mount nothing. On `replayDone()`, mount only forms still `editing`. Never show a `formId` twice.
8. Set text only with `textContent`.
9. `src/ui-server.js`:
    - Raise the body limit to `express.json({ limit: '64kb' })`.
    - Serve `GET /shared/forms.js`.
    - Add run kind `form_action` to `NEXT_STATES`: `sending → completed | failed | uncertain`.
    - Keep `forms: Map(formId → { formId, workflowId, agentId, conversationId, contextId, taskId, formVersion, a2uiMessages, updates, state, inFlight, lastOperation, lastSubmitted })`.
10. On `form_received`, `registerForm`: `WORKFLOWS[workflowId].agentId !== issuer` → `refused`; a known `formId` keeps its state; else `editing`. Publish `form_received` with that `lifecycle` and `agentId: issuer`.
11. `POST /api/forms/:formId/actions`:
    - Allow only body keys `operationId`, `action`, and action keys `name, surfaceId, sourceComponentId, timestamp, context`.
    - Run `checkAction`; for a final action also `validateFinal`. Invalid → `400 { errors }`, nothing sent.
    - `409` when in flight, in `confirmation_pending`, or not `editing`.
    - Final → lifecycle `submitting` with `{ operationId, submitted: context }`; save `lastOperation`, `lastSubmitted`. Cancel → `cancelled`.
    - Start a `form_action` run calling `sendFormAction(TUTOR_URL, …)`.
12. When it settles: `accepted` → lifecycle `accepted` with `{ receipt, duplicate }`. Other final status → `rejected` with `errors`. Outcome `uncertain` → `confirmation_pending` with `operationId`. Other errors → `rejected` with `notDelivered: true`, `errors: { _form: 'Not delivered: …' }`.
13. `/edit` only from `rejected`: publish `editing` with `{ restored: true, values: lastSubmitted }`, return the values.
14. `/reconcile` only from `confirmation_pending`: publish `submitting` with `reconcile: true`, re-send `lastOperation` with the **same** operation ID.
15. `GET /api/events` ends its history replay with `event: replayed\ndata: {}\n\n`.
16. `public/app.js`:
    - `hello` → `formsUi.setReplaying(true)`; `replayed` → `replayDone()`.
    - Route `form_received`, `form_lifecycle`, `form_action_result`, `form_action_failed` to `formsUi`.
    - Tutor panel: `form_sent`, the `receivedValues` of `form_action_received`, "Accepted" (`form_action_result`), "Sent" (`form_reply_sent`).
    - After acceptance, show the Tutor's reply and receipt as an ordinary received chat message.
    - The `form_action` timeline, from real events only: `student:form_action_sent`, `tutor:form_action_received`, `tutor:form_reply_sent`, `student:form_action_result`.
17. `public/styles.css`: plain form styles, full chat width, roomy inputs. Step 6 does the visual design.

## Phase 3 — Join and check (lead)

1. Check that `ui-server.js` calls `sendFormAction` and reads `form_received` exactly as Task B built them.
2. Run `npm run build:ui`, then `node --test test/payload-policy.test.js test/a2ui-render.test.js`, then `node --test --test-name-pattern="A2A" test/form.test.js`.
3. Add the UI tests to `test/form.test.js` (a Tutor plus a UI server pointed at it). They check:
   - `public/index.html` has no "Request form"; `POST /api/forms` → 404; opening the page creates no form.
   - "I want to arrange in-person help with calculus" → a form; "Explain derivatives" → the ordinary reply.
   - **Round trip:** lifecycle `submitting` → `accepted`; receipt `requestId` matches `/^TR-/`, status "Received — awaiting scheduling"; reply text equals `TUTORING_ACK`; the update has `deleteSurface`; the Tutor's `receivedValues` deep-equal the submitted values; `recorded tutoring request` once; a second submit → 409.
   - **Invalid input** (blank names, bad email, weekend, period/time mismatch, unknown field) → 400, no `form_action_sent`, still `editing`.
   - **Duplicates:** two identical POSTs at once → one 202, one 409. An identical A2A retry returns the stored receipt with `duplicate: true`; other values with that ID are refused; recorded once.
   - **Reconnect:** a new event stream replays state, sends nothing, records nothing.
   - **Cancel:** lifecycle `cancelled`, nothing recorded.
   - **Unavailable Tutor:** kill it, submit → `rejected` with `notDelivered: true`, never `accepted`; `/edit` returns the exact values.
   - **Uncertain:** `TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS=1200`, `SUBMIT_TIMEOUT_MS=400` → `confirmation_pending`; new submit and `/edit` → 409; `/reconcile` → `accepted` with `duplicate: true`; both sends share the operation ID, the second is `new-message-referencing-task`; recorded once.
   - **Privacy:** a unique email never appears in the Tutor's logs.
4. Run `npm test` and fix failures until it passes.
5. (Optional — needs a browser; if none is available, say so.) Check in a real browser (Playwright if available): invalid values show inline errors; valid values show the summary, then the receipt.

## Rules that apply to the whole step

1. A2A carries agent messages. A2UI describes the UI inside A2A. The SSE stream only reports real events and delivers the received payload.
2. Never emit an event for something that didn't happen.
3. Never execute code, HTML or URLs from a payload.
4. Records are in memory; a Tutor restart clears them. Say so in the README.
5. Keep the `received message … messageId: '<id>'` and `listening on` log lines unchanged.

## Avoid these known problems

- Pin A2UI **v0.9**, not v0.9.1 (the installed renderer registers the v0_9 catalog).
- The renderer's ReDoS guard silently fails unsafe-looking regexes. Use catalog functions and `\S`.
- DateTimeInput `min`/`max` in any other format fails the schema's `oneOf`. Test **with** format checks.
- Every executor path publishes `AgentEvent.message` or `AgentEvent.task` first, including follow-ups on an existing task.
- Tutor events can arrive after the A2A reply. Tests wait for them.

## Done when

- `npm run build:ui` writes `public/vendor/a2ui.js`.
- `node --test test/payload-policy.test.js`, `node --test test/a2ui-render.test.js` and `node --test test/form.test.js` pass.
- `npm test` passes with 0 failed, including Steps 1–2.
- `grep -rn "innerHTML" public/*.js` finds nothing.
- Manual (optional — needs a browser; if none is available, say so): `npm run tutor` and `npm run ui`, open `http://127.0.0.1:4444`, ask "I want to arrange in-person help with calculus". The form renders; invalid input shows errors and sends nothing; valid input becomes "You sent", then the receipt arrives.

Then append the notes below to `CLAUDE.md` and commit `Step 3: A2UI form sent by the Tutor, submitted over A2A`.

## CLAUDE.md notes

- A2UI is pinned to v0.9; parts set `mediaType` and `metadata.mimeType` to `application/a2ui+json`.
- `src/forms.js` stays dependency-free (browser: `/shared/forms.js`). The issuing agent's validation counts.
- A form is one A2A Task in `INPUT_REQUIRED`. Actions resume it with `taskId`; a completed task gets a new message with `referenceTaskIds`.
- The form host dedupes by `metadata.operationId` (same values → stored result; different → rejected) and serializes actions per form.
- Delivery outcomes: before send or ECONNREFUSED → `not_delivered`; mid-send timeout/network error → `uncertain`, never auto-retried.
- The Student allowlists every A2UI payload and update before rendering.
- `structuredClone` before `processMessages`. `/ui/submitAttempted` gates check visibility; `/ui/submitLocked` disables buttons.
- The UI server owns the form lifecycle (`form_lifecycle`). The browser draws only forms still `editing` after `replayed`.
- `wantsTutoringForm` in `src/tutor-agent.js` is temporary; Step 6 replaces it.
- Tests count the Tutor log line `recorded tutoring request`. Keep it.

## Show it (optional)

After the manual check above, ask for a new form, stop the Tutor with `kill $(lsof -tiTCP:41241 -sTCP:LISTEN)`, and submit. You see "Not delivered"; "Edit and retry" brings your values back.
