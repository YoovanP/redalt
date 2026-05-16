import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PostCard } from '../components/PostCard';
import { ShortsFeed } from '../components/ShortsFeed';
import { StateView } from '../components/StateView';
import { normalizePost } from '../lib/normalizePost';
import {
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

function getSubredditScrollKey(name: string): string {
  return `redalt.subreddit.scroll.${name}`;
}

function getSubredditRestoreFlagKey(name: string): string {
  return `redalt.subreddit.restore.${name}`;
}

export function SubredditPage() {
  const {
    settings: { columns, videoFeedMode, cardMode },
  } = useUiSettings();
  const { name = 'mildlyinfuriating' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = getValidatedSort(searchParams.get('sort'));
  const topTimeRange = getValidatedTopTimeRange(searchParams.get('t'));
  const selectedFlair = searchParams.get('flair') ?? 'all';
  const [posts, setPosts] = useState<RedditPostData[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const nearEndRef = useRef<HTMLDivElement | null>(null);
  const hasRestoredScrollRef = useRef(false);

  useEffect(() => {
    hasRestoredScrollRef.current = false;
  }, [name]);

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
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

  const postRefs = useRef<Map<string, HTMLElement>>(new Map());
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

    for (const flair of discoveredFlairs) {
      seen.add(flair);
    }

    if (selectedFlair !== 'all') {
      seen.add(selectedFlair);
    }

    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [discoveredFlairs, selectedFlair]);

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

    return flairFilteredPosts.filter((post) => isMediaPost(post.media.type));
  }, [flairFilteredPosts, videoFeedMode]);

  const [focusedPostIndex, setFocusedPostIndex] = useState(-1);

  useEffect(() => {
    if (videoFeedMode) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        return;
      }

      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        setFocusedPostIndex((prev) => {
          if (visiblePosts.length === 0) return -1;
          const delta = event.key === 'j' ? 1 : -1;
          const next = Math.max(0, Math.min(visiblePosts.length - 1, prev + delta));
          const key = visiblePosts[next]?.name;

          if (key) {
            const el = postRefs.current.get(key);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }

          return next;
        });
      }

      if (event.key === 'Enter' && focusedPostIndex >= 0 && focusedPostIndex < visiblePosts.length) {
        const post = visiblePosts[focusedPostIndex];
        if (post) {
          window.location.href = `/r/${post.subreddit}/comments/${post.id}`;
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [videoFeedMode, visiblePosts, focusedPostIndex]);

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

  useEffect(() => {
    if (loading || hasRestoredScrollRef.current) {
      return;
    }

    let shouldRestore = false;
    let nextScrollY = 0;

    try {
      shouldRestore = sessionStorage.getItem(getSubredditRestoreFlagKey(name)) === '1';

      if (shouldRestore) {
        const raw = sessionStorage.getItem(getSubredditScrollKey(name));
        const parsed = raw ? Number(raw) : 0;
        nextScrollY = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      }
    } catch {
      shouldRestore = false;
    }

    if (!shouldRestore) {
      hasRestoredScrollRef.current = true;
      return;
    }

    hasRestoredScrollRef.current = true;

    requestAnimationFrame(() => {
      window.scrollTo({ top: nextScrollY, behavior: 'auto' });
    });

    try {
      sessionStorage.removeItem(getSubredditRestoreFlagKey(name));
    } catch {
      // Ignore storage failures.
    }
  }, [loading, name]);

  const triggerIndex = Math.max(0, visiblePosts.length - 3);

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
        message={videoFeedMode ? 'No media posts found for this subreddit.' : 'This subreddit has no visible posts.'}
      />
    );
  }

  return (
    <section>
      {!videoFeedMode && (
        <>
          <h2>/r/{name}</h2>
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
            <article
              key={post.name}
              ref={(el) => {
                if (el) postRefs.current.set(post.name, el);
                else postRefs.current.delete(post.name);
              }}
              data-focused={focusedPostIndex === index ? 'true' : undefined}
            >
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
