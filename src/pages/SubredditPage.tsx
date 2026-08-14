import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LoadMoreButton, LoadMoreRecovery } from '../components/LoadMoreButton';
import { SortControls } from '../components/SortControls';
import { PostCard } from '../components/PostCard';
import { ShortsFeed } from '../components/ShortsFeed';
import { StateView } from '../components/StateView';
import { readStorageItem, removeStorageItem } from '../lib/browserStorage';
import { getValidatedListingSort, getValidatedTopTimeRange, isMediaPost } from '../lib/feedUtils';
import {
  fetchSubredditListing,
  type FetchListingOptions,
  type ListingSort,
  type TopTimeRange,
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
    settings: { columns, videoFeedMode, cardMode, loadMoreMode, fallbackMediaSource, redditApiSource },
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

  const {
    normalizedPosts,
    after,
    loading,
    loadingMore,
    error,
    loadMoreError,
    loadMoreRetryAt,
    loadMore,
    retryLoadMore,
    retry,
  } = usePostListingFeed({
    sourceKey: `${name}:${sort}:${topTimeRange}:${fallbackMediaSource}:${redditApiSource}`,
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
    disabled: videoFeedMode || loadMoreMode === 'button' || Boolean(loadMoreError),
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

    shouldRestore = readStorageItem('session', getSubredditRestoreFlagKey(name)) === '1';

    if (shouldRestore) {
      const raw = readStorageItem('session', getSubredditScrollKey(name));
      const parsed = raw ? Number(raw) : 0;
      nextScrollY = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    if (!shouldRestore) {
      hasRestoredScrollRef.current = true;
      return;
    }

    hasRestoredScrollRef.current = true;

    requestAnimationFrame(() => {
      window.scrollTo({ top: nextScrollY, behavior: 'auto' });
    });

    removeStorageItem('session', getSubredditRestoreFlagKey(name));
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

  if (loading && normalizedPosts.length === 0) {
    return <StateView kind="loading" />;
  }

  if (error && normalizedPosts.length === 0) {
    return (
      <StateView
        kind="error"
        message="Posts are temporarily unavailable."
        detail={error}
        actionLabel="Try again"
        onAction={retry}
        alternateActionLabel="Open on Reddit"
        alternateActionHref={`https://www.reddit.com/r/${encodeURIComponent(name)}/`}
      />
    );
  }

  const showRefreshError = Boolean(error) && normalizedPosts.length > 0;

  if (visiblePosts.length === 0) {
    return (
      <section>
        <StateView
          kind="empty"
          message={
            videoFeedMode
              ? 'No media posts found in the pages checked for this subreddit.'
              : selectedFlair !== 'all'
                ? `No loaded posts use the “${selectedFlair}” flair.`
                : 'This subreddit has no visible posts.'
          }
        />
        {after && (
          <div>
            {loadMoreError ? (
              <LoadMoreRecovery message={loadMoreError} loading={loadingMore} onRetry={retryLoadMore} retryAt={loadMoreRetryAt} />
            ) : (
              <LoadMoreButton loading={loadingMore} onClick={loadMore}>
                Check more posts
              </LoadMoreButton>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section>
      {showRefreshError && (
        <div className="feed-refresh-error" role="alert">
          <span>Could not refresh posts: {error}</span>
          <button type="button" className="state-action state-action-primary" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {!videoFeedMode && (
        <>
          <h2>/r/{name}</h2>
          <div className="feed-toolbar">
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
          </div>
        </>
      )}
      {videoFeedMode ? (
        <ShortsFeed
          posts={visiblePosts}
          hasMore={Boolean(after)}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          loadMoreRetryAt={loadMoreRetryAt}
          onNearEnd={loadMore}
          onRetryLoadMore={retryLoadMore}
        />
      ) : (
        <div className="post-list" style={{ '--post-columns': columns } as CSSProperties}>
          {visiblePosts.map((post, index) => (
            <div
              key={post.name}
              ref={(el) => {
                if (el) postRefs.current.set(post.name, el);
                else postRefs.current.delete(post.name);
              }}
              data-focused={focusedPostIndex === index ? 'true' : undefined}
            >
              {index === triggerIndex && after && <div ref={nearEndRef} className="near-end-trigger" />}
              <PostCard post={post} cardMode={cardMode} />
            </div>
          ))}
        </div>
      )}

      {after && !videoFeedMode && (
        <div>
          {loadMoreError ? (
            <LoadMoreRecovery message={loadMoreError} loading={loadingMore} onRetry={retryLoadMore} retryAt={loadMoreRetryAt} />
          ) : (
            <LoadMoreButton loading={loadingMore} onClick={loadMore}>
              Load more
            </LoadMoreButton>
          )}
        </div>
      )}
    </section>
  );
}
