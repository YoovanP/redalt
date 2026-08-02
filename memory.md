# RedAlt Project Memory

Last reviewed: 2026-08-02.

## Product and limits

RedAlt is a public, read-only Reddit reader built with React, TypeScript, and
Vite. It supports subreddit/user/search feeds, post details and comments,
media, custom feeds, themes, saved posts, history, and a media-first shorts
mode. Browser personalization is local only.

It is not an account client: there is no Reddit login, voting, posting,
commenting, moderation, messaging, subscription sync, or account-library sync.

## Current request architecture

```text
React browser
  └─ /api/reddit (one same-origin request boundary)
       └─ api/redditProxy.ts
            ├─ official Reddit OAuth API (normal production path)
            └─ explicitly enabled degraded fallbacks only
```

- `src/lib/redditApi.ts` defaults to `/api/reddit`. Operators can configure
  additional owned bases with `VITE_REDDIT_API_BASES`, but the browser does not
  automatically hop through public Render/Pages deployments.
- Feed calls have individual and whole-request deadlines. The client attempts
  at most two configured bases and does not repeat a full retry cycle.
- `usePostListingFeed` supplies an `AbortSignal`; route changes and React
  development re-mounts cancel stale work instead of allowing duplicate loads.
- `PostDetailPage` uses one detail request. If media metadata is incomplete,
  recovery is a user-triggered “Improve media” action with at most two bounded
  repair attempts; opening a post never starts a five-request repair fanout.
- Error states are actionable: feed/detail failures show Retry and an Open on
  Reddit escape hatch. Skeletons include visible status text.
- Reddit `Retry-After` data travels through the shared gateway and client. A
  rate-limited source is held until its exact retry window ends; generic
  connection failures remain manually retryable. Failed pagination pauses its
  observer and shows an inline countdown/retry surface instead of reissuing the
  same cursor automatically.

## Shared server gateway

`api/redditProxy.ts` is the canonical gateway core. It validates allowed Reddit
paths, strips RedAlt-only query parameters, validates response shape before
returning JSON, caches successful responses briefly, shares concurrent OAuth
token exchanges, and normalizes upstream 429 responses into structured JSON.

Normal server behavior:

1. Use `REDDIT_OAUTH_ACCESS_TOKEN`, or exchange `REDDIT_CLIENT_ID` and
   `REDDIT_CLIENT_SECRET` for an OAuth token. `REDDIT_REFRESH_TOKEN` is
   supported for user-authorized access.
2. Fetch the requested path from `https://oauth.reddit.com` with an honest
   `REDDIT_PROXY_USER_AGENT`.
3. Use a small anonymous direct request only as best-effort degraded behavior.
4. Return a structured, retryable failure before the request deadline if no
   usable source responds.

`getRedditProxyStatus` is the safe, configuration-level status surface. It
never exposes a credential or token. Adapters serve it at `GET /api/status`;
`ready` means OAuth is configured, while `degraded` means the gateway lacks the
normal OAuth path. It is not a Reddit upstream liveness probe.

The OAuth values are server-only and must never use a `VITE_` prefix. Local
Vite development loads them only in `viteRedditProxy.ts`'s Node process.

### Explicit degraded fallback mode

Public instances, dynamic instance discovery, AllOrigins, and old-Reddit/RSS
scraping are disabled by default. They are compatibility paths with slower,
less reliable media and HTML-dependent parsing.

- `ENABLE_PUBLIC_INSTANCE_FALLBACK=true` enables bounded public-instance use.
- `REDDIT_PUBLIC_INSTANCE_BASES` gives operator-provided instances priority.
- `ENABLE_PUBLIC_INSTANCE_DISCOVERY=true` allows dynamic instance-list lookup.
- `ENABLE_MIRROR_FALLBACK=true` enables AllOrigins.
- `ENABLE_LEGACY_SCRAPE_FALLBACK=true` enables old-Reddit HTML and RSS parsing.

Do not enable these just to hide an OAuth/deployment problem. First verify the
official gateway's credentials, user agent, and deployment logs.

## Runtime adapters

- `api/reddit.ts` and `api/status.ts`: Vercel adapters. The former calls the
  shared core directly; the latter exposes safe gateway configuration.
- `functions/api/reddit/[[path]].ts` and `functions/api/status.ts`: Cloudflare
  Pages adapters for requests and safe gateway configuration.
- `viteRedditProxy.ts`: local Vite adapter that loads private `.env.local`
  values without putting them in the browser bundle; it also serves `/api/status`.
- `fly-proxy/server.mjs`: Render/Node adapter with `/healthz` and `/api/status`;
  it imports the shared core and its deployment root must include `api/redditProxy.ts`.

All adapters should return structured JSON failures rather than allowing a
runtime exception to become an opaque host-level 500.

## Main code surfaces

- `src/lib/redditApi.ts`: API paths, timeouts, cache/payload merge, source
  selection, detail media repair.
- `src/lib/usePostListingFeed.ts`: shared feed lifecycle, pagination,
  cancellation, and retry.
- `src/lib/normalizePost.ts`: converts Reddit-shaped data to renderable post
  data. Fix data quality here or in the gateway before changing cards.
- `src/components/media/RenderMedia.tsx`: chooses media renderers.
- `src/pages/SubredditPage.tsx`, `UserPage.tsx`, `HomePage.tsx`, and
  `PostDetailPage.tsx`: user-facing loading/error/recovery flows.
- `src/components/StateView.tsx`: coherent visible loading, empty, and error
  states.

## Deployment notes

Set `VITE_REDDIT_API_BASES=/api/reddit` for the frontend served by a gateway.
Add these secrets/values to that gateway's environment:

```bash
REDDIT_PROXY_USER_AGENT="web:RedAlt:0.2.0 (public read-only client)"
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
# optional
REDDIT_REFRESH_TOKEN=...
```

`render.yaml` declares the relevant secret placeholders. Cross-host source
chains are no longer required. A previous Vercel deployment returned
`FUNCTION_INVOCATION_FAILED` even for an invalid path; validate a fresh deploy
with `/api/reddit/not-allowed` (expected 400) before treating it as healthy.

## Verification matrix

Run after gateway or UI changes:

- `npm test`
- `npm run test:components`
- `npx tsc -b --pretty false`
- `npm run build`
- `$env:PLAYWRIGHT_PORT='5191'; npm run test:e2e`
- `node --check fly-proxy/server.mjs`
- `git diff --check`

Probe `GET /api/status` first, then an OAuth-configured deployment directly for
a feed, search, and detail thread. Check status, JSON content type,
`X-RedAlt-Source: official-oauth`, payload renderability, and response time.
Then browser-check initial feed, retry UI, rate-limit countdown, load more,
detail/comments, explicit media repair, search, and shorts mode.

## Maintenance rules

- Diagnose live request/payload behavior before styling around an error.
- Keep `api/redditProxy.ts` as the behavior source of truth; adapters remain
  thin.
- Treat scraper and public-instance changes as opt-in compatibility work, with
  focused parser tests and hard request caps.
- Keep credentials server-only and never log or return them.
- On Windows/PowerShell, use `-LiteralPath` for
  `functions/api/reddit/[[path]].ts` because brackets are wildcard syntax.
