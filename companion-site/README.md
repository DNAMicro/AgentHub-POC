# AgentHub-POC, step by step — companion site

A standalone teaching site that explains how this repository (AgentHub-POC) was built in Steps 1–9: what each step changed and why, and how it works, on one architecture diagram that evolves from step to step.

## Start it

```bash
cd companion-site && npm start
```

Open **http://localhost:4440**. The site binds to 127.0.0.1 only. If port 4440 is taken, it stops with a message rather than choosing another port. It needs no API key, no model calls, no login and no part of the application running: it is static files plus a 40-line Node server, with no dependencies.

```bash
npm run check   # structural checks: page budget, diagram continuity, walkthrough events, screenshots, sources, commits, no external assets
```

## What is in it

- **19 pages:** an introduction, then for each step **A** (what changed and why) and **B** (how to build it and how it works). The recap is in Step 9.
- **One architecture diagram** (`public/js/diagram.js`). Every component and connection has a fixed position, name and colour. Each step is an absolute snapshot (`ARCH` in `public/js/content.js`). The site computes what was added and removed and marks it with a tag, a border style and a colour: **+ NEW**, **~ CHANGED**, **✕ REMOVED**. Connections are labelled with what they carry. Line style shows the kind: A2A (solid), HTTP, SSE (dotted), HTTPS model call (dashed), file (dash-dot).
- **Comparison (page A):** *Previous step / This step / Animate the change*. Step 9 also offers *Step 1 → Step 9*.
- **Walkthrough (page B):** one concrete user action, hop by hop. It has Play, Pause, Replay, Prev and Next event controls and a caption per event. The numbered list beside it is the same walkthrough without motion. It is labelled **Simulated**: nothing is sent to any agent or model.
- **Screenshots:** real screenshots of the running app, taken on a separate test stack with fictional data. They show today's UI, and each caption says which step's idea it illustrates.
- **Keys:** ← → (PageUp / PageDown) change pages, Home / End jump, F starts presentation mode (full screen, no top navigation) and Esc leaves it. Swipe works on touch screens.
- **Theme:** the ◐ button in the header (or **T**) cycles **Auto → Light → Dark**. Auto follows the computer's setting. The choice is remembered in this browser (`localStorage`) and applied before the page draws, so it never flashes the wrong theme. If storage is blocked, it still works for the open page.
- **Reduced motion:** no animation; tokens jump to their destination and changes appear at once.

## Where the content comes from

`SOURCE-MAP.md` is the source map written before authoring. Its sources are `Steps/01–09`, the git history, the tests at each step's commits, `CLAUDE.md` and `README.md`. Every page has a "Sources" list. Each technology is credited to the commit that introduced it: for example, the Library's model arrived in `7bc2e21`, not in the first Part 5 commit.

Known limits of the reconstruction:
- **Steps 1–6 were written down later.** Their files were first committed with Step 6 (`c81e566`), so their "original prompt" wording was assembled after the fact.
- **Step 3's form no longer exists.** Step 6 removed it, so its example is taken from git (`d9a1e9b`).
- **Step 4's code has moved.** Its model call is shown from `src/llm.js`, where Step 5 moved it.
- **No recorded live results for Steps 1–5.** Only the tests document them.
- **Screenshots show today's UI.** The Step 2 monitor looked different at the time and was redesigned in Step 6.
- **`Steps/README.md` omits the last Part 9 commit (`36ba0a6`).** The site cites it.
