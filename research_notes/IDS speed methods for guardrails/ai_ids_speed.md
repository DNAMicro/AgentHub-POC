# How AI/ML-based IDS and NDR keep up with network speed, and what transfers to fast chat-text screening

Research date: Friday, Oct 30, 2026. Vendor statements are marked "(vendor claim)". Search snippets were cross-checked against primary docs where a fetch was possible. The notes say so where a figure comes only from a third party.

## 1. Where the ML sits: inline or out-of-band? Do commercial AI NDR products block inline?

### Takeaway
The best-known "AI NDR" products (Darktrace, Vectra AI, ExtraHop RevealX, Cisco Secure Network Analytics) are **passive and out-of-band**. They watch a copy of the traffic (SPAN/TAP mirror or NetFlow/IPFIX records), so their ML never delays a packet. They detect after the fact and respond afterwards: TCP resets, or asking a firewall/NAC/EDR to block. Firewalls (Palo Alto, Fortinet) are the ones that run ML **inline**. Even they put ML only on a small "unknown/suspicious" slice, behind signatures, with a time cap and a configurable allow-or-block action when the cap is hit.

### Cited Findings
- **Vectra AI:** its X47 appliance docs say "out of band deployment is the only supported method of traffic capture. There is no inline mode for currently supported Vectra Sensor appliances." Traffic arrives via SPAN/COPY/MIRROR, TAPs or packet brokers. — [Vectra docs, X47](https://docs.vectra.ai/deployment/ndr-physical-appliances/x-series/x47)
- **ExtraHop RevealX:** the appliance needs "a passive feed of network (SPAN port), a network tap, or a network data broker" and is described as "a completely passive solution". — [ExtraHop Reveal(x) POC datasheet](https://assets.extrahop.com/datasheets/ExtraHop-Reveal(x)-POC-datasheet.pdf). It decrypts while "remaining out-of-band for no performance impact" (vendor claim). — [ExtraHop datasheet via SHI](https://www.content.shi.com/cms-content/accelerator/media/pdfs/extrahop/extrahop-100224-revealx-network-detection-and-response-datasheet.pdf). Blocking goes through integrations (firewall, NAC, EDR) (third-party summary). — [Security Scientist](https://www.securityscientist.net/blog/12-questions-and-answers-about-extrahop-reveal-x-extrahop/)
- **A 2026 comparison** calls Darktrace, ExtraHop, Vectra and Corelight all "passive, out-of-band sensors", and says Vectra and Corelight cannot block traffic themselves (third party). — [Technologymatch, 2026](https://technologymatch.com/blog/darktrace-vs-extrahop-vs-vectra-ai-vs-corelight-ndr-comparison)
- **Darktrace:** sensors take traffic "into one or more packet capture ports", and setup starts by configuring a SPAN/port mirror. "Autonomous Response" (formerly RESPOND/Network, formerly Antigena) acts by sending **spoofed TCP RST packets** from the Darktrace instance. The spec admits limits: RSTs typically cannot cross stateful devices, may not reach their destination, and do not work for UDP. Actions can wait in a "pending" state unless automatic action has been granted. — [Darktrace Product Specification v1.5.1](https://cdn.prod.website-files.com/626ff4d25aca2edf4325ff97/6984ac7573b5414b46acdb7c_Darktrace%20Offering%20Product%20Specification%20v1.5.1.pdf); [v1.2, Oct 2024](https://cdn.prod.website-files.com/626ff4d25aca2edf4325ff97/67191e731225b20fb9d63229_Darktrace%20Offering%20Product%20Specification%20v1.2%2020241015.pdf)
- **Darktrace modes:** there is a "Human Confirmation Mode" (a human approves recommended actions, e.g. in the mobile app) and an "Active Mode" (fully autonomous). It "responds within seconds" (vendor claim). — [Darktrace Antigena product brief](https://cdn.blueally.com/cyberaiworks/datasheets/ds-antigena-network.pdf); [Darktrace Antigena white paper](https://www.3sc.ae/3SC%20Solutions/DT%20AI-Powered%20Autonomous%20Response.pdf)
- **Cisco Secure Network Analytics (formerly Stealthwatch):** it collects telemetry (NetFlow, IPFIX, cloud flow logs) from existing routers, switches and firewalls, with "the network infrastructure itself becom[ing] the sensor". It uses behavioural (non-signature) techniques. Optional Flow Sensors generate flow records where gear cannot. — [Cisco SNA white paper](https://www.cisco.com/c/en/us/products/collateral/security/stealthwatch/white-paper-c11-740605.pdf); [Cisco SNA data sheet](https://www.cisco.com/c/en/us/products/collateral/security/stealthwatch/datasheet-c78-739398.html). Core detections run on each flow collector with "98+ tunable behavioural algorithms". — [Cisco Live 2024 BRKSEC-3019](https://www.ciscolive.com/c/dam/r/ciscolive/emea/docs/2024/pdf/BRKSEC-3019.pdf). Feeding it sampled sFlow may hurt detection accuracy. — [Cisco SNA 7.4.2 Analytics guide](https://www.cisco.com/c/dam/en/us/td/docs/security/Analytics/7_4_2_Analytics_Detections_Alerts_Observations_DV_2_2.pdf)
- **Fortinet FortiGuard AI-based Inline Malware Prevention:** known-good files are allowed, malicious files blocked, and **unknown files are held** in an inline sandbox until a verdict ("holds any unknown content … until the verdict is rendered") (vendor claim: "without traffic impact"). — [Fortinet ILMPS page](https://www.fortinet.com/support/support-services/fortiguard-security-subscriptions/inline-malware-prevention); [Fortinet solution brief](https://www.fortinet.com/content/dam/fortinet/assets/solution-guides/sb-fortiguard-ilmps.pdf). FortiOS 7.2.1 docs: FortiGate holds a file **up to 50 seconds** for the verdict, and timed-out scans can be set to block, log or ignore. — [FortiOS 7.2.1 docs](https://docs.fortinet.com/document/fortigate/7.2.0/new-features/599740/inline-scanning-with-fortiguard-ai-based-sandbox-service-7-2-1). The newer FortiSandbox "PAIX" engine claims verdicts "within milliseconds" (vendor claim). — [FortiSandbox data sheet](https://www.fortinet.com/content/dam/fortinet/assets/data-sheets/FortiSandbox.pdf)
- **Palo Alto:** inline (see Section 3).

### Inferences
- "AI-based and fast" usually means **the AI is not in the path**. NDR products get their speed by working on a copy and accepting that they react after the fact (seconds), using resets or other control points. That fits a security team that tolerates a short exposure window. It does not fit a guardrail that must stop a harmful reply *before* a student sees it.
- The inline products avoid putting ML on every item. They hold only the "unknown" fraction, with a time cap and an explicit fail-open/fail-closed choice. That is a pattern the Hub can copy directly.

### Gaps
- No primary document found on whether Darktrace or Vectra have added inline enforcement in 2026. Darktrace's 2026 spec still describes RST-based response.
- No vendor figure for what share of traffic reaches the inline ML stage (Fortinet's "unknown" share, Palo Alto's cloud-escalation share).

## 2. Speed techniques: flow features, light models, early classification, cascades, sampling, hardware/in-network ML, latency figures

### Takeaway
Fast ML IDS rely on a few stacked tricks:
- summarise traffic into **small numeric feature vectors** (flow statistics, not payloads);
- use **cheap models** (trees, forests, binary neural nets) that fit the hardware;
- **decide as early as possible** (first N packets) once confidence is high;
- **escalate only uncertain cases** to heavier analysis;
- move inference **close to the data** (switch or SmartNIC), because shipping data to a CPU often costs more than the model itself.

Reported in-network latencies are nanoseconds to tens of microseconds. That is possible only because the models are tiny.

### Cited Findings
- **Flow telemetry instead of payload:** Cisco SNA analyses NetFlow/IPFIX flow records rather than full packets. — [Cisco SNA white paper](https://www.cisco.com/c/en/us/products/collateral/security/stealthwatch/white-paper-c11-740605.pdf)
- **Early classification (pForest):** "As Soon As Possible" classification on programmable data planes. It trains **context-dependent random forests**, one per flow phase (the first x packets), switches models per packet, and trusts a result only when the model's certainty is high enough. Random forests suit switches because they are sequences of comparisons (no floating point, no loops). Training is in Python, inference in P4. — [pForest, arXiv 1909.05680](https://arxiv.org/abs/1909.05680); [HTML v2](https://arxiv.org/html/1909.05680v2)
- **Taurus (ASPLOS 2022):** adds a MapReduce/SIMD block to switch and NIC pipelines for per-packet inference. ASIC evaluation: +3.8% area and **up to 221 ns** added latency for line-rate models. Non-ML packets bypass it. The FPGA prototype detected two orders of magnitude more events than a control-plane anomaly detector, which works on millisecond timescales. — [Taurus, arXiv 2002.08987](https://arxiv.org/pdf/2002.08987); [ACM PDF](https://dl.acm.org/doi/pdf/10.1145/3503222.3507726); [IETF 114 ANRP slides](https://www.irtf.org/anrp/IETF114-ANRP-Swamy.pdf). A third-party summary gives an average of 122 ns and 1 GPkt/s; not checked against the paper.
- **N3IC (NSDI 2022):** compiles **binary neural networks** into SmartNIC data planes (Netronome micro-C, P4→FPGA, native FPGA). Claims up to 100× lower classification latency and 1.5–7× higher throughput than software ML, at 40 Gbps line rate. CPU baseline: 42 µs, rising past 800 µs at 1M flows/s; N3IC stays under 40 µs. Uses 1–2% of a Virtex7 FPGA's logic. — [N3IC NSDI'22 paper](https://www.usenix.org/system/files/nsdi22-paper-siracusano.pdf); [USENIX page](https://www.usenix.org/conference/nsdi22/presentation/siracusano). A survey notes the PCIe trip to the CPU often costs more than the inference. For larger networks the NIC can become slower than the round trip, so the CPU wins. — [ACM survey "Offloading ML to programmable data planes"](https://dl.acm.org/doi/10.1145/3605153)
- **FENIX (NSDI 2026):** an FPGA attached to a programmable switch for DNN inference, targeting <5 µs. It argues switches give multi-Tbps throughput versus hundreds of Gbps for SmartNIC designs like N3IC. — [FENIX, NSDI'26](https://www.usenix.org/system/files/nsdi26-gao.pdf); [arXiv 2507.14891](https://arxiv.org/pdf/2507.14891)
- **Cascade / escalate-on-uncertainty in commercial gear:** Fortinet sends only "unknown" files to the AI sandbox after AV and threat-intel checks. — [Fortinet ILMPS](https://www.fortinet.com/support/support-services/fortiguard-security-subscriptions/inline-malware-prevention). Palo Alto runs its deep-learning analysis "when content looks suspicious" (Section 3). — [PAN-OS 11.2 content inspection features](https://docs.paloaltonetworks.com/pan-os/11-2/pan-os-release-notes/features-introduced-in-pan-os/content-inspection-features)
- **Lightweight online anomaly detection (Kitsune, NDSS 2018):** incremental statistics per channel plus an ensemble of small autoencoders, scored by reconstruction error. Unsupervised and online. Claimed to perform comparably to offline detectors "even on a Raspberry PI". — [Kitsune, arXiv 1802.09089](https://arxiv.org/pdf/1802.09089); [NDSS PDF](https://www.ndss-symposium.org/wp-content/uploads/2018/02/ndss2018_03A-3_Mirsky_paper.pdf)
- **Sampling hurts:** Cisco warns sampled sFlow may reduce detection accuracy. — [Cisco SNA 7.4.2 guide](https://www.cisco.com/c/dam/en/us/td/docs/security/Analytics/7_4_2_Analytics_Detections_Alerts_Observations_DV_2_2.pdf). SPAN ports can drop packets under load; TAPs are lossless (third party). — [Technologymatch](https://technologymatch.com/blog/darktrace-vs-extrahop-vs-vectra-ai-vs-corelight-ndr-comparison)

### Inferences
- In-network speed comes from shrinking the model to fit the hardware (trees, binary nets), not from making large models fast. The text equivalent is a tiny classifier, not a faster LLM.
- The pattern shared by pForest, Fortinet, Palo Alto and the text cascade below is: **decide cheaply when confident, escalate only when unsure.**

### Gaps
- Kitsune's exact packets/second on the Pi vs a PC was not confirmed (the snippet cut off before the numbers; it was not fetched).
- No verified figures for GPU batching in commercial NDR.

## 3. Palo Alto "inline deep learning": latency figures and how they keep it low

### Takeaway
Palo Alto's own documentation contradicts its "no performance impact" marketing. Cloud inline analysis can add **100–200 ms**. It is governed by a **Max Latency setting (default 200 ms)** with an "Allow on Max Latency" toggle: allow when the limit is hit, or block if unticked. To cut latency they moved the same models **onto the firewall ("Local Deep Learning", PAN-OS 11.2+)**, claiming verdicts "up to 100 times faster than cloud-only". Traffic waits for the verdict up to the cap (hold-and-release with a timeout), not allow-then-revoke.

### Cited Findings
- PAN-OS 12.2 notes: cloud analysis for command injection "can restrict traffic volume and introduce 100–200 milliseconds of latency". — [PAN-OS 12.2 new features](https://docs.paloaltonetworks.com/ngfw/new-features/by-version/panos/12-2)
- Max Latency: "maximum acceptable processing time, in milliseconds, for Inline Cloud Analysis to return a result". "The default value is 200ms." "Allow on Max Latency—Enables the NGFW to take the action of allow, when the maximum latency is reached." "De-selecting this option sets the NGFW action to block." If the cloud FQDN is blocked, "traffic that requires cloud inspection may be dropped." "Log Traffic Not Scanned" records what was skipped. — [Configure Inline Cloud Analysis](https://docs.paloaltonetworks.com/advanced-threat-prevention/administration/configure-threat-prevention/configure-inline-cloud-analysis)
- Local Deep Learning (PAN-OS 11.2+ for C2; 12.2.2+ for command injection): "fast, local deep learning-based analysis of zero-day and other evasive threats", models updated via content updates, verdicts "up to 100 times faster than cloud-only analysis" (vendor claim). Enabled by default on new Vulnerability Protection profiles. Not supported for data exfiltration. VM-Series needs at least 16 GB memory. — [Configure Inline Cloud Analysis](https://docs.paloaltonetworks.com/advanced-threat-prevention/administration/configure-threat-prevention/configure-inline-cloud-analysis)
- PAN-OS 11.2: local analysis runs when content looks suspicious, using the same model as the cloud. Cloud-only analysis can add unwanted latency. — [PAN-OS 11.2 content inspection features](https://docs.paloaltonetworks.com/pan-os/11-2/pan-os-release-notes/features-introduced-in-pan-os/content-inspection-features)
- Marketing: no impact on network performance thanks to a "single-pass, cloud-based" design (vendor claim). — [Palo Alto ATP product page](https://www.paloaltonetworks.com/network-security/advanced-threat-prevention). PAN-OS 10.2 "Nebula" launch claimed "6X faster prevention" and millisecond verdicts (vendor claim). — [What's new in Nebula](https://www.paloaltonetworks.com/network-security/whats-new-in-nebula)
- A reseller blog claims <0.8 µs decisions at 100 Gbps. No official source backs it; treat as unreliable. — [PJ Networks blog](https://pjnetworks.com/precision-ai-in-palo-alto-ngfw-inline-deep-learning-impact/)

### Inferences
- The design maps onto a chat guardrail almost one to one: a hard time budget, an explicit fail-open or fail-closed choice when it runs out, a log of what went unscanned, and a local model that removes the network round trip.
- Neither Palo Alto nor Fortinet claims the full deep model runs on every packet. "Suspicious" pre-filtering is what makes the latency acceptable.

### Gaps
- No public figure for Local Deep Learning's absolute latency (only "up to 100×"), or for the share of traffic flagged suspicious.
- The docs do not explicitly describe the signature-before-ML order or the exact hold mechanics. "Hold until verdict or Max Latency" is inferred from the Max Latency wording.

## 4. Accuracy issues: base rate, false positives, drift, benchmark critiques

### Takeaway
The classic limit on IDS is **false alarms, not detection rate** (Axelsson). When attacks are rare, even a tiny false-positive rate floods operators. ML-IDS papers often report inflated results because of flawed datasets (CIC-IDS2017 has documented labelling and feature-extraction errors) and common methodological pitfalls. Models that score well in-distribution can **collapse on new data**. The same is true for text guardrail classifiers (Section 5).

### Cited Findings
- **Base-rate fallacy:** Axelsson (ACM TISSEC 2000; earlier CCS '99) argues that the false-alarm rate is the limiting factor. A useful P(intrusion | alarm) may require a false-alarm rate that "may sometimes be unattainably low", and a low Bayesian detection rate teaches operators to ignore alarms. — [Axelsson, ACM TISSEC](https://dl.acm.org/doi/pdf/10.1145/357830.357849); revisited in [Base-Rate Fallacy Redux, arXiv 2203.08801](https://arxiv.org/pdf/2203.08801)
- **Sommer & Paxson (IEEE S&P 2010), "Outside the Closed World":** intrusion detection differs from other ML tasks. Misclassification costs are very high, attack examples are scarce, traffic is diverse and shifting, and ML is "rarely employed in operational real world settings". They do not reject ML; they give guidelines. — [Sommer & Paxson PDF](https://www.umiacs.umd.edu/~tdumitra/courses/ENEE657/Fall19/papers/Sommer10.pdf); [ACM DL](https://dl.acm.org/doi/10.1109/SP.2010.25)
- **Arp et al. (USENIX Security 2022), "Dos and Don'ts of ML in Computer Security":** ten pitfalls, including sampling bias, label inaccuracy, data snooping, spurious correlations, inappropriate measures, base-rate fallacy, lab-only evaluation and inappropriate threat model. In 30 top-venue papers, every paper had at least three pitfalls; sampling bias and data snooping were the most common. — [USENIX PDF](https://www.usenix.org/system/files/sec22summer_arp.pdf); [CACM 2024 version](https://cacm.acm.org/research-highlights/pitfalls-in-machine-learning-for-computer-security/)
- **CIC-IDS2017 flaws:** Engelen, Rimmer & Joosen (IEEE SPW 2021) found errors in attack simulation (a misimplemented DoS Hulk attack), flow construction (CICFlowMeter misreads TCP termination), feature extraction, labelling (meaningless artefact flows) and benchmarking (aggregate metrics hide per-class failure). The issues persist in CSE-CIC-IDS2018. — [Engelen et al., IEEE CSDL](https://www.computer.org/csdl/proceedings-article/spw/2021/373200a007/1v56l3jrtGE). Follow-up (Liu, Engelen et al., IEEE CNS 2022): label errors of 6.67% (2017) and 7.53% (2018), over 75% for some attack classes (from search snippet). Lanvin et al. (2023) report misordered packets, incoherent timestamps, duplicated traffic and mislabelled attacks, with significant differences in measured detection performance. — [Lanvin et al.](https://www.researchgate.net/publication/370796116_Errors_in_the_CICIDS2017_Dataset_and_the_Significant_Differences_in_Detection_Performances_It_Makes)
- **Generalisation:** cross-dataset studies show NIDS models trained on one dataset degrade on others. — [Cross-dataset generalization, arXiv 2402.10974](https://arxiv.org/html/2402.10974v1)
- **Same pattern in text guards:** CPU classifiers with F1 of about 0.96 in-distribution fall to 0.11–0.42 F1 on out-of-distribution jailbreaks. 72.2% of OOD attacks got confident benign predictions ("confident miscalibration"). — [Majhi et al., arXiv 2512.19011 v3, Jun 2026](https://arxiv.org/html/2512.19011)
- **Opacity:** autonomous-response systems' opaque decisions complicate compliance and audit. — [arXiv 2507.15676](https://arxiv.org/pdf/2507.15676)

### Inferences
- For student chat, most messages are benign, so a guardrail with even a 1% false-block rate would wrongly stop many ordinary questions. The threshold should be set on measured false positives on real, benign university chat, not on a benchmark F1.
- A cheap classifier's confidence cannot be trusted on new phrasings. Uncertain or out-of-distribution text should escalate, not be auto-allowed on a confident score alone.

### Gaps
- No primary-source figures found for production false-positive rates of commercial NDR (vendors do not publish them).
- Concept drift in NIDS was not covered with a dedicated primary source in this pass.

## 5. Text-analog transfer: tiny text classifiers, measured latency, embedding lookups, cascades for guardrails

### Takeaway
The IDS lessons transfer directly. On commodity CPUs:
- regex and keyword rules: well under 1 ms;
- TF-IDF plus linear SVM: about 3–5 ms;
- fastText: thousands of sentences per second;
- distilled transformer (DistilBERT/MiniLM) through ONNX Runtime: about 6–12 ms;
- 86M-parameter DeBERTa guard: roughly 50–200 ms on CPU.

All of these are 10–300× faster than a 1–2 s LLM call. A **cascade** (rules, then cheap classifier, then LLM only for the uncertain band) was measured to resolve about 80–96% of prompts without the expensive stage. Its weak spot is that cheap models miss new kinds of attack confidently.

### Cited Findings
- **fastText:** "classify half a million sentences among 312K classes in less than a minute" on a multicore CPU (at least about 8,300 sentences/s, derived). Accuracy is "often on par" with deep classifiers of that era. — [Joulin et al., Bag of Tricks, arXiv 1607.01759](https://arxiv.org/abs/1607.01759); [ACL Anthology E17-2068](https://aclanthology.org/E17-2068/)
- **Measured CPU guard classifiers (Majhi et al., arXiv 2512.19011 v3, Jun 2026; listed for USENIX ATC 2026):** batch-1 latency on a 32-core server: SVM word n-gram 3.4 ms ($0.17 per 1M requests), SVM char 4.6 ms, LightGBM 49.4 ms, Random Forest 67.2 ms. GPU (A100): Mamba-130M 24.3 ms, DeBERTa-v3 LoRA 27.5 ms, Gemma-2-2B LoRA 48.5 ms. Mamba on CPU only: 1,696 ms. — [arXiv 2512.19011](https://arxiv.org/html/2512.19011)
- **GuardChain cascade (same paper):** regex (<0.2 ms), then CPU classifier, then GPU model. It escalates when the score is within δ=0.15 of 0.5. Regex alone resolves about 18% (in-distribution). Combined results: in-distribution 80.4% resolved by CPU, 1.9% sent to GPU, F1 0.911, 32.8 ms. Obfuscated: 91.7% CPU, 3.8% GPU, F1 0.942. OOD: 20.3% escalated, F1 0.573, 42.8 ms, $3.58/1M vs $6.80/1M GPU-only. Caveats: the cascade's in-distribution F1 (about 0.91) is below LightGBM alone (0.968); the OOD test set is 97% malicious; no explicit false-positive rates are given. The authors say GPU guards are "unnecessary for the majority of traffic". — [arXiv 2512.19011](https://arxiv.org/html/2512.19011)
- **Off-the-shelf small guards:** Meta's Prompt Guard 2 model card gives 92.4 ms per classification on an A100 at 512 tokens for the 86M models. English recall at 1% FPR: 21.2% (v1) vs 97.5% (v2). A 22M variant (DeBERTa-xsmall) exists for lower latency. — [Llama-Prompt-Guard-2-86M model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M). Meta publishes no CPU latency (noted by a competitor). — [jailguard PyPI](https://pypi.org/project/jailguard/). A third-party guide claims 50–200 ms on a 4-core CPU (unverified conditions). — [Orchestra-Research skill guide](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/main/07-safety-alignment/prompt-guard/SKILL.md). The 2512.19011 paper measured PromptGuard-86M at about 14.4 ms on GPU, with a 95% false-positive rate on its D1 set and failure on obfuscated data (F1 0.085). — [arXiv 2512.19011](https://arxiv.org/html/2512.19011). LlamaFirewall says PromptGuard 2 is small enough for real-time local CPU or GPU use. — [LlamaFirewall, arXiv 2505.03574](https://arxiv.org/pdf/2505.03574)
- **ONNX / transformers.js latency:** a fine-tuned DistilBERT on native ONNX Runtime CPU: 5.66 ms p50 (tokenisation included), vs 8.95 ms in PyTorch. INT8 was slightly slower (6.14 ms). — [SaiArrow inference-lab](https://github.com/SaiArrow/inference-lab). The same DistilBERT about 6 ms native vs about 58 ms in browser WASM (about 10×). — [DEV Community: quantizing DistilBERT to ONNX](https://dev.to/fuxionixt/what-i-learned-quantizing-distilbert-to-onnx-for-browser-inference-5fok). MiniLM-L6 (q8) in transformers.js/WASM: median 12.2 ms (p95 14.4 ms), about 81 items/s; WebGPU was slower for single sentences (173 ms). — [browser-runtimes-bench](https://github.com/delcenjo/browser-runtimes-bench/blob/main/README.md)
- **Embedding-similarity lookups against known-bad examples:** no primary source with measured latency was found in this pass. The MiniLM embedding figure above (about 12 ms per item in WASM) gives the embedding cost. A cosine search over a few thousand stored vectors is extra (not measured here).

### Inferences
- For the Hub, a **Palo Alto-style cascade** fits:
  1. Deterministic checks first (PII regex for emails, phone numbers and IDs; a word list), under 1 ms.
  2. A local small classifier (TF-IDF+SVM or a quantised MiniLM/DistilBERT via `onnxruntime-node`), roughly 5–15 ms on CPU.
  3. Only messages in the uncertain band (the paper saw about 2–20%) go to Haiku at 1–2 s, under a **hard time budget** with an explicit fail-open/fail-closed rule and a "not scanned" log.
- An IDS-style **out-of-band** path also transfers: deliver low-risk replies immediately, and run the LLM check in parallel for audit and follow-up. This is the NDR "detect then respond" model. It is only acceptable for content where a few seconds of exposure is tolerable, so it should not be used for clearly harmful categories.
- Native `onnxruntime-node` should land near the about 6 ms native figure rather than the WASM figure. This is an inference; it was not measured in Node here.
- Small classifiers fail on new phrasings, like IDS models across datasets. Benign-traffic false-positive rates must be measured on the project's own chat samples before trusting any threshold.

### Gaps
- No Node.js (`onnxruntime-node` / transformers.js in Node) latency benchmark for a toxicity or PII classifier was found. It must be measured locally.
- No measured source for embedding kNN guardrail latency or accuracy.
- Not covered: off-the-shelf toxicity classifiers' (e.g. Detoxify-style) accuracy and false-positive rates on student-style text.
- The remaining third of arXiv 2512.19011 (appendix with Llama-Guard-3-1B / ShieldGemma / WildGuard latencies) was not read.
