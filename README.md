# RedAlt

RedAlt is a React + TypeScript Reddit reader with a Reddit-style feed, media view, comments, saved posts, history, custom feeds, and video mode.

## Reliability architecture

The browser talks to one same-origin gateway: `/api/reddit`. It does not rotate through public proxies during an ordinary feed load.

```text
Browser → /api/reddit → official Reddit OAuth API (when configured)
                         ↓ otherwise (bounded, auto-enabled)
                       old.reddit HTML → Reddit RSS
                         ↓ optional, off by default
                       public instances / mirror / anonymous JSON
```

- OAuth is always the preferred source when credentials are configured.
- **Without credentials the gateway auto-enables the bounded old.reddit/RSS scrape path** — the one unauthenticated source that works in practice. Anonymous `www.reddit.com` JSON is WAF-blocked from servers and most public Redlib instances sit behind anti-bot walls, so both are optional last resorts.
- All requests to Reddit-owned hosts flow through a single serialized queue with minimum spacing, and once Reddit blocks the IP the gateway opens a 90-second circuit breaker instead of piling more requests onto the block.
- Feed requests have a short overall deadline and are aborted when the user changes route or retries. Already-loaded posts stay visible when a refresh fails (inline banner instead of a full-screen error).
- Post detail loads comments and the primary post in one request. Media repair is explicit instead of silently fanning out into several extra feed requests.
- The gateway prefers the official OAuth API, validates payload shape before returning it, caches successful JSON briefly, and shares one cold OAuth token exchange across concurrent requests.
- `Retry-After` is carried from Reddit through the gateway to a visible countdown. Failed pagination pauses until the reader deliberately retries it, rather than repeatedly requesting the same cursor.
- Search fans out into three upstream calls but recent query/filter combinations are remembered for the session so toggling filters does not re-press the upstream source.

Reddit access must use the developer-documented authorization flow and may be rate-limited. See the [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms) and [API documentation](https://www.reddit.com/dev/api/).

## Configure the gateway

Copy `.env.example` to `.env.local` for local development. Keep the browser on its local gateway:

```bash
VITE_REDDIT_API_BASES=/api/reddit
```

Create a Reddit OAuth application at <https://www.reddit.com/prefs/apps>, then set these **server-only** variables. Do not prefix them with `VITE_`.

```bash
REDDIT_PROXY_USER_AGENT="web:RedAlt:0.2.0 (public read-only client)"
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
# Optional for user-authorized access:
REDDIT_REFRESH_TOKEN=...
```

`REDDIT_OAUTH_ACCESS_TOKEN` is available as a short-lived development override, but client credentials or a refresh token is the normal deployment setup. The Vite development gateway loads these values only in Node; they are not bundled into the browser.

### Fallbacks

When OAuth is not configured, the gateway automatically uses the bounded old.reddit/RSS scrape path so an out-of-the-box deployment works. OAuth is always preferred when credentials exist. You can force the scrape path on or off explicitly with `ENABLE_LEGACY_SCRAPE_FALLBACK=true|false`, or hard-disable it with `REDDIT_DISABLE_SCRAPE_FALLBACK=true`.

The remaining degraded fallbacks are disabled by default because they have inconsistent availability and can return incomplete media:

```bash
ENABLE_PUBLIC_INSTANCE_FALLBACK=true
REDDIT_PUBLIC_INSTANCE_BASES=https://your-redlib.example
ENABLE_PUBLIC_INSTANCE_DISCOVERY=false
ENABLE_MIRROR_FALLBACK=false
ENABLE_LEGACY_SCRAPE_FALLBACK=false
```

If the official gateway is not configured or unavailable, the UI shows a clear bounded failure state with Retry and an “Open on Reddit” escape hatch instead of an endless skeleton. Already-loaded content stays on screen during a failed refresh. The header shows a small status pill (`Reader mode` vs `Official API`) so it is always clear which source is serving content.

### Gateway status

`GET /api/status` is available through Vercel, Cloudflare Pages, Render/Node, and local Vite development. It returns only safe operational state: whether OAuth is configured, its non-secret mode, whether an access token is cached, enabled degraded fallbacks, and the response-cache entry count. It is not an upstream liveness check and never returns OAuth values or credentials.

Use it after a deployment before testing a real listing. A healthy configured environment reports `"status": "ready"`; an unconfigured gateway reports `"status": "degraded"` and will only have its bounded degraded path available.

## Local development

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. `/api/reddit/*` and `/api/status` are handled by `viteRedditProxy.ts`, using the same shared proxy core as production.

## Deploy

The shared gateway core is `api/redditProxy.ts`.

- **Vercel:** `api/reddit.ts` provides the same-origin serverless route; `api/status.ts` exposes safe configuration status.
- **Cloudflare Pages:** `functions/api/reddit/[[path]].ts` provides the Pages Function; `functions/api/status.ts` exposes safe configuration status.
- **Render / Node:** `fly-proxy/server.mjs` exposes `/api/reddit/*`, `/api/status`, and `/healthz`; `render.yaml` includes the required secret placeholders.

Set `VITE_REDDIT_API_BASES=/api/reddit` for a frontend and configure the OAuth secrets in the environment of the server that serves that route. There is no required cross-host proxy chain.

## Tests

```bash
npm test
npm run test:components
npm run build
npm run test:e2e
```

The Node tests cover proxy path validation and payload parsing. Component and end-to-end tests cover feed rendering and failure/retry behavior.

## Product features

- Subreddit, user, search, and custom feeds
- Sort controls, flair filters, cursor pagination, and keyboard feed navigation
- Text, galleries, Reddit-hosted video, and external embeds
- Threaded comments with collapse/expand controls
- Video shorts mode
- Local saved posts, history, themes, and layout preferences
