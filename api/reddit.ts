const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];
const CLOUDFLARE_PROXY_BASE = 'https://redalt.pages.dev/api/reddit';
const OAUTH_HOST = 'https://oauth.reddit.com';
const OAUTH_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const PUBLIC_INSTANCE_LIST_URLS = [
  'https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json',
  'https://raw.githubusercontent.com/libreddit/libreddit-instances/master/instances.json',
];
const STATIC_PUBLIC_INSTANCES = [
  'https://redlib.perennialte.ch',
  'https://redlib.r4fo.com',
  'https://red.artemislena.eu',
  'https://redlib.cow.rip',
  'https://redlib.privacyredirect.com',
  'https://redlib.nadeko.net',
  'https://redlib.orangenet.cc',
  'https://redlib.privadency.com',
  'https://redlib.catsarch.com',
  'https://eddrit.com',
  'https://lr.vern.cc',
  'https://teddit.net',
  'https://teddit.ggc-project.de',
  'https://teddit.kavin.rocks',
  'https://teddit.zaggy.nl',
  'https://teddit.namazso.eu',
  'https://teddit.nautolan.racing',
  'https://teddit.tinfoil-hat.net',
  'https://teddit.domain.glass',
  'https://www.troddit.com',
  'https://troddit.com',
];

type OAuthTokenCache = {
  token: string;
  expiresAt: number;
};

type PublicInstanceCache = {
  urls: string[];
  expiresAt: number;
};

let oauthTokenCache: OAuthTokenCache | null = null;
let publicInstanceCache: PublicInstanceCache | null = null;

function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('application/json');
}

async function isBlockedHtmlResponse(response: Response): Promise<boolean> {
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

function buildUpstreamPath(pathParam: string | string[] | undefined, incomingUrl: URL): string {
  const path = Array.isArray(pathParam) ? pathParam.join('/') : pathParam ?? '';
  const normalizedPath = path.replace(/^\/+/, '');
  const params = new URLSearchParams(incomingUrl.search);
  params.delete('path');
  const query = params.toString();

  return `/${normalizedPath}${query ? `?${query}` : ''}`;
}

async function fetchViaAllOrigins(upstreamPath: string): Promise<Response> {
  const redditUrl = `https://www.reddit.com${upstreamPath}`;
  const mirrorUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(redditUrl)}`;

  return fetchWithTimeout(mirrorUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': getProxyUserAgent(),
    },
  }, 4000);
}

function getProxyUserAgent(): string {
  return process.env.REDDIT_PROXY_USER_AGENT ?? 'RedAlt/1.0 (Vercel proxy)';
}

function publicInstanceFallbackEnabled(): boolean {
  return (process.env.ENABLE_PUBLIC_INSTANCE_FALLBACK ?? 'true').toLowerCase() !== 'false';
}

function normalizeInstanceBase(base: string): string {
  return base.trim().replace(/\/+$/g, '');
}

function addInstanceUrl(urls: string[], seen: Set<string>, value: unknown): void {
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

function collectHttpsUrls(value: unknown, urls: string[], seen: Set<string>): void {
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
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

function isTedditInstance(base: string): boolean {
  try {
    return new URL(base).hostname.toLowerCase().includes('teddit');
  } catch {
    return false;
  }
}

function appendTedditApiParams(path: string, sourceParams: URLSearchParams): string {
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

function buildTedditPath(upstreamPath: string): string | null {
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

function isUnsupportedBrowserAppInstance(base: string): boolean {
  try {
    const hostname = new URL(base).hostname.toLowerCase();
    return hostname.includes('troddit');
  } catch {
    return true;
  }
}

function buildRssPath(upstreamPath: string): string | null {
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

function buildPublicInstancePath(base: string, upstreamPath: string): string | null {
  if (isTedditInstance(base)) {
    return buildTedditPath(upstreamPath);
  }

  if (isUnsupportedBrowserAppInstance(base)) {
    return null;
  }

  return buildRssPath(upstreamPath);
}

function normalizePublicInstancePayload(payload: unknown, upstreamPath: string): unknown {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (
    normalizedPath.startsWith('/user/') &&
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { overview?: { data?: { children?: unknown[] } } }).overview?.data?.children)
  ) {
    return (payload as { overview: unknown }).overview;
  }

  return payload;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function readXmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function readXmlAttribute(xml: string, tag: string, attribute: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function inferSubredditFromPath(upstreamPath: string): string {
  const match = upstreamPath.match(/^\/r\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : 'popular';
}

function inferUserFromPath(upstreamPath: string): string {
  const match = upstreamPath.match(/^\/user\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function stableIdFromUrl(url: string, fallbackIndex: number): string {
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

function parseRssListing(xml: string, upstreamPath: string): unknown | null {
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

async function getPublicInstanceUrls(): Promise<string[]> {
  const now = Date.now();

  if (publicInstanceCache && publicInstanceCache.expiresAt > now) {
    return publicInstanceCache.urls;
  }

  const urls: string[] = [];
  const seen = new Set<string>();

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
            'User-Agent': getProxyUserAgent(),
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

function isPublicPostPath(upstreamPath: string): boolean {
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

function isCompatibleRedditPayload(payload: unknown, upstreamPath: string): boolean {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (normalizedPath.includes('/comments/')) {
    return (
      Array.isArray(payload) &&
      typeof payload[0] === 'object' &&
      payload[0] !== null &&
      Array.isArray((payload[0] as { data?: { children?: unknown[] } }).data?.children)
    );
  }

  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === 'Listing' &&
    Array.isArray((payload as { data?: { children?: unknown[] } }).data?.children)
  );
}

async function fetchFromPublicInstance(base: string, upstreamPath: string): Promise<Response | null> {
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
          'User-Agent': getProxyUserAgent(),
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

async function fetchViaPublicInstances(upstreamPath: string): Promise<Response | null> {
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

async function getOAuthAccessToken(): Promise<string | null> {
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
        'User-Agent': getProxyUserAgent(),
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok || !isJsonContentType(response.headers.get('content-type'))) {
      return null;
    }

    const tokenPayload = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };

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

async function fetchViaOAuth(upstreamPath: string): Promise<Response | null> {
  const token = await getOAuthAccessToken();

  if (!token) {
    return null;
  }

  try {
    return await fetch(`${OAUTH_HOST}${upstreamPath}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': getProxyUserAgent(),
      },
    });
  } catch {
    return null;
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  const incomingUrl = new URL(req.url ?? '/', 'http://localhost');
  const upstreamPath = buildUpstreamPath(req.query?.path, incomingUrl);
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  const allowedPrefix =
    normalizedPath.startsWith('/r/') ||
    normalizedPath.startsWith('/user/') ||
    normalizedPath.startsWith('/search.json') ||
    normalizedPath.startsWith('/subreddits/') ||
    normalizedPath.startsWith('/users/') ||
    normalizedPath.startsWith('/api/search_reddit_names.json');

  if (!allowedPrefix) {
    res.status(400).setHeader('Content-Type', 'text/plain; charset=utf-8').send('Invalid Reddit path');
    return;
  }

  const oauthResponse = await fetchViaOAuth(upstreamPath);

  if (oauthResponse?.ok && isJsonContentType(oauthResponse.headers.get('content-type'))) {
    const body = await oauthResponse.text();

    res
      .status(oauthResponse.status)
      .setHeader('Content-Type', oauthResponse.headers.get('content-type') ?? 'application/json')
      .setHeader('Cache-Control', 'public, max-age=30, s-maxage=120')
      .send(body);
    return;
  }

  // Prefer a known-working Cloudflare proxy to bypass Vercel egress blocks.
  const cloudflareResponse = await fetchWithTimeout(
    `${CLOUDFLARE_PROXY_BASE}${upstreamPath}`,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': getProxyUserAgent(),
      },
    },
    4000,
  ).catch(() => null);

  if (cloudflareResponse?.ok && isJsonContentType(cloudflareResponse.headers.get('content-type'))) {
    const body = await cloudflareResponse.text();

    res
      .status(cloudflareResponse.status)
      .setHeader('Content-Type', cloudflareResponse.headers.get('content-type') ?? 'application/json')
      .setHeader('Cache-Control', 'public, max-age=30, s-maxage=120')
      .send(body);
    return;
  }

  const publicInstanceResponse = await fetchViaPublicInstances(upstreamPath);

  if (publicInstanceResponse) {
    const body = await publicInstanceResponse.text();

    res
      .status(publicInstanceResponse.status)
      .setHeader('Content-Type', publicInstanceResponse.headers.get('content-type') ?? 'application/json')
      .setHeader('Cache-Control', publicInstanceResponse.headers.get('cache-control') ?? 'public, max-age=30, s-maxage=120')
      .setHeader('X-RedAlt-Fallback', publicInstanceResponse.headers.get('x-redalt-fallback') ?? 'public-instance')
      .setHeader('X-RedAlt-Instance', publicInstanceResponse.headers.get('x-redalt-instance') ?? 'unknown')
      .send(body);
    return;
  }

  let fallback: {
    status: number;
    contentType: string;
    cacheControl: string;
    body: string;
  } | null = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${upstreamPath}`;
    const upstreamResponse = await fetchWithTimeout(
      upstreamUrl,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': getProxyUserAgent(),
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

      res
        .status(upstreamResponse.status)
        .setHeader('Content-Type', upstreamResponse.headers.get('content-type') ?? 'application/json')
        .setHeader('Cache-Control', 'public, max-age=30, s-maxage=120')
        .send(body);
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

  const mirrorResponse = await fetchViaAllOrigins(upstreamPath).catch(() => null);

  if (mirrorResponse?.ok && isJsonContentType(mirrorResponse.headers.get('content-type'))) {
    const body = await mirrorResponse.text();

    res
      .status(mirrorResponse.status)
      .setHeader('Content-Type', mirrorResponse.headers.get('content-type') ?? 'application/json')
      .setHeader('Cache-Control', 'public, max-age=30, s-maxage=120')
      .send(body);
    return;
  }

  if (fallback) {
    res
      .status(fallback.status)
      .setHeader('Content-Type', fallback.contentType)
      .setHeader('Cache-Control', fallback.cacheControl)
      .send(fallback.body);
    return;
  }

  res
    .status(502)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(JSON.stringify({ error: 'upstream_unavailable' }));
}
