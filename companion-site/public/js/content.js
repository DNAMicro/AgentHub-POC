// Content of the companion site, from the source map of the repository (Steps/, git history, tests).
// Every claim names where it comes from in the page's "Sources". Text uses `code` and *emphasis*
// marks only; it is rendered as text, never as HTML.

export const STEPS = [
  { n: 1, short: 'A2A connectivity', adds: 'Two processes, one real A2A message', commits: ['79c6ef4', 'bd61b67'] },
  { n: 2, short: 'Browser monitor', adds: 'Watch the exchange live (SSE telemetry)', commits: ['dad775b'] },
  { n: 3, short: 'A2UI form', adds: 'An agent sends a UI, not just text', commits: ['d9a1e9b', '3f31bb5'] },
  { n: 4, short: 'Haiku tutor', adds: 'Real answers from Claude Haiku 5.5', commits: ['e996a6a', '5cc671d'] },
  { n: 5, short: 'Routing & skills', adds: 'Library agent, routing, enforced skills', commits: ['020018c', '7bc2e21', '5cc671d'] },
  { n: 6, short: 'Forms on request', adds: 'Agents decide when a form is the answer', commits: ['c81e566', '99f4f38'] },
  { n: 7, short: 'University Hub', adds: 'One front door, registry, live topology', commits: ['cfb7040', 'ecb79af', '520b83a', '283c4fb', '81afc79', '39d242c', '5508964'] },
  { n: 8, short: 'Generated UI', adds: 'The model composes UI from a catalog', commits: ['48b2fa6', '7347f41'] },
  { n: 9, short: 'Professor', adds: 'Conversations start from either side', commits: ['6d84aec', 'cad2e9d', '2814874', '9150c60', '36ba0a6'] },
];

// ---- one architecture, nine snapshots ---------------------------------------------------------------
// Absolute snapshots; the site computes added / removed itself, and `modified` lists pieces whose job
// changed even where their label didn't. Labels are the connection's real payload, kept short.
export const ARCH = {
  1: {
    nodes: { student: { sub: 'CLI process · A2A client' }, tutor: { sub: 'A2A server · fixed reply' } },
    edges: { student_tutor: { label: 'SendMessage' } },
  },
  2: {
    nodes: { browser: { sub: 'monitor page (HTML, JS)' }, student: { sub: 'hosted in the UI server' }, tutor: { sub: 'A2A server · fixed reply' } },
    edges: { browser_student: { label: 'POST /api/runs' }, student_browser_sse: { label: 'SSE /api/events' }, student_tutor: { label: 'A2A + runId' }, tutor_student_sse: { label: 'SSE /viz/events' } },
    modified: ['student'],
  },
  3: {
    nodes: { browser: { sub: 'monitor + A2UI renderer' }, student: { sub: 'UI server · A2UI allowlist' }, tutor: { sub: 'A2A server · sends a form' } },
    edges: { browser_student: { label: 'runs + form submit' }, student_browser_sse: { label: 'SSE + A2UI payload' }, student_tutor: { label: 'A2A + A2UI' }, tutor_student_sse: { label: 'SSE /viz/events' } },
  },
  4: {
    nodes: { anthropic: {}, browser: { sub: 'monitor + A2UI renderer' }, student: { sub: 'UI server · A2UI allowlist' }, tutor: { sub: 'answers with Haiku 5.5' } },
    edges: { browser_student: { label: 'runs + form submit' }, student_browser_sse: { label: 'SSE + A2UI payload' }, student_tutor: { label: 'A2A + A2UI' }, tutor_student_sse: { label: 'SSE /viz/events' }, tutor_model: { label: 'Messages API' } },
  },
  5: {
    nodes: { anthropic: {}, browser: { sub: 'monitor + skills dialogs' }, student: { sub: 'UI server · router (registry)' }, tutor: { sub: 'answers within its skills' }, library: { sub: 'answers from saved content' } },
    edges: {
      browser_student: { label: 'runs + form submit' }, student_browser_sse: { label: 'SSE + A2UI payload' }, student_tutor: { label: 'A2A + notices' }, tutor_student_sse: { label: 'SSE /viz/events' },
      student_library: { label: 'A2A + notices' }, library_student_sse: { label: 'SSE /viz/events' },
      tutor_model: { label: 'answer + scope check' }, student_model: { label: 'routing' }, library_model: { label: 'evidence answers' },
    },
  },
  6: {
    nodes: { anthropic: {}, browser: { sub: 'chat with forms inside' }, student: { sub: 'UI server · form lifecycle' }, tutor: { sub: 'tutoring-request form' }, library: { sub: 'study-room booking form' } },
    edges: {
      browser_student: { label: 'runs + form actions' }, student_browser_sse: { label: 'SSE + form_lifecycle' }, student_tutor: { label: 'A2A + notices' }, tutor_student_sse: { label: 'SSE /viz/events' },
      student_library: { label: 'A2A + A2UI' }, library_student_sse: { label: 'SSE /viz/events' },
      tutor_model: { label: 'intent · review' }, student_model: { label: 'routing' }, library_model: { label: 'intent · review' },
    },
  },
  7: {
    nodes: { anthropic: {}, browser: { sub: 'tabs: chat, activity, topology' }, student: { sub: 'talks only to the Hub' }, hub: { sub: 'registry · router · relay' }, tutor: { sub: 'registers with the Hub' }, library: { sub: 'registers with the Hub' } },
    edges: {
      browser_student: { label: 'runs + form actions' }, student_browser_sse: { label: 'SSE + topology events' }, student_hub: { label: 'A2A' }, hub_student_sse: { label: 'SSE (redacted)' },
      hub_tutor: { label: 'A2A forward' }, hub_library: { label: 'A2A forward' },
      tutor_model: { label: 'intent · review' }, student_model: { label: 'clarify / pick' }, library_model: { label: 'intent · review' }, hub_model: { label: 'routing' },
    },
  },
  8: {
    nodes: { anthropic: {}, browser: { sub: 'tabs + UI inspector' }, student: { sub: 'talks only to the Hub' }, hub: { sub: 'router · signs the student' }, tutor: { sub: 'registers with the Hub' }, library: { sub: 'composes loan UI' }, storage: { title: 'data/library-loans.json', sub: 'loan facts and renewals (Library)' } },
    edges: {
      browser_student: { label: 'runs + form actions' }, student_browser_sse: { label: 'SSE + topology events' }, student_hub: { label: 'A2A' }, hub_student_sse: { label: 'SSE (redacted)' },
      hub_tutor: { label: 'A2A forward' }, hub_library: { label: 'signed A2A' },
      tutor_model: { label: 'intent · review' }, student_model: { label: 'clarify / pick' }, library_model: { label: 'compose A2UI' }, hub_model: { label: 'routing' }, library_storage: { label: 'loans' },
    },
  },
  9: {
    nodes: { anthropic: {}, browser: { sub: 'chat, activity, topology, professor' }, student: { sub: 'inbound endpoint + inbox' }, hub: { sub: 'router · lessons · sessions' }, tutor: { sub: 'registers with the Hub' }, library: { sub: 'composes loan UI' }, professor: { sub: 'answers · posts' }, storage: { title: 'data/*.json', sub: 'loans · lessons · inbox · outbox' } },
    edges: {
      browser_student: { label: 'runs + form actions' }, student_browser_sse: { label: 'SSE + topology events' }, student_hub: { label: 'A2A both ways (signed)' }, hub_student_sse: { label: 'SSE (redacted)' },
      hub_tutor: { label: 'A2A forward' }, hub_library: { label: 'signed A2A' }, hub_professor: { label: 'A2A both ways' },
      tutor_model: { label: 'intent · review' }, student_model: { label: 'clarify / pick' }, library_model: { label: 'compose A2UI' }, hub_model: { label: 'routing' }, professor_model: { label: 'answers + assistant' },
      library_storage: { label: 'loans' }, hub_storage: { label: 'lessons' }, student_storage: { label: 'inbox' }, professor_storage: { label: 'outbox' },
    },
    modified: ['student', 'hub', 'browser'],
  },
};

const S = (file, alt, caption) => ({ src: `img/${file}`, alt, caption });

export const PAGES = [
  // ---- Introduction ----------------------------------------------------------------------------------
  {
    id: 'intro', type: 'intro', step: 0,
    eyebrow: 'Introduction',
    title: 'From two agents to a university — how AgentHub-POC was built',
    lead: 'A learning spike, built one prompted step at a time: each step explained, implemented, tested, then stopped so the next could build on it. Nine steps took two Node.js processes exchanging one fixed message to five agents behind a university front door.',
    blocks: [
      { h: 'The problem', text: 'Show — with real protocols, not mock transcripts — how independent AI agents discover each other, exchange messages, hand a person structured UI, get routed by an intermediary, and start conversations from either side.' },
      { h: 'Who it is for', text: 'Developers learning agent-to-agent systems. Inside the demo the people are fictional: *Alex Student* (`student-alex`), *Sam Student* (enrolled, no agent running) and a Marketing 101 professor.' },
      { h: 'By the end of Step 9 you can explain', list: [
        'A2A v1.0 over JSON-RPC between separate processes: Agent Cards, Messages, Tasks, typed data parts',
        'A2UI v0.9 interfaces travelling inside A2A, rendered by the official renderer — including UI a model composes, checked by code',
        'Claude Haiku 5.5 inside each agent for answers, routing, clarifying, review and composition',
        'A hub that is the only front door: private registry, routing, relaying, signed identities',
        'Conversations that start on the other side: a professor’s post reaching an idle student',
      ] },
      { h: 'What stays outside the spike', list: [
        'Production readiness: no deployment, accounts or real authentication (Part 9’s keys are a local demo measure)',
        'No streaming, push notifications, fan-out to several agents, database or real email — JSON files under `data/` only',
        'Everything binds to 127.0.0.1; all data is fictional',
      ] },
    ],
    sources: ['`CLAUDE.md` — what this is, scope constraints', '`README.md` — hop-by-hop walkthrough', '`Steps/README.md` — the nine steps and their commits', '`package.json` — pinned dependencies'],
  },

  // ---- Step 1 ----------------------------------------------------------------------------------------
  {
    id: '1a', step: 1, type: 'A', title: 'Two agents talking over A2A',
    before: 'Nothing yet: an empty repository. The goal was to prove connectivity with the real protocol — not intelligence, not UI.',
    goal: '“Build a minimal local spike that proves two agents can communicate using the actual Agent-to-Agent (A2A) protocol.” The Student Agent sends “Hello Tutor Agent. Can you help me with calculus?”; the Tutor Agent answers through A2A.',
    capability: 'Two separate processes. The Student discovers the Tutor from its *Agent Card* (`/.well-known/agent-card.json`), then sends a real `SendMessage` over JSON-RPC and prints the Tutor’s fixed reply. Both sides log messageId, contextId and taskId.',
    tech: [
      { name: 'A2A protocol v1.0 (JSON-RPC binding)', kind: 'protocol', role: 'how agents describe themselves (Agent Card) and exchange Messages and Tasks', why: 'the point of the spike — a real protocol, not a custom REST call' },
      { name: '@a2a-js/sdk 1.3.0', kind: 'library', role: 'official A2A client and server for Node (`ClientFactory`, `DefaultRequestHandler`, Express adapters)', why: 'use the real interfaces; its types are v1.0 protobuf-shaped' },
      { name: 'Express 5.3.0', kind: 'library', role: 'HTTP host for the SDK’s JSON-RPC and Agent Card handlers' },
      { name: 'node:test', kind: 'runtime', role: 'test runner — the Tutor runs as a child process on a free port' },
    ],
    sources: ['`Steps/01-a2a-connectivity.md`', '`src/tutor-agent.js`, `src/student-agent.js`', '`test/a2a.test.js` — 4 tests at `79c6ef4`', 'Commits 79c6ef4, bd61b67'],
  },
  {
    id: '1b', step: 1, type: 'B', title: 'One message, discovered and delivered',
    walk: {
      title: '“Hello Tutor Agent. Can you help me with calculus?”',
      events: [
        { at: 'node:tutor', title: 'Tutor starts', caption: '`npm run tutor` listens on 127.0.0.1:41241 and builds its Agent Card with the real port.' },
        { at: 'edge:student_tutor', title: 'Discovery', caption: '`npm run student` fetches the card.', payload: 'GET /.well-known/agent-card.json' },
        { at: 'edge:student_tutor', reverse: true, title: 'Card returned', caption: 'Its `supportedInterfaces` names one JSON-RPC 1.0 endpoint; `ClientFactory` picks that transport.' },
        { at: 'edge:student_tutor', title: 'SendMessage', caption: 'One user text part, sent with `client.sendMessage`.', payload: 'POST /a2a/jsonrpc  method: SendMessage' },
        { at: 'node:tutor', title: 'Handler', caption: '`DefaultRequestHandler` assigns contextId/taskId; `tutorExecutor` logs “received message” and publishes a Message.' },
        { at: 'edge:student_tutor', reverse: true, title: 'Reply', caption: 'The fixed reply travels back as the JSON-RPC result.', payload: '“Hello Student Agent. Yes, I can help you with calculus.”' },
        { at: 'node:student', title: 'Printed', caption: 'The Student logs “received reply” with the same ids and prints the text.' },
      ],
    },
    build: [
      '`src/tutor-agent.js`: build the Agent Card, then `tutorExecutor` → `DefaultRequestHandler` → `jsonRpcHandler` / `agentCardHandler` — mounted *inside* the `listen()` callback so the card carries the real port.',
      '`src/student-agent.js`: `askTutor()` — resolve the card, `createFromAgentCard`, `sendMessage`, log the ids.',
      'Bind to 127.0.0.1 only; log stable `listening on http://127.0.0.1:<port>` lines (the tests parse them).',
      '`test/a2a.test.js`: card discoverable, exact reply received, ids traceable in both logs, Tutor down → a clear failure.',
    ],
    code: { caption: 'The Agent Card tells clients where and how to talk — `src/tutor-agent.js`', text: "supportedInterfaces: [\n  {\n    url: `http://${HOST}:${port}${JSONRPC_PATH}`,\n    protocolBinding: 'JSONRPC',\n    protocolVersion: A2A_PROTOCOL_VERSION,\n    tenant: '',\n  },\n]," },
    test: { cmd: 'node --test test/a2a.test.js\nnpm run tutor     # terminal 1\nnpm run student   # terminal 2', expect: 'Then: 4 tests passed. Today the file still checks the card and the exact reply. The Student prints “Hello Student Agent. Yes, I can help you with calculus.”; with the Tutor stopped it reports a connection failure, never a fake reply.' },
    pitfall: 'Examples online are A2A v0.3. SDK 1.x uses v1.0 protobuf-shaped types — parts are `{ content: { $case: "text", value } }`, roles are enums, the card has `supportedInterfaces`. Read the package’s `.d.ts` files.',
    takeaway: 'The protocol works between two processes — but you can only watch it in terminal logs. Step 2 makes the exchange visible without faking it.',
    sources: ['`src/tutor-agent.js` — card and executor', '`src/student-agent.js` — `askTutor`', '`test/a2a.test.js`', '`Steps/01-a2a-connectivity.md` — “Avoid these known problems”'],
  },

  // ---- Step 2 ----------------------------------------------------------------------------------------
  {
    id: '2a', step: 2, type: 'A', title: 'A browser window onto the exchange',
    before: 'The exchange existed only in two terminals’ logs. Nobody could watch it happen, and nothing showed request state.',
    goal: '“Enhance the existing two-agent A2A spike with a simple browser UI so I can watch the agents communicate” — truthfully: real events only, correlated per run, never resent on reconnect.',
    capability: 'A UI server hosts the Student Agent. The browser posts what you type; the Student sends it over A2A; a *separate* event stream reports what each side really did — sent, received, replied — with ids, times and a timeline.',
    tech: [
      { name: 'Server-sent events (SSE)', kind: 'standard', role: 'one-way event stream: Tutor `/viz/events` → UI server → browser `/api/events`', why: 'watch-only telemetry on its own channel — it never carries agent messages' },
      { name: 'Plain HTML, CSS and JavaScript', kind: 'runtime', role: 'the monitor page (no framework); text always set with `textContent`' },
    ],
    shot: S('s2-chat-ids.png', 'The conversation with a reply and its A2A ids expanded, and the hop-by-hop strip below', 'Today’s chat (the Step 2 monitor first had two side-by-side panels; its look was redesigned in Step 6). The IDs and the hop-by-hop strip are the Step 2 idea. Test stack, fictional data.'),
    sources: ['`Steps/02-browser-monitor.md`', '`src/ui-server.js`, `public/app.js`', '`test/ui.test.js` — 6 tests at `dad775b`', 'Commit dad775b'],
  },
  {
    id: '2b', step: 2, type: 'B', title: 'Two channels: A2A for messages, SSE for watching',
    walk: {
      title: 'Alex presses Send in the browser',
      events: [
        { at: 'edge:browser_student', title: 'Typed text posted', caption: 'The browser posts the message; the UI server creates a `runId` and publishes `run_started`.', payload: 'POST /api/runs { text }' },
        { at: 'node:student', title: 'Student sends', caption: '`askTutor(text, { runId })` — the only place an A2A request starts. Event `request_sent`.' },
        { at: 'edge:student_tutor', title: 'A2A message', caption: 'SendMessage, now carrying `metadata.runId` so every event can be tied to this run.' },
        { at: 'edge:tutor_student_sse', title: 'Tutor reports receipt', caption: 'The Tutor’s executor emits `message_received` on its own `/viz/events` the moment it happens.' },
        { at: 'edge:student_tutor', reverse: true, title: 'Reply over A2A', caption: 'The reply carries the same runId; the Tutor emits `reply_published`.' },
        { at: 'edge:tutor_student_sse', title: 'Reply reported', caption: 'Telemetry can arrive *after* the A2A reply — it is a different connection.' },
        { at: 'edge:student_browser_sse', title: 'Browser updates', caption: 'Every event is relayed to the browser; it renders the timeline and both sides’ messages with their ids.', payload: 'SSE /api/events  (replayed on reconnect, deduped by seq)' },
      ],
    },
    build: [
      '`src/ui-server.js`: host the Student; `POST /api/runs` starts a run (one at a time); keep a forward-only run state machine.',
      'Tutor: `/viz/events` SSE fed by `emitViz` calls inside the executor — events only where things really happen.',
      'UI server relays to `GET /api/events` with history replay; the browser dedupes by `seq` and resets on a new `bootId`.',
      '`public/app.js`: panels, timeline sent → received → replied → received, states idle → sending → waiting → completed / failed.',
    ],
    code: { caption: 'Telemetry is emitted where the event happens — `src/tutor-agent.js`', text: "// Visualization-only feed. Events are emitted from the executor at the moment\n// they actually happen; nothing here carries or replaces A2A traffic.\nconst vizEvents = new EventEmitter();\nconst emitViz = (type, runId, data) => vizEvents.emit('event',\n  { source: 'tutor', type, runId, at: new Date().toISOString(), data });" },
    test: { cmd: 'node --test test/ui.test.js', expect: 'Round trip observed step by step; two runs never mix; a second Send during a run is refused; a browser reconnect replays history but never resends the A2A request; Tutor down → a real error.' },
    pitfall: 'Never assume event order across channels: the reply can beat the telemetry describing it. Wait for the events — and never move a finished run backwards.',
    takeaway: 'You can now see every hop. But the Tutor can only send text — Step 3 lets an agent send an interface.',
    sources: ['`src/ui-server.js` — runs, relay, replay', '`src/tutor-agent.js` — `/viz/events`', '`public/app.js`', '`test/ui.test.js`', '`CLAUDE.md` — “Three channels — keep them separate”'],
  },

  // ---- Step 3 ----------------------------------------------------------------------------------------
  {
    id: '3a', step: 3, type: 'A', title: 'Agents can send UI: an A2UI form over A2A',
    before: 'Agents exchanged text only. Anything structured — a student’s name and email — had to be typed and parsed as prose.',
    goal: '“An A2UI form sent by Tutor Agent, completed by the student, and returned to Tutor Agent through A2A” — rendered from the description the Tutor sent, not hard-coded HTML.',
    capability: 'The Tutor answers with an A2A *Task* in `INPUT_REQUIRED` whose data part is an A2UI v0.9 description (fields, bindings, a submit action). The browser renders it with the official renderer; Submit sends an A2UI action back over A2A, resuming that task. Validation runs in the browser, the UI server and the Tutor (which decides).',
    tech: [
      { name: 'A2UI v0.9', kind: 'protocol', role: 'declarative UI messages (`createSurface`, `updateComponents`, `updateDataModel`) carried in A2A data parts as `application/a2ui+json`', why: 'an agent can describe UI safely: a catalog of components, no code' },
      { name: '@a2ui/lit 0.14.0 + @a2ui/web_core 0.14.0', kind: 'library', role: 'the official renderer and core (basic catalog, JSON schemas)' },
      { name: 'Lit 3.3.3', kind: 'library', role: 'web-component base the renderer is built on' },
      { name: 'esbuild 0.28.2 · jsdom 30.1.2 · Ajv 8.20.0', kind: 'library', role: 'dev tools: bundle the renderer for the browser; render in tests; validate payloads against the official schemas' },
    ],
    shot: S('s3-form-errors.png', 'The tutoring request form rendered in the chat with inline validation errors', 'The A2UI mechanics of Step 3 as they work today, in the tutoring-request form that replaced the Step 3 student-details form in Step 6. Inline checks come from the A2UI description. Test stack, fictional data.'),
    sources: ['`Steps/03-a2ui-form.md`', 'Step 3 form code in git: `d9a1e9b` (`src/student-form.js`, removed in Step 6)', '`src/form-host.js` — A2UI parts today', '`test/a2ui-render.test.js`, `test/payload-policy.test.js`', 'Commits d9a1e9b, 3f31bb5'],
  },
  {
    id: '3b', step: 3, type: 'B', title: 'The form is one A2A task',
    walk: {
      title: 'Alex requests the student-details form and submits it (Step 3 as built)',
      events: [
        { at: 'edge:browser_student', title: 'Request form', caption: 'In Step 3 a “Request form” button posted to the UI server (removed in Step 6 — you now ask in chat).', payload: 'POST /api/forms' },
        { at: 'edge:student_tutor', title: 'Ask for the form', caption: 'An A2A message with `metadata.request` and the A2UI extension header.', payload: 'A2A-Extensions: https://a2ui.org/a2a-extension/a2ui/v0.9' },
        { at: 'edge:student_tutor', reverse: true, title: 'Task: input required', caption: 'The Tutor returns a Task in `INPUT_REQUIRED` with the A2UI description in a data part.', payload: 'mediaType: application/a2ui+json' },
        { at: 'node:student', title: 'Allowlist', caption: 'The Student checks the payload against its A2UI allowlist (hardened after a security review, `3f31bb5`).' },
        { at: 'edge:student_browser_sse', title: 'Deliver to renderer', caption: 'The received A2UI payload reaches the browser over the existing event stream.' },
        { at: 'node:browser', title: 'Render and fill', caption: 'The official renderer draws it; drafts stay local; Submit validates first — invalid data is never sent.' },
        { at: 'edge:browser_student', title: 'Submit', caption: 'The UI server re-validates the values.', payload: 'POST /api/forms/:formId/submissions' },
        { at: 'edge:student_tutor', title: 'Action resumes the task', caption: 'An A2UI action data part with the same `taskId` (or a new message with `referenceTaskIds` if the task is already terminal).' },
        { at: 'node:tutor', title: 'Authoritative check', caption: 'The Tutor validates again, records once per `submissionId`, and acknowledges.' },
      ],
    },
    build: [
      'Shared, dependency-free form module (then `src/student-form.js`, today `src/forms.js`): builder, validation, payload allowlist — imported by browser, UI server and Tutor.',
      'Tutor: return a Task `INPUT_REQUIRED` with the A2UI parts; accept actions by `taskId`.',
      'Bundle `@a2ui/lit` with esbuild (`npm run build:ui`) and render the received payload.',
      'Before resuming, `GetTask`: a completed task is terminal — send a new message with `referenceTaskIds` instead.',
    ],
    code: { caption: 'A2UI in A2A: both the v1.0 field and the extension’s field — `src/form-host.js`', text: "// A2A v1.0 Parts have a native mediaType; the A2UI extension spec (written\n// against A2A v0.3 examples) names metadata.mimeType. Set both.\nconst a2uiPart = (messages) => ({\n  content: { $case: 'data', value: messages },\n  metadata: { mimeType: A2UI_MIME_TYPE },\n  filename: '', mediaType: A2UI_MIME_TYPE,\n});" },
    test: { cmd: 'node --test test/a2ui-render.test.js test/payload-policy.test.js', expect: 'The payload validates against the official v0.9 schemas; editing only changes local draft state; disallowed components are refused. (At Step 3: 27 tests in the suite.)' },
    pitfall: 'Pin the renderer’s A2UI version: v0.9, not v0.9.1, because `@a2ui/lit` 0.14.0 registers the v0.9 basic catalog. And never “resume” a finished task.',
    takeaway: 'Agents can now send UI — but the Tutor still answers every question with one fixed sentence. Step 4 gives it a model.',
    sources: ['`git show d9a1e9b` — the Step 3 form', '`src/forms.js`, `src/form-host.js`', '`test/a2ui-render.test.js`', '`CLAUDE.md` — “A2UI gotchas”, “Form = one A2A task”'],
  },

  // ---- Step 4 ----------------------------------------------------------------------------------------
  {
    id: '4a', step: 4, type: 'A', title: 'The Tutor gets a model: Claude Haiku 5.5',
    before: 'The Tutor returned the same fixed sentence whatever Alex asked.',
    goal: '“Connect Tutor Agent to Anthropic Claude Haiku 5.5 so it gives real, contextual tutoring responses” — with the key server-side only, bounded history, and honest failures.',
    capability: 'The Tutor calls the Anthropic Messages API from its own process. Three modes: `fixed` (the Step 1 reply), `mock` (labelled, for tests) and `live`. History is kept per A2A `contextId`; “New conversation” starts a fresh one. No hidden retries, no canned answers on failure.',
    tech: [
      { name: 'Claude Haiku 5.5 (`claude-haiku-5-5`)', kind: 'product', role: 'the model answering tutoring questions', why: 'fast and cheap enough for a demo; effort `low`, 800-token cap' },
      { name: 'Anthropic Messages API', kind: 'service', role: 'external HTTPS service — the only part outside 127.0.0.1' },
      { name: '@anthropic-ai/sdk 1.3.0', kind: 'library', role: 'official client; `maxRetries: 0` so every paid call is visible' },
    ],
    shot: S('s4-haiku-answer.png', 'A live chain-rule answer from the Tutor with the live model badges at the top', 'A live answer (Haiku 5.5) as it looks today, routed through the Hub added in Step 7. The “Tutor: live (claude-haiku-5-5)” badge is the Step 4 mode label. Test stack.'),
    sources: ['`Steps/04-haiku-tutor.md`', '`src/tutor-model.js`, `src/llm.js`', '`test/tutor-llm.test.js` — 13 tests at `e996a6a`', '`scripts/live-smoke.js`', 'Commits e996a6a, 5cc671d'],
  },
  {
    id: '4b', step: 4, type: 'B', title: 'A model call inside an A2A exchange',
    walk: {
      title: '“Explain the derivative of x squared” — then a follow-up',
      events: [
        { at: 'edge:browser_student', title: 'Question', caption: 'Posted as before; the same conversation keeps the same `contextId`.' },
        { at: 'edge:student_tutor', title: 'A2A message', caption: 'Nothing about A2A changed — the Student is still deterministic.' },
        { at: 'node:tutor', title: 'Guards first', caption: 'Ledger keyed by (contextId, messageId) — a repeat never makes a second paid call; one in-flight call per conversation.' },
        { at: 'edge:tutor_model', title: 'Model call', caption: 'System prompt + this conversation’s bounded history (10 messages / 12,000 characters).', payload: 'POST /v1/messages  model: claude-haiku-5-5' },
        { at: 'edge:tutor_model', reverse: true, title: 'Response checked', caption: 'Check `stop_reason` (refusal, max_tokens) before using the text; log model, latency and usage — not content.' },
        { at: 'edge:tutor_student_sse', title: 'Milestones reported', caption: 'Model call started / response received with token usage — still watch-only.' },
        { at: 'edge:student_tutor', reverse: true, title: 'Answer over A2A', caption: 'The exchange is appended to the history; the follow-up “why?” now has context.' },
      ],
    },
    build: [
      '`src/tutor-model.js`: `TUTOR_MODE` (read at import), system prompt, history per contextId, ledger, `toTutorError` sanitized codes.',
      'Key from the server’s environment or a git-ignored `.env`; never in A2A, logs, events or the browser (a test checks).',
      '`test/support/fake-anthropic.js`: live-mode tests against a local fake API — no real key, no network.',
      '`scripts/live-smoke.js`: an opt-in paid smoke test that refuses to run without `LIVE_SMOKE_MAX_USD`.',
    ],
    code: { caption: 'One call, no hidden retries — `src/llm.js` (moved here from `tutor-model.js` in Step 5)', text: "client ??= new Anthropic({ apiKey: apiKey(), maxRetries: 0 });\nconst response = await client.messages.create({\n  model: current.name,\n  max_tokens: maxTokens,\n  // thinking counts toward max_tokens\n  output_config: { effort: 'low' },\n  system,\n  messages,\n}, { timeout: timeoutMs });" },
    test: { cmd: 'node --test test/tutor-llm.test.js', expect: 'Live-mode requests are exactly as specified; follow-ups carry history; conversations are isolated; repeats never cost twice; the key never appears anywhere visible. (Suite at Step 4: 40.)' },
    pitfall: 'Haiku 5.5 rejects `temperature` / `top_p` / `top_k` (HTTP 400), and fake 429s came from a parent shell’s `ANTHROPIC_BASE_URL` proxy — start live servers with `env -u ANTHROPIC_BASE_URL` and check the logged API host.',
    takeaway: 'One smart agent answers everything — even plumbing questions. Step 5 adds a second agent and makes each one stay within its skills.',
    sources: ['`src/tutor-model.js`, `src/llm.js`', '`test/tutor-llm.test.js`, `test/support/fake-anthropic.js`', '`CLAUDE.md` — “Part 4 (model) notes”'],
  },

  // ---- Step 5 ----------------------------------------------------------------------------------------
  {
    id: '5a', step: 5, type: 'A', title: 'A second agent, routing, and skills that set the rules',
    before: 'One specialist: every chat went to the Tutor, and the Tutor answered anything at all.',
    goal: '“Intelligent routing between Tutor and Library agents, editable Agent Cards, automatic card-refresh notifications, and enforcement of each agent’s advertised scope.”',
    capability: 'A Library Agent joins. The Student routes each question (Haiku, over a trusted registry of card skills) and code validates the choice. Skills are editable (⚙); saving updates the Agent Card and notifies over A2A. Each agent refuses what its enabled skills don’t cover. From `7bc2e21`, skills carry private *answer content*, and the Library answers only from it — in live mode with evidence lines code checks verbatim.',
    noTech: '',
    tech: [
      { name: 'No new package', kind: 'runtime', role: 'the change is architectural: application-level routing over a trusted registry; the skill configuration is the single source for card, router and policy' },
      { name: 'A2A typed data part `agent-card-changed`', kind: 'format', role: 'this app’s convention for a card-change notification, sent as a normal A2A message' },
      { name: 'HTTP conditional fetch (ETag)', kind: 'standard', role: 'cards re-fetched only when changed, with `node:http`' },
    ],
    shot: S('s5-skills.png', 'The Library Agent’s skills dialog listing its skills with on/off toggles', 'The skills dialog (⚙) introduced in Step 5, as it looks today. Saving would update the Agent Card; the demo only looks. Test stack.'),
    sources: ['`Steps/05-routing-skills-scope.md`', '`src/router.js`, `src/skills.js`, `src/agent-settings.js`, `src/library-agent.js`, `src/library-model.js`', '`test/routing.test.js`, `test/scope.test.js`, `test/skills.test.js`, `test/card-refresh.test.js`', 'Commits 020018c, 7bc2e21, 5cc671d'],
  },
  {
    id: '5b', step: 5, type: 'B', title: 'Route by advertised skills; enforce them at the receiver',
    walk: {
      title: '“Where can I find a calculus textbook?” (the Student routed in Step 5)',
      events: [
        { at: 'edge:browser_student', title: 'Question', caption: 'Posted as before.' },
        { at: 'edge:student_model', title: 'Routing call', caption: 'The registry’s card skills go in as data; the model returns a structured decision.', payload: '{ decision: "route", agent_id: "library", skill_id: "find-resources" }' },
        { at: 'node:student', title: 'Validate the decision', caption: '`validateDecision`: the agent and skill must exist in the trusted registry — a URL-shaped or unknown choice fails closed.' },
        { at: 'edge:student_library', title: 'A2A to the Library', caption: 'The endpoint comes from the trusted registry, never from the model.' },
        { at: 'node:library', title: 'Scope and content', caption: 'The Library checks its enabled skills and answers only from their saved content.' },
        { at: 'edge:library_model', title: 'Evidence-backed answer', caption: 'Live mode must quote evidence lines; code checks they appear verbatim before releasing the answer.' },
        { at: 'edge:student_library', reverse: true, title: 'Answer', caption: 'Shown in the Library’s colour, with the routing note.' },
        { at: 'edge:student_tutor', reverse: true, title: 'Card changed', caption: 'Later, saving a skill in ⚙ sends an `agent-card-changed` data part over A2A; the Student re-fetches the card (ETag) and routing changes — no model call.' },
      ],
    },
    build: [
      '`src/skills.js`: one config → `buildCardSkills` (card), `buildScopeExtension` (`urn:a2a-spike:skill-scope:v1`), `policyFromConfig` (runtime) — swapped together on save.',
      '`src/router.js`: `ROUTER_MODE` direct / mock / live, the decision schema, `validateDecision`.',
      '`src/library-agent.js` + `src/library-model.js`: answers only from saved content; live answers need verbatim evidence.',
      '`src/agent-settings.js`: settings API with revisions/ETags and the A2A notification.',
    ],
    code: { caption: 'The router’s structured output — `src/router.js` (the Hub’s router since Step 7)', text: "const DECISION_SCHEMA = {\n  type: 'object',\n  properties: {\n    decision: { type: 'string', enum: ['route', 'clarify', 'unsupported'] },\n    agent_id: { type: 'string' },\n    skill_id: { type: 'string' },\n    reason: { type: 'string' },\n    clarification_question: { type: 'string' },\n  },\n  required: ['decision', 'agent_id', 'skill_id', 'reason', 'clarification_question'],\n  additionalProperties: false,\n};" },
    test: { cmd: 'node --test test/routing.test.js test/scope.test.js test/skills.test.js test/card-refresh.test.js', expect: 'Every example reaches exactly the expected agent — or none; physics and override attempts are declined even over direct A2A; saving notifies and changes routing with no model calls. (Suite: 71.)' },
    pitfall: 'Fetch cards with `node:http`, not `fetch`: undici adds `Cache-Control: no-cache` to conditional requests, Express answers 200 instead of 304, and revalidation silently never happens.',
    takeaway: 'Agents answer within their skills — but forms still need a button. Step 6 lets the receiving agent decide when a form is the answer.',
    sources: ['`src/router.js`, `src/skills.js`, `src/agent-settings.js`', '`src/library-agent.js`, `src/library-model.js`', '`test/routing.test.js`, `test/card-refresh.test.js`', '`CLAUDE.md` — “Part 5” notes'],
  },

  // ---- Step 6 ----------------------------------------------------------------------------------------
  {
    id: '6a', step: 6, type: 'A', title: 'Forms on request, with an advisory review',
    before: 'Forms came only from a “Request form” button, there was one static student-details form, and no agent decided anything about it.',
    goal: '“Conversationally triggered A2UI workflows for in-person tutoring requests and group study-room bookings, with correct form dismissal after submission, an advisory model review before anything is recorded, and a clean chat-style UI.”',
    capability: 'No form buttons: the agent that receives a request decides (from its own enabled workflow skill) to answer with a form — the Tutor’s *tutoring-request*, the Library’s *study-room-booking*. Only details from the student’s own words are prefilled. A model reviews every field before recording; it can only flag, and “Send anyway” is the student’s call. Forms live in the chat and become a “You sent” summary.',
    tech: [
      { name: 'No new package', kind: 'runtime', role: 'the change is behavioural: agent-decided workflows, a UI-server-owned form lifecycle (`editing → submitting → accepted | rejected …`), a model-based advisory review' },
      { name: 'Atkinson Hyperlegible Next, IBM Plex Mono', kind: 'format', role: 'self-hosted fonts for the chat-style redesign (OFL)' },
    ],
    shot: S('s6-booking-review.png', 'The group study room booking form in review state with a Confirm demo booking button', 'The Library’s booking form after “Review booking”: nothing is reserved until Confirm, and the slot is re-checked then. Test stack, demo availability.'),
    sources: ['`Steps/06-conversational-workflow-forms.md`', '`src/forms.js`, `src/form-host.js`, `src/form-intent.js`, `src/form-review.js`, `src/demo-store.js`', '`test/booking.test.js`, `test/form.test.js`', 'Commits c81e566, 99f4f38'],
  },
  {
    id: '6b', step: 6, type: 'B', title: 'From a sentence to a booking',
    walk: {
      title: '“I want to reserve a group study room for 4 people tomorrow afternoon”',
      events: [
        { at: 'edge:browser_student', title: 'Plain words', caption: 'No button — just the chat.' },
        { at: 'edge:student_model', title: 'Routing', caption: 'The Student’s router (still in the Student in Step 6) picks the Library.' },
        { at: 'edge:student_library', title: 'A2A request', caption: 'The Library classifies the intent: offer its booking workflow.' },
        { at: 'edge:student_library', reverse: true, title: 'Form as a Task', caption: 'A2UI Task `INPUT_REQUIRED`; group size and date prefilled from Alex’s words by `form-intent.js` — never by the model.' },
        { at: 'edge:student_browser_sse', title: 'Lifecycle: editing', caption: 'The UI server owns the form’s state and renders it as a chat item.' },
        { at: 'edge:student_library', title: 'Availability', caption: 'A `checkAvailability` action (scheduling fields only) → demo slots from the Library’s room store.' },
        { at: 'edge:browser_student', title: 'Review → Confirm', caption: 'Review first; Confirm sends the final action with an `operationId`.', payload: 'POST /api/forms/:formId/actions' },
        { at: 'edge:library_model', title: 'Advisory review', caption: '`reviewGate`: the model checks every field. It can only flag (`needs_review`); it never changes values.' },
        { at: 'node:library', title: 'Reserve atomically', caption: 'Synchronous check-and-set: no `await` between “is it free?” and “book it”.' },
        { at: 'edge:student_library', reverse: true, title: 'Receipt', caption: 'Booking ID back; the surface is deleted (`deleteSurface`) and replaced by “You sent”.' },
      ],
    },
    build: [
      '`src/forms.js` `WORKFLOWS`: each workflow is the agent’s reserved form skill; actions allowlisted with their button and fields.',
      '`src/form-host.js`: issue forms, handle actions, dedupe by `operationId`, serialize actions per form (`99f4f38`).',
      '`src/form-intent.js` (prefill from words), `src/form-review.js` (advisory review), `src/demo-store.js` (rooms).',
      '`public/forms-ui.js`: forms as chat items; re-render only forms still `editing` after a replay.',
    ],
    code: { caption: 'A workflow is data the agent owns — `src/forms.js`', text: "export const WORKFLOWS = {\n  'tutoring-request': {\n    id: 'tutoring-request', agentId: 'tutor',\n    skillId: 'in-person-tutoring-request',\n    title: 'Request an in-person calculus tutoring session',\n    finalAction: 'submitTutoringRequest',\n    actions: {\n      submitTutoringRequest: { button: 'submit_button', fields: TUTORING_FIELDS, final: true },\n      cancelForm: { button: 'cancel_button', fields: [], cancel: true },\n    },\n  }," },
    test: { cmd: 'node --test test/booking.test.js test/form.test.js', expect: 'Concurrent confirmations for one slot: exactly one booking; no request-form shortcut exists; a flagged submission comes back unrecorded and “Send anyway” records it. (Suite: 94.)' },
    pitfall: 'Two final submissions of one form were both recorded. Keep check-and-reserve synchronous, and queue actions per form rather than rejecting the second.',
    takeaway: 'Two agents, many abilities — but the Student holds every specialist’s address. Step 7 puts a university in between.',
    sources: ['`src/forms.js`, `src/form-host.js`, `src/form-intent.js`, `src/form-review.js`, `src/demo-store.js`', '`public/forms-ui.js`', '`test/booking.test.js`', '`CLAUDE.md` — “Part 6” notes'],
  },

  // ---- Step 7 ----------------------------------------------------------------------------------------
  {
    id: '7a', step: 7, type: 'A', title: 'One front door: the University Hub',
    before: 'The Student held the specialists’ URLs, the registry and the router; specialists notified the Student directly.',
    goal: '“Introduce a University Hub between the Student, Tutor and Library agents. The Student connects only to the university… Add a dedicated browser Topology tab.”',
    capability: 'The Hub (public name “California State University Fullerton”, fictional) keeps a private registry: specialists register, heartbeat and are dispatched only when *ready*. The router moved into the Hub; the Hub forwards on its own A2A leg, maps forms by opaque `formRef` and relays telemetry through an allowlist. Moving the router removed the Student’s model — you spotted that in the diagram — so the Student got its own model back, to clarify and pick a public capability.',
    tech: [
      { name: 'No new package', kind: 'runtime', role: 'hub-and-spoke orchestration: registry, readiness, heartbeats, per-agent model configuration, labelled topology telemetry' },
      { name: 'A2A typed data parts: register / heartbeat / deregister / card-changed', kind: 'format', role: 'this app’s control messages to the Hub, as normal A2A messages' },
      { name: 'Per-agent model choice', kind: 'product', role: 'each agent names its model (Haiku 5.5 default; Sonnet 5.5 and Opus 5.5 allowed); unknown names stop startup' },
    ],
    shot: S('s7-topology.png', 'The live Topology tab: Student, University Hub, Tutor, Professor and Library nodes with model boxes and the event list', 'The Topology tab (added in Step 7), shown today with the Professor from Step 9. Pulses appear only for events the agents reported. Test stack.'),
    sources: ['`Steps/07-university-hub-topology.md`', '`src/hub-agent.js`, `src/hub-registry.js`, `src/hub-link.js`, `src/student-assistant.js`, `src/topology.js`', '`test/hub.test.js`, `test/student-model.test.js`', 'Commits cfb7040, ecb79af, 520b83a, 283c4fb'],
  },
  {
    id: '7b', step: 7, type: 'B', title: 'Two A2A legs, one decision',
    walk: {
      title: '“Explain the derivative of x squared”, through the Hub',
      events: [
        { at: 'edge:browser_student', title: 'Question', caption: 'Posted as before.' },
        { at: 'node:student', title: 'Student plans', caption: 'One public capability matches (tutoring) → obvious, sent as-is; the Hub decides. Zero or several matches would ask the Student’s model.' },
        { at: 'edge:student_hub', title: 'Leg 1: Student → Hub', caption: 'The Student knows only the university’s public card.' },
        { at: 'edge:hub_model', title: 'Hub routes', caption: 'Router call over the registry’s skills; `validateDecision` checks the result.' },
        { at: 'node:hub', title: 'Ready?', caption: 'Only a *ready* specialist gets work — registered isn’t enough.' },
        { at: 'edge:hub_tutor', title: 'Leg 2: Hub → Tutor', caption: 'Its own messageId and context, plus `hubOperationId`; endpoint from configuration only.' },
        { at: 'edge:tutor_model', title: 'Scope + answer', caption: 'The Tutor checks scope and answers.' },
        { at: 'edge:hub_tutor', reverse: true, title: 'Answer', caption: 'Back to the Hub.' },
        { at: 'edge:student_hub', reverse: true, title: 'Relayed', caption: 'With `servedBy` and the decision — “Agent identified” in the hop strip.' },
        { at: 'edge:hub_student_sse', title: 'Telemetry', caption: 'Specialists’ events go to the Hub, which redacts them by allowlist and relays them; the topology animates only labelled real events.' },
      ],
    },
    build: [
      '`src/hub-agent.js`: public card, executor (control messages first, then student requests), router, forward/relay, `formRef` mapping, ledgers.',
      '`src/hub-registry.js` + `src/hub-link.js`: register, heartbeat, statuses ready / stale / unreachable / disconnected / disabled / invalid_card.',
      '`src/config.js`: validated configuration — specialist URLs live only in the Hub’s config.',
      '`src/student-assistant.js` (clarify / pick capability), `src/topology.js` + `public/topology.js` (labelled events → animated graph).',
    ],
    code: { caption: 'Control messages are typed A2A data parts — `src/hub-link.js`', text: "export const REGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-register+json';\nexport const HEARTBEAT_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-heartbeat+json';\nexport const DEREGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-deregister+json';\nexport const CONTROL_MEDIA_TYPES = new Set([REGISTER_MEDIA_TYPE,\n  HEARTBEAT_MEDIA_TYPE, DEREGISTER_MEDIA_TYPE, CARD_CHANGED_MEDIA_TYPE]);" },
    test: { cmd: 'node --test test/hub.test.js test/student-model.test.js', expect: 'The Student only ever sees the public card; heartbeat expiry → stale, sign-out → disconnected, neither gets requests; telemetry redaction is an allowlist; obvious questions go on as-is. (Suite: 115.)' },
    pitfall: 'A structural move can delete a capability as a side effect: moving the router to the Hub removed the Student’s only model. Say so and ask before removing what works.',
    takeaway: 'Every form so far was a template the server registered. Step 8 lets a model compose the interface — and makes code check it.',
    sources: ['`src/hub-agent.js`, `src/hub-registry.js`, `src/hub-link.js`, `src/config.js`', '`src/student-assistant.js`, `src/topology.js`', '`test/hub.test.js`', '`CLAUDE.md` — “Part 7” notes'],
  },

  // ---- Step 8 ----------------------------------------------------------------------------------------
  {
    id: '8a', step: 8, type: 'A', title: 'The model builds the interface',
    before: 'Every form was a template registered in code; models only chose an outcome. Identity forwarded by the Hub was a plain metadata field.',
    goal: '“Demonstrate a model that understands the conversation, decides whether to answer, ask a clarifying question, or generate an interface, and composes that interface from a supported component catalog” — not a template picked by keyword.',
    capability: 'For Alex’s (synthetic) book loans the Library’s model returns `answer`, `clarify` or `ui` — an A2UI surface composed from the installed catalog. Code validates it (official schema, allowed components, real loan ids, date limits = what policy permits) with up to two repairs. A loan service owns every fact and renews idempotently. The borrower is the student the Hub *signed*, never the model or browser.',
    tech: [
      { name: 'Ajv 8.20.0 at runtime', kind: 'library', role: 'moved from a dev tool to a runtime dependency: validate generated UI against the official A2UI JSON schemas' },
      { name: 'HMAC signatures (node:crypto)', kind: 'runtime', role: 'the Hub signs `studentId|contextId|hubOperationId` with a key each specialist gave it at registration' },
      { name: 'JSON file store', kind: 'format', role: '`data/library-loans.json` — the first thing that survives a restart' },
    ],
    shot: S('s8-generated-ui.png', 'A renewal interface composed by the model: a heading, the current due date, a date picker and a Renew button', 'A screen nobody designed: the model picked these components from the catalog; code checked them, including the date picker’s permitted range. Test stack, synthetic loans.'),
    sources: ['`Steps/08-model-generated-ui-loans.md`', '`src/loan-model.js`, `src/a2ui-catalog.js`, `src/loan-store.js`', '`test/loans.test.js` — 14 tests', 'Commits 48b2fa6, 7347f41'],
  },
  {
    id: '8b', step: 8, type: 'B', title: 'Model proposes, code disposes',
    walk: {
      title: '“Can I keep the calculus book until after my exam?”',
      events: [
        { at: 'edge:student_hub', title: 'Question', caption: 'Through the Hub as in Step 7.' },
        { at: 'edge:hub_model', title: 'Route', caption: 'A rule for the student’s *own* borrowed items sends it to the Library.' },
        { at: 'edge:hub_library', title: 'Signed student', caption: 'The Hub signs who is asking with the Library’s registration key.', payload: 'hubSignature = HMAC(studentId|contextId|hubOperationId)' },
        { at: 'node:library', title: 'Verify, classify', caption: '`verifiedStudent` checks the signature; the request is about *my loans*.' },
        { at: 'edge:library_storage', title: 'Facts', caption: 'Due dates, eligibility and permitted return dates come only from the loan store.' },
        { at: 'edge:library_model', title: 'Compose', caption: 'The model returns `ui` with `components_json` + `data_model_json` built from the catalog.' },
        { at: 'node:library', title: 'Validate', caption: '`validateGeneratedUi`: schema, allowed components, real loan id, date picker min/max = permitted range — else up to two repairs.' },
        { at: 'edge:student_hub', reverse: true, title: 'Relayed unchanged', caption: 'The Hub relays the generated surface as a Task; the inspector shows model output, checks and facts apart.' },
        { at: 'edge:hub_library', title: 'Renew', caption: 'The generated button’s action comes back with its `formRef`; the Library re-verifies the borrower, version and range.' },
        { at: 'edge:library_storage', title: 'Persisted once', caption: 'An idempotent renewal; a double click returns the stored result.' },
      ],
    },
    build: [
      '`src/loan-store.js`: authoritative facts, policy (2 renewals, 21 days), idempotent persisted renewals.',
      '`src/a2ui-catalog.js`: the model-visible catalog generated from the installed schemas; `validateGeneratedUi`.',
      '`src/loan-model.js`: one structured call → answer / clarify / ui; ≤2 repairs; a truthful fallback.',
      'Hub: `callKey` at registration, `registry.signFor`; Library: `hubLink.verifiedStudent` — never trust a bare metadata field.',
    ],
    code: { caption: 'Three outcomes, UI as JSON strings — `src/loan-model.js`', text: "const SCHEMA = {\n  type: 'object',\n  properties: {\n    kind: { type: 'string', enum: ['answer', 'clarify', 'ui'] },\n    text: { type: 'string' },\n    loan_ids: { type: 'array', items: { type: 'string' } },\n    components_json: { type: 'string' },\n    data_model_json: { type: 'string' },\n  },\n  required: ['kind', 'text', 'loan_ids', 'components_json', 'data_model_json'],\n  additionalProperties: false,\n};" },
    test: { cmd: 'node --test test/loans.test.js', expect: 'The catalog is the installed renderer’s; an eligible renewal goes through the Hub to a verified receipt and renews once; the Library never takes the borrower from the caller; mock mode never generates UI. (Scripted model output: plumbing, not judgment. Suite: 129.)' },
    pitfall: 'A metadata field is not authentication: with a plain `studentId`, anyone could read or renew another student’s loans. The forwarder signs; the receiver verifies.',
    takeaway: 'Every conversation still starts with the student. Step 9 lets the other side begin.',
    sources: ['`src/loan-model.js`, `src/a2ui-catalog.js`, `src/loan-store.js`', '`src/hub-link.js` — `verifiedStudent`', '`test/loans.test.js`', '`CLAUDE.md` — “Part 8” notes'],
  },

  // ---- Step 9 ----------------------------------------------------------------------------------------
  {
    id: '9a', step: 9, type: 'A', title: 'The professor can start the conversation',
    before: 'Every exchange began with the student; the Student’s identity at the Hub was self-declared; the inspector relayed full model text.',
    goal: '“Demonstrate that communication can begin on either side… a professor can also introduce a lesson while the student is idle.”',
    capability: 'A Marketing 101 Professor agent joins behind the Hub. A post travels Professor → Hub → Student as a *new*, signed A2A message into the Student agent’s persisted inbox — queued, delivered, opened, reconciled if an acknowledgement is lost. The Professor view is a chat: plain messages go to tagged students or the class; `@assistant` asks the course assistant. Later in the step: messages arrive in the student’s chat with Reply, replies reach whoever sent them, and the assistant schedules meetings from times the professor gives.',
    tech: [
      { name: 'No new package', kind: 'runtime', role: 'the reverse route is a normal `message/send` with typed data parts — not A2A push notifications' },
      { name: 'Signed sessions for every Hub caller', kind: 'standard', role: 'per-process HMAC keys: specialists, the Professor’s posts, and the Student (challenge to its configured endpoint, then a signature on every request)' },
      { name: 'JSON files', kind: 'format', role: '`data/hub-lessons.json`, `data/student-inbox.json`, `data/professor-outbox.json`' },
    ],
    shot: S('s9-professor.png', 'The Professor view: posts with per-student delivery states, a student reply and the assistant’s answer', 'The Professor view: each post shows each student’s state (Delivered, Opened, Queued at Hub). Test stack, fictional class.'),
    sources: ['`Steps/09-marketing-101-professor-lessons.md`', '`src/professor-agent.js`, `src/hub-lessons.js`, `src/student-inbox.js`, `src/lessons.js`, `src/meeting-times.js`', '`test/professor.test.js` — 20 tests', 'Commits 6d84aec, cad2e9d, 2814874, 9150c60, 36ba0a6'],
  },
  {
    id: '9b', step: 9, type: 'B', title: 'End to end: a lesson reaches an idle student',
    walk: {
      title: 'The professor posts; Alex, idle, opens it and asks a follow-up',
      events: [
        { at: 'edge:browser_student', title: 'Professor writes', caption: 'In the Professor view; proxied through the Hub to the Professor’s authoring API.', payload: 'POST /api/professor/chat → /author/chat' },
        { at: 'edge:professor_model', title: 'Name it', caption: 'A plain message goes out as written; the model only names it (lesson or message, a title).' },
        { at: 'edge:professor_storage', title: 'Outbox', caption: 'Persisted with a stable operation id — a retry never makes a second post.' },
        { at: 'edge:hub_professor', reverse: true, title: 'Publish (signed)', caption: 'A2A data part `lesson-publish`, signed with the Professor’s registration key.' },
        { at: 'edge:hub_storage', title: 'Hub records it', caption: 'Checks course and enrollment, dedupes, creates one delivery per student.' },
        { at: 'edge:student_hub', reverse: true, title: 'Delivery (new A2A message)', caption: 'To the Student’s configured inbound endpoint, signed with its session key — Alex never asked.', payload: 'application/vnd.a2a-spike.lesson-delivery+json' },
        { at: 'edge:student_storage', title: 'Delivered = committed', caption: 'The Student writes the inbox entry to disk, *then* replies “delivered”. Lost ack? The Hub queries before re-sending.' },
        { at: 'edge:student_browser_sse', title: 'Toast', caption: 'A toast that never steals focus; opening it sends a signed “opened” receipt.' },
        { at: 'edge:student_hub', title: 'Follow-up', caption: 'The question carries `lessonDeliveryId`; the Hub routes it by its own delivery record, not keywords.' },
        { at: 'edge:hub_professor', title: 'To its professor', caption: 'With the lesson id and the Hub-signed student.' },
        { at: 'edge:professor_model', title: 'Answer from the lesson', caption: 'Dates not in the lesson or question are rejected by code.' },
        { at: 'edge:student_hub', reverse: true, title: 'Answer', caption: 'Relayed to Alex — the same front door as Step 7, the same A2A as Step 1.' },
      ],
    },
    build: [
      '`src/lessons.js`: media types, `sign` / `verify`, `contentHash`.',
      '`src/hub-lessons.js`: publish checks, deliveries, retries, reconcile-by-query, sessions.',
      '`src/student-inbox.js`: the Student’s inbound A2A endpoint and persisted inbox.',
      '`src/professor-agent.js` + `public/classroom.js`: the Professor’s chat, posts, replies and meetings.',
    ],
    code: { caption: 'The reverse route’s typed messages — `src/lessons.js`', text: "const MT = (name) => `application/vnd.a2a-spike.${name}+json`;\nexport const LESSON_PUBLISH_MEDIA_TYPE = MT('lesson-publish');   // Professor → Hub\nexport const LESSON_DELIVERY_MEDIA_TYPE = MT('lesson-delivery'); // Hub → Student\nexport const LESSON_QUERY_MEDIA_TYPE = MT('lesson-query');       // reconcile\nexport const LESSON_RECEIPT_MEDIA_TYPE = MT('lesson-receipt');   // opened" },
    test: { cmd: 'node --test test/professor.test.js', expect: 'An idle student gets the lesson; a lost acknowledgement is reconciled without a duplicate; a toast never marks it opened. (`npm test`: 150 in total.)' },
    pitfall: '“Accepted by the Hub” is not “delivered”: count it delivered only after the Student commits it, and query an uncertain delivery before ever sending it again.',
    recap: [
      '*A2A*: one real message between two processes',
      '*Monitor*: a watch-only SSE channel',
      '*A2UI*: an agent sends UI inside A2A',
      '*Haiku*: a model behind the Tutor',
      '*Skills*: route by skills, enforce at the receiver',
      '*Forms*: the agent decides, code records',
      '*Hub*: one front door, two A2A legs',
      '*Generated UI*: model composes, code validates',
      '*Professor*: either side can start',
    ],
    takeaway: 'Models judge; code validates and owns the facts; every arrow is a real message. Step 1 vs Step 9: previous page.',
    sources: ['`src/lessons.js`, `src/hub-lessons.js`, `src/student-inbox.js`', '`src/professor-agent.js`, `public/classroom.js`', '`test/professor.test.js`', '`CLAUDE.md` — “Part 9” notes'],
  },
];
