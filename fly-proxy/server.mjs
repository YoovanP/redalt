import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const USER_AGENT = process.env.REDDIT_PROXY_USER_AGENT ?? 'RedAlt/1.0 (Render proxy)';
const MIRROR_ENABLED = (process.env.ENABLE_MIRROR_FALLBACK ?? 'true').toLowerCase() !== 'false';

const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

function isJsonContentType(contentType) {
  return (contentType ?? '').toLowerCase().includes('application/json');
}

async function isBlockedHtmlResponse(response) {
  const contentType = response.headers.get('content-type');

  if (isJsonContentType(contentType)) {
    return false;
  }

  if (response.status !== 403 && response.status !== 429) {
    return false;
  }

  const body = await response.clone().text();
  const normalized = body.toLowerCase();

  return (
    normalized.includes("you've been blocked by network security") ||
    normalized.includes('blocked by network security')
  );
}

function getAllowedPath(url) {
  const normalizedPath = url.pathname;

  if (!normalizedPath.startsWith('/api/reddit/')) {
    return null;
  }

  const upstreamPath = normalizedPath.slice('/api/reddit'.length);

  const allowedPrefix =
    upstreamPath.startsWith('/r/') ||
    upstreamPath.startsWith('/user/') ||
    upstreamPath.startsWith('/search.json') ||
    upstreamPath.startsWith('/subreddits/') ||
    upstreamPath.startsWith('/users/') ||
    upstreamPath.startsWith('/api/search_reddit_names.json');

  if (!allowedPrefix) {
    return null;
  }

  return `${upstreamPath}${url.search || ''}`;
}

function writeJson(res, statusCode, payload, cacheControl = 'no-store') {
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(payload));
}

function writeText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', cacheControl = 'no-store') {
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  });
  res.end(text);
}

async function fetchViaAllOrigins(upstreamPath) {
  const redditUrl = `https://www.reddit.com${upstreamPath}`;
  const mirrorUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(redditUrl)}`;

  return fetch(mirrorUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
}

async function proxyRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    writeText(res, 405, 'Method not allowed');
    return;
  }

  if (url.pathname === '/healthz') {
    writeJson(res, 200, { ok: true });
    return;
  }

  const upstreamPath = getAllowedPath(url);

  if (!upstreamPath) {
    writeText(res, 400, 'Invalid Reddit path');
    return;
  }

  let fallback = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${upstreamPath}`;
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });

    const blockedHtml = await isBlockedHtmlResponse(upstreamResponse);

    if (upstreamResponse.ok && isJsonContentType(upstreamResponse.headers.get('content-type'))) {
      const body = await upstreamResponse.text();
      writeText(
        res,
        upstreamResponse.status,
        body,
        upstreamResponse.headers.get('content-type') ?? 'application/json',
        'public, max-age=30, s-maxage=120',
      );
      return;
    }

    if (blockedHtml) {
      fallback = {
        status: 403,
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=15, s-maxage=30',
        body: JSON.stringify({
          error: 'blocked',
          message: 'Reddit blocked this request from the current network.',
        }),
      };
      continue;
    }

    if (!fallback) {
      fallback = {
        status: upstreamResponse.status,
        contentType: upstreamResponse.headers.get('content-type') ?? 'application/json',
        cacheControl: 'public, max-age=15, s-maxage=30',
        body: await upstreamResponse.text(),
      };
    }
  }

  if (MIRROR_ENABLED) {
    const mirrorResponse = await fetchViaAllOrigins(upstreamPath);

    if (mirrorResponse.ok && isJsonContentType(mirrorResponse.headers.get('content-type'))) {
      const body = await mirrorResponse.text();
      writeText(
        res,
        mirrorResponse.status,
        body,
        mirrorResponse.headers.get('content-type') ?? 'application/json',
        'public, max-age=30, s-maxage=120',
      );
      return;
    }
  }

  if (fallback) {
    writeText(res, fallback.status, fallback.body, fallback.contentType, fallback.cacheControl);
    return;
  }

  writeJson(res, 502, { error: 'upstream_unavailable' });
}

const server = http.createServer((req, res) => {
  proxyRequest(req, res).catch((error) => {
    console.error('Proxy error:', error);
    writeJson(res, 502, { error: 'proxy_failure' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`RedAlt proxy listening on http://${HOST}:${PORT}`);
});
