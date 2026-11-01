# ComplianceNLP (arXiv 2604.23585v1): notes

Source: Dongxin Guo, Siu Ming Yiu (The University of Hong Kong), Jikun Wu (Stellaris AI Limited),
"ComplianceNLP: Knowledge-Graph-Augmented RAG for Multi-Framework Regulatory Gap Detection",
arXiv:2604.23585v1 [cs.CL], 26 Apr 2026. https://arxiv.org/html/2604.23585v1
Code: github.com/bettyguo/ComplianceNLP. Read in full (main text + appendices A–Q) on 31 Oct 2026.

## What it is

An offline system for banks. It reads new regulations (SEC, MiFID II, Basel III) and reports where the
bank's internal policies fall short ("gaps"). It does **not** check live messages and is **not** a
multi-agent guardrail; everything below about our app is interpretation.

## Facts (quoted or exact numbers from the paper)

### Pipeline (three stages)
1. **KG-augmented retrieval:** hybrid dense + BM25 (α = 0.7). The top 5 passages are re-ranked by
   distance in a Regulatory Knowledge Graph (β = 0.3).
   - Graph size: "12,847 provision nodes and 34,219 edges".
   - Node types: Provision, Entity, Obligation, Threshold, Enforcement.
   - Edge types: Amends, Supersedes, CrossReferences, Implements, AppliesTo.
   - Updates: synced nightly, with an 18-hour median incorporation latency.
   - Unvalidated provisions carry `pending_validation` and fall back to embedding-only retrieval.
2. **Obligation extraction:** LEGAL-BERT with three heads:
   - NER, 23 entity types;
   - a deontic classifier: Obligation / Permission / Prohibition / Recommendation;
   - a cross-reference resolver.
3. **Gap analysis:** each obligation becomes a tuple **⟨entity, action, modality, condition,
   source_provision⟩**.
   - Policies stay as text clauses.
   - Alignment = dense similarity × a learned fuzzy type match ("credit institution" vs "bank").
   - A clause scoring below δ is flagged. LLaMA-3 then labels it Compliant / Partial Gap / Full Gap, with
     citation, severity and remediation.
   - **MiniCheck** verifies grounding (τ = 0.85); low-confidence outputs go to a human.

What it does not use:
- No formal methods, solvers or sandboxing.
- Enforcement is advisory, with humans in the loop.

### Results
- **Accuracy:**
  - Gap detection F1 87.7 (+3.5 over GPT-4o+RAG); end-to-end 83.4 F1, where NER boundary errors cause 68%
    of the drop.
  - Grounding accuracy 94.2%, vs 83.7% for GPT-4+RAG and 85.1% for GPT-4o+RAG.
  - Grounding falls with complexity: 97.1% with 0 cross-references → 84.6% with 3+ → ~79% on nested
    conditionals (38 instances).
  - Main grounding failure: "conflating related but distinct provisions".
- **Ablations:**
  - Removing KG re-ranking costs −4.6 gap F1, and −5.4 on Full Gap (p = 0.007).
  - Removing MiniCheck drops grounding from 94.2% to 86.7%.
  - KG structure raised cross-reference F1 from 72.3 to 89.1 in early prototypes.
- **Thresholds:** deployment uses δ = 0.45 instead of 0.6.
  - Full Gap recall 79.8 → 91.2, precision 83.2 → 72.8.
  - False alerts 1.3 → 3.7 per day.
  - Missed obligations 2.1 → 0.7 per 100 pages.
  - The rationale is that "a single missed compliance gap eroded confidence significantly".
- **Latency:** 70B teacher p50 1,847 ms / p99 3,214 ms. 8B distilled + domain Medusa p50 659 ms / p99
  1,082 ms (2.8×), keeping ≥97.4% of teacher accuracy.
  - The p99 still misses the sub-second target. Causes: >5 KG hops 41%, Medusa rejection cascades 29%,
    FAISS contention 30%.
  - Regulatory text is predictable (entropy 2.31 vs 3.87 bits), which is why speculative decoding works
    well on it.
- **Deployment (4-month parallel run, Oct 2025–Jan 2026):**
  - 9,847 updates; 1,243 gaps flagged, 1,127 confirmed.
  - 47 missed, giving estimated recall 96.0% (95.6–95.8% if manual recall is 90–95%).
  - Override rate 11.4% → 6.1%; uptime 99.2%; 3.1× faster analysts.
  - Found 24 gaps that the manual process had missed.
- **Missed gaps:** 23/47 were in Basel III amendment chains and 14/47 were implicit MiFID II obligations.
  By severity: 3 Critical, 11 Major, 19 Moderate, 14 Minor.

### Operations
- **Human review:**
  - Mandatory for High/Critical findings and for obligations with 3+ cross-references.
  - Later phases give graduated autonomy to low-severity findings, plus random audits of 5% of them.
- **Automation bias:**
  - In weeks 1–2, 34% of analysts accepted outputs without checking.
  - Fixes: mandatory confidence display and weekly calibration with deliberately seeded errors. This
    brought uncritical acceptance to 12% by month 3.
  - "Most effective": weekly accuracy digests comparing the system with manual review.
- **Drift:**
  - A confidence drop (0.62 vs 0.84; 2σ rule) flagged a Basel III amendment within 6 h, retrained
    within 48 h.
  - 3 shift events in 4 months. Upkeep is 4–6 h per week.
- **Integration:**
  - About 3 months, as long as model development; budget "at least 40%" of the timeline.
  - The GRC platform expected rules **by business function**, but the source taxonomy was **by
    regulation**. Mapping 847 categories reached 94.1% automatically; 5.9% went to manual review.
- **Failed approach:** end-to-end fine-tuning was worse (86.3 → 81.7 F1, ~$2,800 per run) than
  distillation (~$420 per run).

### Limitations (theirs)
- Covers 3 frameworks (~48% of update volume), English only.
- GapBench is small and from a single institution (Full Gap F1 81.5 ± 4.2).
- The user study is small and unblinded (12 analysts).
- All outputs were human-reviewed, so behaviour with less oversight is untested.
