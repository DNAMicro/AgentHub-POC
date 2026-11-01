# Rules as typed facts, verdicts with proof

*Research synthesis, Saturday, Oct 31, 2026 09:55 PM PDT. Built from `research_notes/ComplianceNLP lessons for compliance engine/compliancenlp_paper.md` (arXiv 2604.23585v1, read in full) and the two earlier reports, `reports/AI gateway guardrail mechanisms.md` and `reports/IDS speed methods for guardrails.md`. Each section separates **proven facts** (from the paper) from **interpretations** (my reasoning about our app, labelled as such).*

ComplianceNLP is not a live guardrail. It is an offline system that reads new bank regulations and reports where a bank's internal policies fall short. It still answers three questions our Connectivo Compliance engine faces:

- How should a rule be written down so a machine can place it and check it?
- How do you trust a model's verdict?
- How do you run the system so people neither ignore it nor trust it blindly?

Its answers:
- Write each obligation as a **typed tuple ⟨entity, action, modality, condition, source⟩**, linked in a graph with "amends", "supersedes" and "applies to" edges.
- Make every model verdict **cite its source and have that citation checked** before release.
- **Tune for catching serious violations** even at the cost of more false alerts.
- Send complex or high-severity cases to a person, and actively fight automation bias.

The rule format and the "applies to" link fit **Step 13** (placing policies at the right agent) almost exactly. The grounding check and severity thresholds fit **Step 12's** Decision Model. Its speed tricks (distillation, speculative decoding on a self-hosted model) don't transfer, because we call a hosted model and the project rules out training.

## How the paper writes rules down

**Proven facts.** Obligations are extracted into a tuple ⟨entity, action, modality, condition, source_provision⟩.
- The modality comes from a four-way **deontic** classifier: Obligation, Permission, Prohibition, Recommendation. "Deontic" means what a rule requires, allows or forbids.
- The tuples live in a knowledge graph of "12,847 provision nodes and 34,219 edges".
- Edge types are Amends, Supersedes, CrossReferences, Implements and **AppliesTo**.
- Adding this structure raised cross-reference F1 from 72.3 to 89.1. Removing graph re-ranking cost 4.6 points of gap-detection F1, and 5.4 on the most serious class (p = 0.007).
- Accuracy still falls as rules get tangled: grounding goes from 97.1% (no cross-references) to 84.6% (3 or more), and to about 79% on nested conditions.
- Nearly half the missed gaps (23 of 47) sat in chains of amendments.

**Interpretation.** This is the shape Step 13's policies should take. Take "no online class on Fridays":

| Field | Value |
|---|---|
| entity | student |
| action | attend online session |
| modality | prohibition |
| condition | day = Friday |
| source | the university policy text, quoted |

Written this way, **automatic placement becomes a lookup, not a guess.** The action "online session" maps to the Tutor's `in-person-tutoring-request` / session-booking skill, which gives the AppliesTo edge. That is the owner's Step 13 requirement ("smart enough to know where to install it"). The modality also maps straight to an outcome: a prohibition refuses, an obligation requires a field, a recommendation only warns.

Our rule ids already carry versions (`no-online-friday@1`). Adding a **supersedes** link between versions, and refusing to load two versions of the same rule at once, avoids the amendment-chain misses the paper reports. The paper's finding on complexity is a reason to keep each rule **flat**: one condition, no references to other rules.

## Verdicts must cite their source, and code checks the citation

**Proven facts.**
- Every gap verdict carries a citation, a severity and remediation advice.
- A separate checker, MiniCheck, verifies that the verdict is grounded in the cited text, with a 0.85 threshold.
- Removing it dropped grounding accuracy from 94.2% to 86.7%.
- Its main failure was "conflating related but distinct provisions".
- Low-confidence outputs go to a human.

**Interpretation.** Our Decision Model (the AI judge) should return, with each "block", the **category id and the exact words of the judge policy line it relied on**. The Hub then checks in code that those words appear in the current policy, the same verbatim check the Library already uses for its evidence lines (Part 5). If the check fails, the verdict is treated as no verdict, which follows the fail-closed rule we already have.

This costs nothing at runtime: it's a string match, not a second model call. It also gives the Guardrails tab's Activity view an honest "because" for every block.

## Tune for the serious misses, and say so

**Proven facts.**
- In production they lowered the flagging threshold from 0.6 to 0.45.
- Recall on full gaps rose from 79.8 to 91.2, and precision fell from 83.2 to 72.8.
- False alerts went from 1.3 to 3.7 a day, and missed obligations from 2.1 to 0.7 per 100 pages.
- Their reason: "a single missed compliance gap eroded confidence significantly".
- Mandatory human review covers High/Critical findings and anything with 3 or more cross-references. Later phases let low-severity findings through, with random audits of 5%.

**Interpretation.**
- **Per-severity thresholds.** Each rule and judge category gets a severity. High-severity categories (someone else's personal data, self-harm, threats) block when the judge is unsure. Low-severity ones (mild language) only block on a confident verdict, or run in watch-only mode.
- **Professor review queue.** Watch-only mode already gives us the parallel run the paper used before going live. Its human-review rule suggests one addition for professor posts: a blocked professor post at high severity could offer a "send for review" action to an administrator queue instead of only "Not sent". That would be a later enhancement, not part of Step 12.

## Keep people honest about the machine

**Proven facts.**
- In the first two weeks, 34% of analysts accepted outputs without checking.
- Showing confidence on every output and running weekly calibration with deliberately planted errors brought that down to 12%.
- The "most effective" step was a weekly accuracy digest comparing the system with manual review.
- Drift was caught by watching confidence: a drop to 0.62, against 0.84 normally, flagged a rule change within 6 hours.

**Interpretation.** Our test set (Step 12, §7.3) can serve as the weekly digest. It re-runs on every policy or rule change and on a schedule, and the Guardrails tab shows pass rate and over-blocking over time. Planting a few known-bad messages in the test set is the "seeded errors" idea. A falling judge confidence, or a rising watch-only "would block" count, is our drift signal.

## What does not transfer

**Proven facts.** Speed came from distilling a 70B model into an 8B one and adding domain speculative-decoding heads. That took p50 latency from 1,847 to 659 ms and p99 from 3,214 to 1,082 ms. Even so, p99 still missed their sub-second target. End-to-end fine-tuning made results worse and cost more.

**Interpretation.**
- **Speed:** we call a hosted model, and the project rules out training, so none of these speed methods apply. The paper's own numbers support the stance of the earlier IDS report: the model's verdict can't be made fast, so it has to be hidden (run alongside the router) or made rare (rules first).
- **Scale:** the retrieval and knowledge-graph machinery is sized for 60,000 regulatory events a year. Our handful of university policies fits in one config file, so a plain list with typed fields and AppliesTo links gives us the useful part without a graph database.

## What I recommend we change in the design

1. **Step 13 policy format (my call, for the Step 13 design):**
   - Each policy is a typed record { id@version, entity, action, modality, condition, source quote, severity, supersedes }.
   - Placement uses the action → skill map, the AppliesTo link.
   - A new agent's sign-in bundle is the list of records whose AppliesTo matches its skills.
2. **Step 12 Decision Model (my call):**
   - Every block verdict must cite a category id plus the exact policy words.
   - The Hub checks those words verbatim in code, and a failed check counts as no verdict, so it fails closed.
3. **Step 12 severities (my call):**
   - Each rule and judge category gets a severity.
   - High severity blocks when unsure; low severity needs a confident verdict.
4. **Step 12 test set as the accuracy digest (already planned; strengthened):**
   - Re-run it on every change and show the trend.
   - Include a few planted known-bad messages.

## Still to test

- Whether Haiku 5.5 reliably quotes a policy line word for word under structured output. The Library's evidence lines suggest yes, but the judge prompt is different, so it needs a live check.
- How often the verbatim check would turn a correct block into "no verdict", and so into a block anyway under fail-closed. Measure it on the test set before turning it on.
