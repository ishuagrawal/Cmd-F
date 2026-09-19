# Verification and evaluation

This report distinguishes implemented behavior, automated fixture evidence, and unmeasured real-model behavior. All screenshots come from actual executions of the application; no rendered design mockups are presented as functional evidence.

## In-page pill verification

The toolbar action and registered `_execute_action` shortcut share the injected `overlay-host.js` entrypoint. The default shortcut is Option+Shift+F on macOS and Alt+Shift+F elsewhere. A narrow prompt capsule expands with search progress, source results, no-answer text, or error messages. Enter or Send immediately searches with This site as the default; there is no confirmation dialog. No whole-page sidebar opens.

Chromium tests cover the production overlay embedded in an owned site, collapsed height under 100px, Enter and Send submission without confirmation, one site-search request per submission, source highlighting without removing the overlay, opening the actual reference in a new tab, Escape dismissal, no-answer/backend failures, cross-tab message rejection, narrow viewport containment, and repeated invocation. Tests use the same injected entrypoint; physical operating-system hotkey dispatch and toolbar permission granting still require a manual check in the user's installed Chrome. Screenshots: `overlay-pill.png`, `overlay-result.png`.

## Functional verification

The unit/API suite covers URL and action policy, private/reserved IPv4/IPv6, production rejection of fixture access, base-URL resolution, sensitive-field extraction, immutable candidate identity, malformed provider output, separate Choice/Noul calls, provider retry budgets, public-cache eligibility, authentication, ownership isolation, current-page and multi-page search, no-answer behavior, cancellation/deletion, lease expiry, bounded event replay, stale-document rejection, actual redirect blocking, compressed response limits, robots redirect enforcement, cookie response handling, and cyclic compressed sitemap indexes.

The Chromium suite uses the real production extension bundles, copied into a test-only manifest with access to the owned fixture origin. It exercises:

- Documentation homepage → Control flow source, while the source tab URL stays unchanged.
- News fact → the exact Juniper excerpt → Show here → Clear highlight, preserving page text.
- The legacy fixture playground data preview excludes password/input values, drafts, and token URLs, with unchecked consent required to continue. These confirmation controls are absent from the user-facing pill.
- Both existing hidden menu children and children created only after the user clicks. Cancellation controls are highlighted; instrumented action counters stay zero.
- Honest no-answer behavior without fetching logout/token action traps.
- A relevant passage late in a long document and a stable local highlight.
- Refusal to highlight a source after its text changes.
- Open-shadow and same-origin-frame extraction with cross-origin/canvas limitations disclosed.
- Clearing obsolete results after source-tab navigation.
- Desktop/mobile playground rendering and an actual browser-playground site search.
- Killing the extension service worker, switching to another tab, and still highlighting only the original source after worker recovery.

Tests open the extension panel document in an extension tab for automation. They do not verify OS-level keyboard dispatch or a manual toolbar permission invocation. The fixture manifest permission is not present in the delivered production manifest. No real account was cancelled, signed out, or changed.

See `docs/reports/verification.json` for the final command results and counts. Playwright writes the full machine-readable run under `test-results` / its HTML report. Screenshots are in `docs/screenshots`.

## Semantic corpus

`tests/eval/tasks.json` contains **60 labeled questions over 12 templates**, eight candidates per question, with target positions varied. There are 48 answerable and 12 no-answer questions. Six templates form the development set; six different templates form the held-out set. Cases span documentation, articles, instructions, controls, paraphrases, and no-answer queries. Corpus construction included a preliminary mock smoke run; no live responses have been used to tune it, and no mock thresholds were changed based on held-out results.

The baseline result is **mock-only** and predates the September 19 ordered-phrase routing update; the corpus metrics below are historical, not a measurement of the updated ranker. It tests a conservative deterministic selector, not Jev. Its mock support value is synthetic and is never a user-facing accuracy probability.

| Metric                                           | All tasks       | Held-out templates |
| ------------------------------------------------ | --------------- | ------------------ |
| Top-1 target / exact passage                     | 29 / 48 (60.4%) | 13 / 24 (54.2%)    |
| Top-3, selected target plus lexical alternatives | 45 / 48 (93.8%) | 23 / 24 (95.8%)    |
| Answerable-case direct recall                    | 29 / 48 (60.4%) | 13 / 24 (54.2%)    |
| False-direct no-answer results                   | 0 / 12          | 0 / 6              |
| Lexical-only top-1 target ranking                | 44 / 48 (91.7%) | 23 / 24 (95.8%)    |
| Lexical-only top-3 target ranking                | 45 / 48 (93.8%) | 23 / 24 (95.8%)    |

The keyword ranker is less conservative than the mock evidence gate; these are different decisions. The mock fails many low-overlap paraphrases. **The proposed 90% answerable-case recall target is not met.** Top-3 is offline reranking of the supplied candidate set, not proof that the crawler discovers every answer or that three results are always displayed.

For scale: the all-task top-1 Wilson 95% interval is approximately **46.3–73.0%**; top-3 is **83.2–97.9%**. Zero false-direct results in 12 negatives still has a Wilson upper bound of about **24.3%**, so it does not establish a production false-positive rate below 5%.

Both Jev transports are implemented and tested, including the real Vercel AI SDK evaluation path. A live Gateway smoke test using `typesafe-ai/jev` selected the correct synthetic Juniper passage and returned support `0.98` in a separate verification call (two requests, 850 input / 61 output tokens).

The subsequent 60-task live evaluation was **invalidated by provider throttling**: 59 tasks had provider errors. A redacted diagnostic confirmed HTTP 429, “Free tier requests on this model are rate-limited.” The raw run is retained in `docs/reports/evaluation-live.json`; its aggregate accuracy figures are not a valid semantic evaluation. The live browser fixture search exercised the disclosed lexical fallback, not verified Jev evidence. No production accuracy claim follows from the successful smoke test.

The evaluation runner now stops on a rate-limit error, marks reports incomplete, and exits nonzero if any provider errors occur. Searches stop further Jev calls for the remainder of a rate-limited search and visibly label keyword candidates as unverified. Rerun `pnpm test:live` when the account's model quota permits the corpus. The fixed corpus and thresholds have not been tuned on live results.

## Performance and highlight coverage

Measured local API p50/p95 was **9.0 / 17.9 ms** for the current page and **1,011.6 / 1,016.3 ms** for site search (four page observations), with zero action-trap activations.

`pnpm benchmark` measures 20 current-page and 20 site-search runs through the local HTTP API, with the mock provider and forced fresh fixture fetches. It reports p50/p95, checked-page counts, and action-trap counts in `docs/reports/latency-mock.json`. These measurements exclude DOM extraction and visible rendering and include no real internet/provider latency. They cannot establish the proposed 3-second/10-second end-user targets under normal network conditions.

Browser tests verify stable highlight operations (article, two menu controls, late passage, recovered worker, and an action-like anchor), repeated highlighting after unrelated mutations, and exact same-document relocation after a re-render. They also check changed text, changed routes, ambiguous replacements, disappearance of an original duplicate, and retry after a hidden target becomes visible. The small fixture sample is not enough to establish a 95% highlight success guarantee for arbitrary sites. Cross-document exact quote relocation is not implemented.

## Remaining acceptance gates

- A complete live Jev semantic evaluation without provider errors, multilingual behavior, exact tokenization, and real-model latency.
- Manual toolbar/activeTab/keyboard shortcut smoke testing in the user’s Chrome installation.
- Real-site completeness, hidden CSS/shadow-root edge cases, account variants, and changed source relocation.
- Infrastructure egress isolation, hosted identity/cumulative quotas, and Chrome Store disclosures.
- Optional renderer and separately approved related-origin search.

These are explicit release limits, not silent passes. The repository delivers a usable local preview and reproducible evidence for its tested subset.

Direct TypeSafe connectivity was subsequently verified using `TYPESAFE_API_KEY` with `JEV_TRANSPORT=typesafe`: Jev 1.13.0 selected the correct synthetic Juniper passage and returned `0.97` support through a separate Noul call (2 calls, 953 input / 61 output tokens). The earlier Gateway rate-limited report is historical; a full direct-provider semantic evaluation has not been run.

## Navigation-heavy site search regression

The W3Schools Python tutorial failure had three causes: the demo policy rejected public origins, DOM extraction kept early navigation instead of query-relevant links, and fetched HTML exhausted its 500-candidate limit before the article. The corrected demo preserves production public-site validation, DOM navigation is ranked before its payload cap, and fetched HTML reserves space for relevant passages and routes. Ordered phrase matches distinguish “for loops” from “while loops”; useful links can be followed before requesting another local section.

A live Chromium extraction of `https://www.w3schools.com/python/` with “how do for loops work” now includes the For Loops link (absent before the fix). A direct TypeSafe search using that snapshot fetched the For Loops article and returned it first with an actual article passage. This diagnostic used a three-public-page budget and returned `candidate_only`, not independently verified complete evidence. It confirms discovery and fetching for this example, not arbitrary-site completeness. The browser regression also opens the correct subpage when 650 unrelated links precede it, using the deterministic mock provider.

The pill renders ongoing status and its loading indicator after all retrieved source cards. A mixed-provider browser regression checks their actual vertical position and verifies that earlier AI-assessed results keep their evidence label while lexical fallback results display Keyword match. Provider interruptions are disclosed separately from search progress.

## Jev-only results and bounded destination validation

Live searches now display only sources that pass independent Jev validation (`0.85` threshold). A local passage must address the request; a fetched destination must directly cover the requested topic or destination. Route choices alone and weaker selections never become result cards. This validates destination relevance rather than promising that every displayed excerpt is a complete standalone explanation. Internal lexical ranking only shortlists candidates for Jev. Explicit mock mode remains available for offline fixture tests.

Defaults are five public subpages and 18 AI calls including retries. Search stops after a validated source; a Jev route decision of none no longer forces exploration of a keyword match. Provider failures propagate through crawler error handling and end the search with a specific category: rate limit, request timeout, local AI budget, invalid response, authentication, payload limit, or provider/network error. The historical fallback and mixed-provider UI checks above describe earlier behavior.

The W3Schools query “how do for loops work” was rerun live through direct TypeSafe. It returned a validated Python For Loops destination after checking the current page and one subpage, using four AI calls in about 1.2 seconds. This is one live example, not a corpus accuracy measurement. Source buttons are limited to validated fetched destinations; local passages and controls have only Show on page. Browser tests also hide stale unverified result payloads.

## Recall regression and Wikipedia checks

The numeric-cutoff version was too strict for a source locator. In a balanced 24-case live diagnostic, Jev selected all 12 expected positive candidates, but the second check and `0.85` cutoff accepted only six. Search-intent prompts plus independent typed relevance validation accepted all 12 expected positive candidates and rejected all 12 unrelated queries. This is a small development comparison, not a held-out production accuracy estimate. See `docs/reports/search-recall-regression.json` for the rows and stage notes.

The final implementation retains the original page title and safe URL through selection and verification, including when following links. Bibliographic entries are de-prioritized unless requested, inflection handling connects words such as testify/testified, and truncation is tracked per candidate. Provider errors still stop the search, keyword-only results remain disabled, and the five-subpage / 18-call limits are unchanged. The earlier numeric threshold description above is historical.

On the actual Sam Altman Wikipedia article, the four supplied queries (attack, house attack, Microsoft partnership, and testimony date) all returned a local article passage and successfully highlighted it in Chromium, with two direct TypeSafe calls and one page checked per query. The Microsoft result locates the article passage about Microsoft's proposed research-team role during the removal/reinstatement episode; this is a search-location result, not a claim that the excerpt exhaustively describes the OpenAI–Microsoft partnership. The testimony result highlights article text rather than a bibliography entry. These cases remain examples, not a guarantee for arbitrary pages.
