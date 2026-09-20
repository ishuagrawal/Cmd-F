# Search redesign — September 19, 2026

## Follow-up: real-page failures

The user subsequently reproduced failures on the real careers page and Astra article. The earlier fixtures did not establish acceptance for those installed-browser searches.

The captured article request contained the complete, untruncated compaction paragraph. Jev's screening accepted it (0.97 match probability), but excerpt selection chose a sentence about the historical method. Independent verification rejected that shortened sentence. The engine then discarded the paragraph and crawled unrelated pages until a limit. This was a loss caused by excerpt selection, not missing article text.

Verification now retries once against the complete immutable source when a shortened excerpt fails. The full source must pass the same relevance check; there is no keyword acceptance or threshold relaxation. Replaying the actual captured request returned the full relevant paragraph in 8 provider calls without destination fetches. Tests cover both accepting a useful full source and rejecting an irrelevant one after this retry.

A separate extraction regression was also fixed: `div[lang]` no longer automatically owns all descendant text as one passage. A page-wide language wrapper previously could suppress all its article paragraphs after being truncated. Inline text under a language-tagged block still stays together through ordinary text-block extraction. This independent bug was not the cause of the captured compaction failure.

After these fixes, 173 unit/API tests, the DOM text-coverage/highlighting check, typecheck, targeted lint, and build passed. Careers and installed-browser launch acceptance remain pending: Arc's careers and Extensions settings pages became blank during verification. Temporary diagnostic capture was limited to the two reported public URLs and has been stopped; the normal API is running again without request snapshot logging.

The recurring failures came from lost candidates and confused result types. Raising the crawl budget alone could not fix either. A listing excluded before Jev sees it cannot be recovered by a better prompt, and a relevant route cannot establish a fact that only exists on its destination page.

## Findings and decisions

| Previous failure                                                          | Implemented decision                                                                                      | Reason                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Every query token had to occur in a link label                            | Independent semantic judgments over all scheduled candidates                                              | Paraphrases and plural requests survive; lexical ranking only schedules work.           |
| One exclusive choice hid multiple valid catalog entries                   | Up to 16 independent three-way choices per request                                                        | Each item can independently match, route, or abstain.                                   |
| Article questions surfaced link titles or bibliography entries            | Classify requested output once, then screen candidates; information intent cannot emit link-title results | A title can guide lookup but does not answer an event, factual, or how-to request.      |
| Shortening excerpts removed the actual event                              | Select exact source spans with explicit relationship/event requirements, then verify                      | Quotes and highlights retain the same source offsets and the evidence needed to answer. |
| Section-label choices consumed the small provider budget                  | Deterministic immutable local pagination                                                                  | Jev spends requests judging actual content.                                             |
| One route failure, passage abstention, or origin boundary ended discovery | Persistent frontier; inspect outgoing links after failed evidence; bounded observed external origins      | A useful page can be reached through an index or a separate documentation/jobs host.    |
| Failed requests counted like inspected pages                              | Separate successful-page and fetch-attempt budgets                                                        | Blocked targets cannot exhaust the useful-page allowance immediately.                   |
| Link count meant crawl-frontier size                                      | Separate observed links, reviewed candidates, fetches, and inspected pages                                | The UI reports what was actually examined and what remains.                             |

The workflow stays in code. Jev supplies typed local decisions over immutable records; it does not invent URLs, issue browser actions, or control an unbounded agent loop. This follows the [TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md) and its [independent reranking pattern](https://docs.typesafe.ai/cookbooks/rerank_typesafe).

## Cost and stopping policy

Screening runs in waves of 48 candidates, with three concurrent requests of at most 16 choices. Request byte limits can make batches smaller. Cached judgments are reused within the session. The budget is 96 provider requests / 4 MB aggregate payload, with a 30-second active deadline. These are ceilings, not requests spent on every search.

The session returns up to three results and stops after verified direct evidence. A page search can finish after three matching listings, explicitly disclosing remaining candidates. A site search preserves these listings while exploring for verified details. This intentionally prioritizes a few relevant results and early feedback over exhaustive catalog export. Search is still bounded by extraction, local continuation, network, and model limits; the UI exposes partial coverage.

External retrieval only follows observed root-site links and then stays within each destination origin. It retains URL policy, DNS pinning, robots handling, anonymous requests, deadlines, and origin-bound redirects. This supports cross-host documentation and application destinations without turning a search into unrestricted web traversal.

## Verification sample

Final checks: 170 unit/API tests and 33 production-extension browser tests passed. TypeScript, ESLint, the production build, and diff whitespace checks passed. The live backend was restarted and checked through its authenticated HTTP API: the semantic engineering query returned the engineering listing and excluded the product role in 0.63 seconds / 2 provider requests.

Live measurements below are individual development runs with Jev, not p50/p95 figures or calibrated accuracy claims. Saved public-page snapshots retain the observed source; W3Schools destination fetches use the live network. Source accuracy outside the quoted pages is not independently established.

| Case                                                            | Observed result                                         | Time / requests           |
| --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------- |
| Six job labels, semantic engineering filter                     | Three engineering listings; product role excluded       | About 0.6 s / 2           |
| Missing salary and unrelated factual requests                   | No unsupported result                                   | About 0.4 s / 2           |
| Refund paraphrase with no shared query words                    | Matching returns/reimbursements destination             | About 0.4 s / 2           |
| Three Python sets/lists/how-to requests                         | Verified related-page excerpts                          | About 2.9–3.1 s / 13 each |
| Four article event/relationship/date requests                   | Relevant article excerpts; no bibliography link answers | About 1.4–2.3 s / 7–10    |
| 818 server-extracted links, only last one semantically relevant | All 818 reviewed; final paraphrased destination found   | About 11.1 s / 53         |

The 818-link case measures server inventory coverage, not 818-item browser pagination. A separate browser registry check covers 220 entries over four disjoint batches, source highlighting, and stale-source rejection. `scripts/check-listing-ui.ts --live` runs the built overlay with a live provider over an owned DOM fixture, verifies multiple listings and local highlighting, then a factual excerpt; desktop and narrow screenshots are saved locally.

Reproduce the semantic sample with `node --import tsx scripts/check-search-pipeline.ts`. Optional `--sites` and `--wiki` use the saved snapshots in `.local`; `--large` constructs the large catalog. Reports stay under `.local/search-pipeline-live*.json`. These are diagnostic examples and need a broader held-out corpus before making a general reliability claim.

## Remaining limits

The real OpenAI careers page was not accepted end to end in this run. Automated public navigation reached a browser challenge. In the installed Arc browser, the extension iframe appeared as `about:srcdoc` rather than its extension document; the production overlay worked in isolated Chromium. That installed-browser integration issue still needs reproduction without interfering with the user's active browsing. No CAPTCHA bypass or authenticated fetch was added.

The first live browser run also caught an intent error on a blank-title page. Intent instructions now prioritize the request and distinguish catalog filters from questions about item attributes. That fix passed the regression, but intent remains a model judgment and requires continued evaluation. Multilingual requests, changing real sites, pagination requiring user actions, closed shadow roots, and authenticated destinations remain outside the demonstrated acceptance sample.
