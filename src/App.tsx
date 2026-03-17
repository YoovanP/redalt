import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CustomFeedBuilder } from './components/CustomFeedBuilder';
import { FeedSettings } from './components/FeedSettings';
import { SubredditSwitcher } from './components/SubredditSwitcher';
import { UiSettingsProvider, useUiSettings } from './lib/uiSettings';
import { LibraryPage } from './pages/LibraryPage';
import { PostDetailPage } from './pages/PostDetailPage';
import { SearchPage } from './pages/SearchPage';
import { SubredditPage } from './pages/SubredditPage';
import { UserPage } from './pages/UserPage';

function currentSubreddit(pathname: string): string {
  const match = pathname.match(/^\/r\/([^/]+)/i);
  return match?.[1] ?? 'mildlyinfuriating';
}

export default function App() {
  return (
    <UiSettingsProvider>
      <AppLayout />
    </UiSettingsProvider>
  );
}

function AppLayout() {
  const location = useLocation();
  const subreddit = currentSubreddit(location.pathname);
  const [apiStatus, setApiStatus] = useState<{ level: 'warn' | 'error'; message: string } | null>(null);
  const {
    settings: { persistentHeader, videoFeedMode },
    updateSettings,
  } = useUiSettings();

  useEffect(() => {
    const onApiStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ level: 'ok' | 'warn' | 'error'; message: string }>).detail;

      if (!detail) {
        return;
      }

      if (detail.level === 'ok') {
        setApiStatus(null);
        return;
      }

      setApiStatus({
        level: detail.level,
        message: detail.message,
      });
    };

    window.addEventListener('redalt-api-status', onApiStatus);

    return () => {
      window.removeEventListener('redalt-api-status', onApiStatus);
    };
  }, []);

  return (
    <div className="app-shell">
      {apiStatus && (
        <div className={`api-status-banner api-status-${apiStatus.level}`} role="status" aria-live="polite">
          <span>{apiStatus.message}</span>
          <button type="button" onClick={() => setApiStatus(null)}>
            Dismiss
          </button>
        </div>
      )}

      <header
        className={`app-header${persistentHeader ? '' : ' app-header-static'}${
          videoFeedMode ? ' app-header-media-only' : ''
        }`}
      >
        {videoFeedMode ? (
          <label className="media-mode-inline-toggle">
            <input
              type="checkbox"
              checked={videoFeedMode}
              onChange={(event) => updateSettings({ videoFeedMode: event.target.checked })}
            />
            Media feed mode
          </label>
        ) : (
          <>
            <div className="header-top">
              <div className="app-brand">
                <h1>RedAlt</h1>
              </div>
              <div className="header-controls">
                <SubredditSwitcher initialSubreddit={subreddit} />
                <nav className="header-nav-links" aria-label="Quick links">
                  <Link to="/saved">Saved</Link>
                  <Link to="/history">History</Link>
                </nav>
              </div>
            </div>

            <div className="header-row">
              <FeedSettings />
            </div>

            <div className="header-row">
              <CustomFeedBuilder currentSubreddit={subreddit} />
            </div>
          </>
        )}
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/r/mildlyinfuriating" replace />} />
          <Route path="/r/:name" element={<SubredditPage />} />
          <Route path="/r/:name/comments/:id" element={<PostDetailPage />} />
          <Route path="/u/:username" element={<UserPage />} />
          <Route path="/user/:username" element={<UserPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/saved" element={<LibraryPage mode="saved" />} />
          <Route path="/history" element={<LibraryPage mode="history" />} />
          <Route path="*" element={<Navigate to="/r/mildlyinfuriating" replace />} />
        </Routes>
      </main>
    </div>
  );
}
