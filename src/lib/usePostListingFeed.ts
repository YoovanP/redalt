import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
): Promise<PostListingResult> {
  let result = await fetchPage({});

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
      result = await fetchPage({ after: requestedCursor });
    } catch {
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
  const loadMoreInFlightRef = useRef(false);

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setPosts([]);
    setAfter(null);

    fetchInitialListingPages(fetchPage, videoFeedMode)
      .then((result) => {
        if (ignore) {
          return;
        }

        setPosts(result.posts);
        setAfter(result.after);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : initialErrorMessage);
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [fetchPage, initialErrorMessage, sourceKey, videoFeedMode]);

  const normalizedPosts = useMemo(() => posts.map(normalizePostCached), [posts]);

  const loadMore = useCallback(async () => {
    if (!after || loadMoreInFlightRef.current) {
      return;
    }

    loadMoreInFlightRef.current = true;
    setLoadMoreError(null);
    setLoadingMore(true);

    try {
      let cursor: string | null = after;
      let nextAfter: string | null = after;
      let attempts = 0;
      const maxAttempts = videoFeedMode ? 4 : 1;
      const collected: RedditPostData[] = [];
      const existingNames = new Set(posts.map((post) => post.name));

      while (cursor && attempts < maxAttempts) {
        const result = await fetchPage({ after: cursor });

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
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : loadMoreErrorMessage);
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [after, fetchPage, loadMoreErrorMessage, posts, videoFeedMode]);

  return {
    posts,
    normalizedPosts,
    after,
    loading,
    loadingMore,
    error,
    loadMoreError,
    loadMore,
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
