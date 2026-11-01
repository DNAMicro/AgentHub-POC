# Hiding or eliminating guardrail latency in LLM / agent systems

Research date: Friday, Oct 30, 2026. Every source was read on that date. Some pages give their own dates, and those are noted. Vendor and competitor numbers are labelled.

## 1. Parallel / speculative execution (guard runs at the same time as routing or the main LLM call)

### Takeaway
Every major framework offers a "run the guard at the same time" mode. A slow input check then costs about max(guard, agent) instead of guard + agent. Because agent replies here take several seconds and a Haiku judge takes 1-2 s, the judge's time can be hidden almost completely. The catch: the downstream agent has already received the content and spent tokens, and it may have done things (tool calls, side effects) before the verdict arrives. That breaks the owner's rule that "a blocked inbound message must not reach any agent," unless the parallel work stays inside the Hub (for example, routing) or is cancelled and thrown away before it has any effect.

### Cited Findings
- **OpenAI Agents SDK:** input guardrails default to `run_in_parallel=True`, and "The guardrail runs concurrently with the agent's execution." This is the lowest-latency option. The docs warn that on a trip, "the agent may have already consumed tokens and executed tools before being cancelled." — [OpenAI Agents SDK, Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- **OpenAI Agents SDK:** blocking mode (`run_in_parallel=False`) means "The guardrail runs and completes before the agent starts... If the guardrail tripwire is triggered, the agent never executes, preventing token consumption and tool execution." The docs call it "ideal for cost optimization and when you want to avoid potential side effects from tool calls." — [OpenAI Agents SDK, Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- **OpenAI Agents SDK:** when a guardrail fails, the runner raises a tripwire exception that "halts agent execution." Input guardrails apply only to the first agent in a chain. Output guardrails "always run after the agent completes, so they don't support the `run_in_parallel` parameter," and a tripwire "rejects the candidate final output." Tool guardrails run on every call of a tool and can skip the call, replace its output, or raise a tripwire. — [OpenAI Agents SDK, Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- **LiteLLM** has three modes. `pre_call` runs before the LLM call, on the input. `during_call` is "Same as `pre_call` but runs in parallel as LLM call," and the "Response not returned until guardrail check completes." `post_call` runs after the call, on input and output. A guardrail that fails returns HTTP 400 "Violated guardrail policy" (example: Aporia PII block). The page doesn't say whether the upstream LLM call is cancelled, or still billed, when a during_call guard fails. — [LiteLLM guardrails quick start](https://docs.litellm.ai/docs/proxy/guardrails/quick_start)
- **LiteLLM** also has a `logging_only` mode, which runs "without changing the client response or adding latency to it." That makes it observe-only, not enforcement. — [LiteLLM guardrails quick start](https://docs.litellm.ai/docs/proxy/guardrails/quick_start)
- **NeMo Guardrails, parallel rails:** "Set `rails.input.parallel` or `rails.output.parallel` when independent rails can run concurrently. A rail that blocks short-circuits the result." Also: "Parallel execution can reduce latency, but it does not remove the cost of the underlying model or service calls." — [NVIDIA NeMo Guardrails, Runtime security FAQ](https://docs.nvidia.com/nemo/guardrails/resources/runtime-security-faq)
- **NeMo, IORails speculative generation:** "prompt checking runs in parallel with LLM response generation. Because most prompts are safe, this can hide input-rail latency," and "the library discards the generated response if an input rail blocks the prompt." — [NVIDIA NeMo Guardrails, Runtime security FAQ](https://docs.nvidia.com/nemo/guardrails/resources/runtime-security-faq)
- **NeMo, no universal number:** NVIDIA says "There is no deployment-independent p50, p95, or throughput for a guardrails configuration." It advises you to "Benchmark the exact configuration on representative traffic." The same goes for precision and recall. — [NVIDIA NeMo Guardrails, Runtime security FAQ](https://docs.nvidia.com/nemo/guardrails/resources/runtime-security-faq)
- **NeMo, race condition warning:** a secondary source says NVIDIA's parallel-rails tutorial warns that input rails which change (mutate) the input "can lead to erroneous results" when run in parallel. Not verified against the primary page, which returned 404. — [beri.net comparison (2026)](https://www.beri.net/article/nemo-guardrails-vs-guardrails-ai-vs-lakera-runtime-prompt-injection-2026)
- **NeMo overhead, secondary sources:**
  - An NVIDIA benchmark in front of Llama 3.1 70B, as cited by beri.net: average response time went from 0.91 s with no rails, to 1.29 s with content safety, to 1.44 s with content safety + topic control + jailbreak detection. — [beri.net](https://www.beri.net/article/nemo-guardrails-vs-guardrails-ai-vs-lakera-runtime-prompt-injection-2026)
  - Spheron's 2026 guide on H100s: input rails added 20 ms p50 / 50 ms p99, and output rails 35 ms p50 / 80 ms p99. — [Spheron](https://www.spheron.network/blog/nemo-guardrails-production-deployment-llm-gpu-cloud/)
  - NeMo's benchmark tooling with a mock LLM: 1063 ms p50 for LLMRails vs 38 ms p50 for IORails. This measures only the guardrail layer. — [Realm Labs (2026-09-22, updated 2026-10-13; vendor)](https://www.realmlabs.ai/articles/runtime-guardrails-latency-benchmarks)
- **Guardrails AI:** "Generally, a guard runs in sub-10ms," and validators "should only add around 100ms of additional latency when configured correctly." The docs recommend `AsyncGuard` for concurrent calls and chunk processing. ML validators can take seconds when cold on a CPU, and run under 100 ms on GPUs. — [Guardrails AI Performance](https://guardrailsai.com/guardrails/docs/concepts/performance); [Guardrails AI FAQ](https://guardrailsai.com/docs/faq/)
- **Guardrails AI bug (PR #1667, Sep 24, 2026):** `AsyncStreamRunner` yielded `validationPassed=True` on every chunk, even after a chunk had failed. "a caller gating on res.validation_passed mid-stream never sees a failure." The search did not show whether the fix has been merged. — [guardrails-ai PR #1667](https://github.com/guardrails-ai/guardrails/pull/1667)

### Inferences
- The Hub can get "parallel" speed without breaking the no-reach rule. It starts the judge at the same moment as work that stays inside the Hub (the deterministic stage, router decision, card and readiness checks, building the A2A request). It sends to the specialist only after the judge passes. What it saves is the router time, not the agent time. If the Hub router is itself a Haiku call (`hub:live`), running judge and router side by side hides roughly one model call.
- The "full speculative" option is to send to the agent at once and cancel or discard if blocked, as IORails and the Agents SDK do. It hides almost all of the judge's time, but it breaks the owner's rule, because the specialist sees the text. It is also unsafe for agents with side effects: Library renewals, form issuance, Professor relays, ledger entries. A2A has no reliable "unsend," so this pattern does not fit the inbound direction here.
- LiteLLM's `during_call` shows the middle ground: run both, but don't release the response until the guard finishes. That is exactly "hold and release" for the outbound side (section 2).

### Gaps
- No primary source gave a measured parallel-vs-sequential latency comparison for NeMo (the parallel-rails page was 404).
- LiteLLM's docs don't say whether the upstream call is cancelled, or how it is billed, when a during_call guard fails.

## 2. Optimistic / async patterns (allow-then-revoke, hold-and-release, streaming chunk checks, post-hoc moderation)

### Takeaway
There are two families. Pre-send blocking (Discord AutoMod, Azure default streaming) guarantees bad content is never shown, but it adds latency. Asynchronous checking (Azure Asynchronous Filter, NeMo `stream_first: True`) adds no visible delay, but harmful content can be displayed before it is retracted. For inbound student messages, only pre-send blocking meets the owner's rule. Outbound replies (agent → student) can use hold-and-release because the agent's own reply time already dominates. Retraction (allow-then-revoke) is acceptable only for low-severity categories.

### Cited Findings
- **Azure OpenAI, default streaming:** "completion content is buffered and evaluated by the content guardrails system... it arrives in buffered content chunks rather than token by token." (Page dated 2026-09-08, updated 2026-10-15.) — [Azure OpenAI content streaming](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-streaming)
- **Azure OpenAI, measured gap in default mode:** "In tests with a custom blocklist... a blocklisted term in roughly the last 15 to 30 words of a streamed response was returned to the client with `finish_reason: "stop"`. The same response was blocked when `stream` was `false`." In other words, even the "safe" buffered mode lets the final segment through. — [Azure OpenAI content streaming](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-streaming)
- **Azure OpenAI, Asynchronous Filter:** "content filters run asynchronously and completion content is returned token by token without buffering... removes content-filtering latency from token delivery, but it delays filtering results." Microsoft describes it as "a trade-off against the safety and real-time vetting... some sections of harmful content that would otherwise have been filtered immediately could be displayed to the user." The signal "is guaranteed within a ~1,000-character window of the policy-violating content." The app must "stop displaying content and remove or replace content that was already displayed." Annotations carry `check_offset`, "Character position up to which content has been fully moderated (never decreases)." Both modes are GA. — [Azure OpenAI content streaming](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-streaming)
- **Azure, when to use which:** use Default "when content must be evaluated before your application displays it" or the app "can't handle delayed filtering signals or remove content after displaying it." — [Azure OpenAI content streaming](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-streaming)
- **Azure, billing:** you are billed for tokens generated before filtering in both modes. — [Azure OpenAI content streaming](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-streaming)
- **NeMo streaming output rails** use buffered chunks with `chunk_size` / `context_size` "to balance latency with the context available to each check." With `stream_first: True`, the client "can receive content before a rail blocks the stream." With `stream_first: False`, inspection "prevents blocked content from reaching the client at the cost of additional latency." — [NVIDIA NeMo Runtime security FAQ](https://docs.nvidia.com/nemo/guardrails/resources/runtime-security-faq)
- **Guardrails AI streaming:** validators by default wait for about a sentence of content, validate it, and emit the result in real time. `error_spans_in_output` lists the failed ranges so far. "Not all on_fail types are supported with streaming." — [Guardrails AI streaming docs](https://guardrailsai.com/guardrails/docs/concepts/streaming.md)
- **Discord AutoMod** filters server-side before posting. The `BLOCK_MESSAGE` action "prevents it from being posted" and can show the member a custom explanation. Bots can only delete after posting, by listening to the Auto Moderation Action Execution event. Discord reported over 20 million messages removed before posting in the first months after launch (about 2022). Limits: 6 custom keyword rules, each with up to 1,000 keywords and 10 regexes of up to 260 characters. — [Discord userdoccers, Auto Moderation](https://docs.discord.food/resources/auto-moderation); [Discord blog](https://discord.com/blog/new-anti-spam-raid-automod-safety-update); [valt.gg guide (2026)](https://valt.gg/blog/discord-automod-setup-guide/)
- **Discord AutoMod is keyword/regex/preset-list based**, a deterministic stage that can run before posting at low latency. A 2023 developer request for custom bot pre-send approval was not implemented. — [discord-api-docs Discussion #6009](https://github.com/discord/discord-api-docs/discussions/6009)
- **AWS Bedrock Guardrails best practice:** "configure your guardrails to evaluate only the most recent user input or a limited number of recent turns," to cut cost and latency by not checking the same content again. — [AWS ML blog, Bedrock Guardrails best practices](https://aws.amazon.com/blogs/machine-learning/build-safe-generative-ai-applications-like-a-pro-best-practices-with-amazon-bedrock-guardrails/)
- **Bedrock via LiteLLM:** for streaming, each sampled scan is a separate ApplyGuardrail call over all the text so far. That adds mid-stream latency and repeated charges. — [LiteLLM Bedrock guardrails](https://docs.litellm.ai/docs/proxy/guardrails/bedrock)

### Inferences
- In this project there is no token streaming (it is in the scope constraints), so agent replies arrive whole. Outbound hold-and-release then costs the judge's time after the reply arrives, unless the judge can start earlier. One way to hide it is to keep the "working…" indicator showing during the judge. The student already waits several seconds, so 1-2 s more is relative, not absolute (see section 6).
- Professor posts are asynchronous by nature: lessons go into an inbox. A hold of 1-2 s before delivery is invisible to the student, who doesn't know when the post was written. Checking those posts in the Hub costs nothing the student can perceive.
- Allow-then-revoke would require a "retract" message type to the Student inbox and chat. The project's honest-state rules ("delivered" only after commit) would make a retraction visible as a separate event. That fits only low-severity, post-hoc categories (for example, an offensive-word flag on an outbound reply), not inbound harmful intent.

### Gaps
- I found no primary documentation for how Slack or Microsoft Teams moderate in real time (block before send vs. remove after send). Searches returned nothing usable. A targeted look at Microsoft Purview Communication Compliance / Teams DLP "block message" docs is still needed.
- I found no measured "time-to-retract" data for chat platforms.

## 3. Verdict caching (exact hash and semantic)

### Takeaway
Exact-hash caching of verdicts is safe and cheap, as long as the cache key includes the full context the judge saw (policy version, direction, a hash of the relevant history). It helps mostly with repeats and retries. Semantic (embedding-similarity) caching of safety verdicts is risky. Recent research shows that high cosine similarity between texts does not mean they deserve the same verdict, and attackers can poison such caches.

### Cited Findings
- **"Similarity Is Not Validity" (arXiv 2609.35908, about Sept/Oct 2026):** an attacker can cache a malicious response under a query whose cosine similarity to benign requests is high. Benign and poisoned entries overlap on key-query cosine. An LLM judge as defense is the strongest baseline, but it costs 4.4 s per cache hit. Their feature classifier (DG, ADL, Echo) blocks 96.7%. — [arXiv 2609.35908](https://arxiv.org/html/2609.35908v1)
- **Mitigation advice:** include tenant and permission set in cache keys, order checks cheap-to-expensive (regex → classifier → model-based), and "cache only where safe." (Community post, lower authority.) — [DEV Community](https://dev.to/rhuturaj_takle/responsible-ai-and-ai-guardrails-3c0d)
- **Description of "cache splitting"** prompt injection to get past refusals via a semantic cache. (Blog, lower authority.) — [Medium / instatunnel](https://medium.com/@instatunnel/semantic-cache-poisoning-corrupting-the-fast-path-e14b7a6cbc1f)
- **NVIDIA lists caching** among features that "can change performance, but each has feature or security tradeoffs." — [NVIDIA NeMo Runtime security FAQ](https://docs.nvidia.com/nemo/guardrails/resources/runtime-security-faq)
- **OneUptime** recommends caching judge results as one way to control evaluation cost. (2026-08-31; this is for offline evaluation, not live guards.) — [OneUptime](https://oneuptime.com/blog/post/2026-08-31-control-llm-evaluation-cost/view)

### Inferences
- For a chat gateway, exact repeats are rare, except for retries. This project already dedupes retries by `(contextId, messageId)` and `operationId`. A verdict ledger keyed the same way gives the "cache" benefit for free and cannot collide.
- Harmful intent often depends on the conversation, not just the text ("how do I get into his account" after earlier turns). So a verdict for the text alone should not be reused across conversations. That argues for hashing text + direction + policy version + a digest of the recent turns the judge saw.
- A semantic "known-bad" index is safer used as a *trigger* (escalate to the judge when the text is close to known-bad) than as a *verdict* (pass because it is close to known-good). That links to section 4.

### Gaps
- I found no published hit-rate data for moderation verdict caches in chat systems.

## 4. Gating the expensive check (run the judge only when a cheap signal fires)

### Takeaway
Cascades cut cost and average latency a lot. But every measured example shows recall loss, and the cheap first stage becomes the attacker's target. For harmful intent, which keyword lists catch poorly, gating the judge on keywords is the weakest option. The safer form gates on "clearly safe" being confidently established, or runs the judge always but hidden in parallel (section 1).

### Cited Findings
- **guardrail-cascade (GitHub):** cheap heuristics handle the confident cases and send ambiguous ones to a paid model. Its own table says "The cascade is about 70% cheaper and misses five times as many." The author says there is no labelled precision eval yet. — [danielmaddaleno/guardrail-cascade](https://github.com/danielmaddaleno/guardrail-cascade)
- **arXiv 2608.28327:** a production two-stage cascade (a linear probe over model activations screens all traffic and escalates flagged exchanges) cut classifier compute by more than 40× for about 1% absolute overhead, at a 0.05% refusal rate over a month of shadow deployment. It also measures how often defense layers fail together (failure correlation). — [arXiv 2608.28327](https://arxiv.org/pdf/2608.28327)
- **securetom (about Oct 2026):** a cheap first-stage classifier can be attacked directly. Small irrelevant changes push inputs across its decision boundary, and judges can be swayed by optimized suffixes and prompt injection. — [securetom](https://securetom.com/blog/llm-guardrail-bypass-classifier-judge-testing)
- **TrueFoundry:** use a cheap classifier for checks that can be computed. Use a judge only when the rule "can be written as a sentence but not as code." For prompt injection, put a detector first and the judge as backstop, because judges catch novel phrasing. (Vendor blog.) — [TrueFoundry](https://www.truefoundry.com/blog/llm-as-a-judge)
- **OneUptime:** a four-stage cascade of deterministic checks → small judge → stronger judge for low-confidence or boundary cases → human review with cascade audits. — [OneUptime](https://oneuptime.com/blog/post/2026-08-31-control-llm-evaluation-cost/view)
- **Jev vs Claude Haiku 4.5 as input guardrails** (n=1,000, independent GitHub repo):
  - Overall detection: Jev 91.9%, Haiku 96.6%.
  - Detection on evasion prompts: Jev 78.2%, Haiku 94.0%.
  - False positives: Jev 9.6%, Haiku 14.1%.

  So a fast model first stage loses the most recall on evasive phrasing. — [rahulbansalc6414/jev-as-a-guardrail](https://github.com/rahulbansalc6414/jev-as-a-guardrail)

### Inferences
- Gating on deterministic signals is good for PII and offensive words, which are pattern-shaped. It is poor for harmful intent ("I want to make him pay for what he did"), which often uses no flagged words. The evasion recall gap above (78% vs 94%) shows the scale of loss when a cheaper stage substitutes for a stronger judge.
- A lower-risk variant is "fast-pass only on confident safe." Very short, routine messages ("thanks", "what are library hours?") that match the router's known capability examples, with no risk features, skip the judge. Everything else goes to the judge. This is still a recall trade-off and must be measured on a labelled set before use.

### Gaps
- I found no published, labelled measurement of recall loss specifically for "keyword-gated LLM judge" on harmful-intent detection. The 5× miss figure is from one unvalidated repo.

## 5. Measured latencies of fast guard options

### Takeaway
Hosted classifier-style guards are typically 50-500 ms, network included. Local deterministic checks take well under 1 ms. An LLM judge is around 2 s median (Haiku 4.5, measured). Claude Haiku 5.5 is a reasoning model, and its benchmark time-to-first-token is much higher than the owner's assumed 1-2 s. That figure must be measured with the project's actual short prompt at `effort: "low"` before planning around it.

### Cited Findings
- **OpenAI omni-moderation:**
  - A competitor benchmark (ZeroGPU, possibly biased), single request: p50 145 ms / p95 252 ms for 0-60 chars, and p50 150 ms / p95 244 ms for 60-120 chars. They say about a third of that is network. — [ZeroGPU benchmark](https://zerogpu.ai/benchmarks/moderation-edge)
  - One user's server-side `openai-processing-ms`: 82 ms for text, 1316 ms for an image. — [OpenAI community](https://community.openai.com/t/discrepancy-omni-moderation-latest-token-usage-vs-tier-1-rate-limits-vision/1371064)
  - The older 2024 thread reported up to 4 s, and 0.8-1.7 s for about 8K-token inputs. — [OpenAI community (2024)](https://community.openai.com/t/moderation-api-is-very-slow/944102)
  - I found no official OpenAI latency figure.
- **Lakera Guard:**
  - Docs: latency depends on content length and number of detectors, and is "<150ms for typical requests with persistent connections." — [Lakera docs, Evaluating guardrails](https://docs.lakera.ai/docs/evaluation-overview)
  - A secondary summary of the docs' p95 table: 50 ms for about 1,000 chars with 1 detector, 100 ms with 16 detectors, 300 ms for about 5,000 chars with 16, all before network. I could not see the table itself. — [beri.net](https://www.beri.net/article/nemo-guardrails-vs-guardrails-ai-vs-lakera-runtime-prompt-injection-2026)
- **AWS Bedrock Guardrails:** I found no official per-policy latency in milliseconds. AWS points to monitoring (CloudWatch / Elastic dashboards show average ApplyGuardrail response time). — [Elastic observability labs](https://www.elastic.co/observability-labs/blog/llm-observability-amazon-bedrock-guardrails)
  - Contextual grounding scans reject queries over about 1,000 characters (per LiteLLM). — [LiteLLM Bedrock](https://docs.litellm.ai/docs/proxy/guardrails/bedrock)
- **TypeSafe Jev:**
  - Vendor claim: 70-500 ms. — [DataCamp](https://www.datacamp.com/blog/system-one-models-jev)
  - WSO2 gateway benchmark (independent; one region, one machine), default settings: 447 ms p50 / 537 ms p90, caught 69.5% of unsafe prompts, wrongly blocked 9.7% of benign. — [randilt/jev-guardrail-benchmark](https://github.com/randilt/jev-guardrail-benchmark)
  - Customised with 2 extra questions: 455 / 507 ms, caught 81.1%, wrongly blocked 13.5%. — [randilt/jev-guardrail-benchmark](https://github.com/randilt/jev-guardrail-benchmark)
  - Jev vs Haiku 4.5 benchmark: median 328 ms vs 2,066 ms, and $0.03 vs $1.87 per 1K calls. — [rahulbansalc6414/jev-as-a-guardrail](https://github.com/rahulbansalc6414/jev-as-a-guardrail)
- **Small local classifiers (BERT-scale toxicity/PII):** about 10-100 ms, usually 10-50 ms per check. Local deterministic checks (SKI): about 0.10 ms p50 / 0.36 ms p99. Managed API network round-trip is typically 50-150 ms. (All quoted second-hand by a vendor article that warns they aren't comparable.) — [Realm Labs (2026-09-22)](https://www.realmlabs.ai/articles/runtime-guardrails-latency-benchmarks)
- **Guardrails AI:** sub-10 ms per guard, about 100 ms per validator. LLM-based validators take about 100-200 ms (per Realm Labs' reading of the docs). — [Guardrails AI Performance](https://guardrailsai.com/guardrails/docs/concepts/performance)
- **"LLM-as-judge adds 5 to 11 seconds per check":** an uncited claim in a vendor article, so treat it as weak. — [Realm Labs](https://www.realmlabs.ai/articles/runtime-guardrails-latency-benchmarks)
- **Claude Haiku 4.5 (non-reasoning):** time to first token 0.50 s on Anthropic's API, measured with 10,000 input tokens. (The page is about a year old.) — [Artificial Analysis, Claude 4.5 Haiku providers](https://artificialanalysis.ai/models/claude-4-5-haiku/providers)
- **Claude Haiku 5.5 (released Oct 7, 2026), always reasoning:**
  - Artificial Analysis lists time to first token at low effort as 7.89 s on its model page and 8.19 s in search snippets, against a price-tier median of about 1.7 s. Medium effort: 10.36 s. Output speed: 157.7 tokens/s at low effort. Input length and date are not stated on the page.
  - This conflicts with the owner's 1-2 s estimate. The difference is probably the benchmark's longer prompts and thinking time, compared with a short classification prompt, but that is not verified.
  - Sources: [Artificial Analysis, Haiku 5.5 (low)](https://artificialanalysis.ai/models/claude-haiku-5-5-low); [Artificial Analysis, Haiku 5.5 (xhigh)](https://artificialanalysis.ai/models/claude-haiku-5-5-xhigh)

### Inferences
- The judge's real latency in this project should be measured from the existing telemetry: `model_call_started` → `model_response_received` on the Tutor's live scope check, which already uses Haiku 5.5 at `effort: "low"` with an 800-token cap. That gives a project-specific p50/p95, instead of relying on 1-2 s or Artificial Analysis's 8 s.
- A pure Node local classifier (ONNX via transformers.js or onnxruntime-node) would fall in the 10-100 ms band cited above. I found no Node-specific benchmark.

### Gaps
- No primary Anthropic latency documentation was fetched (the call budget was used up). Anthropic's "reducing latency" docs should be checked for guidance on short structured outputs.
- No ONNX-in-Node classifier benchmark was found.
- No Bedrock per-policy latency was found.
- I could not view the primary Lakera p95 table.

## 6. Perceived-latency UX (thresholds, typing indicators, chat studies)

### Takeaway
Nielsen's limits are 0.1 s (feels instant), 1 s (flow kept, delay noticed) and 10 s (attention lost; show progress). Chatbot studies show that a few seconds of delay in a chat reply is not inherently harmful. Delays that vary with message complexity were rated more human-like. Experienced users, however, react negatively. Since agent replies here already take several seconds, an extra 1-2 s judge delay falls inside an already-noticed wait, as long as feedback (a typing or working indicator) is shown.

### Cited Findings
- **Nielsen's three limits:** "0.1 second is about the limit for having the user feel that the system is reacting instantaneously." "1.0 second is about the limit for the user's flow of thought to stay uninterrupted, even though the user will notice the delay." 10 s is the limit for keeping attention; anything slower needs a progress indicator and a way to interrupt. Feedback matters most when response time varies a lot. (Origin: Miller 1968; Nielsen 1993.) — [NN/g, Response Time Limits](https://www.nngroup.com/articles/response-times-3-important-limits/)
- **Gnewuch et al. 2018 (ECIS):** dynamic delays, scaled to the complexity of the message, made a customer-service chatbot seem more human and socially present, and raised satisfaction compared with near-instant replies. — [AIS eLibrary, ECIS 2018](https://aisel.aisnet.org/ecis2018_rp/113/)
- **Gnewuch et al. 2022 (BISE 64(6), N=202):** delays had opposing effects. For users with prior chatbot experience, delay *reduced* social presence. There was no difference between fixed and dynamic delays, and the authors warn artificial delays can backfire. — [AIS eLibrary, BISE](https://aisel.aisnet.org/bise/vol64/iss6/5/)
- **CSCW study (doi 10.1145/3555765):** an 8 s delay was seen as tolerable, and 2-4 s as robotic or unrealistically fast. With moderate delays (5-10 s), users were more willing to follow the bot's suggestions than with long (13-18 s) or short (0-1 s) ones. — [ACM DL 10.1145/3555765](https://dl.acm.org/doi/pdf/10.1145/3555765)
- **"Explaining the Wait" (ACM CUI 2024):** explaining a delay raised perceived transparency and trust when the bot answered instantly, but had no effect with dynamic delays. In pre-testing, 8 of 10 participants thought the dynamic delay was too long. — [ACM DL, Explaining the Wait](https://dl.acm.org/doi/fullHtml/10.1145/3640794.3665550)

### Inferences
- For inbound: the student already sees a working state while the Hub routes and the agent answers (several seconds). Adding the judge before forwarding extends that wait by its latency. Per Nielsen, a wait already past 1 s is noticed either way, and staying well under 10 s with visible progress keeps attention. The risk is the judge's tail latency (p95), not its median, and Haiku 5.5's reasoning time could push the total toward 10 s.
- For a blocked message, answering quickly matters more: the student should get the "not sent" notice. Deterministic blocks are instant. Judge blocks arrive after the judge's latency, which is still faster than an agent reply.
- An honest status line ("Checking your message…") is consistent with "Explaining the Wait." It does not fake progress, and it matches the project rule of reporting only real events.

### Gaps
- I found no study isolating typing indicators as a separate factor in chatbot latency perception. A targeted search is still needed.
- I found no chat-specific threshold study newer than 2024.
