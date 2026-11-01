# Deterministic detection of sensitive data and blocked content (efficient, low false positives)

Researched 2026-10-30. Sources are mostly primary (vendor docs, the Hyperscan NSDI paper, GitHub issues, npm registry). One section reports a small local micro-benchmark I ran myself; it is labelled as such and is not a primary source.

## How DLP products structure detection: prefilters, keyword proximity, confidence levels (instead of running every check)

### Takeaway
Production DLP and secret scanners do not run every validator on every input. They use a layered recipe: a cheap trigger (a literal keyword, prefix, or a loose pattern found in one pass over the text) decides which detectors are even considered; a pattern match plus a validator (checksum, range rules) produces a candidate; then nearby "supporting" keywords raise (or lower) a confidence level, and only findings above a minimum confidence are reported. Microsoft Purview, Google Sensitive Data Protection (DLP), AWS Macie, Snort/Suricata, TruffleHog and Gitleaks all document a version of this.

### Cited Findings
**Microsoft Purview sensitive information types (SITs)**
- Purview maps confidence levels to numbers: "Low confidence: 65 or below; Medium confidence: 75; High confidence: 85." — [Purview SIT entity definitions (updated 2026-06-15)](https://learn.microsoft.com/en-us/purview/sit-sensitive-information-type-entity-definitions)
- U.S. SSN definition: four functions (`Func_ssn` for pre-2011 formatted, `Func_unformatted_ssn`, `Func_randomized_formatted_ssn`, `Func_randomized_unformatted_ssn`); "Checksum: No". Every pattern requires a keyword from `Keyword_ssn` "within a proximity of 300 characters". XML: `<Entity ... patternsProximity="300" recommendedConfidence="75">` with patterns at confidenceLevel 85 (formatted pre-2011 + keyword), 75 (unformatted pre-2011 + keyword), 65 (randomized formatted + keyword), 55 (randomized unformatted + keyword). Keywords: "SSA Number, social security number, social security #, social security#, social security no, Social Security#, Soc Sec, SSN, SSNS, SSN#, SS#, SSID". — [Purview U.S. SSN definition](https://learn.microsoft.com/en-us/purview/sit-defn-us-social-security-number)
- So in Purview, a bare 9-digit number with no SSN keyword nearby is **not** an SSN at any confidence. — inference from the XML above (every Pattern contains a `<Match idRef="Keyword_ssn" />`) — [same source](https://learn.microsoft.com/en-us/purview/sit-defn-us-social-security-number)
- Credit card definition: "14 to 19 digits ... Must pass the Luhn test. Must match number formats used by major credit card companies." "This sensitive information type doesn't flag reserved credit card numbers, such as the ones financial institutions use for testing." High confidence (85) = `Func_credit_card` + checksum + any one of `Keyword_cc_verification`, `Keyword_cc_name`, or `Func_expiration_date` within 300 characters; low confidence (65) = `Func_credit_card` + checksum alone. `recommendedConfidence="85"`. — [Purview credit card definition](https://learn.microsoft.com/en-us/purview/sit-defn-credit-card-number)
- Structure in Purview terms: primary element (`IdMatch` – the pattern/function), supporting elements (`Match` – keyword lists or other functions, optionally `Any minMatches="1"`), a confidence level per Pattern, and a proximity window (`patternsProximity`) around the primary element. — [Purview credit card definition XML](https://learn.microsoft.com/en-us/purview/sit-defn-credit-card-number)

**Google Cloud Sensitive Data Protection (DLP)**
- Likelihood levels: `VERY_UNLIKELY` ("A weak signal", "Absence of contextual clues", "Negative signals"), `UNLIKELY`, `POSSIBLE` ("Signals can include passing checksums" with "Lack of a strong contextual clue and unique, specific formatting"), `LIKELY` ("one or more strong signals"), `VERY_LIKELY` ("many strong signals"). Default is "same as POSSIBLE"; findings below the chosen minimum likelihood are dropped; minimum likelihood can be set per infoType. — [Google SDP: Match likelihood](https://docs.cloud.google.com/sensitive-data-protection/docs/likelihood)
- Hotword rules: "adjust the likelihood of a finding, depending on whether a hotword occurs near that finding". Fields: `hotwordRegex`, `proximity.windowBefore` / `windowAfter` (character counts), and `likelihoodAdjustment` as either `fixedLikelihood` or `relativeLikelihood` (integer steps; e.g. POSSIBLE +1 = LIKELY). Example: custom MRN regex at base POSSIBLE; hotword `(?i)(mrn|medical)` with `windowBefore: 10` → `VERY_LIKELY`; "Patient's MRN 444-5-22222 and just a number 333-2-33333" → only the first is raised; the second "lacked the context, so the likelihood stayed at POSSIBLE." Negative example: hotword "Fake Social Security Number" with `fixedLikelihood: VERY_UNLIKELY` and `minLikelihood: POSSIBLE` drops 111-11-1111 from results. `ExcludeByHotword` is "the recommended approach for excluding an entire column". — [Google SDP: hotword rules / customize likelihood](https://docs.cloud.google.com/sensitive-data-protection/docs/creating-custom-infotypes-likelihood)

**AWS Macie managed data identifiers**
- "To detect certain types of sensitive data ... Amazon Macie requires a keyword to be in proximity of the data." For unstructured text "a keyword typically has to be within 30 characters (inclusively) of the data." For columnar/record data the keyword can be in the column/field name or JSON path (e.g. `$.credentials.aws.key`). "Keywords aren't case sensitive"; a keyword with a space also matches no-space, underscore or hyphen variants. — [Macie keyword requirements](https://docs.aws.amazon.com/macie/latest/user/managed-data-identifiers-keywords.html)
- Macie describes its identifiers as "a combination of criteria and techniques, including machine learning and pattern matching". — [Macie managed data identifiers](https://docs.aws.amazon.com/macie/latest/user/managed-data-identifiers.html)

**IDS prefiltering and the Hyperscan design (the origin of the "cheap trigger gates expensive check" idea)**
- "the de-facto best practice of high-performance DPI generally employs multi-string pattern matching as a pre-condition for expensive regex matching. This hybrid approach (or prefiltering) is attractive as multi-string matching is known to outperform multi-regex matching by two orders of magnitude, and most input traffic is innocent ... Snort and Suricata specify a string pattern per each regex for prefiltering, and launch the corresponding regex matching only if the string is found." — [Wang et al., Hyperscan, NSDI '19, p.631](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Stated limits of hand-written prefilters: keywords "defined manually by humans" do not scale and "improper keywords would waste CPU cycles"; string matching is a separate pass, causing "duplicate matching"; a whole regex as one DFA can blow up. — [Hyperscan paper](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- Hyperscan's fix ("regex decomposition"): automatically extract literal strings that are prerequisites of each regex and run small automata only when "all relevant string and FA components are matched". On Snort rulesets this cut regex invocations "by over two orders of magnitude"; many hand-written Snort `content` keywords were single characters, which "invokes redundant regex matching too frequently." — [Hyperscan paper §6.2](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)

**Secret scanners**
- TruffleHog: each detector has keywords that decide "if the chunk of data has potential for containing a secret." v3.28.6 put all detectors' keywords into one Aho-Corasick automaton: scan the chunk once, record hits, skip any detector whose keywords did not appear — from "O(n*k + m)" to "O(n+m+z)". Claimed "2x speedup on average"; e.g. gitlab repo 629.66 s → 175.85 s (concurrency 1). (Two speedup figures in the article's table do not match its own raw times — likely typos.) — [Truffle Security blog](https://trufflesecurity.com/blog/making-trufflehog-faster-with-aho-corasick)
- Gitleaks: "Keywords are used for pre-regex check filtering" — a "quick string compare check" that the keyword is present before the rule's regex runs (since v8.6.0); per-rule `entropy` ("minimum shannon entropy a regex group must have"); `allowlists` (regexes, `stopwords` that target the extracted secret, paths; global allowlists take precedence); inline `gitleaks:allow` comment. — [Gitleaks README](https://raw.githubusercontent.com/gitleaks/gitleaks/master/README.md)
- GitHub token format: prefixes `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`; "An underscore is not a Base64 character", so tokens "cannot be accidentally duplicated by randomly generated strings like SHAs." "With this prefix alone, we anticipate the false positive rate for secret scanning will be down to 0.5%." A CRC32 checksum (Base62, last 6 chars) "virtually eliminates false positives for secret scanning offline." — [GitHub blog: new token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)
- GitHub secret scanning also uses partner validation and optional "validity checks" that "may contact the secret's issuing service to determine if the credential has been revoked"; generic patterns and AI detection widen coverage for unstructured secrets like passwords (no accuracy figures given). — [GitHub Docs: about secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning)

### Inferences
- The common architecture is: (1) one cheap pass that finds *triggers* (literals, prefixes, keyword list, or simply "the text contains a digit run / an @"); (2) only detectors whose trigger fired run their full regex; (3) a deterministic validator confirms; (4) proximity keywords set a confidence level; (5) a per-type minimum confidence decides block/redact/allow. This directly answers the "don't run every check on every message" concern.
- Proximity windows differ widely by vendor (Purview 300 chars, Macie 30 chars, Google configurable per rule, e.g. 10 chars before). For short chat messages (<4 KB), a 300-char window covers much of the message, so it acts close to "keyword anywhere in the message"; a 30–50 char window is more precise.
- For identifiers without a checksum (SSN, student IDs, driver's licences), all three vendors lean on keywords; for identifiers with a checksum (cards, IBAN, GitHub tokens), the checksum carries most of the precision.

### Gaps
- Google's exact window sizes and hotwords for its built-in infoTypes (e.g. US_SOCIAL_SECURITY_NUMBER) are not published on the pages fetched; Google treats built-in detector internals as opaque.
- Macie's per-identifier keyword lists (in its detailed reference pages) were not fetched.
- Nightfall and Cloudflare DLP engineering details were not retrieved in this pass (no primary source read).

## Accuracy techniques that cut false positives, and their effect on precision and recall

### Takeaway
Checksums and structural rules raise precision with almost no recall cost (a real number always passes); keyword/proximity requirements raise precision a lot but cost recall (a real SSN typed without "SSN" nearby is missed); exclusion/test-number lists and allowlists remove known benign values; minimum-confidence thresholds trade one for the other. Format-specific prefixes plus checksums (GitHub tokens) are the gold standard: near-zero false positives.

### Cited Findings
- Luhn check: Purview requires cards to "pass the Luhn test" and "match number formats used by major credit card companies" (issuer prefixes and lengths), and excludes "reserved credit card numbers, such as the ones financial institutions use for testing." — [Purview credit card definition](https://learn.microsoft.com/en-us/purview/sit-defn-credit-card-number)
- SSN structure: SSA randomized assignment on June 25, 2011, removing the geographic meaning of the area number; randomization excludes "area numbers 000, 666 and 900-999", and "will not assign group number 00 or serial number 0000." — [SSA randomization FAQ](https://www.ssa.gov/employer/randomizationfaqs.html); [SSA randomization](https://www.ssa.gov/employer/randomization.html)
- Purview notes pre-mid-2011 SSNs have "strong formatting where certain parts of the number must fall within certain ranges ... (but there's no checksum)" and gives randomized-format SSNs lower confidence (65/55) than pre-2011-format ones (85/75). — [Purview SSN](https://learn.microsoft.com/en-us/purview/sit-defn-us-social-security-number)
- Context raises precision: Google example — identical-shape numbers, only the one with "MRN" nearby becomes VERY_LIKELY. — [Google SDP hotwords](https://docs.cloud.google.com/sensitive-data-protection/docs/creating-custom-infotypes-likelihood)
- Negative context lowers likelihood: hotword "Fake Social Security Number" + `fixedLikelihood: VERY_UNLIKELY` removes 111-11-1111. — [same](https://docs.cloud.google.com/sensitive-data-protection/docs/creating-custom-infotypes-likelihood)
- Prefix effect measured by GitHub: prefix alone → anticipated 0.5% false positive rate; adding checksum → "virtually eliminates" false positives. — [GitHub blog](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)
- Entropy thresholds, stopwords and allowlist regexes are standard false-positive controls in Gitleaks. — [Gitleaks README](https://raw.githubusercontent.com/gitleaks/gitleaks/master/README.md)
- Presidio's own list of false-positive fixes: raise the acceptance threshold; "remove unnecessary PII recognizers, if the dataset does not contain these entities"; update/replace the logic of specific recognizers; or use third-party recognizers. It states "there is a trade-off between false positives ... and false negatives." — [Presidio FAQ](https://presidio.dataprivacystack.org/faq/)
- Presidio context enhancement (LemmaContextAwareEnhancer): `context_similarity_factor` default 0.35, `min_score_with_context_similarity` default 0.4; YAML keys also include `context_prefix_count` (default 5 words) and `context_suffix_count` (default 0). A weak regex scored 0.01 with a context word becomes 0.4. — [Presidio context tutorial](https://github.com/microsoft/presidio/blob/main/docs/tutorial/06_context.md); [Presidio "Configure from file"](https://presidio.dataprivacystack.org/analyzer/analyzer_engine_provider/); [Discussion #812](https://github.com/microsoft/presidio/discussions/812)

### Inferences
- Effect summary (reasoned from the sources above):

| Technique | Precision | Recall | Notes |
|---|---|---|---|
| Checksum (Luhn, IBAN mod-97, CRC in token) | Large gain (random digit runs fail ~90% of Luhn checks, since 1 in 10 passes) | ~No loss | Only for formats that have a check digit |
| Structural rules (SSN area/group/serial, card issuer prefix/length) | Moderate gain | ~No loss | SSN has no checksum, so rules remove only a small share of random 9-digit strings |
| Required keyword within N chars | Large gain | Real loss (unlabelled values missed) | Purview/Macie do this for SSN |
| Keyword as booster (confidence levels) | Gain at high tier | Kept at low tier | Lets policy choose: block high, warn/redact low |
| Test/dummy lists (4111 1111 1111 1111, 123-45-6789, 000-00-0000) | Gain | Tiny loss (only if someone's real number is on the list) | Purview excludes testing card numbers |
| Allowlist (known benign values e.g. the course code, the university phone) | Gain | None for real PII | Must be exact-value, not pattern |
| Min confidence per type | Tunable | Tunable | Google/Purview per-type thresholds |
- The 1-in-10 Luhn pass rate is a mathematical property of a mod-10 check digit, not a vendor figure.

### Gaps
- No vendor publishes measured precision/recall per technique; numbers above beyond GitHub's 0.5% are qualitative.
- IBAN mod-97 and specific test-number lists (e.g. Stripe/Visa test cards) were not fetched from primary sources in this pass.

## Documented Presidio false-positive problems and fixes

### Takeaway
Presidio's false positives come mainly from (a) weak, context-free regex recognizers (driver's licence, bank number, date) that match any digit run, and (b) the spaCy NER model labelling ordinary words as PERSON/LOCATION. Documented fixes are: disable recognizers you don't need, raise per-entity thresholds, require/boost with context, allow/deny lists, and changing the NLP model. Note: Presidio is now community-governed under the Data Privacy Stack org (github.com/data-privacy-stack/presidio).

### Cited Findings
- Presidio now describes itself as "a community-governed open source project under the Data Privacy Stack organization", "originally created at Microsoft". — [Presidio FAQ](https://presidio.dataprivacystack.org/faq/)
- FAQ: "A driver's license number, for example, could be any 9-digit number"; there is "no guarantee that Presidio will find all sensitive information"; SaaS tools "often have better entity coverage or accuracy". — [Presidio FAQ](https://presidio.dataprivacystack.org/faq/)
- Issue #999 "Reduce analyzer false positives": on 1693 DICOM images, 39 contained false positives; with `score_threshold=0.7`, 38 still did. OCR fragments like "3", "deg.", "F", "10,0", "6%", "Pees", "Pam" flagged as PII at ≥0.7. Suggested debugging: `return_decision_process` to see which recognizer fired. Closed "as not planned" on Jun 19, 2025, with no maintainer fix. — [presidio#999](https://github.com/microsoft/presidio/issues/999)
- Issue #2415 (opened Oct 26, 2026): "Call me on 9848012345 about the water problem." → DATE_TIME 0.85, PHONE_NUMBER 0.4 (0.75 with "phone"/"mobile" context), US_BANK_NUMBER 0.05, US_DRIVER_LICENSE 0.01; anonymizer keeps the top score, so it becomes `<DATE_TIME>`. In a 240-complaint test, the 203 phone numbers' top label was PHONE_NUMBER 153, DATE_TIME 32, PERSON 16, UK_NHS 2. Proposed fixes: skip DATE_TIME on digit-only phone-length spans; boost PhoneRecognizer when the number validates for a region. No maintainer response yet. — [presidio#2415](https://github.com/data-privacy-stack/presidio/issues/2415)
- LiteLLM's Presidio guide: "Short alphanumeric strings might be incorrectly flagged as US_DRIVER_LICENSE"; suppress with `presidio_score_thresholds` (example: US_DRIVER_LICENSE 0.85) or `presidio_entities_deny_list`. — [LiteLLM Presidio tutorial](https://docs.litellm.ai/docs/tutorials/presidio_pii_masking)
- NER false positives: English `en_core_web_lg` labelled Brazilian basin names (Pré-Sal, Campos, Santos) as PERSON; fixed by switching to `pt_core_news_lg`. — [Enterprise-SecureChat README](https://github.com/marcelorvergara/Enterprise-SecureChat)
- A guardrail project reports Presidio/GLiNER false positives on public-figure names, generic locations and overlapping spans (e.g. PERSON inside an EMAIL_ADDRESS span); false-positive rate stayed ~22% after a fix, as "card-over-match FPs were simply replaced by NER FPs". (Small third-party project; treat as anecdotal.) — [agentforge#27](https://github.com/sk-20231/agentforge/issues/27)

### Inferences
- The user's Presidio experience matches the documented pattern: many default recognizers enabled at once, several with near-zero base scores that only need a context word to cross 0.4, plus an NER model. A gateway that enables only the entity types it needs, requires validators, and never uses NER for blocking would avoid most of these failure modes.
- Overlap resolution matters: when one span matches several types, "highest score wins" can pick the wrong type (#2415). Deterministic precedence (validated checksum types beat context-free types) is safer.

### Gaps
- No systematic public benchmark of Presidio precision by entity type was retrieved (presidio-research exists but numbers were not fetched).

## Node.js / JavaScript options (packages and maintenance status)

### Takeaway
For Node, the practical stack is: built-in V8 `RegExp` (fast, but backtracking) or `re2` (linear-time, has `RE2.Set` for one-pass multi-pattern matching, actively maintained), a JS Aho-Corasick library for keyword gating, and hand-written validators (Luhn etc. are a few lines; `validator` has `isCreditCard`, `isIBAN`, `isEmail`). Hyperscan has no maintained Node binding. JS PII libraries exist but are young or regex-only without the confidence/proximity model.

### Cited Findings
Registry facts below were read from `npm view` on 2026-10-30 (last-publish = publish time of the latest version).

| Package | Latest | Last publish | Notes |
|---|---|---|---|
| `re2` | 1.27.0 | 2026-09-26 | BSD-3; bindings to Google RE2 |
| `hyperscan` | 0.0.2 | 2018-04-26 | effectively abandoned |
| `@monyone/aho-corasick` | 1.5.11 | 2026-10-19 | MIT, TypeScript, `hasKeywordInText`, `matchInText` |
| `modern-ahocorasick` | 3.3.0 | 2026-09-23 | "Unicode-aware ... UTF-16 ranges, counting, lazy iteration, and replacement" |
| `validator` | 13.15.35 | 2026-04-02 | string validators |
| `redact-pii` | 3.4.0 | 2022-07-29 | old; no release since 2022 |
| `@redactpii/node` | 1.0.19 | 2026-09-28 | "Zero dependencies ... regex-based PII redaction ... modern fork of the abandoned 786k-download library" |
| `openredaction` | 1.1.5 | 2026-07-26 | "Regex-first, local-by-default, 570+ patterns" |
| `@arcjet/redact` | 1.15.0 | 2026-10-28 | Apache-2.0 "sensitive information redaction library" |

- `re2` supports `new RE2.Set(patterns[, flags][, options])` (added 1.23.0; `maxMem` in 1.25.0, default DFA budget 8 MiB); `set.test(str)` returns whether any pattern matches; `set.match(str)` "returns an array of indexes of matching patterns"; a set "builds a single automaton and frequently beats running individual regular expressions one by one." RE2 "lacks backreferences and lookahead assertions" (throws SyntaxError); Node only (no browser/Bun/Deno); results can differ from V8 in edge cases. 1.25.0 added "Faster matching on pure-ASCII inputs." — [node-re2 README](https://github.com/uhop/node-re2)
- Note: `RE2.Set` reports *which* patterns matched, not where; to get spans, re-run only the matched patterns individually. — [node-re2 README](https://github.com/uhop/node-re2) (API returns indexes only)
- npm 12-era installs block package install scripts by default; installing `re2@1.27.0` printed "npm warn install-scripts re2@1.27.0 (install: install-from-cache ... || node-gyp ...)" and required explicit approval (`npm install-scripts approve`). Observed locally on 2026-10-30 (Node v26.11.1). — own observation (no URL)

### Inferences
- Hyperscan/Vectorscan are C libraries; without a maintained binding, using them from Node means writing/maintaining a native addon — overkill for a local demo.
- `re2` adds a native dependency and an install-script approval step; acceptable, but the gain over V8 for a dozen patterns on <4 KB is small (see benchmark below). Its main benefit for a guardrail is safety: linear-time matching on untrusted input (no ReDoS).
- The JS PII libraries are regex lists; none of the fetched descriptions mention confidence levels, keyword proximity or checksum gating in the Purview sense — a project-owned detector table (pattern + validator + keywords + window + confidence) is likely simpler and more auditable than adopting one. (Not verified by reading their source.)

### Gaps
- Did not read the source of `openredaction`, `@redactpii/node` or `@arcjet/redact` to confirm whether they use checksums or context.
- Did not verify whether any Vectorscan Node binding exists on npm.

## Performance: N separate regexes vs one combined automaton for message-sized text

### Takeaway
At large scale (thousands of rules, network speeds), combined automata win by 10–100x (Hyperscan vs RE2/PCRE). For a dozen patterns on chat-sized text (<4 KB), everything costs tens of microseconds per message; the biggest win by far is a trivial gate (e.g. "does the text contain a digit or '@' at all?") which skips digit/email detectors on clean text in ~0.1–0.3 µs. Choose the design for accuracy and clarity, not raw speed.

### Cited Findings
- Hyperscan paper (Snort Talos 1,300 regexes / Suricata 2,800 regexes, single core): "Hyperscan-s outperforms PCRE, RE2-s, and PCRE2"; for Talos, Hyperscan-m is "13.5x faster than RE2-m" and shows "183.3x" over PCRE2; for Suricata, Hyperscan-s shows "24.8x, 9.1x, and 1.8x speedups over PCRE, RE2-s, and PCRE2. Hyperscan-m outperforms RE2-m and PCRE2 by 8.4x and 6.9x." PCRE/PCRE2 had JIT enabled. — [Hyperscan paper, Table 5 and §6.3](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf); JIT note — [intel/hyperscan#138](https://github.com/intel/hyperscan/issues/138)
- Multi-string matching "is known to outperform multi-regex matching by two orders of magnitude". — [Hyperscan paper](https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf)
- TruffleHog's switch from per-detector keyword scans to one Aho-Corasick pass gave ~2x overall scanner speedup (hundreds of detectors, large repos). — [Truffle Security](https://trufflesecurity.com/blog/making-trufflehog-faster-with-aho-corasick)

**Own micro-benchmark (not a primary source; one machine: Apple M2 Pro, Node v26.11.1, 2026-10-30).** 12 typical patterns (SSN, card, phone, email, student-ID-with-label, IBAN, IPv4, GitHub token, AWS key, DOB, passport-with-label, URL), V8 RegExp, 20,000 iterations after warm-up; times are µs per message:

| Text | 12 separate V8 regexes | 1 combined V8 alternation | gate (`/\d/`, `/@/`) then separate | Aho-Corasick 12 keywords (`@monyone/aho-corasick`, pure JS) |
|---|---|---|---|---|
| clean 1 KB (no digits/@) | 14.12 | 16.53 | 0.10 | 31.54 |
| clean 4 KB | 76.86 | 50.04 | 0.30 | 61.34 |
| 4 KB with SSN + card + email | 54.19 | 48.06 | 53.91 | 127.58 |

- Both separate and combined found 3 matches on the dirty text. A combined alternation returns only one alternative per position (non-overlapping), so a span that is both "phone-shaped" and "SSN-shaped" is reported once — fine for gating, wrong for type classification. — own benchmark
- `re2` / `RE2.Set` could not be benchmarked: its native install script was blocked pending approval (see above). — own observation

### Inferences
- For <4 KB messages with ~10–20 detectors, total regex cost is ~15–80 µs per message on V8 — negligible next to a model call (hundreds of ms). "Running every check" is not a performance problem at this scale; it is an *accuracy* problem (every loose regex adds false positives) and a *clarity* problem.
- A pure-JS Aho-Corasick keyword scan was slower than plain V8 regexes here, because V8's regex engine is native code; keyword gating in JS can be done with one V8 alternation regex of the keywords instead. AC libraries pay off with hundreds+ of literals (e.g. a blocked-terms list).
- The efficient and low-false-positive design is therefore: cheap gates per detector family (digits present? '@' present? keyword present?) → full pattern → validator → context-based confidence → per-type threshold — the Purview/Google model, implemented as a small data table.

### Gaps
- No primary published benchmark for N separate vs combined regex on short messages in JavaScript was found.
- `RE2.Set` vs V8 on short text not measured (install blocked); node-re2 says sets "frequently" beat one-by-one but gives no numbers.
- Benchmark used synthetic English text; results on real student messages may differ.
