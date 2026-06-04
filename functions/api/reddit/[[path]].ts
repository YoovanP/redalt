type PagesFunctionContext = {
  request: Request;
  params: {
    path?: string | string[];
  };
  env?: Record<string, string | undefined>;
};

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

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

function withCors(headers: HeadersInit = {}): Headers {
  const merged = new Headers(headers);

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    merged.set(key, value);
  }

  return merged;
}

function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('application/json');
}

async function isBlockedHtmlResponse(response: Response): Promise<boolean> {
  const contentType = response.headers.get('Content-Type');

  if (isJsonContentType(contentType)) {
    return false;
  }

  if (response.status !== 403 && response.status !== 429) {
    return false;
  }

  const body = await response.clone().text();
  const normalized = body.toLowerCase();

  return normalized.includes("you've been blocked by network security") || normalized.includes('blocked by network security');
}

async function fetchViaAllOrigins(
  upstreamPath: string,
  env: Record<string, string | undefined> | undefined,
): Promise<Response> {
  const redditUrl = `https://www.reddit.com${upstreamPath}`;
  const mirrorUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(redditUrl)}`;

  return fetchWithTimeout(mirrorUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': getProxyUserAgent(env),
    },
  }, 4000);
}

function getProxyUserAgent(env: Record<string, string | undefined> | undefined): string {
  return env?.REDDIT_PROXY_USER_AGENT ?? 'RedAlt/1.0 (Cloudflare Pages proxy)';
}

function publicInstanceFallbackEnabled(env: Record<string, string | undefined> | undefined): boolean {
  return (env?.ENABLE_PUBLIC_INSTANCE_FALLBACK ?? 'true').toLowerCase() !== 'false';
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

async function getPublicInstanceUrls(env: Record<string, string | undefined> | undefined): Promise<string[]> {
  const now = Date.now();

  if (publicInstanceCache && publicInstanceCache.expiresAt > now) {
    return publicInstanceCache.urls;
  }

  const urls: string[] = [];
  const seen = new Set<string>();

  const configuredInstances = (env?.REDDIT_PUBLIC_INSTANCE_BASES ?? '')
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
            'User-Agent': getProxyUserAgent(env),
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

async function fetchFromPublicInstance(
  base: string,
  upstreamPath: string,
  env: Record<string, string | undefined> | undefined,
): Promise<Response | null> {
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
          'User-Agent': getProxyUserAgent(env),
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

async function fetchViaPublicInstances(
  upstreamPath: string,
  env: Record<string, string | undefined> | undefined,
): Promise<Response | null> {
  if (!publicInstanceFallbackEnabled(env) || !isPublicPostPath(upstreamPath)) {
    return null;
  }

  const urls = await getPublicInstanceUrls(env);
  const batchSize = 8;

  for (let index = 0; index < urls.length; index += batchSize) {
    const batch = urls.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((base) => fetchFromPublicInstance(base, upstreamPath, env)));
    const successfulResponse = results.find((response) => response !== null);

    if (successfulResponse) {
      return successfulResponse;
    }
  }

  return null;
}

async function getOAuthAccessToken(env: Record<string, string | undefined> | undefined): Promise<string | null> {
  const staticToken = env?.REDDIT_BEARER_TOKEN?.trim();

  if (staticToken) {
    return staticToken;
  }

  const clientId = env?.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env?.REDDIT_CLIENT_SECRET?.trim();

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
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getProxyUserAgent(env),
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

async function fetchViaOAuth(
  upstreamPath: string,
  env: Record<string, string | undefined> | undefined,
): Promise<Response | null> {
  const token = await getOAuthAccessToken(env);

  if (!token) {
    return null;
  }

  try {
    return await fetch(`${OAUTH_HOST}${upstreamPath}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': getProxyUserAgent(env),
      },
    });
  } catch {
    return null;
  }
}

function buildUpstreamPath(paramsPath: string | string[] | undefined, url: URL): string {
  const path = Array.isArray(paramsPath) ? paramsPath.join('/') : paramsPath ?? '';
  const normalizedPath = path.replace(/^\/+/, '');
  const query = url.search || '';

  return `/${normalizedPath}${query}`;
}

export async function onRequest(context: PagesFunctionContext): Promise<Response> {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: withCors(),
    });
  }

  const incomingUrl = new URL(context.request.url);
  const upstreamPath = buildUpstreamPath(context.params.path, incomingUrl);
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  const allowedPrefix =
    normalizedPath.startsWith('/r/') ||
    normalizedPath.startsWith('/user/') ||
    normalizedPath.startsWith('/search.json') ||
    normalizedPath.startsWith('/subreddits/') ||
    normalizedPath.startsWith('/users/') ||
    normalizedPath.startsWith('/api/search_reddit_names.json');

  if (!allowedPrefix) {
    return new Response('Invalid Reddit path', {
      status: 400,
      headers: withCors({
        'Cache-Control': 'no-store',
      }),
    });
  }

  const oauthResponse = await fetchViaOAuth(upstreamPath, context.env);

  if (oauthResponse?.ok && isJsonContentType(oauthResponse.headers.get('Content-Type'))) {
    const headers = new Headers();
    headers.set('Content-Type', oauthResponse.headers.get('Content-Type') ?? 'application/json');
    headers.set('Cache-Control', 'public, max-age=30, s-maxage=120');

    return new Response(oauthResponse.body, {
      status: oauthResponse.status,
      statusText: oauthResponse.statusText,
      headers: withCors(headers),
    });
  }

  let fallbackResponse: Response | null = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${upstreamPath}`;
    const upstreamResponse = await fetchWithTimeout(
      upstreamUrl,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': getProxyUserAgent(context.env),
        },
      },
      5000,
    ).catch(() => null);

    if (!upstreamResponse) {
      continue;
    }

    const blockedHtml = await isBlockedHtmlResponse(upstreamResponse);

    if (upstreamResponse.ok && isJsonContentType(upstreamResponse.headers.get('Content-Type'))) {
      const headers = new Headers();
      headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') ?? 'application/json');
      headers.set('Cache-Control', 'public, max-age=30, s-maxage=120');

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: withCors(headers),
      });
    }

    if (blockedHtml) {
      fallbackResponse = new Response(
        JSON.stringify({
          error: 'blocked',
          message: 'Reddit blocked this request from the current network. Configure Reddit OAuth credentials on the proxy to use authenticated API access.',
        }),
        {
          status: 403,
          headers: withCors({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=15, s-maxage=30',
          }),
        },
      );
      continue;
    }

    if (!fallbackResponse) {
      const headers = new Headers();
      headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') ?? 'application/json');
      headers.set('Cache-Control', 'public, max-age=15, s-maxage=30');

      fallbackResponse = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
  }

  const mirrorResponse = await fetchViaAllOrigins(upstreamPath, context.env).catch(() => null);

  if (mirrorResponse?.ok && isJsonContentType(mirrorResponse.headers.get('Content-Type'))) {
    const headers = new Headers();
    headers.set('Content-Type', mirrorResponse.headers.get('Content-Type') ?? 'application/json');
    headers.set('Cache-Control', 'public, max-age=30, s-maxage=120');

    return new Response(mirrorResponse.body, {
      status: mirrorResponse.status,
      statusText: mirrorResponse.statusText,
        headers: withCors(headers),
    });
  }

  const publicInstanceResponse = await fetchViaPublicInstances(upstreamPath, context.env);

  if (publicInstanceResponse) {
    return new Response(publicInstanceResponse.body, {
      status: publicInstanceResponse.status,
      statusText: publicInstanceResponse.statusText,
      headers: withCors(publicInstanceResponse.headers),
    });
  }

  return (
    fallbackResponse ??
    new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
      status: 502,
      headers: withCors({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }),
    })
  );
}
