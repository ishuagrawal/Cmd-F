# Security boundaries and threat model

## Assets and trust

Private browser text and queries belong to one consented search. The local client token authorizes backend access; a Vercel Gateway key/OIDC token (or optional direct TypeSafe key) authorizes provider calls. Both are secrets, but only the application token is entered into extension settings. Public HTML, DOM labels, URLs, sitemaps, and provider responses are untrusted.

A malicious webpage can control its text, links, ARIA attributes, menu structure, and redirects. A malicious API caller can send malformed DTOs or another search ID. The code does not assume a website’s GET routes are harmless, a provider response is valid, or CORS is authentication.

## Implemented controls

- Exact-origin HTTPS public targets only, standard HTTPS port, no URL credentials or token-bearing URLs. Action and account-route policies are recomputed on the server instead of trusting client labels.
- DNS resolves all answers and rejects a hostname if any answer is private, loopback, link-local, reserved, or otherwise nonpublic. A checked address is pinned into the actual connection lookup. Redirects repeat origin, URL, DNS, and robots validation before network access.
- Anonymous fetches carry no browser cookies, authorization, or user profile. Static HTML parsing never executes website scripts. Compression is bounded before and after decoding; XML entities/DTDs are rejected. Requests have hard deadlines and abort signals.
- Known mutation routes, one-click token links, executable schemes, and account management URLs are not background fetch candidates. Informational help routes remain searchable. Navigation helpers independently reapply the same policy.
- Extension messages must originate in this extension’s panel/background and match a runtime schema. Local operations accept IDs, not arbitrary selectors or code. The mediator uses a fixed source tab; the content script verifies document/snapshot identity.
- No website `click`, focus, form-submit, cookie, or arbitrary page-script API exists. Highlight layers cannot receive pointer events. React renders source text as text, not untrusted HTML.
- Choice responses must contain exactly the offered IDs plus `none`, finite probabilities, a normalized distribution, and a known selected ID. Noul is separately validated. Provider errors reveal no source text or request body in ordinary logs.
- Authentication precedes API work, search ownership is checked on every search route, payload size and DTO shape are bounded, at most three active searches per owner and 100 retained sessions are admitted, and active leases expire.
- Sensitive requests and query-dependent rankings never enter the public SQLite cache. Responses with cookies, authentication challenges, or restrictive cache directives are ineligible.

## Residual risks and deployment boundary

A public GET endpoint can have undocumented effects. Route filtering reduces intentional action exposure; it cannot prove every unknown server route is side-effect-free. Arbitrary public crawling remains bounded and user-authorized.

No host egress firewall is installed by this repository. DNS pinning and redirect checks are tested application controls, not a claim of infrastructure isolation. Keep the API on loopback. Hosted deployment requires authenticated per-user identities, cumulative quotas, trusted TLS termination, secret provisioning, egress rules excluding internal networks, and an independent deployment review.

Input redaction is incomplete by nature. The pill submits selected page text immediately on Enter or Send; it does not present a per-search preview. Form values and drafts are still excluded, including on private/account pages. Closed shadow roots cannot be inspected reliably. ARIA declarations are hints; hidden controls remain unavailable until observed after a real user reveal. The extension cannot verify that a third-party site describes its controls truthfully.

The optional renderer is absent and fails closed. No external-origin search approval, browser authentication export, private endpoint discovery, CAPTCHA bypass, or paywall bypass is implemented.

Tests exercise actual prohibited network/DOM effects where fixtures can observe them. See [evaluation](evaluation.md) for the exact verification scope, including what is not yet certified.
