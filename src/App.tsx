import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CustomFeedBuilder } from './components/CustomFeedBuilder';
import { FeedSettings } from './components/FeedSettings';
import { SubredditSwitcher } from './components/SubredditSwitcher';
import { UiSettingsProvider, useUiSettings } from './lib/uiSettings';
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
  const {
    settings: { persistentHeader, videoFeedMode },
    updateSettings,
  } = useUiSettings();

  return (
    <div className="app-shell">
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
          <Route path="*" element={<Navigate to="/r/mildlyinfuriating" replace />} />
        </Routes>
      </main>
    </div>
  );
}
