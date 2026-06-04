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
  const [rawPath, rawQuery = ''] = upstreamPath.split('?');
  const path = rawPath.replace(/\.json$/i, '');
  const rssParams = new URLSearchParams(rawQuery);
  rssParams.delete('raw_json');
  const query = rssParams.toString();
  const withQuery = (rssPath) => `${rssPath}${query ? `?${query}` : ''}`;
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

  if (isTedditInstance(base)) {
    return appendTedditApiParams('/search', params);
  }

  return `/search.rss?${params.toString()}`;
}

function buildPublicInstancePath(base, upstreamPath) {
  if (isPublicDiscoveryPath(upstreamPath)) {
    return buildPublicDiscoveryPath(base, upstreamPath);
  }

  if (isTedditInstance(base)) {
    return buildTedditPath(upstreamPath);
  }

  if (isUnsupportedBrowserAppInstance(base)) {
    return null;
  }

  return buildRssPath(upstreamPath);
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
  const lines = stripHtmlLines(content).filter((line) => {
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

function parseRssListing(xml, upstreamPath, sourceBase = 'https://www.reddit.com') {
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
        const enclosureUrl = normalizeUrlCandidate(
          readXmlAttribute(itemXml, 'enclosure', 'url') ||
            readXmlAttribute(itemXml, 'media:content', 'url') ||
            readXmlAttribute(itemXml, 'media:thumbnail', 'url'),
          sourceBase,
        );
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
        const contentUrls = firstDistinctUrl(
          [
            enclosureUrl,
            ...readHtmlAttributes(content, 'src'),
            ...readHtmlAttributes(content, 'href'),
            link,
          ],
          sourceBase,
        );
        const imageUrl = contentUrls.find(isLikelyImageUrl) ?? '';
        const videoUrl = contentUrls.find(isLikelyVideoUrl) ?? '';
        const embed = contentUrls.map(buildKnownEmbed).find((value) => value !== null) ?? null;
        const externalUrl = contentUrls.find((url) => !isRedditNavigationUrl(url)) ?? '';
        const outboundUrl = videoUrl || imageUrl || externalUrl || normalizeUrlCandidate(link, sourceBase) || `https://www.reddit.com${permalink}`;
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
    const looksHtml = (contentType ?? '').toLowerCase().includes('html') || /<html\b|<a\s/i.test(body);

    if (!looksJson && !looksRss && !(looksHtml && isPublicDiscoveryPath(upstreamPath))) {
      return null;
    }

    const normalizedPayload = looksJson
      ? normalizePublicInstancePayload(JSON.parse(body), upstreamPath)
      : looksRss
        ? normalizePublicInstancePayload(parseRssListing(body, upstreamPath, base), upstreamPath)
        : parseHtmlDiscoveryListing(body, upstreamPath);

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
  if (!publicInstanceFallbackEnabled() || !isPublicFallbackPath(upstreamPath)) {
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
    const normalizedPayload = parseRssListing(body, upstreamPath);

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

  const redditRssResponse = await fetchViaRedditRss(upstreamPath);

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
