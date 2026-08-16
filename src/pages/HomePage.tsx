import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { readCustomFeedSubreddits } from '../lib/customFeed';
import { normalizePost } from '../lib/normalizePost';
import { fetchSubredditListing } from '../lib/redditApi';
import { RedditApiError } from '../lib/errors';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { LoadMoreRecovery } from '../components/LoadMoreButton';
import { StateView } from '../components/StateView';
import { PostHeader } from '../components/post/PostHeader';
import { PostThumbnail } from '../components/post/PostThumbnail';
import { useUiSettings } from '../lib/uiSettings';
import { useNearEndLoadMore } from '../lib/usePostListingFeed';
import type { NormalizedPost } from '../types/reddit';

const QUICK_SUBREDDITS = [
  { name: 'mildlyinfuriating', icon: '⚡' },
  { name: 'pics', icon: '📸' },
  { name: 'videos', icon: '🎬' },
  { name: 'todayilearned', icon: '💡' },
  { name: 'technology', icon: '💻' },
  { name: 'worldnews', icon: '🌐' },
  { name: 'funny', icon: '🎭' },
  { name: 'AskReddit', icon: '💬' },
];

function getRecentSubreddits(): string[] {
  return readCustomFeedSubreddits().slice(0, 4);
}

export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [trendingPosts, setTrendingPosts] = useState<NormalizedPost[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [trendingError, setTrendingError] = useState<string | null>(null);
  const [trendingRetryVersion, setTrendingRetryVersion] = useState(0);
  const [visibleCount, setVisibleCount] = useState(3);
  const [after, setAfter] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [trendingLoadMoreError, setTrendingLoadMoreError] = useState<string | null>(null);
  const [trendingLoadMoreRetryAt, setTrendingLoadMoreRetryAt] = useState<number | null>(null);
  const [currentSource, setCurrentSource] = useState<'popular' | 'all'>('popular');
  const loadMorePausedRef = useRef(false);

  const {
    settings: { loadMoreMode, fallbackMediaSource, redditApiSource },
  } = useUiSettings();

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();

    async function loadTrendingPosts() {
      setTrendingLoading(true);
      setTrendingError(null);
      setTrendingLoadMoreError(null);
      setTrendingLoadMoreRetryAt(null);
      loadMorePausedRef.current = false;

      try {
        let result = await fetchSubredditListing('popular', { sort: 'hot', signal: controller.signal });
        if (!ignore) {
          setCurrentSource('popular');
        }

        if (result.posts.length === 0) {
          result = await fetchSubredditListing('all', { sort: 'hot', signal: controller.signal });
          if (!ignore) {
            setCurrentSource('all');
          }
        }

        if (!ignore) {
          setTrendingPosts(result.posts.map(normalizePost));
          setAfter(result.after);
        }
      } catch (error) {
        if (!ignore && !controller.signal.aborted) {
          // Keep a previously loaded page visible instead of replacing it
          // with a full-screen error when a refresh fails.
          setTrendingError(error instanceof Error ? error.message : 'Unable to load trending posts.');
        }
      } finally {
        if (!ignore && !controller.signal.aborted) {
          setTrendingLoading(false);
        }
      }
    }

    loadTrendingPosts();

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [fallbackMediaSource, redditApiSource, trendingRetryVersion]);

  const loadMore = async () => {
    if (!after || loadingMore || loadMorePausedRef.current) {
      return;
    }

    setTrendingLoadMoreError(null);
    setTrendingLoadMoreRetryAt(null);
    setLoadingMore(true);

    try {
      const result = await fetchSubredditListing(currentSource, { sort: 'hot', after });
      setTrendingPosts((prev) => [...prev, ...result.posts.map(normalizePost)]);
      setAfter(result.after);
      setVisibleCount((prev) => prev + 6);
    } catch (error) {
      // Keep the useful first page visible and let the reader decide when to
      // retry instead of silently hammering the same pagination cursor.
      loadMorePausedRef.current = true;
      setTrendingLoadMoreError(error instanceof Error ? error.message : 'Unable to load more trending posts.');
      setTrendingLoadMoreRetryAt(
        error instanceof RedditApiError && error.retryAfterSeconds
          ? Date.now() + error.retryAfterSeconds * 1000
          : null,
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const retryLoadMore = () => {
    if (!after || loadingMore || (trendingLoadMoreRetryAt !== null && trendingLoadMoreRetryAt > Date.now())) {
      return;
    }

    loadMorePausedRef.current = false;
    setTrendingLoadMoreError(null);
    setTrendingLoadMoreRetryAt(null);
    void loadMore();
  };

  const handleLoadMore = () => {
    const nextCount = visibleCount + 6;
    if (nextCount > trendingPosts.length && after) {
      if (trendingLoadMoreError) {
        retryLoadMore();
      } else {
        void loadMore();
      }
    } else {
      setVisibleCount(nextCount);
    }
  };

  const { nearEndRef, triggerIndex } = useNearEndLoadMore({
    after: (after || visibleCount < trendingPosts.length) ? 'has-more' : null,
    loadingMore,
    disabled: loadMoreMode === 'button' || Boolean(trendingLoadMoreError),
    itemCount: Math.min(visibleCount, trendingPosts.length),
    loadMore: handleLoadMore,
  });

  const recentSubreddits = useMemo(() => getRecentSubreddits(), []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = query.trim();
    if (!nextQuery) return;
    navigate(`/search?q=${encodeURIComponent(nextQuery)}`);
  };

  return (
    <section className="home-page">
      <div className="home-hero">
        <h2>Welcome to RedAlt</h2>
        <p>A modern, minimal Reddit client. Search for communities, browse trending posts, or dive into your saved content.</p>
        <form className="home-search-form" onSubmit={onSubmit}>
          <input
            className="home-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search posts, communities, users..."
            aria-label="Search RedAlt"
          />
          <button type="submit" className="home-search-submit">
            Search
          </button>
        </form>
      </div>

      <div className="home-grid">
        <article className="home-card">
          <h3>Popular Communities</h3>
          <div className="home-chip-list">
            {QUICK_SUBREDDITS.map((item) => (
              <Link key={item.name} to={`/r/${item.name}`} className="home-chip">
                <span className="home-chip-icon">{item.icon}</span>
                <span>r/{item.name}</span>
              </Link>
            ))}
          </div>
        </article>

        <article className="home-card">
          <h3>Your Library</h3>
          <div className="home-chip-list">
            <Link to="/saved" className="home-chip">
              <span className="home-chip-icon">★</span> Saved posts
            </Link>
            <Link to="/history" className="home-chip">
              <span className="home-chip-icon">◷</span> Watch history
            </Link>
            <Link to="/search?q=trending" className="home-chip">
              <span className="home-chip-icon">▸</span> Search trending
            </Link>
          </div>
          {recentSubreddits.length > 0 && (
            <div className="home-recent-subreddits">
              <p className="home-recent-label">Recently visited:</p>
              <div className="home-chip-list">
                {recentSubreddits.map((name) => (
                  <Link key={name} to={`/r/${name}`} className="home-chip home-chip-sm">
                    r/{name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </article>
      </div>

      <article className="home-card home-trending">
        <h3>Trending on Reddit</h3>
        {trendingLoading && trendingPosts.length === 0 ? (
          <div className="home-trending-grid">
            <SkeletonLoader kind="post-card" count={3} />
          </div>
        ) : trendingError && trendingPosts.length === 0 ? (
          <StateView
            kind="error"
            message="Trending posts are temporarily unavailable."
            detail={trendingError}
            actionLabel="Try again"
            onAction={() => setTrendingRetryVersion((version) => version + 1)}
            alternateActionLabel="Open popular on Reddit"
            alternateActionHref="https://www.reddit.com/r/popular/"
          />
        ) : trendingPosts.length > 0 ? (
          <>
            {trendingError && (
              <div className="feed-refresh-error" role="alert">
                <span>Could not refresh trending posts: {trendingError}</span>
                <button
                  type="button"
                  className="state-action state-action-primary"
                  onClick={() => setTrendingRetryVersion((version) => version + 1)}
                >
                  Try again
                </button>
              </div>
            )}
            <div className="home-trending-grid">
              {trendingPosts.slice(0, visibleCount).map((post, index) => (
                <article
                  key={post.id}
                  className="home-trending-card"
                >
                  {index === triggerIndex && (after || visibleCount < trendingPosts.length) && (
                    <div ref={nearEndRef} className="near-end-trigger" />
                  )}
                  <div className="home-trending-media">
                    <PostThumbnail post={post} />
                  </div>
                  <div className="home-trending-info">
                    <PostHeader post={post} headingLevel={4} showSubreddit />
                  </div>
                </article>
              ))}
            </div>
            <div className="home-trending-actions" style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
              {trendingLoadMoreError ? (
                <LoadMoreRecovery
                  message={trendingLoadMoreError}
                  loading={loadingMore}
                  onRetry={retryLoadMore}
                  retryAt={trendingLoadMoreRetryAt}
                />
              ) : (visibleCount < trendingPosts.length || after) && (
                <button
                  type="button"
                  className="home-search-submit"
                  style={{ margin: 0, padding: '0.5rem 1.5rem', height: 'auto' }}
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                >
                  {loadingMore ? 'Loading...' : 'Load more posts'}
                </button>
              )}
              <Link to="/r/popular" className="home-trending-more" style={{ margin: 0 }}>
                Browse more popular posts →
              </Link>
            </div>
          </>
        ) : (
          <p className="home-trending-empty">Could not load trending posts. Try browsing a community above.</p>
        )}
      </article>
    </section>
  );
}
