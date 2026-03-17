import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PostCard } from '../components/PostCard';
import { StateView } from '../components/StateView';
import { normalizePost } from '../lib/normalizePost';
import { fetchGlobalSearch } from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import type { RedditPostData } from '../types/reddit';
import type { SearchSubredditResult, SearchUserResult } from '../lib/redditApi';

export function SearchPage() {
  const [searchParams] = useSearchParams();
  const query = (searchParams.get('q') ?? '').trim();
  const {
    settings: { cardMode },
  } = useUiSettings();

  const [posts, setPosts] = useState<RedditPostData[]>([]);
  const [subreddits, setSubreddits] = useState<SearchSubredditResult[]>([]);
  const [users, setUsers] = useState<SearchUserResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    if (query.length < 2) {
      setPosts([]);
      setSubreddits([]);
      setUsers([]);
      setError(null);
      setLoading(false);
      return () => {
        ignore = true;
      };
    }

    setLoading(true);
    setError(null);

    fetchGlobalSearch(query)
      .then((result) => {
        if (ignore) {
          return;
        }

        setPosts(result.posts);
        setSubreddits(result.subreddits);
        setUsers(result.users);
      })
      .catch((err: unknown) => {
        if (ignore) {
          return;
        }

        setError(err instanceof Error ? err.message : 'Unable to search right now.');
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [query]);

  const normalizedPosts = useMemo(() => posts.map(normalizePost), [posts]);
  const hasResults = normalizedPosts.length > 0 || subreddits.length > 0 || users.length > 0;

  if (loading) {
    return <StateView kind="loading" message={`Searching for "${query}"...`} />;
  }

  if (error) {
    return <StateView kind="error" message={error} />;
  }

  if (query.length < 2) {
    return <StateView kind="empty" message="Type at least 2 characters to search posts, subreddits, and users." />;
  }

  if (!hasResults) {
    return <StateView kind="empty" message={`No results found for "${query}".`} />;
  }

  return (
    <section className="search-page">
      <h2>Search results for "{query}"</h2>

      {subreddits.length > 0 && (
        <section className="search-section">
          <h3>Subreddits</h3>
          <div className="search-chip-list">
            {subreddits.map((subreddit) => (
              <Link key={subreddit.name} to={`/r/${subreddit.name}`} className="search-chip-card">
                {subreddit.iconUrl && <img src={subreddit.iconUrl} alt="" loading="lazy" />}
                <div>
                  <strong>r/{subreddit.name}</strong>
                  <p>{subreddit.title}</p>
                  <span>{subreddit.subscribers.toLocaleString()} members{` ${subreddit.isNsfw ? '· NSFW' : ''}`}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {users.length > 0 && (
        <section className="search-section">
          <h3>Users</h3>
          <div className="search-chip-list">
            {users.map((user) => (
              <Link key={user.name} to={`/u/${user.name}`} className="search-chip-card">
                {user.iconUrl && <img src={user.iconUrl} alt="" loading="lazy" />}
                <div>
                  <strong>u/{user.name}</strong>
                  <span>{user.totalKarma.toLocaleString()} karma</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {normalizedPosts.length > 0 && (
        <section className="search-section">
          <h3>Posts</h3>
          <div className="post-list" style={{ '--post-columns': 1 } as CSSProperties}>
            {normalizedPosts.map((post) => (
              <article key={post.name}>
                <PostCard post={post} cardMode={cardMode} />
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
