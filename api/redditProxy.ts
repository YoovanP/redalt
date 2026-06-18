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

type MediaPref = 'instance' | 'reddit';

const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];
const PUBLIC_INSTANCE_LIST_URLS = [
  'https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json',
  'https://raw.githubusercontent.com/libreddit/libreddit-instances/master/instances.json',
];
const PUBLIC_INSTANCE_FAILURE_BASE_COOLDOWN_MS = 60 * 1000;
const PUBLIC_INSTANCE_FAILURE_MAX_COOLDOWN_MS = 15 * 60 * 1000;
const REDLIB_DETAIL_ENRICH_CONCURRENCY = 4;
const REDLIB_DETAIL_ENRICH_TIMEOUT_MS = 4000;
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

// The frontend appends `redalt_media=reddit` to request which media host to serve from.
// It must be read once and stripped before any upstream/fallback URL is built so it never
// leaks to Reddit/Redlib or fragments caches.
function extractMediaPref(upstreamPath: string): { pref: MediaPref; cleanPath: string } {
  const [path, rawQuery = ''] = upstreamPath.split('?');

  if (!rawQuery.includes('redalt_media')) {
    return { pref: 'instance', cleanPath: upstreamPath };
  }

  const params = new URLSearchParams(rawQuery);
  const pref: MediaPref = params.get('redalt_media') === 'reddit' ? 'reddit' : 'instance';
  params.delete('redalt_media');
  const query = params.toString();

  return { pref, cleanPath: query ? `${path}?${query}` : path };
}

// Maps a Redlib-served media path back to the original Reddit CDN, preserving the signed
// query. Only same-instance still-image paths are rewritten; video/stream paths (/vid, /hls)
// and anything not hosted on the serving instance are left untouched.
function rewriteRedlibImageUrl(url: string, instanceHost: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.hostname.toLowerCase() !== instanceHost) {
    return url;
  }

  const path = parsed.pathname;
  const search = parsed.search;

  if (/^\/(?:vid|hls)\//i.test(path)) {
    return url;
  }

  const externalPre = path.match(/^\/preview\/external-pre\/(.+)$/i);
  if (externalPre) {
    return `https://external-preview.redd.it/${externalPre[1]}${search}`;
  }

  const pre = path.match(/^\/preview\/pre\/(.+)$/i);
  if (pre) {
    return `https://preview.redd.it/${pre[1]}${search}`;
  }

  const img = path.match(/^\/img\/(.+)$/i);
  if (img) {
    return `https://i.redd.it/${img[1]}${search}`;
  }

  return url;
}

function rewriteRedlibVideoUrl(url: string, instanceHost: string): string {
  let path = url;
  let search = '';

  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== instanceHost) {
      return url;
    }
    path = parsed.pathname;
    search = parsed.search;
  } catch {
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      path = url.slice(0, qIdx);
      search = url.slice(qIdx);
    }
  }

  // Rewrite HLS: /hls/foo/HLSPlaylist.m3u8 -> https://v.redd.it/foo/HLSPlaylist.m3u8
  const hlsMatch = path.match(/^\/hls\/([^/]+)\/(.+)$/i);
  if (hlsMatch) {
    return `https://v.redd.it/${hlsMatch[1]}/${hlsMatch[2]}${search}`;
  }

  // Rewrite /vid/ (3-segment new Redlib): /vid/foo/DASH/360.mp4 -> https://v.redd.it/foo/DASH_360.mp4
  const vid3Match = path.match(/^\/vid\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (vid3Match) {
    return `https://v.redd.it/${vid3Match[1]}/${vid3Match[2]}_${vid3Match[3]}${search}`;
  }

  // Rewrite /vid/ (2-segment old Redlib): /vid/foo/360.mp4 -> https://v.redd.it/foo/DASH_360.mp4
  const vid2Match = path.match(/^\/vid\/([^/]+)\/([^/]+)$/i);
  if (vid2Match) {
    const segment2 = vid2Match[2].toLowerCase();
    const prefix = segment2 === 'cmaf' ? 'CMAF' : 'DASH';
    const size = segment2 === 'cmaf' ? '1080.mp4' : vid2Match[2];
    const separator = segment2.startsWith('dash_') || segment2.startsWith('cmaf_') ? '' : '_';
    return `https://v.redd.it/${vid2Match[1]}/${prefix}${separator}${size}${search}`;
  }

  return url;
}

// When the user prefers the Reddit CDN, rewrite still-image fields and video fields
// in the reconstructed payload.
function applyMediaSourcePreference(payload: unknown, base: string, pref: MediaPref): unknown {
  if (pref !== 'reddit' || !payload) {
    return payload;
  }

  let instanceHost: string;

  try {
    instanceHost = new URL(base).hostname.toLowerCase();
  } catch {
    return payload;
  }

  const rewrite = (value: unknown): unknown =>
    typeof value === 'string' && value ? rewriteRedlibImageUrl(value, instanceHost) : value;

  const isVideoPath = (urlStr: string): boolean => {
    try {
      const pathname = new URL(urlStr, base).pathname;
      return pathname.startsWith('/vid/') || pathname.startsWith('/hls/');
    } catch {
      return false;
    }
  };

  const rewriteData = (data: Record<string, unknown> | undefined): void => {
    if (!data) {
      return;
    }

    if (typeof data.url === 'string') {
      data.url = (isVideoPath(data.url) ? rewriteRedlibVideoUrl(data.url, instanceHost) : rewrite(data.url)) as string;
    }

    if (typeof data.url_overridden_by_dest === 'string') {
      data.url_overridden_by_dest = (isVideoPath(data.url_overridden_by_dest)
        ? rewriteRedlibVideoUrl(data.url_overridden_by_dest, instanceHost)
        : rewrite(data.url_overridden_by_dest)) as string;
    }

    if (typeof data.thumbnail === 'string') {
      data.thumbnail = rewrite(data.thumbnail) as string;
    }

    const preview = data.preview as { images?: Array<{ source?: { url?: unknown } }> } | undefined;
    if (preview?.images) {
      for (const image of preview.images) {
        if (image?.source && typeof image.source.url === 'string') {
          image.source.url = rewrite(image.source.url) as string;
        }
      }
    }

    const mediaMetadata = data.media_metadata as
      | Record<string, { s?: { u?: unknown; url?: unknown } }>
      | undefined;
    if (mediaMetadata) {
      for (const meta of Object.values(mediaMetadata)) {
        if (meta?.s) {
          if (typeof meta.s.u === 'string') {
            meta.s.u = rewrite(meta.s.u) as string;
          }
          if (typeof meta.s.url === 'string') {
            meta.s.url = rewrite(meta.s.url) as string;
          }
        }
      }
    }

    const media = data.media as { reddit_video?: Record<string, unknown>; oembed?: Record<string, unknown> } | undefined;
    if (media?.reddit_video) {
      if (typeof media.reddit_video.fallback_url === 'string') {
        media.reddit_video.fallback_url = rewriteRedlibVideoUrl(media.reddit_video.fallback_url, instanceHost);
      }
      if (typeof media.reddit_video.hls_url === 'string') {
        media.reddit_video.hls_url = rewriteRedlibVideoUrl(media.reddit_video.hls_url, instanceHost);
      }
      if (typeof media.reddit_video.dash_url === 'string') {
        media.reddit_video.dash_url = rewriteRedlibVideoUrl(media.reddit_video.dash_url, instanceHost);
      }
    }

    if (media?.oembed && typeof media.oembed.thumbnail_url === 'string') {
      media.oembed.thumbnail_url = rewrite(media.oembed.thumbnail_url) as string;
    }

    const secureMedia = data.secure_media as { reddit_video?: Record<string, unknown>; oembed?: Record<string, unknown> } | undefined;
    if (secureMedia?.reddit_video) {
      if (typeof secureMedia.reddit_video.fallback_url === 'string') {
        secureMedia.reddit_video.fallback_url = rewriteRedlibVideoUrl(secureMedia.reddit_video.fallback_url, instanceHost);
      }
      if (typeof secureMedia.reddit_video.hls_url === 'string') {
        secureMedia.reddit_video.hls_url = rewriteRedlibVideoUrl(secureMedia.reddit_video.hls_url, instanceHost);
      }
      if (typeof secureMedia.reddit_video.dash_url === 'string') {
        secureMedia.reddit_video.dash_url = rewriteRedlibVideoUrl(secureMedia.reddit_video.dash_url, instanceHost);
      }
    }

    if (secureMedia?.oembed && typeof secureMedia.oembed.thumbnail_url === 'string') {
      secureMedia.oembed.thumbnail_url = rewrite(secureMedia.oembed.thumbnail_url) as string;
    }
  };

  const listings = Array.isArray(payload) ? payload : [payload];
  for (const listing of listings) {
    for (const child of listingChildren(listing)) {
      rewriteData(child.data);
    }
  }

  return payload;
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

  const { pref: mediaPref, cleanPath } = extractMediaPref(upstreamPath);

  if (options.cloudflareProxyBase) {
    const cloudflareResponse = await fetchWithTimeout(
      `${options.cloudflareProxyBase}${cleanPath}`,
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

  const publicInstanceResponse = await fetchViaPublicInstances(cleanPath, env, options, mediaPref);

  if (publicInstanceResponse) {
    return publicInstanceResponse;
  }

  let fallbackResponse: Response | null = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamResponse = await fetchWithTimeout(
      `${host}${cleanPath}`,
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

  const mirrorResponse = await fetchViaAllOrigins(cleanPath, env, options).catch(() => null);

  if (mirrorResponse?.ok && isJsonContentType(mirrorResponse.headers.get('content-type'))) {
    return responseFromUpstream(mirrorResponse, 'public, max-age=30, s-maxage=120');
  }

  const redditRssResponse = await fetchViaRedditRss(cleanPath, env, options);

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

function getPublicInstanceFailureCount(base: string): number {
  return publicInstanceHealth.get(getPublicInstanceHealthKey(base))?.failureCount ?? 0;
}

// Lower rank is tried first. Redlib/Libreddit serve full-fidelity HTML (media, comments, real
// scores), so they lead; teddit is JSON-only and frequently down; troddit is heavy; eddrit is
// skipped entirely in fetchFromPublicInstance and only ranks last as a defensive default.
function rankPublicInstance(base: string): number {
  if (isEddritInstance(base)) {
    return 3;
  }

  if (isTrodditInstance(base)) {
    return 2;
  }

  if (isTedditInstance(base)) {
    return 1;
  }

  return 0;
}

function getPublicInstanceCandidates(urls: string[]): { candidates: string[]; skipped: string[] } {
  const skipped: string[] = [];
  const candidates: Array<{ url: string; index: number }> = [];
  const now = Date.now();

  urls.forEach((url, index) => {
    if (isPublicInstanceCoolingDown(url, now)) {
      skipped.push(url);
    } else {
      candidates.push({ url, index });
    }
  });

  // Stable sort: Redlib-capable instances first, then those with fewer recent failures, then
  // the original list order so configured/static preferences are preserved within a tier.
  candidates.sort((a, b) => {
    const rankDiff = rankPublicInstance(a.url) - rankPublicInstance(b.url);

    if (rankDiff !== 0) {
      return rankDiff;
    }

    const failureDiff = getPublicInstanceFailureCount(a.url) - getPublicInstanceFailureCount(b.url);

    if (failureDiff !== 0) {
      return failureDiff;
    }

    return a.index - b.index;
  });

  const ordered = candidates.map((entry) => entry.url);

  return {
    candidates: ordered.length > 0 ? ordered : urls,
    skipped: ordered.length > 0 ? skipped : [],
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
  const commentThreadMatch = path.match(/^\/r\/([^/]+)\/comments\/([^/]+)(?:\/.*)?$/i);
  const subredditSearchMatch = path.match(/^\/r\/([^/]+)\/search$/i);
  const subredditMatch = path.match(/^\/r\/([^/]+)(?:\/(hot|new|rising|top))?$/i);
  const userMatch = path.match(/^\/user\/([^/]+)\/submitted$/i);
  const isListingPath = Boolean(subredditSearchMatch || subredditMatch || userMatch || path === '/search');

  if (isListingPath) {
    const requestedLimit = Number(rssParams.get('limit') ?? 25);
    const fallbackLimit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit) * 4, 50), 100)
      : 50;

    rssParams.set('limit', String(fallbackLimit));
    rssParams.delete('after');
    rssParams.delete('before');
    rssParams.delete('count');
  }

  const query = rssParams.toString();
  const withQuery = (rssPath: string) => `${rssPath}${query ? `?${query}` : ''}`;

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
  const subredditSearchMatch = path.match(/^\/r\/([^/]+)\/search$/i);
  const subredditMatch = path.match(/^\/r\/([^/]+)(?:\/(hot|new|rising|top))?$/i);
  const userMatch = path.match(/^\/user\/([^/]+)\/submitted$/i);
  const isListingPath = Boolean(subredditSearchMatch || subredditMatch || userMatch || path === '/search');

  if (isListingPath) {
    const requestedLimit = Number(params.get('limit') ?? 25);
    const fallbackLimit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit) * 4, 50), 100)
      : 50;

    params.set('limit', String(fallbackLimit));
  }

  params.delete('raw_json');
  const query = params.toString();
  const withQuery = (htmlPath: string) => `${htmlPath}${query ? `?${query}` : ''}`;
  const commentThreadMatch = path.match(/^\/r\/([^/]+)\/comments\/([^/]+)(?:\/.*)?$/i);

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

  // HTML first: Redlib renders full-quality media (video/image/gallery/comments) in HTML.
  // RSS is a text-only last resort (Redlib RSS has no media), skipped for Troddit.
  addPublicInstanceRequest(requests, seen, 'html', buildPublicHtmlPath(upstreamPath));

  if (!isTrodditInstance(base)) {
    addPublicInstanceRequest(requests, seen, 'rss', buildRssPath(upstreamPath));
  }

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

function readHtmlAttribute(openTag: string, attribute: string): string {
  const quoted = openTag.match(new RegExp(`\\s${attribute}=(["'])([\\s\\S]*?)\\1`, 'i'));

  if (quoted) {
    return decodeXmlEntities(quoted[2] ?? '').trim();
  }

  const unquoted = openTag.match(new RegExp(`\\s${attribute}=([^\\s>]+)`, 'i'));
  return decodeXmlEntities(unquoted?.[1] ?? '').trim();
}

function readHtmlMetaContent(html: string, key: string): string {
  const normalizedKey = key.toLowerCase();

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = (readHtmlAttribute(tag, 'property') || readHtmlAttribute(tag, 'name')).toLowerCase();

    if (name === normalizedKey) {
      return readHtmlAttribute(tag, 'content');
    }
  }

  return '';
}

function hasHtmlClass(openTag: string, className: string): boolean {
  return readHtmlAttribute(openTag, 'class')
    .split(/\s+/)
    .some((value) => value === className);
}

type HtmlTagBlock = {
  openTag: string;
  innerHtml: string;
  innerStart: number;
  innerEnd: number;
  end: number;
};

function findHtmlTagBlockAt(html: string, tagName: string, openTagStart: number): HtmlTagBlock | null {
  const openMatch = html.slice(openTagStart).match(new RegExp(`^<${tagName}\\b[^>]*>`, 'i'));

  if (!openMatch) {
    return null;
  }

  const openTag = openMatch[0];
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  let depth = 0;
  tagPattern.lastIndex = openTagStart;

  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const tag = match[0];

    if (/^<\//.test(tag)) {
      depth -= 1;

      if (depth === 0) {
        const innerStart = openTagStart + openTag.length;
        const innerEnd = match.index;

        return {
          openTag,
          innerHtml: html.slice(innerStart, innerEnd),
          innerStart,
          innerEnd,
          end: match.index + tag.length,
        };
      }
    } else if (!/\/>$/.test(tag)) {
      depth += 1;
    }
  }

  return null;
}

function findFirstHtmlTagBlock(html: string, tagName: string, className: string): HtmlTagBlock | null {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');

  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    if (!hasHtmlClass(match[0], className)) {
      continue;
    }

    return findHtmlTagBlockAt(html, tagName, match.index);
  }

  return null;
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
  const allChildren = parseHtmlPostLinks(html, upstreamPath, sourceBase);
  const startIndex = getPaginatedStartIndex(allChildren, upstreamPath, true);

  if (startIndex === null) {
    return null;
  }

  const children = allChildren.slice(startIndex, startIndex + pageSize);

  if (children.length === 0) {
    return null;
  }

  return {
    kind: 'Listing',
    data: {
      after: getSyntheticRssAfter(allChildren, upstreamPath, pageSize, startIndex),
      before: null,
      children,
    },
  };
}

function isEddritInstance(base: string): boolean {
  try {
    return new URL(base).hostname.toLowerCase().includes('eddrit');
  } catch {
    return false;
  }
}

// Eddrit and some Redlib mirrors sit behind the Anubis proof-of-work wall, which answers
// with an HTTP 200 HTML challenge page. Detect it so it is treated as a failure, never parsed.
function isAnubisChallenge(body: string): boolean {
  return (
    /making sure you(?:&#39;|')re not a bot/i.test(body) ||
    body.includes('anubis_challenge') ||
    body.includes('/.within.website/x/cmd/anubis')
  );
}

// Public instances increasingly hide behind anti-bot walls that answer with an interstitial
// instead of Reddit-shaped content: Anubis (above), go-away (Angie/HTTP 418), and Cloudflare's
// "Just a moment" challenge. Treat any of them as a failure so the instance is skipped and
// cooled down rather than parsed into a bogus post.
function isInstanceChallenge(body: string): boolean {
  return (
    isAnubisChallenge(body) ||
    /\bgo-away\b/i.test(body) ||
    /checking (?:you are|if you are|if the site connection is secure)/i.test(body) ||
    /just a moment\b/i.test(body) ||
    /cf-browser-verification|challenge-platform|__cf_chl/i.test(body)
  );
}

function looksRedlibHtml(body: string): boolean {
  return (
    /\bclass=["'][^"']*\bpost_header\b/i.test(body) ||
    /\bclass=["'][^"']*\bpost_media_content\b/i.test(body) ||
    /\bid=["']comment_count["']/i.test(body) ||
    /<div\b[^>]*\bclass=["'][^"']*\bpost\b[^"']*["'][^>]*\bid=/i.test(body)
  );
}

function toPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function urlWidthParam(url: string): number | undefined {
  try {
    const width = Number(new URL(url).searchParams.get('width'));
    return Number.isFinite(width) && width > 0 ? width : undefined;
  } catch {
    return undefined;
  }
}

function fullSizeRedditImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const previewMatch = pathname.match(/^\/preview\/pre\/(.+)$/i);

    if (previewMatch) {
      return `${parsed.origin}/img/${previewMatch[1]}`;
    }

    if (parsed.hostname.toLowerCase() === 'preview.redd.it') {
      const imageName = pathname.split('/').filter(Boolean).at(-1);
      return imageName ? `https://i.redd.it/${imageName}` : url;
    }
  } catch {
    // Keep the original URL if it cannot be parsed.
  }

  return url;
}

function mimeFromUrl(url: string): string {
  const path = getUrlPathname(url);

  if (/\.png(?:[?#]|$)/i.test(path)) {
    return 'image/png';
  }
  if (/\.gif(?:[?#]|$)/i.test(path)) {
    return 'image/gif';
  }
  if (/\.webp(?:[?#]|$)/i.test(path)) {
    return 'image/webp';
  }

  return 'image/jpeg';
}

function findRedlibPostBlocks(html: string): Array<{ openTag: string; block: HtmlTagBlock }> {
  const blocks: Array<{ openTag: string; block: HtmlTagBlock }> = [];
  const tagPattern = /<div\b[^>]*>/gi;

  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const openTag = match[0];

    // Listing posts are `<div class="post" id="...">`; the detail-page post is
    // `<div class="post highlighted">` with no id, so don't require an id here.
    if (!hasHtmlClass(openTag, 'post')) {
      continue;
    }

    const block = findHtmlTagBlockAt(html, 'div', match.index);

    if (!block) {
      continue;
    }

    blocks.push({ openTag, block });
    tagPattern.lastIndex = block.end;
  }

  return blocks;
}

function redlibVideoMedia(
  innerHtml: string,
  sourceBase: string,
): { fallbackUrl: string; hlsUrl?: string; width?: number; height?: number } | null {
  const videoBlock = findFirstHtmlTagBlock(innerHtml, 'video', 'post_media_video');

  if (!videoBlock) {
    return null;
  }

  let mp4 = '';
  let hls = '';
  const videoSrc = normalizeUrlCandidate(readHtmlAttribute(videoBlock.openTag, 'src'), sourceBase);

  if (videoSrc) {
    if (/\.m3u8(?:[?#]|$)/i.test(videoSrc) || /\/hls\//i.test(videoSrc)) {
      hls = videoSrc;
    } else {
      mp4 = videoSrc;
    }
  }

  for (const match of videoBlock.innerHtml.matchAll(/<source\b[^>]*>/gi)) {
    const tag = match[0];
    const src = normalizeUrlCandidate(readHtmlAttribute(tag, 'src'), sourceBase);

    if (!src) {
      continue;
    }

    const type = readHtmlAttribute(tag, 'type').toLowerCase();

    if (type.includes('mpegurl') || /\.m3u8(?:[?#]|$)/i.test(src) || /\/hls\//i.test(src)) {
      hls = hls || src;
    } else {
      mp4 = mp4 || src;
    }
  }

  if (!mp4 && !hls) {
    return null;
  }

  const width = Number(readHtmlAttribute(videoBlock.openTag, 'width')) || undefined;
  const height = Number(readHtmlAttribute(videoBlock.openTag, 'height')) || undefined;

  return { fallbackUrl: mp4 || hls, hlsUrl: hls || undefined, width, height };
}

function redlibPostMediaHint(innerHtml: string): string {
  const postTypeMatch = innerHtml.match(/<!--\s*post_type:\s*([a-z0-9:_-]+)\s*-->/i);

  if (postTypeMatch?.[1]) {
    return postTypeMatch[1].toLowerCase();
  }

  const thumbBlock = findFirstHtmlTagBlock(innerHtml, 'a', 'post_thumbnail');
  const thumbnailLabel = thumbBlock ? stripHtml(thumbBlock.innerHtml).toLowerCase() : '';

  if (/\bvideo\b/.test(thumbnailLabel)) {
    return 'video';
  }

  if (/\bgallery\b/.test(thumbnailLabel)) {
    return 'gallery';
  }

  if (/\bimage\b/.test(thumbnailLabel)) {
    return 'image';
  }

  return '';
}

function redlibImageSource(
  innerHtml: string,
  sourceBase: string,
): { url: string; width?: number; height?: number } | null {
  const anchorBlock = findFirstHtmlTagBlock(innerHtml, 'a', 'post_media_image');
  let href = anchorBlock ? readHtmlAttribute(anchorBlock.openTag, 'href') : '';

  if (!href) {
    const contentBlock = findFirstHtmlTagBlock(innerHtml, 'div', 'post_media_content');
    const imgTag = contentBlock ? contentBlock.innerHtml.match(/<img\b[^>]*>/i)?.[0] ?? '' : '';
    href = imgTag ? readHtmlAttribute(imgTag, 'src') : '';
  }

  const url = fullSizeRedditImageUrl(normalizeUrlCandidate(href, sourceBase));

  if (!url) {
    return null;
  }

  if (!/^\/(?:preview|img)\//i.test(toPathname(url)) && !isLikelyImageUrl(url)) {
    return null;
  }

  return { url, width: urlWidthParam(url) };
}

function redlibGalleryItems(
  innerHtml: string,
  sourceBase: string,
): Array<{ mediaId: string; url: string; width?: number; mimeType: string }> {
  const galleryBlock = findFirstHtmlTagBlock(innerHtml, 'div', 'gallery');

  if (!galleryBlock) {
    return [];
  }

  const items: Array<{ mediaId: string; url: string; width?: number; mimeType: string }> = [];
  const seen = new Set<string>();

  for (const match of galleryBlock.innerHtml.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)) {
    const figureHtml = match[1] ?? '';
    const anchorTag = figureHtml.match(/<a\b[^>]*>/i)?.[0] ?? '';
    let href = anchorTag ? readHtmlAttribute(anchorTag, 'href') : '';

    if (!href) {
      const imgTag = figureHtml.match(/<img\b[^>]*>/i)?.[0] ?? '';
      href = imgTag ? readHtmlAttribute(imgTag, 'src') : '';
    }

    const url = fullSizeRedditImageUrl(normalizeUrlCandidate(href, sourceBase));

    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    const slug = toPathname(url).split('/').filter(Boolean).at(-1) ?? '';
    const mediaId = slug.replace(/\.[a-z0-9]+$/i, '') || `g${items.length}`;
    items.push({ mediaId, url, width: urlWidthParam(url), mimeType: mimeFromUrl(url) });
  }

  return items;
}

function redlibThumbnail(innerHtml: string, sourceBase: string): string {
  const videoTag = innerHtml.match(/<video\b[^>]*>/i)?.[0] ?? '';
  const poster = videoTag ? normalizeUrlCandidate(readHtmlAttribute(videoTag, 'poster'), sourceBase) : '';

  if (poster) {
    return poster;
  }

  const thumbBlock = findFirstHtmlTagBlock(innerHtml, 'a', 'post_thumbnail');
  const contentBlock = findFirstHtmlTagBlock(innerHtml, 'div', 'post_media_content');
  const imgTag =
    (thumbBlock ? thumbBlock.innerHtml.match(/<img\b[^>]*>/i)?.[0] : undefined) ??
    (contentBlock ? contentBlock.innerHtml.match(/<img\b[^>]*>/i)?.[0] : undefined) ??
    '';
  const src = imgTag ? readHtmlAttribute(imgTag, 'src') : '';

  return normalizeUrlCandidate(src, sourceBase);
}

function redlibOutboundCandidates(innerHtml: string, sourceBase: string): string[] {
  const candidates: string[] = [];
  const thumbBlock = findFirstHtmlTagBlock(innerHtml, 'a', 'post_thumbnail');

  if (thumbBlock) {
    candidates.push(readHtmlAttribute(thumbBlock.openTag, 'href'));
  }

  const linkTag = innerHtml.match(/<a\b[^>]*\bclass=["'][^"']*\bpost_(?:url|link)\b[^"']*["'][^>]*>/i)?.[0] ?? '';

  if (linkTag) {
    candidates.push(readHtmlAttribute(linkTag, 'href'));
  }

  return candidates.map((href) => normalizeUrlCandidate(href, sourceBase)).filter(Boolean);
}

function redlibKnownEmbed(
  innerHtml: string,
  sourceBase: string,
): { provider: string; embedUrl: string; sourceUrl: string } | null {
  for (const url of redlibOutboundCandidates(innerHtml, sourceBase)) {
    const embed = buildKnownEmbed(url);

    if (embed) {
      return { provider: embed.provider, embedUrl: embed.embedUrl, sourceUrl: url };
    }
  }

  return null;
}

function redlibOutboundUrl(innerHtml: string, sourceBase: string, instanceHost: string): string {
  for (const url of redlibOutboundCandidates(innerHtml, sourceBase)) {
    const host = getUrlHostname(url);

    if (!host || host === instanceHost || isRedditNavigationUrl(url)) {
      continue;
    }

    return url;
  }

  return '';
}

function redlibListingCommentCount(innerHtml: string): number {
  const linkMatch = innerHtml.match(/<a\b[^>]*\bclass=["'][^"']*\bpost_comments\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  const text = stripHtml(linkMatch?.[1] ?? '');
  const valueMatch = text.match(/([\d,.]+)\s*([km])?/i);

  if (!valueMatch) {
    return 0;
  }

  const parsed = Number((valueMatch[1] ?? '').replace(/,/g, ''));
  const multiplier = valueMatch[2]?.toLowerCase() === 'm' ? 1_000_000 : valueMatch[2]?.toLowerCase() === 'k' ? 1_000 : 1;

  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : 0;
}

function findRedlibTitleLink(
  titleHtml: string,
  sourceBase: string,
): { permalink: string; title: string } | null {
  let fallback: { permalink: string; title: string } | null = null;

  for (const match of titleHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const openTag = match[0].match(/^<a\b[^>]*>/i)?.[0] ?? '';

    if (!openTag || hasHtmlClass(openTag, 'post_flair')) {
      continue;
    }

    const permalink = toPathname(normalizeUrlCandidate(readHtmlAttribute(openTag, 'href'), sourceBase));
    const title = stripHtml(match[1] ?? '');

    if (!permalink && !title) {
      continue;
    }

    const candidate = { permalink, title };

    if (/\/comments\//i.test(permalink)) {
      return candidate;
    }

    fallback ??= candidate;
  }

  return fallback;
}

// Reconstruct a full Reddit `t3` post (with media) from a single Redlib `<div class="post">` block.
function parseRedlibPostBlock(
  openTag: string,
  innerHtml: string,
  upstreamPath: string,
  sourceBase: string,
  mediaPref: MediaPref,
  fallbackId = '',
): { kind: 't3'; data: Record<string, unknown> } | null {
  const id = readHtmlAttribute(openTag, 'id') || fallbackId;

  if (!id) {
    return null;
  }

  const fallbackSubreddit = inferSubredditFromPath(upstreamPath);
  const subredditMatch = innerHtml.match(
    /<a\b[^>]*\bclass=["'][^"']*\bpost_subreddit\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
  );
  const subreddit = normalizeCommunityName(stripHtml(subredditMatch?.[1] ?? '')) || fallbackSubreddit;

  const authorMatch = innerHtml.match(
    /<a\b[^>]*\bclass=["'][^"']*\bpost_author\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
  );
  const author = normalizeUserName(stripHtml(authorMatch?.[1] ?? '')) || '[unknown]';

  let title = '';
  let permalink = '';
  const titleBlock =
    findFirstHtmlTagBlock(innerHtml, 'h1', 'post_title') ?? findFirstHtmlTagBlock(innerHtml, 'h2', 'post_title');

  if (titleBlock) {
    const titleLink = findRedlibTitleLink(titleBlock.innerHtml, sourceBase);

    if (titleLink) {
      permalink = titleLink.permalink;
      title = titleLink.title;
    }

    if (!title) {
      title = stripHtml(titleBlock.innerHtml);
    }
  } else {
    const anchorBlock = findFirstHtmlTagBlock(innerHtml, 'a', 'post_title');

    if (anchorBlock) {
      permalink = toPathname(normalizeUrlCandidate(readHtmlAttribute(anchorBlock.openTag, 'href'), sourceBase));
      title = stripHtml(anchorBlock.innerHtml);
    }
  }

  if (!/\/comments\//i.test(permalink)) {
    permalink = `/r/${subreddit}/comments/${id}/`;
  }

  if (!title) {
    title = titleFromPermalink(permalink);
  }

  const scoreTag = innerHtml.match(/<[^>]*\bclass=["'][^"']*\bpost_score\b[^"']*["'][^>]*>/i)?.[0] ?? '';
  const scoreTitle = scoreTag ? readHtmlAttribute(scoreTag, 'title').replace(/,/g, '') : '';
  const score = /^\d+$/.test(scoreTitle) ? Number(scoreTitle) : 0;

  const flairMatch = innerHtml.match(/<[^>]*\bclass=["'][^"']*\bpost_flair\b[^"']*["'][^>]*>([\s\S]*?)<\//i);
  const flair = stripHtml(flairMatch?.[1] ?? '');

  const over18 = /\bclass=["'][^"']*\bnsfw\b/i.test(innerHtml) || hasHtmlClass(openTag, 'nsfw');

  const createdTag = innerHtml.match(/<[^>]*\bclass=["'][^"']*\bcreated\b[^"']*["'][^>]*>/i)?.[0] ?? '';
  const createdMs = Date.parse(createdTag ? readHtmlAttribute(createdTag, 'title') : '');

  const bodyBlock = findFirstHtmlTagBlock(innerHtml, 'div', 'post_body');
  const selftext = bodyBlock ? stripHtmlLines(bodyBlock.innerHtml).join('\n\n') : '';
  const thumbnail = redlibThumbnail(innerHtml, sourceBase);
  const instanceHost = getUrlHostname(sourceBase);

  const data: Record<string, unknown> = {
    id,
    name: `t3_${id}`,
    title,
    author,
    subreddit,
    permalink,
    score,
    ups: score,
    num_comments: redlibListingCommentCount(innerHtml),
    created_utc: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : Math.floor(Date.now() / 1000),
    selftext,
    over_18: over18,
    is_self: false,
  };

  if (flair && !/^(?:nsfw|oc|spoiler)$/i.test(flair)) {
    data.link_flair_text = flair;
  }

  if (thumbnail) {
    data.thumbnail = thumbnail;
  }

  const mediaHint = redlibPostMediaHint(innerHtml);

  if (mediaHint === 'video') {
    data.is_video = true;
    data.post_hint = 'hosted:video';
  }

  const embed = redlibKnownEmbed(innerHtml, sourceBase);
  const video = redlibVideoMedia(innerHtml, sourceBase);
  const gallery = redlibGalleryItems(innerHtml, sourceBase);
  const image = redlibImageSource(innerHtml, sourceBase);
  const shouldUseEmbed = Boolean(embed && (!video || mediaPref === 'reddit'));
  const shouldUseVideo = Boolean(video && (!embed || mediaPref !== 'reddit'));

  if (shouldUseEmbed && embed) {
    const mediaObject = {
      oembed: {
        provider_name: embed.provider,
        thumbnail_url: thumbnail || undefined,
        html: `<iframe src="${embed.embedUrl}" allowfullscreen></iframe>`,
      },
    };
    data.url = embed.sourceUrl;
    data.url_overridden_by_dest = embed.sourceUrl;
    data.domain = getUrlHostname(embed.sourceUrl);
    data.post_hint = 'rich:video';
    data.media = mediaObject;
    data.secure_media = mediaObject;
  } else if (shouldUseVideo && video) {
    const redditVideo = {
      fallback_url: video.fallbackUrl,
      hls_url: video.hlsUrl,
      width: video.width,
      height: video.height,
      is_gif: false,
    };
    data.is_video = true;
    data.post_hint = 'hosted:video';
    data.url = video.fallbackUrl;
    data.url_overridden_by_dest = video.fallbackUrl;
    data.domain = 'v.redd.it';
    data.media = { reddit_video: redditVideo };
    data.secure_media = { reddit_video: redditVideo };
  } else if (gallery.length > 0) {
    const mediaMetadata: Record<string, unknown> = {};

    for (const item of gallery) {
      mediaMetadata[item.mediaId] = {
        status: 'valid',
        e: 'Image',
        m: item.mimeType,
        s: { u: item.url, x: item.width },
        p: [],
      };
    }

    data.is_gallery = true;
    data.gallery_data = { items: gallery.map((item, index) => ({ media_id: item.mediaId, id: index })) };
    data.media_metadata = mediaMetadata;
    data.url = `https://www.reddit.com${permalink}`;
    data.domain = 'reddit.com';
    data.preview = {
      enabled: true,
      images: [{ source: { url: gallery[0].url, width: gallery[0].width }, resolutions: [] }],
    };
  } else if (image) {
    data.post_hint = 'image';
    data.url = image.url;
    data.url_overridden_by_dest = image.url;
    data.domain = getUrlHostname(image.url);
    data.preview = {
      enabled: true,
      images: [{ source: { url: image.url, width: image.width, height: image.height }, resolutions: [] }],
    };
  } else {
    const outbound = redlibOutboundUrl(innerHtml, sourceBase, instanceHost);

    if (outbound) {
      data.url = outbound;
      data.url_overridden_by_dest = outbound;
      data.domain = getUrlHostname(outbound);
      data.post_hint = 'link';
    } else if (thumbnail && mediaHint !== 'video') {
      // Redlib sometimes collapses media posts to 140px preview thumbnails in listings.
      // Upgrade Reddit-hosted previews to the full image path before exposing them as media.
      const fullImageUrl = fullSizeRedditImageUrl(thumbnail);

      data.post_hint = 'image';
      data.url = fullImageUrl;
      data.url_overridden_by_dest = fullImageUrl;
      data.domain = getUrlHostname(fullImageUrl);
      data.preview = {
        enabled: true,
        images: [{ source: { url: fullImageUrl, width: urlWidthParam(fullImageUrl) }, resolutions: [] }],
      };
    } else {
      data.is_self = true;
      data.url = `https://www.reddit.com${permalink}`;
      data.domain = 'reddit.com';
    }
  }

  return { kind: 't3', data };
}

function parseRedlibListing(html: string, upstreamPath: string, sourceBase: string, mediaPref: MediaPref): unknown | null {
  const pageSize = Math.min(getRequestedListingLimit(upstreamPath), 25);
  const nativeAfter = getHtmlListingNextAfter(html, upstreamPath, sourceBase);
  const allChildren = findRedlibPostBlocks(html)
    .map(({ openTag, block }) => parseRedlibPostBlock(openTag, block.innerHtml, upstreamPath, sourceBase, mediaPref))
    .filter((child): child is { kind: 't3'; data: Record<string, unknown> } => child !== null);

  if (allChildren.length === 0) {
    return null;
  }

  const startIndex = getPaginatedStartIndex(allChildren, upstreamPath, true);

  if (startIndex === null) {
    return null;
  }

  const children = allChildren.slice(startIndex, startIndex + pageSize);

  if (children.length === 0) {
    return null;
  }

  return {
    kind: 'Listing',
    data: {
      after: getSyntheticRssAfter(allChildren, upstreamPath, pageSize, startIndex) ?? nativeAfter,
      before: null,
      children,
    },
  };
}

function parseRedlibCommentsResponse(html: string, upstreamPath: string, sourceBase: string, mediaPref: MediaPref): unknown | null {
  const postId = inferCommentThreadId(upstreamPath);
  const blocks = findRedlibPostBlocks(html);

  if (blocks.length === 0) {
    return null;
  }

  const chosen =
    blocks.find(({ openTag }) => readHtmlAttribute(openTag, 'id') === postId) ??
    blocks.find(({ openTag }) => hasHtmlClass(openTag, 'highlighted')) ??
    blocks[0];
  const postChild = parseRedlibPostBlock(chosen.openTag, chosen.block.innerHtml, upstreamPath, sourceBase, mediaPref, postId);

  if (!postChild) {
    return null;
  }

  const comments = parseHtmlCommentChildren(html);
  const commentCount = readHtmlCommentCount(html);
  postChild.data.num_comments = Math.max(commentCount, comments.length, Number(postChild.data.num_comments) || 0);

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

function readHtmlCommentAuthor(commentHtml: string): string {
  const authorMatch = commentHtml.match(/<a\b[^>]*\bclass=["'][^"']*\bcomment_author\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  return normalizeUserName(stripHtml(authorMatch?.[1] ?? '')) || '[unknown]';
}

function readHtmlCommentBody(commentHtml: string): string {
  const bodyBlock = findFirstHtmlTagBlock(commentHtml, 'div', 'comment_body');
  return bodyBlock ? stripHtmlLines(bodyBlock.innerHtml).join('\n\n') : '';
}

function parseHtmlCommentChildren(html: string): Array<{ kind: 't1'; data: Record<string, unknown> }> {
  const comments: Array<{ kind: 't1'; data: Record<string, unknown> }> = [];
  const tagPattern = /<div\b[^>]*>/gi;

  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const openTag = match[0];

    if (!hasHtmlClass(openTag, 'comment')) {
      continue;
    }

    const id = readHtmlAttribute(openTag, 'id');
    const commentBlock = id ? findHtmlTagBlockAt(html, 'div', match.index) : null;

    if (!id || !commentBlock) {
      continue;
    }

    const author = readHtmlCommentAuthor(commentBlock.innerHtml);
    const body = readHtmlCommentBody(commentBlock.innerHtml);
    const repliesBlock = findFirstHtmlTagBlock(commentBlock.innerHtml, 'blockquote', 'replies');
    const replyChildren = repliesBlock ? parseHtmlCommentChildren(repliesBlock.innerHtml) : [];

    if (body) {
      comments.push({
        kind: 't1',
        data: {
          id,
          name: `t1_${id}`,
          author,
          body,
          replies: replyChildren.length > 0
            ? {
                kind: 'Listing',
                data: {
                  after: null,
                  before: null,
                  children: replyChildren,
                },
              }
            : '',
        },
      });
    }

    tagPattern.lastIndex = commentBlock.end;
  }

  return comments;
}

function readHtmlCommentCount(html: string): number {
  const countMatch = html.match(/<[^>]+\bid=["']comment_count["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  const text = stripHtml(countMatch?.[1] ?? '');
  const valueMatch = text.match(/([\d,.]+)\s*([km])?\s+comments?/i);

  if (!valueMatch) {
    return 0;
  }

  const parsed = Number((valueMatch[1] ?? '').replace(/,/g, ''));
  const multiplier = valueMatch[2]?.toLowerCase() === 'm' ? 1_000_000 : valueMatch[2]?.toLowerCase() === 'k' ? 1_000 : 1;

  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : 0;
}

function extractVRedditIdFromHtml(html: string): string {
  const decoded = decodeXmlEntities(html);
  const match = decoded.match(/https?:\\?\/\\?\/v\.redd\.it\\?\/([A-Za-z0-9]+)/i);

  return match?.[1] ?? '';
}

function applyRedditHtmlVideoMedia(data: Record<string, unknown>, html: string, sourceBase: string): void {
  const videoId = extractVRedditIdFromHtml(html);

  if (!videoId) {
    return;
  }

  const videoPageUrl = `https://v.redd.it/${videoId}`;
  const hlsUrl = `https://v.redd.it/${videoId}/HLSPlaylist.m3u8`;
  const thumbnail = normalizeUrlCandidate(readHtmlMetaContent(html, 'og:image'), sourceBase);
  const redditVideo = {
    fallback_url: hlsUrl,
    hls_url: hlsUrl,
    is_gif: false,
  };

  data.is_self = false;
  data.is_video = true;
  data.post_hint = 'hosted:video';
  data.url = videoPageUrl;
  data.url_overridden_by_dest = videoPageUrl;
  data.domain = 'v.redd.it';
  data.media = { reddit_video: redditVideo };
  data.secure_media = { reddit_video: redditVideo };

  if (thumbnail) {
    data.thumbnail = thumbnail;
    data.preview = {
      enabled: true,
      images: [{ source: { url: thumbnail }, resolutions: [] }],
    };
  }
}

function parseHtmlCommentsResponse(html: string, upstreamPath: string, sourceBase: string): unknown | null {
  const postId = inferCommentThreadId(upstreamPath);
  const postChild = parseHtmlPostLinks(html, upstreamPath, sourceBase).find((child) => child.data.id === postId);

  if (!postChild) {
    return null;
  }

  const comments = parseHtmlCommentChildren(html);
  const commentCount = readHtmlCommentCount(html);
  applyRedditHtmlVideoMedia(postChild.data, html, sourceBase);
  postChild.data.num_comments = Math.max(commentCount, comments.length, Number(postChild.data.num_comments) || 0);

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

function getRequestedAfter(upstreamPath: string): string {
  const [, rawQuery = ''] = upstreamPath.split('?');
  const params = new URLSearchParams(rawQuery);

  return (params.get('after') ?? '').trim();
}

function getChildName(child: { data?: { name?: unknown } }): string {
  const name = child.data?.name;
  return typeof name === 'string' ? name : '';
}

function getChildId(child: { data?: { id?: unknown } }): string {
  const id = child.data?.id;
  return typeof id === 'string' ? id : '';
}

function getPaginatedStartIndex(
  children: Array<{ data?: { id?: unknown; name?: unknown } }>,
  upstreamPath: string,
  isNativePagination = false,
): number | null {
  const after = getRequestedAfter(upstreamPath);

  if (!after) {
    return 0;
  }

  const normalizedAfter = after.toLowerCase();
  const normalizedAfterId = normalizedAfter.replace(/^t3_/, '');
  const afterIndex = children.findIndex((child) => {
    const name = getChildName(child).toLowerCase();
    const id = getChildId(child).toLowerCase();

    return name === normalizedAfter || id === normalizedAfterId;
  });

  if (afterIndex >= 0) {
    return afterIndex + 1;
  }

  return isNativePagination ? 0 : null;
}

function getSyntheticRssAfter(
  children: Array<{ data?: { id?: unknown; name?: unknown } }>,
  upstreamPath: string,
  pageSize: number,
  startIndex: number,
): string | null {
  if (isCommentThreadPath(upstreamPath) || children.length <= startIndex + pageSize) {
    return null;
  }

  const name = children[startIndex + pageSize - 1]?.data?.name;
  return typeof name === 'string' && name ? name : null;
}

function getHtmlListingNextAfter(html: string, upstreamPath: string, sourceBase: string): string | null {
  const requestedAfter = getRequestedAfter(upstreamPath).toLowerCase();

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = readHtmlAttribute(match[0], 'href');
    const url = normalizeUrlCandidate(href, sourceBase);

    if (!url) {
      continue;
    }

    try {
      const parsed = new URL(url);
      const after = (parsed.searchParams.get('after') ?? '').trim();

      if (!after || after.toLowerCase() === requestedAfter) {
        continue;
      }

      return after;
    } catch {
      // Ignore malformed links and keep scanning pagination anchors.
    }
  }

  return null;
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
  const allChildren = items.map((item, index) => parseRssPostChild(item[2], upstreamPath, sourceBase, index));
  const startIndex = getPaginatedStartIndex(allChildren, upstreamPath, false);

  if (startIndex === null) {
    return null;
  }

  const children = allChildren.slice(startIndex, startIndex + pageSize);

  return {
    kind: 'Listing',
    data: {
      after: getSyntheticRssAfter(allChildren, upstreamPath, pageSize, startIndex),
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

function getStringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isRenderableObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function isUsableThumbnail(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return /^https?:\/\//i.test(normalized) && !['default', 'self', 'nsfw', 'spoiler', 'image'].includes(normalized);
}

function isCommentPermalinkUrl(url: string, permalink: string, id: string): boolean {
  const normalizedId = id.toLowerCase();
  const normalizedPermalink = permalink.replace(/\/+$/g, '').toLowerCase();
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })().replace(/\/+$/g, '').toLowerCase();

  return (
    Boolean(normalizedId && pathname.includes(`/comments/${normalizedId}`)) ||
    Boolean(normalizedPermalink && pathname.startsWith(normalizedPermalink))
  );
}

function hasRenderablePostData(data: Record<string, unknown>): boolean {
  if (getStringField(data, 'selftext')) {
    return true;
  }

  if (isRenderableObject(data.media) || isRenderableObject(data.secure_media) || isRenderableObject(data.preview)) {
    return true;
  }

  if (isUsableThumbnail(data.thumbnail)) {
    return true;
  }

  const postHint = getStringField(data, 'post_hint');

  if (postHint && postHint !== 'link') {
    return true;
  }

  const outboundUrl = getStringField(data, 'url_overridden_by_dest') || getStringField(data, 'url');

  if (!outboundUrl) {
    return false;
  }

  return !isRedditNavigationUrl(outboundUrl) && !isCommentPermalinkUrl(
    outboundUrl,
    getStringField(data, 'permalink'),
    getStringField(data, 'id'),
  );
}

function hasRenderablePostPayload(payload: unknown, upstreamPath: string): boolean {
  if (isCommentThreadPath(upstreamPath)) {
    if (!Array.isArray(payload)) {
      return false;
    }

    const postHasContent = listingChildren(payload[0]).some((child) =>
      child.data ? hasRenderablePostData(child.data) : false,
    );
    const commentsHaveContent = listingChildren(payload[1]).some((child) => getStringField(child.data ?? {}, 'body'));

    return postHasContent || commentsHaveContent;
  }

  return listingChildren(payload).some((child) => child.data ? hasRenderablePostData(child.data) : false);
}

function hasPreviewMedia(data: Record<string, unknown>): boolean {
  const preview = data.preview as { images?: unknown[] } | undefined;
  return Array.isArray(preview?.images) && preview.images.length > 0;
}

function hasGalleryMedia(data: Record<string, unknown>): boolean {
  const galleryData = data.gallery_data as { items?: unknown[] } | undefined;
  return Boolean(data.is_gallery && Array.isArray(galleryData?.items) && isRenderableObject(data.media_metadata));
}

function hasPlayableMediaFields(data: Record<string, unknown>): boolean {
  if (hasGalleryMedia(data) || isRenderableObject(data.media) || isRenderableObject(data.secure_media)) {
    return true;
  }

  const outboundUrl = getStringField(data, 'url_overridden_by_dest') || getStringField(data, 'url');
  return Boolean(outboundUrl && isLikelyImageUrl(outboundUrl));
}

function hasUsableMediaFields(data: Record<string, unknown>): boolean {
  if (
    hasGalleryMedia(data) ||
    hasPreviewMedia(data) ||
    isRenderableObject(data.media) ||
    isRenderableObject(data.secure_media) ||
    isUsableThumbnail(data.thumbnail)
  ) {
    return true;
  }

  const outboundUrl = getStringField(data, 'url_overridden_by_dest') || getStringField(data, 'url');
  return Boolean(outboundUrl && isLikelyImageUrl(outboundUrl));
}

function getCommentThreadPostData(payload: unknown): Record<string, unknown> | null {
  if (!Array.isArray(payload)) {
    return null;
  }

  return listingChildren(payload[0])[0]?.data ?? null;
}

function getRedlibDetailPath(data: Record<string, unknown>): string {
  for (const value of [getStringField(data, 'permalink'), getStringField(data, 'url')]) {
    if (!value) {
      continue;
    }

    const path = toPathname(normalizeUrlCandidate(value, 'https://www.reddit.com'));

    if (/\/comments\//i.test(path)) {
      return path;
    }
  }

  const id = getStringField(data, 'id');
  const subreddit = normalizeCommunityName(getStringField(data, 'subreddit'));

  return id && subreddit && !subreddit.includes('/') ? `/r/${subreddit}/comments/${id}/` : '';
}

const REDLIB_MEDIA_FIELDS = [
  'preview',
  'thumbnail',
  'gallery_data',
  'media_metadata',
  'media',
  'secure_media',
  'post_hint',
  'is_gallery',
  'is_video',
  'url',
  'url_overridden_by_dest',
  'domain',
  'is_self',
] as const;

function mergeRedlibMediaFields(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (!hasUsableMediaFields(source)) {
    return;
  }

  for (const key of REDLIB_MEDIA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    }),
  );
}

async function fetchRedlibDetailMediaData(
  base: string,
  detailPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
  mediaPref: MediaPref,
): Promise<Record<string, unknown> | null> {
  const response = await fetchWithTimeout(
    `${base}${detailPath}`,
    {
      headers: getPublicInstanceRequestHeaders(base, 'html', env, options),
    },
    REDLIB_DETAIL_ENRICH_TIMEOUT_MS,
  );

  if (!response.ok) {
    return null;
  }

  const body = await response.text();

  if (isInstanceChallenge(body) || !looksRedlibHtml(body)) {
    return null;
  }

  const detailPayload = parseRedlibCommentsResponse(body, detailPath, base, mediaPref);
  const detailData = listingChildren(Array.isArray(detailPayload) ? detailPayload[0] : null)[0]?.data;

  return detailData && hasUsableMediaFields(detailData) ? detailData : null;
}

async function enrichCommentThreadMediaFromOldReddit(
  payload: unknown,
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Promise<unknown> {
  const postData = getCommentThreadPostData(payload);

  if (!postData || hasPlayableMediaFields(postData)) {
    return payload;
  }

  const detailPath = buildPublicHtmlPath(upstreamPath);

  if (!detailPath) {
    return payload;
  }

  try {
    const response = await fetchWithTimeout(
      `https://old.reddit.com${detailPath}`,
      {
        headers: {
          Accept: getPublicInstanceAccept('html'),
          'User-Agent': getProxyUserAgent(env, options),
        },
      },
      REDLIB_DETAIL_ENRICH_TIMEOUT_MS,
    );

    if (!response.ok) {
      return payload;
    }

    const body = await response.text();

    if (isInstanceChallenge(body)) {
      return payload;
    }

    applyRedditHtmlVideoMedia(postData, body, 'https://old.reddit.com');
  } catch {
    // Keep the original fallback payload when old Reddit media enrichment fails.
  }

  return payload;
}

async function enrichRedlibListingMedia(
  payload: unknown,
  base: string,
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
  mediaPref: MediaPref,
): Promise<unknown> {
  if (isCommentThreadPath(upstreamPath) || isPublicDiscoveryPath(upstreamPath)) {
    return payload;
  }

  const targets = listingChildren(payload)
    .filter((child): child is { kind?: string; data: Record<string, unknown> } =>
      Boolean(child.data && needsRedlibDetailMediaEnrichment(child.data)),
    )
    .map((child) => ({ child, detailPath: getRedlibDetailPath(child.data) }))
    .filter((item) => item.detailPath);

  if (targets.length === 0) {
    return payload;
  }

  await runWithConcurrency(targets, REDLIB_DETAIL_ENRICH_CONCURRENCY, async ({ child, detailPath }) => {
    try {
      const detailData = await fetchRedlibDetailMediaData(base, detailPath, env, options, mediaPref);

      if (detailData) {
        mergeRedlibMediaFields(child.data, detailData);
      }
    } catch {
      // Detail enrichment is opportunistic; keep the original listing child on failure.
    }
  });

  return payload;
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

function getPublicInstanceRequestHeaders(
  base: string,
  method: PublicInstanceRequest['method'],
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: getPublicInstanceAccept(method),
    'User-Agent': getProxyUserAgent(env, options),
  };

  if (method === 'html' && !isTedditInstance(base) && !isTrodditInstance(base)) {
    headers.Cookie = 'use_hls=on';
  }

  return headers;
}

function needsRedlibDetailMediaEnrichment(data: Record<string, unknown>): boolean {
  if (hasPlayableMediaFields(data)) {
    return false;
  }

  return Boolean(
    data.is_video ||
      getStringField(data, 'post_hint') === 'hosted:video' ||
      isUsableThumbnail(data.thumbnail),
  );
}

function getPublicInstanceTimeoutMs(request: PublicInstanceRequest, upstreamPath: string): number {
  if (!isCommentThreadPath(upstreamPath)) {
    return 3000;
  }

  return request.method === 'html' ? 7000 : 5000;
}

function parsePublicInstancePayload(
  body: string,
  contentType: string | null,
  request: PublicInstanceRequest,
  base: string,
  upstreamPath: string,
  mediaPref: MediaPref,
): unknown | null {
  if (isInstanceChallenge(body)) {
    return null;
  }

  const looksJson = request.method === 'json' || isJsonContentType(contentType) || /^[\s\r\n]*[\[{]/.test(body);
  const looksRss =
    request.method === 'rss' ||
    (contentType ?? '').toLowerCase().includes('rss') ||
    (contentType ?? '').toLowerCase().includes('atom') ||
    /<rss\b|<feed\b|<item\b/i.test(body);
  const looksHtml = request.method === 'html' || (contentType ?? '').toLowerCase().includes('html') || /<html\b|<a\s/i.test(body);
  const looksRedlib = looksHtml && looksRedlibHtml(body);

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
    if (looksRedlib) {
      const redlibPayload = parseRedlibCommentsResponse(body, upstreamPath, base, mediaPref);

      if (hasRenderablePostPayload(redlibPayload, upstreamPath)) {
        return redlibPayload;
      }
    }

    if (looksRss) {
      return parseRssCommentsResponse(body, upstreamPath, base);
    }

    if (looksHtml) {
      const htmlPayload = parseHtmlCommentsResponse(body, upstreamPath, base);
      return hasRenderablePostPayload(htmlPayload, upstreamPath) ? htmlPayload : null;
    }

    return null;
  }

  if (looksRedlib) {
    const redlibPayload = normalizePublicInstancePayload(parseRedlibListing(body, upstreamPath, base, mediaPref), upstreamPath);
    return redlibPayload;
  }

  if (looksRss) {
    return normalizePublicInstancePayload(parseRssListing(body, upstreamPath, base), upstreamPath);
  }

  if (looksHtml) {
    const htmlPayload = normalizePublicInstancePayload(parseHtmlListing(body, upstreamPath, base), upstreamPath);
    return hasRenderablePostPayload(htmlPayload, upstreamPath) ? htmlPayload : null;
  }

  return null;
}

async function fetchFromPublicInstance(
  base: string,
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
  mediaPref: MediaPref,
): Promise<Response | null> {
  // Eddrit now sits behind an Anubis proof-of-work wall; requests only return a challenge
  // page, so skip it entirely to avoid wasted latency.
  if (isEddritInstance(base)) {
    return null;
  }

  const requests = buildPublicInstanceRequests(base, upstreamPath);

  for (const request of requests) {
    try {
      const response = await fetchWithTimeout(
        `${base}${request.path}`,
        {
          headers: getPublicInstanceRequestHeaders(base, request.method, env, options),
        },
        getPublicInstanceTimeoutMs(request, upstreamPath),
      );

      if (!response.ok) {
        continue;
      }

      const body = await response.text();
      let normalizedPayload = parsePublicInstancePayload(
        body,
        response.headers.get('content-type'),
        request,
        base,
        upstreamPath,
        mediaPref,
      );

      if (isCommentThreadPath(upstreamPath)) {
        normalizedPayload = await enrichCommentThreadMediaFromOldReddit(normalizedPayload, upstreamPath, env, options);
      }

      if (
        request.method === 'html' &&
        looksRedlibHtml(body) &&
        !isCommentThreadPath(upstreamPath) &&
        !isPublicDiscoveryPath(upstreamPath)
      ) {
        normalizedPayload = await enrichRedlibListingMedia(normalizedPayload, base, upstreamPath, env, options, mediaPref);
      }

      if (!isCompatibleRedditPayload(normalizedPayload, upstreamPath)) {
        continue;
      }

      const finalPayload = applyMediaSourcePreference(normalizedPayload, base, mediaPref);

      return new Response(JSON.stringify(finalPayload), {
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

function raceUsablePublicInstance(
  bases: string[],
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
  mediaPref: MediaPref,
): Promise<{ base: string; response: Response } | null> {
  return new Promise((resolve) => {
    if (bases.length === 0) {
      resolve(null);
      return;
    }

    let remaining = bases.length;
    let settled = false;

    const finish = (value: { base: string; response: Response } | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    for (const base of bases) {
      fetchFromPublicInstance(base, upstreamPath, env, options, mediaPref)
        .then((response) => {
          if (response) {
            markPublicInstanceSuccess(base);
            finish({ base, response });
          } else {
            markPublicInstanceFailure(base);
          }
        })
        .catch(() => {
          markPublicInstanceFailure(base);
        })
        .finally(() => {
          remaining -= 1;

          if (remaining === 0) {
            finish(null);
          }
        });
    }
  });
}

async function fetchViaPublicInstances(
  upstreamPath: string,
  env: RedditProxyEnv | undefined,
  options: RedditProxyOptions,
  mediaPref: MediaPref,
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

    const winner = await raceUsablePublicInstance(batch, upstreamPath, env, options, mediaPref);

    if (winner?.response) {
      winner.response.headers.set('X-RedAlt-Instance-Attempts', formatInstanceHeader(attempted));

      if (skipped.length > 0) {
        winner.response.headers.set('X-RedAlt-Skipped-Instances', formatInstanceHeader(skipped));
      }

      return winner.response;
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
