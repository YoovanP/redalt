import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const USER_AGENT = process.env.REDDIT_PROXY_USER_AGENT ?? 'RedAlt/1.0 (Render proxy)';
const MIRROR_ENABLED = (process.env.ENABLE_MIRROR_FALLBACK ?? 'true').toLowerCase() !== 'false';

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

let publicInstanceCache = null;
const publicInstanceHealth = new Map();

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

// The frontend appends `redalt_media=reddit` to request which media host to serve from.
// It must be read once and stripped before any upstream/fallback URL is built so it never
// leaks to Reddit/Redlib or fragments caches.
function extractMediaPref(upstreamPath) {
  const [path, rawQuery = ''] = upstreamPath.split('?');

  if (!rawQuery.includes('redalt_media')) {
    return { pref: 'instance', cleanPath: upstreamPath };
  }

  const params = new URLSearchParams(rawQuery);
  const pref = params.get('redalt_media') === 'reddit' ? 'reddit' : 'instance';
  params.delete('redalt_media');
  const query = params.toString();

  return { pref, cleanPath: query ? `${path}?${query}` : path };
}

// Maps a Redlib-served media path back to the original Reddit CDN, preserving the signed
// query. Only same-instance still-image paths are rewritten; video/stream paths (/vid, /hls)
// and anything not hosted on the serving instance are left untouched.
function rewriteRedlibImageUrl(url, instanceHost) {
  let parsed;

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

// When the user prefers the Reddit CDN, rewrite still-image fields in the reconstructed
// payload. Video (reddit_video) and embeds (oembed) are intentionally left on the instance.
function applyMediaSourcePreference(payload, base, pref) {
  if (pref !== 'reddit' || !payload) {
    return payload;
  }

  let instanceHost;

  try {
    instanceHost = new URL(base).hostname.toLowerCase();
  } catch {
    return payload;
  }

  const rewrite = (value) =>
    typeof value === 'string' && value ? rewriteRedlibImageUrl(value, instanceHost) : value;

  const rewriteData = (data) => {
    if (!data) {
      return;
    }

    if (typeof data.url === 'string') {
      data.url = rewrite(data.url);
    }

    if (typeof data.url_overridden_by_dest === 'string') {
      data.url_overridden_by_dest = rewrite(data.url_overridden_by_dest);
    }

    if (typeof data.thumbnail === 'string') {
      data.thumbnail = rewrite(data.thumbnail);
    }

    if (data.preview?.images) {
      for (const image of data.preview.images) {
        if (image?.source && typeof image.source.url === 'string') {
          image.source.url = rewrite(image.source.url);
        }
      }
    }

    if (data.media_metadata) {
      for (const meta of Object.values(data.media_metadata)) {
        if (meta?.s) {
          if (typeof meta.s.u === 'string') {
            meta.s.u = rewrite(meta.s.u);
          }
          if (typeof meta.s.url === 'string') {
            meta.s.url = rewrite(meta.s.url);
          }
        }
      }
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

function getPublicInstanceHealthKey(base) {
  return normalizeInstanceBase(base).toLowerCase();
}

function isPublicInstanceCoolingDown(base, now = Date.now()) {
  const health = publicInstanceHealth.get(getPublicInstanceHealthKey(base));
  return Boolean(health && health.retryAfter > now);
}

function markPublicInstanceSuccess(base) {
  publicInstanceHealth.delete(getPublicInstanceHealthKey(base));
}

function markPublicInstanceFailure(base, now = Date.now()) {
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

function getPublicInstanceFailureCount(base) {
  return publicInstanceHealth.get(getPublicInstanceHealthKey(base))?.failureCount ?? 0;
}

// Lower rank is tried first. Redlib/Libreddit serve full-fidelity HTML (media, comments, real
// scores), so they lead; teddit is JSON-only and frequently down; troddit is heavy; eddrit is
// skipped entirely in fetchFromPublicInstance and only ranks last as a defensive default.
function rankPublicInstance(base) {
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

function getPublicInstanceCandidates(urls) {
  const skipped = [];
  const candidates = [];
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

function formatInstanceHeader(values) {
  const visible = values.slice(0, 12);
  const suffix = values.length > visible.length ? `, +${values.length - visible.length} more` : '';
  return `${visible.join(', ')}${suffix}`;
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

function isTrodditInstance(base) {
  try {
    return new URL(base).hostname.toLowerCase().includes('troddit');
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

function buildRssPath(upstreamPath) {
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
  const withQuery = (rssPath) => `${rssPath}${query ? `?${query}` : ''}`;

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

function buildPublicHtmlPath(upstreamPath) {
  const [rawPath, rawQuery = ''] = upstreamPath.split('?');
  const path = rawPath.replace(/\.json$/i, '');
  const params = new URLSearchParams(rawQuery);
  params.delete('raw_json');
  const query = params.toString();
  const withQuery = (htmlPath) => `${htmlPath}${query ? `?${query}` : ''}`;
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

function getPublicSearchParams(upstreamPath) {
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

function getDiscoverySearchType(upstreamPath) {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (normalizedPath === '/subreddits/search.json' || normalizedPath === '/api/search_reddit_names.json') {
    return 'sr';
  }

  if (normalizedPath === '/users/search.json') {
    return 'user';
  }

  return 'link';
}

function isPublicDiscoveryPath(upstreamPath) {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  return (
    normalizedPath === '/api/search_reddit_names.json' ||
    normalizedPath === '/subreddits/search.json' ||
    normalizedPath === '/users/search.json'
  );
}

function buildPublicDiscoveryPath(base, upstreamPath) {
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

function addPublicInstanceRequest(requests, seen, method, path) {
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

function buildPublicInstanceRequests(base, upstreamPath) {
  const requests = [];
  const seen = new Set();

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

function isCommentThreadPath(upstreamPath) {
  const normalizedPath = (upstreamPath.split('?')[0] || '/').replace(/\.json$/i, '');
  return /^\/r\/[^/]+\/comments\/[^/]+(?:\/.*)?$/i.test(normalizedPath);
}

function inferCommentThreadId(upstreamPath) {
  const normalizedPath = (upstreamPath.split('?')[0] || '/').replace(/\.json$/i, '');
  const match = normalizedPath.match(/^\/r\/[^/]+\/comments\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function getRequestedListingLimit(upstreamPath) {
  const [, rawQuery = ''] = upstreamPath.split('?');
  const params = new URLSearchParams(rawQuery);
  const parsed = Number(params.get('limit') ?? 25);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 25;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), 100);
}

function getSearchQuery(upstreamPath) {
  const [, rawQuery = ''] = upstreamPath.split('?');
  const params = new URLSearchParams(rawQuery);

  return (params.get('q') ?? params.get('query') ?? '').trim().toLowerCase();
}

function normalizeCommunityName(value) {
  return value.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
}

function normalizeUserName(value) {
  return value.trim().replace(/^\/?(?:u|user)\//i, '').replace(/^\/+|\/+$/g, '');
}

function matchesSearchQuery(value, query) {
  return !query || value.toLowerCase().includes(query);
}

function listingChildren(payload) {
  if (payload?.kind === 'Listing' && Array.isArray(payload.data?.children)) {
    return payload.data.children;
  }

  return [];
}

function collectSubredditNamesFromListing(payload, upstreamPath) {
  const query = getSearchQuery(upstreamPath);
  const names = [];
  const seen = new Set();

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

function collectUserNamesFromListing(payload, upstreamPath) {
  const query = getSearchQuery(upstreamPath);
  const names = [];
  const seen = new Set();

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

function buildSubredditSearchPayload(names) {
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

function buildUserSearchPayload(names) {
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

function normalizePublicInstancePayload(payload, upstreamPath) {
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

  if (normalizedPath.startsWith('/user/') && Array.isArray(payload?.overview?.data?.children)) {
    return payload.overview;
  }

  return payload;
}

function decodeXmlEntities(value) {
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

function stripHtml(value) {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function stripHtmlLines(value) {
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

function readHtmlAttributes(html, attribute) {
  return [...html.matchAll(new RegExp(`\\s${attribute}=["']([^"']+)["']`, 'gi'))].map((match) =>
    decodeXmlEntities(match[1] ?? '').trim(),
  );
}

function readHtmlAttribute(openTag, attribute) {
  const quoted = openTag.match(new RegExp(`\\s${attribute}=(["'])([\\s\\S]*?)\\1`, 'i'));

  if (quoted) {
    return decodeXmlEntities(quoted[2] ?? '').trim();
  }

  const unquoted = openTag.match(new RegExp(`\\s${attribute}=([^\\s>]+)`, 'i'));
  return decodeXmlEntities(unquoted?.[1] ?? '').trim();
}

function hasHtmlClass(openTag, className) {
  return readHtmlAttribute(openTag, 'class')
    .split(/\s+/)
    .some((value) => value === className);
}

function findHtmlTagBlockAt(html, tagName, openTagStart) {
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

function findFirstHtmlTagBlock(html, tagName, className) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');

  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    if (!hasHtmlClass(match[0], className)) {
      continue;
    }

    return findHtmlTagBlockAt(html, tagName, match.index);
  }

  return null;
}

function normalizeUrlCandidate(value, baseUrl) {
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

function getUrlHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getUrlPathname(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isLikelyImageUrl(url) {
  const pathname = getUrlPathname(url);
  return /\.(?:png|jpe?g|webp|gif|avif)$/i.test(pathname);
}

function isLikelyVideoUrl(url) {
  const pathname = getUrlPathname(url);
  return /\.(?:mp4|webm|mov|m4v|m3u8)$/i.test(pathname) || pathname.endsWith('.gifv');
}

function isRedditNavigationUrl(url) {
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

function firstDistinctUrl(values, baseUrl) {
  const urls = [];
  const seen = new Set();

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

function buildYouTubeEmbed(url) {
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

function buildVimeoEmbed(url) {
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

function buildRedgifsEmbed(url) {
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

function buildKnownEmbed(url) {
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

function cleanRssSelfText(content, title, mediaUrl) {
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

function stripRssSubmissionBoilerplate(value) {
  return value
    .replace(
      /\s*submitted\s+by\s+\/?u\/[A-Za-z0-9_-]+(?:\s+to\s+\/?r\/[A-Za-z0-9_]+)?(?:\s+\[[^\]]+\])*\s*$/i,
      '',
    )
    .trim();
}

function collectNamesFromHtml(html, pattern, query) {
  const names = [];
  const seen = new Set();

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

function titleFromPermalink(permalink) {
  const slug = permalink.split('/').filter(Boolean).at(-1) ?? '';
  return decodeURIComponent(slug).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled post';
}

function parseHtmlPostLinks(html, upstreamPath, sourceBase) {
  const children = [];
  const seen = new Set();
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

function parseHtmlListing(html, upstreamPath, sourceBase) {
  const pageSize = Math.min(getRequestedListingLimit(upstreamPath), 25);
  const allChildren = parseHtmlPostLinks(html, upstreamPath, sourceBase);
  const startIndex = getPaginatedStartIndex(allChildren, upstreamPath);

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

function isEddritInstance(base) {
  try {
    return new URL(base).hostname.toLowerCase().includes('eddrit');
  } catch {
    return false;
  }
}

// Eddrit and some Redlib mirrors sit behind the Anubis proof-of-work wall, which answers
// with an HTTP 200 HTML challenge page. Detect it so it is treated as a failure, never parsed.
function isAnubisChallenge(body) {
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
function isInstanceChallenge(body) {
  return (
    isAnubisChallenge(body) ||
    /\bgo-away\b/i.test(body) ||
    /checking (?:you are|if you are|if the site connection is secure)/i.test(body) ||
    /just a moment\b/i.test(body) ||
    /cf-browser-verification|challenge-platform|__cf_chl/i.test(body)
  );
}

function looksRedlibHtml(body) {
  return (
    /\bclass=["'][^"']*\bpost_header\b/i.test(body) ||
    /\bclass=["'][^"']*\bpost_media_content\b/i.test(body) ||
    /\bid=["']comment_count["']/i.test(body) ||
    /<div\b[^>]*\bclass=["'][^"']*\bpost\b[^"']*["'][^>]*\bid=/i.test(body)
  );
}

function toPathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function urlWidthParam(url) {
  try {
    const width = Number(new URL(url).searchParams.get('width'));
    return Number.isFinite(width) && width > 0 ? width : undefined;
  } catch {
    return undefined;
  }
}

function mimeFromUrl(url) {
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

function findRedlibPostBlocks(html) {
  const blocks = [];
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

function redlibVideoMedia(innerHtml, sourceBase) {
  const videoBlock = findFirstHtmlTagBlock(innerHtml, 'video', 'post_media_video');

  if (!videoBlock) {
    return null;
  }

  let mp4 = '';
  let hls = '';

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

  // Redlib serves a muxed CMAF MP4 at /vid/<id>/CMAF. Derive it from the HLS id when the
  // <source type="video/mp4"> isn't present, so fallback_url is always a cross-browser MP4.
  if (!mp4 && hls) {
    const idMatch = hls.match(/\/hls\/([^/?#]+)\//i);

    if (idMatch) {
      try {
        mp4 = `${new URL(hls).origin}/vid/${idMatch[1]}/CMAF`;
      } catch {
        // Keep HLS as the only source if the URL cannot be parsed.
      }
    }
  }

  if (!mp4 && !hls) {
    return null;
  }

  const width = Number(readHtmlAttribute(videoBlock.openTag, 'width')) || undefined;
  const height = Number(readHtmlAttribute(videoBlock.openTag, 'height')) || undefined;

  return { fallbackUrl: mp4 || hls, hlsUrl: hls || undefined, width, height };
}

function redlibImageSource(innerHtml, sourceBase) {
  const anchorBlock = findFirstHtmlTagBlock(innerHtml, 'a', 'post_media_image');
  let href = anchorBlock ? readHtmlAttribute(anchorBlock.openTag, 'href') : '';

  if (!href) {
    const contentBlock = findFirstHtmlTagBlock(innerHtml, 'div', 'post_media_content');
    const imgTag = contentBlock ? contentBlock.innerHtml.match(/<img\b[^>]*>/i)?.[0] ?? '' : '';
    href = imgTag ? readHtmlAttribute(imgTag, 'src') : '';
  }

  const url = normalizeUrlCandidate(href, sourceBase);

  if (!url) {
    return null;
  }

  if (!/^\/(?:preview|img)\//i.test(toPathname(url)) && !isLikelyImageUrl(url)) {
    return null;
  }

  return { url, width: urlWidthParam(url) };
}

function redlibGalleryItems(innerHtml, sourceBase) {
  const galleryBlock = findFirstHtmlTagBlock(innerHtml, 'div', 'gallery');

  if (!galleryBlock) {
    return [];
  }

  const items = [];
  const seen = new Set();

  for (const match of galleryBlock.innerHtml.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)) {
    const figureHtml = match[1] ?? '';
    const anchorTag = figureHtml.match(/<a\b[^>]*>/i)?.[0] ?? '';
    let href = anchorTag ? readHtmlAttribute(anchorTag, 'href') : '';

    if (!href) {
      const imgTag = figureHtml.match(/<img\b[^>]*>/i)?.[0] ?? '';
      href = imgTag ? readHtmlAttribute(imgTag, 'src') : '';
    }

    const url = normalizeUrlCandidate(href, sourceBase);

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

function redlibThumbnail(innerHtml, sourceBase) {
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

function redlibOutboundCandidates(innerHtml, sourceBase) {
  const candidates = [];
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

function redlibKnownEmbed(innerHtml, sourceBase) {
  for (const url of redlibOutboundCandidates(innerHtml, sourceBase)) {
    const embed = buildKnownEmbed(url);

    if (embed) {
      return { provider: embed.provider, embedUrl: embed.embedUrl, sourceUrl: url };
    }
  }

  return null;
}

function redlibOutboundUrl(innerHtml, sourceBase, instanceHost) {
  for (const url of redlibOutboundCandidates(innerHtml, sourceBase)) {
    const host = getUrlHostname(url);

    if (!host || host === instanceHost || isRedditNavigationUrl(url)) {
      continue;
    }

    return url;
  }

  return '';
}

function redlibListingCommentCount(innerHtml) {
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

function findRedlibTitleLink(titleHtml, sourceBase) {
  let fallback = null;

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
function parseRedlibPostBlock(openTag, innerHtml, upstreamPath, sourceBase, fallbackId = '') {
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

  const data = {
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

  const embed = redlibKnownEmbed(innerHtml, sourceBase);
  const video = redlibVideoMedia(innerHtml, sourceBase);
  const gallery = redlibGalleryItems(innerHtml, sourceBase);
  const image = redlibImageSource(innerHtml, sourceBase);

  if (embed) {
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
  } else if (video) {
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
    const mediaMetadata = {};

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
    } else if (thumbnail) {
      // Redlib collapsed a media post to a thumbnail in the listing; show the thumbnail and
      // let the detail page load full media on click.
      data.post_hint = 'image';
      data.url = `https://www.reddit.com${permalink}`;
      data.preview = {
        enabled: true,
        images: [{ source: { url: thumbnail }, resolutions: [] }],
      };
    } else {
      data.is_self = true;
      data.url = `https://www.reddit.com${permalink}`;
      data.domain = 'reddit.com';
    }
  }

  return { kind: 't3', data };
}

function parseRedlibListing(html, upstreamPath, sourceBase) {
  const pageSize = Math.min(getRequestedListingLimit(upstreamPath), 25);
  const allChildren = findRedlibPostBlocks(html)
    .map(({ openTag, block }) => parseRedlibPostBlock(openTag, block.innerHtml, upstreamPath, sourceBase))
    .filter((child) => child !== null);

  if (allChildren.length === 0) {
    return null;
  }

  const startIndex = getPaginatedStartIndex(allChildren, upstreamPath);

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

function parseRedlibCommentsResponse(html, upstreamPath, sourceBase) {
  const postId = inferCommentThreadId(upstreamPath);
  const blocks = findRedlibPostBlocks(html);

  if (blocks.length === 0) {
    return null;
  }

  const chosen =
    blocks.find(({ openTag }) => readHtmlAttribute(openTag, 'id') === postId) ??
    blocks.find(({ openTag }) => hasHtmlClass(openTag, 'highlighted')) ??
    blocks[0];
  const postChild = parseRedlibPostBlock(chosen.openTag, chosen.block.innerHtml, upstreamPath, sourceBase, postId);

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

function readHtmlCommentAuthor(commentHtml) {
  const authorMatch = commentHtml.match(/<a\b[^>]*\bclass=["'][^"']*\bcomment_author\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  return normalizeUserName(stripHtml(authorMatch?.[1] ?? '')) || '[unknown]';
}

function readHtmlCommentBody(commentHtml) {
  const bodyBlock = findFirstHtmlTagBlock(commentHtml, 'div', 'comment_body');
  return bodyBlock ? stripHtmlLines(bodyBlock.innerHtml).join('\n\n') : '';
}

function parseHtmlCommentChildren(html) {
  const comments = [];
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

function readHtmlCommentCount(html) {
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

function parseHtmlCommentsResponse(html, upstreamPath, sourceBase) {
  const postId = inferCommentThreadId(upstreamPath);
  const postChild = parseHtmlPostLinks(html, upstreamPath, sourceBase).find((child) => child.data.id === postId);

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

function parseHtmlDiscoveryListing(html, upstreamPath) {
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

function parseRssDiscoveryListing(xml, upstreamPath) {
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

function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function readXmlAttribute(xml, tag, attribute) {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function readXmlAuthor(xml) {
  const authorXml = readXmlTag(xml, 'author');
  return stripHtml(readXmlTag(authorXml, 'name') || authorXml);
}

function inferSubredditFromPath(upstreamPath) {
  const match = upstreamPath.match(/^\/r\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : 'popular';
}

function inferUserFromPath(upstreamPath) {
  const match = upstreamPath.match(/^\/user\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function inferSubredditFromPermalink(permalink, fallback) {
  const match = permalink.match(/^\/r\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : fallback;
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

function getRequestedAfter(upstreamPath) {
  const [, rawQuery = ''] = upstreamPath.split('?');
  const params = new URLSearchParams(rawQuery);

  return (params.get('after') ?? '').trim();
}

function getChildName(child) {
  const name = child.data?.name;
  return typeof name === 'string' ? name : '';
}

function getChildId(child) {
  const id = child.data?.id;
  return typeof id === 'string' ? id : '';
}

function getPaginatedStartIndex(children, upstreamPath) {
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

  return afterIndex >= 0 ? afterIndex + 1 : null;
}

function getSyntheticRssAfter(children, upstreamPath, pageSize, startIndex) {
  if (isCommentThreadPath(upstreamPath) || children.length <= startIndex + pageSize) {
    return null;
  }

  const name = children[startIndex + pageSize - 1]?.data?.name;
  return typeof name === 'string' && name ? name : null;
}

function parseRssPostChild(itemXml, upstreamPath, sourceBase, fallbackIndex) {
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

function parseRssCommentId(link, postId) {
  const escapedPostId = postId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  try {
    const path = new URL(link).pathname;
    return path.match(new RegExp(`/comments/${escapedPostId}/[^/]+/([^/?#]+)`, 'i'))?.[1] ?? null;
  } catch {
    return link.match(new RegExp(`/comments/${escapedPostId}/[^/]+/([^/?#]+)`, 'i'))?.[1] ?? null;
  }
}

function readRssCommentAuthor(itemXml) {
  const author = normalizeUserName(readXmlAuthor(itemXml));

  if (author) {
    return author;
  }

  const title = stripHtml(readXmlTag(itemXml, 'title'));
  return title.match(/^\/?u\/([A-Za-z0-9_-]+)/i)?.[1] ?? '[unknown]';
}

function readRssCommentBody(itemXml) {
  const content =
    readXmlTag(itemXml, 'content:encoded') ||
    readXmlTag(itemXml, 'content') ||
    readXmlTag(itemXml, 'summary') ||
    readXmlTag(itemXml, 'description');

  return stripHtmlLines(content).join('\n\n');
}

function parseRssCommentsResponse(xml, upstreamPath, sourceBase = 'https://www.reddit.com') {
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
    .filter((item) => item !== null);

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

function parseRssListing(xml, upstreamPath, sourceBase = 'https://www.reddit.com') {
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];

  if (items.length === 0) {
    return null;
  }

  const pageSize = Math.min(getRequestedListingLimit(upstreamPath), 25);
  const allChildren = items.map((item, index) => parseRssPostChild(item[2], upstreamPath, sourceBase, index));
  const startIndex = getPaginatedStartIndex(allChildren, upstreamPath);

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

function isPublicFallbackPath(upstreamPath) {
  return isPublicPostPath(upstreamPath) || isPublicDiscoveryPath(upstreamPath);
}

function isCompatibleRedditPayload(payload, upstreamPath) {
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  if (normalizedPath === '/api/search_reddit_names.json') {
    return Array.isArray(payload?.names);
  }

  if (normalizedPath.includes('/comments/')) {
    return Array.isArray(payload) && Array.isArray(payload[0]?.data?.children);
  }

  return payload?.kind === 'Listing' && Array.isArray(payload.data?.children);
}

function getStringField(data, key) {
  const value = data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isRenderableObject(value) {
  return typeof value === 'object' && value !== null;
}

function isUsableThumbnail(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return /^https?:\/\//i.test(normalized) && !['default', 'self', 'nsfw', 'spoiler', 'image'].includes(normalized);
}

function isCommentPermalinkUrl(url, permalink, id) {
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

function hasRenderablePostData(data) {
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

function hasRenderablePostPayload(payload, upstreamPath) {
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

function hasPreviewMedia(data) {
  return Array.isArray(data.preview?.images) && data.preview.images.length > 0;
}

function hasGalleryMedia(data) {
  return Boolean(data.is_gallery && Array.isArray(data.gallery_data?.items) && isRenderableObject(data.media_metadata));
}

function hasUsableMediaFields(data) {
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

function getRedlibDetailPath(data) {
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
];

function mergeRedlibMediaFields(target, source) {
  if (!hasUsableMediaFields(source)) {
    return;
  }

  for (const key of REDLIB_MEDIA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
}

async function runWithConcurrency(items, concurrency, worker) {
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

async function fetchRedlibDetailMediaData(base, detailPath) {
  const response = await fetchWithTimeout(
    `${base}${detailPath}`,
    {
      headers: {
        Accept: getPublicInstanceAccept('html'),
        'User-Agent': USER_AGENT,
      },
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

  const detailPayload = parseRedlibCommentsResponse(body, detailPath, base);
  const detailData = listingChildren(Array.isArray(detailPayload) ? detailPayload[0] : null)[0]?.data;

  return detailData && hasUsableMediaFields(detailData) ? detailData : null;
}

async function enrichRedlibListingMedia(payload, base, upstreamPath) {
  if (isCommentThreadPath(upstreamPath) || isPublicDiscoveryPath(upstreamPath)) {
    return payload;
  }

  const targets = listingChildren(payload)
    .filter((child) => child.data && !hasUsableMediaFields(child.data))
    .map((child) => ({ child, detailPath: getRedlibDetailPath(child.data) }))
    .filter((item) => item.detailPath);

  if (targets.length === 0) {
    return payload;
  }

  await runWithConcurrency(targets, REDLIB_DETAIL_ENRICH_CONCURRENCY, async ({ child, detailPath }) => {
    try {
      const detailData = await fetchRedlibDetailMediaData(base, detailPath);

      if (detailData) {
        mergeRedlibMediaFields(child.data, detailData);
      }
    } catch {
      // Detail enrichment is opportunistic; keep the original listing child on failure.
    }
  });

  return payload;
}

function getPublicInstanceAccept(method) {
  if (method === 'json') {
    return 'application/json';
  }

  if (method === 'rss') {
    return 'application/rss+xml, application/atom+xml, application/xml, text/xml';
  }

  return 'text/html, application/xhtml+xml';
}

function getPublicInstanceTimeoutMs(request, upstreamPath) {
  if (!isCommentThreadPath(upstreamPath)) {
    return 3000;
  }

  return request.method === 'html' ? 7000 : 5000;
}

function parsePublicInstancePayload(body, contentType, request, base, upstreamPath) {
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
      const redlibPayload = parseRedlibCommentsResponse(body, upstreamPath, base);

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
    const redlibPayload = normalizePublicInstancePayload(parseRedlibListing(body, upstreamPath, base), upstreamPath);
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

async function fetchFromPublicInstance(base, upstreamPath, mediaPref) {
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
          headers: {
            Accept: getPublicInstanceAccept(request.method),
            'User-Agent': USER_AGENT,
          },
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
      );

      if (
        request.method === 'html' &&
        looksRedlibHtml(body) &&
        !isCommentThreadPath(upstreamPath) &&
        !isPublicDiscoveryPath(upstreamPath)
      ) {
        normalizedPayload = await enrichRedlibListingMedia(normalizedPayload, base, upstreamPath);
      }

      if (!isCompatibleRedditPayload(normalizedPayload, upstreamPath)) {
        continue;
      }

      const finalPayload = applyMediaSourcePreference(normalizedPayload, base, mediaPref);
      const normalizedBody = JSON.stringify(finalPayload);

      return new Response(normalizedBody, {
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

// Query a group of instances concurrently and resolve with the FIRST that returns a usable
// Reddit-shaped response. A dead, slow, or bot-walled instance can no longer stall the whole
// group: losers settle in the background only to record health. Resolves null if none succeed.
function raceUsablePublicInstance(bases, upstreamPath, mediaPref) {
  return new Promise((resolve) => {
    if (bases.length === 0) {
      resolve(null);
      return;
    }

    let remaining = bases.length;
    let settled = false;

    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    for (const base of bases) {
      fetchFromPublicInstance(base, upstreamPath, mediaPref)
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

async function fetchViaPublicInstances(upstreamPath, mediaPref) {
  if (!publicInstanceFallbackEnabled() || !isPublicFallbackPath(upstreamPath)) {
    return null;
  }

  const urls = await getPublicInstanceUrls();
  const { candidates, skipped } = getPublicInstanceCandidates(urls);
  const attempted = [];
  const batchSize = 8;

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    attempted.push(...batch);

    const winner = await raceUsablePublicInstance(batch, upstreamPath, mediaPref);

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

async function fetchViaRedditRss(upstreamPath) {
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
          'User-Agent': USER_AGENT,
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

  const { pref: mediaPref, cleanPath } = extractMediaPref(upstreamPath);

  const publicInstanceResponse = await fetchViaPublicInstances(cleanPath, mediaPref);

  if (publicInstanceResponse) {
    const body = await publicInstanceResponse.text();
    setCorsHeaders(res);
    res.writeHead(publicInstanceResponse.status, {
      'Content-Type': publicInstanceResponse.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'Cache-Control': publicInstanceResponse.headers.get('cache-control') ?? 'public, max-age=30, s-maxage=120',
      'X-RedAlt-Fallback': publicInstanceResponse.headers.get('x-redalt-fallback') ?? 'public-instance',
      'X-RedAlt-Instance': publicInstanceResponse.headers.get('x-redalt-instance') ?? 'unknown',
      'X-RedAlt-Instance-Method': publicInstanceResponse.headers.get('x-redalt-instance-method') ?? 'unknown',
      'X-RedAlt-Instance-Attempts': publicInstanceResponse.headers.get('x-redalt-instance-attempts') ?? '',
      'X-RedAlt-Skipped-Instances': publicInstanceResponse.headers.get('x-redalt-skipped-instances') ?? '',
    });
    res.end(body);
    return;
  }

  let fallback = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${cleanPath}`;
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
          message: 'Reddit blocked this request from the current network. Try another proxy or fallback source.',
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
    const mirrorResponse = await fetchViaAllOrigins(cleanPath).catch(() => null);

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

  const redditRssResponse = await fetchViaRedditRss(cleanPath);

  if (redditRssResponse) {
    const body = await redditRssResponse.text();
    setCorsHeaders(res);
    res.writeHead(redditRssResponse.status, {
      'Content-Type': redditRssResponse.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'Cache-Control': redditRssResponse.headers.get('cache-control') ?? 'public, max-age=30, s-maxage=120',
      'X-RedAlt-Fallback': redditRssResponse.headers.get('x-redalt-fallback') ?? 'reddit-rss',
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
