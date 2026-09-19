# Cmd-F

Ask what you are looking for. Reach the actual passage, page, or control.

Cmd-F is a local-first Chrome extension with a keyboard-invoked in-page prompt with a bounded, anonymous site-search backend. It searches the current page first, returns source text, and highlights only when asked. It never clicks website controls or navigates the source tab during a search.

![Cmd-F in-page pill](docs/screenshots/overlay-pill.png)

## Run the playground

Use Node **24.21.0 LTS** (`.node-version`) and pnpm **11.19.0**. The package supports Node 24.19+; the initial build was also exercised on Node 26.4.0.

```bash
pnpm install --frozen-lockfile
pnpm demo
```

Open **http://127.0.0.1:5173/overlay.html** for the pill preview, or **http://127.0.0.1:5173/sidepanel.html** for the full fixture playground. The playground embeds owned documentation, news, and account fixtures. In the pill, Enter or Send immediately searches the current page and public pages on the same site. The legacy fixture playground retains its preview and confirmation controls. With no provider key, the backend uses a clearly labeled deterministic keyword provider.

Try these flows:

1. **Documentation:** “How do loops work in Python?” → This site → consent → the Control flow source page.
2. **A news article:** “What is the baby’s name?” → This page → consent → Show here.
3. **An account menu:** “Where can I cancel my membership?” → This page → consent → search the available content. Closed menus do not trigger manual inspection prompts; if no source is verified, the search finishes without a result. The cancellation button is never clicked.
4. Ask “What is the temperature on Mars?” for an honest no-answer result.

`pnpm demo` uses the normal public-site network policy and adds a **fixed allowlist for owned loopback fixtures**. Public websites remain searchable. The fixture exception is never imported by the production API entrypoint. `pnpm dev` runs the same UI and fixtures but uses the normal public-only fetch policy; it cannot crawl loopback fixtures. Never expose either development server to a network.

## Load the real extension

```bash
pnpm build
pnpm dev:api
```

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select `apps/extension/dist` in this repository.
3. Open a website and click the **Cmd-F** toolbar action (or use the shortcut). That invocation grants temporary current-tab access.
4. Use **Option+Shift+F** on Mac or **Alt+Shift+F** elsewhere to toggle the compact pill in the top-right corner. Change it at `chrome://extensions/shortcuts`. Escape closes it.
5. Open Connection settings in the pill. Copy the local client token from `.local/client-token` into the token field. This is application authentication, not your Gateway API key.
6. Type a question and press Enter or Send. Cmd-F immediately searches the current page and public pages on the same site, with no additional confirmation. Select This page in settings to limit the scope.

Enter submits a request; Shift+Enter inserts a newline. The pill expands beneath the input for search progress and the conversation. Only Jev-validated sources are displayed in live mode. Results offer **Show on page** for local passages and **Open source** only for a validated destination page, using its fetched URL; destination links open in a new tab. Searches default to five public subpages and at most 18 AI calls including retries. Show on page tolerates unrelated layout updates and automatically relocates a uniquely matching unchanged passage after a re-render. Changed or ambiguous sources still require a new search. Rate limits, connection errors, and no-answer outcomes appear in the same conversation. The browser’s normal Cmd+F / Ctrl+F stays unchanged.

The unpacked production manifest has `activeTab`, `scripting`, and `storage`, plus access to the exact loopback API origin. Only the overlay HTML is web-accessible so it can be embedded; this does not grant page-reading access. The UI runs in an extension-origin iframe and inspection is bound to its actual source tab. It has no blanket website host permission, cookies, debugger, history, or automatically injected page scripts. Browser-internal pages, extension pages, and the Chrome Web Store cannot be inspected.

The extension build is also available as `artifacts/cmd-f-extension.zip` after `pnpm package`. Extract it before using Load unpacked.

## Enable Jev directly through TypeSafe

Set the following in `.env` or `.env.local`, then restart the backend:

```dotenv
TYPESAFE_API_KEY=your-key
JEV_TRANSPORT=typesafe
```

Cmd-F sends typed Choice and independent Noul verification requests directly to TypeSafe's `https://api.typesafe.ai/v1/systemone` endpoint using `jev-1.13.0`. The Gateway is not involved. Your existing local client token in the extension stays the same.

When `JEV_TRANSPORT` is unset, a `TYPESAFE_API_KEY` selects direct TypeSafe access even if an old Gateway key is also present. An explicit transport setting always wins. A live direct smoke test selected the correct synthetic source and returned support `0.97`; this verifies connectivity, not overall semantic accuracy.

## Optional: use Vercel AI Gateway

Add your Gateway key to **`.env.local`** (the file is gitignored):

```dotenv
AI_GATEWAY_API_KEY=your-key
JEV_TRANSPORT=gateway
```

`VERCEL_AI_GATEWAY_KEY` in `.env` is also supported; there is no need to rename an existing key. `AI_GATEWAY_API_KEY` takes precedence if both are set.

Restart `pnpm demo` or `pnpm dev:api`. Cmd-F uses AI SDK 7's `experimental_evaluate` with **`typesafe-ai/jev`**. It selects an exact candidate ID with a typed Choice, then makes a separate Boolean probability request to verify the selected source. Optional `GATEWAY_ZERO_DATA_RETENTION=true` requests zero data retention on supported Vercel plans; standard Gateway policy applies by default. Keys stay on the backend and are never bundled into the extension.

Shell variables take precedence over `.env.local`, then `.env`. A key enables live mode unless `PROVIDER_MODE=mock` is set. Vercel OIDC (`VERCEL_OIDC_TOKEN`) is also supported. For an already linked Vercel project, `vercel env pull .env.local` refreshes its local OIDC credentials; no Vercel deployment is required when using a Gateway API key.

`npx vercel@latest ai-gateway setup` configures **coding agents**, not this application's environment. Cmd-F does not need changes to your Codex or Claude configuration. Create an app key in your [Vercel Gateway dashboard](https://vercel.com/dashboard/ai-gateway).

Direct TypeSafe defaults to `jev-1.13.0`; Gateway defaults to `typesafe-ai/jev`. Remove a transport-specific `JEV_MODEL` override when switching providers to use the appropriate default.

```bash
pnpm test:live
```

This runs the same 60-task evaluation with real inference and writes `docs/reports/evaluation-live.json`, recording the transport and model. It exits clearly when credentials are missing. A live Gateway smoke test passed. The larger evaluation hit free-tier model rate limits and is marked incomplete; deterministic mock results and rate-limited runs are not semantic-accuracy evidence. Live searches stop with a specific error when AI verification fails; they never return keyword fallback results.

## Commands

| Command             | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `pnpm dev`          | Public-policy API, Vite panel playground, owned fixtures |
| `pnpm demo`         | Public-site search plus owned local fixtures             |
| `pnpm dev:api`      | Public-policy loopback backend only                      |
| `pnpm build`        | Production unpacked extension and bundled Node backend   |
| `pnpm package`      | Build and zip the unpacked extension                     |
| `pnpm typecheck`    | TypeScript validation                                    |
| `pnpm lint`         | ESLint                                                   |
| `pnpm format:check` | Source formatting check                                  |
| `pnpm test`         | Unit, security, and API integration suites               |
| `pnpm test:e2e`     | Build and test the real extension in Chromium            |
| `pnpm test:eval`    | 60-task deterministic evaluation report                  |
| `pnpm test:live`    | Opt-in Jev evaluation on the same corpus                 |

Browser regression tests require a mock backend. Stop a running live preview first; the test runner starts its own mock preview and refuses to reuse a live one.

Before the first browser test, run `pnpm exec playwright install chromium`. Tests copy the production build to `.local/test-extension` and add permission for the **owned fixture origin only**. The original fixture interface is tested in an extension tab; the pill suite embeds the actual overlay in an owned page. OS-level hotkey dispatch and a manual toolbar permission grant remain manual checks.

## Delivered and remaining

Implemented: source extraction, current-page controls, bounded static public crawling, DNS-pinned requests, robots/sitemap discovery, SQLite public cache, Jev adapter, immediate pill search, legacy playground consent previews, streaming/replay, leases/cancellation, hidden-menu guidance, and reversible local highlights.

This is a **working local preview**, not a store-ready hosted release. See [decisions](docs/decisions.md) for deliberate changes and [evaluation](docs/evaluation.md) for measured results and incomplete acceptance gates. In particular: live Jev quality is unmeasured; anonymous rendering, hosted identity/quotas, additional-origin approval, and automatic quote relocation on newly opened source tabs remain deferred. Source links use heading anchors where available.

- [Architecture and protocol](docs/architecture.md)
- [Security boundaries](docs/security.md)
- [Privacy and retention](docs/privacy.md)
- [Configuration](docs/configuration.md)
- [Evaluation and verification](docs/evaluation.md)

## If clicking the extension opens a help page

Cmd-F cannot be injected into New Tab, browser settings, `chrome://extensions`, other extensions, the Chrome Web Store, or built-in document viewers. Switch to a normal HTTP/HTTPS website, then invoke Cmd-F there. The help page distinguishes browser restrictions, missing tab access, and an installation/load failure; an unknown failure is not automatically called a restricted page.

After updating the unpacked extension, click **Reload** in `chrome://extensions`. Existing installations may retain the old shortcut: open `chrome://extensions/shortcuts`, find **Cmd-F → Activate the extension**, and assign **Option+Shift+F** (Mac) or **Alt+Shift+F**. If another app already uses that combination, choose another unused shortcut. Browser and OS reserved shortcuts take priority over extension commands.
