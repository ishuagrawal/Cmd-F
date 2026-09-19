# Primary references checked during implementation

Checked September 19, 2026. Numerical application budgets and thresholds are project choices.

- [TypeSafe HTTP API](https://docs.typesafe.ai/api): `POST /v1/systemone`, authorization, typed questions/answers, usage and errors.
- [Choice](https://docs.typesafe.ai/primitives/choice): choice ID and relative option distribution; no interpretation as answer accuracy.
- [Noul](https://docs.typesafe.ai/primitives/noul): yes/no support in `noul`.
- [Models](https://docs.typesafe.ai/models): pinned `jev-1.13.0`, documented overall/state-plus-largest-question context limits. Live behavior remains unverified in this repository.
- [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel): extension panel and user-invoked opening.
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions): persistent Chromium context and extension service-worker testing.
- [Node.js releases](https://nodejs.org/en/about/previous-releases): Node 24 LTS selection.

- [Vercel Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation): AI SDK 7 typed Choice and Boolean requests using `typesafe-ai/jev`.
- [Vercel CLI Gateway setup](https://vercel.com/docs/cli/ai-gateway): coding-agent setup is separate from application credentials.
