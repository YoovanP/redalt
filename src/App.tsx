import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CustomFeedBuilder } from './components/CustomFeedBuilder';
import { FeedSettings } from './components/FeedSettings';
import { SubredditSwitcher } from './components/SubredditSwitcher';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { UiSettingsProvider } from './lib/uiSettings';
import { PostDetailPage } from './pages/PostDetailPage';
import { SubredditPage } from './pages/SubredditPage';
import { UserPage } from './pages/UserPage';

function currentSubreddit(pathname: string): string {
  const match = pathname.match(/^\/r\/([^/]+)/i);
  return match?.[1] ?? 'mildlyinfuriating';
}

export default function App() {
  const location = useLocation();
  const subreddit = currentSubreddit(location.pathname);

  return (
    <UiSettingsProvider>
      <div className="app-shell">
        <header className="app-header">
          <div className="header-top">
            <div className="app-brand">
              <h1>RedAlt</h1>
            </div>
            <div className="header-controls">
              <SubredditSwitcher initialSubreddit={subreddit} />
              <ThemeSwitcher />
            </div>
          </div>

          <div className="header-row">
            <FeedSettings />
          </div>

          <div className="header-row">
          <CustomFeedBuilder currentSubreddit={subreddit} />
          </div>
        </header>

        <main>
          <Routes>
            <Route path="/" element={<Navigate to="/r/mildlyinfuriating" replace />} />
            <Route path="/r/:name" element={<SubredditPage />} />
            <Route path="/r/:name/comments/:id" element={<PostDetailPage />} />
            <Route path="/u/:username" element={<UserPage />} />
            <Route path="/user/:username" element={<UserPage />} />
            <Route path="*" element={<Navigate to="/r/mildlyinfuriating" replace />} />
          </Routes>
        </main>
      </div>
    </UiSettingsProvider>
  );
}
