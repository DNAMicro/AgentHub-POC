# Steps

How this project was built, one step per file. Each file contains the instructions for that step: the original wording, with every later enhancement merged in, plus a closing **Enhancements merged into this step** section that says what changed and why.

Run the steps in order to rebuild the app as it is now; each one builds on the previous step's working code and tests.

Each step also has an **Avoid these known problems** section: every bug, wrong assumption and trap we hit while building that step, written as instructions so a rebuild doesn't repeat them.

| Step | File | What it adds | Final commit(s) |
| --- | --- | --- | --- |
| 1 | [01-a2a-connectivity.md](01-a2a-connectivity.md) | Student Agent ↔ Tutor Agent over the real A2A protocol (two processes, Agent Card discovery, deterministic reply) | `79c6ef4`, `bd61b67` |
| 2 | [02-browser-monitor.md](02-browser-monitor.md) | Browser UI that shows the real A2A exchange via a separate visualization event stream | `dad775b` |
| 3 | [03-a2ui-form.md](03-a2ui-form.md) | A2UI v0.9 student-details form sent by the Tutor, rendered in the browser, submitted back over A2A | `d9a1e9b`, `3f31bb5` |
| 4 | [04-haiku-tutor.md](04-haiku-tutor.md) | Tutor answers with Claude Haiku 5.5 (fixed / mock / live modes), conversation history, New conversation | `e996a6a`, `5cc671d` |
| 5 | [05-routing-skills-scope.md](05-routing-skills-scope.md) | Library Agent, Haiku routing over a trusted registry, editable skills with answer content, card-change notifications over A2A, scope enforcement | `020018c`, `7bc2e21`, `5cc671d` |
| 6 | [06-conversational-workflow-forms.md](06-conversational-workflow-forms.md) | No form buttons: the receiving agent sends an A2UI form when asked in chat — in-person tutoring requests (Tutor Agent) and group study-room bookings (Library Agent). Forms are chat items that become your “You sent” summary; an advisory model review checks every field before anything is recorded; the switchboard UI design | “Add Part 6” commit, `99f4f38` |
| 7 | [07-university-hub-topology.md](07-university-hub-topology.md) | The University Hub (“California State University Fullerton”): the Student talks only to the Hub, which keeps a private registry (registration, heartbeats, readiness), routes to server-owned destinations, forwards and relays over A2A, maps forms by opaque references and dedupes operations. The Student's own model clarifies unclear questions and picks a public capability when the destination isn't obvious. Every agent sets its own model. Three browser tabs, each with its own address (`/conversation`, `/activity`, `/topology`), including a live animated topology with one model box per agent, driven only by real, labelled events | `cfb7040`, `ecb79af`, `520b83a`, `283c4fb`, `81afc79`, `39d242c`, `5508964` |
| 8 | [08-model-generated-ui-loans.md](08-model-generated-ui-loans.md) | The Library's model answers, asks, or composes an interface itself from the installed A2UI v0.9 basic catalog for your own (synthetic) book loans and renewals; deterministic validation, bounded repair, a backend loan service that owns every fact and renews idempotently, Hub-verified borrower, and a Generated UI inspector | `48b2fa6`, `7347f41` |
| 9 | [09-marketing-101-professor-lessons.md](09-marketing-101-professor-lessons.md) | One Marketing 101 Professor agent behind the Hub, working both ways: students ask it questions, and the professor posts lessons that travel Professor → Hub → Student as a new signed A2A interaction into the Student agent's persisted inbox (queued, delivered, opened; reconciled when an acknowledgment is lost). A Professor view tab, an inbox with toast and lesson view, follow-ups routed by the trusted lesson record, signed Student → Hub requests, and a structure-only inspector by default | `6d84aec`, `cad2e9d` |

Rules that apply to every step (from your instructions):

- **Ready means live.** When something is handed over as ready, it runs in live mode; mock and fixed modes are for automated tests only.
- **No budget step for live use.** Live use and verification just run; calls, usage and cost are reported afterwards. The scripted paid checks (`smoke:live`, `eval:live`) keep a max-spend environment variable.
- **The API key stays server-side.** It is read from a git-ignored `.env`, never printed, logged or sent to the browser.
- **Everything stays on localhost** (`127.0.0.1`). Most state is in memory (restarting a server clears its saved skills, history and form records); the exceptions are JSON files under the git-ignored `data/`: Part 8's loan store and Part 9's Hub lesson records, Professor outbox and Student inbox.
