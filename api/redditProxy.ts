export type RedditProxyEnv = Record<string, string | undefined>;

type RedditProxyOptions = {
  cloudflareProxyBase?: string;
  userAgentFallback?: string;
};

type OAuthTokenCache = {
  token: string;
  expiresAt: number;
};

type PublicInstanceCache = {
  urls: string[];
  expiresAt: number;
};

const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];
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

let oauthTokenCache: OAuthTokenCache | null = null;
let publicInstanceCache: PublicInstanceCache | null = null;

export function isAllowedRedditPath(upstreamPath: string): boolean {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  return (
    normalizedPath.startsWith('/r/') ||
    normalizedPath.startsWith('/user/') ||
    normalizedPath.startsWith('/search.json') ||
    normalizedPath.startsWith('/subreddits/') ||
    normalizedPath.startsWith('/users/') ||
    normalizedPath.startsWith('/api/search_reddit_names.json')
  );
}

export async function handleRedditProxyRequest(
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions = {},
): Promise<Response> {
  if (!isAllowedRedditPath(upstreamPath)) {
    return new Response('Invalid Reddit path', {
      status: 400,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }

  if (options.cloudflareProxyBase) {
    const cloudflareResponse = await fetchWithTimeout(
      `${options.cloudflareProxyBase}${upstreamPath}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': getProxyUserAgent(env, options),
        },
      },
      4000,
    ).catch(() => null);

    if (cloudflareResponse?.ok && isJsonContentType(cloudflareResponse.headers.get('content-type'))) {
      return responseFromUpstream(cloudflareResponse, 'public, max-age=30, s-maxage=120');
    }
  }

  const publicInstanceResponse = await fetchViaPublicInstances(upstreamPath, env, options);

  if (publicInstanceResponse) {
    return publicInstanceResponse;
  }

  let fallbackResponse: Response | null = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamResponse = await fetchWithTimeout(
      `${host}${upstreamPath}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': getProxyUserAgent(env, options),
        },
      },
      5000,
    ).catch(() => null);

    if (!upstreamResponse) {
      continue;
    }

    const blockedHtml = await isBlockedHtmlResponse(upstreamResponse);

    if (upstreamResponse.ok && isJsonContentType(upstreamResponse.headers.get('content-type'))) {
      return responseFromUpstream(upstreamResponse, 'public, max-age=30, s-maxage=120');
    }

    if (blockedHtml) {
      fallbackResponse = new Response(
        JSON.stringify({
          error: 'blocked',
          message:
            'Reddit blocked this request from the current network. Configure Reddit OAuth credentials on the proxy to use authenticated API access.',
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=15, s-maxage=30',
          },
        },
      );
      continue;
    }

    if (!fallbackResponse) {
      fallbackResponse = responseFromUpstream(upstreamResponse, 'public, max-age=15, s-maxage=30');
    }
  }

  const mirrorResponse = await fetchViaAllOrigins(upstreamPath, env, options).catch(() => null);

  if (mirrorResponse?.ok && isJsonContentType(mirrorResponse.headers.get('content-type'))) {
    return responseFromUpstream(mirrorResponse, 'public, max-age=30, s-maxage=120');
  }

  const redditRssResponse = await fetchViaRedditRss(upstreamPath, env, options);

  if (redditRssResponse) {
    return redditRssResponse;
  }

  const oauthResponse = await fetchViaOAuth(upstreamPath, env, options);

  if (oauthResponse?.ok && isJsonContentType(oauthResponse.headers.get('content-type'))) {
    return responseFromUpstream(oauthResponse, 'public, max-age=30, s-maxage=120');
  }

  return (
    fallbackResponse ??
    new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  );
}

function responseFromUpstream(response: Response, cacheControl: string): Response {
  const headers = new Headers();
  headers.set('Content-Type', response.headers.get('content-type') ?? 'application/json');
  headers.set('Cache-Control', cacheControl);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('application/json');
}

async function isBlockedHtmlResponse(response: Response): Promise<boolean> {
  const contentType = response.headers.get('content-type');

  if (isJsonContentType(contentType) || (response.status !== 403 && response.status !== 429)) {
    return false;
  }

  const normalized = (await response.clone().text()).toLowerCase();
  return normalized.includes("you've been blocked by network security") || normalized.includes('blocked by network security');
}

async function fetchViaAllOrigins(
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<Response> {
  const redditUrl = `https://www.reddit.com${upstreamPath}`;
  const mirrorUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(redditUrl)}`;

  return fetchWithTimeout(
    mirrorUrl,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': getProxyUserAgent(env, options),
      },
    },
    4000,
  );
}

function getProxyUserAgent(env: RedditProxyEnv | undefined, options: RedditProxyOptions): string {
  return env?.REDDIT_PROXY_USER_AGENT ?? options.userAgentFallback ?? 'RedAlt/1.0 (Reddit proxy)';
}

function publicInstanceFallbackEnabled(env: RedditProxyEnv | undefined): boolean {
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
    return new URL(base).hostname.toLowerCase().includes('troddit');
  } catch {
    return true;
  }
}

function buildRssPath(upstreamPath: string): string | null {
  const [rawPath, rawQuery = ''] = upstreamPath.split('?');
  const path = rawPath.replace(/\.json$/i, '');
  const rssParams = new URLSearchParams(rawQuery);
  rssParams.delete('raw_json');
  const query = rssParams.toString();
  const withQuery = (rssPath: string) => `${rssPath}${query ? `?${query}` : ''}`;
  const subredditSearchMatch = path.match(/^\/r\/([^/]+)\/search$/i);
  const subredditMatch = path.match(/^\/r\/([^/]+)(?:\/(hot|new|rising|top))?$/i);
  const userMatch = path.match(/^\/user\/([^/]+)\/submitted$/i);

  if (subredditSearchMatch) {
    return withQuery(`/r/${subredditSearchMatch[1]}/search.rss`);
  }

  if (subredditMatch) {
    const sort = subredditMatch[2];
    return withQuery(sort && sort !== 'hot' ? `/r/${subredditMatch[1]}/${sort}.rss` : `/r/${subredditMatch[1]}.rss`);
  }

  if (userMatch) {
    return withQuery(`/user/${userMatch[1]}/submitted.rss`);
  }

  if (path === '/search') {
    return withQuery('/search.rss');
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

function readXmlAuthor(xml: string): string {
  const authorXml = readXmlTag(xml, 'author');
  return stripHtml(readXmlTag(authorXml, 'name') || authorXml);
}

function inferSubredditFromPath(upstreamPath: string): string {
  const match = upstreamPath.match(/^\/r\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : 'popular';
}

function inferUserFromPath(upstreamPath: string): string {
  const match = upstreamPath.match(/^\/user\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function inferSubredditFromPermalink(permalink: string, fallback: string): string {
  const match = permalink.match(/^\/r\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : fallback;
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
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];

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
        const itemXml = item[2];
        const title = stripHtml(readXmlTag(itemXml, 'title')) || 'Untitled post';
        const link = readXmlAttribute(itemXml, 'link', 'href') || readXmlTag(itemXml, 'link') || readXmlTag(itemXml, 'guid');
        const author = readXmlAuthor(itemXml) || user || '[unknown]';
        const content =
          readXmlTag(itemXml, 'content:encoded') ||
          readXmlTag(itemXml, 'content') ||
          readXmlTag(itemXml, 'summary') ||
          readXmlTag(itemXml, 'description');
        const enclosureUrl = readXmlAttribute(itemXml, 'enclosure', 'url') || readXmlAttribute(itemXml, 'media:thumbnail', 'url');
        const created = Date.parse(readXmlTag(itemXml, 'pubDate') || readXmlTag(itemXml, 'updated') || readXmlTag(itemXml, 'published'));
        const id = stableIdFromUrl(link || title, index);
        const permalink = (() => {
          try {
            return new URL(link).pathname;
          } catch {
            return link.startsWith('/') ? link : `/r/${subreddit}/comments/${id}`;
          }
        })();
        const itemSubreddit = inferSubredditFromPermalink(permalink, subreddit);
        const outboundUrl = enclosureUrl || link || `https://www.reddit.com${permalink}`;

        return {
          kind: 't3',
          data: {
            id,
            name: `t3_${id}`,
            title,
            author,
            subreddit: itemSubreddit,
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

async function getPublicInstanceUrls(env: RedditProxyEnv | undefined, options: RedditProxyOptions): Promise<string[]> {
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
            'User-Agent': getProxyUserAgent(env, options),
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

  return normalizedPath.startsWith('/r/') || normalizedPath.startsWith('/user/') || normalizedPath === '/search.json';
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
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
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
          'User-Agent': getProxyUserAgent(env, options),
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

    const normalizedPayload = looksJson ? normalizePublicInstancePayload(JSON.parse(body), upstreamPath) : parseRssListing(body, upstreamPath);

    if (!isCompatibleRedditPayload(normalizedPayload, upstreamPath)) {
      return null;
    }

    return new Response(JSON.stringify(normalizedPayload), {
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
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<Response | null> {
  if (!publicInstanceFallbackEnabled(env) || !isPublicPostPath(upstreamPath)) {
    return null;
  }

  const urls = await getPublicInstanceUrls(env, options);
  const batchSize = 8;

  for (let index = 0; index < urls.length; index += batchSize) {
    const batch = urls.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((base) => fetchFromPublicInstance(base, upstreamPath, env, options)));
    const successfulResponse = results.find((response) => response !== null);

    if (successfulResponse) {
      return successfulResponse;
    }
  }

  return null;
}

async function fetchViaRedditRss(
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<Response | null> {
  const rssPath = buildRssPath(upstreamPath);

  if (!rssPath) {
    return null;
  }

  try {
    const response = await fetchWithTimeout(
      `https://www.reddit.com${rssPath}`,
      {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml',
          'User-Agent': getProxyUserAgent(env, options),
        },
      },
      5000,
    );

    if (!response.ok) {
      return null;
    }

    const normalizedPayload = parseRssListing(await response.text(), upstreamPath);

    if (!isCompatibleRedditPayload(normalizedPayload, upstreamPath)) {
      return null;
    }

    return new Response(JSON.stringify(normalizedPayload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30, s-maxage=120',
        'X-RedAlt-Fallback': 'reddit-rss',
      },
    });
  } catch {
    return null;
  }
}

async function getOAuthAccessToken(
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<string | null> {
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
        Authorization: `Basic ${encodeBase64(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getProxyUserAgent(env, options),
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

function encodeBase64(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value);
  }

  const globalWithBuffer = globalThis as typeof globalThis & {
    Buffer?: {
      from(input: string): {
        toString(encoding: 'base64'): string;
      };
    };
  };

  if (!globalWithBuffer.Buffer) {
    throw new Error('No base64 encoder available.');
  }

  return globalWithBuffer.Buffer.from(value).toString('base64');
}

async function fetchViaOAuth(
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<Response | null> {
  const token = await getOAuthAccessToken(env, options);

  if (!token) {
    return null;
  }

  try {
    return await fetch(`${OAUTH_HOST}${upstreamPath}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': getProxyUserAgent(env, options),
      },
    });
  } catch {
    return null;
  }
}
