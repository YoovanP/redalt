export type RedditProxyEnv = Record<string, string | undefined>;

type RedditProxyOptions = {
  cloudflareProxyBase?: string;
  userAgentFallback?: string;
};

type PublicInstanceCache = {
  urls: string[];
  expiresAt: number;
};

type PublicInstanceHealth = {
  failureCount: number;
  retryAfter: number;
};

type PublicInstanceRequest = {
  path: string;
  method: 'json' | 'rss' | 'html';
};

const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];
const PUBLIC_INSTANCE_LIST_URLS = [
  'https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json',
  'https://raw.githubusercontent.com/libreddit/libreddit-instances/master/instances.json',
];
const PUBLIC_INSTANCE_FAILURE_BASE_COOLDOWN_MS = 60 * 1000;
const PUBLIC_INSTANCE_FAILURE_MAX_COOLDOWN_MS = 15 * 60 * 1000;
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

let publicInstanceCache: PublicInstanceCache | null = null;
const publicInstanceHealth = new Map<string, PublicInstanceHealth>();

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
          message: 'Reddit blocked this request from the current network. Try another proxy or fallback source.',
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

function getPublicInstanceHealthKey(base: string): string {
  return normalizeInstanceBase(base).toLowerCase();
}

function isPublicInstanceCoolingDown(base: string, now = Date.now()): boolean {
  const health = publicInstanceHealth.get(getPublicInstanceHealthKey(base));
  return Boolean(health && health.retryAfter > now);
}

function markPublicInstanceSuccess(base: string): void {
  publicInstanceHealth.delete(getPublicInstanceHealthKey(base));
}

function markPublicInstanceFailure(base: string, now = Date.now()): void {
  const key = getPublicInstanceHealthKey(base);
  const previous = publicInstanceHealth.get(key);
  const failureCount = Math.min((previous?.failureCount ?? 0) + 1, 6);
  const cooldown = Math.min(
    PUBLIC_INSTANCE_FAILURE_BASE_COOLDOWN_MS * 2 ** (failureCount - 1),
    PUBLIC_INSTANCE_FAILURE_MAX_COOLDOWN_MS,
  );

  publicInstanceHealth.set(key, {
    failureCount,
    retryAfter: now + cooldown,
  });
}

function getPublicInstanceCandidates(urls: string[]): { candidates: string[]; skipped: string[] } {
  const skipped: string[] = [];
  const candidates: string[] = [];
  const now = Date.now();

  for (const url of urls) {
    if (isPublicInstanceCoolingDown(url, now)) {
      skipped.push(url);
    } else {
      candidates.push(url);
    }
  }

  return {
    candidates: candidates.length > 0 ? candidates : urls,
    skipped: candidates.length > 0 ? skipped : [],
  };
}

function formatInstanceHeader(values: string[]): string {
  const visible = values.slice(0, 12);
  const suffix = values.length > visible.length ? `, +${values.length - visible.length} more` : '';
  return `${visible.join(', ')}${suffix}`;
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

function isTrodditInstance(base: string): boolean {
  try {
    return new URL(base).hostname.toLowerCase().includes('troddit');
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

function buildRssPath(upstreamPath: string): string | null {
  const [rawPath, rawQuery = ''] = upstreamPath.split('?');
  const path = rawPath.replace(/\.json$/i, '');
  const rssParams = new URLSearchParams(rawQuery);
  rssParams.delete('raw_json');
  const query = rssParams.toString();
  const withQuery = (rssPath: string) => `${rssPath}${query ? `?${query}` : ''}`;
  const commentThreadMatch = path.match(/^\/r\/([^/]+)\/comments\/([^/]+)(?:\/.*)?$/i);
  const subredditSearchMatch = path.match(/^\/r\/([^/]+)\/search$/i);
  const subredditMatch = path.match(/^\/r\/([^/]+)(?:\/(hot|new|rising|top))?$/i);
  const userMatch = path.match(/^\/user\/([^/]+)\/submitted$/i);

  if (commentThreadMatch) {
    return withQuery(`/r/${commentThreadMatch[1]}/comments/${commentThreadMatch[2]}.rss`);
  }

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

function buildPublicHtmlPath(upstreamPath: string): string | null {
  const [rawPath, rawQuery = ''] = upstreamPath.split('?');
  const path = rawPath.replace(/\.json$/i, '');
  const params = new URLSearchParams(rawQuery);
  params.delete('raw_json');
  const query = params.toString();
  const withQuery = (htmlPath: string) => `${htmlPath}${query ? `?${query}` : ''}`;
  const commentThreadMatch = path.match(/^\/r\/([^/]+)\/comments\/([^/]+)(?:\/.*)?$/i);
  const subredditSearchMatch = path.match(/^\/r\/([^/]+)\/search$/i);
  const subredditMatch = path.match(/^\/r\/([^/]+)(?:\/(hot|new|rising|top))?$/i);
  const userMatch = path.match(/^\/user\/([^/]+)\/submitted$/i);

  if (commentThreadMatch) {
    return withQuery(`/r/${commentThreadMatch[1]}/comments/${commentThreadMatch[2]}`);
  }

  if (subredditSearchMatch) {
    return withQuery(`/r/${subredditSearchMatch[1]}/search`);
  }

  if (subredditMatch) {
    const sort = subredditMatch[2];
    return withQuery(sort && sort !== 'hot' ? `/r/${subredditMatch[1]}/${sort}` : `/r/${subredditMatch[1]}`);
  }

  if (userMatch) {
    return withQuery(`/u/${userMatch[1]}`);
  }

  if (path === '/search') {
    return withQuery('/search');
  }

  return null;
}

function getPublicSearchParams(upstreamPath: string): URLSearchParams | null {
  const [, rawQuery = ''] = upstreamPath.split('?');
  const sourceParams = new URLSearchParams(rawQuery);
  const query = (sourceParams.get('q') ?? sourceParams.get('query') ?? '').trim();

  if (query.length < 2) {
    return null;
  }

  const params = new URLSearchParams();
  params.set('q', query);
  params.set('sort', sourceParams.get('sort') ?? 'relevance');
  params.set('type', sourceParams.get('type') ?? 'link');

  for (const key of ['t', 'limit', 'include_over_18']) {
    const value = sourceParams.get(key);

    if (value) {
      params.set(key, value);
    }
  }

  return params;
}

function getDiscoverySearchType(upstreamPath: string): string {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (normalizedPath === '/subreddits/search.json' || normalizedPath === '/api/search_reddit_names.json') {
    return 'sr';
  }

  if (normalizedPath === '/users/search.json') {
    return 'user';
  }

  return 'link';
}

function isPublicDiscoveryPath(upstreamPath: string): boolean {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  return (
    normalizedPath === '/api/search_reddit_names.json' ||
    normalizedPath === '/subreddits/search.json' ||
    normalizedPath === '/users/search.json'
  );
}

function buildPublicDiscoveryPath(base: string, upstreamPath: string): string | null {
  const params = getPublicSearchParams(upstreamPath);

  if (!params) {
    return null;
  }

  params.set('type', getDiscoverySearchType(upstreamPath));

  if (isTedditInstance(base)) {
    return appendTedditApiParams('/search', params);
  }

  return `/search?${params.toString()}`;
}

function addPublicInstanceRequest(
  requests: PublicInstanceRequest[],
  seen: Set<string>,
  method: PublicInstanceRequest['method'],
  path: string | null,
): void {
  if (!path) {
    return;
  }

  const key = `${method}:${path}`;

  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  requests.push({ method, path });
}

function buildPublicInstanceRequests(base: string, upstreamPath: string): PublicInstanceRequest[] {
  const requests: PublicInstanceRequest[] = [];
  const seen = new Set<string>();

  if (isPublicDiscoveryPath(upstreamPath)) {
    addPublicInstanceRequest(requests, seen, isTedditInstance(base) ? 'json' : 'html', buildPublicDiscoveryPath(base, upstreamPath));
    addPublicInstanceRequest(requests, seen, 'rss', buildRssPath(upstreamPath));
    return requests;
  }

  if (isTedditInstance(base)) {
    addPublicInstanceRequest(requests, seen, 'json', buildTedditPath(upstreamPath));
  }

  if (!isTrodditInstance(base)) {
    addPublicInstanceRequest(requests, seen, 'rss', buildRssPath(upstreamPath));
  }

  addPublicInstanceRequest(requests, seen, 'html', buildPublicHtmlPath(upstreamPath));

  return requests;
}

function isCommentThreadPath(upstreamPath: string): boolean {
  const normalizedPath = (upstreamPath.split('?')[0] || '/').replace(/\.json$/i, '');
  return /^\/r\/[^/]+\/comments\/[^/]+(?:\/.*)?$/i.test(normalizedPath);
}

function inferCommentThreadId(upstreamPath: string): string {
  const normalizedPath = (upstreamPath.split('?')[0] || '/').replace(/\.json$/i, '');
  const match = normalizedPath.match(/^\/r\/[^/]+\/comments\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function getRequestedListingLimit(upstreamPath: string): number {
  const [, rawQuery = ''] = upstreamPath.split('?');
  const params = new URLSearchParams(rawQuery);
  const parsed = Number(params.get('limit') ?? 25);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 25;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), 100);
}

function getSearchQuery(upstreamPath: string): string {
  const [, rawQuery = ''] = upstreamPath.split('?');
  const params = new URLSearchParams(rawQuery);

  return (params.get('q') ?? params.get('query') ?? '').trim().toLowerCase();
}

function normalizeCommunityName(value: string): string {
  return value.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
}

function normalizeUserName(value: string): string {
  return value.trim().replace(/^\/?(?:u|user)\//i, '').replace(/^\/+|\/+$/g, '');
}

function matchesSearchQuery(value: string, query: string): boolean {
  return !query || value.toLowerCase().includes(query);
}

function listingChildren(payload: unknown): Array<{ kind?: string; data?: Record<string, unknown> }> {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === 'Listing' &&
    Array.isArray((payload as { data?: { children?: unknown[] } }).data?.children)
  ) {
    return (payload as { data: { children: Array<{ kind?: string; data?: Record<string, unknown> }> } }).data.children;
  }

  return [];
}

function collectSubredditNamesFromListing(payload: unknown, upstreamPath: string): string[] {
  const query = getSearchQuery(upstreamPath);
  const names: string[] = [];
  const seen = new Set<string>();

  for (const child of listingChildren(payload)) {
    const data = child.data ?? {};
    const rawName =
      typeof data.subreddit === 'string'
        ? data.subreddit
        : typeof data.display_name === 'string'
          ? data.display_name
          : typeof data.permalink === 'string'
            ? inferSubredditFromPermalink(data.permalink, '')
            : '';
    const name = normalizeCommunityName(rawName);
    const key = name.toLowerCase();

    if (!name || seen.has(key) || !matchesSearchQuery(name, query)) {
      continue;
    }

    seen.add(key);
    names.push(name);
  }

  return names;
}

function collectUserNamesFromListing(payload: unknown, upstreamPath: string): string[] {
  const query = getSearchQuery(upstreamPath);
  const names: string[] = [];
  const seen = new Set<string>();

  for (const child of listingChildren(payload)) {
    const data = child.data ?? {};
    const rawName = typeof data.author === 'string' ? data.author : typeof data.name === 'string' ? data.name : '';
    const name = normalizeUserName(rawName);
    const key = name.toLowerCase();

    if (!name || name === '[unknown]' || seen.has(key) || !matchesSearchQuery(name, query)) {
      continue;
    }

    seen.add(key);
    names.push(name);
  }

  return names;
}

function buildSubredditSearchPayload(names: string[]): unknown {
  return {
    kind: 'Listing',
    data: {
      after: null,
      children: names.slice(0, 25).map((name) => ({
        kind: 't5',
        data: {
          display_name: name,
          title: `r/${name}`,
          public_description: '',
          over18: false,
          subscribers: 0,
        },
      })),
    },
  };
}

function buildUserSearchPayload(names: string[]): unknown {
  return {
    kind: 'Listing',
    data: {
      after: null,
      children: names.slice(0, 25).map((name) => ({
        kind: 't2',
        data: {
          name,
          total_karma: 0,
        },
      })),
    },
  };
}

function normalizePublicInstancePayload(payload: unknown, upstreamPath: string): unknown {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (isCommentThreadPath(upstreamPath)) {
    if (isCompatibleRedditPayload(payload, upstreamPath)) {
      return payload;
    }

    const threadId = inferCommentThreadId(upstreamPath);
    const postChild = listingChildren(payload).find((child) => {
      const data = child.data;

      if (!data) {
        return false;
      }

      const id = typeof data.id === 'string' ? data.id : '';
      const name = typeof data.name === 'string' ? data.name : '';
      const permalink = typeof data.permalink === 'string' ? data.permalink : '';

      return id === threadId || name === `t3_${threadId}` || permalink.includes(`/comments/${threadId}`);
    });

    if (!postChild) {
      return null;
    }

    return [
      {
        kind: 'Listing',
        data: {
          after: null,
          before: null,
          children: [postChild],
        },
      },
      {
        kind: 'Listing',
        data: {
          after: null,
          before: null,
          children: [],
        },
      },
    ];
  }

  if (normalizedPath === '/api/search_reddit_names.json') {
    const names = collectSubredditNamesFromListing(payload, upstreamPath);

    if (names.length === 0) {
      return null;
    }

    return {
      names: names.slice(0, 25),
    };
  }

  if (normalizedPath === '/subreddits/search.json') {
    const names = collectSubredditNamesFromListing(payload, upstreamPath);
    return names.length > 0 ? buildSubredditSearchPayload(names) : null;
  }

  if (normalizedPath === '/users/search.json') {
    const names = collectUserNamesFromListing(payload, upstreamPath);
    return names.length > 0 ? buildUserSearchPayload(names) : null;
  }

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
  let decoded = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded
      .replace(/&amp;/g, '&')
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    if (next === decoded) {
      break;
    }

    decoded = next;
  }

  return decoded;
}

function stripHtml(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function stripHtmlLines(value: string): string[] {
  return decodeXmlEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|blockquote|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function readHtmlAttributes(html: string, attribute: 'href' | 'src'): string[] {
  return [...html.matchAll(new RegExp(`\\s${attribute}=["']([^"']+)["']`, 'gi'))].map((match) =>
    decodeXmlEntities(match[1] ?? '').trim(),
  );
}

function normalizeUrlCandidate(value: string, baseUrl: string): string {
  const candidate = decodeXmlEntities(value).trim();

  if (!candidate || /^(?:#|javascript:|mailto:)/i.test(candidate)) {
    return '';
  }

  try {
    const url = new URL(candidate, baseUrl);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }

    return url.toString();
  } catch {
    return '';
  }
}

function getUrlHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getUrlPathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isLikelyImageUrl(url: string): boolean {
  const pathname = getUrlPathname(url);
  return /\.(?:png|jpe?g|webp|gif|avif)$/i.test(pathname);
}

function isLikelyVideoUrl(url: string): boolean {
  const pathname = getUrlPathname(url);
  return /\.(?:mp4|webm|mov|m4v|m3u8)$/i.test(pathname) || pathname.endsWith('.gifv');
}

function isRedditNavigationUrl(url: string): boolean {
  const hostname = getUrlHostname(url);

  if (!hostname.endsWith('reddit.com') && !hostname.endsWith('redd.it')) {
    return false;
  }

  const pathname = getUrlPathname(url);
  return (
    pathname === '/' ||
    pathname.startsWith('/r/') ||
    pathname.startsWith('/user/') ||
    pathname.startsWith('/u/') ||
    pathname.startsWith('/search')
  );
}

function firstDistinctUrl(values: string[], baseUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const url = normalizeUrlCandidate(value, baseUrl);
    const key = url.toLowerCase();

    if (!url || seen.has(key)) {
      continue;
    }

    seen.add(key);
    urls.push(url);
  }

  return urls;
}

function buildYouTubeEmbed(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    let id = '';

    if (hostname.includes('youtu.be')) {
      id = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (hostname.includes('youtube.com')) {
      id =
        parsed.searchParams.get('v') ??
        parsed.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/i)?.[1] ??
        '';
    }

    return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : null;
  } catch {
    return null;
  }
}

function buildVimeoEmbed(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('vimeo.com')) {
      return null;
    }

    const id = parsed.pathname.match(/\/(\d+)/)?.[1] ?? '';
    return id ? `https://player.vimeo.com/video/${id}` : null;
  } catch {
    return null;
  }
}

function buildRedgifsEmbed(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('redgifs.com')) {
      return null;
    }

    const id = parsed.pathname.match(/\/(?:watch|ifr)\/([^/?]+)/i)?.[1] ?? '';
    return id ? `https://www.redgifs.com/ifr/${id}` : null;
  } catch {
    return null;
  }
}

function buildKnownEmbed(url: string): { provider: string; embedUrl: string } | null {
  const youtubeEmbed = buildYouTubeEmbed(url);

  if (youtubeEmbed) {
    return { provider: 'YouTube', embedUrl: youtubeEmbed };
  }

  const vimeoEmbed = buildVimeoEmbed(url);

  if (vimeoEmbed) {
    return { provider: 'Vimeo', embedUrl: vimeoEmbed };
  }

  const redgifsEmbed = buildRedgifsEmbed(url);

  if (redgifsEmbed) {
    return { provider: 'Redgifs', embedUrl: redgifsEmbed };
  }

  return null;
}

function cleanRssSelfText(content: string, title: string, mediaUrl: string): string {
  const titleKey = title.trim().toLowerCase();
  const mediaKey = mediaUrl.trim().toLowerCase();
  const lines = stripHtmlLines(content).map(stripRssSubmissionBoilerplate).filter((line) => {
    const key = line.toLowerCase();

    if (!key || key === titleKey || key === mediaKey) {
      return false;
    }

    if (
      /^submitted\b/i.test(line) ||
      /^by\s+\/?u\//i.test(line) ||
      /^to\s+\/?r\//i.test(line) ||
      (/(?:^|\s)(?:comments?|permalink|source|share|save)(?:\s|$)/i.test(line) && line.length < 80) ||
      /^\d+\s+comments?$/i.test(line) ||
      /^https?:\/\//i.test(line) ||
      /^(\[[^\]]+\]\s*)+$/i.test(line)
    ) {
      return false;
    }

    return true;
  });

  return lines.slice(0, 4).join('\n\n');
}

function stripRssSubmissionBoilerplate(value: string): string {
  return value
    .replace(
      /\s*submitted\s+by\s+\/?u\/[A-Za-z0-9_-]+(?:\s+to\s+\/?r\/[A-Za-z0-9_]+)?(?:\s+\[[^\]]+\])*\s*$/i,
      '',
    )
    .trim();
}

function collectNamesFromHtml(html: string, pattern: RegExp, query: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(pattern)) {
    const name = decodeXmlEntities(match[1] ?? '').trim();
    const key = name.toLowerCase();

    if (!name || seen.has(key) || !matchesSearchQuery(name, query)) {
      continue;
    }

    seen.add(key);
    names.push(name);
  }

  return names;
}

function titleFromPermalink(permalink: string): string {
  const slug = permalink.split('/').filter(Boolean).at(-1) ?? '';
  return decodeURIComponent(slug).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled post';
}

function parseHtmlPostLinks(html: string, upstreamPath: string, sourceBase: string): Array<{ kind: 't3'; data: Record<string, unknown> }> {
  const children: Array<{ kind: 't3'; data: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  const fallbackSubreddit = inferSubredditFromPath(upstreamPath);

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] ?? '';
    const href = attrs.match(/\shref=["']([^"']+)["']/i)?.[1] ?? '';
    const url = normalizeUrlCandidate(href, sourceBase);

    if (!url) {
      continue;
    }

    const pathname = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return '';
      }
    })();
    const id = pathname.match(/\/comments\/([^/]+)/i)?.[1] ?? '';
    const permalink = pathname.match(/^\/r\/[^/]+\/comments\/[^/]+/i) ? pathname : '';
    const key = id.toLowerCase();

    if (!id || !permalink || seen.has(key)) {
      continue;
    }

    const rawTitle = stripHtml(match[2] ?? '');
    const title = rawTitle && !/^comments?$/i.test(rawTitle) ? rawTitle : titleFromPermalink(permalink);
    const subreddit = inferSubredditFromPermalink(permalink, fallbackSubreddit);
    seen.add(key);
    children.push({
      kind: 't3',
      data: {
        id,
        name: `t3_${id}`,
        title,
        author: '[unknown]',
        subreddit,
        permalink,
        score: 0,
        ups: 0,
        num_comments: 0,
        created_utc: Math.floor(Date.now() / 1000),
        selftext: '',
        over_18: false,
        url,
        url_overridden_by_dest: url,
        domain: getUrlHostname(url),
        is_self: false,
        post_hint: 'link',
      },
    });
  }

  return children;
}

function parseHtmlListing(html: string, upstreamPath: string, sourceBase: string): unknown | null {
  const pageSize = Math.min(getRequestedListingLimit(upstreamPath), 25);
  const children = parseHtmlPostLinks(html, upstreamPath, sourceBase).slice(0, pageSize);

  if (children.length === 0) {
    return null;
  }

  return {
    kind: 'Listing',
    data: {
      after: getSyntheticRssAfter(children, upstreamPath, pageSize),
      before: null,
      children,
    },
  };
}

function parseHtmlCommentsResponse(html: string, upstreamPath: string, sourceBase: string): unknown | null {
  const postId = inferCommentThreadId(upstreamPath);
  const postChild = parseHtmlPostLinks(html, upstreamPath, sourceBase).find((child) => child.data.id === postId);

  if (!postChild) {
    return null;
  }

  return [
    {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: [postChild],
      },
    },
    {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: [],
      },
    },
  ];
}

function parseHtmlDiscoveryListing(html: string, upstreamPath: string): unknown | null {
  const normalizedPath = upstreamPath.split('?')[0] || '/';
  const query = getSearchQuery(upstreamPath);

  if (normalizedPath === '/api/search_reddit_names.json') {
    const names = collectNamesFromHtml(html, /(?:href=["'][^"']*\/r\/|>\s*r\/)([A-Za-z0-9_]{2,21})/gi, query);
    return names.length > 0 ? { names: names.slice(0, 25) } : null;
  }

  if (normalizedPath === '/subreddits/search.json') {
    const names = collectNamesFromHtml(html, /(?:href=["'][^"']*\/r\/|>\s*r\/)([A-Za-z0-9_]{2,21})/gi, query);
    return names.length > 0 ? buildSubredditSearchPayload(names) : null;
  }

  if (normalizedPath === '/users/search.json') {
    const names = collectNamesFromHtml(html, /(?:href=["'][^"']*\/(?:u|user)\/|>\s*u\/)([A-Za-z0-9_-]{2,24})/gi, query);
    return names.length > 0 ? buildUserSearchPayload(names) : null;
  }

  return null;
}

function parseRssDiscoveryListing(xml: string, upstreamPath: string): unknown | null {
  const normalizedPath = upstreamPath.split('?')[0] || '/';
  const query = getSearchQuery(upstreamPath);

  if (normalizedPath === '/api/search_reddit_names.json' || normalizedPath === '/subreddits/search.json') {
    const names = collectNamesFromHtml(xml, /(?:href=["'][^"']*\/r\/|>\s*r\/|\/r\/)([A-Za-z0-9_]{2,21})/gi, query);
    const payload = normalizedPath === '/api/search_reddit_names.json'
      ? { names: names.slice(0, 25) }
      : buildSubredditSearchPayload(names);

    return names.length > 0 ? payload : null;
  }

  if (normalizedPath === '/users/search.json') {
    const names = collectNamesFromHtml(xml, /(?:href=["'][^"']*\/(?:u|user)\/|>\s*u\/|\/u\/|\/user\/)([A-Za-z0-9_-]{2,24})/gi, query);
    return names.length > 0 ? buildUserSearchPayload(names) : null;
  }

  return null;
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

function getSyntheticRssAfter(
  children: Array<{ data?: { name?: unknown } }>,
  upstreamPath: string,
  pageSize: number,
): string | null {
  if (isCommentThreadPath(upstreamPath) || children.length < pageSize) {
    return null;
  }

  const name = children[children.length - 1]?.data?.name;
  return typeof name === 'string' && name ? name : null;
}

function parseRssPostChild(
  itemXml: string,
  upstreamPath: string,
  sourceBase: string,
  fallbackIndex: number,
): { kind: 't3'; data: Record<string, unknown> } {
  const subreddit = inferSubredditFromPath(upstreamPath);
  const user = inferUserFromPath(upstreamPath);
  const title = stripHtml(readXmlTag(itemXml, 'title')) || 'Untitled post';
  const link = readXmlAttribute(itemXml, 'link', 'href') || readXmlTag(itemXml, 'link') || readXmlTag(itemXml, 'guid');
  const author = normalizeUserName(readXmlAuthor(itemXml)) || user || '[unknown]';
  const content =
    readXmlTag(itemXml, 'content:encoded') ||
    readXmlTag(itemXml, 'content') ||
    readXmlTag(itemXml, 'summary') ||
    readXmlTag(itemXml, 'description');
  const enclosureUrl = normalizeUrlCandidate(
    readXmlAttribute(itemXml, 'enclosure', 'url') ||
      readXmlAttribute(itemXml, 'media:content', 'url') ||
      readXmlAttribute(itemXml, 'media:thumbnail', 'url'),
    sourceBase,
  );
  const created = Date.parse(readXmlTag(itemXml, 'pubDate') || readXmlTag(itemXml, 'updated') || readXmlTag(itemXml, 'published'));
  const id = stableIdFromUrl(link || title, fallbackIndex);
  const permalink = (() => {
    try {
      return new URL(link).pathname;
    } catch {
      return link.startsWith('/') ? link : `/r/${subreddit}/comments/${id}`;
    }
  })();
  const itemSubreddit = inferSubredditFromPermalink(permalink, subreddit);
  const sourceUrls = firstDistinctUrl(
    [
      enclosureUrl,
      ...readHtmlAttributes(content, 'src'),
    ],
    sourceBase,
  );
  const hrefUrls = firstDistinctUrl(
    [
      ...readHtmlAttributes(content, 'href'),
      link,
    ],
    sourceBase,
  );
  const contentUrls = firstDistinctUrl([...hrefUrls, ...sourceUrls], sourceBase);
  const imageUrl = sourceUrls.find(isLikelyImageUrl) ?? hrefUrls.find(isLikelyImageUrl) ?? '';
  const videoUrl = hrefUrls.find(isLikelyVideoUrl) ?? sourceUrls.find(isLikelyVideoUrl) ?? '';
  const embed = hrefUrls.map(buildKnownEmbed).find((value) => value !== null) ?? null;
  const externalUrl =
    hrefUrls.find((url) => !isRedditNavigationUrl(url) && !isLikelyImageUrl(url)) ??
    contentUrls.find((url) => !isRedditNavigationUrl(url) && !isLikelyImageUrl(url)) ??
    '';
  const outboundUrl = videoUrl || externalUrl || imageUrl || normalizeUrlCandidate(link, sourceBase) || `https://www.reddit.com${permalink}`;
  const thumbnailUrl = imageUrl || enclosureUrl;
  const selftext = cleanRssSelfText(content, title, outboundUrl);
  const domain = getUrlHostname(outboundUrl);
  const isMediaPost = Boolean(imageUrl || videoUrl || embed || externalUrl);

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
      selftext,
      over_18: false,
      url: outboundUrl,
      url_overridden_by_dest: outboundUrl,
      domain,
      is_self: !isMediaPost,
      post_hint: videoUrl ? 'hosted:video' : embed ? 'rich:video' : imageUrl ? 'image' : externalUrl ? 'link' : undefined,
      thumbnail: thumbnailUrl || undefined,
      media: embed
        ? {
            oembed: {
              provider_name: embed.provider,
              thumbnail_url: thumbnailUrl || undefined,
              html: `<iframe src="${embed.embedUrl}" allowfullscreen></iframe>`,
            },
          }
        : videoUrl
          ? {
              reddit_video: {
                fallback_url: videoUrl.endsWith('.gifv') ? videoUrl.replace(/\.gifv$/i, '.mp4') : videoUrl,
                hls_url: videoUrl.endsWith('.m3u8') ? videoUrl : undefined,
              },
            }
          : null,
      secure_media: embed
        ? {
            oembed: {
              provider_name: embed.provider,
              thumbnail_url: thumbnailUrl || undefined,
              html: `<iframe src="${embed.embedUrl}" allowfullscreen></iframe>`,
            },
          }
        : videoUrl
          ? {
              reddit_video: {
                fallback_url: videoUrl.endsWith('.gifv') ? videoUrl.replace(/\.gifv$/i, '.mp4') : videoUrl,
                hls_url: videoUrl.endsWith('.m3u8') ? videoUrl : undefined,
              },
            }
          : null,
      preview: thumbnailUrl
        ? {
            images: [
              {
                source: {
                  url: thumbnailUrl,
                },
              },
            ],
          }
        : undefined,
    },
  };
}

function parseRssCommentId(link: string, postId: string): string | null {
  const escapedPostId = postId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  try {
    const path = new URL(link).pathname;
    return path.match(new RegExp(`/comments/${escapedPostId}/[^/]+/([^/?#]+)`, 'i'))?.[1] ?? null;
  } catch {
    return link.match(new RegExp(`/comments/${escapedPostId}/[^/]+/([^/?#]+)`, 'i'))?.[1] ?? null;
  }
}

function readRssCommentAuthor(itemXml: string): string {
  const author = normalizeUserName(readXmlAuthor(itemXml));

  if (author) {
    return author;
  }

  const title = stripHtml(readXmlTag(itemXml, 'title'));
  return title.match(/^\/?u\/([A-Za-z0-9_-]+)/i)?.[1] ?? '[unknown]';
}

function readRssCommentBody(itemXml: string): string {
  const content =
    readXmlTag(itemXml, 'content:encoded') ||
    readXmlTag(itemXml, 'content') ||
    readXmlTag(itemXml, 'summary') ||
    readXmlTag(itemXml, 'description');

  return stripHtmlLines(content).join('\n\n');
}

function parseRssCommentsResponse(xml: string, upstreamPath: string, sourceBase = 'https://www.reddit.com'): unknown | null {
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const postId = inferCommentThreadId(upstreamPath);

  if (items.length === 0 || !postId) {
    return null;
  }

  const postIndex = items.findIndex((item, index) => {
    const itemXml = item[2];
    const link = readXmlAttribute(itemXml, 'link', 'href') || readXmlTag(itemXml, 'link') || readXmlTag(itemXml, 'guid');

    return stableIdFromUrl(link || readXmlTag(itemXml, 'title'), index) === postId && !parseRssCommentId(link, postId);
  });
  const resolvedPostIndex = postIndex >= 0 ? postIndex : 0;
  const postChild = parseRssPostChild(items[resolvedPostIndex][2], upstreamPath, sourceBase, resolvedPostIndex);
  const comments = items
    .map((item, index) => {
      if (index === resolvedPostIndex) {
        return null;
      }

      const itemXml = item[2];
      const link = readXmlAttribute(itemXml, 'link', 'href') || readXmlTag(itemXml, 'link') || readXmlTag(itemXml, 'guid');
      const id = parseRssCommentId(link, postId);
      const body = readRssCommentBody(itemXml);

      if (!id || !body) {
        return null;
      }

      return {
        kind: 't1',
        data: {
          id,
          author: readRssCommentAuthor(itemXml),
          body,
          replies: '',
        },
      };
    })
    .filter((item): item is { kind: 't1'; data: { id: string; author: string; body: string; replies: '' } } => item !== null);

  return [
    {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: [postChild],
      },
    },
    {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: comments,
      },
    },
  ];
}

function parseRssListing(xml: string, upstreamPath: string, sourceBase = 'https://www.reddit.com'): unknown | null {
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];

  if (items.length === 0) {
    return null;
  }

  const pageSize = Math.min(getRequestedListingLimit(upstreamPath), 25);
  const children = items
    .slice(0, pageSize)
    .map((item, index) => parseRssPostChild(item[2], upstreamPath, sourceBase, index));

  return {
    kind: 'Listing',
    data: {
      after: getSyntheticRssAfter(children, upstreamPath, pageSize),
      before: null,
      children,
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

function isPublicFallbackPath(upstreamPath: string): boolean {
  return isPublicPostPath(upstreamPath) || isPublicDiscoveryPath(upstreamPath);
}

function isCompatibleRedditPayload(payload: unknown, upstreamPath: string): boolean {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (normalizedPath === '/api/search_reddit_names.json') {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { names?: unknown[] }).names)
    );
  }

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

function getPublicInstanceAccept(method: PublicInstanceRequest['method']): string {
  if (method === 'json') {
    return 'application/json';
  }

  if (method === 'rss') {
    return 'application/rss+xml, application/atom+xml, application/xml, text/xml';
  }

  return 'text/html, application/xhtml+xml';
}

function parsePublicInstancePayload(
  body: string,
  contentType: string | null,
  request: PublicInstanceRequest,
  base: string,
  upstreamPath: string,
): unknown | null {
  const looksJson = request.method === 'json' || isJsonContentType(contentType) || /^[\s\r\n]*[\[{]/.test(body);
  const looksRss =
    request.method === 'rss' ||
    (contentType ?? '').toLowerCase().includes('rss') ||
    (contentType ?? '').toLowerCase().includes('atom') ||
    /<rss\b|<feed\b|<item\b/i.test(body);
  const looksHtml = request.method === 'html' || (contentType ?? '').toLowerCase().includes('html') || /<html\b|<a\s/i.test(body);

  if (looksJson) {
    return normalizePublicInstancePayload(JSON.parse(body), upstreamPath);
  }

  if (isPublicDiscoveryPath(upstreamPath)) {
    if (looksRss) {
      return parseRssDiscoveryListing(body, upstreamPath);
    }

    return looksHtml ? parseHtmlDiscoveryListing(body, upstreamPath) : null;
  }

  if (isCommentThreadPath(upstreamPath)) {
    if (looksRss) {
      return parseRssCommentsResponse(body, upstreamPath, base);
    }

    return looksHtml ? parseHtmlCommentsResponse(body, upstreamPath, base) : null;
  }

  if (looksRss) {
    return normalizePublicInstancePayload(parseRssListing(body, upstreamPath, base), upstreamPath);
  }

  return looksHtml ? normalizePublicInstancePayload(parseHtmlListing(body, upstreamPath, base), upstreamPath) : null;
}

async function fetchFromPublicInstance(
  base: string,
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<Response | null> {
  const requests = buildPublicInstanceRequests(base, upstreamPath);

  for (const request of requests) {
    try {
      const response = await fetchWithTimeout(
        `${base}${request.path}`,
        {
          headers: {
            Accept: getPublicInstanceAccept(request.method),
            'User-Agent': getProxyUserAgent(env, options),
          },
        },
        3000,
      );

      if (!response.ok) {
        continue;
      }

      const body = await response.text();
      const normalizedPayload = parsePublicInstancePayload(
        body,
        response.headers.get('content-type'),
        request,
        base,
        upstreamPath,
      );

      if (!isCompatibleRedditPayload(normalizedPayload, upstreamPath)) {
        continue;
      }

      return new Response(JSON.stringify(normalizedPayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=30, s-maxage=120',
          'X-RedAlt-Fallback': 'public-instance',
          'X-RedAlt-Instance': base,
          'X-RedAlt-Instance-Method': request.method,
        },
      });
    } catch {
      // Try the next supported access method for this instance.
    }
  }

  return null;
}

async function fetchViaPublicInstances(
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<Response | null> {
  if (!publicInstanceFallbackEnabled(env) || !isPublicFallbackPath(upstreamPath)) {
    return null;
  }

  const urls = await getPublicInstanceUrls(env, options);
  const { candidates, skipped } = getPublicInstanceCandidates(urls);
  const attempted: string[] = [];
  const batchSize = 8;

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    attempted.push(...batch);
    const results = await Promise.all(
      batch.map(async (base) => ({
        base,
        response: await fetchFromPublicInstance(base, upstreamPath, env, options),
      })),
    );
    const successfulResult = results.find((result) => result.response !== null);

    for (const result of results) {
      if (result.response) {
        markPublicInstanceSuccess(result.base);
      } else {
        markPublicInstanceFailure(result.base);
      }
    }

    if (successfulResult?.response) {
      successfulResult.response.headers.set('X-RedAlt-Instance-Attempts', formatInstanceHeader(attempted));

      if (skipped.length > 0) {
        successfulResult.response.headers.set('X-RedAlt-Skipped-Instances', formatInstanceHeader(skipped));
      }

      return successfulResult.response;
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

    const body = await response.text();
    const normalizedPayload = isCommentThreadPath(upstreamPath)
      ? parseRssCommentsResponse(body, upstreamPath)
      : parseRssListing(body, upstreamPath);

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
