import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StateView } from '../components/StateView';
import { PostActions } from '../components/post/PostActions';
import { PostHeader } from '../components/post/PostHeader';
import { useOpenInNewTab } from '../lib/uiSettings';
import {
  clearSavedPosts,
  clearWatchHistory,
  getSavedPosts,
  getWatchHistory,
  invalidateSavedPostsCache,
  removeSavedPost,
  LIBRARY_UPDATE_EVENT,
  type LibraryItem,
} from '../lib/localLibrary';
import type { NormalizedPost } from '../types/reddit';

type LibraryPageProps = {
  mode: 'saved' | 'history';
};

function formatRecordedAt(item: LibraryItem, mode: 'saved' | 'history'): string {
  const stamp = mode === 'saved' ? item.savedAt : item.viewedAt;

  if (!stamp) {
    return '';
  }

  return new Date(stamp).toLocaleString();
}

function getFallbackPost(item: LibraryItem): NormalizedPost {
  if (item.postPreview) return item.postPreview;

  return {
    id: item.id,
    name: item.name,
    title: item.title,
    author: item.author,
    subreddit: item.subreddit,
    permalink: item.permalink,
    score: item.score,
    numComments: item.numComments,
    createdUtc: item.createdUtc,
    selfText: '',
    isNsfw: item.isNsfw,
    outboundUrl: item.outboundUrl,
    media: { type: 'link', outboundUrl: item.outboundUrl },
  };
}

export function LibraryPage({ mode }: LibraryPageProps) {
  const navigate = useNavigate();
  const openInNewTab = useOpenInNewTab();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(() => {
    setItems(mode === 'saved' ? getSavedPosts() : getWatchHistory());
  }, [mode]);

  useEffect(() => {
    refresh();

    const onStorage = () => {
      invalidateSavedPostsCache();
      refresh();
    };

    const onLibraryUpdate = () => refresh();

    window.addEventListener('storage', onStorage);
    window.addEventListener(LIBRARY_UPDATE_EVENT, onLibraryUpdate);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(LIBRARY_UPDATE_EVENT, onLibraryUpdate);
    };
  }, [refresh]);

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }

    if (mode === 'saved') {
      clearSavedPosts();
    } else {
      clearWatchHistory();
    }

    refresh();
    setConfirmClear(false);
  };

  const title = mode === 'saved' ? 'Saved posts' : 'Watch history';

  return (
    <section className="library-page">
      <div className="library-nav-tabs">
        <Link to="/saved" className={`library-tab${mode === 'saved' ? ' library-tab-active' : ''}`}>
          Saved Posts
        </Link>
        <Link to="/history" className={`library-tab${mode === 'history' ? ' library-tab-active' : ''}`}>
          Viewing History
        </Link>
      </div>

      <div className="library-header">
        <h2>{title} ({items.length})</h2>
        {items.length > 0 && (
          <button type="button" className="load-more" onClick={clearAll} onBlur={() => setConfirmClear(false)}>
            {confirmClear ? `Confirm clear ${items.length}` : 'Clear all'}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <StateView
          kind="empty"
          message={`No ${mode} posts yet.`}
          detail={mode === 'saved' ? 'Save posts from any feed to read them later.' : 'Posts you open will automatically appear in your reading history.'}
          actionLabel="Discover popular posts"
          onAction={() => navigate('/')}
        />
      ) : (
        <div className="library-list">
          {items.map((item) => (
            <article key={item.id} className="library-item">
              <PostHeader post={getFallbackPost(item)} headingLevel={3} showSubreddit openInNewTab={openInNewTab} />
              <p className="library-recorded-at">{mode === 'saved' ? 'Saved' : 'Viewed'}: {formatRecordedAt(item, mode)}</p>

              <PostActions post={getFallbackPost(item)} openInNewTab={openInNewTab} />
              {mode === 'saved' && (
                <div className="library-item-manage">
                  <button
                    type="button"
                    className="post-action-button library-remove-button"
                    onClick={() => {
                      removeSavedPost(item.id);
                      refresh();
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
