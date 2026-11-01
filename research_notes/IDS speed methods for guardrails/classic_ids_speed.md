# How classic IDS/IPS engines (Snort 3, Suricata, Zeek) keep up with line rate, and what transfers to a Node.js chat guardrail

Research date: Friday, Oct 30, 2026. Sources are official docs (Snort 3 reference/user manuals, Suricata "latest" docs, Zeek "master" docs), the Hyperscan NSDI'19 paper, and vendor or community benchmarks (marked as such). Snort manual text quoted here comes from the PDFs at snort.org/downloads/snortplus/ (the user manual header says version 3.1.82.0, so parts may lag the current 3.x release).

Context for the reader: the guardrail screens chat messages under 4 KB in a single Node.js process (the "University Hub"). An IDS scans gigabits per second of mostly harmless traffic. The two settings differ by many orders of magnitude, and that difference drives most of the "does it transfer" judgments below.

## 1. Pipeline: decode, normalize, MPM prefilter, then full rule evaluation

### Takeaway
Snort 3 and Suricata both use the same two-stage design. Rules are grouped, and one literal per rule (the "fast pattern") goes into a single multi-pattern automaton that scans each buffer once. Only rules whose fast pattern hits get the costly option-by-option check (PCRE, byte tests, distance and within checks), and that check stops at the first option that fails. Hyperscan's authors argue the design works because "most input traffic is innocent". They measured that choosing the literals automatically cuts regex invocations "by over two orders of magnitude" compared with hand-picked `content` keywords. I found no published figure for what share of packets reach full evaluation.

### Cited Findings
**Snort 3**
- "Snort evaluates rules in a two-step process which includes a fast pattern search and full evaluation of the signature." — [Snort 3 User Manual §2.7](https://snort.org/downloads/snortplus/snort_user.pdf)
- Rule groups: "When Snort starts or reloads configuration, rules are grouped by protocol, port and service… These rule groups are compiled into multipattern search engines (MPSE) which are designed to search for all patterns with just a single pass through a given packet or buffer." — [Snort 3 User Manual §2.7.1](https://snort.org/downloads/snortplus/snort_user.pdf)
- Engine choice: `search_engine.search_method` "defaults to ac_bnfa, which balances speed and memory. For a faster search at the expense of significantly more memory, use ac_full. For best performance and reasonable memory, download the hyperscan source from Intel." The options are `ac_bnfa | ac_full | hyperscan | lowmem`. — [Snort 3 User Manual §2.7.1](https://snort.org/downloads/snortplus/snort_user.pdf); [Snort 3 Reference](https://snort.org/downloads/snortplus/snort_reference.pdf)
- Fast pattern selection: "Snort will by default choose the longest pattern in the rule since that is likely to be most unique. That is not always the case… The ideal fast pattern is one which, if found, is very likely to result in a rule match. Fast patterns that match frequently for unrelated traffic will cause Snort to work hard with little to show for it." — [Snort 3 User Manual §2.7.2](https://snort.org/downloads/snortplus/snort_user.pdf)
- Some contents can't be fast patterns. A negated content is excluded "if it is also relative to another content, case sensitive, or has non-zero offset or depth". — [Snort 3 User Manual §2.7.2](https://snort.org/downloads/snortplus/snort_user.pdf)
- Rule evaluation: "For each fast pattern match, the corresponding rule(s) are evaluated left-to-right. Rule evaluation requires checking each detection option in a rule and is a fairly costly process which is why fast patterns are so important. Rule evaluation aborts on the first nonmatching option." — [Snort 3 User Manual §2.7.3](https://snort.org/downloads/snortplus/snort_user.pdf)
- "Fast pattern only": "When rule evaluation takes place, the fast pattern match will automatically be skipped if possible. Note that this differs from Snort 2 which provided the fast_pattern:only option." — [Snort 3 User Manual §2.7.3](https://snort.org/downloads/snortplus/snort_user.pdf); [Snort 3 rule docs: fast_pattern](https://docs.snort.org/rules/options/payload/fast_pattern)
- Some buffers can't hold fast-pattern contents (`http_raw_cookie`, `http_param`, `http_raw_body`, `http_true_ip`). — [Snort 3 rule docs: fast_pattern](https://docs.snort.org/rules/options/payload/fast_pattern)
- Queue limits: `search_engine.max_queue_events = 5` ("maximum number of matching fast pattern states to queue per packet") and `search_engine.queue_limit = 0` (unlimited). A counter, `search_engine.total_overruns`, counts "fast pattern matches discarded due to overflow". Other counters are `searched_bytes`, `total_inserts` (fast pattern hits), `qualified_events` and `non_qualified_events`. These are how operators measure prefilter hit rates on their own traffic. — [Snort 3 Reference, search_engine](https://snort.org/downloads/snortplus/snort_reference.pdf)
- `detection.hyperscan_literals` (default false) means "use hyperscan for content literal searches instead of boyer-moore". In other words, Snort 3 also uses Hyperscan for the single-literal checks in the second stage, and `regex` is a "rule option for matching payload data with hyperscan regex; uses pcre syntax". Counter `pcre.pcre_to_hyper` = "total pcre rules by hyperscan engine". — [Snort 3 Reference](https://snort.org/downloads/snortplus/snort_reference.pdf)
- `search_engine.split_any_any = true`: "evaluate any-any rules separately to save memory". — [Snort 3 Reference](https://snort.org/downloads/snortplus/snort_reference.pdf)

**Suricata**
- "Only one content of a signature will be used in the Multi Pattern Matcher (MPM)." When there are several, "Suricata uses the 'strongest' content", which is "a combination of length, how varied a content is, and what buffer it is looking in… Generally, the longer and more varied the better." — [Suricata docs: Prefiltering keywords](https://docs.suricata.io/en/latest/rules/prefilter-keywords.html)
- Manual override example: `"User-Agent|3A|"` would be chosen automatically, but "'User-Agent:' will be a match very often" while "'Badness' appears less often", so the rule writer puts `fast_pattern;` on the rarer string. — [Suricata docs: Prefiltering keywords](https://docs.suricata.io/en/latest/rules/prefilter-keywords.html)
- `fast_pattern:only`: when a rule has only one content, an MPM hit means "the whole signature matches", and "Suricata notices this automatically". `fast_pattern:offset,length` ("chop") feeds only part of a content to the MPM. Note: the docs' chop example (`"aaaaaaaaabc"; fast_pattern:8,4;`) doesn't add up, since offset 8 leaves only 3 bytes. — [Suricata docs: Prefiltering keywords](https://docs.suricata.io/en/latest/rules/prefilter-keywords.html)
- The `prefilter` keyword lets non-content checks act as prefilters too, for example `ttl:123; prefilter;` makes "the TTL test… used in prefiltering instead of the single byte pattern". — [Suricata docs: Prefiltering keywords](https://docs.suricata.io/en/latest/rules/prefilter-keywords.html)
- `mpm-algo`: "ac, hs and ac-ks… On x86_64 hs (Hyperscan) should be used for best performance." Detect profiles: `high` ("good performance and more use of memory"), `medium` (default), `low`. `sgh-mpm-context: auto` picks full (one MPM context per signature group) or single (shared). "ac" uses single. — [Suricata docs: suricata.yaml](https://docs.suricata.io/en/latest/configuration/suricata-yaml.html)
- Suppress rules cost more than they look: "the suppression is only considered post-matching". — [Suricata docs: Ignoring traffic](https://docs.suricata.io/en/latest/performance/ignoring-traffic.html)

**Why prefiltering works (Hyperscan paper)**
- "The de-facto best practice of high-performance DPI generally employs multi-string pattern matching as a pre-condition for expensive regex matching… multi-string matching is known to outperform multi-regex matching by two orders of magnitude, and most input traffic is innocent, making it more efficient to defer a rigorous check." — [Wang et al., Hyperscan, NSDI'19, p.631](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- The paper names three weaknesses of classic prefiltering: (1) the keywords are hand-picked ("Manual choice does not scale… improper keywords would waste CPU cycles on redundant regex matching"); (2) the literal is matched twice, once as a trigger and again inside the regex; (3) a whole regex compiled to one automaton may be too big for a DFA, forcing a slower NFA. — [Hyperscan NSDI'19](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Measured effect: on ET-Open 2.9.0 and Talos 2.9.11.1 against a real traffic trace, automatic literal extraction "dramatically reduces the number of regex matching invocations by over two orders of magnitude". The authors blame "many single-character strings in the content option of the Snort rulesets, which invokes redundant regex matching too frequently". — [Hyperscan NSDI'19 §6.2, Tables 3–4](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- When the prefilter fails because the literals really are present, the cost goes up. Hyperscan's own history says that in v2.0, "if prefiltering failed (i.e., when the string factors were all present), it ended up consuming more CPU cycles than naïvely performing the NFA engines over all the input". — [Hyperscan NSDI'19 §8 history](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)

### Inferences
- **Transfers well.** The guardrail should be "one pass, many literals, then confirm". Compile every trigger literal (PII cue words, offensive lexicon terms, harmful-intent phrases, digit-run shapes) into one multi-pattern scan. Run the costly validators (Luhn, SSN area rules, proximity windows, any model call) only for categories whose literal hit. This is the same as Snort's "rule group → MPSE → evaluate only hit rules, abort on first failing option".
- **Pick fast patterns for rarity, not length.** Both engines' docs say the longest literal is often not the rarest. For chat, "ssn" or "social security" is a better trigger than a common word like "number". Frequent-but-harmless triggers are the main cost driver ("work hard with little to show for it").
- **Measure the hit rate.** Copy Snort's `total_inserts` / `qualified_events` idea: count how often each trigger fires and how often the full check confirms it. A trigger with a low confirm rate is a bad fast pattern.
- **Scale check.** A 4 KB message is about the size of 2–3 network packets. Even a slow JS regex pass over 4 KB takes far less than a millisecond in typical cases. Prefiltering here mainly keeps the costly second stage (model calls, many regexes) rare. Raw scan speed matters much less.

### Gaps
- I found no recent published measurement of what fraction of packets/buffers reach full rule evaluation in Snort 3 or Suricata on real traffic. The NSDI'19 tables report regex invocation counts (relative), not packet shares. Operators get this from their own `search_engine.*` (Snort) or rule-profiling (Suricata) counters.
- I did not fetch Suricata's "Fast Pattern Determination Explained" appendix (the exact strength formula).

## 2. Inline IPS vs passive IDS: latency budgets and overload handling

### Takeaway
Inline engines put hard per-packet and per-rule time caps on themselves. Snort 3's `latency` module defaults both to **500 µs**, and it can "fastpath" (stop inspecting) a packet or suspend a slow rule. Suricata's exception policies decide fail-open or fail-closed under memory pressure or parser errors. Its default is **fail-closed (drop) in IPS mode** and **ignore in IDS mode**. Commercial NGFWs advertise single-digit-microsecond device latency (vendor figures, not independent). Both engines also stop inspecting flows that are already judged or uninteresting ("bypass").

### Cited Findings
**Snort 3 latency module (successor to Snort 2's PPM)**
- `latency.packet.max_time = 500`: "set timeout for packet latency thresholding (usec)". `latency.packet.fastpath = false`: "fastpath expensive packets (max_time exceeded)". — [Snort 3 Reference, latency](https://snort.org/downloads/snortplus/snort_reference.pdf)
- `latency.rule.max_time = 500`: "set timeout for rule evaluation (usec)". `latency.rule.suspend = false`: "temporarily suspend expensive rules". `latency.rule.suspend_threshold = 5`: "number of timeouts before suspending a rule". `latency.rule.max_suspend_time = 30000` ms ("0 means permanently disable rule"). — [Snort 3 Reference, latency](https://snort.org/downloads/snortplus/snort_reference.pdf)
- Alerts: `134:1` "rule tree suspended due to latency", `134:2` "rule tree re-enabled after suspend timeout", `134:3` "packet fastpathed due to latency". Counters: `latency.packet_timeouts`, `latency.rule_eval_timeouts`, `latency.rule_tree_enables`. — [Snort 3 Reference, latency](https://snort.org/downloads/snortplus/snort_reference.pdf)
- Snort 2 PPM (the predecessor) "does not provide a hard and fast latency guarantee but should in effect provide a good average latency control". The suggested `max-pkt-time` starting values were "100/250/1000 for 1G/100M/5M nets" (µs). Without the action flags (`fastpath-expensive-packets`, `suspend-expensive-rules`), PPM only counts. — [Snort README.ppm](https://www.snort.org/faq/readme-ppm)
- `stream_reassemble` rule option with `fastpath`: "optionally trust the remainder of the session" (a rule can declare the rest of a flow safe). — [Snort 3 Reference](https://snort.org/downloads/snortplus/snort_reference.pdf)

**Suricata exception policies (fail-open vs fail-closed)**
- Policies: `drop-flow`, `drop-packet`, `reject`/`rejectboth`, `bypass` ("No further decoding or parsing is done"; can be offloaded), `pass-flow` (detection off, but "stream reassembly, app-layer parsing and logging still happen"), `pass-packet`, `ignore`. `auto` = "drop-flow or drop-packet… in IPS mode, and ignore in IDS mode". — [Suricata docs: Exception policies](https://docs.suricata.io/en/latest/configuration/exception-policies.html)
- Triggers: stream/reassembly/flow/defrag memcaps, midstream pickup, and app-layer parser errors. Triggered policies are logged in flow records (`exception_policy`). — [Suricata docs: Exception policies](https://docs.suricata.io/en/latest/configuration/exception-policies.html)
- Default in IPS: most policies fail closed. Midstream defaults to ignore if midstream flows are accepted. The master switch can be set to `ignore` to turn off the fail-closed default. — [Suricata docs: Exception policies](https://docs.suricata.io/en/latest/configuration/exception-policies.html)

**Bypass / shunting**
- Local bypass: Suricata still decodes and looks up the flow, but "if the corresponding flow is local bypassed then it simply skips all streaming, detection and output". Capture bypass puts the flow in the kernel (AF_PACKET: "an element in an eBPF hash table stored in kernel"; NFQ: a mark). NIC bypass uses XDP, which "can process the traffic prior to reaching the kernel". — [Suricata docs: Ignoring traffic](https://docs.suricata.io/en/latest/performance/ignoring-traffic.html)
- Pass rules "pass the packet and in case of TCP the rest of the flow", and Eve logs are still written. — [Suricata docs: Ignoring traffic](https://docs.suricata.io/en/latest/performance/ignoring-traffic.html)
- Encrypted-traffic bypass: TLS/QUIC/SSH `encryption-handling: bypass` means "Suricata bypasses flows once the handshake is completed and encrypted traffic is detected". — [Suricata docs: Ignoring traffic](https://docs.suricata.io/en/latest/performance/ignoring-traffic.html)
- Elephant-flow handling by depth: stream reassembly depth "by default… is 1MB". The `stream.bypass` option "activates 'bypass' for a flow/session when either side of the session reaches its depth", with the warning "`bypass` can lead to missing important traffic. Use with care." — [Suricata docs: suricata.yaml](https://docs.suricata.io/en/latest/configuration/suricata-yaml.html)
- Zeek's shunting (via NetControl) can "stop forwarding a uni-directional flow of packets to Zeek", which saves resources on benign traffic. — [Zeek docs: NetControl](https://docs.zeek.org/en/master/frameworks/netcontrol.html)

**Inline latency budgets (vendor-reported)**
- Fortinet says NSS Labs' 2017 NGFW test measured 18.5 Gbps and "an average latency of 4.6 microseconds". NSS NGFW tests run with the security policy on, but this is the vendor's summary, not the report itself. — [Fortinet: NSS Labs page](https://www.fortinet.com/corporate/about-us/product-certifications/nss-labs)
- Fortinet brief: FortiGate 3700D/3800D "average latency below five µs", under 2 µs for 64–256-byte frames. The excerpt doesn't say which features were on. — [Fortinet: Deterministic Performance brief](https://www.fortinet.com/content/dam/fortinet/assets/solution-guides/sb-deterministic-performance-for-high-speed-security.pdf)
- Cloud firewall for comparison: Azure Firewall latency "ranges from 1 ms to 10 ms, depending on the Firewall SKU and deployment size". — [Microsoft Learn: Azure Firewall monitoring reference](https://learn.microsoft.com/en-us/azure/firewall/monitor-firewall-reference)

### Inferences
- **Transfers directly: time budgets with a defined fallback.** Give the guardrail a per-message budget and a per-check budget, as Snort does (500 µs defaults). Count timeouts per check and auto-suspend a check that keeps timing out (Snort: 5 timeouts → suspend for 30 s, with an alert). For a chat gateway, a realistic deterministic-stage budget is around 1 ms. The microsecond budgets are for packet hardware and don't apply.
- **Choose fail-open vs fail-closed per check and per direction, on purpose and in the config.** Suricata's model (`auto` = drop in IPS, ignore in IDS; logged with `exception_policy`) maps well. Possible split: outbound PII leak check = fail-closed (hold the reply), offensive-language check on a student message = fail-open but log, model-based intent check timing out = fail-open with an async follow-up. Always record which policy fired.
- **Bypass ≈ "already decided" fast path.** The chat version is "skip the costly checks once a conversation is judged". Unlike network flows, though, each chat message is new content. Only cheap checks are safe to skip based on earlier verdicts (see §3).
- **Inline vs passive.** The Hub can split the same way IPS and IDS do. Cheap deterministic checks run inline (they block). Costly or probabilistic checks (model judgment) run out of band after delivery and raise alerts or follow-up actions, like Zeek (see §5). The owner's latency worry is mostly about the model-based part. Moving it out of band trades latency for "detect after the fact".

### Gaps
- No independent 2025–2026 test report found giving inline IPS latency with full IPS on and off. NSS Labs closed in 2020; CyberRatings/NetSecOPEN reports were not reached.
- I did not fetch Suricata's packet/rule profiling docs (ticks-based rule profiling), so its exact output fields are not cited here.

## 3. Verdict caching, flow-level decisions, reputation lookups

### Takeaway
Both engines decide once per flow wherever they can. A pass rule, bypass, or "trust the remainder of the session" removes the rest of the flow from detection, sometimes all the way down into the kernel eBPF map or the NIC (XDP). Zeek's NetControl applies the same idea with timed blocks ("catch and release"). These are hash-table lookups keyed on the flow 5-tuple or an address.

### Cited Findings
- Flow-level pass: "Pass rules… pass the packet and in case of TCP the rest of the flow." — [Suricata docs: Ignoring traffic](https://docs.suricata.io/en/latest/performance/ignoring-traffic.html)
- Bypass decisions live in a flow-keyed table: local bypass checks the flow table. Capture bypass adds "an element in an eBPF hash table stored in kernel". — [Suricata docs: Ignoring traffic](https://docs.suricata.io/en/latest/performance/ignoring-traffic.html)
- Suricata's `autofp` hash scheduler uses "the 5-7 tuple hash", which is "the same hash used to store flows in memory". — [Suricata docs: Runmodes](https://docs.suricata.io/en/latest/performance/runmodes.html)
- Snort `stream_reassemble ... fastpath`: "optionally trust the remainder of the session". — [Snort 3 Reference](https://snort.org/downloads/snortplus/snort_reference.pdf)
- Zeek NetControl: drop connection (by 5-tuple), drop address, shunt flow. "Catch and release" blocks briefly and re-blocks "immediately… (for a longer amount of time), if it is seen reappearing". — [Zeek docs: NetControl](https://docs.zeek.org/en/master/frameworks/netcontrol.html)
- Snort 3 has a `reputation` inspector (paths configured in the manual). — [Snort 3 User Manual](https://snort.org/downloads/snortplus/snort_user.pdf)

### Inferences
- **Transfers, with care.** Useful O(1) maps in Node: (a) a content-hash cache, `sha256(normalized text) → verdict`, so the same message (retry, duplicate send, the Hub's own `chatLedger` repeats) is never re-screened. This matches the Hub's existing dedupe by `(contextId, messageId)`. (b) A per-sender or per-conversation state such as "flagged, extra checks on" or "trusted, skip the optional model check". (c) Blocklists in a `Set`/`Map` (known-bad phrases, hashes of known abusive messages).
- **Big difference from network flows.** A network flow's later packets often add nothing new after the decision (encrypted payload, bulk file). Each chat message is new user content, so "decide once per conversation and skip" would let PII or abuse through in message #2. Use flow-level state only to *raise* scrutiny, or to skip optional costly checks. Never skip the cheap mandatory PII and offensive-literal pass.
- Catch-and-release maps to growing cool-downs for repeat offenders.

### Gaps
- I did not retrieve Snort 3 reputation/IP-list internals (data structure, lookup cost) or Suricata's IP reputation / dataset (`dataset`, `iprep`) docs, so the "O(1)" property is asserted from the hash-table design described above, not from a cited benchmark.

## 4. Parallelism: runmodes, flow affinity, AF_PACKET, per-core throughput

### Takeaway
Suricata's `workers` mode (one thread runs the full pipeline, with the NIC/kernel hashing flows to threads) "generally… performs the best". `autofp` adds a queue hop and is for pcap and NFQ IPS. Snort 3 runs independent packet threads (`-z`). Real-world per-core throughput with full rulesets is roughly **0.5–1 Gbps per core** (community and vendor data, varies a lot). One DPDK developer cites around 1 M packets/s per worker.

### Cited Findings
- Workers: "Generally, the `workers` runmode performs the best… Each packet processing thread then contains the full packet pipeline", with traffic spread across threads by the NIC/driver. Autofp: "For processing PCAP files, or in case of certain IPS setups (like NFQ)". Capture/decode threads pass packets to "flow worker" threads. — [Suricata docs: Runmodes](https://docs.suricata.io/en/latest/performance/runmodes.html)
- Flow affinity: `autofp-scheduler: hash` (default) uses the 5–7-tuple hash so a flow's packets stay on one thread. Other options are `ippair` and `ftp-hash` (keeps FTP control and data together so "there is no concurrency issue"). — [Suricata docs: Runmodes](https://docs.suricata.io/en/latest/performance/runmodes.html)
- `max-pending-packets` sets "the number of packets you allow Suricata to process simultaneously". — [Suricata docs: suricata.yaml](https://docs.suricata.io/en/latest/configuration/suricata-yaml.html)
- Snort 3: "You can process multiple sources at one time by using the -z or --max-threads option". Output is per packet thread ("If you run 4 packet threads with u2 output, you will get 4 different u2 files"). — [Snort 3 User Manual](https://snort.org/downloads/snortplus/snort_user.pdf)
- 100 Gbps community deployment: Intel E810, 28 queues mapped 1:1 to 28 workers, bursts "up to 64Gbps and averaging 30Gbps with minimal drops" (about 1.1 Gbps per worker average). — [Suricata forum](https://forum.suricata.io/t/suricata-ids-on-100gbps-link-via-af-packet-and-an-intel-e810-cqda2-with-ice-driver/4892)
- Vendor (Napatech, marketing): Dell R740, ET ruleset of 12,712 signatures, 40 cores / 80 threads, standard NIC peaks at 34.8 Gbps (about 0.87 Gbps per physical core). Their Intel app note gives a lossless standard-NIC rate of 6 Gbps at 40 threads and 15 Gbps at 80. — [Napatech solution description](https://www.napatech.com/support/resources/solution-descriptions/4x-suricata-performance-increase-for-napatech/); [Napatech/Intel app note](https://www.napatech.com/Intel/Napatech-Intel-AppNote-Suricata_v1.0.html)
- SEPTun (community tuning guide): sustained 20 Gbps on dual Xeon E5 with AF_PACKET, core isolation and similar tuning. — [Suricata Extreme Performance Tuning](https://www.academia.edu/33882347/Suricata_Extreme_Performance_Tuning)
- DPDK-Suricata developer: "each worker thread around 1 million packets per sec". — [GitHub issue, dpdk_suricata](https://github.com/vipinpv85/dpdk_suricata-4_1_1/issues/2)
- Hyperscan in Snort (NSDI'19): stock Snort (AC + PCRE) reached 113 Mbps on a real web traffic trace with the Talos ruleset. Hyperscan-ported Snort reached 986 Mbps (8.73×), single-threaded. — [Hyperscan NSDI'19 §6.4](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)

### Inferences
- **Per-core numbers put chat screening in context.** About 1 Gbps per core is about 125 MB/s of full-ruleset inspection, which is about 30,000 4-KB messages per second per core in C with SIMD. A JS implementation will be slower, but the Hub's message rate (students typing) is many orders of magnitude lower. CPU throughput is not the risk. Tail latency from a slow check, regex blowup, or a model call is.
- **Flow affinity transfers as "per-conversation ordering".** Keep one conversation's checks in order (like same-flow-same-thread) so a verdict for message N doesn't race message N+1. In Node's single event loop this happens for free unless checks move to worker threads.
- **Worker threads.** Node `worker_threads` resemble the workers runmode, but message passing costs tens of µs or more. For under-4 KB synchronous scans that is likely more than the scan itself. Use workers only for costly CPU checks, or to keep a pathological regex from blocking the event loop.

### Gaps
- No official Snort 3 or Suricata per-core benchmark from OISF/Cisco Talos was found. The per-core figures come from vendor and community sources (flagged). Secondary 2026 blog figures (tech-insider, secopblueprint) were seen in search results but not verified, so they are excluded.

## 5. Zeek: event-driven, asynchronous, alert after the fact

### Takeaway
Zeek is a passive analyzer. A C++ event engine turns packets into "policy-neutral" protocol events. A script interpreter runs event handlers that hold state and apply site policy. Any blocking is done later by external devices through NetControl (switches, routers, OpenFlow) after something is seen and the backend confirms. It is the model for "don't block the message, analyze it and react".

### Cited Findings
- The core "reduces the incoming packet stream into a series of higher-level events". The pipeline covers "input sources, packet analysis, session analysis, and file analysis". — [Zeek docs: Architecture](https://docs.zeek.org/en/master/about/architecture.html)
- Events "describe what has been seen, but not why, or whether it is significant". For example `http_request` "does not convey any further interpretation, such as whether that URI corresponds to a known malware site". — [Zeek docs: Architecture](https://docs.zeek.org/en/master/about/architecture.html)
- The script interpreter "executes a set of event handlers written in Zeek's custom scripting language". "All of Zeek's default output comes from scripts". Scripts "maintain state over time" across connections and hosts. — [Zeek docs: Architecture](https://docs.zeek.org/en/master/about/architecture.html)
- NetControl hides "the complexity of heterogeneous network equipment behind a simple task-oriented API". Rules go to backends (OpenFlow, Broker, acld). The lifecycle runs REQUESTED → SUCCEEDED, and `rule_added` fires only when a backend confirms. The `rule_policy` hook is "processed immediately". Rules can target the "forward path" or only the "monitor path". — [Zeek docs: NetControl](https://docs.zeek.org/en/master/frameworks/netcontrol.html)

### Inferences
- **Transfers well as the second layer.** The Hub already has a telemetry stream of real events. A Zeek-style design would run the slow, judgment-based checks (harmful intent, nuanced offensiveness) as handlers on "message delivered" events. A positive result triggers a follow-up action (retract or flag the message, notify staff, raise scrutiny for that conversation), not a pre-delivery hold.
- **Trade-off to state plainly.** After-the-fact analysis means a harmful reply may be seen before it is flagged. For outbound PII (a leak can't be undone), an inline check is needed. For intent and tone it may be acceptable, since that is the Zeek model.
- **Policy-neutral events + separate policy** maps to the guardrail emitting neutral facts (`pii_candidate{type:'card', luhn:true}`) and a separate policy layer deciding block, redact or log. This keeps policy changes cheap, like editing Zeek scripts.

### Gaps
- Zeek cluster architecture (manager/logger/proxy/worker, load balancing) and performance figures were not fetched.

## 6. Hyperscan: streaming mode, literal factoring, regex vs literal cost

### Takeaway
Hyperscan breaks each regex into required literals plus small automata, runs one SIMD multi-literal pass first, and runs the automata only when their literals line up. That decomposition, not just SIMD, gives the big wins: regex invocations drop by more than 100× compared with hand-picked content keywords, and it is 24.8×–40.1× faster than PCRE single-pattern. Streaming mode scans data in chunks with a fixed, compile-time-sized state, so patterns that span packets match without buffering old data.

### Cited Findings
- Decomposition: Hyperscan "splits a regex pattern into a series of disjoint string and FA components". Extracted strings "are pre-requisite for the rest of regex matching". "String matching is run as a part of regex matching rather than being employed only as a trigger". "FA component matching is executed only when all relevant string and FA components are matched". Decomposed FAs "tend to be small, so they are more likely to be able to be converted to a DFA". — [Hyperscan NSDI'19 §1](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- "87% to 94% of the regex rules in IDSes have at least one extractable string." Table 1: "97.2% to 99.2% of decomposable real-world regex rules benefit from dominant path" analysis (Snort Talos May 2015, ET-Open 2.9.0, Suricata 4.0.4 rulesets). — [Hyperscan NSDI'19 §3, §4](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- SIMD multi-string matcher (bucketed shift-or, extending DFC's two-stage filter/verify) "outperforms state-of-the-art multi-string matching by a factor of 1.3 to 2.5". DFC itself beat Aho-Corasick by 2–3.6×. AC "suffers from frequent cache misses due to large memory footprint and random memory access pattern" and one-byte-at-a-time dependency stalls. — [Hyperscan NSDI'19 §1–2](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Regex speed (Table 5; 1,300 Snort Talos regexes, 2,800 Suricata regexes; PCRE 8.41 JIT, PCRE2 10.32 JIT, RE2 2018-09-01). Talos: Hyperscan single-regex beats PCRE / RE2 / PCRE2 by 40.1× / 10.3× / 2.3×. Multi-regex Hyperscan is 13.5× faster than RE2 multi and 183.3× faster than PCRE2. Suricata: 24.8× / 9.1× / 1.8× single; 8.4× vs RE2-m and 6.9× vs PCRE2 multi. — [Hyperscan NSDI'19 §6.3](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- End to end: Snort 113 Mbps → 986 Mbps (8.73×) on real web traffic. "The main contributor for performance improvement is the highly-efficient multi-string matcher." — [Hyperscan NSDI'19 §6.4](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Literal vs regex cost: multi-string matching outperforms multi-regex matching "by two orders of magnitude". Restructured automata such as XFA take "multiple tens to hundreds of CPU cycles per input byte, which is slower than a normal DFA by one or two orders of magnitude". — [Hyperscan NSDI'19 §1–2](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Streaming: Hyperscan 2.0 "supported 'streaming' – scanning multiple blocks without retaining old data and with a fixed-at-pattern-compile-time amount of stream state… especially desirable for network traffic monitoring as patterns may spread over multiple packets". Older versions had a hard limit of 512 NFA states, beyond which code was "extremely slow". — [Hyperscan NSDI'19 §8](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Hybrid with PCRE for unsupported syntax (back-references, capture): Hyperscan prefilters, then calls PCRE to confirm. — [Hyperscan NSDI'19 §8](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Snort 3 uses Hyperscan for MPM (`search_method = hyperscan`), literals (`hyperscan_literals`), `regex`, and `sd_pattern` (sensitive data, the Snort DLP option; counter `sd_pattern.terminated`). It requires "hyperscan >= 4.4.0". — [Snort 3 Reference](https://snort.org/downloads/snortplus/snort_reference.pdf)

### Inferences
- **Streaming mode mostly doesn't transfer.** Messages under 4 KB are whole when screened, so "block mode" (scan the full buffer) is the right model. Streaming matters only if the Hub screens model output *while it streams* (token streaming is out of scope per CLAUDE.md). The idea that does transfer is to screen the whole reply before release, not chunk by chunk.
- **Literal factoring transfers as a design rule, without Hyperscan.** For each regex, pull out its required literal and test the literal first (one combined literal scan, or `String.prototype.includes` / a single alternation `RegExp`). Run the regex only when the literal is present. V8's Irregexp is a backtracking engine like PCRE, so the classic IDS lesson applies: regex is the costly part and must be gated. Avoid patterns that can backtrack catastrophically (nested quantifiers). The A2UI renderer in this project already rejects regexes its ReDoS detector flags.
- **Hyperscan in Node.** Native bindings exist (e.g. `hyperscan` npm wrappers, Vectorscan for ARM), but they add a native dependency and need x86 SIMD or the Vectorscan port. For under-4 KB messages and a ruleset of hundreds of patterns, a pure-JS Aho-Corasick or one combined `RegExp` is likely fast enough. This is an inference, not measured here. A micro-benchmark on the Hub's real lexicon would settle it.
- **Snort `sd_pattern` is the closest IDS precedent** for the guardrail's PII check (Hyperscan-backed sensitive-data patterns inside the IPS). The earlier DLP report covers its validation logic.

### Gaps
- No measured numbers found for Hyperscan via Node bindings, or for V8 regex vs a JS Aho-Corasick on 4 KB inputs. A local micro-benchmark is needed.
- Hyperscan's current status (Intel moved later releases to a closed license in 2024; the Vectorscan fork continues open source) was not verified in this session. Treat it as unconfirmed.
