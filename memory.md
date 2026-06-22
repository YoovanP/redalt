# RedAlt Project Memory

Last reviewed: 2026-06-17.

This file is a working memory for the RedAlt project. It describes what the
project is, how it works, what it currently achieves, what is known to work,
and what remains fragile or unsupported. Update it when major behavior,
deployment topology, or proxy fallback behavior changes.

## What The Project Is

RedAlt is a public Reddit alternative frontend built with React, TypeScript,
and Vite. It lets users browse Reddit content through RedAlt-controlled proxy
routes instead of calling Reddit directly from the browser.

The core goal is resilience: Reddit frequently blocks shared hosting egress IPs
or returns non-JSON block pages, so RedAlt uses multiple proxy backends and
fallback sources to keep public feeds, search results, media, and comments
usable when one source fails.

RedAlt is not a Reddit account client. It does not implement login, voting,
posting, commenting, inbox, moderation, or account sync. It focuses on public
read-only browsing.

## What It Achieves

- Browses public subreddit feeds, user submitted feeds, global search, and post
  detail pages.
- Renders common Reddit media types: Markdown text, images, galleries,
  Reddit-hosted videos, and known external embeds such as YouTube, Vimeo, and
  RedGIFs when enough metadata exists.
- Provides local-only personalization: themes, feed layout settings, custom
  feed subreddit lists, saved posts, watch history, and media-feed preferences.
- Provides a media-first "shorts" mode for scrolling through image/video-heavy
  feeds.
- Uses several API/proxy targets so one blocked or unavailable backend does not
  immediately break the frontend.
- Converts public-instance HTML/RSS/Atom fallback responses back into the
  Reddit JSON shapes expected by the React app.
- Ships deploy paths for Vercel, Cloudflare Pages Functions, and a Render
  Node proxy service.

## Technology Stack

- Frontend: React 19, TypeScript, Vite, React Router, `react-markdown`, and
  `remark-gfm`.
- Browser state: `localStorage` and `sessionStorage`.
- Serverless/proxy paths:
  - `api/reddit.ts`: Vercel API adapter.
  - `functions/api/reddit/[[path]].ts`: Cloudflare Pages Function adapter.
  - `api/redditProxy.ts`: shared TypeScript proxy core used by the Vercel and
    Cloudflare adapters.
  - `fly-proxy/server.mjs`: standalone Node proxy used by Render.
- PWA pieces: `public/manifest.webmanifest` and `public/sw.js`.

## Main Product Surfaces

- `/`: home page with search, quick subreddit links, recent custom-feed
  subreddits, and a small trending preview from `popular` or `all`.
- `/r/:name`: subreddit feed with sort controls, top-time range support,
  discovered flair filtering, keyboard navigation, scroll restoration,
  infinite/load-more behavior, card layout settings, and media-feed mode.
- `/u/:username` and `/user/:username`: user submitted-post feed with the same
  general listing behavior as subreddit feeds.
- `/search`: post, subreddit, and user search with sort, top range, subreddit
  scoping, NSFW toggle, media-type filtering, and "view more" limits.
- `/r/:name/comments/:id`: post detail, media rendering, top-level comment
  pagination, nested comment rendering, collapse/expand, save/share/open links,
  and watch-history recording.
- `/saved` and `/history`: local saved-post and watch-history library views.

## How Data Flows

The frontend request layer is `src/lib/redditApi.ts`.

1. It builds API paths for Reddit-style JSON endpoints.
2. It chooses proxy bases from `VITE_REDDIT_API_BASES`, or from built-in
   defaults when the env var is missing.
3. Current built-in default order in code is:
   `https://redalt.pages.dev/api/reddit`,
   `https://redalt-vercel.onrender.com/api/reddit`,
   then `/api/reddit`.
4. In Vite dev mode, `/api/reddit` is removed from the default base list unless
   explicitly configured, because the plain Vite server does not provide the
   serverless API route.
5. After a proxy returns valid JSON, the client pins that base for the browser
   session using `sessionStorage` key `redalt.redditApiBase`, with an in-memory
   fallback if storage is unavailable.
6. Network errors, 429, 403, 451, and 5xx responses can clear the session pin
   and put a base on cooldown, allowing the client to try another proxy.
7. Valid payloads are normalized in `src/lib/normalizePost.ts`.
8. `src/components/media/RenderMedia.tsx` chooses the concrete renderer for
   text, image, gallery, video, external embed, or plain link posts.

The README recommends a production order of Render, Cloudflare Pages, then
same-origin. The code's built-in default order currently starts with
Cloudflare Pages, then Render, then same-origin. If the intended production
priority is Render first, set `VITE_REDDIT_API_BASES` explicitly.

## Proxy Behavior

`api/redditProxy.ts` is the shared proxy core for Vercel and Cloudflare Pages.
It only allows public Reddit paths under:

- `/r/`
- `/user/`
- `/search.json`
- `/subreddits/`
- `/users/`
- `/api/search_reddit_names.json`

The proxy strips RedAlt-only query parameters such as `redalt_media` before
calling upstream services. The media preference lets the frontend choose
whether fallback images stay on the public instance host or are rewritten back
to Reddit CDN URLs when possible.

The Vercel adapter can try the Cloudflare Pages proxy first. After that, the
shared proxy attempts:

1. Public alternative frontend instances, including configured instances,
   static known bases, and dynamically fetched Redlib/Libreddit instance lists.
2. Direct Reddit JSON hosts: `www.reddit.com`, `api.reddit.com`, and
   `old.reddit.com`.
3. AllOrigins mirror fallback when enabled.
4. Reddit RSS/Atom fallback for compatible listing and comment routes.

The Render proxy in `fly-proxy/server.mjs` implements the same broad behavior
as a standalone Node HTTP server with `/healthz`, but it is a separate copy and
must be kept in sync manually when proxy fallback logic changes.

## What Works

- The React app has complete route coverage for home, subreddit feeds, user
  feeds, search, post detail, saved posts, and history.
- Subreddit/user listing state is centralized in `usePostListingFeed`, including
  initial load, load-more state, error state, duplicate filtering, and media-mode
  fetching behavior.
- Feed sorting supports `hot`, `new`, `rising`, and `top`, with top-time ranges.
- Subreddit flair filtering works from flairs discovered in already loaded
  posts.
- Search can return posts, subreddits, and users. It supports filters and local
  "view more" expansion by requesting larger limits.
- Post cards support save/unsave, share/copy, opening Reddit discussion, opening
  the original source URL, card modes, open-in-new-tab behavior, long-text
  preview expansion, and scroll restoration.
- Post detail can render a route-provided fallback post while the detail request
  is failing or still loading, so the UI can still show the opened post when it
  was reached from a listing.
- Comments render nested replies and support top-level paging and collapse.
- Local saved posts and watch history work through `localStorage`.
- Custom feed subreddit storage works through `localStorage` and the
  `redalt-custom-feed-update` event.
- UI settings persist through `localStorage` and include theme, autoplay,
  columns, media-feed mode, card mode, sticky header, open-in-new-tab, and
  fallback media-source preference.
- The service worker caches the app shell and successful runtime GET responses,
  including previously fetched Reddit proxy responses.
- The proxy can reject degenerate fallback payloads that only contain title/link
  stubs and no renderable content.
- Public-instance fallback can parse Redlib-style HTML listings and comment
  pages into Reddit-shaped post/comment payloads.
- RSS/Atom fallback supports both `<item>` and `<entry>` formats and locally
  paginates fallback listings when upstream cursors are unavailable.

## What Is Fragile Or Does Not Work

- RedAlt does not support authenticated Reddit actions: login, voting, saving to
  Reddit, commenting, posting, messaging, subscriptions, moderation, or account
  data.
- Reddit OAuth was removed from this codebase. The current model is anonymous
  public browsing through proxies and fallbacks.
- Live deployment health is not guaranteed by the repo. The README lists
  `https://redalt.vercel.app`, `https://redalt.pages.dev`, and
  `https://redalt-vercel.onrender.com`, but this file does not verify their
  current uptime.
- Reddit and public instances can still block requests with 403/451, bot checks,
  CAPTCHA-style pages, Anubis proof-of-work pages, or unexpected HTML. The proxy
  tries to work around this but cannot guarantee every route.
- Public-instance parsing is inherently brittle because it depends on third-party
  HTML structure and public instance availability.
- RSS/Atom fallback is lower fidelity than Reddit JSON or Redlib HTML. It may
  miss media metadata, scores, flair, exact comment counts, gallery structure,
  or nested comments depending on the source feed.
- Search can be partial. On Cloudflare Pages hosts, some block-prone search
  endpoints are skipped by the client, so user search/typeahead behavior can be
  reduced compared with other hosts.
- The browser library is local-only. Clearing browser storage or switching
  browsers/devices loses saved posts, history, custom feeds, and settings.
- The service worker may serve cached runtime responses while offline. This is
  useful for resilience but can make stale Reddit content appear if the network
  is unavailable.
- There is no test script, lint script, or parser test suite in `package.json`.
  The main repo-level verification command is `npm run build`.
- The Render proxy (`fly-proxy/server.mjs`) duplicates large parts of
  `api/redditProxy.ts`. A fix made in only one file can leave one deployment path
  stale.
- Plain Vite local development relies on the remote default proxies unless
  `VITE_REDDIT_API_BASES` is set. The same-origin `/api/reddit` route is not
  available from Vite alone.

## Deployment And Configuration Notes

Important environment variables:

- `VITE_REDDIT_API_BASES`: comma-separated frontend proxy base list.
- `REDDIT_PROXY_USER_AGENT`: user agent sent by proxy requests.
- `ENABLE_PUBLIC_INSTANCE_FALLBACK`: defaults to enabled unless set to `false`.
- `REDDIT_PUBLIC_INSTANCE_BASES`: optional comma-separated preferred public or
  self-hosted fallback instances.
- `ENABLE_MIRROR_FALLBACK`: used by the Render proxy to control AllOrigins
  mirror fallback.

Deployment paths:

- Vercel uses `api/reddit.ts` and `api/redditProxy.ts`.
- Cloudflare Pages uses `functions/api/reddit/[[path]].ts` and
  `api/redditProxy.ts`.
- Render uses `fly-proxy/server.mjs`, `fly-proxy/package.json`, and
  `render.yaml`.

## Verification Notes

Use these checks after meaningful code changes:

- `npm run build`
- Direct proxy probes against representative paths, for example:
  - `/api/reddit/r/popular/hot.json?raw_json=1&limit=8`
  - `/api/reddit/search.json?raw_json=1&type=link&q=mildlyinfuriating`
  - `/api/reddit/r/<subreddit>/comments/<postId>.json?raw_json=1&limit=100`
- Browser checks for:
  - a subreddit feed,
  - load-more behavior,
  - a media-heavy post,
  - a post detail page with comments,
  - search results,
  - saved/history behavior,
  - media-feed mode.

On Windows/PowerShell, use `-LiteralPath` for
`functions/api/reddit/[[path]].ts` because brackets are treated as wildcard
syntax otherwise.

Known local friction on this machine includes occasional Windows/OneDrive or
sandbox-related `spawn EPERM` failures. Re-run the same build or git operation
with the needed permissions before treating that as a code regression.

## Maintenance Rules

- If Reddit loading breaks, inspect direct proxy responses and payload shape
  before changing UI components.
- If fallback content loads but looks wrong, fix normalization or proxy parsing
  first; `PostCard` and `RenderMedia` can only render what normalized payloads
  contain.
- Keep `api/redditProxy.ts` and `fly-proxy/server.mjs` behaviorally aligned for
  proxy fixes.
- Keep `api/reddit.ts` and `functions/api/reddit/[[path]].ts` thin adapters over
  the shared proxy core.
- Prefer direct HTTP probes over browser-only checks when diagnosing Reddit
  proxy issues.
- Add focused parser/build checks before large changes to RSS, Redlib HTML, or
  public-instance fallback behavior.
