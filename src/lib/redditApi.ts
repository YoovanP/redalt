import { getApiErrorMessage, RedditApiError } from './errors';
import type {
  PostDetailResult,
  PostListingResult,
  RedditComment,
  RedditCommentsResponse,
  RedditListingResponse,
  RedditPostData,
} from '../types/reddit';

const REDDIT_BASES = ['/api/reddit', 'https://www.reddit.com'];
const PAGE_SIZE = 8;

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
        subscribers?: number;
      };
    }>;
  };
};

type FetchListingOptions = {
  after?: string | null;
  sort?: ListingSort;
  topTimeRange?: TopTimeRange;
};

function normalizeSubredditName(input: string): string {
  return input.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
}

function normalizeUserName(input: string): string {
  return input.trim().replace(/^\/?u(?:ser)?\//i, '').replace(/^\/+|\/+$/g, '');
}

async function fetchReddit<T>(path: string): Promise<T> {
  let lastError: unknown;

  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const base of REDDIT_BASES) {
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
          throw new RedditApiError(getApiErrorMessage(response.status), response.status);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error;

        if (error instanceof RedditApiError && error.status !== 429 && error.status < 500) {
          continue;
        }
      }
    }

    if (cycle === 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
    }
  }

  if (lastError instanceof RedditApiError) {
    throw lastError;
  }

  throw new RedditApiError('Network error while contacting Reddit.', 0);
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
  const cleanedLower = cleaned.toLowerCase();

  if (cleaned.length < 2) {
    return [];
  }

  try {
    const response = await fetchReddit<SubredditSearchResponse>(
      `/subreddits/search.json?raw_json=1&limit=25&q=${encodeURIComponent(cleaned)}`,
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
