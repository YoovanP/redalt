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
const DEFAULT_REDDIT_BASES = [
  'https://redalt.pages.dev/api/reddit',
  'https://redalt-vercel.onrender.com/api/reddit',
  DEFAULT_REDDIT_BASE,
];
const REDDIT_BASES = resolveRedditBases(import.meta.env.VITE_REDDIT_API_BASES);
const SESSION_REDDIT_BASE_KEY = 'redalt.redditApiBase';
const PAGE_SIZE = 8;
const REDDIT_BASE_FAILURE_BASE_COOLDOWN_MS = 30 * 1000;
const REDDIT_BASE_FAILURE_MAX_COOLDOWN_MS = 5 * 60 * 1000;

let sessionRedditBase = readSessionRedditBase();
const redditBaseHealth = new Map<string, { failureCount: number; retryAfter: number }>();

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

function resolveRedditBases(rawBases: string | undefined): string[] {
  const configuredBases = (rawBases ?? '')
    .split(',')
    .map((base) => normalizeBase(base))
    .filter((base) => base.length > 0);
  const bases =
    configuredBases.length === 0
      ? DEFAULT_REDDIT_BASES.filter((base) => !isViteDevServer() || base !== DEFAULT_REDDIT_BASE)
      : configuredBases;
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const base of bases) {
    const normalized = normalizeBase(base);
    const key = normalized.toLowerCase();

    if (!normalized || seen.has(key)) {
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

function isConfiguredRedditBase(base: string): boolean {
  const normalized = normalizeBase(base).toLowerCase();
  return REDDIT_BASES.some((candidate) => candidate.toLowerCase() === normalized);
}

function readSessionRedditBase(): string | null {
  if (!canUseSessionStorage()) {
    return null;
  }

  try {
    const storedBase = normalizeBase(window.sessionStorage.getItem(SESSION_REDDIT_BASE_KEY) ?? '');
    return storedBase && isConfiguredRedditBase(storedBase) ? storedBase : null;
  } catch {
    return null;
  }
}

function writeSessionRedditBase(base: string): void {
  const normalized = normalizeBase(base);

  if (!normalized || !isConfiguredRedditBase(normalized)) {
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
  if (sessionRedditBase !== normalizeBase(base)) {
    return;
  }

  sessionRedditBase = null;

  if (!canUseSessionStorage()) {
    return;
  }

  try {
    window.sessionStorage.removeItem(SESSION_REDDIT_BASE_KEY);
  } catch {
    // Nothing else to clear.
  }
}

function markRedditBaseSuccess(base: string): void {
  redditBaseHealth.delete(normalizeBase(base).toLowerCase());
}

function markRedditBaseFailure(base: string): void {
  const key = normalizeBase(base).toLowerCase();
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
  const health = redditBaseHealth.get(normalizeBase(base).toLowerCase());
  return Boolean(health && health.retryAfter > Date.now());
}

function getRedditBaseCandidates(): string[] {
  let candidates: string[];

  if (!sessionRedditBase || !isConfiguredRedditBase(sessionRedditBase)) {
    sessionRedditBase = null;
    candidates = REDDIT_BASES;
  } else {
    candidates = [
      sessionRedditBase,
      ...REDDIT_BASES.filter((base) => base.toLowerCase() !== sessionRedditBase?.toLowerCase()),
    ];
  }

  const activeCandidates = candidates.filter((base) => !isRedditBaseCoolingDown(base));
  return activeCandidates.length > 0 ? activeCandidates : candidates;
}

async function fetchReddit<T>(path: string): Promise<T> {
  let lastError: unknown;
  let lastApiError: RedditApiError | null = null;

  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const base of getRedditBaseCandidates()) {
      try {
        const controller = new AbortController();
        const timeoutId = globalThis.setTimeout(() => controller.abort(), 12000);

        const response = await fetch(`${base}${path}`, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        });

        globalThis.clearTimeout(timeoutId);

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
        lastError = error;

        if (error instanceof RedditApiError) {
          lastApiError = error;

          if (isSourceSwitchableError(error)) {
            markRedditBaseFailure(base);
            clearSessionRedditBase(base);
          }
        } else {
          markRedditBaseFailure(base);
          clearSessionRedditBase(base);
        }

        if (error instanceof RedditApiError) {
          if (error.status === 429) {
            notifyApiStatus('warn', 'Reddit rate limit hit. Retrying...');
          } else if (error.status === 403 || error.status === 451) {
            notifyApiStatus('warn', 'Reddit blocked one proxy. Trying another...');
          } else if (error.status >= 500 || error.status === 0) {
            notifyApiStatus('error', 'Reddit connection issue. Retrying...');
          }
        }

        if (error instanceof RedditApiError && error.status !== 429 && error.status < 500) {
          continue;
        }
      }
    }

    if (lastApiError && !shouldRetryApiError(lastApiError)) {
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
  );

  return {
    posts: data.data.children.map((item) => item.data),
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
  );

  return {
    posts: data.data.children.map((item) => item.data),
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
        subtitle: `r/${post.subreddit} · u/${post.author}`,
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
  const response = await fetchReddit<RedditCommentsResponse>(
    `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}.json?raw_json=1&limit=100`,
  );

  const post = response[0]?.data?.children?.[0]?.data;

  if (!post) {
    throw new RedditApiError('Post not found.', 404);
  }

  return {
    post,
    comments: response[1] ? extractComments(response[1]) : [],
  };
}
