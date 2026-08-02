# RedAlt

RedAlt is a React + TypeScript Reddit reader with a Reddit-style feed, media view, comments, saved posts, history, custom feeds, and video mode.

## Reliability architecture

The browser talks to one same-origin gateway: `/api/reddit`. It does not rotate through public proxies during an ordinary feed load.

```text
Browser → /api/reddit → official Reddit OAuth API
                         ↓ only if explicitly enabled
                   bounded degraded fallbacks
```

- Feed requests have a short overall deadline and are aborted when the user changes route or retries.
- Post detail loads comments and the primary post in one request. Media repair is explicit instead of silently fanning out into several extra feed requests.
- The gateway prefers the official OAuth API, validates payload shape before returning it, caches successful JSON briefly, and shares one cold OAuth token exchange across concurrent requests.
- Public Redlib/Teddit/mirror scraping is opt-in and bounded. It is a degraded compatibility mode, not the normal production path.
- `Retry-After` is carried from Reddit through the gateway to a visible countdown. Failed pagination pauses until the reader deliberately retries it, rather than repeatedly requesting the same cursor.

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

### Degraded fallbacks

These are disabled by default because they have inconsistent availability and can return incomplete media. Enable them only if you intentionally operate and monitor them:

```bash
ENABLE_PUBLIC_INSTANCE_FALLBACK=true
REDDIT_PUBLIC_INSTANCE_BASES=https://your-redlib.example
ENABLE_PUBLIC_INSTANCE_DISCOVERY=false
ENABLE_MIRROR_FALLBACK=false
ENABLE_LEGACY_SCRAPE_FALLBACK=false
```

If the official gateway is not configured or unavailable, the UI shows a clear bounded failure state with Retry and an “Open on Reddit” escape hatch instead of an endless skeleton.

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
