# Verification and evaluation

This report distinguishes implemented behavior, automated owned-fixture evidence, and sampled real-model behavior. Screenshots and browser runs are generated from the local application; they are not design-only claims. See [search redesign](search-redesign.md) for the live regression sample and its limits.

## In-page pill verification

The toolbar action and registered `_execute_action` shortcut share the injected `overlay-host.js` entrypoint. The default shortcut is Option+Shift+F on macOS and Alt+Shift+F elsewhere. A narrow prompt capsule expands with progress, source results, no-answer text, or an error. Enter or Send immediately starts the request with This site as the default. No whole-page sidebar opens.

Chromium tests cover the production overlay embedded in an owned fixture, collapsed height under 100px, immediate submission, one request per submission, source highlighting without removing the overlay, opening a validated destination, Escape dismissal, no-answer/provider failures, cross-tab message rejection, narrow viewport containment, and repeated invocation. Physical operating-system shortcut dispatch and toolbar permission granting still require a manual check in the installed browser.

## Functional verification

The unit/API suite covers URL and action policy, private and reserved address handling, production rejection of fixture access, base-URL resolution, sensitive-field extraction, immutable candidate identity, malformed provider output, separate selection and verification calls, retry budgets, public-cache eligibility, authentication, ownership isolation, current-page and multi-page retrieval, no-answer behavior, cancellation/deletion, lease expiry, bounded event replay, stale-document rejection, redirect blocking, compressed-response limits, robots enforcement, cookie handling, and cyclic sitemap indexes.

The browser suite uses the production extension bundles against owned local pages. It exercises destination discovery, exact local highlighting, private preview redaction, hidden controls, action-like links, late passages, stale sources, open shadow roots, same-origin frames, unsupported surfaces, source-tab navigation, tab switching, and service-worker recovery. No external page or real account is required.

## Semantic corpus

`tests/eval/tasks.json` contains 13 neutral labeled requests across four templates, with answerable and no-answer cases, varied candidate positions, passages, and controls. The corpus is intentionally synthetic and does not encode an external site, article, person, or user search history.

The deterministic report is generated with `pnpm test:eval` and written to `docs/reports/evaluation-mock.json`. Its scores describe candidate selection over the supplied fixtures only. They do not establish real-model accuracy, public-site completeness, or highlight success on arbitrary pages.

Provider transports are exercised separately. A live provider run is incomplete whenever credentials, rate limits, or transport errors prevent the planned cases from finishing; incomplete runs do not produce semantic accuracy claims.

## Performance and highlight coverage

`pnpm benchmark` measures local API round trips for current-page and bounded site retrieval with the mock provider and forced fresh fixture fetches. It reports p50/p95 timings, checked-page counts, and action traps in `docs/reports/latency-mock.json`. These measurements exclude browser extraction and rendering, real network latency, and live-provider latency.

Browser tests verify stable same-document highlights after unrelated mutations, exact relocation after a rerender, changed text, ambiguous replacements, source disappearance, hidden targets, and retry behavior. The fixture sample is not enough to establish a guarantee for arbitrary sites. Cross-document quote relocation remains deferred.

## Remaining acceptance gates

- A representative held-out live semantic evaluation, including multilingual behavior, repeated-run stability, and latency distributions. The small live regression sample is not a production accuracy estimate.
- Manual toolbar, active-tab, and keyboard-shortcut checks in the installed browser.
- Real-site completeness, unusual rendering surfaces, account variants, and changed-source behavior.
- Infrastructure egress isolation, hosted identity/quotas, and store disclosures.
- Optional renderer support. Observed related-origin retrieval is implemented and bounded; authenticated or rendered destination retrieval remains unsupported.

These are explicit release limits, not silent passes. The repository delivers a usable local preview and reproducible evidence for its tested subset.
