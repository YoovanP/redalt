import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RedditApiError } from './errors';
import { normalizePost } from './normalizePost';
import { isMediaPost } from './feedUtils';
import type { FetchListingOptions } from './redditApi';
import type { NormalizedPost, PostListingResult, RedditPostData } from '../types/reddit';

type FetchListingPage = (options: FetchListingOptions) => Promise<PostListingResult>;

type UsePostListingFeedOptions = {
  sourceKey: string;
  fetchPage: FetchListingPage;
  videoFeedMode: boolean;
  initialErrorMessage: string;
  loadMoreErrorMessage?: string;
};

type UseNearEndLoadMoreOptions = {
  after: string | null;
  disabled?: boolean;
  itemCount: number;
  loadingMore: boolean;
  loadMore: () => void;
};

const MEDIA_PAGE_SCAN_LIMIT = 4;
const normalizedPostCache = new WeakMap<RedditPostData, NormalizedPost>();

// Feeds persist their last page in session storage so reopening the app (or
// navigating back to a subreddit) renders instantly and refreshes in the
// background instead of showing a skeleton.
const FEED_SNAPSHOT_KEY = 'redalt.feedSnapshot';
const FEED_SNAPSHOT_LIMIT = 12;
const FEED_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type FeedSnapshotEntry = {
  sourceKey: string;
  posts: RedditPostData[];
  after: string | null;
  savedAt: number;
};

function readFeedSnapshot(sourceKey: string): FeedSnapshotEntry | null {
  try {
    const raw = window.sessionStorage.getItem(FEED_SNAPSHOT_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as FeedSnapshotEntry[];
    const entry = Array.isArray(parsed) ? parsed.find((item) => item?.sourceKey === sourceKey) : null;

    if (!entry || !Array.isArray(entry.posts) || Date.now() - entry.savedAt > FEED_SNAPSHOT_MAX_AGE_MS) {
      return null;
    }

    return entry;
  } catch {
    return null;
  }
}

function writeFeedSnapshot(sourceKey: string, posts: RedditPostData[], after: string | null): void {
  try {
    const raw = window.sessionStorage.getItem(FEED_SNAPSHOT_KEY);
    const parsed = JSON.parse(raw ?? '[]') as FeedSnapshotEntry[];
    const rest = (Array.isArray(parsed) ? parsed : [])
      .filter((entry) => entry?.sourceKey && entry.sourceKey !== sourceKey)
      .slice(0, FEED_SNAPSHOT_LIMIT - 1);
    const entry: FeedSnapshotEntry = { sourceKey, posts, after, savedAt: Date.now() };

    window.sessionStorage.setItem(FEED_SNAPSHOT_KEY, JSON.stringify([entry, ...rest]));
  } catch {
    // Snapshotting is best-effort; the live fetch path is unaffected.
  }
}

// One-page lookahead so "load more" feels instant. Keyed by source+cursor and
// kept in memory only; failures (e.g. a WAF block) fall back to a normal
// fetch when the reader actually asks for the page.
const prefetchedPages = new Map<string, PostListingResult>();

function normalizePostCached(post: RedditPostData): NormalizedPost {
  const cached = normalizedPostCache.get(post);
  if (cached) return cached;
  const normalized = normalizePost(post);
  normalizedPostCache.set(post, normalized);
  return normalized;
}

async function fetchInitialListingPages(
  fetchPage: FetchListingPage,
  videoFeedMode: boolean,
  signal?: AbortSignal,
): Promise<PostListingResult> {
  // React Strict Mode performs setup → cleanup → setup synchronously in
  // development. Yielding one microtask lets the discarded setup abort before
  // it can issue a network request, while adding no visible loading delay.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  signal?.throwIfAborted();

  let result = await fetchPage({ signal });

  if (!videoFeedMode || result.posts.some((post) => isMediaPost(normalizePostCached(post).media.type))) {
    return result;
  }

  const posts = [...result.posts];
  const seenNames = new Set(posts.map((post) => post.name));
  let after = result.after;
  let attempts = 1;

  while (after && attempts < MEDIA_PAGE_SCAN_LIMIT) {
    const requestedCursor = after;
    try {
      result = await fetchPage({ after: requestedCursor, signal });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

      break;
    }

    for (const post of result.posts) {
      if (!seenNames.has(post.name)) {
        seenNames.add(post.name);
        posts.push(post);
      }
    }

    after = result.after;
    attempts += 1;

    if (
      result.posts.some((post) => isMediaPost(normalizePostCached(post).media.type)) ||
      after === requestedCursor
    ) {
      break;
    }
  }

  return { posts, after };
}

export function usePostListingFeed({
  sourceKey,
  fetchPage,
  videoFeedMode,
  initialErrorMessage,
  loadMoreErrorMessage = 'Unable to load more posts.',
}: UsePostListingFeedOptions) {
  const [posts, setPosts] = useState<RedditPostData[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loadMoreRetryAt, setLoadMoreRetryAt] = useState<number | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const loadMoreInFlightRef = useRef(false);
  const loadMorePausedRef = useRef(false);
  const lastSourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    const sourceChanged = lastSourceKeyRef.current !== sourceKey;
    lastSourceKeyRef.current = sourceKey;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setLoadMoreRetryAt(null);
    setAfter(null);
    loadMorePausedRef.current = false;

    // A source change starts from the persisted snapshot when one exists so
    // the feed renders instantly; the live fetch below then refreshes it.
    if (sourceChanged) {
      const snapshot = typeof window !== 'undefined' ? readFeedSnapshot(sourceKey) : null;

      setPosts(snapshot?.posts ?? []);
      setAfter(snapshot?.after ?? null);
    }

    fetchInitialListingPages(fetchPage, videoFeedMode, controller.signal)
      .then((result) => {
        if (ignore) {
          return;
        }

        setPosts(result.posts);
        setAfter(result.after);
        writeFeedSnapshot(sourceKey, result.posts, result.after);

        // Look ahead one page so the next "load more" is instant. Deliberately
        // fire-and-forget: failures stay silent and the reader-triggered
        // pagination falls back to a direct fetch.
        if (result.after && !videoFeedMode) {
          const prefetchKey = `${sourceKey}|${result.after}`;

          window.setTimeout(() => {
            if (controller.signal.aborted) {
              return;
            }

            void fetchPage({ after: result.after, signal: controller.signal })
              .then((nextPage) => {
                if (!controller.signal.aborted) {
                  prefetchedPages.set(prefetchKey, nextPage);
                }
              })
              .catch(() => {
                // Prefetch is best-effort.
              });
          }, 2_500);
        }
      })
      .catch((err: unknown) => {
        if (!ignore && !controller.signal.aborted) {
          setError(err instanceof Error ? err.message : initialErrorMessage);
        }
      })
      .finally(() => {
        if (!ignore && !controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [fetchPage, initialErrorMessage, reloadVersion, sourceKey, videoFeedMode]);

  const normalizedPosts = useMemo(() => posts.map(normalizePostCached), [posts]);

  const loadMore = useCallback(async () => {
    if (!after || loadMoreInFlightRef.current || loadMorePausedRef.current) {
      return;
    }

    loadMoreInFlightRef.current = true;
    setLoadMoreError(null);
    setLoadMoreRetryAt(null);
    setLoadingMore(true);

    try {
      let cursor: string | null = after;
      let nextAfter: string | null = after;
      let attempts = 0;
      const maxAttempts = videoFeedMode ? 4 : 1;
      const collected: RedditPostData[] = [];
      const existingNames = new Set(posts.map((post) => post.name));

      while (cursor && attempts < maxAttempts) {
        const prefetchKey = `${sourceKey}|${cursor}`;
        const prefetched = prefetchedPages.get(prefetchKey);
        let result: PostListingResult;

        if (prefetched) {
          prefetchedPages.delete(prefetchKey);
          result = prefetched;
        } else {
          result = await fetchPage({ after: cursor });
        }

        collected.push(...result.posts);
        nextAfter = result.after;
        attempts += 1;

        if (!videoFeedMode || result.posts.some((post) => isMediaPost(normalizePostCached(post).media.type))) {
          break;
        }

        if (!result.after || result.after === cursor) {
          break;
        }

        cursor = result.after;
      }

      const uniqueCollected = collected.filter((post) => {
        if (existingNames.has(post.name)) {
          return false;
        }

        existingNames.add(post.name);
        return true;
      });

      if (uniqueCollected.length > 0) {
        setPosts((previous) => {
          const previousNames = new Set(previous.map((post) => post.name));
          return [
            ...previous,
            ...uniqueCollected.filter((post) => !previousNames.has(post.name)),
          ];
        });
      }

      setAfter(nextAfter === after ? null : nextAfter);
      writeFeedSnapshot(sourceKey, posts.concat(uniqueCollected), nextAfter === after ? null : nextAfter);
    } catch (err) {
      // An observer should not keep replaying a failed page while its trigger is
      // still visible. Only an explicit retry resumes pagination.
      loadMorePausedRef.current = true;
      setLoadMoreError(err instanceof Error ? err.message : loadMoreErrorMessage);
      setLoadMoreRetryAt(
        err instanceof RedditApiError && err.retryAfterSeconds
          ? Date.now() + err.retryAfterSeconds * 1000
          : null,
      );
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [after, fetchPage, loadMoreErrorMessage, posts, videoFeedMode]);

  const retryLoadMore = useCallback(() => {
    if (!after || loadMoreInFlightRef.current || (loadMoreRetryAt !== null && loadMoreRetryAt > Date.now())) {
      return;
    }

    loadMorePausedRef.current = false;
    setLoadMoreError(null);
    setLoadMoreRetryAt(null);
    void loadMore();
  }, [after, loadMore, loadMoreRetryAt]);

  return {
    posts,
    normalizedPosts,
    after,
    loading,
    loadingMore,
    error,
    loadMoreError,
    loadMoreRetryAt,
    loadMore,
    retryLoadMore,
    retry: () => setReloadVersion((version) => version + 1),
  };
}

export function useNearEndLoadMore({
  after,
  disabled = false,
  itemCount,
  loadingMore,
  loadMore,
}: UseNearEndLoadMoreOptions) {
  const nearEndRef = useRef<HTMLDivElement | null>(null);
  const triggerIndex = Math.max(0, itemCount - 3);

  useEffect(() => {
    const target = nearEndRef.current;

    if (!target || !after || loadingMore || disabled) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      {
        root: null,
        threshold: 0.4,
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [after, disabled, itemCount, loadMore, loadingMore]);

  return {
    nearEndRef,
    triggerIndex,
  };
}
