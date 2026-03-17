import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StateView } from '../components/StateView';
import {
  clearSavedPosts,
  clearWatchHistory,
  getSavedPosts,
  getWatchHistory,
  removeSavedPost,
  type LibraryItem,
} from '../lib/localLibrary';

type LibraryPageProps = {
  mode: 'saved' | 'history';
};

function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

function formatRecordedAt(item: LibraryItem, mode: 'saved' | 'history'): string {
  const stamp = mode === 'saved' ? item.savedAt : item.viewedAt;

  if (!stamp) {
    return '';
  }

  return new Date(stamp).toLocaleString();
}

export function LibraryPage({ mode }: LibraryPageProps) {
  const [items, setItems] = useState<LibraryItem[]>([]);

  const refresh = useCallback(() => {
    setItems(mode === 'saved' ? getSavedPosts() : getWatchHistory());
  }, [mode]);

  useEffect(() => {
    refresh();

    const onStorage = () => {
      refresh();
    };

    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh]);

  const clearAll = () => {
    if (mode === 'saved') {
      clearSavedPosts();
    } else {
      clearWatchHistory();
    }

    refresh();
  };

  const title = mode === 'saved' ? 'Saved posts' : 'Watch history';

  if (items.length === 0) {
    return <StateView kind="empty" message={`No ${mode} posts yet.`} />;
  }

  return (
    <section className="library-page">
      <div className="library-header">
        <h2>{title}</h2>
        <button type="button" className="load-more" onClick={clearAll}>
          Clear all
        </button>
      </div>

      <div className="library-list">
        {items.map((item) => (
          <article key={item.id} className="library-item">
            <h3>
              <Link to={`/r/${item.subreddit}/comments/${item.id}`}>{item.title}</Link>
            </h3>
            <p className="meta">
              <Link to={`/u/${item.author}`}>u/{item.author}</Link> · r/{item.subreddit} · {item.score} points ·{' '}
              {item.numComments} comments · {formatTimestamp(item.createdUtc)}
              {item.isNsfw ? ' · NSFW' : ''}
            </p>
            <p className="meta">{mode === 'saved' ? 'Saved' : 'Viewed'}: {formatRecordedAt(item, mode)}</p>

            <div className="post-actions">
              <Link className="post-action-button" to={`/r/${item.subreddit}/comments/${item.id}`}>
                Open in RedAlt
              </Link>
              <a className="post-action-button" href={`https://www.reddit.com${item.permalink}`} target="_blank" rel="noreferrer">
                Open on Reddit
              </a>
              <a className="post-action-button" href={item.outboundUrl} target="_blank" rel="noreferrer">
                Open source
              </a>
              {mode === 'saved' && (
                <button
                  type="button"
                  className="post-action-button"
                  onClick={() => {
                    removeSavedPost(item.id);
                    refresh();
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
