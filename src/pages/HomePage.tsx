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

export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = query.trim();

    if (!nextQuery) {
      return;
    }

    navigate(`/search?q=${encodeURIComponent(nextQuery)}`);
  };

  return (
    <section className="home-page">
      <div className="home-hero">
        <h2>Welcome to RedAlt</h2>
        <p>Use the top search bar to open a subreddit, search keywords, or paste a Reddit link.</p>
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

      <article className="home-card">
        <h3>Quick Start</h3>
        <div className="home-chip-list">
          <Link to="/r/mildlyinfuriating" className="home-chip">Go to r/mildlyinfuriating</Link>
          <Link to="/search?q=trending" className="home-chip">Search trending</Link>
          <Link to="/saved" className="home-chip">Open saved posts</Link>
          <Link to="/history" className="home-chip">Open watch history</Link>
        </div>
      </article>

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
