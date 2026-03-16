import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PostCard } from '../components/PostCard';
import { ShortsFeed } from '../components/ShortsFeed';
import { SortControls } from '../components/SortControls';
import { StateView } from '../components/StateView';
import { normalizePost } from '../lib/normalizePost';
import {
  fetchSubredditFlairs,
  fetchSubredditListing,
  type ListingSort,
  type TopTimeRange,
} from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import type { RedditPostData } from '../types/reddit';

function getValidatedSort(input: string | null): ListingSort {
  if (input === 'hot' || input === 'new' || input === 'rising' || input === 'top') {
    return input;
  }

  return 'hot';
}

function getValidatedTopTimeRange(input: string | null): TopTimeRange {
  if (input === 'hour' || input === 'day' || input === 'week' || input === 'month') {
    return input;
  }

  return 'day';
}

export function SubredditPage() {
    const {
      settings: { columns, videoFeedMode },
    } = useUiSettings();
  const { name = 'mildlyinfuriating' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = getValidatedSort(searchParams.get('sort'));
  const topTimeRange = getValidatedTopTimeRange(searchParams.get('t'));
  const selectedFlair = searchParams.get('flair') ?? 'all';
  const [posts, setPosts] = useState<RedditPostData[]>([]);
  const [fetchedFlairs, setFetchedFlairs] = useState<string[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nearEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError(null);
    setPosts([]);
    setAfter(null);

    fetchSubredditListing(name, {
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

        setError(err instanceof Error ? err.message : 'Unable to load subreddit.');
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [name, sort, topTimeRange]);

  useEffect(() => {
    let ignore = false;

    setFetchedFlairs([]);

    fetchSubredditFlairs(name).then((flairs) => {
      if (!ignore) {
        setFetchedFlairs(flairs);
      }
    });

    return () => {
      ignore = true;
    };
  }, [name]);

  const normalizedPosts = useMemo(() => posts.map(normalizePost), [posts]);
  const discoveredFlairs = useMemo(() => {
    const seen = new Set<string>();

    for (const post of normalizedPosts) {
      const flair = post.flairText?.trim();

      if (flair) {
        seen.add(flair);
      }
    }

    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [normalizedPosts]);

  const availableFlairs = useMemo(() => {
    const seen = new Set<string>();

    for (const flair of fetchedFlairs) {
      seen.add(flair);
    }

    for (const flair of discoveredFlairs) {
      seen.add(flair);
    }

    if (selectedFlair !== 'all') {
      seen.add(selectedFlair);
    }

    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [fetchedFlairs, discoveredFlairs, selectedFlair]);

  const flairFilteredPosts = useMemo(() => {
    if (selectedFlair === 'all') {
      return normalizedPosts;
    }

    return normalizedPosts.filter((post) => post.flairText === selectedFlair);
  }, [normalizedPosts, selectedFlair]);

  const visiblePosts = useMemo(() => {
    if (!videoFeedMode) {
      return flairFilteredPosts;
    }

    return flairFilteredPosts.filter(
      (post) => post.media.type === 'video' || post.media.type === 'external',
    );
  }, [flairFilteredPosts, videoFeedMode]);

  const loadMore = async () => {
    if (!after || loadingMore) {
      return;
    }

    setLoadingMore(true);

    try {
      let cursor: string | null = after;
      let nextAfter: string | null = after;
      let attempts = 0;
      const maxAttempts = videoFeedMode ? 4 : 1;
      const collected: RedditPostData[] = [];

      while (cursor && attempts < maxAttempts) {
        const result = await fetchSubredditListing(name, {
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

        const chunkHasVideo = result.posts.some((post) => {
          const mediaType = normalizePost(post).media.type;
          return mediaType === 'video' || mediaType === 'external';
        });

        if (chunkHasVideo) {
          break;
        }

        cursor = result.after;
      }

      if (collected.length > 0) {
        setPosts((previous) => [...previous, ...collected]);
      }

      setAfter(nextAfter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load more posts.');
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

  const onSortChange = (nextSort: ListingSort) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('sort', nextSort);

    if (nextSort !== 'top') {
      nextParams.delete('t');
    } else if (!nextParams.get('t')) {
      nextParams.set('t', 'day');
    }

    setSearchParams(nextParams);
  };

  const onTopTimeRangeChange = (nextRange: TopTimeRange) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('sort', 'top');
    nextParams.set('t', nextRange);
    setSearchParams(nextParams);
  };

  const onFlairChange = (nextFlair: string) => {
    const nextParams = new URLSearchParams(searchParams);

    if (nextFlair === 'all') {
      nextParams.delete('flair');
    } else {
      nextParams.set('flair', nextFlair);
    }

    setSearchParams(nextParams);
  };

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
        message={videoFeedMode ? 'No video posts found for this subreddit.' : 'This subreddit has no visible posts.'}
      />
    );
  }

  return (
    <section>
      <h2>/r/{name}</h2>
      <SortControls
        sort={sort}
        topTimeRange={topTimeRange}
        onSortChange={onSortChange}
        onTopTimeRangeChange={onTopTimeRangeChange}
      />
      <div className="sort-controls" role="group" aria-label="Flair filter">
        <label>
          Flair
          <select value={selectedFlair} onChange={(event) => onFlairChange(event.target.value)}>
            <option value="all">All flairs</option>
            {availableFlairs.map((flair) => (
              <option key={flair} value={flair}>
                {flair}
              </option>
            ))}
          </select>
        </label>
      </div>
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
              <PostCard post={post} />
            </article>
          ))}
        </div>
      )}

      {after && (
        <button className="load-more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
