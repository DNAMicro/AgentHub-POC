# Step 0 — Project setup and the names everyone must use

Time: about 10 minutes. Cost: free (no model calls).

## What you'll have when this works

An empty project with pinned packages, the folder layout, a `CLAUDE.md`, and a passing empty test run. Every later step uses the **exact names on this page**. Later steps say "create `src/forms.js`" and expect that exact file, so don't rename anything.

## Instructions for Claude

You are the **lead**. In this step, do the work yourself; there is nothing to split.

1. Work in the student's project folder: the current folder, at its root (never a subfolder). It holds the course materials and nothing else yet. That is either just the `Steps-classroom/` folder the student copied in, or the AgentHub-Exercise repo (`Steps/`, `Steps-classroom/`, `companion-site/`, `README.md`, `LICENSE`). Keep all of them as they are and commit them with everything else. If `Steps-classroom/00-setup-and-contracts.md` is missing, stop and ask the student to copy the folder in first. Later steps' subagents read it.
2. Create `package.json` exactly as in "Package file" below.
3. Run `npm install`. Check that `package-lock.json` now exists.
4. Create the folders: `src/`, `src/browser/`, `public/`, `public/vendor/`, `test/`, `test/support/`, `scripts/`, `config/`, `data/`.
5. Create `.gitignore` and `.env.example` exactly as below.
6. Create `CLAUDE.md` with the text in "Project CLAUDE.md" below.
7. Run `git init` only if the folder is not already a git repository (a cloned AgentHub-Exercise already is). Then commit everything with the message `Step 0: project setup`.
8. Run `npm test`. With no test files yet, Node prints `tests 0` and exits successfully. That counts as passing.

## Package file

Use these **exact** versions. Don't upgrade them and don't use `^` or `~`. Later steps depend on how these exact versions behave.

```json
{
  "name": "agenthub-classroom",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "HUB_URL=http://127.0.0.1:9 node --test --test-reporter=spec test/"
  },
  "dependencies": {
    "@a2a-js/sdk": "1.3.0",
    "@a2ui/lit": "0.14.0",
    "@a2ui/web_core": "0.14.0",
    "@anthropic-ai/sdk": "1.3.0",
    "ajv": "8.20.0",
    "express": "5.3.0",
    "lit": "3.3.3"
  },
  "devDependencies": {
    "esbuild": "0.28.2",
    "jsdom": "30.1.2"
  }
}
```

Each step adds its own `npm` scripts. The full list is in "npm scripts by step" below.

## .gitignore

```
node_modules/
public/vendor/
.env
.env.*
!.env.example
.temp
data/
.DS_Store
*.log
```

## .env.example

```
# Copy this file to .env and put your own key in it. .env is git-ignored.
# Only live modes read it. Tests never need it.
ANTHROPIC_API_KEY=your-anthropic-api-key-here
```

## Project CLAUDE.md

Write this file as-is. Later steps append their own notes to it.

```markdown
# CLAUDE.md

Classroom rebuild of AgentHub: agents that talk over the real A2A protocol (v1.0, JSON-RPC) with
@a2a-js/sdk 1.3.0, through a university Hub, with A2UI v0.9 forms and Claude Haiku 5.5.

Rules for every step:
- Plain ESM JavaScript ("type": "module"). No TypeScript, no lint, no frontend framework.
- Every server binds to 127.0.0.1 only.
- Use the exact file names, ports, env vars and npm scripts from Steps-classroom/00-setup-and-contracts.md.
- Keep dependency versions pinned exactly. Never upgrade a package.
- Never read, print or log the API key or .env. Report only whether a key is present.
- Tests never call the real Anthropic API. They use test/support/fake-anthropic.js via ANTHROPIC_BASE_URL.
- Use fictional sample data only (Alex Student, alex@example.com).
- The browser sets text with textContent. Never use innerHTML.
- Stop only the servers you started: save $! when you start one in the background and kill that PID,
  or kill by port (kill $(lsof -tiTCP:<port> -sTCP:LISTEN)) only after checking the port was free
  before you started. If a port such as 4444 or 41241-41244 is already in use when you begin,
  don't stop that process (it may be the user's running app): say so and skip that check.
  Never use broad pkill patterns.
- When starting live servers from Claude Code, run them with `env -u ANTHROPIC_BASE_URL`
  (Claude Code's shell sets that variable to a local proxy that answers with fake errors).
```

## How each later step runs (subagents)

Every later step has the same three phases. The student pastes the step file into Claude Code. Claude is the **lead**.

1. **Contracts (lead, alone).** The lead writes the small shared pieces the step lists: shapes, IDs, constants, function signatures. Subagents start only after these exist.
2. **Build (subagents, at the same time).** The lead starts every task in the step's task table **in one message**, using the Agent tool, so the tasks run in parallel. Use the model the table names (`haiku` by default, `sonnet` where marked). Give each subagent:
   - the whole step file,
   - this file (`00-setup-and-contracts.md`),
   - its task row: the files it owns, what it must build, and its "done when" check.
   
   A subagent edits **only the files it owns**. If it needs a change in another file, it reports that back to the lead and does not make the change itself.
3. **Join and check (lead, alone).** The lead wires the pieces together, runs the step's "Done when" commands, and fixes failures. The step is finished only when every check passes. Then the lead appends the step's "CLAUDE.md notes" to `CLAUDE.md` and commits with the message `Step N: <title>`.

Recommended models: **Sonnet 5.5 (`claude-sonnet-5-5`) for the lead session**, and Haiku 5.5 for the subagents. If a Haiku subagent fails its "done when" check twice, the lead re-runs that one task with `sonnet`.

## Ports

| Process | File | Port | Address override |
|---|---|---|---|
| Tutor Agent | `src/tutor-agent.js` | 41241 | `PORT`, `TUTOR_URL` |
| Library Agent | `src/library-agent.js` | 41242 | `PORT`, `LIBRARY_URL` |
| University Hub | `src/hub-agent.js` | 41243 | `PORT`, `HUB_URL` |
| Marketing 101 Professor | `src/professor-agent.js` | 41244 | `PORT`, `PROFESSOR_URL` |
| Student UI server (browser at `http://127.0.0.1:4444`) | `src/ui-server.js` | 4444 | `UI_PORT`, `STUDENT_URL` |

`PORT=0` / `UI_PORT=0` means "pick a free port". Tests use this.

Who reads the address overrides:
- `TUTOR_URL`, `LIBRARY_URL`, `PROFESSOR_URL`: whoever calls that agent. Before Step 7a, that is the UI server. From Step 7a on, only the Hub calls them.
- `HUB_URL`: the UI server, from Step 7a on.
- `STUDENT_URL`: in Steps 5–6 the Tutor and Library use it to send `agent_card_changed` to the UI server. Steps 7a–9a don't use it, because notifications go to the Hub. From Step 9b on, the Hub uses it as the student's endpoint for lesson delivery.

**Startup log contract.** When a server is ready, it prints one line that tests wait for. The format is `[<Name>] listening on http://127.0.0.1:<port>`:
- `[Tutor Agent] listening on …`
- `[Library Agent] listening on …`
- `[Hub] listening on …`
- `[Marketing 101 Professor] listening on …`
- `[UI] listening on …`

Never change these lines.

## Files, and the step that creates each one

A file is created in the step shown, and later steps may extend it. Never create a file earlier than its step. A few functions move between files later. Each step says exactly what moves. For example, Step 5 puts `getCard` and `validateCard` in `src/router.js`, and Step 7a moves them unchanged into `src/cards.js`.

| Step | Files created |
|---|---|
| 1 | `src/tutor-agent.js`, `src/student-agent.js`, `test/a2a.test.js`, `test/support/harness.js` |
| 2 | `src/ui-server.js`, `src/local-guard.js`, `public/index.html`, `public/app.js`, `public/styles.css`, `test/ui.test.js` |
| 3 | `src/forms.js`, `src/form-host.js`, `src/browser/a2ui-entry.js`, `public/forms-ui.js`, `test/support/a2ui-schema.js`, `test/support/render-form.js`, `test/form.test.js`, `test/a2ui-render.test.js`, `test/payload-policy.test.js` |
| 4 | `src/tutor-model.js`, `src/llm.js`, `src/models.js`, `test/support/fake-anthropic.js`, `test/tutor-llm.test.js`, `scripts/live-smoke.js` |
| 5 | `src/skills.js`, `src/agent-settings.js`, `src/library-agent.js`, `src/library-fixture.js`, `src/library-model.js`, `src/router.js`, `src/text-match.js`, `test/skills.test.js`, `test/scope.test.js`, `test/routing.test.js`, `test/card-refresh.test.js`, `scripts/live-eval.js` |
| 6 | `src/form-intent.js`, `src/form-review.js`, `src/demo-store.js`, `test/booking.test.js` |
| 7a | `src/config.js`, `src/cards.js`, `src/hub-agent.js`, `src/hub-registry.js`, `src/hub-link.js`, `config/*.example.json`, `test/hub.test.js`, `scripts/start-all.js` |
| 7b | `src/student-assistant.js`, `src/topology.js`, `public/topology.js`, `test/student-model.test.js`, `scripts/browser-checks/chat-scroll.js` |
| 8 | `src/loan-store.js`, `src/a2ui-catalog.js`, `src/loan-model.js`, `test/loans.test.js` |
| 9a | `src/professor-agent.js`, `src/professor-model.js`, `src/course-pack.js` |
| 9b | `src/lessons.js`, `src/a2a-data.js`, `src/json-store.js`, `src/hub-lessons.js`, `src/student-inbox.js`, `public/classroom.js`, `test/professor.test.js` |
| 9c | `src/meeting-times.js` |

## npm scripts by step

Each step adds its scripts to `package.json`.

| Step | Scripts |
|---|---|
| 1 | `"tutor": "node src/tutor-agent.js"`, `"student": "node src/student-agent.js"` |
| 2 | `"ui": "node src/ui-server.js"` (Step 3 changes it to build the bundle first) |
| 3 | `"build:ui": "esbuild src/browser/a2ui-entry.js --bundle --format=esm --target=es2022 --minify --legal-comments=linked --outfile=public/vendor/a2ui.js"`, and `"ui": "npm run build:ui && node src/ui-server.js"` |
| 4 | `"tutor:mock": "TUTOR_MODE=mock node src/tutor-agent.js"`, `"tutor:live": "TUTOR_MODE=live node src/tutor-agent.js"`, `"smoke:live": "node scripts/live-smoke.js"` |
| 5 | `"library": "node src/library-agent.js"`, `"library:live": "LIBRARY_MODE=live node src/library-agent.js"`, `"eval:live": "node scripts/live-eval.js"` |
| 7a | `"hub": "ROUTER_MODE=mock node src/hub-agent.js"`, `"hub:live": "ROUTER_MODE=live node src/hub-agent.js"`, `"hub:direct": "node src/hub-agent.js"`, `"demo": "npm run build:ui && node scripts/start-all.js"`, `"demo:live": "npm run build:ui && DEMO_MODE=live node scripts/start-all.js"` |
| 7b | `"ui": "npm run build:ui && STUDENT_MODE=mock node src/ui-server.js"`, `"ui:live": "npm run build:ui && STUDENT_MODE=live node src/ui-server.js"` |
| 9a | `"professor": "node src/professor-agent.js"`, `"professor:live": "PROFESSOR_MODE=live node src/professor-agent.js"` |

## Mode switches (read once, when the module loads)

| Variable | Values | Default | Step |
|---|---|---|---|
| `TUTOR_MODE` | `fixed`, `mock`, `live` | `fixed` | 4 |
| `LIBRARY_MODE` | `mock`, `live` | `mock` | 5 |
| `ROUTER_MODE` | `direct`, `mock`, `live` | `direct` | 5 |
| `TUTOR_SCOPE_ENFORCEMENT` | `on`, `off` | `on` | 5 |
| `STUDENT_MODE` | `off`, `mock`, `live` | `off` | 7b |
| `PROFESSOR_MODE` | `mock`, `live` | `mock` | 9a |
| `DEMO_MODE` | `live` or unset | unset | 7a (used by `scripts/start-all.js` to set every mode above to `live`) |

Because these are read when the module loads, set them in the environment **before** the process starts (or before `import`).

## The model

- Model ID: `claude-haiku-5-5`, called through `@anthropic-ai/sdk` 1.3.0.
- Price: $0.10 per million input tokens, $0.50 per million output tokens.
- Send `output_config: { effort: "low" }` and `max_tokens` up to 800. Haiku 5.5 counts thinking toward `max_tokens`.
- Never send `temperature`, `top_p` or `top_k`. They return HTTP 400 on API version 2026-10-21.
- Set `maxRetries: 0`, and use no fallback model and no canned answer when a call fails.
- Always check `stop_reason` (`refusal`, `max_tokens`) before using the content.

## A2A SDK 1.3.0 shapes (protocol v1.0)

Examples online are mostly for protocol v0.3 and use different shapes. Use these:

- A part, in JavaScript: `{ content: { $case: 'text' | 'data', value }, mediaType, filename, metadata }`. On the wire it is just `{"text": …}` or `{"data": …}`.
- Roles and states are enums: `Role.ROLE_USER`, `TaskState.TASK_STATE_INPUT_REQUIRED`, and so on.
- The Agent Card lists `supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant }]`. There is no top-level `url`.
- `sendMessage(request, { signal, serviceParameters })` returns a `Message` or a `Task`. `serviceParameters` become HTTP headers.
- For exact shapes, read `node_modules/@a2a-js/sdk/dist/**/*.d.ts`. The npm package has no samples.

## A2UI

- Use **v0.9**, not v0.9.1. `@a2ui/lit` 0.14.0 registers the v0_9 basic catalog.
- Every message has `"version": "v0.9"`. The extension URI is `https://a2ui.org/a2a-extension/a2ui/v0.9`.
- An A2UI part sets both `mediaType` and `metadata.mimeType` to `application/a2ui+json`.

## Done when

- `npm install` finished, and `package-lock.json` exists.
- `npm test` exits successfully (0 tests is fine at this point).
- `git log --oneline` shows `Step 0: project setup`.
