import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { readCustomFeedSubreddits } from '../lib/customFeed';
import { normalizePost } from '../lib/normalizePost';
import { fetchSubredditListing } from '../lib/redditApi';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { RenderMedia } from '../components/media/RenderMedia';
import type { NormalizedPost } from '../types/reddit';

const QUICK_SUBREDDITS = [
  'mildlyinfuriating',
  'pics',
  'videos',
  'todayilearned',
  'technology',
  'worldnews',
  'funny',
  'AskReddit',
];

function getRecentSubreddits(): string[] {
  return readCustomFeedSubreddits().slice(0, 4);
}

export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [trendingPosts, setTrendingPosts] = useState<NormalizedPost[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(3);
  const [after, setAfter] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentSource, setCurrentSource] = useState<'popular' | 'all'>('popular');

  useEffect(() => {
    let ignore = false;

    async function loadTrendingPosts() {
      setTrendingLoading(true);

      try {
        let result = await fetchSubredditListing('popular', { sort: 'hot' });
        if (!ignore) {
          setCurrentSource('popular');
        }

        if (result.posts.length === 0) {
          result = await fetchSubredditListing('all', { sort: 'hot' });
          if (!ignore) {
            setCurrentSource('all');
          }
        }

        if (!ignore) {
          setTrendingPosts(result.posts.map(normalizePost));
          setAfter(result.after);
        }
      } catch {
        try {
          const result = await fetchSubredditListing('all', { sort: 'hot' });
          if (!ignore) {
            setCurrentSource('all');
            setTrendingPosts(result.posts.map(normalizePost));
            setAfter(result.after);
          }
        } catch {
          if (!ignore) {
            setTrendingPosts([]);
            setAfter(null);
          }
        }
      } finally {
        if (!ignore) {
          setTrendingLoading(false);
        }
      }
    }

    loadTrendingPosts();

    return () => {
      ignore = true;
    };
  }, []);

  const loadMore = async () => {
    if (!after || loadingMore) {
      return;
    }

    setLoadingMore(true);

    try {
      const result = await fetchSubredditListing(currentSource, { sort: 'hot', after });
      setTrendingPosts((prev) => [...prev, ...result.posts.map(normalizePost)]);
      setAfter(result.after);
      setVisibleCount((prev) => prev + 6);
    } catch {
      // Keep existing posts on error
    } finally {
      setLoadingMore(false);
    }
  };

  const handleLoadMore = () => {
    const nextCount = visibleCount + 6;
    if (nextCount > trendingPosts.length && after) {
      loadMore();
    } else {
      setVisibleCount(nextCount);
    }
  };

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
            {QUICK_SUBREDDITS.map((name) => (
              <Link key={name} to={`/r/${name}`} className="home-chip">
                r/{name}
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
        {trendingLoading ? (
          <div className="home-trending-grid">
            <SkeletonLoader kind="post-card" count={3} />
          </div>
        ) : trendingPosts.length > 0 ? (
          <>
            <div className="home-trending-grid">
              {trendingPosts.slice(0, visibleCount).map((post) => (
                <Link
                  key={post.id}
                  to={`/r/${post.subreddit}/comments/${post.id}`}
                  className="home-trending-card"
                  state={{ fallbackPost: post }}
                >
                  <div className="home-trending-media">
                    {post.media.type !== 'text' && post.media.type !== 'link' ? (
                      <RenderMedia post={post} mode="shorts" />
                    ) : (
                      <div className="home-trending-placeholder">
                        <span className="home-trending-placeholder-icon">📄</span>
                      </div>
                    )}
                  </div>
                  <div className="home-trending-info">
                    <h4>{post.title}</h4>
                    <p className="home-trending-meta">
                      r/{post.subreddit} · {post.score} points
                    </p>
                  </div>
                </Link>
              ))}
            </div>
            <div className="home-trending-actions" style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
              {(visibleCount < trendingPosts.length || after) && (
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
