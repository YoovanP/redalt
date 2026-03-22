import { Link } from 'react-router-dom';

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
  return (
    <section className="home-page">
      <div className="home-hero">
        <h2>Welcome to RedAlt</h2>
        <p>Use the top search bar to open a subreddit, search keywords, or paste a Reddit link.</p>
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
