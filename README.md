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

## Project Notes

- Uses `raw_json=1` Reddit endpoints for cleaner payload parsing.
- API errors (such as 403/451) are mapped to friendly messages in UI.
- External embeds depend on metadata availability from Reddit payloads.
- In production on Cloudflare Pages, requests are proxied through `functions/api/reddit/[[path]].ts` (same-origin) for better Safari/iPhone reliability.
- In local development, the app automatically falls back to direct `https://www.reddit.com` API requests when the proxy route is unavailable.
