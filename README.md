# RedAlt

RedAlt is a modern Reddit alternative frontend built with React + TypeScript + Vite, with multi-backend API proxy support (Vercel, Cloudflare Pages, and Render).

## Deploy Buttons

[![Deploy on Vercel](https://img.shields.io/badge/Deploy_on-Vercel-000000?style=for-the-badge&logo=vercel)](https://vercel.com/new/clone?repository-url=https://github.com/YoovanP/redalt-vercel)
[![Deploy on Cloudflare Pages](https://img.shields.io/badge/Deploy_on-Cloudflare%20Pages-F38020?style=for-the-badge&logo=cloudflare)](https://dash.cloudflare.com/?to=/:account/pages/new)
[![Deploy on Render](https://img.shields.io/badge/Deploy_on-Render-46E3B7?style=for-the-badge&logo=render&logoColor=000)](https://render.com/deploy?repo=https://github.com/YoovanP/redalt)
[![Deploy on Railway](https://img.shields.io/badge/Deploy_on-Railway-7B3FE4?style=for-the-badge&logo=railway&logoColor=fff)](https://railway.app/new)

Notes:
- Vercel and Render links are repo-wired.
- Cloudflare and Railway links open new project flows (you can import either repo there).

## Active Instances

- Frontend (Vercel): https://redalt.vercel.app
- Cloudflare Pages: https://redalt.pages.dev
- Render API Proxy: https://redalt-vercel.onrender.com

## Repository Layout (Both Repos)

This project is actively used across two GitHub repositories:

- `YoovanP/redalt`
  - Primary source and Cloudflare Pages deployment target.
  - Includes Pages Functions proxy in `functions/api/reddit/[[path]].ts`.
- `YoovanP/redalt-vercel`
  - Vercel-facing mirror/fork used for frontend deployment and cross-platform proxy routing.
  - Commonly paired with Render API proxy (`fly-proxy/`).

Both repos run the same app architecture and can be kept in sync.

## How It Works

RedAlt loads Reddit JSON through proxy backends to reduce direct client-side rate-limit/CORS issues.
For production, configure Reddit OAuth credentials on each proxy. Reddit often blocks anonymous JSON
requests from shared hosting egress IPs, so authenticated calls to `oauth.reddit.com` are much more reliable.

### Request Flow

1. Frontend reads `VITE_REDDIT_API_BASES`.
2. For each API call, RedAlt tries bases in order until one succeeds.
3. Responses are normalized and rendered as posts/comments/media.
4. If one backend is blocked/down, fallback continues automatically.

Recommended production chain:

```bash
VITE_REDDIT_API_BASES=https://redalt-vercel.onrender.com/api/reddit,https://redalt.pages.dev/api/reddit,/api/reddit
```

This means:

1. Render proxy as primary
2. Cloudflare Pages proxy as secondary
3. Same-origin Vercel API route as final fallback

Proxy env vars:

```bash
REDDIT_CLIENT_ID=<reddit app client id>
REDDIT_CLIENT_SECRET=<reddit app client secret>
REDDIT_PROXY_USER_AGENT="RedAlt/1.0 by your-reddit-username"
ENABLE_PUBLIC_INSTANCE_FALLBACK=true
REDDIT_PUBLIC_INSTANCE_BASES=
```

Use a Reddit script/web app credential and keep these values server-side only.

### Proxy Fallbacks

Each proxy tries upstreams in this order:

1. Reddit OAuth API, when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are configured.
2. Same-project proxy fallback, where available.
3. Direct Reddit JSON hosts: `www.reddit.com`, `api.reddit.com`, and `old.reddit.com`.
4. AllOrigins mirror fallback, when enabled.
5. Public alternative frontend instances for post JSON.

The public-instance fallback is enabled by default with `ENABLE_PUBLIC_INSTANCE_FALLBACK=true`. It only runs for public post/listing JSON routes such as subreddit feeds, user submitted feeds, search results, and post detail threads. The proxy validates that the response is Reddit-shaped JSON before returning it to the app, so HTML block pages or incompatible frontend responses are skipped.

Built-in public fallback sources include Redlib, Libreddit, Teddit, Eddrit, and Troddit. Redlib and Libreddit instance lists are refreshed from their public JSON lists and cached briefly by the proxy; the other projects are included as static public bases because their public instance metadata is less consistent.

You can prefer your own public or self-hosted instances with a comma-separated list:

```bash
REDDIT_PUBLIC_INSTANCE_BASES=https://redlib.example.com,https://teddit.example.com
```

Set `ENABLE_PUBLIC_INSTANCE_FALLBACK=false` to disable this behavior.

## Features

- Subreddit feed and post detail views
- Sort controls (`hot`, `rising`, `new`, `top`) with top time range support
- Multi-theme UI with persisted user settings
- Multi-subreddit custom feed builder
- Video shorts mode with infinite loading
- Rich media support:
  - Self/text posts with Markdown + GFM
  - Images
  - Gallery/carousel posts
  - Reddit-hosted videos
  - External embeds (including RedGIFs when metadata is available)
- Flair filtering (including discovered flairs from loaded posts)
- Threaded comments with collapse/expand and paged top-level loading
- Saved posts and watch history library

## Technologies Used

### Frontend

- React
- TypeScript
- Vite
- React Router
- `react-markdown` + `remark-gfm`

### Backend/Proxy Runtime

- Node.js (Render proxy via `fly-proxy/server.mjs`)
- Cloudflare Pages Functions (`functions/api/reddit/[[path]].ts`)
- Vercel Serverless API routes (`api/reddit/*`)

### Deployment Platforms

- Vercel (frontend + optional API fallback)
- Cloudflare Pages (frontend/proxy path support)
- Render Web Service (dedicated Reddit proxy)
- Railway (optional host for proxy/frontend)

## Local Development

```bash
npm install
npm run dev
```

Open: http://localhost:5173 (or next available Vite port)

### Local Environment

Create `.env.local` as needed:

```bash
VITE_REDDIT_API_BASES=/api/reddit
```

You can also set multiple proxies:

```bash
VITE_REDDIT_API_BASES=https://proxy-a.example.com/api/reddit,https://proxy-b.example.com/api/reddit,/api/reddit
```

## Build

```bash
npm run build
```

## Deploying by Platform

### Vercel

```bash
npm i -g vercel
vercel login
vercel --prod
```

Set `VITE_REDDIT_API_BASES` in Project Settings -> Environment Variables.
Also set `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_PROXY_USER_AGENT`, and `ENABLE_PUBLIC_INSTANCE_FALLBACK` for the API route.

### Render (Proxy Service)

Use `fly-proxy/` as root service directory.

- Runtime: Node
- Build Command: `npm install --omit=dev`
- Start Command: `npm run start`
- Health Check Path: `/healthz`
- Env: `ENABLE_MIRROR_FALLBACK=true`
- Env: `ENABLE_PUBLIC_INSTANCE_FALLBACK=true`
- Env: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_PROXY_USER_AGENT`

You can deploy via [render.yaml](render.yaml) blueprint or dashboard setup.

Health endpoint:

- `GET /healthz` -> `{ "ok": true }`

### Cloudflare Pages

- Connect repo in Cloudflare Pages.
- Build command: `npm run build`
- Output directory: `dist`
- Ensure Functions are enabled so `functions/api/reddit/[[path]].ts` is active.
- Set `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_PROXY_USER_AGENT`, and `ENABLE_PUBLIC_INSTANCE_FALLBACK` as Pages environment variables.

### Railway

- Create a new Railway project from this repo.
- For proxy deployment, set service root to `fly-proxy`.
- Use same Node build/start commands as Render.

## Project Notes

- Uses Reddit `raw_json=1` endpoints for cleaner payload parsing.
- API failures (403/451/etc.) are mapped to user-friendly UI messages.
- Cloudflare Pages and Vercel routes include CORS-aware proxy handling.
- Local development can fall back to direct Reddit API when proxy routes are unavailable.
