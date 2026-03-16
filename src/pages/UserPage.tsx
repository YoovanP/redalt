import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PostCard } from '../components/PostCard';
import { ShortsFeed } from '../components/ShortsFeed';
import { StateView } from '../components/StateView';
import { normalizePost } from '../lib/normalizePost';
import { fetchUserListing, type ListingSort, type TopTimeRange } from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import type { RedditPostData } from '../types/reddit';

function getValidatedSort(input: string | null): ListingSort {
  if (input === 'hot' || input === 'new' || input === 'rising' || input === 'top') {
    return input;
  }

  return 'hot';
}

function getValidatedTopTimeRange(input: string | null): TopTimeRange {
  if (
    input === 'hour' ||
    input === 'day' ||
    input === 'week' ||
    input === 'month' ||
    input === 'year' ||
    input === 'all'
  ) {
    return input;
  }

  return 'day';
}

function isMediaPost(mediaType: string): boolean {
  return mediaType === 'image' || mediaType === 'gallery' || mediaType === 'video' || mediaType === 'external';
}

export function UserPage() {
  const {
    settings: { columns, videoFeedMode, cardMode },
  } = useUiSettings();
  const { username = '' } = useParams();
  const [searchParams] = useSearchParams();
  const sort = getValidatedSort(searchParams.get('sort'));
  const topTimeRange = getValidatedTopTimeRange(searchParams.get('t'));
  const [posts, setPosts] = useState<RedditPostData[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const nearEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setPosts([]);
    setAfter(null);

    fetchUserListing(username, {
      sort,
      topTimeRange,
    })
      .then((result) => {
        if (ignore) {
          return;
        }

        setPosts(result.posts);
        setAfter(result.after);
      })
      .catch((err: unknown) => {
        if (ignore) {
          return;
        }

        setError(err instanceof Error ? err.message : 'Unable to load user feed.');
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [username, sort, topTimeRange]);

  const normalizedPosts = useMemo(() => posts.map(normalizePost), [posts]);

  const visiblePosts = useMemo(() => {
    if (!videoFeedMode) {
      return normalizedPosts;
    }

    return normalizedPosts.filter((post) => isMediaPost(post.media.type));
  }, [normalizedPosts, videoFeedMode]);

  const loadMore = async () => {
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
        const result = await fetchUserListing(username, {
          after: cursor,
          sort,
          topTimeRange,
        });

        collected.push(...result.posts);
        nextAfter = result.after;
        attempts += 1;

        if (!videoFeedMode) {
          break;
        }

        const chunkHasMedia = result.posts.some((post) => {
          const mediaType = normalizePost(post).media.type;
          return isMediaPost(mediaType);
        });

        if (chunkHasMedia) {
          break;
        }

        cursor = result.after;
      }

      if (collected.length > 0) {
        setPosts((previous) => [...previous, ...collected]);
      }

      setAfter(nextAfter);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : 'Unable to load more posts.');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const target = nearEndRef.current;

    if (!target || !after || loadingMore || videoFeedMode) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void loadMore();
            break;
          }
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
  }, [after, loadingMore, videoFeedMode, visiblePosts.length]);

  const triggerIndex = Math.max(0, visiblePosts.length - 3);

  if (loading) {
    return <StateView kind="loading" />;
  }

  if (error) {
    return <StateView kind="error" message={error} />;
  }

  if (visiblePosts.length === 0) {
    return (
      <StateView
        kind="empty"
        message={videoFeedMode ? 'No media posts found for this user.' : 'This user has no visible posts.'}
      />
    );
  }

  return (
    <section>
      {!videoFeedMode && (
        <>
          <h2>/u/{username}</h2>
        </>
      )}

      {videoFeedMode ? (
        <ShortsFeed
          posts={visiblePosts}
          hasMore={Boolean(after)}
          loadingMore={loadingMore}
          onNearEnd={loadMore}
        />
      ) : (
        <div className="post-list" style={{ '--post-columns': columns } as CSSProperties}>
          {visiblePosts.map((post, index) => (
            <article key={post.name}>
              {index === triggerIndex && after && <div ref={nearEndRef} className="near-end-trigger" />}
              <PostCard post={post} cardMode={cardMode} />
            </article>
          ))}
        </div>
      )}

      {after && !videoFeedMode && (
        <div>
          <button className="load-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
          {loadMoreError && <p className="meta">{loadMoreError}</p>}
        </div>
      )}
    </section>
  );
}
