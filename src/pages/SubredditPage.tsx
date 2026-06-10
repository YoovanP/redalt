import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LoadMoreButton } from '../components/LoadMoreButton';
import { PostCard } from '../components/PostCard';
import { ShortsFeed } from '../components/ShortsFeed';
import { StateView } from '../components/StateView';
import { getValidatedListingSort, getValidatedTopTimeRange, isMediaPost } from '../lib/feedUtils';
import {
  fetchSubredditListing,
  type FetchListingOptions,
} from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import { useNearEndLoadMore, usePostListingFeed } from '../lib/usePostListingFeed';

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
  const navigate = useNavigate();
  const { name = 'mildlyinfuriating' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = getValidatedListingSort(searchParams.get('sort'));
  const topTimeRange = getValidatedTopTimeRange(searchParams.get('t'));
  const selectedFlair = searchParams.get('flair') ?? 'all';
  const hasRestoredScrollRef = useRef(false);
  const fetchPage = useCallback(
    (options: FetchListingOptions) =>
      fetchSubredditListing(name, {
        ...options,
        sort,
        topTimeRange,
      }),
    [name, sort, topTimeRange],
  );
  const {
    normalizedPosts,
    after,
    loading,
    loadingMore,
    error,
    loadMoreError,
    loadMore,
  } = usePostListingFeed({
    sourceKey: `${name}:${sort}:${topTimeRange}`,
    fetchPage,
    videoFeedMode,
    initialErrorMessage: 'Unable to load subreddit.',
  });

  useEffect(() => {
    hasRestoredScrollRef.current = false;
  }, [name]);

  const postRefs = useRef<Map<string, HTMLElement>>(new Map());
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
  const { nearEndRef, triggerIndex } = useNearEndLoadMore({
    after,
    loadingMore,
    disabled: videoFeedMode,
    itemCount: visiblePosts.length,
    loadMore,
  });

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
          navigate(`/r/${post.subreddit}/comments/${post.id}`, {
            state: { fromSubreddit: post.subreddit, fallbackPost: post },
          });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [videoFeedMode, visiblePosts, focusedPostIndex, navigate]);

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
          <LoadMoreButton loading={loadingMore} onClick={loadMore}>
            Load more
          </LoadMoreButton>
          {loadMoreError && <p className="meta">{loadMoreError}</p>}
        </div>
      )}
    </section>
  );
}
