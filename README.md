# RedAlt

Minimal Reddit alternative frontend built with React + TypeScript + Vite, powered by public Reddit JSON endpoints.

## Features

- Subreddit feed and post detail views
- Sort controls (`hot`, `rising`, `new`, `top`) with top time range
- Multi-theme UI with saved user settings
- Multi-subreddit custom feed builder
- Video shorts mode with infinite loading
- Media support:
  - Self/text posts (Markdown + GFM rendering)
  - Images
  - Gallery / carousel posts
  - Reddit-hosted videos
  - External embeds (including RedGIFs when metadata is available)
- Flair filter dropdown (all available + discovered flairs)
- Threaded comments with reply hierarchy, collapse/expand replies, and paged top-level comments

## Tech Stack

- React
- TypeScript
- Vite
- React Router
- react-markdown + remark-gfm

## Getting Started

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Build

```bash
npm run build
```

## Deployment (Vercel)

1. Install and login to Vercel CLI.
2. Deploy production from project root.

```bash
npm i -g vercel
vercel login
vercel --prod
```

### API Proxy Base Configuration

The frontend reads Reddit proxy bases from `VITE_REDDIT_API_BASES`.

- Default: `/api/reddit`
- Multiple bases are supported as a comma-separated list.
- Useful for switching proxy providers without code changes.

Examples:

```bash
VITE_REDDIT_API_BASES=/api/reddit
VITE_REDDIT_API_BASES=https://my-proxy.example.com/api/reddit
VITE_REDDIT_API_BASES=https://proxy-a.example.com/api/reddit,https://proxy-b.example.com/api/reddit
```

For Vercel, set this in Project Settings -> Environment Variables.

## Render Proxy Backend (Cloudflare-Independent)

This repository includes a standalone Reddit proxy service at [fly-proxy/server.mjs](fly-proxy/server.mjs) that can be deployed on Render.

### Deploy to Render (Web Dashboard)

1. Push this repo to GitHub.
2. In Render Dashboard, click New + -> Blueprint.
3. Connect your GitHub repo and select it.
4. Render will detect [render.yaml](render.yaml) and create a web service automatically.
5. Click Apply, then wait for deploy to finish.

### Health Check

- `GET /healthz` returns JSON `{ "ok": true }`

### Configure Vercel Frontend to Use Render First

Set `VITE_REDDIT_API_BASES` in Vercel:

```bash
https://<your-render-service>.onrender.com/api/reddit,https://redalt.pages.dev/api/reddit,/api/reddit
```

This order gives:

1. Render primary backend
2. Cloudflare backup
3. Same-origin Vercel API fallback

## Project Notes

- Uses `raw_json=1` Reddit endpoints for cleaner payload parsing.
- API errors (such as 403/451) are mapped to friendly messages in UI.
- External embeds depend on metadata availability from Reddit payloads.
- In production on Cloudflare Pages, requests are proxied through `functions/api/reddit/[[path]].ts` (same-origin) for better Safari/iPhone reliability.
- In local development, the app automatically falls back to direct `https://www.reddit.com` API requests when the proxy route is unavailable.
