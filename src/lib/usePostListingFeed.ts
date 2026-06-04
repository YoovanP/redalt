import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizePost } from './normalizePost';
import { isMediaPost } from './feedUtils';
import type { FetchListingOptions } from './redditApi';
import type { PostListingResult, RedditPostData } from '../types/reddit';

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

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setPosts([]);
    setAfter(null);

    fetchPage({})
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
  }, [fetchPage, initialErrorMessage, sourceKey]);

  const normalizedPosts = useMemo(() => posts.map(normalizePost), [posts]);

  const loadMore = useCallback(async () => {
    if (!after || loadingMore) {
      return;
    }

    setLoadMoreError(null);
    setLoadingMore(true);

    try {
      let cursor: string | null = after;
      let nextAfter: string | null = after;
      let attempts = 0;
      const maxAttempts = videoFeedMode ? 4 : 1;
      const collected: RedditPostData[] = [];

      while (cursor && attempts < maxAttempts) {
        const result = await fetchPage({ after: cursor });

        collected.push(...result.posts);
        nextAfter = result.after;
        attempts += 1;

        if (!videoFeedMode || result.posts.some((post) => isMediaPost(normalizePost(post).media.type))) {
          break;
        }

        cursor = result.after;
      }

      if (collected.length > 0) {
        setPosts((previous) => [...previous, ...collected]);
      }

      setAfter(nextAfter);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : loadMoreErrorMessage);
    } finally {
      setLoadingMore(false);
    }
  }, [after, fetchPage, loadMoreErrorMessage, loadingMore, videoFeedMode]);

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
