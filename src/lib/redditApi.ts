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
// The browser should have one clear request boundary. Deployments can explicitly opt into
// additional owned API origins with VITE_REDDIT_API_BASES, but public proxy hopping must not
// be the default user journey.
const DEFAULT_REDDIT_BASES = [DEFAULT_REDDIT_BASE];
const REDDIT_BASES = resolveRedditBases(import.meta.env.VITE_REDDIT_API_BASES);
const SESSION_REDDIT_BASE_KEY = 'redalt.redditApiBase';
const UI_SETTINGS_KEY = 'redalt.uiSettings';

type RedditApiSourcePreference = 'auto' | 'same-origin';

const REDDIT_API_SOURCE_BASES: Record<Exclude<RedditApiSourcePreference, 'auto'>, string> = {
  'same-origin': DEFAULT_REDDIT_BASE,
};

const PAGE_SIZE = 8;
const REDDIT_BASE_FAILURE_BASE_COOLDOWN_MS = 30 * 1000;
const REDDIT_BASE_FAILURE_MAX_COOLDOWN_MS = 5 * 60 * 1000;
const POST_CACHE_KEY = 'redalt.postCache';
const POST_CACHE_LIMIT = 120;
const POST_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const LISTING_FETCH_TIMEOUT_MS = 8_000;
const LISTING_REQUEST_TIMEOUT_MS = 12_000;
const DETAIL_FETCH_TIMEOUT_MS = 10_000;
const DETAIL_REQUEST_TIMEOUT_MS = 15_000;
const DETAIL_FETCH_STAGGER_MS = 400;
const DETAIL_RECOVERY_TIMEOUT_MS = 6_000;
const DETAIL_RECOVERY_REQUEST_TIMEOUT_MS = 9_000;
const DETAIL_FALLBACK_PAGE_SIZE = 40;
const MAX_CLIENT_BASE_CANDIDATES = 2;
const MAX_DETAIL_RECOVERY_ATTEMPTS = 2;

let sessionRedditBase = readSessionRedditBase();
const redditBaseHealth = new Map<string, { failureCount: number; retryAfter: number; rateLimited: boolean }>();
const postCache = readSessionPostCache();

// Search fans out into three upstream requests per call. Remember recent
// results in session storage so toggling filters or revisiting a previous
// query does not re-press the upstream source (and the per-IP request budget).
const SEARCH_CACHE_KEY = 'redalt.searchCache';
const SEARCH_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const SEARCH_CACHE_LIMIT = 20;
const searchCache = new Map<string, { savedAt: number; result: GlobalSearchResult }>();

function readSessionSearchCache(): Map<string, { savedAt: number; result: GlobalSearchResult }> {
  const cache = new Map<string, { savedAt: number; result: GlobalSearchResult }>();

  if (!canUseSessionStorage()) {
    return cache;
  }

  try {
    const raw = window.sessionStorage.getItem(SEARCH_CACHE_KEY);

    if (!raw) {
      return cache;
    }

    const parsed = JSON.parse(raw) as Array<{ key?: unknown; savedAt?: unknown; result?: GlobalSearchResult }>;
    const now = Date.now();

    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const key = typeof entry?.key === 'string' ? entry.key : '';
      const savedAt = typeof entry?.savedAt === 'number' ? entry.savedAt : 0;

      if (!key || !entry?.result || now - savedAt > SEARCH_CACHE_MAX_AGE_MS) {
        continue;
      }

      cache.set(key, { savedAt, result: entry.result });
    }
  } catch {
    return new Map<string, { savedAt: number; result: GlobalSearchResult }>();
  }

  return cache;
}

function writeSessionSearchCache(): void {
  if (!canUseSessionStorage()) {
    return;
  }

  try {
    const entries = Array.from(searchCache.entries())
      .sort((left, right) => right[1].savedAt - left[1].savedAt)
      .slice(0, SEARCH_CACHE_LIMIT)
      .map(([key, entry]) => ({ key, savedAt: entry.savedAt, result: entry.result }));

    window.sessionStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(entries));
  } catch {
    // Keep using the in-memory cache when storage is unavailable.
  }
}

function getCachedSearchResult(key: string): GlobalSearchResult | null {
  ensureSearchCacheInitialized();

  const entry = searchCache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.savedAt > SEARCH_CACHE_MAX_AGE_MS) {
    searchCache.delete(key);
    writeSessionSearchCache();
    return null;
  }

  return entry.result;
}

function rememberSearchResult(key: string, result: GlobalSearchResult): void {
  ensureSearchCacheInitialized();

  searchCache.set(key, { savedAt: Date.now(), result });

  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldestKey = searchCache.keys().next().value;

    if (typeof oldestKey !== 'string') {
      break;
    }

    searchCache.delete(oldestKey);
  }

  writeSessionSearchCache();
}

// Populated lazily on first use so SSR-less module init stays cheap.
let searchCacheInitialized = false;

function ensureSearchCacheInitialized(): void {
  if (searchCacheInitialized) {
    return;
  }

  searchCacheInitialized = true;

  for (const [key, entry] of readSessionSearchCache()) {
    searchCache.set(key, entry);
  }
}

function normalizeBase(base: string): string {
  const trimmed = base.trim();

  if (!trimmed) {
    return '';
  }

  return trimmed.replace(/\/+$/g, '');
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

function shouldAvoidPersistingRedditBase(): boolean {
  return getRedditApiSourcePref() !== 'auto';
}

function getDefaultRedditBases(): string[] {
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
  signal?: AbortSignal;
};

type CachedPostEntry = {
  savedAt: number;
  post: RedditPostData;
};

type ApiStatusDetail = {
  level: 'ok' | 'warn' | 'error';
  message: string;
  retryAt?: number;
};

function formatRetryAfter(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function notifyApiStatus(level: ApiStatusDetail['level'], message: string, retryAfterSeconds?: number): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent('redalt-api-status', {
      detail: {
        level,
        message,
        retryAt: retryAfterSeconds ? Date.now() + retryAfterSeconds * 1000 : undefined,
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

function hostMatches(hostname: string, expectedHost: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.+$/g, '');
  const normalizedExpectedHost = expectedHost.trim().toLowerCase().replace(/^\.+|\.+$/g, '');

  return Boolean(
    normalizedHostname &&
      normalizedExpectedHost &&
      (normalizedHostname === normalizedExpectedHost || normalizedHostname.endsWith(`.${normalizedExpectedHost}`)),
  );
}

function isRedditMediaHost(hostname: string): boolean {
  return (
    hostname === 'i.redd.it' ||
    hostname === 'preview.redd.it' ||
    hostname === 'v.redd.it' ||
    hostMatches(hostname, 'redd.it') ||
    hostMatches(hostname, 'redditmedia.com') ||
    hostMatches(hostname, 'reddit.com')
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

    return hostname === 'v.redd.it' || (hostMatches(hostname, 'reddit.com') && /^\/video\/[^/?#]+/i.test(parsed.pathname));
  } catch {
    return (
      /https?:\/\/v\.redd\.it\//i.test(url) ||
      /https?:\/\/(?:[^./?#]+\.)*reddit\.com\/video\//i.test(url)
    );
  }
}

function hasNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

function isUsableHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function hasUsableMediaSource(value: unknown): boolean {
  if (!hasNonEmptyObject(value)) {
    return false;
  }

  return ['url', 'u', 'mp4', 'gif', 'hlsUrl', 'dashUrl', 'hls_url', 'dash_url'].some((key) =>
    isUsableHttpUrl(value[key]),
  );
}

function hasPreviewImagesDirect(post: RedditPostData): boolean {
  const images = Array.isArray(post.preview?.images) ? post.preview.images : [];
  return Boolean(
    images.some((image) =>
      hasUsableMediaSource(image.source) ||
      Object.values(image.variants ?? {}).some((variant) => hasUsableMediaSource(variant?.source)),
    ),
  );
}

function hasRedditVideoSource(value: unknown): boolean {
  if (!hasNonEmptyObject(value)) {
    return false;
  }

  return [value.fallback_url, value.hls_url, value.dash_url].some(isUsableHttpUrl);
}

function hasPreviewVideoDirect(post: RedditPostData): boolean {
  return hasRedditVideoSource(post.preview?.reddit_video_preview);
}

function hasRenderablePreviewDirect(post: RedditPostData): boolean {
  return hasPreviewImagesDirect(post) || hasPreviewVideoDirect(post);
}

const POST_MEDIA_TREE_MAX_DEPTH = 3;
const POST_MEDIA_TREE_MAX_ITEMS = 4;

function somePostMediaTree(
  post: RedditPostData,
  predicate: (candidate: RedditPostData) => boolean,
  depth = 0,
  seen = new Set<RedditPostData>(),
): boolean {
  if (depth > POST_MEDIA_TREE_MAX_DEPTH || seen.has(post)) {
    return false;
  }

  seen.add(post);

  if (predicate(post)) {
    return true;
  }

  if (depth === POST_MEDIA_TREE_MAX_DEPTH || !Array.isArray(post.crosspost_parent_list)) {
    return false;
  }

  return post.crosspost_parent_list
    .slice(0, POST_MEDIA_TREE_MAX_ITEMS)
    .some((crosspost) => crosspost && somePostMediaTree(crosspost, predicate, depth + 1, seen));
}

function hasPreviewImages(post: RedditPostData): boolean {
  return somePostMediaTree(post, hasPreviewImagesDirect);
}

function getPostOutboundUrl(post: RedditPostData | null | undefined): string {
  return post ? post.url_overridden_by_dest ?? post.url ?? '' : '';
}

function hasPlayableVideoMediaDirect(post: RedditPostData): boolean {
  const outboundUrl = getPostOutboundUrl(post);

  return Boolean(
    hasRedditVideoSource(post.secure_media?.reddit_video) ||
      hasRedditVideoSource(post.media?.reddit_video) ||
      hasPreviewVideoDirect(post) ||
      isKnownRedditHostedVideoUrl(outboundUrl) ||
      /\.(?:mp4|webm|mov|m4v|ogv|gifv|m3u8)(?:$|[?#])/i.test(outboundUrl),
  );
}

function hasPlayableVideoMedia(post: RedditPostData | null | undefined): boolean {
  return Boolean(post && somePostMediaTree(post, hasPlayableVideoMediaDirect));
}

function hasRenderableEmbedDirect(post: RedditPostData): boolean {
  return Boolean(
    post.secure_media?.oembed?.html ||
      post.media?.oembed?.html ||
      post.secure_media_embed?.content ||
      post.media_embed?.content,
  );
}

function hasRenderableEmbed(post: RedditPostData | null | undefined): boolean {
  return Boolean(post && somePostMediaTree(post, hasRenderableEmbedDirect));
}

function hasGalleryMediaDirect(post: RedditPostData): boolean {
  if (!Array.isArray(post.gallery_data?.items) || post.gallery_data.items.length === 0 || !hasNonEmptyObject(post.media_metadata)) {
    return false;
  }

  return post.gallery_data.items.some((item) => {
    const metadata = post.media_metadata?.[item.media_id] as Record<string, unknown> | undefined;

    return Boolean(
      metadata &&
        (hasUsableMediaSource(metadata) ||
          hasUsableMediaSource(metadata.s) ||
          (Array.isArray(metadata.p) && metadata.p.some(hasUsableMediaSource))),
    );
  });
}

function hasGalleryMedia(post: RedditPostData | null | undefined): boolean {
  return Boolean(post && somePostMediaTree(post, hasGalleryMediaDirect));
}

function hasRenderableExternalOutboundDirect(post: RedditPostData): boolean {
  const outboundUrl = getPostOutboundUrl(post);
  const hostname = getUrlHostname(outboundUrl);

  return Boolean(
    outboundUrl && !isRedditMediaHost(hostname) && !isCommentPermalinkUrl(outboundUrl, post.id),
  );
}

function hasRenderableExternalOutbound(post: RedditPostData | null | undefined): boolean {
  return Boolean(post && somePostMediaTree(post, hasRenderableExternalOutboundDirect));
}

function hasRenderableImageDirect(post: RedditPostData): boolean {
  const outboundUrl = getPostOutboundUrl(post);
  const hasImageOutbound = /\.(?:png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(outboundUrl);

  return Boolean(
    hasPreviewImagesDirect(post) ||
      hasImageOutbound ||
      (isUsableHttpUrl(post.thumbnail) && !['default', 'self', 'nsfw', 'spoiler', 'image'].includes(post.thumbnail.toLowerCase())),
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

  if (post.is_self || hasRenderableExternalOutbound(post)) {
    return false;
  }

  const explicitlyMedia = Boolean(
      post.is_video ||
      post.is_gallery ||
      post.post_hint === 'gallery' ||
      post.post_hint === 'hosted:video' ||
      post.post_hint === 'image' ||
      post.post_hint === 'rich:video',
  );

  return explicitlyMedia && (getRawPostMediaStrength(post) < 3 || isPreviewOnlyPlaceholderDetail(post));
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

  const hasExternalOutbound = hasRenderableExternalOutbound(post);
  const hasVideo = hasPlayableVideoMedia(post);
  const hasEmbed = hasRenderableEmbed(post);
  const hasGallery = hasGalleryMedia(post);
  const hasImage = somePostMediaTree(post, hasRenderableImageDirect);

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
    return 3;
  }

  return post.is_self || (post.selftext ?? '').trim() ? 1 : 0;
}

function mergePostMediaFields(detailPost: RedditPostData, mediaPost: RedditPostData): RedditPostData {
  const mediaPostHasGallery = hasGalleryMediaDirect(mediaPost);
  const mediaPostHasPreview = hasRenderablePreviewDirect(mediaPost);

  return {
    ...detailPost,
    link_flair_text: detailPost.link_flair_text ?? mediaPost.link_flair_text,
    url: mediaPost.url || detailPost.url,
    url_overridden_by_dest: mediaPost.url_overridden_by_dest ?? detailPost.url_overridden_by_dest,
    domain: mediaPost.domain || detailPost.domain,
    thumbnail: isUsableHttpUrl(mediaPost.thumbnail) ? mediaPost.thumbnail : detailPost.thumbnail,
    preview: mediaPostHasPreview ? mediaPost.preview : detailPost.preview,
    gallery_data: mediaPostHasGallery ? mediaPost.gallery_data : detailPost.gallery_data,
    media_metadata: mediaPostHasGallery ? mediaPost.media_metadata : detailPost.media_metadata,
    media: hasRenderableEmbedDirect(mediaPost) || hasRedditVideoSource(mediaPost.media?.reddit_video)
      ? mediaPost.media
      : detailPost.media,
    secure_media: hasRedditVideoSource(mediaPost.secure_media?.reddit_video) || Boolean(mediaPost.secure_media?.oembed?.html)
      ? mediaPost.secure_media
      : detailPost.secure_media,
    media_embed: mediaPost.media_embed?.content ? mediaPost.media_embed : detailPost.media_embed,
    secure_media_embed: mediaPost.secure_media_embed?.content ? mediaPost.secure_media_embed : detailPost.secure_media_embed,
    crosspost_parent_list: mediaPost.crosspost_parent_list?.length
      ? mediaPost.crosspost_parent_list
      : detailPost.crosspost_parent_list,
    is_self: typeof mediaPost.is_self === 'boolean' ? mediaPost.is_self : detailPost.is_self,
    is_gallery: mediaPostHasGallery ? true : detailPost.is_gallery,
    is_video: mediaPost.is_video ?? detailPost.is_video,
    post_hint: mediaPost.post_hint ?? detailPost.post_hint,
  };
}

export function mergePostCandidates(
  primary: RedditPostData,
  candidates: Array<RedditPostData | null | undefined>,
): RedditPostData {
  return candidates.reduce<RedditPostData>((current, candidate) => {
    if (!candidate || candidate.id !== current.id) {
      return current;
    }

    if (candidateImprovesMedia(current, candidate)) {
      return mergePostMediaFields(current, candidate);
    }

    if ((candidate.num_comments ?? 0) > (current.num_comments ?? 0) || (candidate.score ?? 0) > (current.score ?? 0)) {
      return mergePostMediaFields(candidate, current);
    }

    return current;
  }, primary);
}

function chooseBetterCachedPost(current: RedditPostData, candidate: RedditPostData): RedditPostData {
  const currentStrength = getRawPostMediaStrength(current);
  const candidateStrength = getRawPostMediaStrength(candidate);

  if (candidateStrength < currentStrength) {
    return current;
  }

  return mergePostCandidates(current, [candidate]);
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
  return mergePostCandidates(detailPost, [candidate]);
}

async function fetchListingFallback(
  subreddit: string,
  sort: ListingSort,
  postId: string,
  topTimeRange: TopTimeRange = 'day',
  signal?: AbortSignal,
): Promise<RedditPostData | null> {
  const queryParts = ['raw_json=1', 'limit=' + DETAIL_FALLBACK_PAGE_SIZE];

  if (sort === 'top') {
    queryParts.push('t=' + encodeURIComponent(topTimeRange));
  }

  const listing = await fetchReddit<RedditListingResponse>(
    '/r/' + encodeURIComponent(subreddit) + '/' + sort + '.json?' + queryParts.join('&'),
    {
      timeoutMs: DETAIL_RECOVERY_TIMEOUT_MS,
      requestTimeoutMs: DETAIL_RECOVERY_REQUEST_TIMEOUT_MS,
      signal,
    },
  );
  const posts = listing.data.children.filter((item) => item.kind === 't3').map((item) => item.data);
  rememberPosts(posts);

  return posts.find((post) => post.id === postId) ?? null;
}

async function fetchUserFallback(author: string, postId: string, signal?: AbortSignal): Promise<RedditPostData | null> {
  const cleanedAuthor = normalizeUserName(author);

  if (!cleanedAuthor || cleanedAuthor === '[deleted]' || cleanedAuthor === '[unknown]') {
    return null;
  }

  const listing = await fetchReddit<RedditListingResponse>(
    '/user/' + encodeURIComponent(cleanedAuthor) + '/submitted.json?raw_json=1&limit=' + DETAIL_FALLBACK_PAGE_SIZE + '&sort=new',
    {
      timeoutMs: DETAIL_RECOVERY_TIMEOUT_MS,
      requestTimeoutMs: DETAIL_RECOVERY_REQUEST_TIMEOUT_MS,
      signal,
    },
  );
  const posts = listing.data.children.filter((item) => item.kind === 't3').map((item) => item.data);
  rememberPosts(posts);

  return posts.find((post) => post.id === postId) ?? null;
}

async function fetchSearchFallback(
  subreddit: string,
  title: string,
  postId: string,
  signal?: AbortSignal,
): Promise<RedditPostData | null> {
  const query = title.trim();

  if (!query) {
    return null;
  }

  const listing = await fetchReddit<RedditListingResponse>(
    '/r/' + encodeURIComponent(subreddit) + '/search.json?raw_json=1&restrict_sr=1&sort=relevance&limit=10&q=' + encodeURIComponent(query),
    {
      timeoutMs: DETAIL_RECOVERY_TIMEOUT_MS,
      requestTimeoutMs: DETAIL_RECOVERY_REQUEST_TIMEOUT_MS,
      signal,
    },
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
  signal?: AbortSignal,
): Promise<RedditPostData | null> {
  const attempts = [
    title ? () => fetchSearchFallback(subreddit, title, postId, signal) : null,
    () => fetchListingFallback(subreddit, 'new', postId, 'day', signal),
    () => fetchUserFallback(author ?? '', postId, signal),
    () => fetchListingFallback(subreddit, 'hot', postId, 'day', signal),
    () => fetchListingFallback(subreddit, 'top', postId, 'week', signal),
  ].filter((attempt): attempt is () => Promise<RedditPostData | null> => Boolean(attempt));

  // Detail enrichment is a repair path, not a second feed loader. Run a small
  // bounded sequence so opening a post never creates a five-request burst.
  for (const attempt of attempts.slice(0, MAX_DETAIL_RECOVERY_ATTEMPTS)) {
    signal?.throwIfAborted();

    try {
      const post = await attempt();

      if (post) {
        return post;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw error;
      }
    }
  }

  return null;
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

    if (!storedBase || !isConfiguredRedditBase(storedBase) || shouldAvoidPersistingRedditBase()) {
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

  if (!normalized || !isConfiguredRedditBase(normalized) || shouldAvoidPersistingRedditBase()) {
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

function markRedditBaseFailure(base: string, retryAfterSeconds?: number, rateLimited = false): void {
  const key = resolveBaseKey(base);
  const previous = redditBaseHealth.get(key);
  const failureCount = Math.min((previous?.failureCount ?? 0) + 1, 5);
  const exponentialCooldown = Math.min(
    REDDIT_BASE_FAILURE_BASE_COOLDOWN_MS * 2 ** (failureCount - 1),
    REDDIT_BASE_FAILURE_MAX_COOLDOWN_MS,
  );
  // When Reddit tells us exactly when the next request is allowed, honor that
  // window rather than replacing it with our generic failure backoff.
  const cooldown = retryAfterSeconds ? retryAfterSeconds * 1000 : exponentialCooldown;

  redditBaseHealth.set(key, {
    failureCount,
    retryAfter: Date.now() + cooldown,
    rateLimited,
  });
}

function isRedditBaseCoolingDown(base: string): boolean {
  const health = redditBaseHealth.get(resolveBaseKey(base));
  return Boolean(health && health.retryAfter > Date.now());
}

function getSoonestRedditBaseRetryAfterSeconds(): number | undefined {
  let soonestRetryAfter = Number.POSITIVE_INFINITY;
  const now = Date.now();

  for (const base of REDDIT_BASES) {
    const retryAfter = redditBaseHealth.get(resolveBaseKey(base))?.retryAfter;

    if (retryAfter && retryAfter > now) {
      soonestRetryAfter = Math.min(soonestRetryAfter, retryAfter);
    }
  }

  return Number.isFinite(soonestRetryAfter) ? Math.max(1, Math.ceil((soonestRetryAfter - now) / 1000)) : undefined;
}

function getRedditBaseCandidates(): string[] {
  let candidates: string[];
  const selectedBase = getSelectedRedditBase();

  if (selectedBase) {
    const selectedKey = resolveBaseKey(selectedBase);
    sessionRedditBase = null;
    candidates = [
      selectedBase,
      ...REDDIT_BASES.filter((base) => resolveBaseKey(base) !== selectedKey),
    ];
  } else if (!sessionRedditBase || !isConfiguredRedditBase(sessionRedditBase) || shouldAvoidPersistingRedditBase()) {
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

  if (activeCandidates.length > 0) {
    return activeCandidates.slice(0, MAX_CLIENT_BASE_CANDIDATES);
  }

  // Back off only when Reddit explicitly rate-limits us. A generic 5xx or
  // network failure is still worth a reader-triggered retry, especially when
  // there is only one same-origin gateway.
  return candidates
    .filter((base) => !redditBaseHealth.get(resolveBaseKey(base))?.rateLimited)
    .slice(0, MAX_CLIENT_BASE_CANDIDATES);
}

function getRedditApiSourcePref(): RedditApiSourcePreference {
  if (typeof window === 'undefined') {
    return 'auto';
  }

  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY);

    if (!raw) {
      return 'auto';
    }

    const parsed = JSON.parse(raw) as { redditApiSource?: unknown };

    if (
      parsed.redditApiSource === 'same-origin'
    ) {
      return parsed.redditApiSource;
    }

    return 'auto';
  } catch {
    return 'auto';
  }
}

function getSelectedRedditBase(): string | null {
  const source = getRedditApiSourcePref();

  if (source === 'auto') {
    return null;
  }

  return normalizeBase(REDDIT_API_SOURCE_BASES[source]);
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
  requestTimeoutMs?: number;
  strategy?: FetchRedditStrategy;
  staggerMs?: number;
  signal?: AbortSignal;
};

type FetchFailureStatusMode = 'retrying' | 'failed' | 'silent';

function notifyRetryableFetchFailure(error: RedditApiError, mode: Exclude<FetchFailureStatusMode, 'silent'>): void {
  if (error.status === 429) {
    const wait = error.retryAfterSeconds ? ` Try again in ${formatRetryAfter(error.retryAfterSeconds)}.` : '';
    notifyApiStatus(
      'warn',
      mode === 'retrying'
        ? `Reddit rate limit hit. Trying another configured source.${wait}`
        : `Reddit is rate-limiting requests right now.${wait}`,
      error.retryAfterSeconds,
    );
  } else if (error.status === 403 || error.status === 451) {
    notifyApiStatus(
      'warn',
      mode === 'retrying'
        ? 'That Reddit source is unavailable. Trying the next configured source...'
        : 'The selected Reddit source is unavailable. Please retry in a moment.',
    );
  } else if (error.status >= 500 || error.status === 0) {
    notifyApiStatus(
      'error',
      mode === 'retrying' ? 'Reddit connection issue. Retrying...' : 'Reddit connection issue. Please retry.',
    );
  }
}

function handleFetchRedditFailure(
  base: string,
  error: unknown,
  statusMode: FetchFailureStatusMode = 'retrying',
): RedditApiError | null {
  if (error instanceof RedditApiError) {
    if (isSourceSwitchableError(error)) {
      markRedditBaseFailure(base, error.retryAfterSeconds, error.status === 429);
      clearSessionRedditBase(base);
    }

    if (statusMode !== 'silent') {
      notifyRetryableFetchFailure(error, statusMode);
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
      throw await readApiError(response);
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

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function fetchRedditSequential<T>(requestPath: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  let lastApiError: RedditApiError | null = null;
  const bases = getRedditBaseCandidates();

  if (bases.length === 0) {
    const retryAfterSeconds = getSoonestRedditBaseRetryAfterSeconds();
    const error = new RedditApiError(
      retryAfterSeconds
        ? `Reddit asked this source to wait ${formatRetryAfter(retryAfterSeconds)} before another request.`
        : 'Reddit is temporarily cooling down. Please try again shortly.',
      429,
      retryAfterSeconds,
    );
    notifyRetryableFetchFailure(error, 'failed');
    throw error;
  }

  for (const base of bases) {
    signal?.throwIfAborted();

    try {
      return await fetchRedditFromBase<T>(base, requestPath, timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw error;
      }

      lastError = error;
      const apiError = handleFetchRedditFailure(base, error);

      if (apiError) {
        lastApiError = apiError;

        // A malformed route or a genuine 404 will not be repaired by making
        // the user wait for another server. Only availability failures move on.
        if (!isSourceSwitchableError(apiError)) {
          break;
        }
      }
    }
  }

  if (lastApiError) {
    notifyRetryableFetchFailure(lastApiError, 'failed');
    throw lastApiError;
  }

  if (lastError instanceof RedditApiError) {
    notifyRetryableFetchFailure(lastError, 'failed');
    throw lastError;
  }

  notifyApiStatus('error', 'Network error while contacting Reddit.');

  throw new RedditApiError('Network error while contacting Reddit.', 0);
}

async function fetchRedditStaggered<T>(
  requestPath: string,
  timeoutMs: number,
  staggerMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const bases = getRedditBaseCandidates();

  if (bases.length <= 1) {
    return fetchRedditSequential<T>(requestPath, timeoutMs, signal);
  }

  let lastError: unknown;
  let lastApiError: RedditApiError | null = null;
  let completed = 0;
  let settled = false;
  const controllers = bases.map(() => new AbortController());

  return new Promise<T>((resolve, reject) => {
    const abortAll = () => controllers.forEach((controller) => controller.abort());
    const onAbort = () => {
      if (settled) return;
      settled = true;
      abortAll();
      reject(signal?.reason ?? new DOMException('Request aborted.', 'AbortError'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    const rejectIfDone = () => {
      if (settled || completed < bases.length) {
        return;
      }

      if (lastApiError) {
        notifyRetryableFetchFailure(lastApiError, 'failed');
        reject(lastApiError);
        return;
      }

      if (lastError instanceof RedditApiError) {
        notifyRetryableFetchFailure(lastError, 'failed');
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
          signal?.removeEventListener('abort', onAbort);
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

          if (signal?.aborted || isAbortError(error)) {
            return;
          }

          lastError = error;
          const apiError = handleFetchRedditFailure(base, error, 'silent');

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
  const requestTimeoutMs = options.requestTimeoutMs ?? timeoutMs;
  const deadlineController = new AbortController();
  let requestTimedOut = false;
  const onParentAbort = () => deadlineController.abort(options.signal?.reason);

  if (options.signal?.aborted) {
    deadlineController.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener('abort', onParentAbort, { once: true });
  }

  const deadlineId = globalThis.setTimeout(() => {
    requestTimedOut = true;
    deadlineController.abort(new DOMException('Request timed out.', 'AbortError'));
  }, requestTimeoutMs);

  try {
    if (strategy === 'staggered') {
      return await fetchRedditStaggered<T>(
        requestPath,
        timeoutMs,
        options.staggerMs ?? 0,
        deadlineController.signal,
      );
    }

    return await fetchRedditSequential<T>(requestPath, timeoutMs, deadlineController.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }

    if (requestTimedOut) {
      throw new RedditApiError('This request took too long. Please try again.', 504);
    }

    throw error;
  } finally {
    globalThis.clearTimeout(deadlineId);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

function normalizeRetryAfterSeconds(value: unknown): number | undefined {
  const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;

  return Number.isFinite(numericValue) && numericValue >= 0 ? Math.max(1, Math.ceil(numericValue)) : undefined;
}

function readRetryAfterSeconds(response: Response): number | undefined {
  const rawValue = response.headers.get('Retry-After')?.trim();

  if (!rawValue) {
    return undefined;
  }

  const numericRetryAfter = normalizeRetryAfterSeconds(rawValue);

  if (numericRetryAfter) {
    return numericRetryAfter;
  }

  const retryAt = Date.parse(rawValue);

  return Number.isFinite(retryAt) ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) : undefined;
}

async function readApiError(response: Response): Promise<RedditApiError> {
  const fallback = getApiErrorMessage(response.status);
  const contentType = response.headers.get('Content-Type') ?? '';
  let message = fallback;
  let bodyRetryAfterSeconds: number | undefined;

  if (contentType.toLowerCase().includes('application/json')) {
    try {
      const payload = (await response.clone().json()) as { message?: unknown; retryAfterSeconds?: unknown };
      message = typeof payload.message === 'string' && payload.message.trim() ? payload.message : fallback;
      bodyRetryAfterSeconds = normalizeRetryAfterSeconds(payload.retryAfterSeconds);
    } catch {
      // Preserve the status-derived error when a proxy returns invalid JSON.
    }
  }

  return new RedditApiError(message, response.status, readRetryAfterSeconds(response) ?? bodyRetryAfterSeconds);
}

function getListingAfter(listing: RedditListingResponse): string | null {
  if (listing.data.after) {
    return listing.data.after;
  }

  if (listing.data.children.length < PAGE_SIZE) {
    return null;
  }

  const lastPostName = [...listing.data.children]
    .reverse()
    .find((child) => child.kind === 't3' && child.data?.name)?.data.name;

  return lastPostName || null;
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
    {
      timeoutMs: LISTING_FETCH_TIMEOUT_MS,
      requestTimeoutMs: LISTING_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    },
  );
  const posts = data.data.children.map((item) => item.data);
  rememberPosts(posts);


  return {
    posts,
    after: getListingAfter(data),
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
    {
      timeoutMs: LISTING_FETCH_TIMEOUT_MS,
      requestTimeoutMs: LISTING_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    },
  );
  const posts = data.data.children.map((item) => item.data);
  rememberPosts(posts);


  return {
    posts,
    after: getListingAfter(data),
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
    // The broader subreddit search below remains available when typeahead fails.
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

  const [subredditTypeahead, userListing, postListing] = await Promise.allSettled([
    fetchReddit<SubredditTypeaheadResponse>(
      `/api/search_reddit_names.json?raw_json=1&include_over_18=1&include_unadvertisable=1&query=${encodeURIComponent(cleaned)}`,
    ),
    fetchReddit<UserSearchResponse>(
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

  if (cleaned.length < 2) {
    return {
      posts: [],
      subreddits: [],
      users: [],
    };
  }

  // Searching fans out into three upstream requests. Remember recent results
  // in the session so going back to a previous query/filter combination is
  // instant and does not re-press the upstream source.
  const searchCacheKey = `search:${cleaned.toLowerCase()}|${sort}|${topTimeRange}|${subredditScope.toLowerCase()}|${includeNsfw}|${postLimit}|${subredditLimit}|${userLimit}`;
  const cachedSearch = getCachedSearchResult(searchCacheKey);

  if (cachedSearch) {
    return cachedSearch;
  }

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

  const [postListing, subredditListing, userListing] = await Promise.allSettled([
    fetchReddit<RedditListingResponse>(`${postSearchPath}&${postQueryParts.join('&')}`),
    fetchReddit<SubredditSearchResponse>(
      `/subreddits/search.json?${[...communityQueryParts, `limit=${subredditLimit}`].join('&')}`,
    ),
    fetchReddit<UserSearchResponse>(
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

  const result = {
    posts,
    subreddits,
    users,
  };
  rememberSearchResult(searchCacheKey, result);

  return result;
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

export type FetchPostDetailOptions = {
  signal?: AbortSignal;
};

export async function fetchPostDetail(
  subredditInput: string,
  postId: string,
  options: FetchPostDetailOptions = {},
): Promise<PostDetailResult> {
  const subreddit = normalizeSubredditName(subredditInput) || 'mildlyinfuriating';
  const cachedPost = getCachedPost(postId);

  try {
    const response = await fetchReddit<RedditCommentsResponse>(
      `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}.json?raw_json=1`,
      {
        timeoutMs: DETAIL_FETCH_TIMEOUT_MS,
        requestTimeoutMs: DETAIL_REQUEST_TIMEOUT_MS,
        strategy: 'staggered',
        staggerMs: DETAIL_FETCH_STAGGER_MS,
        signal: options.signal,
      },
    );

    const detailPost = response[0]?.data?.children?.[0]?.data;

    if (!detailPost) {
      throw new RedditApiError('Post not found.', 404);
    }

    const post = useRicherPostMedia(detailPost, cachedPost);

    rememberPosts([post]);

    const comments = response[1] ? extractComments(response[1]) : [];
    const commentsUnavailable = !response[1] || (post.num_comments > 0 && comments.length === 0);

    return {
      post,
      comments,
      commentsStatus: commentsUnavailable ? 'unavailable' : comments.length > 0 ? 'loaded' : 'empty',
      mediaStatus: needsDetailMediaRecovery(post) ? 'incomplete' : 'ready',
    };
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      throw error;
    }

    const fallbackPost = cachedPost;

    if (fallbackPost) {
      rememberPosts([fallbackPost]);
      return {
        post: fallbackPost,
        comments: [],
        commentsStatus: 'unavailable',
        mediaStatus: needsDetailMediaRecovery(fallbackPost) ? 'incomplete' : 'ready',
      };
    }

    throw error;
  }
}

export async function fetchPostMediaEnrichment(
  post: RedditPostData,
  options: FetchPostDetailOptions = {},
): Promise<RedditPostData> {
  if (!needsDetailMediaRecovery(post)) {
    return post;
  }

  const recovered = await recoverPostFromFallbackSources(
    post.subreddit,
    post.id,
    post.author,
    post.title,
    options.signal,
  );
  const merged = mergePostCandidates(post, [recovered]);
  rememberPosts([merged]);
  return merged;
}
