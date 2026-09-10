# RedAlt

RedAlt is a React + TypeScript Reddit reader with a Reddit-style feed, media view, comments, saved posts, history, custom feeds, and video mode.

## Reliability architecture

The browser talks to one same-origin gateway: `/api/reddit`. It does not rotate through public proxies during an ordinary feed load.

```text
Browser → /api/reddit → official Reddit OAuth API (when configured)
                         ↓ otherwise (bounded, auto-enabled)
                       old.reddit HTML → Reddit RSS → RSS-to-JSON mirrors
                         ↓ optional, off by default
                       public instances / mirror / anonymous JSON
```

- OAuth is always the preferred source when credentials are configured.
- **Without credentials the gateway auto-enables the bounded old.reddit/RSS scrape path** — the one unauthenticated source that works in practice. If direct RSS is blocked or rate-limited, two bounded RSS-to-JSON mirrors (`feed2json.org`, then `rss2json.com`) run through reduced query variants and one retry round before the public-instance fallback. Anonymous `www.reddit.com` JSON is WAF-blocked from servers and remains a last resort.
- All requests to Reddit-owned hosts flow through a single serialized queue with minimum spacing, and once Reddit blocks the IP the gateway opens a 90-second circuit breaker instead of piling more requests onto the block.
- Search results re-sort on the client for orderable sorts: Reddit's RSS search endpoints ignore `sort`, so when a mirror serves the response the reader locally re-orders `new` (by date) and `top` (by score) results to match what was asked.
- Feed requests have a short overall deadline and are aborted when the user changes route or retries. Already-loaded posts stay visible when a refresh fails (inline banner instead of a full-screen error).
- The gateway coalesces concurrent identical requests into one upstream journey, and every success advertises browser freshness plus `stale-while-revalidate=300` / `stale-if-error=3600`, so the CDN keeps serving (and quietly refreshing) content instead of stampeding into a Reddit block window.
- Post detail loads comments and the primary post in one request. Media repair is explicit instead of silently fanning out into several extra feed requests. Hovering or focusing a post title / comments link starts the detail request early (a bounded two-request-deep LRU that respects `Save-Data`), so opening a post usually renders from an already-settled request.
- The gateway prefers the official OAuth API, validates payload shape before returning it, caches successful JSON briefly, and shares one cold OAuth token exchange across concurrent requests.
- `Retry-After` is carried from Reddit through the gateway to a visible countdown. Failed pagination pauses until the reader deliberately retries it, rather than repeatedly requesting the same cursor.
- Search fans out into three upstream calls but recent query/filter combinations are remembered for the session so toggling filters does not re-press the upstream source.

Reddit access must use the developer-documented authorization flow and may be rate-limited. See the [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms) and [API documentation](https://www.reddit.com/dev/api/).

## Configure the gateway

Copy `.env.example` to `.env.local` for local development. Keep the browser on its local gateway:

```bash
VITE_REDDIT_API_BASES=/api/reddit
```

`/api/reddit` is always the first candidate the browser tries, and any other owned origin listed here is appended after it. The variable is additive on purpose: a deployment that points it at a retired Render/Pages host keeps working because the same-origin gateway is still attempted first. The browser never hops through third-party proxies.

Create a Reddit OAuth application at <https://www.reddit.com/prefs/apps>, then set these **server-only** variables. Do not prefix them with `VITE_`.

```bash
REDDIT_PROXY_USER_AGENT="web:RedAlt:0.2.0 (public read-only client)"
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
# Optional for user-authorized access:
REDDIT_REFRESH_TOKEN=...
```

`REDDIT_OAUTH_ACCESS_TOKEN` is available as a short-lived development override, but client credentials or a refresh token is the normal deployment setup. The Vite development gateway loads these values only in Node; they are not bundled into the browser.

### Anonymous installed-app grant (at your own risk)

Reddit closed self-serve app registration in late 2025, so new developers cannot create their own client id/secret. As an explicit opt-in, the gateway also supports the anonymous installed-app grant: set `REDDIT_ANON_CLIENT_ID` to a client id shipped by a third-party client (no secret required) and the gateway will request an anonymous token. This is NOT sanctioned by Reddit's API terms, the credential can be rotated at any time, and overuse can get the shared credential (or your IP) limited. Personal, read-only use only.

```bash
REDDIT_ANON_CLIENT_ID=...
# optional
REDDIT_ANON_DEVICE_ID=DO_NOT_TRACK_THIS_DEVICE
```

### Fallbacks

When OAuth is not configured, the gateway automatically uses the bounded old.reddit/RSS scrape path so an out-of-the-box deployment works. OAuth is always preferred when credentials exist. You can force the scrape path on or off explicitly with `ENABLE_LEGACY_SCRAPE_FALLBACK=true|false`, or hard-disable it with `REDDIT_DISABLE_SCRAPE_FALLBACK=true`.

Public instances are auto-enabled when OAuth is not configured and are attempted only after old.reddit/RSS and the RSS-to-JSON mirrors fail. They are still a degraded path because public Redlib instances may be blocked, challenging, or missing media. Set `ENABLE_PUBLIC_INSTANCE_FALLBACK=false` to opt out, or provide an operator-vetted instance:

```bash
# ENABLE_PUBLIC_INSTANCE_FALLBACK=false
# REDDIT_PUBLIC_INSTANCE_BASES=https://your-redlib.example
ENABLE_PUBLIC_INSTANCE_DISCOVERY=false
ENABLE_MIRROR_FALLBACK=false
```

If the official gateway is not configured or unavailable, the UI shows a clear bounded failure state with Retry and an “Open on Reddit” escape hatch instead of an endless skeleton. Already-loaded content stays on screen during a failed refresh. The header shows a small status pill (`Reader mode` vs `Official API`) so it is always clear which source is serving content.

The RSS-to-JSON mirrors are compatibility paths, not peers of the official API. They are anonymous third-party services, so responses can be partial (the `rss2json` free tier returns at most ten items unless an operator key is configured via `REDDIT_RSS2JSON_API_KEY`, which unlocks `count=50`) and a search served by a mirror is relevance-ordered because Reddit's RSS search endpoints ignore the reader's sort filter. Both mirrors rate-limit shared anonymous traffic, so the gateway backs off the moment either one reports throttling instead of retrying into the block.

When every live source fails anyway, the gateway serves the last good response for that exact path from its instance cache, marked `X-RedAlt-Cache: stale`, instead of a hard error (bounded to one hour). An explicit upstream 429 still surfaces as a rate-limit response so the client's retry countdown stays truthful.

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
