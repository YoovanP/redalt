import { getApiErrorMessage, RedditApiError } from './errors';
import type {
  PostDetailResult,
  PostListingResult,
  RedditComment,
  RedditCommentsResponse,
  RedditListingResponse,
  RedditPostData,
} from '../types/reddit';

const DEFAULT_REDDIT_BASE = '/api/reddit';
const REMOTE_REDDIT_BASES = [
  'https://redalt-vercel.onrender.com/api/reddit',
  'https://redalt.pages.dev/api/reddit',
] as const;
const DEFAULT_REDDIT_BASES = [...REMOTE_REDDIT_BASES, DEFAULT_REDDIT_BASE];
const REDDIT_BASES = resolveRedditBases(import.meta.env.VITE_REDDIT_API_BASES);
const SESSION_REDDIT_BASE_KEY = 'redalt.redditApiBase';
const UI_SETTINGS_KEY = 'redalt.uiSettings';
const PAGE_SIZE = 8;
const REDDIT_BASE_FAILURE_BASE_COOLDOWN_MS = 30 * 1000;
const REDDIT_BASE_FAILURE_MAX_COOLDOWN_MS = 5 * 60 * 1000;
const POST_CACHE_KEY = 'redalt.postCache';
const POST_CACHE_LIMIT = 120;
const POST_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const LISTING_FETCH_TIMEOUT_MS = 25_000;
const DETAIL_FETCH_TIMEOUT_MS = 40_000;
const DETAIL_FETCH_STAGGER_MS = 1_500;
const DETAIL_RECOVERY_TIMEOUT_MS = 25_000;
const DETAIL_FALLBACK_PAGE_SIZE = 40;

let sessionRedditBase = readSessionRedditBase();
const redditBaseHealth = new Map<string, { failureCount: number; retryAfter: number }>();
const postCache = readSessionPostCache();

function normalizeBase(base: string): string {
  const trimmed = base.trim();

  if (!trimmed) {
    return '';
  }

  return trimmed.replace(/\/+$/g, '');
}

function isCloudflarePagesHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.endsWith('.pages.dev');
}

function isViteDevServer(): boolean {
  return import.meta.env.DEV;
}

function resolveBaseKey(base: string): string {
  const normalized = normalizeBase(base);

  if (!normalized) {
    return '';
  }

  if (typeof window !== 'undefined') {
    try {
      return normalizeBase(new URL(normalized, window.location.origin).toString()).toLowerCase();
    } catch {
      return normalized.toLowerCase();
    }
  }

  return normalized.toLowerCase();
}

function isSameOriginRedditBase(base: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return resolveBaseKey(base) === resolveBaseKey(DEFAULT_REDDIT_BASE);
}

function shouldAvoidPersistingRedditBase(base: string): boolean {
  return isCloudflarePagesHost() && isSameOriginRedditBase(base);
}

function getDefaultRedditBases(): string[] {
  if (isViteDevServer()) {
    return [...REMOTE_REDDIT_BASES];
  }

  if (isCloudflarePagesHost()) {
    return [REMOTE_REDDIT_BASES[0], DEFAULT_REDDIT_BASE];
  }

  return [...DEFAULT_REDDIT_BASES];
}

function resolveRedditBases(rawBases: string | undefined): string[] {
  const configuredBases = (rawBases ?? '')
    .split(',')
    .map((base) => normalizeBase(base))
    .filter((base) => base.length > 0);
  const bases = configuredBases.length === 0 ? getDefaultRedditBases() : configuredBases;
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const base of bases) {
    const normalized = normalizeBase(base);
    const key = resolveBaseKey(normalized);

    if (!normalized || !key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.length > 0 ? deduped : [DEFAULT_REDDIT_BASE];
}

export type ListingSort = 'hot' | 'new' | 'rising' | 'top';
export type TopTimeRange = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

type FlairTemplate = {
  text?: string;
};

type SubredditSearchResponse = {
  kind: 'Listing';
  data: {
    children: Array<{
      data: {
        display_name?: string;
        title?: string;
        public_description?: string;
        over18?: boolean;
        icon_img?: string;
        community_icon?: string;
        subscribers?: number;
      };
    }>;
  };
};

type UserSearchResponse = {
  kind: 'Listing';
  data: {
    children: Array<{
      data: {
        name?: string;
        icon_img?: string;
        total_karma?: number;
      };
    }>;
  };
};

export type SearchSubredditResult = {
  name: string;
  title: string;
  description: string;
  subscribers: number;
  isNsfw: boolean;
  iconUrl?: string;
};

export type SearchUserResult = {
  name: string;
  totalKarma: number;
  iconUrl?: string;
};

export type GlobalSearchResult = {
  posts: RedditPostData[];
  subreddits: SearchSubredditResult[];
  users: SearchUserResult[];
};

export type MixedSearchSuggestion = {
  kind: 'post' | 'subreddit' | 'user';
  label: string;
  route: string;
  subtitle?: string;
};

export type SearchSort = 'relevance' | 'hot' | 'new' | 'top' | 'comments';

export type GlobalSearchOptions = {
  sort?: SearchSort;
  topTimeRange?: TopTimeRange;
  subredditScope?: string;
  includeNsfw?: boolean;
  postLimit?: number;
  subredditLimit?: number;
  userLimit?: number;
};

type SubredditTypeaheadResponse = {
  names?: string[];
};

export type FetchListingOptions = {
  after?: string | null;
  sort?: ListingSort;
  topTimeRange?: TopTimeRange;
};

type CachedPostEntry = {
  savedAt: number;
  post: RedditPostData;
};

function notifyApiStatus(level: 'ok' | 'warn' | 'error', message: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent('redalt-api-status', {
      detail: {
        level,
        message,
      },
    }),
  );
}

function normalizeApiUrl(input: string | undefined): string {
  return (input ?? '').replace(/&amp;/g, '&');
}

function normalizeSubredditName(input: string): string {
  return input.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
}

function normalizeUserName(input: string): string {
  return input.trim().replace(/^\/?u(?:ser)?\//i, '').replace(/^\/+|\/+$/g, '');
}

function shouldRetryApiError(error: RedditApiError): boolean {
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

function isSourceSwitchableError(error: RedditApiError): boolean {
  return shouldRetryApiError(error) || error.status === 403 || error.status === 451;
}

function canUseSessionStorage(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return typeof window.sessionStorage !== 'undefined';
  } catch {
    return false;
  }
}

function readSessionPostCache(): Map<string, CachedPostEntry> {
  const cache = new Map<string, CachedPostEntry>();

  if (!canUseSessionStorage()) {
    return cache;
  }

  try {
    const raw = window.sessionStorage.getItem(POST_CACHE_KEY);

    if (!raw) {
      return cache;
    }

    const parsed = JSON.parse(raw) as Array<{ savedAt?: unknown; post?: RedditPostData }>;
    const now = Date.now();

    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const post = entry?.post;
      const savedAt = typeof entry?.savedAt === 'number' ? entry.savedAt : 0;

      if (!post?.id || !post.subreddit || now - savedAt > POST_CACHE_MAX_AGE_MS) {
        continue;
      }

      cache.set(post.id, { savedAt, post });
    }
  } catch {
    return new Map<string, CachedPostEntry>();
  }

  return cache;
}

function writeSessionPostCache(): void {
  if (!canUseSessionStorage()) {
    return;
  }

  try {
    const entries = Array.from(postCache.values())
      .sort((left, right) => right.savedAt - left.savedAt)
      .slice(0, POST_CACHE_LIMIT);

    postCache.clear();

    for (const entry of entries) {
      postCache.set(entry.post.id, entry);
    }

    window.sessionStorage.setItem(POST_CACHE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage failures and keep using the in-memory cache.
  }
}

function getUrlHostname(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isRedditMediaHost(hostname: string): boolean {
  return (
    hostname === 'i.redd.it' ||
    hostname === 'preview.redd.it' ||
    hostname === 'v.redd.it' ||
    hostname.endsWith('.redd.it') ||
    hostname.endsWith('redditmedia.com') ||
    hostname.endsWith('reddit.com')
  );
}

function isCommentPermalinkUrl(url: string | undefined, postId: string): boolean {
  if (!url || !postId) {
    return false;
  }

  try {
    return new URL(url).pathname.toLowerCase().includes('/comments/' + postId.toLowerCase());
  } catch {
    return url.toLowerCase().includes('/comments/' + postId.toLowerCase());
  }
}

function isKnownRedditHostedVideoUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    return hostname === 'v.redd.it' || (hostname.endsWith('reddit.com') && /^\/video\/[^/?#]+/i.test(parsed.pathname));
  } catch {
    return /https?:\/\/v\.redd\.it\//i.test(url) || /https?:\/\/[^/]*reddit\.com\/video\//i.test(url);
  }
}

function hasNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

function hasPreviewImages(post: RedditPostData): boolean {
  return Array.isArray(post.preview?.images) && post.preview.images.length > 0;
}

function getPostOutboundUrl(post: RedditPostData | null | undefined): string {
  return post ? post.url_overridden_by_dest ?? post.url ?? '' : '';
}

function hasPlayableVideoMedia(post: RedditPostData | null | undefined): boolean {
  if (!post) {
    return false;
  }

  const outboundUrl = getPostOutboundUrl(post);

  return Boolean(
    (Boolean(post.is_video || post.post_hint === 'hosted:video') &&
      Boolean(post.secure_media?.reddit_video?.fallback_url || post.media?.reddit_video?.fallback_url)) ||
      isKnownRedditHostedVideoUrl(outboundUrl),
  );
}

function hasRenderableEmbed(post: RedditPostData | null | undefined): boolean {
  if (!post) {
    return false;
  }

  return Boolean(
    post.secure_media?.oembed?.html ||
      post.media?.oembed?.html ||
      post.secure_media_embed?.content ||
      post.media_embed?.content,
  );
}

function hasGalleryMedia(post: RedditPostData | null | undefined): boolean {
  return Boolean(post?.is_gallery && post.gallery_data?.items?.length && hasNonEmptyObject(post.media_metadata));
}

function hasRenderableExternalOutbound(post: RedditPostData | null | undefined): boolean {
  if (!post) {
    return false;
  }

  const outboundUrl = getPostOutboundUrl(post);
  const hostname = getUrlHostname(outboundUrl);

  return Boolean(
    outboundUrl && !isRedditMediaHost(hostname) && !isCommentPermalinkUrl(outboundUrl, post.id),
  );
}

function isPreviewOnlyPlaceholderDetail(post: RedditPostData | null | undefined): boolean {
  if (!post || post.is_self) {
    return false;
  }

  const outboundUrl = getPostOutboundUrl(post);
  const hostname = getUrlHostname(outboundUrl);
  const usesDiscussionUrl = isCommentPermalinkUrl(outboundUrl, post.id);
  const pointsToRedditHost = Boolean(outboundUrl) && isRedditMediaHost(hostname);

  return (
    hasPreviewImages(post) &&
    !hasPlayableVideoMedia(post) &&
    !hasRenderableEmbed(post) &&
    !hasGalleryMedia(post) &&
    !hasRenderableExternalOutbound(post) &&
    (!outboundUrl || usesDiscussionUrl || pointsToRedditHost)
  );
}

function needsDetailMediaRecovery(post: RedditPostData | null | undefined): boolean {
  if (!post) {
    return true;
  }

  return getRawPostMediaStrength(post) < 3 || isPreviewOnlyPlaceholderDetail(post);
}

function candidateImprovesMedia(current: RedditPostData, candidate: RedditPostData): boolean {
  const currentStrength = getRawPostMediaStrength(current);
  const candidateStrength = getRawPostMediaStrength(candidate);

  if (candidateStrength > currentStrength) {
    return true;
  }

  if (candidateStrength < currentStrength && !isPreviewOnlyPlaceholderDetail(current)) {
    return false;
  }

  if (hasPlayableVideoMedia(candidate) && !hasPlayableVideoMedia(current)) {
    return true;
  }

  if (hasRenderableEmbed(candidate) && !hasRenderableEmbed(current)) {
    return true;
  }

  if (hasGalleryMedia(candidate) && !hasGalleryMedia(current)) {
    return true;
  }

  if (hasRenderableExternalOutbound(candidate) && !hasRenderableExternalOutbound(current)) {
    return true;
  }

  return false;
}

function getRawPostMediaStrength(post: RedditPostData | null | undefined): number {
  if (!post) {
    return -1;
  }

  const outboundUrl = getPostOutboundUrl(post);
  const hostname = getUrlHostname(outboundUrl);
  const hasExternalOutbound = Boolean(
    outboundUrl && !isRedditMediaHost(hostname) && !isCommentPermalinkUrl(outboundUrl, post.id),
  );
  const hasVideo = hasPlayableVideoMedia(post);
  const hasEmbed = hasRenderableEmbed(post);
  const hasGallery = hasGalleryMedia(post);
  const hasImage =
    post.post_hint === 'image' ||
    hasPreviewImages(post) ||
    Boolean(post.thumbnail && /^https?:\/\//i.test(post.thumbnail));

  if (hasVideo) {
    return 5;
  }

  if (hasEmbed) {
    return 4;
  }

  if (hasGallery) {
    return 4;
  }

  if (hasImage) {
    return 3;
  }

  if (hasExternalOutbound) {
    return 2;
  }

  return post.is_self || post.selftext.trim() ? 1 : 0;
}

function mergePostMediaFields(detailPost: RedditPostData, mediaPost: RedditPostData): RedditPostData {
  return {
    ...detailPost,
    link_flair_text: detailPost.link_flair_text ?? mediaPost.link_flair_text,
    url: mediaPost.url || detailPost.url,
    url_overridden_by_dest: mediaPost.url_overridden_by_dest ?? detailPost.url_overridden_by_dest,
    domain: mediaPost.domain || detailPost.domain,
    thumbnail: mediaPost.thumbnail ?? detailPost.thumbnail,
    preview: hasPreviewImages(mediaPost) ? mediaPost.preview : detailPost.preview,
    gallery_data: mediaPost.gallery_data ?? detailPost.gallery_data,
    media_metadata: mediaPost.media_metadata ?? detailPost.media_metadata,
    media: hasNonEmptyObject(mediaPost.media) ? mediaPost.media : detailPost.media,
    secure_media: hasNonEmptyObject(mediaPost.secure_media) ? mediaPost.secure_media : detailPost.secure_media,
    media_embed: mediaPost.media_embed ?? detailPost.media_embed,
    secure_media_embed: mediaPost.secure_media_embed ?? detailPost.secure_media_embed,
    is_self: mediaPost.is_self,
    is_gallery: mediaPost.is_gallery ?? detailPost.is_gallery,
    is_video: mediaPost.is_video ?? detailPost.is_video,
    post_hint: mediaPost.post_hint ?? detailPost.post_hint,
  };
}

function chooseBetterCachedPost(current: RedditPostData, candidate: RedditPostData): RedditPostData {
  const currentStrength = getRawPostMediaStrength(current);
  const candidateStrength = getRawPostMediaStrength(candidate);

  if (candidateImprovesMedia(current, candidate)) {
    return candidate;
  }

  if (candidateStrength < currentStrength && !candidateImprovesMedia(candidate, current)) {
    return current;
  }

  if ((candidate.num_comments ?? 0) > (current.num_comments ?? 0) || (candidate.score ?? 0) > (current.score ?? 0)) {
    return candidate;
  }

  return current;
}

function rememberPosts(posts: RedditPostData[]): void {
  let changed = false;
  const now = Date.now();

  for (const post of posts) {
    if (!post?.id || !post.subreddit) {
      continue;
    }

    const existing = postCache.get(post.id);
    const best = existing ? chooseBetterCachedPost(existing.post, post) : post;

    postCache.set(post.id, {
      savedAt: now,
      post: best,
    });
    changed = true;
  }

  if (!changed) {
    return;
  }

  writeSessionPostCache();
}

function getCachedPost(postId: string): RedditPostData | null {
  const cached = postCache.get(postId);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.savedAt > POST_CACHE_MAX_AGE_MS) {
    postCache.delete(postId);
    writeSessionPostCache();
    return null;
  }

  return cached.post;
}

export function getRememberedPost(postId: string): RedditPostData | null {
  return getCachedPost(postId);
}

function useRicherPostMedia(detailPost: RedditPostData, candidate: RedditPostData | null): RedditPostData {
  if (!candidate || candidate.id !== detailPost.id) {
    return detailPost;
  }

  return candidateImprovesMedia(detailPost, candidate) ? mergePostMediaFields(detailPost, candidate) : detailPost;
}

async function fetchListingFallback(
  subreddit: string,
  sort: ListingSort,
  postId: string,
  topTimeRange: TopTimeRange = 'day',
): Promise<RedditPostData | null> {
  const queryParts = ['raw_json=1', 'limit=' + DETAIL_FALLBACK_PAGE_SIZE];

  if (sort === 'top') {
    queryParts.push('t=' + encodeURIComponent(topTimeRange));
  }

  const listing = await fetchReddit<RedditListingResponse>(
    '/r/' + encodeURIComponent(subreddit) + '/' + sort + '.json?' + queryParts.join('&'),
    { timeoutMs: DETAIL_RECOVERY_TIMEOUT_MS },
  );
  const posts = listing.data.children.filter((item) => item.kind === 't3').map((item) => item.data);
  rememberPosts(posts);

  return posts.find((post) => post.id === postId) ?? null;
}

async function fetchUserFallback(author: string, postId: string): Promise<RedditPostData | null> {
  const cleanedAuthor = normalizeUserName(author);

  if (!cleanedAuthor || cleanedAuthor === '[deleted]' || cleanedAuthor === '[unknown]') {
    return null;
  }

  const listing = await fetchReddit<RedditListingResponse>(
    '/user/' + encodeURIComponent(cleanedAuthor) + '/submitted.json?raw_json=1&limit=' + DETAIL_FALLBACK_PAGE_SIZE + '&sort=new',
    { timeoutMs: DETAIL_RECOVERY_TIMEOUT_MS },
  );
  const posts = listing.data.children.filter((item) => item.kind === 't3').map((item) => item.data);
  rememberPosts(posts);

  return posts.find((post) => post.id === postId) ?? null;
}

async function fetchSearchFallback(subreddit: string, title: string, postId: string): Promise<RedditPostData | null> {
  const query = title.trim();

  if (!query) {
    return null;
  }

  const listing = await fetchReddit<RedditListingResponse>(
    '/r/' + encodeURIComponent(subreddit) + '/search.json?raw_json=1&restrict_sr=1&sort=relevance&limit=10&q=' + encodeURIComponent(query),
    { timeoutMs: DETAIL_RECOVERY_TIMEOUT_MS },
  );
  const posts = listing.data.children.filter((item) => item.kind === 't3').map((item) => item.data);
  rememberPosts(posts);
  return posts.find((post) => post.id === postId) ?? null;
}

async function recoverPostFromFallbackSources(
  subreddit: string,
  postId: string,
  author?: string,
  title?: string,
): Promise<RedditPostData | null> {
  const attempts = [
    title ? () => fetchSearchFallback(subreddit, title, postId) : null,
    () => fetchListingFallback(subreddit, 'new', postId),
    () => fetchUserFallback(author ?? '', postId),
    () => fetchListingFallback(subreddit, 'hot', postId),
    () => fetchListingFallback(subreddit, 'top', postId, 'week'),
  ].filter((attempt): attempt is () => Promise<RedditPostData | null> => Boolean(attempt));

  const results = await Promise.all(
    attempts.map(async (attempt) => {
      try {
        return await attempt();
      } catch {
        return null;
      }
    }),
  );

  return results.find((post): post is RedditPostData => Boolean(post)) ?? null;
}

function isConfiguredRedditBase(base: string): boolean {
  const key = resolveBaseKey(base);
  return key.length > 0 && REDDIT_BASES.some((candidate) => resolveBaseKey(candidate) === key);
}

function readSessionRedditBase(): string | null {
  if (!canUseSessionStorage()) {
    return null;
  }

  try {
    const storedBase = normalizeBase(window.sessionStorage.getItem(SESSION_REDDIT_BASE_KEY) ?? '');

    if (!storedBase || !isConfiguredRedditBase(storedBase) || shouldAvoidPersistingRedditBase(storedBase)) {
      window.sessionStorage.removeItem(SESSION_REDDIT_BASE_KEY);
      return null;
    }

    return storedBase;
  } catch {
    return null;
  }
}

function writeSessionRedditBase(base: string): void {
  const normalized = normalizeBase(base);

  if (!normalized || !isConfiguredRedditBase(normalized) || shouldAvoidPersistingRedditBase(normalized)) {
    clearSessionRedditBase(base);
    return;
  }

  sessionRedditBase = normalized;

  if (!canUseSessionStorage()) {
    return;
  }

  try {
    window.sessionStorage.setItem(SESSION_REDDIT_BASE_KEY, normalized);
  } catch {
    // In-memory session pinning still works when storage is unavailable.
  }
}

function clearSessionRedditBase(base: string): void {
  const key = resolveBaseKey(base);

  if (sessionRedditBase && resolveBaseKey(sessionRedditBase) === key) {
    sessionRedditBase = null;
  }

  if (!canUseSessionStorage()) {
    return;
  }

  try {
    const storedBase = normalizeBase(window.sessionStorage.getItem(SESSION_REDDIT_BASE_KEY) ?? '');

    if (!storedBase || resolveBaseKey(storedBase) !== key) {
      return;
    }

    window.sessionStorage.removeItem(SESSION_REDDIT_BASE_KEY);
  } catch {
    // Nothing else to clear.
  }
}

function markRedditBaseSuccess(base: string): void {
  redditBaseHealth.delete(resolveBaseKey(base));
}

function markRedditBaseFailure(base: string): void {
  const key = resolveBaseKey(base);
  const previous = redditBaseHealth.get(key);
  const failureCount = Math.min((previous?.failureCount ?? 0) + 1, 5);
  const cooldown = Math.min(
    REDDIT_BASE_FAILURE_BASE_COOLDOWN_MS * 2 ** (failureCount - 1),
    REDDIT_BASE_FAILURE_MAX_COOLDOWN_MS,
  );

  redditBaseHealth.set(key, {
    failureCount,
    retryAfter: Date.now() + cooldown,
  });
}

function isRedditBaseCoolingDown(base: string): boolean {
  const health = redditBaseHealth.get(resolveBaseKey(base));
  return Boolean(health && health.retryAfter > Date.now());
}

function getRedditBaseCandidates(): string[] {
  let candidates: string[];

  if (!sessionRedditBase || !isConfiguredRedditBase(sessionRedditBase) || shouldAvoidPersistingRedditBase(sessionRedditBase)) {
    sessionRedditBase = null;
    candidates = REDDIT_BASES;
  } else {
    const sessionKey = resolveBaseKey(sessionRedditBase);
    candidates = [
      sessionRedditBase,
      ...REDDIT_BASES.filter((base) => resolveBaseKey(base) !== sessionKey),
    ];
  }

  const activeCandidates = candidates.filter((base) => !isRedditBaseCoolingDown(base));
  return activeCandidates.length > 0 ? activeCandidates : candidates;
}

// Reads the persisted UI preference directly (this module is not a React component).
// `reddit` asks the proxy to rewrite still-image media to the Reddit CDN; `instance`
// (default) keeps Redlib-served media URLs.
function getFallbackMediaPref(): 'instance' | 'reddit' {
  if (typeof window === 'undefined') {
    return 'instance';
  }

  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY);

    if (!raw) {
      return 'instance';
    }

    const parsed = JSON.parse(raw) as { fallbackMediaSource?: unknown };
    return parsed.fallbackMediaSource === 'reddit' ? 'reddit' : 'instance';
  } catch {
    return 'instance';
  }
}

function appendMediaPref(path: string): string {
  if (getFallbackMediaPref() !== 'reddit') {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}redalt_media=reddit`;
}

type FetchRedditStrategy = 'sequential' | 'staggered';

type FetchRedditOptions = {
  timeoutMs?: number;
  strategy?: FetchRedditStrategy;
  staggerMs?: number;
};

function handleFetchRedditFailure(base: string, error: unknown): RedditApiError | null {
  if (error instanceof RedditApiError) {
    if (isSourceSwitchableError(error)) {
      markRedditBaseFailure(base);
      clearSessionRedditBase(base);
    }

    if (error.status === 429) {
      notifyApiStatus('warn', 'Reddit rate limit hit. Retrying...');
    } else if (error.status === 403 || error.status === 451) {
      notifyApiStatus('warn', 'Reddit blocked one proxy. Trying another...');
    } else if (error.status >= 500 || error.status === 0) {
      notifyApiStatus('error', 'Reddit connection issue. Retrying...');
    }

    return error;
  }

  markRedditBaseFailure(base);
  clearSessionRedditBase(base);
  return null;
}

async function fetchRedditFromBase<T>(
  base: string,
  requestPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${base}${requestPath}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        notifyApiStatus('warn', 'Reddit is rate-limiting requests. Results may load slowly.');
      }

      throw new RedditApiError(await readApiErrorMessage(response), response.status);
    }

    const contentType = response.headers.get('Content-Type') ?? '';

    if (!contentType.toLowerCase().includes('application/json')) {
      throw new RedditApiError('Reddit returned an unexpected response format.', 502);
    }

    notifyApiStatus('ok', 'Connected to Reddit.');

    const payload = (await response.json()) as T;
    markRedditBaseSuccess(base);
    writeSessionRedditBase(base);

    return payload;
  } catch (error) {
    if (timedOut) {
      throw new RedditApiError('Reddit request timed out.', 0);
    }

    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);

    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function fetchRedditSequential<T>(requestPath: string, timeoutMs: number): Promise<T> {
  let lastError: unknown;
  let lastApiError: RedditApiError | null = null;

  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const base of getRedditBaseCandidates()) {
      try {
        return await fetchRedditFromBase<T>(base, requestPath, timeoutMs);
      } catch (error) {
        lastError = error;

        const apiError = handleFetchRedditFailure(base, error);

        if (apiError) {
          lastApiError = apiError;

          if (apiError.status !== 429 && apiError.status < 500) {
            continue;
          }
        }
      }
    }

    if (lastApiError && !shouldRetryApiError(lastApiError) && !isSourceSwitchableError(lastApiError)) {
      break;
    }

    if (cycle === 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
    }
  }

  if (lastApiError) {
    throw lastApiError;
  }

  if (lastError instanceof RedditApiError) {
    throw lastError;
  }

  notifyApiStatus('error', 'Network error while contacting Reddit.');

  throw new RedditApiError('Network error while contacting Reddit.', 0);
}

async function fetchRedditStaggered<T>(requestPath: string, timeoutMs: number, staggerMs: number): Promise<T> {
  const bases = getRedditBaseCandidates();

  if (bases.length <= 1) {
    return fetchRedditSequential<T>(requestPath, timeoutMs);
  }

  let lastError: unknown;
  let lastApiError: RedditApiError | null = null;
  let completed = 0;
  let settled = false;
  const controllers = bases.map(() => new AbortController());

  return new Promise<T>((resolve, reject) => {
    const rejectIfDone = () => {
      if (settled || completed < bases.length) {
        return;
      }

      if (lastApiError) {
        reject(lastApiError);
        return;
      }

      if (lastError instanceof RedditApiError) {
        reject(lastError);
        return;
      }

      notifyApiStatus('error', 'Network error while contacting Reddit.');
      reject(new RedditApiError('Network error while contacting Reddit.', 0));
    };

    bases.forEach((base, index) => {
      void (async () => {
        if (index > 0) {
          await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, staggerMs * index));
        }

        if (settled) {
          completed += 1;
          rejectIfDone();
          return;
        }

        try {
          const payload = await fetchRedditFromBase<T>(base, requestPath, timeoutMs, controllers[index].signal);

          if (settled) {
            return;
          }

          settled = true;
          controllers.forEach((controller, controllerIndex) => {
            if (controllerIndex !== index) {
              controller.abort();
            }
          });
          resolve(payload);
        } catch (error) {
          if (settled && controllers[index].signal.aborted) {
            return;
          }

          lastError = error;
          const apiError = handleFetchRedditFailure(base, error);

          if (apiError) {
            lastApiError = apiError;
          }

          completed += 1;
          rejectIfDone();
        }
      })();
    });
  });
}

async function fetchReddit<T>(path: string, options: FetchRedditOptions = {}): Promise<T> {
  const requestPath = appendMediaPref(path);
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const strategy = options.strategy ?? 'sequential';

  if (strategy === 'staggered') {
    return fetchRedditStaggered<T>(requestPath, timeoutMs, options.staggerMs ?? 0);
  }

  return fetchRedditSequential<T>(requestPath, timeoutMs);
}

async function readApiErrorMessage(response: Response): Promise<string> {
  const fallback = getApiErrorMessage(response.status);
  const contentType = response.headers.get('Content-Type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    return fallback;
  }

  try {
    const payload = (await response.clone().json()) as { message?: unknown };
    return typeof payload.message === 'string' && payload.message.trim() ? payload.message : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchSubredditListing(
  subredditInput: string,
  options: FetchListingOptions = {},
): Promise<PostListingResult> {
  const after = options.after ?? null;
  const sort = options.sort ?? 'hot';
  const topTimeRange = options.topTimeRange ?? 'day';
  const subreddit = normalizeSubredditName(subredditInput) || 'mildlyinfuriating';
  const queryParts = ['raw_json=1', `limit=${PAGE_SIZE}`];

  if (after) {
    queryParts.push(`after=${encodeURIComponent(after)}`);
  }

  if (sort === 'top') {
    queryParts.push(`t=${encodeURIComponent(topTimeRange)}`);
  }

  const data = await fetchReddit<RedditListingResponse>(
    `/r/${encodeURIComponent(subreddit)}/${sort}.json?${queryParts.join('&')}`,
    { timeoutMs: LISTING_FETCH_TIMEOUT_MS },
  );
  const posts = data.data.children.map((item) => item.data);
  rememberPosts(posts);


  return {
    posts,
    after: data.data.after,
  };
}

export async function fetchUserListing(
  userInput: string,
  options: FetchListingOptions = {},
): Promise<PostListingResult> {
  const after = options.after ?? null;
  const sort = options.sort ?? 'hot';
  const topTimeRange = options.topTimeRange ?? 'day';
  const user = normalizeUserName(userInput);
  const queryParts = ['raw_json=1', `limit=${PAGE_SIZE}`];

  if (after) {
    queryParts.push(`after=${encodeURIComponent(after)}`);
  }

  if (sort === 'top') {
    queryParts.push(`t=${encodeURIComponent(topTimeRange)}`);
  }

  const data = await fetchReddit<RedditListingResponse>(
    `/user/${encodeURIComponent(user)}/submitted.json?${queryParts.join('&')}&sort=${encodeURIComponent(sort)}`,
    { timeoutMs: LISTING_FETCH_TIMEOUT_MS },
  );
  const posts = data.data.children.map((item) => item.data);
  rememberPosts(posts);


  return {
    posts,
    after: data.data.after,
  };
}

export async function fetchSubredditFlairs(subredditInput: string): Promise<string[]> {
  const subreddit = normalizeSubredditName(subredditInput) || 'mildlyinfuriating';

  try {
    const templates = await fetchReddit<FlairTemplate[]>(
      `/r/${encodeURIComponent(subreddit)}/api/link_flair_v2.json?raw_json=1`,
    );

    const seen = new Set<string>();

    for (const template of templates) {
      const flair = template.text?.trim();

      if (flair) {
        seen.add(flair);
      }
    }

    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function fetchSubredditSuggestions(query: string): Promise<string[]> {
  const cleaned = query.trim().replace(/^\/?r\//i, '');

  if (cleaned.length < 2) {
    return [];
  }

  if (!isCloudflarePagesHost()) {
    try {
      const typeahead = await fetchReddit<SubredditTypeaheadResponse>(
        `/api/search_reddit_names.json?raw_json=1&include_over_18=1&include_unadvertisable=1&query=${encodeURIComponent(cleaned)}`,
      );

      const names = (typeahead.names ?? [])
        .map((name) => name.trim())
        .filter(Boolean);

      if (names.length > 0) {
        return names.slice(0, 8);
      }
    } catch {
      // fallback handled below
    }
  }

  const cleanedLower = cleaned.toLowerCase();

  try {
    const response = await fetchReddit<SubredditSearchResponse>(
      `/subreddits/search.json?raw_json=1&include_over_18=on&limit=25&q=${encodeURIComponent(cleaned)}`,
    );

    const entries: Array<{ name: string; subscribers: number }> = [];
    const seen = new Set<string>();

    for (const item of response.data.children) {
      const value = item.data.display_name?.trim();
      const valueLower = value?.toLowerCase() ?? '';

      if (!value || !valueLower.includes(cleanedLower)) {
        continue;
      }

      if (seen.has(valueLower)) {
        continue;
      }

      seen.add(valueLower);
      entries.push({
        name: value,
        subscribers: item.data.subscribers ?? 0,
      });
    }

    entries.sort((a, b) => b.subscribers - a.subscribers || a.name.localeCompare(b.name));

    return entries.slice(0, 8).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function fetchMixedSearchSuggestions(query: string): Promise<MixedSearchSuggestion[]> {
  const cleaned = query.trim();

  if (cleaned.length < 2) {
    return [];
  }

  const blockProneSearchEndpoints = isCloudflarePagesHost();

  const [subredditTypeahead, userListing, postListing] = await Promise.allSettled([
    blockProneSearchEndpoints
      ? Promise.resolve<SubredditTypeaheadResponse>({ names: [] })
      : fetchReddit<SubredditTypeaheadResponse>(
          `/api/search_reddit_names.json?raw_json=1&include_over_18=1&include_unadvertisable=1&query=${encodeURIComponent(cleaned)}`,
        ),
    blockProneSearchEndpoints
      ? Promise.resolve<UserSearchResponse>({ kind: 'Listing', data: { children: [] } })
      : fetchReddit<UserSearchResponse>(
          `/users/search.json?raw_json=1&include_over_18=on&limit=5&q=${encodeURIComponent(cleaned)}`,
        ),
    fetchReddit<RedditListingResponse>(
      `/search.json?raw_json=1&sort=relevance&type=link&limit=6&q=${encodeURIComponent(cleaned)}`,
    ),
  ]);

  const suggestions: MixedSearchSuggestion[] = [];
  const seen = new Set<string>();

  if (postListing.status === 'fulfilled') {
    for (const item of postListing.value.data.children) {
      if (item.kind !== 't3') {
        continue;
      }

      const post = item.data;
      const key = `post:${post.id}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      suggestions.push({
        kind: 'post',
        label: post.title,
        route: `/r/${post.subreddit}/comments/${post.id}`,
        subtitle: `r/${post.subreddit} | u/${post.author}`,
      });
    }
  }

  if (subredditTypeahead.status === 'fulfilled') {
    for (const name of subredditTypeahead.value.names ?? []) {
      const trimmed = name.trim();

      if (!trimmed) {
        continue;
      }

      const key = `subreddit:${trimmed.toLowerCase()}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      suggestions.push({
        kind: 'subreddit',
        label: `r/${trimmed}`,
        route: `/r/${trimmed}`,
      });
    }
  }

  if (userListing.status === 'fulfilled') {
    for (const item of userListing.value.data.children) {
      const name = item.data.name?.trim();

      if (!name) {
        continue;
      }

      const key = `user:${name.toLowerCase()}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      suggestions.push({
        kind: 'user',
        label: `u/${name}`,
        route: `/u/${name}`,
        subtitle: `${(item.data.total_karma ?? 0).toLocaleString()} karma`,
      });
    }
  }

  return suggestions.slice(0, 12);
}

export async function fetchGlobalSearch(
  query: string,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchResult> {
  const cleaned = query.trim();
  const sort = options.sort ?? 'relevance';
  const topTimeRange = options.topTimeRange ?? 'day';
  const includeNsfw = options.includeNsfw ?? true;
  const subredditScope = normalizeSubredditName(options.subredditScope ?? '');
  const postLimit = Math.min(Math.max(options.postLimit ?? 16, 1), 100);
  const subredditLimit = Math.min(Math.max(options.subredditLimit ?? 12, 1), 100);
  const userLimit = Math.min(Math.max(options.userLimit ?? 12, 1), 100);

  const postSearchPath = subredditScope
    ? `/r/${encodeURIComponent(subredditScope)}/search.json?raw_json=1&restrict_sr=1`
    : '/search.json?raw_json=1';
  const postQueryParts = [
    `sort=${encodeURIComponent(sort)}`,
    `t=${encodeURIComponent(topTimeRange)}`,
    `include_over_18=${includeNsfw ? 'on' : 'off'}`,
    'type=link',
    `limit=${postLimit}`,
    `q=${encodeURIComponent(cleaned)}`,
  ];
  const communityQueryParts = [
    `raw_json=1`,
    `include_over_18=${includeNsfw ? 'on' : 'off'}`,
    `q=${encodeURIComponent(cleaned)}`,
  ];

  if (cleaned.length < 2) {
    return {
      posts: [],
      subreddits: [],
      users: [],
    };
  }

  const blockProneSearchEndpoints = isCloudflarePagesHost();

  const [postListing, subredditListing, userListing] = await Promise.allSettled([
    fetchReddit<RedditListingResponse>(`${postSearchPath}&${postQueryParts.join('&')}`),
    fetchReddit<SubredditSearchResponse>(
      `/subreddits/search.json?${[...communityQueryParts, `limit=${subredditLimit}`].join('&')}`,
    ),
    blockProneSearchEndpoints
      ? Promise.resolve<UserSearchResponse>({ kind: 'Listing', data: { children: [] } })
      : fetchReddit<UserSearchResponse>(
          `/users/search.json?${[...communityQueryParts, `limit=${userLimit}`].join('&')}`,
        ),
  ]);

  const postsSource = postListing.status === 'fulfilled' ? postListing.value : null;
  const subredditsSource = subredditListing.status === 'fulfilled' ? subredditListing.value : null;
  const usersSource = userListing.status === 'fulfilled' ? userListing.value : null;

  if (!postsSource && !subredditsSource && !usersSource) {
    throw new RedditApiError('Unable to search right now.', 0);
  }

  const posts = (postsSource?.data.children ?? [])
    .filter((item) => item.kind === 't3')
    .map((item) => item.data);
  rememberPosts(posts);

  const subreddits: SearchSubredditResult[] = [];

  for (const item of subredditsSource?.data.children ?? []) {
    const name = item.data.display_name?.trim();

    if (!name) {
      continue;
    }

    const iconCandidate = item.data.community_icon || item.data.icon_img;

    subreddits.push({
      name,
      title: item.data.title?.trim() || `r/${name}`,
      description: item.data.public_description?.trim() || '',
      subscribers: item.data.subscribers ?? 0,
      isNsfw: Boolean(item.data.over18),
      iconUrl: iconCandidate ? normalizeApiUrl(iconCandidate) : undefined,
    });
  }

  const users: SearchUserResult[] = [];

  for (const item of usersSource?.data.children ?? []) {
    const name = item.data.name?.trim();

    if (!name) {
      continue;
    }

    users.push({
      name,
      totalKarma: item.data.total_karma ?? 0,
      iconUrl: item.data.icon_img ? normalizeApiUrl(item.data.icon_img) : undefined,
    });
  }

  return {
    posts,
    subreddits,
    users,
  };
}

function extractComments(listing: RedditListingResponse, parentAuthor?: string): RedditComment[] {
  const comments: RedditComment[] = [];

  for (const child of listing.data.children) {
    if (child.kind !== 't1') {
      continue;
    }

    const payload = child.data as RedditPostData & {
      body?: string;
      replies?: '' | RedditListingResponse;
    };

    if (!payload.body) {
      continue;
    }

    const author = payload.author || '[deleted]';
    const replies =
      payload.replies && typeof payload.replies === 'object'
        ? extractComments(payload.replies, author)
        : [];

    comments.push({
      id: payload.id,
      author,
      body: payload.body,
      parentAuthor,
      replies,
    });
  }

  return comments;
}

export async function fetchPostDetail(
  subredditInput: string,
  postId: string,
): Promise<PostDetailResult> {
  const subreddit = normalizeSubredditName(subredditInput) || 'mildlyinfuriating';
  const cachedPost = getCachedPost(postId);
  const cachedTitle = cachedPost?.title;

  try {
    const response = await fetchReddit<RedditCommentsResponse>(
      `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}.json?raw_json=1`,
      {
        timeoutMs: DETAIL_FETCH_TIMEOUT_MS,
        strategy: 'staggered',
        staggerMs: DETAIL_FETCH_STAGGER_MS,
      },
    );

    const detailPost = response[0]?.data?.children?.[0]?.data;

    if (!detailPost) {
      throw new RedditApiError('Post not found.', 404);
    }

    let post = useRicherPostMedia(detailPost, cachedPost);

    if (needsDetailMediaRecovery(post)) {
      const recoveredPost = await recoverPostFromFallbackSources(
        subreddit,
        postId,
        detailPost.author || cachedPost?.author,
        detailPost.title || cachedTitle,
      );

      post = useRicherPostMedia(post, recoveredPost);
    }

    rememberPosts([post]);

    return {
      post,
      comments: response[1] ? extractComments(response[1]) : [],
    };
  } catch (error) {
    const fallbackPost = cachedPost ?? (await recoverPostFromFallbackSources(subreddit, postId, undefined, cachedTitle));

    if (fallbackPost) {
      rememberPosts([fallbackPost]);
      return {
        post: fallbackPost,
        comments: [],
      };
    }

    throw error;
  }
}


