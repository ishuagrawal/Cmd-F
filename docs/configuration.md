# Configuration

Copy `.env.example` to `.env.local`; keep it local. Startup loads shell values first, then `.env.local`, then `.env`. The client key is never printed to API logs or bundled into the extension.

| Variable                      | Default                      | Meaning                                                                                             |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY`          | empty                        | Backend-only Vercel Gateway credential; enables live mode automatically                             |
| `VERCEL_AI_GATEWAY_KEY`       | empty                        | Alias for `AI_GATEWAY_API_KEY`; standard name wins when both are present                            |
| `VERCEL_OIDC_TOKEN`           | empty                        | Gateway credential alternative from Vercel's environment; used if no Gateway key is set             |
| `GATEWAY_ZERO_DATA_RETENTION` | `false`                      | Require Gateway ZDR on supported plans; a policy rejection fails the call without downgrading       |
| `JEV_TRANSPORT`               | inferred                     | `gateway` uses AI SDK evaluation; `typesafe` uses the native HTTP API                               |
| `TYPESAFE_API_KEY`            | empty                        | Used only with `JEV_TRANSPORT=typesafe`                                                             |
| `PROVIDER_MODE`               | inferred                     | `mock` or `live`; live without a key fails startup                                                  |
| `JEV_MODEL`                   | transport default            | `typesafe-ai/jev` for Gateway; `jev-1.13.0` for direct TypeSafe. Gateway rejects chat models.       |
| `API_PORT`                    | `4317`                       | Backend port; host is always `127.0.0.1`                                                            |
| `CMD_F_API_BASE_URL`          | inferred from API port       | Exact loopback API origin compiled into panel, manifest permission, and CSP; rebuild after changing |
| `CMD_F_CLIENT_TOKEN`          | randomly provisioned         | At least 24 characters; otherwise read/create `.local/client-token` with owner-only permissions     |
| `ALLOWED_ORIGINS`             | localhost/127.0.0.1:5173     | Comma-separated browser playground CORS origins; extension origins still need bearer authentication |
| `MAX_PAGES`                   | `5`                          | Successfully retrieved public HTML pages, maximum 20; fetch attempts are capped at twice this value |
| `MAX_URLS`                    | `5000`                       | Bounded discovered frontier records                                                                 |
| `SEARCH_DEADLINE_MS`          | `30000`                      | Cumulative active time across local continuations                                                   |
| `FETCH_TIMEOUT_MS`            | `8000`                       | Per-resource request timeout, maximum 10000                                                         |
| `LEASE_MS`                    | `45000`                      | Maximum silence from the panel before cancellation/deletion                                         |
| `SESSION_TTL_MS`              | `600000`                     | Absolute maximum retention                                                                          |
| `CACHE_PATH`                  | `.local/public-cache.sqlite` | SQLite file for eligible anonymous artifacts                                                        |
| `CACHE_TTL_MS`                | `900000`                     | Freshness ceiling, further restricted by HTTP directives                                            |
| `ENABLE_RENDERER`             | `false`                      | `true` fails closed; isolated renderer is deferred                                                  |

The backend admits at most three active searches per client token and 100 retained sessions. Semantic screening uses at most 16 independent candidate judgments per request and three concurrent requests, with full extracted text bounded by request bytes. Searches allow 96 provider requests including retries and 4 MB total serialized payload, inside the unchanged 30-second deadline. Local continuation is bounded to 24 batches. A live matching link requires a semantic item/navigation verdict and is labeled as unverified destination details. Passages and controls additionally require independent exact-source verification. Confidence is not presented as answer accuracy. Provider failures retain earlier results and report their reason. Public pages have a five-successful-page and ten-attempt budget by default. External routes must be observed links; redirects stay within the target origin, and external destinations cannot expand to a third origin.

Build-time API origins are intentionally restricted to loopback. A hosted deployment requires a separate identity and infrastructure design; editing a CORS list does not make this local application ready for public exposure.

The demo policy delegates public origins to the production network policy and allows fixed owned loopback fixtures separately. Fixture exceptions are injected only in `pnpm demo` and test entrypoints. The production API has no fixture override environment variable. Browser tests require ports 4317/4318/5173 to be available unless an already-running mock demo is reused locally; they refuse to reuse a live backend.

With no explicit transport, `TYPESAFE_API_KEY` selects direct TypeSafe; otherwise the transport is Gateway. `.env.example` explicitly selects `typesafe`. The extension reads the effective transport from the backend for its connection-settings disclosure. An existing Gateway key is ignored while `JEV_TRANSPORT=typesafe`.
