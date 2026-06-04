import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const USER_AGENT = process.env.REDDIT_PROXY_USER_AGENT ?? 'RedAlt/1.0 (Render proxy)';
const MIRROR_ENABLED = (process.env.ENABLE_MIRROR_FALLBACK ?? 'true').toLowerCase() !== 'false';

const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];
const OAUTH_HOST = 'https://oauth.reddit.com';
const OAUTH_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const PUBLIC_INSTANCE_LIST_URLS = [
  'https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json',
  'https://raw.githubusercontent.com/libreddit/libreddit-instances/master/instances.json',
];
const STATIC_PUBLIC_INSTANCES = [
  'https://lr.vern.cc',
  'https://teddit.net',
  'https://teddit.ggc-project.de',
  'https://teddit.kavin.rocks',
  'https://teddit.zaggy.nl',
  'https://teddit.namazso.eu',
  'https://teddit.nautolan.racing',
  'https://teddit.tinfoil-hat.net',
  'https://teddit.domain.glass',
  'https://redlib.catsarch.com',
  'https://redlib.perennialte.ch',
  'https://redlib.r4fo.com',
  'https://red.artemislena.eu',
  'https://redlib.cow.rip',
  'https://redlib.privacyredirect.com',
  'https://redlib.nadeko.net',
  'https://redlib.orangenet.cc',
  'https://redlib.privadency.com',
  'https://eddrit.com',
  'https://www.troddit.com',
  'https://troddit.com',
];

let oauthTokenCache = null;
let publicInstanceCache = null;

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

  return fetchWithTimeout(mirrorUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  }, 4000);
}

function publicInstanceFallbackEnabled() {
  return (process.env.ENABLE_PUBLIC_INSTANCE_FALLBACK ?? 'true').toLowerCase() !== 'false';
}

function normalizeInstanceBase(base) {
  return base.trim().replace(/\/+$/g, '');
}

function addInstanceUrl(urls, seen, value) {
  if (typeof value !== 'string') {
    return;
  }

  const normalized = normalizeInstanceBase(value);

  if (!normalized.startsWith('https://') || seen.has(normalized)) {
    return;
  }

  seen.add(normalized);
  urls.push(normalized);
}

function collectHttpsUrls(value, urls, seen) {
  if (typeof value === 'string') {
    addInstanceUrl(urls, seen, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectHttpsUrls(item, urls, seen);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const item of Object.values(value)) {
    collectHttpsUrls(item, urls, seen);
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function isTedditInstance(base) {
  try {
    return new URL(base).hostname.toLowerCase().includes('teddit');
  } catch {
    return false;
  }
}

function appendTedditApiParams(path, sourceParams) {
  const params = new URLSearchParams();
  params.set('api', '');
  params.set('type', 'json');
  params.set('target', 'reddit');

  for (const [key, value] of sourceParams) {
    if (!params.has(key) && key !== 'raw_json') {
      params.append(key, value);
    }
  }

  return `${path}?${params.toString()}`;
}

function buildTedditPath(upstreamPath) {
  const [rawPath, rawQuery = ''] = upstreamPath.split('?');
  const sourceParams = new URLSearchParams(rawQuery);
  const path = rawPath.replace(/\.json$/i, '');
  const subredditMatch = path.match(/^\/r\/([^/]+)\/([^/]+)$/i);
  const userMatch = path.match(/^\/user\/([^/]+)\/submitted$/i);

  if (subredditMatch) {
    return appendTedditApiParams(`/r/${subredditMatch[1]}/${subredditMatch[2]}`, sourceParams);
  }

  if (userMatch) {
    return appendTedditApiParams(`/u/${userMatch[1]}/submitted`, sourceParams);
  }

  return null;
}

function isUnsupportedBrowserAppInstance(base) {
  try {
    const hostname = new URL(base).hostname.toLowerCase();
    return hostname.includes('troddit');
  } catch {
    return true;
  }
}

function buildRssPath(upstreamPath) {
  const [rawPath] = upstreamPath.split('?');
  const path = rawPath.replace(/\.json$/i, '');
  const subredditMatch = path.match(/^\/r\/([^/]+)(?:\/[^/]+)?$/i);
  const userMatch = path.match(/^\/user\/([^/]+)\/submitted$/i);

  if (subredditMatch) {
    return `/r/${subredditMatch[1]}.rss`;
  }

  if (userMatch) {
    return `/user/${userMatch[1]}.rss`;
  }

  return null;
}

function buildPublicInstancePath(base, upstreamPath) {
  if (isTedditInstance(base)) {
    return buildTedditPath(upstreamPath);
  }

  if (isUnsupportedBrowserAppInstance(base)) {
    return null;
  }

  return buildRssPath(upstreamPath);
}

function normalizePublicInstancePayload(payload, upstreamPath) {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (normalizedPath.startsWith('/user/') && Array.isArray(payload?.overview?.data?.children)) {
    return payload.overview;
  }

  return payload;
}

function decodeXmlEntities(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(value) {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function readXmlAttribute(xml, tag, attribute) {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function inferSubredditFromPath(upstreamPath) {
  const match = upstreamPath.match(/^\/r\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : 'popular';
}

function inferUserFromPath(upstreamPath) {
  const match = upstreamPath.match(/^\/user\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function stableIdFromUrl(url, fallbackIndex) {
  const commentMatch = url.match(/\/comments\/([^/]+)/i);
  if (commentMatch) {
    return commentMatch[1];
  }

  let hash = 0;
  for (let index = 0; index < url.length; index += 1) {
    hash = (hash * 31 + url.charCodeAt(index)) >>> 0;
  }

  return `rss_${hash.toString(36)}_${fallbackIndex}`;
}

function parseRssListing(xml, upstreamPath) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

  if (items.length === 0) {
    return null;
  }

  const subreddit = inferSubredditFromPath(upstreamPath);
  const user = inferUserFromPath(upstreamPath);

  return {
    kind: 'Listing',
    data: {
      after: null,
      children: items.slice(0, 25).map((item, index) => {
        const itemXml = item[1];
        const title = stripHtml(readXmlTag(itemXml, 'title')) || 'Untitled post';
        const link = readXmlTag(itemXml, 'link') || readXmlTag(itemXml, 'guid');
        const author = stripHtml(readXmlTag(itemXml, 'author')) || user || '[unknown]';
        const content = readXmlTag(itemXml, 'content:encoded') || readXmlTag(itemXml, 'content') || readXmlTag(itemXml, 'description');
        const enclosureUrl = readXmlAttribute(itemXml, 'enclosure', 'url');
        const created = Date.parse(readXmlTag(itemXml, 'pubDate'));
        const id = stableIdFromUrl(link || title, index);
        const permalink = (() => {
          try {
            return new URL(link).pathname;
          } catch {
            return link.startsWith('/') ? link : `/r/${subreddit}/comments/${id}`;
          }
        })();
        const outboundUrl = enclosureUrl || link || `https://www.reddit.com${permalink}`;

        return {
          kind: 't3',
          data: {
            id,
            name: `t3_${id}`,
            title,
            author,
            subreddit,
            permalink,
            score: 0,
            ups: 0,
            num_comments: 0,
            created_utc: Number.isFinite(created) ? Math.floor(created / 1000) : Math.floor(Date.now() / 1000),
            selftext: stripHtml(content),
            over_18: false,
            url: outboundUrl,
            url_overridden_by_dest: outboundUrl,
            domain: (() => {
              try {
                return new URL(outboundUrl).hostname;
              } catch {
                return '';
              }
            })(),
            is_self: !enclosureUrl,
            post_hint: enclosureUrl ? 'image' : undefined,
            preview: enclosureUrl
              ? {
                  images: [
                    {
                      source: {
                        url: enclosureUrl,
                      },
                    },
                  ],
                }
              : undefined,
          },
        };
      }),
    },
  };
}

async function getPublicInstanceUrls() {
  const now = Date.now();

  if (publicInstanceCache && publicInstanceCache.expiresAt > now) {
    return publicInstanceCache.urls;
  }

  const urls = [];
  const seen = new Set();

  const configuredInstances = (process.env.REDDIT_PUBLIC_INSTANCE_BASES ?? '')
    .split(',')
    .map((base) => base.trim())
    .filter(Boolean);

  for (const base of [...configuredInstances, ...STATIC_PUBLIC_INSTANCES]) {
    addInstanceUrl(urls, seen, base);
  }

  for (const sourceUrl of PUBLIC_INSTANCE_LIST_URLS) {
    try {
      const response = await fetchWithTimeout(
        sourceUrl,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
        },
        2500,
      );

      if (!response.ok || !isJsonContentType(response.headers.get('content-type'))) {
        continue;
      }

      collectHttpsUrls(await response.json(), urls, seen);
    } catch {
      // Static instances remain available if a list endpoint is stale or blocked.
    }
  }

  publicInstanceCache = {
    urls,
    expiresAt: now + 10 * 60 * 1000,
  };

  return urls;
}

function isPublicPostPath(upstreamPath) {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (!normalizedPath.endsWith('.json')) {
    return false;
  }

  return (
    normalizedPath.startsWith('/r/') ||
    normalizedPath.startsWith('/user/') ||
    normalizedPath === '/search.json'
  );
}

function isCompatibleRedditPayload(payload, upstreamPath) {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (normalizedPath.includes('/comments/')) {
    return Array.isArray(payload) && Array.isArray(payload[0]?.data?.children);
  }

  return payload?.kind === 'Listing' && Array.isArray(payload.data?.children);
}

async function fetchFromPublicInstance(base, upstreamPath) {
  try {
    const publicPath = buildPublicInstancePath(base, upstreamPath);

    if (!publicPath) {
      return null;
    }

    const response = await fetchWithTimeout(
      `${base}${publicPath}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      },
      2500,
    );

    if (!response.ok) {
      return null;
    }

    const body = await response.text();
    const contentType = response.headers.get('content-type');
    const looksJson = isJsonContentType(contentType) || /^[\s\r\n]*[\[{]/.test(body);
    const looksRss = (contentType ?? '').toLowerCase().includes('rss') || /<rss\b|<feed\b|<item\b/i.test(body);

    if (!looksJson && !looksRss) {
      return null;
    }

    const normalizedPayload = looksJson
      ? normalizePublicInstancePayload(JSON.parse(body), upstreamPath)
      : parseRssListing(body, upstreamPath);

    if (!isCompatibleRedditPayload(normalizedPayload, upstreamPath)) {
      return null;
    }

    const normalizedBody = JSON.stringify(normalizedPayload);

    return new Response(normalizedBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30, s-maxage=120',
        'X-RedAlt-Fallback': 'public-instance',
        'X-RedAlt-Instance': base,
      },
    });
  } catch {
    return null;
  }
}

async function fetchViaPublicInstances(upstreamPath) {
  if (!publicInstanceFallbackEnabled() || !isPublicPostPath(upstreamPath)) {
    return null;
  }

  const urls = await getPublicInstanceUrls();
  const batchSize = 8;

  for (let index = 0; index < urls.length; index += batchSize) {
    const batch = urls.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((base) => fetchFromPublicInstance(base, upstreamPath)));
    const successfulResponse = results.find((response) => response !== null);

    if (successfulResponse) {
      return successfulResponse;
    }
  }

  return null;
}

async function getOAuthAccessToken() {
  const staticToken = process.env.REDDIT_BEARER_TOKEN?.trim();

  if (staticToken) {
    return staticToken;
  }

  const clientId = process.env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    return null;
  }

  const now = Date.now();

  if (oauthTokenCache && oauthTokenCache.expiresAt > now + 30000) {
    return oauthTokenCache.token;
  }

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok || !isJsonContentType(response.headers.get('content-type'))) {
      return null;
    }

    const tokenPayload = await response.json();

    if (typeof tokenPayload.access_token !== 'string') {
      return null;
    }

    const expiresIn = typeof tokenPayload.expires_in === 'number' ? tokenPayload.expires_in : 3600;

    oauthTokenCache = {
      token: tokenPayload.access_token,
      expiresAt: now + Math.max(expiresIn - 60, 60) * 1000,
    };

    return oauthTokenCache.token;
  } catch {
    return null;
  }
}

async function fetchViaOAuth(upstreamPath) {
  const token = await getOAuthAccessToken();

  if (!token) {
    return null;
  }

  try {
    return await fetch(`${OAUTH_HOST}${upstreamPath}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
    });
  } catch {
    return null;
  }
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

  const oauthResponse = await fetchViaOAuth(upstreamPath);

  if (oauthResponse?.ok && isJsonContentType(oauthResponse.headers.get('content-type'))) {
    const body = await oauthResponse.text();
    writeText(
      res,
      oauthResponse.status,
      body,
      oauthResponse.headers.get('content-type') ?? 'application/json',
      'public, max-age=30, s-maxage=120',
    );
    return;
  }

  let fallback = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${upstreamPath}`;
    const upstreamResponse = await fetchWithTimeout(
      upstreamUrl,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      },
      5000,
    ).catch(() => null);

    if (!upstreamResponse) {
      continue;
    }

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
          message: 'Reddit blocked this request from the current network. Configure Reddit OAuth credentials on the proxy to use authenticated API access.',
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
    const mirrorResponse = await fetchViaAllOrigins(upstreamPath).catch(() => null);

    if (mirrorResponse?.ok && isJsonContentType(mirrorResponse.headers.get('content-type'))) {
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

  const publicInstanceResponse = await fetchViaPublicInstances(upstreamPath);

  if (publicInstanceResponse) {
    const body = await publicInstanceResponse.text();
    setCorsHeaders(res);
    res.writeHead(publicInstanceResponse.status, {
      'Content-Type': publicInstanceResponse.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'Cache-Control': publicInstanceResponse.headers.get('cache-control') ?? 'public, max-age=30, s-maxage=120',
      'X-RedAlt-Fallback': publicInstanceResponse.headers.get('x-redalt-fallback') ?? 'public-instance',
      'X-RedAlt-Instance': publicInstanceResponse.headers.get('x-redalt-instance') ?? 'unknown',
    });
    res.end(body);
    return;
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
