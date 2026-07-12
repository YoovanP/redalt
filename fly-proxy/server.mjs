import http from 'node:http';

const { handleRedditProxyRequest, isAllowedRedditPath } = await import(
  new URL('../api/redditProxy.ts', import.meta.url).href,
);

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const USER_AGENT = process.env.REDDIT_PROXY_USER_AGENT ?? 'RedAlt/1.0 (Render proxy)';
const MIRROR_ENABLED = (process.env.ENABLE_MIRROR_FALLBACK ?? 'true').toLowerCase() !== 'false';
const REDDIT_PROXY_PREFIX = '/api/reddit';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

function withCors(headers = new Headers()) {
  const merged = new Headers(headers);

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    merged.set(key, value);
  }

  return merged;
}

function buildUpstreamPath(url) {
  if (!url.pathname.startsWith(REDDIT_PROXY_PREFIX)) {
    return null;
  }

  const upstreamPath = url.pathname.slice(REDDIT_PROXY_PREFIX.length) || '/';
  const normalizedPath = upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`;
  return `${normalizedPath}${url.search}`;
}

function isConsumedBodyError(error) {
  return error instanceof TypeError && String(error.message || error).includes('Body is unusable');
}

async function readResponseBody(response) {
  if (!response.body) {
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

async function sendResponse(res, response) {
  const headers = withCors(response.headers);
  const body = await readResponseBody(response);

  res.writeHead(response.status, Object.fromEntries(headers.entries()));
  res.end(body ?? undefined);
}

async function proxyRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    await sendResponse(res, new Response(null, { status: 204 }));
    return;
  }

  if (req.method !== 'GET') {
    await sendResponse(
      res,
      new Response('Method not allowed', {
        status: 405,
        headers: {
          Allow: 'GET, OPTIONS',
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
    );
    return;
  }

  if (url.pathname === '/healthz') {
    await sendResponse(
      res,
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
    );
    return;
  }

  const upstreamPath = buildUpstreamPath(url);

  if (!upstreamPath || !isAllowedRedditPath(upstreamPath)) {
    await sendResponse(
      res,
      new Response('Invalid Reddit path', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
    );
    return;
  }

  const proxyOptions = {
    userAgentFallback: USER_AGENT,
    enableMirrorFallback: MIRROR_ENABLED,
  };

  let response = await handleRedditProxyRequest(upstreamPath, process.env, proxyOptions);
  let body = null;

  try {
    body = await readResponseBody(response);
  } catch (error) {
    if (!isConsumedBodyError(error)) {
      throw error;
    }

    // Successful JSON responses are cached by the shared core before returning.
    // Replaying the same request here converts a one-off consumed stream into a fresh cached response.
    response = await handleRedditProxyRequest(upstreamPath, process.env, proxyOptions);
    body = await readResponseBody(response);
  }

  const headers = withCors(response.headers);
  res.writeHead(response.status, Object.fromEntries(headers.entries()));
  res.end(body ?? undefined);
}

const server = http.createServer((req, res) => {
  proxyRequest(req, res).catch(async (error) => {
    console.error('Proxy error:', error);
    await sendResponse(
      res,
      new Response(JSON.stringify({ error: 'proxy_failure' }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
    );
  });
});

server.listen(PORT, HOST, () => {
  console.log(`RedAlt proxy listening on http://${HOST}:${PORT}`);
});
