# Step 12 — University Hub guardrails (design)

*Friday, Oct 30, 2026. Design for approval. Built from the brainstorm with the owner and two research
reports: `reports/AI gateway guardrail mechanisms.md` and `reports/IDS speed methods for guardrails.md`.
Calls I made that the owner did not explicitly decide are marked **(my call)**.*

## 1. Intent

The University Hub is the single front door every message passes through. Step 12 makes it a
**checkpoint for what is being said**, not only who is asking and where it may go. A message with
personal data (an SSN, a card number), offensive language or harmful intent is **stopped at the Hub
before it reaches any agent**, and the student is **told plainly what the issue was** so they can fix
it. The same checkpoint screens what flows **back**: agent replies and professor posts.

Why it matters (owner's words, paraphrased): get ahead of a problem before it reaches anyone behind the
Hub. Sending a message to the guardrail's AI is acceptable; letting it reach a person at the school —
on their screen and in their chat record — is not.

## 2. Goals, non-goals, anti-goals

**Goals**
- Block personal data, offensive language and harmful intent in **both directions**:
  student → agent, agent reply → student, professor post → student.
- **Low false positives** (the owner's Presidio experience: too many false alarms). Every block must
  rest on evidence.
- **No noticeable delay** for a clean student message.
- An **interface** where the university creates and manages the rules and the AI judge's policy.
- Every guardrail action **visible in Topology** (and the hop-by-hop strip) when it happens.

**Non-goals (this step)**
- Masking/redacting and forwarding (we block; masking is a later option).
- Checking form submissions (form fields are meant to hold names/emails; form data never goes to a model).
- A meaning-based (embedding) trigger — deferred to a later phase (§11).
- The TypeSafe Jev judge — the judge is pluggable so Jev can be tried later (§11).
- University **policies** (e.g. "no online class on Fridays", loan limits). They are not guardrails:
  a student asking about a policy deserves an answer, not a block. Today each service enforces its own
  in code (`src/loan-store.js` renewals, `src/forms.js` tutoring/room hours, Hub `recipient_not_enrolled`)
  and explains it from its knowledge. Distributing policies to the agents that own them is **Step 13** (§11).

**Anti-goals (it fails even if it "works" if…)**
- It blocks innocent questions often ("how do I kill a Python process?").
- A blocked message reaches any agent, or any log/screen shows the blocked content.
- A check silently passes a message when it fails or times out.
- It adds seconds to every clean message.

## 3. What the research settled (the basis for the design)

- **Don't run every check on every message; make each detector earn its finding.** A cheap **trigger**
  decides whether a rule runs at all; a rule must find **proof** (Luhn checksum for cards, valid SSN
  number ranges, known test numbers ignored) and **context** (e.g. "SSN" within ~40 characters) before
  it reaches high confidence. (Microsoft Purview, Google DLP, AWS Macie, Snort/Suricata, GitHub secret
  scanning.)
- **Checks are chosen per hop by configuration**, not per message by a router (AWS, Microsoft, Google).
- **For context and intent, a general model judging against a written policy beats small guard models**
  (independent studies: Llama Guard missed most harmful prompts; Granite over-blocked 25.7%).
- **The judge can't be made fast — hide it.** IDS lesson: do the costly work rarely or out of the way;
  inline AI products hold, cap the wait, and decide at the cap. Measured on this app today, live Haiku 5.5
  calls take ~1.5–2.7 s; the Hub's router call takes ~2.7 s. Running the judge **at the same time as the
  router** makes the wait max(judge, router), not the sum.
- **HyDE, turned around:** have the AI write example violating messages and safe look-alikes **in
  advance** — used here to build the **test set** (§7.3).
- **The "Validation layer" (deck "Interfaces built at runtime", 27 Oct 2026, slides 14–19)** is the same
  idea already worked out for form inputs: plain-words rule → search existing validators → model writes a
  Zod function + tests → static check and sandbox tests (≤3 retries) → publish versioned (`work-hours@1`),
  callable by id (`POST /v1/validate/work-hours@1` → `{ valid, reason }`); every later check is plain code,
  no model call on the hot path; one workerd isolate per validator, loaded at runtime by the Worker Loader,
  network blocked; ~2–4 ms added by the sandbox (the deck's rough estimate, not a benchmark). What Step 12
  takes from it, and where it deliberately differs:

  | Validation layer | Step 12 guardrails |
  |---|---|
  | Search existing validators (pgvector) | Search existing rules first, by the authoring model over the short list (§5) — no database (project rule) |
  | Validator = Zod schema over **fields** → `{ valid, reason }` | Guardrail rule = detector over **free text** → findings (positions, never values). Field validators are Step 13 (§11) |
  | ≤3 automatic retries | ≤2 repair rounds, then a person sees the failures (my call; cheaper, and a person approves anyway) |
  | A new rule can be generated **when a form needs it**, before it is shown | **Never while a student waits**; a person approves every version before it runs |
  | One isolate per validator via Worker Loader | Same (§5) |
  | Callable by anyone through the API | Step 12: only the Hub calls `/scan`. Step 13: agents call checks by id (§11) |
  | gVisor around workerd as a second wall | Deferred (owner's decision); workerd only |
  | nginx + Docker Swarm + Postgres + pg-boss | Not needed for a local demo: one workerd process, `data/guardrails.json` |

## 4. How a message flows (the pipeline)

Three checkpoints, all in the Hub (`src/guardrail.js`, called from `src/hub-agent.js` / `src/hub-lessons.js`):

| Hop | Where in the Hub | Stage 1: Rules (deterministic) | Stage 2: Judge (AI) | On block |
|---|---|---|---|---|
| **Inbound** student chat | after signature/session checks, **before routing** | always first | **in parallel with the router**; forward only after "allow" | not forwarded; the student is told why |
| **Reply** from Tutor/Library/Professor | when the specialist's answer returns, **before relaying** | always | after rules (the reply is held) | reply withheld; the student is told a reply was held back and why |
| **Professor post** | before a post becomes deliveries | always | after rules (held) | post refused to the professor with the reason; nothing delivered |

**Inbound order:**
1. **Rules** run first and alone (microseconds). A **high-confidence** finding blocks immediately — the
   text never reaches any model (router or judge).
2. Otherwise the **judge and the router start together**. Low-confidence rule findings go to the judge as
   hints (e.g. "a number shaped like an SSN, no keyword nearby").
3. The message is forwarded to the chosen agent **only after the judge says allow**.

**Modes, per rule and per judge category:** `off` · `shadow` (log "would have blocked", deliver anyway)
· `enforce`. Rules the university creates start in `shadow`; the two **seed rules and the starting judge
categories ship in `enforce`**, so the demo blocks on first run **(my call)**.

**Time caps and failures (explicit, always logged):** rules cap 50 ms; judge cap = a configurable value
(start 8 s inbound/reply, 30 s professor posts) **(my call)**. On a cap or error the hop **fails closed**:
nothing forwarded, the student (or professor) is told honestly "we couldn't check your message, nothing
was sent — please try again" **(my call, matches the project's no-hidden-fallback rule)**. If the rule
engine is down, the Hub fails closed and Topology shows the engine offline.

**Verdict cache:** exact match only — key = hop + policy version + SHA-256 of the text + digest of the
recent turns the judge saw. Never reuse a "safe" verdict for a merely similar message.

**What the student sees:** their sent bubble, then a university reply in fixed, code-owned words, e.g.
"Your message wasn't sent because it contains a Social Security number. Please remove it and send it
again." The words come from the rule/category (editable in the interface), never from the model, and
never echo the matched value. A blocked message is **not** stored in Hub history, not sent to the agent,
and not used as conversation context later.

**Which inbound messages are checked (my call):** every free-text chat message gets rules + judge,
including paths that skip the router (the Student agent chose the service, a follow-up to a lesson or
professor message, `ROUTER_MODE=mock|direct`). On those paths there is no router call to overlap, so the
judge's time is visible — accepted for safety. Structured picks with no free text (a meeting-slot button,
a reply chip with no typed text) skip the judge; rules still run on any text.

**The student's own data on the way back (my call):** the Hub-verified conversation owner's own name and
email in a reply (a form confirmation, their own loan list, a professor's message to them) are allowed.
SSNs and card numbers are blocked in every direction, whoever they belong to. The judge policy says
"personal data about someone other than the student".

**A block also clears the Student side (my call):** when the Hub blocks a message, the UI server drops
any pending clarification that holds it (`pending.original`) and never re-sends it as context, so blocked
text can't come back inside the next message.

**Known limit (stated, not solved):** the Student agent's own model (on the student's side, Part 7) sees
the text before the Hub does. The guardrail protects the university side.

## 5. Stage 1 — Rules (AI-written validators, sandboxed)

**What a rule is:** a small JavaScript module, written in advance by an AI from a person's description,
using **Zod** (already pinned) and **validator.js** (new, pinned exactly) where they help. Each rule
exports:
- `triggers` — cheap literal/regex hints (e.g. a digit run, "ssn", "social security"); the engine runs
  the rule only if a trigger matches (the IDS "fast pattern").
- `detect(text)` → findings `[{ kind, start, end, confidence: 'high' | 'low' }]` — positions only, **never
  the matched value**.

**Lifecycle (nothing generated while a student waits):**
1. A person describes the rule in the interface (plus optional example messages).
1b. **Search before writing** (from the "Interfaces built at runtime" deck, 27 Oct 2026): the existing
   rules (descriptions + kinds) are shown as possible matches first; reuse or new version beats a
   near-duplicate. Step 12 matches with the authoring model over the short rule list (no vector store);
   embedding search is a later option (§11).
2. The AI writes the module **and** test cases (positives + near-miss look-alikes).
3. The draft is run **in the sandbox** against its tests and the frozen test set; results shown.
4. A person reviews the code (read-only view) and approves → it becomes a **version**, pinned by content
   hash, starting in `shadow`.
5. Editing = a new version; the old one stays available to roll back to.

**Static gate before any run:** reject drafts that use `fetch`, `import` of anything but the allowed
libraries, `eval`, `Function`, timers, or regexes that fail the ReDoS-safety check (the project already
does this for A2UI).

**Where rules run — the rule engine:** a separate local process, **workerd**, on `127.0.0.1:41245`
**(my call for the port)**, with no network and no filesystem bindings, called by the Hub over local
HTTP (`POST /scan { hop, text } → { findings, ruleTimings }`). Rule code can't be `eval`ed inside a
Worker, so it is loaded with workerd's **Worker Loader** binding (Dynamic Worker Loading; works in local
workerd, per Cloudflare's docs and its author — idea taken from the "Interfaces built at runtime" deck):
- **each rule version runs in its own isolate**, loaded on demand by id `name@version` + content hash
  (`env.LOADER.get(id, …)`), with `globalOutbound: null` (no network) and no bindings;
- **activation** = the Hub tells the engine the new active set; no restart, no redeploy;
- **draft testing** loads the draft as a one-off isolate (`LOADER.load`) in the same engine, under a
  separate `/test` route, never in the active set.
- **Builder checks first:** the exact workerd config syntax and whether it needs `--experimental`. If the
  Worker Loader doesn't work in the pinned workerd, fall back to the earlier plan: regenerate the config
  with the active rules and swap engines (start new → health check → switch → stop old), and test drafts in
  a short-lived second instance.

**Sandbox: workerd only (owner's decision, 2026-10-30: "lets not include the gvisor for now").**
workerd runs directly, with no bindings, so a rule can't reach the network, files or the Hub. workerd's
own README says it isn't hardened against its own implementation bugs for truly untrusted code; that's
acceptable here because every rule is reviewed and approved before it runs. gVisor (workerd inside a
Docker container with the `runsc` runtime) is a later hardening option (§11).

**Seed rules (shipped, fictional test data only):** US SSN (structure rules; **high** only with an SSN
keyword nearby, otherwise **low** → judge hint) and payment card (Luhn + issuer prefix/length, known test
numbers excluded → **high**). Both go through the same generate → test → approve flow and are committed
as approved versions.

## 6. Stage 2 — The judge (AI)

- **One structured Haiku 5.5 call** per checked message (the Hub's existing `callModel` path, no retries,
  sanitized errors) returning **all categories at once**:
  `{ verdict: 'allow' | 'block', categories: [ids], confidence: 'high' | 'low' }`.
- Input: the message, the **recent conversation** (briefReply, like other prompts), the hop, the rule
  hints, and the **policy** — one entry per category, written in plain words in the interface.
- Starting categories: **offensive language**, **harmful intent** (hurting someone, breaking into
  accounts/systems, cheating), **personal data the rules can't catch** (e.g. a home address with name).
- The message is content, not instructions (the prompt says so, like the Professor's).
- **Anthropic has no separate guardrail model or moderation endpoint** (checked 2026-10-30). Its
  guidance ("Mitigate jailbreaks": *harmlessness screens*) is exactly this design: a lightweight Claude
  model (Haiku 5.5) pre-screens input with structured output. Its safety classifiers can **decline the
  screening request itself** — treat `stop_reason: "refusal"` as a **block** verdict (category
  `harmful_intent`, recorded as `by: 'model_refusal'`), not as an error that fails closed with the
  "couldn't check" wording. `max_tokens` stays an error (fail closed).
- **Pluggable:** `judge(input) → verdict` is one function, so Jev (or another model) can be tried side by
  side later.
- Mock mode (tests): a labelled heuristic — proves plumbing, not judgment.
- **Authoring model (my call):** Haiku 5.5 also writes rule code, rule tests and test-set examples
  (it's the model already validated in `src/models.js`); a draft that fails its tests gets at most 2
  automatic repair rounds, then the person sees the failures. A stronger model can be added later via
  `src/models.js` (with its check and price) and a separate `guardrail.author.model` setting.

## 7. The interface — a new **Guardrails** tab (`/guardrails`)

A fifth tab in the same app (like the Professor view), for the university. All writes go UI server →
Hub `/dev/guardrails/*`, origin-guarded like the other `/dev` routes.

### 7.1 Rules
- List: name, kind, mode (off/shadow/enforce), active version, and counters — **triggered / confirmed /
  blocked** (IDS hit counters; a trigger that rarely confirms is a bad trigger).
- **New rule:** describe it in words (+ optional examples) → **Generate** → shows the generated code
  (read-only), the generated tests, and the **sandbox test run** (pass/fail per case) → a "try a message"
  box → **Approve** (starts in shadow) or **Discard**.
- Per rule: change mode, edit the student-facing message, view versions, roll back, disable.

### 7.2 Judge policy
- Categories with their policy text, which hops they apply to, mode, and the student-facing message.
- **Try a message:** runs the judge as a preview (nothing sent anywhere) and shows the verdict and time.
- Judge settings: time caps per hop.

### 7.3 Test set
- The frozen examples every rule version and the judge are measured against: violating messages and
  safe look-alikes, per category and hop. Fictional data only.
- **Generate examples** (HyDE-style): the AI drafts positives and look-alikes for a category; a person
  accepts or rejects each before it joins the set.
- **Run all:** per rule/category — caught, missed, false alarms.

### 7.4 Activity
- Recent decisions: time, hop, rule/category, action (allowed / blocked / shadow-would-block / timeout),
  latency. **Never the message text.**

## 8. Topology and the hop-by-hop strip

- **The guardrail lives inside the Hub circle (owner's request, 2026-10-31):** no separate Guardrail
  node. The Hub disc carries a shield badge above its name (slightly larger than the agents' badges),
  and two new boxes hang off the Hub — **Rule engine** ("workerd") and **Guardrail model** (its own
  model box, like each agent's). Discs show the name only: sub-lines such as "Marketing 101 / +
  assistant", "Front door and router / router: live", "Tutoring", "You / student-alex" are removed
  as redundant (owner's request), as are "a person / Professor view" on Professor Amir's box.
- **Professor Amir as a person (owner's request, 2026-10-30):** a person node (rounded square with a
  head-and-shoulders mark, berry) beside the Professor agent, joined by a dotted "Professor view" lane.
  It animates only on what the human really does: a hand-over arriving (`needsProfessor` entry → "1
  waiting"), the professor's own reply or direct post leaving (author `professor`), and a refused post
  coming back ("Not sent"). Assistant answers animate Professor ↔ Professor's model instead, and the person
  node dims. Labels distinguish "written by Professor Amir" from "assistant". The same mockup previews
  Step 13: a small shield badge inside each agent disc, above its name (outline = rules installed;
  filled with a dashed orbit that turns, like production's busy orbit, = a rule is running; red with
  a blink = refused; green = passed/loaded; dashed amber = no rules yet), a Library and a Tutor rule
  refusing an action with the reason, and an agent signing in that receives its policies first. Mockup:
  `docs/superpowers/specs/2026-10-30-step-12-topology-mockup.html`.
- **Animated hops (real events only):** Hub → Rule engine (scan), Hub → Guardrail model (judge); the
  verdict shows on the Hub's shield, which fills and turns its dashed orbit while checking (like
  production's busy orbit), then turns **green pass** or **red block**, with the Hub's status pill saying
  "Guardrail checking / pass / blocked" (the flow stops at the Hub and the
  return hop to the student is labelled "blocked"), **amber** for shadow "would block", grey for timeout.
  Reply and professor-post checks animate the same way on their hops.
- **Hop-by-hop strip:** a new step **Guardrail checked** between "Hub received" and "Agent identified",
  with notes like "blocked — Social Security number", "allowed · 1.6 s", "shadow: would block — offensive
  language". A blocked message marks the later steps **skipped — blocked by the guardrail**. A reply check
  shows on "Hub got the reply".
- **Agent activity:** the Hub console logs each decision (names, verdicts, timings — no text).

**Telemetry events (Hub, through the existing `redactTelemetry` allowlist — never text, never values):**
`guardrail_check_started {hop}`, `guardrail_rules_result {hop, findings:[{ruleId, kind, confidence}],
latencyMs, engine}`, `guardrail_judge_started {hop}`, `guardrail_judge_result {hop, verdict, categories,
latencyMs, model, usage}`, `guardrail_decision {hop, action, reasons}`, `guardrail_engine_status
{status}`, plus `guardrail_rule_activated` / `guardrail_policy_saved` (config events, no run).

## 9. Data and configuration

- Persisted in `data/guardrails.json` (`GUARDRAIL_FILE`): rules and versions (code, tests, hash,
  mode, student message), judge policy, test set, counters. Tests always use a temp file.
- Hub config: `guardrail: { enabled, engineUrl, judge: { model, caps } }`; env
  `GUARDRAIL_MODE=off|mock|live` (read at import, like the other modes).
- `npm run demo` / `demo:live` start the rule engine as a sixth process.

## 10. Testing and measuring

- **`npm test`:** rules engine (triggers, findings, no values leaked), each seed rule against the frozen
  set, static gate rejects bad drafts, inbound block never reaches a specialist (assert via the
  specialist's own `message_received` absence), judge-and-router run in parallel (timing), fail-closed on
  engine down and on judge timeout, shadow mode delivers but logs, reply withheld, professor post
  refused, telemetry carries no text, verdict cache.
- **Live judgment** (paid, budget-gated like `eval:live`): `npm run eval:guardrail` runs the test set
  through the live judge — caught / missed / false alarms per category, and latency (median, p95).
- **Browser e2e on the owner's app:** an SSN message blocked instantly with the right words; an offensive
  message blocked by the judge; "how do I kill a Python process" allowed; a held reply; a refused
  professor post; Topology and the strip show each; create a rule end to end in the Guardrails tab.

## 11. Later (not this step)

- **Step 13 — distributed policies (owner's decision, 2026-10-30: "make it step 13 after guardrails").**
  Built on Step 12's rule engine, AI authoring, sandbox testing and approval flow. Owner's requirements:
  1. **Automatic placement:** once a policy is defined, the system works out which agent(s) it belongs to
     (proposal: the AI proposes "applies to" by matching against the skills on the registered agents'
     cards; a person confirms; policies attach to **skills and their workflow actions/fields**, never to
     agent names, so they follow a skill that moves).
  2. **Onboarding:** a new agent must first check and fetch the policies that apply to it before it gets
     work (proposal: registration → card fetched → Hub sends the matching policies → agent loads them and
     acknowledges their hashes → only then `ready`; the same push on a new approval or a skill change).
  3. **From the "Interfaces built at runtime" deck:** a form field can **name its validator**
     (`work-hours@1`) inside the A2UI message, so generated forms (Part 8) and fixed forms get the same
     approved, versioned checks: inline in the browser while typing, and re-checked by the agent before it
     saves (matches the project's "validation in three places" rule). Policies become callable checks by
     id, e.g. `POST /validate/<id>@<version>`.
     This also eases the known limit below: if an agent **calls** the shared check service by id
     (rather than only holding a copy), every call is logged, so the Hub can see whether the agent checked
     before it acted (onboarding then hands the agent the list of check ids that apply to its skills).
  Known limit to design for: the Hub can verify an agent *loaded* a policy (hash), not that it *applies*
  it — safety stays at the Hub; agent policies rely on the agent plus audit events. Brainstorm Step 13
  separately once Step 12 ships.

- Meaning-based trigger (local embeddings, HyDE-style generated reference examples) for harmful intent
  and for skipping the judge on low-risk outbound messages — only ever to **raise** scrutiny on inbound.
- Jev as a faster judge, tried side by side with Haiku on the test set.
- Masking instead of blocking; checking form submissions.
- gVisor around the rule engine (workerd in a Docker container with `runsc`; Docker on this Mac has only
  `runc` today).

## 12. Project rule changes this step needs

- CLAUDE.md scope: allow **model-generated validator code**, only for Step 12 rules, only after tests
  pass and a person approves, only run in the sandboxed rule engine.
- Add `validator` (pinned exactly) and `workerd` (pinned to a release at least two weeks old).

## 13. Left to the builder

File layout inside `src/guardrail*`, the exact prompt wording, the engine swap mechanics, the UI layout
details within the Guardrails tab (matching the app's existing design), and the exact Topology positions.
