# Production AI guardrail platforms and AI gateways: how they choose which checks run, and in what order

Research date: 2026-10-30. Pages were fetched or searched on that date. Where a page shows a "last updated" date, it is given. Findings marked "(search summary)" come from a search-engine summary of the named official page, not from a full fetch. Treat those as slightly less certain.

## AWS Bedrock Guardrails: policies, evaluation order, ApplyGuardrail, mask vs block, latency and cost

### Takeaway
Bedrock runs **all configured policies in parallel** on the input. If the input is blocked, the model is never called. If it passes, the output is then checked against the same guardrail. There is no cascade and no routing inside one guardrail. Cost control comes from three things: turning policies on only where needed, turning each policy on per direction (input/output), and making the cheap deterministic policies (word filters, regex) free. Each finding comes back per policy with an action of BLOCKED, ANONYMIZED (masked) or NONE (detect only).

### Cited Findings
- Policy set: "A guardrail is a combination of multiple policies configured for prompts and response including; content filters, denied topics, sensitive information filters, word filters, and image content filters." Contextual grounding and Automated Reasoning are separately priced policies. — [AWS: How Guardrails works](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html); [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- **Parallel, not cascaded:** "for improved latency, the input is evaluated in parallel for each configured policy." — [AWS: How Guardrails works](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)
- **Pipeline order:** "If the input evaluation results in a guardrail intervention, a configured *blocked message* response is returned and the foundation model inference is discarded. If the input evaluation succeeds, the model response is then subsequently evaluated… If the response results in a guardrail intervention… it will be overridden with *pre-configured blocked messaging* or *masking* of the sensitive information based on your policy configuration." — [AWS: How Guardrails works](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)
- Cost follows the pipeline: if input is blocked, "There are no charges for foundation model inference calls"; "Charges… are incurred only for the policies configured in the guardrail." — [AWS: How Guardrails works](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)
- **Standalone API:** "You can use the `ApplyGuardrail` API to assess any text using your pre-configured Amazon Bedrock Guardrails, without invoking the foundation models." `source` is `INPUT` (user content) or `OUTPUT` (model response). Example given: in RAG, "evaluate the user input before performing the retrieval." — [AWS: Use the ApplyGuardrail API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)
- **Result shape:** top-level `action: "GUARDRAIL_INTERVENED" | "NONE"`; `outputs` holds the masked text (if only masked), a single canned message (if blocked), or is empty (no action); `assessments` has one block per policy (topicPolicy, contentPolicy with type/confidence/filterStrength, wordPolicy, sensitiveInformationPolicy with piiEntities and regexes each `BLOCKED | ANONYMIZED`, contextualGroundingPolicy with score vs threshold); `invocationMetrics.guardrailProcessingLatency`; `usage` billed units per policy; `guardrailCoverage` (characters guarded vs total). — [AWS: Use the ApplyGuardrail API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)
- Masking example: "Hi, my name is {NAME}…" (PII entity replaced by its type label). — [AWS: Use the ApplyGuardrail API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)
- By default only detected items are returned; `outputScope: FULL` also returns non-detected entries "for enhanced debugging" (not for word filters or regex). — [AWS: Use the ApplyGuardrail API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)
- **Per-direction, per-filter actions (search summary):** content, word and PII filters take `inputAction`/`outputAction` (`BLOCK | NONE`, plus `ANONYMIZE` for PII) and `inputEnabled`/`outputEnabled`. NONE "takes no action but returns detection information in the trace" (console label "Detect (no action)"). A disabled direction is not charged and does not appear in the response. — [AWS API: GuardrailContentFilter](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GuardrailContentFilter.html); [AWS: sensitive information filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html); [AWS: word filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-word-filters.html)
- **Pricing (official, fetched 2026-10-30):** content filters (text) $0.15 / 1,000 text units; denied topics $0.15; sensitive information filters $0.10; **sensitive information regex: Free; word filters: Free**; contextual grounding $0.10; Automated Reasoning $0.17 per 1,000 text units *per policy*. "A text unit can contain up to 1000 characters." Contextual grounding counts source + query + response characters. — [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- A separate **InvokeGuardrailChecks API** price table: content filters (text) $0.07, prompt attack $0.08, sensitive information $0.10 per 1,000 text units; with it "you can use the prompt attack filter separately outside of content filters," "available only with this API." — [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- Latency: AWS gives no published per-policy latency; the API returns measured `guardrailProcessingLatency`. A third-party estimate is ~100–300 ms per evaluation (unverified). — [AWS: ApplyGuardrail](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html); third-party: [techjacksolutions](https://techjacksolutions.com/ai-tools/aws/what-is-bedrock-guardrails/)
- Streaming via LiteLLM: each sampled scan is a separate ApplyGuardrail call over all text so far, adding mid-stream latency and repeated text-unit charges (search summary). — [LiteLLM: Bedrock guardrail](https://docs.litellm.ai/docs/proxy/guardrails/bedrock.md)

### Inferences
- Bedrock's "efficiency" comes from parallelism (wall-clock time ≈ slowest policy) and from per-direction enablement, **not** from skipping checks based on what the text looks like. Cost still scales with every enabled policy.
- Making regex/word filters free is a signal that AWS treats deterministic checks as the cheap first layer worth running everywhere.
- The "detect only" (NONE) action is the standard way to trial a new check on live traffic without user impact.

### Gaps
- I did not find an AWS-published latency figure per policy, nor confirmation of how Automated Reasoning or contextual grounding fit timing-wise (they need a reference source, so they mostly apply to outputs).
- The InvokeGuardrailChecks API reference page itself was not fetched; only its pricing table.

## Cloudflare AI Gateway guardrails and Firewall for AI (now "AI Security for Apps")

### Takeaway
Cloudflare's WAF product runs its detectors **in parallel, non-blocking, from a Worker**, with a **hard 2-second cap** per analysis; on timeout it falls back to whatever detections finished. Detector results become WAF fields; customers write normal WAF rules (log/block) on them. The prompt text is not stored; only results are logged. As of the Aug 2025 post, only prompts (not responses) were scanned by the WAF product. AI Gateway guardrails (a separate product) check prompts and responses with flag or block.

### Cited Findings
- AI Gateway Guardrails: "prompts can be flagged or blocked before reaching the model"; for responses, "If hazardous content is detected, it can be flagged or blocked before being delivered to the user." "flagged content is logged for review, while blocked content is prevented from proceeding." Users "Specify which categories to monitor" (e.g. violence, hate, sexual content). The page does not name the model, latency, streaming or PII. — [Cloudflare AI Gateway: Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/)
- Firewall for AI architecture (blog, 2025-08-26, last modified 2026-07-15): "we built a new asynchronous architecture"; "a Cloudflare Worker makes parallel, non-blocking requests to our different detection modules — one for PII, one for unsafe topics, and others as we add them"; "latency does not increase as we add new detections. It will only be bounded by the slowest model used." — [Cloudflare blog: Block unsafe prompts with Firewall for AI](https://blog.cloudflare.com/block-unsafe-llm-prompts-with-firewall-for-ai/)
- Timeout / fail behaviour: "We also enforce a hard 2-second threshold for each analysis… if this time limit is reached, we fall back to any detections already completed." — same source
- Model: "we chose Llama Guard 3… it answers whether the text is safe or unsafe, and provides a specific category… we cover the 13 default categories. We deploy it on Workers AI… the number of model instances… scales automatically with the load." — same source
- Results → rules: example rules `any(cf.llm.prompt.unsafe_topic_categories[*] in {"S10" "S12"})` → Log; `cf.llm.prompt.unsafe_topic_detected` → Block. "The request body itself (the prompt text) is not stored or exposed; only the results of the analysis are logged." — same source
- Responses not yet scanned: "A major part of our roadmap is adding model response handling." — same source
- Product renamed "AI Security for Apps (formerly Firewall for AI)"; PII detection covers phone numbers, emails, SSNs and credit card numbers; custom topics supported; only `application/json` requests; Enterprise add-on (search summary). — [Cloudflare WAF: AI Security for Apps](https://developers.cloudflare.com/waf/detections/ai-security-for-apps/)
- PII module was Presidio deployed on Workers AI (search summary citing earlier blog); a related post says "Presidio is highly specialized and reliable for detecting PII, while Promptguard2 excels at identifying malicious prompts like jailbreaks." — [Cloudflare blog: Beyond the ban](https://blog.cloudflare.com/ai-prompt-protection/)

### Inferences
- Workers relevance: the orchestration is a Worker doing fan-out `fetch`es to detector services with a timeout. That pattern (Promise-based fan-out with a deadline and partial results) maps directly to a Node.js gateway (`Promise.allSettled` + `AbortSignal.timeout`).
- Cloudflare's timeout behaviour is effectively **fail-open on slow detectors** (use partial results), with the block decision left to the customer's rules.
- "Detect then decide by rule" separates detection (always on, parallel) from policy (cheap rule evaluation).

### Gaps
- The AI Gateway Guardrails page did not name its model or describe streaming handling; I did not confirm whether AI Gateway uses Llama Guard (it is widely reported, but not on the fetched page).
- No millisecond latency figures from Cloudflare beyond the 2 s cap.

## NVIDIA NeMo Guardrails: rail types, Colang flows, parallel execution, streaming, integrations

### Takeaway
NeMo has five rail stages in a fixed pipeline order (input → dialog → retrieval/execution → output). Within a stage, rails run **sequentially by default**; `parallel: True` runs input or output rails concurrently. The docs warn against parallel when a rail mutates text (e.g. masking), because later rails must see the masked text. Output rails can be applied to streamed chunks with tunable chunk size, overlap and "stream first" behaviour.

### Cited Findings
- Five rail types (README): input "can reject the input, stopping any additional processing, or alter the input"; dialog rails "determine if an action should be executed, if the LLM should be invoked…"; retrieval rails are "applied to the retrieved chunks" in RAG; execution rails are "applied to input/output of the custom actions (a.k.a. tools)"; output "can reject the output… or alter it". Latest release "0.24.1" (page snapshot updated Aug 18, 2026). — [NeMo Guardrails README](https://github.com/NVIDIA/NeMo-Guardrails)
- Built-ins listed: LLM self-checking (input/output moderation, fact-checking, hallucination), "NVIDIA safety models (content safety, topic safety)", "jailbreak and injection detection", integrations with ActiveFence, PolicyAI, AlignScore and LangChain. — [NeMo Guardrails README](https://github.com/NVIDIA/NeMo-Guardrails)
- Parallel (search summary of config reference): `rails.input.parallel` and `rails.output.parallel`, boolean, **default false**. Use for "I/O-bound rails such as external API calls"; "Avoid parallel execution for CPU-bound rails"; "Input rail mutations can lead to erroneous results during parallel execution because of race conditions"; "do not run the masking rail in parallel with those dependent rails, because they must evaluate its transformed output"; parallel "does not remove the cost of the underlying model or service calls." — [NeMo: Configuration reference](https://docs.nvidia.com/nemo/guardrails/configure-guardrails/configuration-reference); [NeMo: Guardrails configuration](https://nvidia.github.io/NeMo-Guardrails/review/pr-1304/user-guides/configuration-guide/guardrails-configuration.html)
- Streaming output rails (search summary): `rails.output.streaming.enabled` (default false), `chunk_size` (default 200 tokens), `context_size` (overlap for consistent decisions across chunk boundaries), `stream_first` (default true: tokens go out before rails run; false: rails check each chunk before it is sent). Max-safety suggestion: chunk_size 300, context_size 75, stream_first False; low-latency example: 50 / 20. Requires `stream_async()`. — [NeMo: Output rail streaming](https://docs.nvidia.com/nemo/guardrails/latest/configure-rails/yaml-schema/streaming/output-rail-streaming.html); [NVIDIA blog: Stream smarter and safer](https://developer.nvidia.com/blog/stream-smarter-and-safer-learn-how-nvidia-nemo-guardrails-enhance-llm-output-streaming/)
- Official parallel+streaming example: output flows `content_safety_check`, `pii_detection`, `hallucination_check` with `parallel: True` and streaming chunk 200 / context 50 / stream_first True (search summary). — [NeMo: Configuration reference](https://docs.nvidia.com/nemo/guardrails/configure-guardrails/configuration-reference)
- "IORails speculative generation": prompt checking runs in parallel with LLM response generation (search summary). — [NeMo: Runtime security FAQ](https://docs.nvidia.com/nemo/guardrails/resources/runtime-security-faq)

### Inferences
- NeMo's default is a **sequential, ordered list** per stage, i.e. the author controls order and can put cheap checks first; a rail that blocks stops processing ("stopping any additional processing").
- The masking caveat is a general rule: mutating checks (redaction) must run before, not alongside, checks that should see redacted text.
- Dialog rails (Colang flows) are effectively **routing**: they decide what happens next based on the canonical intent of the message, rather than running every check.

### Gaps
- I could not fetch the Guardrails Library page this session (two docs URLs 404'd), so the specific integrations requested — **Presidio/GLiNER PII, Llama Guard, and the perplexity-based jailbreak heuristics** — are **not verified here**. They are commonly documented NeMo integrations; a writer should verify before citing.
- No published latency figures for NeMo rails were found.

## Microsoft (Azure AI Content Safety, Prompt Shields, Foundry guardrails, Purview)

### Takeaway
Microsoft Foundry models guardrails as **controls = risk + intervention points + action**. There are four intervention points (user input, tool call, tool response, output); models get two, agents get all four (tool points in Preview). Actions are "annotate" (flag) or "annotate and block". Prompt Shields scan user input and, for agents, documents in tool responses. Underneath is Azure AI Content Safety classification.

### Cited Findings
- Structure (search summary of Microsoft Learn, updated ~mid-Oct 2026): "Guardrails consist of a set of controls. The controls define a risk to be detected, intervention points to scan for the risk, and the response action to take in the model or agent when the risk is detected." Guardrails is "a configuration and enforcement layer that uses Azure AI Content Safety classification models (plus some additional controls)". — [Microsoft Learn: Guardrails and controls overview in Foundry](https://learn.microsoft.com/en-us/azure/foundry/guardrails/guardrails-overview)
- Intervention points: user input, tool call (Preview), tool response (Preview), output. Tool points "require moderation support from the tool itself." Blocking at tool call means "the tool call won't be executed, and the agent stops functioning until there is another user input." "Annotate" is supported for models but not agents; "Annotate and block" for both (search summary). — [Microsoft Learn: Intervention points](https://learn.microsoft.com/en-us/azure/foundry/guardrails/intervention-points); [Overview](https://learn.microsoft.com/en-us/azure/foundry/guardrails/guardrails-overview)
- Prompt Shields: user prompt attack detection enabled by default; user prompt attacks apply only to user input; document attacks are scanned at user input for model calls and at tool response for agents (Preview); REST uses `"action": "annotate"` or `"block"` (search summary). — [Microsoft Learn: Prompt Shields](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/jailbreak-detection)
- Third-party table: content filters (input and output) block/annotate; groundedness, protected material, PII (output) block/annotate; custom blocklists block only. — [Atmosera blog](https://www.atmosera.com/blog/azure-ai-foundry-guardrails)

### Inferences
- Microsoft's design is **routing by intervention point**: each check is declared only at the points where its risk can appear (e.g. prompt-attack on input/tool response; groundedness on output), rather than running everything everywhere.

### Gaps
- Not researched in depth this session: Content Safety latency figures, severity thresholds per category, and the **Purview** integration (DSPM for AI / audit). These should be treated as open.

## Google Cloud Model Armor

### Takeaway
Model Armor exposes two endpoints, `sanitizeUserPrompt` and `sanitizeModelResponse`, each bound to a **template** (which filters, which confidence levels). Org-level **floor settings** set a minimum that every template must meet, and also apply to Gemini and Google MCP server traffic. Results come back as per-filter match states and confidence levels.

### Cited Findings
- Endpoints: `POST /v1/{name=projects/*/locations/*/templates/*}:sanitizeUserPrompt` and `:sanitizeModelResponse`; regional endpoints; the global endpoint only for floor settings (search summary). — [Model Armor REST reference](https://docs.cloud.google.com/model-armor/reference/rest)
- Results: `sanitizationResult` with `filterMatchState` and `filterResults`, e.g. `piAndJailbreakFilterResult` with `matchState` and `confidenceLevel` (search summary, Promptfoo guide). — [Promptfoo: Testing Model Armor](https://www.promptfoo.dev/docs/guides/google-cloud-model-armor/)
- Floor settings "define the minimum security and safety requirements for all Model Armor templates" in a resource-hierarchy scope, covering RAI categories, prompt injection/jailbreak, and sensitive data protection; also enforceable on Gemini Enterprise Agent Platform and "Google and Google Cloud MCP servers" traffic (search summary). — [Model Armor: Configure logging](https://docs.cloud.google.com/model-armor/configure-logging)
- Logging is opt-in via `log_sanitize_operations`; in console, floor-setting logging is on by default for Agent Platform, off by default for MCP servers (search summary). — [Model Armor: Configure logging](https://docs.cloud.google.com/model-armor/configure-logging)
- Gateway integration: Apigee `SanitizeUserPrompt` and `SanitizeModelResponse` policies placed in the proxy flow. — [Apigee: SanitizeUserPrompt policy](https://cloud.google.com/apigee/docs/api-platform/reference/policies/sanitize-user-prompt-policy?hl=es); [Google Cloud blog](https://cloud.google.com/blog/products/identity-security/how-model-armor-can-help-protect-your-ai-apps)

### Inferences
- Templates per use case + org floor = a two-level policy model (local choices, central minimum). Logging content is opt-in, consistent with "don't store sensitive text by default".

### Gaps
- No Model Armor latency figures or internal evaluation order (parallel vs sequential) found. Pricing not checked.

## Lakera Guard

### Takeaway
One API call (`/v2/guard`) per interaction or agent step; a **policy** (per app/feature/environment) chooses which detectors run. Lakera parallelises and chunks internally to stay under a latency cap; documented p95 ~50 ms for ~1,000 characters with only the prompt-attack detector.

### Cited Findings
- Latency depends on content length and which detectors the policy runs; "smart chunking and parallelization" keep requests under a latency cap; evaluation guide treats <150 ms typical as success; v2 p95 ≈ 50 ms for ~1,000 chars with only the prompt attack detector (search summary). — [Lakera: Guard API](https://docs.lakera.ai/docs/api/guard); [Lakera: Evaluating AI guardrails](https://docs.lakera.ai/docs/evaluation-overview)
- Policies per app/feature/environment/customer; detectors and strictness changeable live; "Changing a policy can affect the latency"; a separate results endpoint returns confidence levels for tuning but is not for runtime decisions; detectors only flag in Enforce mode (search summary). — [Lakera: Policies](https://docs.lakera.ai/docs/policies)
- Agent coverage: tool calls, tool responses and tool descriptions; "Dangerous Deviation" detector and a runtime Tool Allow/Deny List (search summary). — [Lakera: Introduction to AI agent security](https://docs.lakera.ai/guard)
- Portkey integration blocks on policy hits and redacts PII when only `pii/*` detectors fire; default 30,000 ms timeout (search summary). — [Portkey: Lakera](https://portkey.ai/docs/aigw/integrations/guardrails/lakera)

### Inferences
- Check selection is by **policy per surface**, not per message content: a lighter policy on a high-volume surface is the latency lever.

### Gaps
- Lakera was reported (third-party) as acquired by Check Point; not verified from a primary source.

## Protect AI LLM Guard

### Takeaway
LLM Guard is a library of input scanners and output scanners run **sequentially in list order**; each scanner can sanitize text and passes it on to the next. `fail_fast=True` stops at the first failing scanner. Results are per-scanner valid/score maps.

### Cited Findings
- 15 input scanners (Anonymize, BanCode, BanCompetitors, BanSubstrings, BanTopics, Code, Gibberish, InvisibleText, Language, PromptInjection, Regex, Secrets, Sentiment, TokenLimit, Toxicity) and 20 output scanners (incl. Deanonymize, JSON, MaliciousURLs, NoRefusal, FactualConsistency, Relevance, Sensitive). — [LLM Guard docs](https://protectai.github.io/llm-guard/)
- Code (`llm_guard/evaluate.py`): `scan_prompt(scanners, prompt, fail_fast=False)` loops `for scanner in scanners: sanitized_prompt, is_valid, risk_score = scanner.scan(sanitized_prompt)` … `if fail_fast and not is_valid: break`. Empty scanner list or blank text returns immediately. `scan_output` does the same, passing the original prompt each time and chaining the output. Returns `(sanitized_text, results_valid, results_score)` keyed by scanner class name; scores 0 (no risk) to 1. — [LLM Guard evaluate.py](https://raw.githubusercontent.com/protectai/llm-guard/main/llm_guard/evaluate.py)

### Inferences
- With `fail_fast`, **order is a cost lever**: put cheap scanners (TokenLimit, BanSubstrings, Regex, InvisibleText) before model scanners (PromptInjection, Toxicity). The skipped scanners are absent from results, so an audit log shows which checks never ran.
- Anonymize (input) / Deanonymize (output) is a round-trip pattern: mask PII before the model, restore it after.

### Gaps
- The Vault mechanism and the Optimization tutorial (ONNX, CPU tips) were not fetched; no latency figures gathered.

## Guardrails AI

### Takeaway
A `Guard` holds validators; each validator has an `on_fail` policy (REASK, FIX, FILTER, REFRAIN, NOOP, EXCEPTION, FIX_REASK, or a custom function). Validators can target input (`on="messages"`) or output. `AsyncGuard` runs validators concurrently; with EXCEPTION, the first failure stops the process.

### Cited Findings
- on_fail actions: REASK (ask LLM again, `num_reasks`), FIX (replace with fix_value), FILTER, REFRAIN (return nothing), NOOP (return as is, log failure), EXCEPTION, FIX_REASK; failures logged in `guard.history.last.failed_validations` (search summary). — [Guardrails AI: validator on-fail actions](https://www.guardrailsai.com/guardrails/docs/concepts/validator_on_fail_actions)
- `on="messages"` runs a validator on the input instead of output; example `Guard().use(CompetitorCheck(..., on_fail=OnFailAction.EXCEPTION), ToxicLanguage(threshold=0.5, validation_method="sentence", ...))`. — [Guardrails AI GitHub](https://github.com/guardrails-ai/guardrails)
- Concurrency: with synchronous validation "validators for each property run in the order they are defined"; under concurrency, "if any validator with on_fail=OnFailAction.EXCEPTION returns a FailResult, Guardrails raises a ValidationError and stops the process"; for FILTER/REFRAIN "whichever of these finishes first is returned early"; plain Guard logs "Falling back to synchronous validation." (search summary). — [Guardrails AI: Concurrency](https://guardrailsai.com/docs/concepts/concurrency/)

### Inferences
- `on_fail` per validator is a richer action set than block/mask/flag: it includes self-repair (REASK/FIX), which is only appropriate where a model is producing the text.

### Gaps
- Third-party claims that validators always run in parallel in 0.5.x+ conflict with the official "falls back to synchronous" note; not resolved.

## AI gateways: LiteLLM, Portkey, Kong

### Takeaway
Gateways attach guardrails by **hook point** (pre-call, during-call, post-call) and by **scope** (on for every request, or attached per key/route/request). They offer sync (can block/mutate) vs async (log only) modes, and parallel vs sequential check lists. Streaming output is the weak spot: post-call checks on streams are often audit-only.

### Cited Findings
- **LiteLLM** (search summary): `mode` is `pre_call`, `post_call`, `during_call` or `logging_only`; `default_on` defaults to False (otherwise attached per key or per request, `"guardrails": ["name"]`). `pre_call` can mask; `during_call` "runs in parallel with the LLM call to save latency" and can only block; `post_call` can mask, but "for streaming responses, post_call runs on the full response only after every chunk has reached the client, so it is audit-only." Modes can be tag-scoped (e.g. by User-Agent). — [LiteLLM: Guardrails quick start](https://docs.litellm.ai/docs/proxy/guardrails/quick_start); [LiteLLM: Custom guardrail](https://docs.litellm.ai/docs/proxy/guardrails/custom_guardrail); [LiteLLM: LLM-as-a-Judge](https://docs.litellm.ai/docs/proxy/guardrails/llm_as_a_judge)
- **Portkey** (now branded "Prisma AIRS AI Gateway") (search summary): `before_request_hooks` (input) and `after_request_hooks` (output); hook fields `checks`, `deny`, `async`, `sequential`, `on_success`, `on_fail`; "When sequential is TRUE, checks run one after another instead of in parallel" (so parallel is the default). `async: true` = verdict does not change handling (logging); `async: false` can block/route. Sync responses include `hook_results` with `verdict`, `deny`, `execution_time`. Mutator hooks with async are skipped. Failure actions: log only, soft-deny (200), hard-deny (446). — [Portkey: Guardrails](https://portkey.ai/docs/product/guardrails); [Portkey: Raw guardrails JSON](https://portkey.ai/docs/product/guardrails/creating-raw-guardrails-in-json)
- **Kong** (search summary): AI Prompt Guard = regex allow/deny lists; AI Semantic Prompt Guard (Gateway 3.8+) = embedding similarity to example allow/deny prompts (embeddings model + Redis vector DB + threshold); AI Semantic Response Guard (3.12+) for outputs, returns a plain 400 when it blocks. AI Lakera Guard policy inspects each streamed segment before passing it to the client. — [Kong: AI Semantic Prompt Guard](https://developer.konghq.com/plugins/ai-semantic-prompt-guard/); [Kong: AI Semantic Response Guard](https://developer.konghq.com/plugins/ai-semantic-response-guard); [Kong: AI Lakera Guard policy](https://developer.konghq.com/ai-gateway/policies/ai-lakera-guard/)

### Inferences
- The "during_call" pattern (check in parallel with the model, discard model output if the check fails) trades wasted model cost for lower latency.
- Semantic (embedding) guards are a middle tier between regex and an LLM judge: one embedding call plus a vector lookup.

### Gaps
- No gateway-published latency numbers for their guardrail hooks were found.

## Recurring patterns across platforms

### Takeaway
No major platform runs a learned "router" that picks checks per message. Instead, checks are selected **statically by configuration**: per direction (input/output), per intervention point (input, tool call, tool response, output), per surface/policy/key, and sometimes per tag. Within that set, execution is either parallel (Bedrock, Cloudflare, Portkey default, Lakera internally) or ordered with fail-fast (LLM Guard, NeMo default, Portkey `sequential`). Cheap deterministic checks are priced/positioned as the first layer.

### Cited Findings
- Parallel fan-out bounded by the slowest detector: Bedrock ("evaluated in parallel for each configured policy"), Cloudflare ("latency… only… bounded by the slowest model used"). — [AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html); [Cloudflare blog](https://blog.cloudflare.com/block-unsafe-llm-prompts-with-firewall-for-ai/)
- Ordered with short-circuit: LLM Guard `fail_fast`; NeMo input rail "stopping any additional processing"; Guardrails AI EXCEPTION stops the process. — [LLM Guard](https://raw.githubusercontent.com/protectai/llm-guard/main/llm_guard/evaluate.py); [NeMo README](https://github.com/NVIDIA/NeMo-Guardrails); [Guardrails AI concurrency](https://guardrailsai.com/docs/concepts/concurrency/)
- Cheap first: agentgateway runs "regex check first, then model-based checks, then a custom webhook," regex "under 1ms per check" (search summary); Bedrock word and regex filters are free. — [agentgateway: About guardrails](https://agentgateway.dev/docs/standalone/latest/documentation/llm/prompt-guards/overview/); [AWS pricing](https://aws.amazon.com/bedrock/pricing/)
- Mutating checks must precede dependent checks (NeMo masking warning). — [NeMo configuration reference](https://docs.nvidia.com/nemo/guardrails/configure-guardrails/configuration-reference)
- Detect-only / annotate modes for trialing: Bedrock NONE, Microsoft annotate, Portkey async, LiteLLM logging_only, Lakera non-Enforce. — sources above
- Timeouts and fail behaviour: Cloudflare 2 s cap then uses completed detections (fail-open on slow detectors); Portkey/Lakera default 30 s timeout. — [Cloudflare blog](https://blog.cloudflare.com/block-unsafe-llm-prompts-with-firewall-for-ai/); [Portkey: Lakera](https://portkey.ai/docs/aigw/integrations/guardrails/lakera)
- Streaming outputs: NeMo chunked rails with overlap and `stream_first`; Kong/Lakera per-segment inspection; LiteLLM post_call on streams is audit-only. — sources above
- Audit without content: Cloudflare logs only analysis results, "The request body itself (the prompt text) is not stored"; Model Armor content logging is opt-in; Bedrock returns only detected items by default and gives `guardrailCoverage` counts. — sources above

### Inferences
- The "cascade by cost" (regex → small classifier → LLM judge) is an explicit order only in agentgateway and in user-configured ordered lists (LLM Guard, NeMo). Commercial APIs mostly run enabled policies in parallel and rely on *configuration scoping* to avoid unnecessary checks.
- For a Node.js hub, a reasonable synthesis is: deterministic checks always (sync, ~free), then a parallel fan-out of only the model checks configured for that direction/hop, with a deadline and an explicit fail-open/closed choice per check, and logs that record check names, verdicts, scores and timings but not the text.

### Gaps
- No primary source found that publishes a measured end-to-end comparison of cascade vs parallel for guardrails.
- Fail-open vs fail-closed defaults are not documented explicitly by most vendors (beyond Cloudflare's partial-results behaviour).

## Guardrails for agent-to-agent (A2A / MCP) traffic

### Takeaway
MCP guardrails exist in several gateways (agentgateway ExtMCP, Bifrost, Model Armor floor settings on Google MCP servers, Foundry tool call/tool response points, Lakera tool-call screening). **First-class A2A payload guardrails are still missing** in agentgateway as of an open issue (~Sep 2026); the workaround is identity/authorization at the edge plus content checks in the agent or its LLM routes.

### Cited Findings
- agentgateway (Linux Foundation, donated by Solo.io, Rust): one control point for MCP servers, A2A agents and LLM providers, with auth, Cedar policies and OpenTelemetry; guardrails = regex, OpenAI moderation, Bedrock Guardrails, Model Armor, custom webhooks. Regex actions mask/reject/audit (default mask); webhook reject/audit (default reject) (search summary). — [agentgateway GitHub](https://github.com/agentgateway/agentgateway); [agentgateway: About guardrails](https://agentgateway.dev/docs/standalone/latest/documentation/llm/prompt-guards/overview/); [0.6 release (A2A, MCP)](https://agentgateway.dev/blog/2025-07-14-a2a-mcp-gateway-api-0-6-release/)
- MCP guardrails inspect tool calls and responses in flight (`backend.mcp.guardrails`, ExtMCP). Issue #3610: "no first-class hook to inspect or mutate A2A message payloads at the gateway"; promptGuard and the webhook API are built around LLM `/request` and `/response`, not A2A JSON-RPC; workaround is JWT + ext_authz at the edge (search summary). — [agentgateway issue #3610](https://github.com/agentgateway/agentgateway/issues/3610)
- Microsoft Foundry tool call / tool response intervention points (Preview), which "require moderation support from the tool itself." — [Microsoft Learn: Intervention points](https://learn.microsoft.com/en-us/azure/foundry/guardrails/intervention-points)
- Model Armor floor settings apply to "Google and Google Cloud MCP servers" traffic. — [Model Armor: Configure logging](https://docs.cloud.google.com/model-armor/configure-logging)
- Bifrost (Maxim): MCP guardrails reuse the same providers as LLM guardrails (e.g. Lakera) without separate setup (search summary). — [Maxim: What are MCP guardrails](https://www.getmaxim.ai/articles/what-are-mcp-guardrails-how-tool-level-policy-enforcement-works/)

### Inferences
- The University Hub (which already terminates and re-originates every A2A hop and signs callers) is in the position agentgateway lacks: it can apply content checks per hop type (student→hub, hub→specialist reply, professor→student post) because it parses the A2A parts itself.
- Treating each A2A hop like a Foundry "intervention point" with its own declared check list is the closest production analogue.

### Gaps
- No vendor documentation found for content guardrails specifically on A2A JSON-RPC payloads; Lakera search results had nothing on A2A.
