import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

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

function sanitizeSubreddit(input: string): string {
  return input.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';
}

export function HomePage() {
  const navigate = useNavigate();
  const [subreddit, setSubreddit] = useState('');
  const [query, setQuery] = useState('');

  const onSubredditSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = sanitizeSubreddit(subreddit);

    if (!cleaned) {
      return;
    }

    navigate(`/r/${cleaned}`);
  };

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = query.trim();

    if (!cleaned) {
      return;
    }

    navigate(`/search?q=${encodeURIComponent(cleaned)}`);
  };

  return (
    <section className="home-page">
      <div className="home-hero">
        <h2>Welcome to RedAlt</h2>
        <p>Browse Reddit your way: media-first feed, custom filters, saved posts, and watch history.</p>
      </div>

      <div className="home-grid">
        <article className="home-card">
          <h3>Jump to Subreddit</h3>
          <form className="home-form" onSubmit={onSubredditSubmit}>
            <input
              value={subreddit}
              onChange={(event) => setSubreddit(event.target.value)}
              placeholder="r/mildlyinfuriating"
              aria-label="Subreddit name"
            />
            <button type="submit">Open</button>
          </form>
        </article>

        <article className="home-card">
          <h3>Search Reddit</h3>
          <form className="home-form" onSubmit={onSearchSubmit}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search posts, communities, users"
              aria-label="Search query"
            />
            <button type="submit">Search</button>
          </form>
        </article>
      </div>

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
          <Link to="/saved" className="home-chip">Saved posts</Link>
          <Link to="/history" className="home-chip">Watch history</Link>
        </div>
      </article>
    </section>
  );
}
