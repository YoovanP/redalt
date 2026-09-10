# RedAlt Project Memory

Last reviewed: 2026-09-10.

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
            ├─ official Reddit OAuth API (when credentials are configured)
            └─ auto-enabled bounded scrape path otherwise:
                 old.reddit HTML → Reddit RSS
                 → RSS-to-JSON mirrors → (auto) public instances → (opt-in) mirror
```

- `src/lib/redditApi.ts` defaults to `/api/reddit` and ALWAYS keeps it as the
  first candidate; `VITE_REDDIT_API_BASES` appends additional owned bases after
  it and can never replace the same-origin boundary. The browser does not hop
  through public Render/Pages deployments. **Incident (2026-09-10)**: the Vercel
  project env had `VITE_REDDIT_API_BASES` set to `redalt-vercel.onrender.com`
  and `redalt.pages.dev`, and the old resolver treated that as a replacement.
  Both hosts were dead, so every browser served zero posts ("Posts are
  temporarily unavailable. This request took too long") while
  `https://redalt.vercel.app/api/reddit` answered 200 to any direct probe —
  which is why months of gateway-level probing missed it. Symptom worth
  remembering: `/api/status` still returns 200 (it is fetched same-origin
  directly) while no `/api/reddit` request ever targets the app's own origin.
  Verify frontend routing with a real browser, not curl. Tests:
  `tests/reddit-base-candidates.test.ts`.
- **Without OAuth, the gateway auto-enables the old.reddit/RSS scrape path,
  two RSS-to-JSON mirrors (`feed2json.org`, then `rss2json.com`) when direct RSS
  fails, and the public-instance fallback** (`legacyScrapeFallbackEnabled`:
  explicit `ENABLE_LEGACY_SCRAPE_FALLBACK` true/false wins;
  `REDDIT_DISABLE_SCRAPE_FALLBACK=true` hard-disables; else auto when
  `getOfficialOAuthMode(env) === 'none'`). Public instances are attempted only
  after RSS fails and can be disabled with `ENABLE_PUBLIC_INSTANCE_FALLBACK=false`.
  `redlib.ducks.party` is first in the static list, but shared instances are
  intermittent. Anonymous www.reddit.com
  JSON is WAF-blocked and public Redlib instances are largely behind
  Anubis/Cloudflare walls, so both are last resorts and the anonymous JSON
  attempt is skipped entirely in scrape mode.
- **Both mirrors are anonymous third-party services and are per-feed flaky**
  (`feed2json` answered 200 with `{"err":"Error processing feed"}` for 6 of 8
  subreddits in one measured run; `rss2json` served 4 of those 6 but caps
  anonymous conversions at ten items). Mitigations in `buildMirrorRssCandidates`
  and `fetchMirrorWithRetry` (mirror work only — never the Reddit-owned path):
  each mirror walks reduced query variants (drop `limit`; for `/search.rss`
  keep only `q` and `t`, since `sort`/`type` are rejected and a query-free
  search feed is never usable), and the whole candidate list runs a second
  round after `MIRROR_RETRY_DELAY_MS`. Per-mirror calls use
  `MIRROR_REQUEST_TIMEOUT_MS` (5s) and stay inside the listing/detail deadline.
  A mirror-served search is relevance-ordered because Reddit's RSS search
  ignores the reader's sort filter; mirror listings drop pagination cursors.
- **Both mirrors throttle the shared anonymous budget, so the candidate walk
  must stop the moment one says so** (`fetchMirrorWithRetry` returns as soon as
  a probe reports `throttled`). `feed2json` answers a bare 429; `rss2json`
  answers 200 with `status: "error"` and a message like "You are converting new
  feeds in a very short period of time" — `isMirrorRateLimitMessage` matches the
  stable words, not one exact sentence (an early version matched "too quickly"
  and never fired, so the cooldown silently did nothing). The offending mirror
  is parked for `MIRROR_THROTTLE_COOLDOWN_MS` (60s) and skipped entirely while
  cooling down; the two mirrors keep independent budgets. Measured effect:
  mirror calls for ten listing probes dropped from 92 to 21, and listing
  success rose from 10% to 40% at the same moment.
- **A cached deployment can hide a dead mirror path for a while**: Vercel's
  function instances hold `SUCCESS_RESPONSE_CACHE_TTL_MS` (10 min) and the CDN
  `s-maxage` holds longer, so a probe can keep returning 200 from cache after
  the mirrors have started throttling. Confirm a deployment change with a
  cache-busting `cb=` query parameter as well as the headers.
- **Serve-stale is the outage backstop**: expired successes stay in the
  instance cache for `SUCCESS_RESPONSE_STALE_MAX_AGE_MS` (1h) and are served
  with `X-RedAlt-Cache: stale` (short `Cache-Control`) when every live source
  fails — except for explicit upstream 429s, whose Retry-After must reach the
  client for the retry countdown. Both the normal failure end and the
  Reddit-circuit-cooling-down early return go through this stale lookup, and
  both need testing (the early return is easy to reach with different cache
  keys by accident).
- **Stage timeouts are budgeted against the 10s/12s request deadlines**: HTML
  3s + RSS 3s + mirror calls 3.5s. When Reddit hangs instead of answering a
  fast 403, the mirrors must still get runway before the deadline aborts the
  remaining stages. Do not raise a stage timeout without re-adding up the budget.
- **Client detail prefetch** (`prefetchPostDetail` in `src/lib/redditApi.ts`):
  hover/focus on post titles, comments links, and j/k keyboard focus starts
  the detail request early; the detail page consumes it via
  `fetchPostDetailWithPrefetch`. Bounded LRU of 6, deduped in flight, skipped
  when `document.hidden` or `navigator.connection.saveData`, failures resolve
  to null and fall through to a live fetch. Tests live in
  `tests/detail-prefetch.test.ts` (vitest; cannot run under `node --test`
  because `src/lib/redditApi.ts` reads `import.meta.env`).
- **Optional operator key**: `REDDIT_RSS2JSON_API_KEY` sends
  `api_key&count=50` to rss2json, lifting the anonymous ten-item cap so
  mirror-served feeds paginate (synthetic `after` requires more items than the
  page size). Unverified against a real key — the docs state `count` requires
  one; measure actual behavior before relying on it.

- **Self-serve app registration is closed** (Responsible Builder Policy, late
  2025): the prefs/apps form is a zombie and new client ids/secrets are not
  issued. As an opt-in the gateway supports the anonymous installed-app grant
  (`REDDIT_ANON_CLIENT_ID`, mode `anon-client`): a secret-less token exchange
  with a shared third-party client id. Unsupported by Reddit, may be rotated
  at any time; used at the operator's own risk.
- **When patching this file, do not write `Basic ` or `Bearer ` literals
  through the patch tool** — its secret redaction mangles them to `***` in
  the written file. Existing occurrences are fine; only new/replaced lines
  are affected.
- **Reddit's WAF blocks an IP for ~2 minutes after a burst of ~4 rapid
  requests.** All requests to Reddit-owned hosts (reddit.com, redd.it,
  redditstatic.com, redditmedia.com) flow through one serialized queue with a
  300ms minimum spacing (`paceRedditOwnedRequest`), and a 90-second circuit
  breaker (`markRedditOwnedBlock`) short-circuits scrape requests to a
  structured 403 after any 403/429/451 from old.reddit or RSS. Do not bypass
  the pacer when adding new scrape fetches.
- Discovery endpoints (`/subreddits/search.json`, `/users/search.json`,
  `/api/search_reddit_names.json`) map to old.reddit `/subreddits/search` and
  `/users/search` in `buildPublicHtmlPath`.
- `fetchViaOldRedditHtml` must NOT re-run `enrichCommentThreadMediaFromOldReddit`
  (it re-fetches the same page and can overwrite a good parse with a degraded
  one). Enrichment is only for payloads that came from other sources.
- Feed calls have individual and whole-request deadlines. The client attempts
  at most two configured bases and does not repeat a full retry cycle.
- `usePostListingFeed` keeps already-loaded posts visible when a reload fails
  (posts are only cleared when the sourceKey changes); SubredditPage/HomePage
  show an inline `.feed-refresh-error` banner instead of a full-screen error.
- `PostDetailPage` uses one detail request. Media recovery is user-triggered
  ("Improve media", bounded); opening a post never starts a repair fanout.
- Error states are actionable: feed/detail failures show Retry and an Open on
  Reddit escape hatch. Skeletons include visible status text.
- Reddit `Retry-After` travels through the shared gateway and client; failed
  pagination pauses until deliberately retried.
- Search fans out into three upstream calls; `fetchGlobalSearch` remembers
  recent query/filter combinations in a 30-minute sessionStorage cache so
  toggling filters does not re-press the upstream source. Matched search posts
  are re-sorted client-side for `new` (created_utc desc) and `top` (score
  desc) because Reddit's RSS search endpoints ignore the sort param when a
  mirror serves the response; `hot`/`comments`/`relevance` keep upstream
  order. Tests: `tests/search-resort.test.ts` (vitest only — the module reads
  `import.meta.env`).
- Feeds persist a per-source snapshot in sessionStorage
  (`redalt.feedSnapshot`) and hydrate it instantly on mount, refreshing in the
  background. `usePostListingFeed` also prefetches the next page ~2.5s after
  the initial load into an in-memory map so "load more" is instant; prefetch
  failures stay silent and pagination falls back to a direct fetch.

## Media rendering notes

- Images with unknown dimensions render at natural size (`.post-image-natural`,
  `MediaShell natural`) instead of a guessed 16:9 letterbox. Galleries get the
  same treatment per item.
- `VideoMedia` must NOT gate hls.js on
  `video.canPlayType('application/vnd.apple.mpegurl')` — several Chromium
  builds report "maybe" without playing HLS natively, which silently leaves
  the video with NO_SOURCE. Attach hls.js whenever `Hls.isSupported()`;
  `<source>` children remain as the Safari fallback.
- The App header shows a gateway status pill (`Reader mode` / `Official API`)
  from `GET /api/status`, refreshed every 5 minutes and on window focus.

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

Public instances auto-enable when OAuth is unconfigured, but all public sources
are compatibility paths with slower, less reliable media and HTML-dependent
parsing. Dynamic instance discovery and AllOrigins remain disabled by default.

- `ENABLE_PUBLIC_INSTANCE_FALLBACK=false` opts out of public-instance use.
- `REDDIT_PUBLIC_INSTANCE_BASES` gives operator-provided instances priority.
- `ENABLE_PUBLIC_INSTANCE_DISCOVERY=true` allows dynamic instance-list lookup.
- `ENABLE_MIRROR_FALLBACK=true` enables AllOrigins.
- The two RSS-to-JSON mirrors need no configuration: they run inside the
  auto-enabled scrape path, and `REDDIT_DISABLE_SCRAPE_FALLBACK=true` removes
  them along with the rest of that path.
- `ENABLE_LEGACY_SCRAPE_FALLBACK=true|false` forces old-Reddit HTML + RSS
  scraping on/off; otherwise it auto-enables when OAuth is unconfigured
  (`REDDIT_DISABLE_SCRAPE_FALLBACK=true` is the hard off-switch).

When OAuth is configured, first verify its credentials, user agent, and
deployment logs before relying on scrape fallbacks — the official API is
strictly more reliable.

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

### Reliability layers (2026-09-10)

Order of defense, all keyed by the success-cache `cacheKey`
(`${mediaPref}:${cleanPath}`):

1. Fresh in-instance cache (10 min) → `X-RedAlt-Cache: hit`.
2. Single-flight coalescing: `inFlightUpstreamRequests` joins concurrent
   identical requests onto one upstream journey (stored promise never
   rejects — `.catch(() => upstreamUnavailableResponse())`) so N concurrent
   users cost one source journey.
3. Live source chain (official OAuth → scrape → mirrors → instances).
4. Instance-cache serve-stale (1h window, `X-RedAlt-Cache: stale`) on any
   failure except an explicit upstream 429.
5. CDN directives: successes advertise `max-age=30, s-maxage=120,
   stale-while-revalidate=300, stale-if-error=3600` via `SUCCESS_CACHE_CONTROL`;
   the OAuth path keeps `private` (`OAUTH_SUCCESS_CACHE_CONTROL`) because a
   user-authorized refresh token could surface user-scoped payloads through an
   allowed path — edge caches must not pin those.

Vercel's edge honors `stale-while-revalidate`/`stale-if-error`, so a Reddit
block window now rides out even on cold lambda instances. When editing the
OAuth cache-control line, keep `private` — the `public` unification elsewhere
does NOT apply to it (a subagent once changed it and the deviation was caught
in review, not in tests).

`enrichFlatDetailFromOldRedditHtml` upgrades flat detail payloads (served from
`reddit-rss` or `reddit-rss-json-proxy`) with one bounded old.reddit HTML read
(3.5s, pacer-serialized, browser UA matching the main HTML journey) when the
circuit breaker is closed: parsed comments replace the flat ones ONLY on
strictly better payload quality, or equal quality with strictly more
top-level comments (`X-RedAlt-Enriched: old-reddit-html`). It must never call
`markRedditOwnedBlock`/`markRedditHtmlBlock` — the attempt is opportunistic
and must not open the breaker for the reader; a broken second journey is what
proves the breaker stayed closed in tests. Do not revert this gate.

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

- `npm test` (in a sandboxed shell where `npm test` cannot spawn per-file
  workers, use `node --test --test-isolation=none tests/*.test.mjs`)
- `npm run test:components`
- `npx tsc -b --pretty false`
- `npm run build`
- `$env:PLAYWRIGHT_PORT='5191'; npm run test:e2e`
- `node --check fly-proxy/server.mjs`
- `git diff --check`

Probe `GET /api/status` first, then the gateway directly for a feed, search,
and detail thread. Check status, JSON content type, source header
(`X-RedAlt-Source: official-oauth` with OAuth, `X-RedAlt-Fallback:
old-reddit-html` otherwise), payload renderability, and response time.
When the live gateway answers from `reddit-rss` (Reddit is currently
rate-limiting the deployment IP), run `node scripts/probe-mirror-fallbacks.mjs`
locally to verify the mirror fallback still works — it forces the Reddit-owned
path to fail and reports which mirror served each path. To compare fallback
strategies or measure mirror health over time, run
`node scripts/bench-mirror-fallbacks.mjs` (old vs new strategy, success rate,
latency, and mirror request count) and
`node scripts/probe-mirror-capacity.mjs` (rss2json keyed call, feed2json
repeat-throttle pattern). Then browser-check
initial feed, retry UI, rate-limit countdown, load more, detail/comments,
explicit media repair, search, and shorts mode. A live
end-to-end browser pass exists at `scripts/live-check.mjs` (needs the dev
server running; budget for Reddit's per-IP burst limits — keep requests
spaced and expect transient blocks during heavy repeated runs).

## Maintenance rules

- Diagnose live request/payload behavior before styling around an error.
- Keep `api/redditProxy.ts` as the behavior source of truth; adapters remain
  thin.
- The old.reddit/RSS scrape path is the default unauthenticated source — treat
  its parser changes as production work with focused parser tests and hard
  request caps. Public-instance/mirror changes remain opt-in compatibility
  work.
- Keep credentials server-only and never log or return them.
- On Windows/PowerShell, use `-LiteralPath` for
  `functions/api/reddit/[[path]].ts` because brackets are wildcard syntax.
