# Guard models and safety classifiers for screening LLM/agent inputs and outputs

Research date: 2026-10-30. Wherever a source gives a date, it is shown. Every number comes from the cited page, as read in this session. Vendor numbers are self-reported unless marked "independent".

## 1. Open guard models: Llama Guard 3/4, Prompt Guard 2, ShieldGemma, Granite Guardian, NemoGuard/Aegis, WildGuard (plus newer entrants)

### Takeaway
The open guard models split into two groups:
- **Content-harm classifiers.** These are 2B–12B LLMs that return a safe/unsafe verdict plus categories: Llama Guard 4, ShieldGemma, Granite Guardian, WildGuard and NemoGuard.
- **Tiny injection/jailbreak classifiers.** Llama Prompt Guard 2 (22M/86M) is the main example.

Vendor model cards report strong numbers. Independent 2025–2026 studies paint a mixed picture:
- Llama Guard is very permissive. It misses most harmful content but almost never over-blocks.
- Granite Guardian 3.2 over-blocks.
- WildGuard and Qwen3Guard are the best balanced.
- None of these models is designed for PII, except Granite Guardian through custom criteria and Llama Guard's broad "Privacy" category.

### Cited Findings

**Llama Guard 4 (12B)**
- Llama Guard 4 is a 12B dense model, pruned from Llama 4 Scout's MoE (only the shared expert was kept). It "can be run on a single GPU." — [HF model card](https://huggingface.co/meta-llama/Llama-Guard-4-12B)
- **Taxonomy:** MLCommons hazards S1–S13 plus S14 Code Interpreter Abuse:
  - S1 Violent Crimes, S2 Non-Violent Crimes, S3 Sex-Related Crimes, S4 Child Sexual Exploitation
  - S5 Defamation, S6 Specialized Advice, S7 Privacy, S8 Intellectual Property
  - S9 Indiscriminate Weapons, S10 Hate, S11 Suicide & Self-Harm, S12 Sexual Content, S13 Elections

  — [HF model card](https://huggingface.co/meta-llama/Llama-Guard-4-12B)
- **Output:** "safe"/"unsafe" plus the violated category codes. It classifies both prompts and responses, and is natively multimodal with multi-image support. — [HF model card](https://huggingface.co/meta-llama/Llama-Guard-4-12B)
- **Meta's in-house output-filtering numbers (English):** recall 69%, false positive rate 11%, F1 61%. Versus Llama Guard 3-8B that is +4% recall, −3% FPR, +8% F1. Multilingual: recall 43%, FPR 3%, F1 51%. The card has no competitor comparison. — [HF model card](https://huggingface.co/meta-llama/Llama-Guard-4-12B)
- **License:** Llama 4 Community License (effective April 5, 2025). Access is gated, "Built with Llama" attribution is required, and companies with more than 700M monthly active users need a separate license. — [HF model card](https://huggingface.co/meta-llama/Llama-Guard-4-12B)
- The card warns that Llama Guard 4 itself may be vulnerable to prompt injection, and points to Prompt Guard 2 for that job. — [HF model card](https://huggingface.co/meta-llama/Llama-Guard-4-12B)

**Llama Prompt Guard 2 (22M / 86M)**
- **What it detects:** jailbreaks and prompt injection, with one binary label (benign/malicious). "Malicious" means the text "explicitly attempts to override prior instructions," whether or not it is otherwise harmful. The separate "injection" label from v1 was dropped as "too broad to be useful." — [HF model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- **Architecture:** the 86M model is mDeBERTa (multilingual). The 22M model is DeBERTa-xsmall, which is weaker on non-English text. Both have a 512-token window; longer text must be split into segments. — [HF model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- **Meta's private jailbreak benchmark:**

  | Model | AUC (English) | Recall at 1% FPR | Latency (A100, 512 tokens) |
  |---|---|---|---|
  | Prompt Guard 2 86M | 0.998 | 97.5% | 92.4 ms |
  | Prompt Guard 2 22M | 0.995 | 88.7% | 19.3 ms |
  | Prompt Guard 1 | 0.987 | 21.2% | — |

  — [HF model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- **AgentDojo, attack prevention at 3% utility cost:** PG2 86M 81.2%, PG2 22M 78.4%, PG1 67.6%, ProtectAI 22.2%, Deepset 13.5%. — [HF model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- **License:** Llama 4 Community License. Meta says adaptive attacks and application-specific attacks reduce accuracy, and recommends fine-tuning on your own data. — [HF model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)

**ShieldGemma (2B / 9B / 27B, Gemma 2-based)**
- **Policies:** four harm types (sexually explicit, dangerous content, hate, harassment), written in two styles: prompt-only (input) and prompt-response (output). English only. — [HF model card](https://huggingface.co/google/shieldgemma-2b)
- **How you use it:**
  - You put the policy text into the prompt, LLM-as-judge style.
  - The model answers Yes/No, and P(Yes) from the logits is used as a score.
  - The card warns it is "highly sensitive to the specific user-provided description of safety principles."

  — [HF model card](https://huggingface.co/google/shieldgemma-2b)
- **AU-PRC (vendor numbers):**

  | Model | OpenAI Mod | ToxicChat |
  |---|---|---|
  | ShieldGemma 2B | 0.887 | 0.778 |
  | ShieldGemma 9B | 0.907 | 0.782 |
  | ShieldGemma 27B | 0.886 | 0.811 |
  | OpenAI Mod API | 0.856 | 0.588 |
  | LlamaGuard1 | 0.847 | 0.626 |

  GPT-4 optimal F1 is 0.705 on OpenAI Mod and 0.683 on ToxicChat. — [HF model card](https://huggingface.co/google/shieldgemma-2b)
- **License:** Gemma license (gated; Google's prohibited use policy applies). — [HF model card](https://huggingface.co/google/shieldgemma-2b)

**IBM Granite Guardian 3.3 (8B; released 2025-08-01)**
- **Risks it covers:**
  - Harm umbrella: harm, social bias, jailbreaking, violence, profanity, sexual content, unethical behavior, harm engagement, evasiveness.
  - RAG checks: context relevance, groundedness, answer relevance.
  - Agentic: function-calling hallucination.

  — [HF model card](https://huggingface.co/ibm-granite/granite-guardian-3.3-8b)
- **Custom criteria:** set through `guardian_config.custom_criteria`. The card's example flags an SSN as personal information, and notes that custom criteria "require testing." — [HF model card](https://huggingface.co/ibm-granite/granite-guardian-3.3-8b)
- **Thinking mode:** `think=True` gives `<think>` reasoning plus `<score>`; otherwise the output is yes/no only. — [HF model card](https://huggingface.co/ibm-granite/granite-guardian-3.3-8b)
- **Harm F1 (aggregate):** 0.81 without thinking, 0.79 with thinking. Earlier versions: 3.1-8b 0.79, 3.2-5b 0.78. It scores 0.90 on xstest_RH. — [HF model card](https://huggingface.co/ibm-granite/granite-guardian-3.3-8b)
- **License:** Apache 2.0. English only. A much smaller Granite-Guardian-HAP-38M exists for hate/abuse/profanity. — [HF model card](https://huggingface.co/ibm-granite/granite-guardian-3.3-8b)

**WildGuard (7B, Mistral-7B-v0.3 base, AllenAI)**
- **One model, three tasks:** harmful prompt, harmful response, and refusal detection. Output looks like "Harmful request: yes / Response refusal: yes / Harmful response: no". It covers 4 risk categories with 13 subcategories, in English. — [HF model card](https://huggingface.co/allenai/wildguard)
- **License:** Apache 2.0, plus the AI2 Responsible Use Guidelines. — [HF model card](https://huggingface.co/allenai/wildguard)
- **Vendor claims:** it beats Llama Guard 2 and Aegis-Guard, by "up to 25.3% on refusal detection." It "matches GPT-4" and exceeds GPT-4 by up to 4.8% on adversarial prompt harmfulness. — [HF model card](https://huggingface.co/allenai/wildguard); [NeurIPS 2024 paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/0f69b4b96a46f284b726fbd70f74fb3b-Paper-Datasets_and_Benchmarks_Track.pdf)
- **Refusal-detection F1 on XSTestResponse / WildGuardTest (independent; GuardReasoner paper):**

  | Model | XSTestResponse | WildGuardTest |
  |---|---|---|
  | WildGuard 7B | 94.70 | 88.60 |
  | Llama Guard 3 8B | 63.55 | 54.29 |
  | ShieldGemma 2B | 61.06 | 50.18 |

  — [GuardReasoner, arXiv 2501.18492](https://arxiv.org/pdf/2501.18492)

**NVIDIA NemoGuard / Aegis**
- **Aegis 2.0 (NAACL 2025):** 33,416 annotated human–LLM interactions, a 12-category core hazard taxonomy plus 9 fine-grained subcategories. The guard models are PEFT fine-tunes of Llama 3.1-8B-Instruct, released as `llama-3.1-nemoguard-8b-content-safety` (Llama Nemotron Safety Guard V2). — [Aegis 2.0, arXiv 2501.09004](https://arxiv.org/pdf/2501.09004); [NeMo safety harness docs](https://archive.docs.nvidia.com/nemo/microservices/25.9.0/evaluate/flows/academic-benchmarks/safety-harness.html)
- **V1 permissive model (Llama Guard / Llama2-7B base):** 0.941 AUPRC and 0.76 F1 on the Aegis V1 test set, versus 0.930 and 0.62 for base Llama Guard. — [HF model card](https://huggingface.co/nvidia/Aegis-AI-Content-Safety-LlamaGuard-Permissive-1.0)
- **Newer NVIDIA model, Nemotron 3.5 Content Safety, on Aegis 2.0:** prompt harmful F1 0.86, response harmful F1 0.85. (Seen only in a search snippet.) — [HF model card](https://huggingface.co/nvidia/Nemotron-3.5-Content-Safety)

**Independent comparisons (2025–2026)**
- **Robustness study of 10 guard models (late 2025):**
  - Overall accuracy: Qwen3Guard-8B 85.3%, WildGuard-7B 82.8%, Granite-Guardian-3.3-8B 81.0%.
  - Llama Guard models were "too permissive": 97–99% accuracy on benign prompts, but only 4.5–21.8% detection of harmful ones.
  - Granite-Guardian-3.2-5B let only 12.5% of harmful prompts through, but over-refused 25.7% of benign ones.
  - ShieldGemma-2B's accuracy swung 20.7 points (48.6–69.3%) depending on prompt wording.

  — [arXiv 2511.22047](https://www.arxiv.org/pdf/2511.22047)
- **LLaDA-Guard paper (2026):**
  - Llama Guard 3/4 rarely over-refuse (PHTest accuracy 94.80 / 93.21) but lag on mixed-label benchmarks.
  - Trigger-word test: Granite's false positives rose from 1.77% with one trigger word to 10.62% with three. ShieldGemma had none.

  — [arXiv 2609.33634](https://arxiv.org/html/2609.33634)
- **ICLR 2026 workshop benchmark:** "Qwen Guard (4B parameters) achieves the highest recall (83.97%) while larger models like Llama Guard (12B) and GPT-OSS Safeguard (20B) exhibit conservative behavior, missing up to 75% of unsafe content." — [arXiv 2605.28830](https://arxiv.org/html/2605.28830v1)
- **Calibration study (9 guard models, 12 benchmarks):** guard models give overconfident predictions, are badly miscalibrated under jailbreak attacks, and are not robust to outputs from different response models. — [arXiv 2410.10414](https://arxiv.org/html/2410.10414v1)

**gpt-oss-safeguard (OpenAI, open weights, 20B/120B, research preview October 2025)**
- **What it is:** a reasoning model that classifies content against a written policy you supply, with low/medium/high reasoning effort. — [OpenAI cookbook guide](https://developers.openai.com/cookbook/articles/gpt-oss-safeguard-guide); [OpenAI announcement](https://openai.com/index/introducing-gpt-oss-safeguard/)
- **OpenAI's numbers:**
  - Multi-policy accuracy: 120b 46.3%, 20b 43.6%, gpt-5-thinking 43.2%.
  - OpenAI Mod F1: 82.9% for both sizes.
  - ToxicChat F1: 79.3% (120b) and 79.9% (20b).

  — [OpenAI technical report](https://cdn.openai.com/pdf/08b7dee4-8bc6-4955-a219-7793fb69090c/Technical_report__Research_Preview_of_gpt_oss_safeguard.pdf) (via search summary)
- **Cost and speed:** OpenAI says it is "time and compute-intensive," and that traditional classifiers trained on thousands of examples will likely do better on a given task. OpenAI puts small, high-recall classifiers in front of it and runs it asynchronously. — [OpenAI announcement](https://openai.com/index/introducing-gpt-oss-safeguard/) (via search summary)

### Inferences
- For a student-facing gateway, Llama Guard's permissiveness, as measured independently, means it would not be a reliable sole blocker. Its low over-blocking would suit it as a "definitely bad" filter.
- WildGuard, Qwen3Guard and Granite Guardian 3.3 are the best-balanced open options. Only Granite Guardian has a documented custom-criteria hook (useful for PII or university-specific rules) and an Apache license.
- Every 2B–12B guard model needs a GPU (or slow CPU inference) to run locally. That is heavy for a local Node.js demo, compared with an API call to Haiku, which the project already makes.

### Gaps
- Llama Guard 3 8B's own model-card F1/FPR figures (its comparison against GPT-4 and the OpenAI Moderation API) were not fetched in this session.
- No source here gave WildGuard's per-benchmark F1 table directly (the model card gives only relative claims). The NeurIPS paper has it but was not read in full.
- No source covered ShieldGemma 2 in the text-moderation sense. As far as I know, ShieldGemma 2 is an image-safety model, but this was not verified here.
- Qwen3Guard's own model card and license were not fetched.
- I found no single source that covers OR-Bench results for these guard models.

## 2. Hosted APIs: OpenAI Moderation, Azure AI Content Safety, Google Model Armor, Perspective, Anthropic constitutional classifiers

### Takeaway
- **OpenAI** omni-moderation is free and returns calibrated scores across 13 categories.
- **Azure Content Safety** adds Prompt Shields, a task-adherence check for agents, and custom categories (several preview features retire April 30, 2027).
- **Google Model Armor** bundles harm filters, injection detection, PII (via Sensitive Data Protection) and malicious-URL checks, but checks each turn without history.
- **Perspective API** shuts down on December 31, 2026, so don't use it.
- **Anthropic's constitutional classifiers** protect Anthropic's own models and are not sold as a separate API. Their published false-refusal rate is 0.05%.

### Cited Findings

**OpenAI Moderation API (`omni-moderation-latest`)**
- Launched September 26, 2024 and built on GPT-4o. Its scores are calibrated probabilities. — [OpenAI community announcement](https://community.openai.com/t/upgrading-the-moderation-api-with-a-new-multimodal-moderation-model/958187); [OpenAI blog](https://openai.com/index/upgrading-the-moderation-api-with-our-new-multimodal-moderation-model/) (blog returned 403 to direct fetch; facts via search summary)
- **13 categories:**
  - hate, hate/threatening
  - harassment, harassment/threatening
  - sexual, sexual/minors
  - violence, violence/graphic
  - illicit, illicit/violent (new; text-only)
  - self-harm, plus its intent and instructions variants

  Images are checked for the sexual, violence and self-harm categories. — [Search summary of OpenAI sources](https://community.openai.com/t/upgrading-the-moderation-api-with-a-new-multimodal-moderation-model/958187)
- **Multilingual:** a 42% improvement on OpenAI's internal multilingual eval across 40 languages versus text-moderation-007, better in 98% of the languages. Free for all developers. — [OpenAI community announcement](https://community.openai.com/t/upgrading-the-moderation-api-with-a-new-multimodal-moderation-model/958187)
- **Independent (Portkey):** the legacy model slightly beat omni on Jigsaw and HateXplain, while omni led on a multilingual set (0.322 vs 0.167). — [Portkey benchmark](https://portkey.ai/blog/openai-omni-moderation-latest-benchmark/)
- **2026 update:** moderation scores reportedly now come back inline in Responses/Completions calls (secondary source). — [AlphaSignal](https://alphasignal.ai/news/openai-folds-omni-moderation-latest-into-generation-calls-cutting-app-complexity)
- There is no PII category and no prompt-injection category (based on the category list above).

**Azure AI Content Safety (overview page updated 2026-10-28)**
- **Analyze Text/Image:** sexual, violence, hate and self-harm "with multi-severity levels." — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview)
- **Other features:**
  - Prompt Shields: scans text for "User input attack" risk.
  - Groundedness detection (preview).
  - Protected material detection.
  - Task adherence API: detects when an agent's tool use is "misaligned, unintended, or premature."
  - Custom categories, standard and rapid (preview).
  - Blocklists.

  — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview)
- **Retiring April 30, 2027:** Analyze Multimodal, Custom categories (rapid), connected/disconnected containers, the Embedded SDK, and groundedness detection. — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview)
- **Rate limits:** F0 5 RPS; S0 1000 requests per 10 s for moderation and Prompt Shields. — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview)
- **Languages:** trained and tested on Chinese, English, French, German, Spanish, Italian, Japanese and Portuguese. Protected material, groundedness and custom categories (standard) are English only. — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview)

**Google Model Armor**
- **What it screens:**
  - Responsible-AI filters: hate speech, harassment, sexually explicit, dangerous content. CSAM filtering is always on.
  - Prompt injection/jailbreak.
  - Sensitive Data Protection. Basic mode inspects credit cards, US SSN, financial accounts, US ITIN and GCP credentials/API keys. Advanced mode adds de-identification through templates.
  - Malicious URLs (first 256 only).

  — [Google Cloud docs](https://docs.cloud.google.com/security-command-center/docs/model-armor-overview)
- **Confidence thresholds:** High, Medium-and-above, Low-and-above. Google suggests High for hate/harassment and Medium for injection/jailbreak, and says Low carries the "highest false-positive risk." — [Google Cloud docs](https://docs.cloud.google.com/security-command-center/docs/model-armor-overview)
- **Limitations:**
  - Each turn is checked "on its own, with no conversation history."
  - Base64 is not decoded.
  - Inputs under 3 words return NO_MATCH_FOUND for injection.
  - It works across clouds and models.

  — [Google Cloud docs](https://docs.cloud.google.com/security-command-center/docs/model-armor-overview)

**Perspective API (Google Jigsaw)**
- It is being sunset. Service ends December 31, 2026, new quota requests closed in February 2026, and Google offers no migration support. — [perspectiveapi.com](https://www.perspectiveapi.com/); [Perspective developer site](https://developers.perspectiveapi.com/s/?language=en_US)

**Anthropic Constitutional Classifiers**
- **First generation:** jailbreak success fell from 86% (unguarded) to 4.4%, at a cost of +23.7% compute and +0.38% refusals on harmless queries. Bug-bounty participants found one universal jailbreak. — [Anthropic, Constitutional Classifiers++ (Jan 9, 2026)](https://www.anthropic.com/research/next-generation-constitutional-classifiers)
- **CC++ (January 2026):**
  - Refusals on harmless production traffic: 0.05% over one month on Claude Sonnet 4.5, an 87% drop.
  - Compute overhead: about 1%.
  - Red teaming: more than 1,700 hours and 198,000 attempts, one high-risk vulnerability found, and "no red-teamer has yet discovered a universal jailbreak."

  — [Anthropic](https://www.anthropic.com/research/next-generation-constitutional-classifiers)
- **CC++ architecture:**
  - An "exchange classifier" judges each output together with its input. That more than halved successful jailbreaks but cost 50% more compute.
  - A cascade sends cheap-stage flags to a stronger second stage instead of refusing, so the first stage can tolerate more false positives.
  - Linear probes on Claude's internal activations screen all traffic.

  — [Anthropic](https://www.anthropic.com/research/next-generation-constitutional-classifiers)

### Inferences
- The classifiers are built into Anthropic's own serving, focused on high-harm misuse such as CBRN. A developer calling Haiku gets that protection only for the model's own generations. It is not a general moderation endpoint for the gateway's student messages. (This is inferred from the article's framing. No Anthropic "moderation API" was found.)
- Anthropic's cascade design (cheap first stage that escalates rather than refuses, then a context-aware second stage) is a published pattern the Hub could copy: a local regex or classifier first, then a Haiku judge.
- Of the hosted options, only Model Armor and Azure cover injection plus harm in one service. Only Model Armor covers PII natively. OpenAI's is free but covers harm categories only.

### Gaps
- Azure's exact severity scale (0–7 values grouped into four levels) and the document-attack half of Prompt Shields were not confirmed on the fetched page.
- Model Armor pricing and token limits are on separate pages that were not fetched.
- I found no public benchmark numbers for Azure Prompt Shields or Model Armor.

## 3. A general LLM (e.g. Claude Haiku) as judge with a policy prompt vs a dedicated guard model

### Takeaway
- **Accuracy:** evidence suggests strong general LLMs given a policy prompt agree with humans at least as well as off-the-shelf guard models, and better than older ones.
- **Cost and speed:** they cost more and run slower.
- **Consistency:** it varies by category, language and judge version.

Dedicated policy-following guard models (gpt-oss-safeguard, ShieldGemma, Granite custom criteria) sit in between. Vendors themselves recommend putting a cheap classifier in front of the expensive reasoning judge.

### Cited Findings
- **SORRY-Bench (ICLR 2025), agreement with 7K+ human labels:**

  | Judge | Agreement |
  |---|---|
  | GPT-4o | 78.9% |
  | Fine-tuned BERT | 74.6% |
  | Llama-3-70b-instruct | 71.5% |
  | WildGuard | 60.6% |
  | HarmBench classifier | 52.5% |
  | Llama-Guard-2-8B | 40.8% |
  | MD-Judge | 37.2% |

  The authors say fine-tuned 7B LLMs can match GPT-4-scale judges at lower cost. — [SORRY-Bench, ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/file/9622163c87b67fd5a4a0ec3247cf356e-Paper-Conference.pdf)
- **Consistency:** in a study of six LLM judges on about 350 safety prompts in 6 languages, judge inconsistency "can vary significantly by the chosen safety criteria and can be impacted by the language of the content and its linguistic style." — [arXiv 2605.31381](https://arxiv.org/html/2605.31381v2)
- **Reliability vs validity:** judge setups can pass consistency checks and still disagree with experts, and "judge upgrades are not interchangeable" (blog summary of 2026 studies; secondary source). — [Kili Technology](https://kili-technology.com/blog/data-story-who-judges-the-judge-llm-as-a-judge)
- **Narrow task:** on refusal scoring, a Qwen-2.5-14B judge agreed with Llama-Guard-3-8B to within a few points (the largest gap in the table was 7.4 points). — [arXiv 2505.19056](https://arxiv.org/pdf/2505.19056)
- **gpt-oss-safeguard as a policy-prompt judge:**
  - OpenAI: traditional classifiers "have lower latency and cost less," and classifiers trained on thousands of examples "will likely do better on a given task."
  - Independent batched throughput on one RTX 6000 Pro: gpt-oss-safeguard-120b 24.66 ms/prompt at F1 0.807, Llama Guard 4 12B 7.44 ms at F1 0.691.

  — [OpenAI](https://openai.com/index/introducing-gpt-oss-safeguard/); [arXiv 2605.28830](https://arxiv.org/html/2605.28830v1) (via search summary)
- **Policy sensitivity:** ShieldGemma (itself a policy-in-prompt judge) is "highly sensitive to the specific user-provided description of safety principles." — [HF model card](https://huggingface.co/google/shieldgemma-2b)
- **Cost (weak industry source):** an LLM judge reaches about 80% agreement with humans at roughly two orders of magnitude higher cost per decision. — [digitalapplied guide](https://www.digitalapplied.com/blog/ai-content-moderation-2026-llm-trust-safety-guide)

### Inferences
- For this project, a Haiku judge has three advantages:
  - It is already integrated, with structured output, no hidden retries and sanitized errors.
  - It can take the conversation context and a university-specific policy (for example, "kill a process" in a CS tutoring context is benign).
  - It needs no GPU.

  The costs are a paid call and added latency on every screened message, and its verdicts will vary somewhat from run to run.
- Wording the policy carefully and asking for a structured verdict (category + allow/flag/block + short reason) follows the pattern of ShieldGemma, Granite custom criteria and gpt-oss-safeguard.
- Because guard models are badly calibrated, treat a judge's confidence as a hint, not a probability.

### Gaps
- I found no published head-to-head of Claude Haiku as a moderation judge versus guard models. Accuracy, latency and cost for Haiku in this role would have to be measured on the project's own test set.
- I found no source on the run-to-run consistency of Anthropic models on moderation tasks.

## 4. Over-blocking / false positives

### Takeaway
Over-blocking is well documented and measurable (XSTest, XSTest-Resp, PHTest, OR-Bench). Guard models differ widely:
- Llama Guard almost never over-blocks but misses a lot.
- Granite 3.2 over-blocked about 26% of benign prompts in one study.
- Trigger words push some models into false positives.

The documented mitigations are adjustable thresholds (Model Armor, Azure severities, ShieldGemma/OpenAI scores), better policy wording, custom categories, and passing context (the exchange classifier and cascade designs).

### Cited Findings
- **XSTest (NAACL 2024; v1 August 2023):** 250 safe prompts across ten prompt types plus 200 contrasting unsafe prompts. It targets cases where "clearly safe prompts are refused if they use similar language to unsafe prompts or mention sensitive topics." — [arXiv 2308.01263](https://arxiv.org/abs/2308.01263)
- **Benign over-refusal (independent):** Granite-Guardian-3.2-5B over-refused 25.7% of benign requests. Llama Guard models were 97–99% accurate on benign prompts. — [arXiv 2511.22047](https://www.arxiv.org/pdf/2511.22047)
- **Trigger words:** Granite's false positives rose from 1.77% with one trigger word to 10.62% with three. ShieldGemma had no false positives. Llama Guard 3/4 scored 94.80 / 93.21 on PHTest. — [arXiv 2609.33634](https://arxiv.org/html/2609.33634)
- **Anthropic:** first-generation classifiers added 0.38% refusals on harmless queries. CC++ is at 0.05% on production traffic. The cascade lets the cheap stage over-flag because flags escalate rather than refuse. — [Anthropic](https://www.anthropic.com/research/next-generation-constitutional-classifiers)
- **Model Armor thresholds:** "High" has the lowest false-positive risk. "Low and above" has the highest and is not advised for general content categories. — [Google Cloud docs](https://docs.cloud.google.com/security-command-center/docs/model-armor-overview)
- **Prompt Guard 2:** flags any text that tries to override instructions, even when harmless. Meta reports recall at 1% FPR, and says application-specific traffic lowers accuracy (fine-tune recommended). — [HF model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- **Measuring over-refusal:** the Mozilla any-guardrail proposal (July 2026) recommends XSTest for measuring guardrail false-positive rates, minding the full vs -Resp variants. — [GitHub issue](https://github.com/mozilla-ai/any-guardrail/issues/194)

### Inferences
- In a university setting, legitimate topics can look "unsafe" without context: chemistry, history of violence, mental-health questions, killing processes in CS. That favors context-aware judging and a "flag and route to a human/professor" outcome over a hard block, for anything except clearly bad cases.
- Prompt Guard's "override instructions" definition would flag students who innocently write "ignore my last message." Expect false positives on chat inputs; it suits third-party content (documents, tool results) better than direct user turns. Meta's own guidance on application-specific traffic points the same way.

### Gaps
- I did not find a reliable source quoting the exact "How do I kill a Python process?" example text from XSTest; only the abstract was fetched.
- I found no OR-Bench results for guard models in this session.

## 5. Small fast classifiers usable in Node.js (ONNX via transformers.js)

### Takeaway
Running small classifiers in-process in Node.js is feasible today with `@huggingface/transformers`:
- toxic-bert (Detoxify) has ONNX exports of 111–438 MB.
- Prompt Guard 2 86M has a community ONNX export tagged for transformers.js.
- Several prompt-injection and multilingual toxicity classifiers ship ONNX files.

Quantization can hurt accuracy noticeably (Prompt Guard 2 86M dropped from 0.98 to 0.90 accuracy in one vendor's test). CPU latency in Node was not documented in any source found.

### Cited Findings
- **toxic-bert:** `Xenova/toxic-bert` ships model.onnx (438 MB), model_fp16.onnx (219 MB) and model_quantized.onnx (111 MB). It has 6 toxicity labels and comes from Unitary Detoxify (Apache 2.0). Usage: `pipeline('text-classification', 'Xenova/toxic-bert')`. — [Xenova/toxic-bert files](https://huggingface.co/Xenova/toxic-bert/tree/main/onnx); [skillsafe-ai mirror card](https://huggingface.co/skillsafe-ai/toxic-bert)
- **Prompt Guard 2 86M:** `sinatras/Llama-Prompt-Guard-2-86M-ONNX` is tagged for Transformers.js (automatic conversion by a community user, not Meta). — [HF](https://huggingface.co/sinatras/Llama-Prompt-Guard-2-86M-ONNX)
- **Gravitee's quantized exports (Optimum-format):**

  | Model | Accuracy | Recall | AUC-ROC |
  |---|---|---|---|
  | Prompt Guard 2 86M, full precision | 0.980 | 0.963 | 0.952 |
  | Prompt Guard 2 86M, quantized | 0.899 | 0.802 | 0.745 |
  | Prompt Guard 2 22M, quantized | ~0.958 | — | — |

  These files sit at the repo root, not in `onnx/`. — [gravitee 86M](https://huggingface.co/gravitee-io/Llama-Prompt-Guard-2-86M-onnx); [gravitee 22M](https://huggingface.co/gravitee-io/Llama-Prompt-Guard-2-22M-onnx)
- **Meta's GPU latency:** 92.4 ms (86M) and 19.3 ms (22M) for 512 tokens on an A100. — [HF model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- **Other ONNX classifiers for transformers.js:**
  - `Horizon-Labs/prompt-injection-guard-base` (308M; int8 ONNX "half the size and the same decisions as fp32 on our checks").
  - `onnx-community/bert-multilingual-toxicity-classifier-ONNX`.
  - `OperKH/twitter-xlmr-toxicity-classifier-ONNX` (15 languages).
  - `protectai/unbiased-toxic-roberta-onnx` (made for LLM Guard / Python).

  — [Horizon-Labs](https://huggingface.co/Horizon-Labs/prompt-injection-guard-base); [onnx-community](https://huggingface.co/onnx-community/bert-multilingual-toxicity-classifier-ONNX); [OperKH](https://huggingface.co/OperKH/twitter-xlmr-toxicity-classifier-ONNX); [protectai](https://huggingface.co/protectai/unbiased-toxic-roberta-onnx)
- **Llama Guard 3 1B ONNX:** `onnx-community/Llama-Guard-3-1B` exists, a small generative guard that can be loaded by the same toolchain. — [HF](https://huggingface.co/onnx-community/Llama-Guard-3-1B)
- **Small IBM option:** Granite-Guardian-HAP-38M targets tighter cost and latency budgets (hate/abuse/profanity). — [Granite Guardian 3.3 card](https://huggingface.co/ibm-granite/granite-guardian-3.3-8b)

### Inferences
- A local toxicity model (toxic-bert quantized, about 111 MB) plus an injection model (Prompt Guard 2 22M/86M) could act as the cheap first stage in Node, with no network and no per-call cost. Ambiguous cases would escalate to the Haiku judge, mirroring Anthropic's cascade.
- Adding these would mean a new pinned dependency (`@huggingface/transformers`, with onnxruntime-node) and a large model download. That conflicts with the project's minimal-dependency style, so it would need the owner's approval.
- toxic-bert was trained on Jigsaw comment toxicity. It detects offensive language, not harmful intent, injection or PII. PII is better handled by deterministic patterns (emails, SSNs, phone numbers), as Model Armor's basic mode and Granite's SSN example suggest.

### Gaps
- I found no published CPU latency for toxic-bert or Prompt Guard 2 in transformers.js on Node (for example, on a Mac M-series). This would have to be measured locally.
- The community Prompt Guard 2 ONNX conversion (sinatras) has no published accuracy check against the original weights.
- License inheritance for community ONNX conversions of Llama models (the Llama 4 Community License still applies) was not verified on those repos.
