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

  useEffect(() => {
    let ignore = false;
    setTrendingLoading(true);

    fetchSubredditListing('popular', { sort: 'hot' })
      .then((result) => {
        if (!ignore) {
          setTrendingPosts(result.posts.slice(0, 6).map(normalizePost));
        }
      })
      .catch(() => {
        if (!ignore) {
          fetchSubredditListing('all', { sort: 'hot' }).then((result) => {
            if (!ignore) {
              setTrendingPosts(result.posts.slice(0, 6).map(normalizePost));
            }
          }).catch(() => {});
        }
      })
      .finally(() => {
        if (!ignore) setTrendingLoading(false);
      });

    return () => { ignore = true; };
  }, []);

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
              {trendingPosts.slice(0, 3).map((post) => (
                <Link
                  key={post.id}
                  to={`/r/${post.subreddit}/comments/${post.id}`}
                  className="home-trending-card"
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
            <Link to="/r/popular" className="home-trending-more">
              Browse more popular posts →
            </Link>
          </>
        ) : (
          <p className="home-trending-empty">Could not load trending posts. Try browsing a community above.</p>
        )}
      </article>
    </section>
  );
}
