import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CustomFeedBuilder } from './components/CustomFeedBuilder';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SubredditSwitcher } from './components/SubredditSwitcher';
import { readStorageItem, writeStorageItem } from './lib/browserStorage';
import { UiSettingsProvider, useUiSettings } from './lib/uiSettings';
import { HomePage } from './pages/HomePage';
import { LibraryPage } from './pages/LibraryPage';
import { PostDetailPage } from './pages/PostDetailPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { SubredditPage } from './pages/SubredditPage';
import { UserPage } from './pages/UserPage';

function currentSubreddit(pathname: string): string {
  const match = pathname.match(/^\/r\/([^/]+)/i);
  return match?.[1] ?? '';
}

function formatRetryCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

type GatewayStatusInfo = {
  state: 'official' | 'anon' | 'scrape' | 'degraded';
  label: string;
  detail: string;
};

async function fetchGatewayStatusInfo(): Promise<GatewayStatusInfo | null> {
  try {
    const response = await fetch('/api/status', { headers: { Accept: 'application/json' } });

    if (!response.ok) {
      return null;
    }

    const status = (await response.json()) as {
      status?: string;
      oauth?: { configured?: boolean; mode?: string };
      fallbacks?: { publicInstances?: boolean };
    };

    if (status.oauth?.mode === 'anon-client') {
      return {
        state: 'anon',
        label: 'Anonymous API',
        detail: 'Using a shared client id via the anonymous installed-app grant. Not sanctioned by Reddit and may stop working if the credential is rotated.',
      };
    }

    if (status.oauth?.configured) {
      return {
        state: 'official',
        label: 'Official API',
        detail: 'Connected to Reddit through the official OAuth API.',
      };
    }

    if (status.fallbacks?.publicInstances) {
      return {
        state: 'scrape',
        label: 'Mirror mode',
        detail: 'No OAuth credentials configured. Posts come from community mirrors via the bounded scrape path.',
      };
    }

    return {
      state: 'scrape',
      label: 'Reader mode',
      detail: 'No OAuth credentials configured. Posts come from the bounded old.reddit scrape path.',
    };
  } catch {
    return null;
  }
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
  const [apiStatus, setApiStatus] = useState<{ level: 'warn' | 'error'; message: string; retryAt?: number } | null>(null);
  const [statusNow, setStatusNow] = useState(() => Date.now());
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatusInfo | null>(null);
  const [headerExpanded, setHeaderExpanded] = useState(() => {
    const raw = readStorageItem('local', 'redalt.headerExpanded');
    return raw === null ? true : raw === 'true';
  });
  const {
    settings: { persistentHeader, videoFeedMode },
    updateSettings,
  } = useUiSettings();

  useEffect(() => {
    writeStorageItem('local', 'redalt.headerExpanded', String(headerExpanded));
  }, [headerExpanded]);

  useEffect(() => {
    let ignore = false;

    const load = () => {
      void fetchGatewayStatusInfo().then((info) => {
        if (!ignore && info) {
          setGatewayStatus(info);
        }
      });
    };

    load();
    const intervalId = window.setInterval(load, 5 * 60 * 1000);
    window.addEventListener('focus', load);

    return () => {
      ignore = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', load);
    };
  }, []);

  useEffect(() => {
    const onApiStatus = (event: Event) => {
      const detail = (event as CustomEvent<{
        level: 'ok' | 'warn' | 'error';
        message: string;
        retryAt?: number;
      }>).detail;

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
        retryAt: typeof detail.retryAt === 'number' && detail.retryAt > Date.now() ? detail.retryAt : undefined,
      });
    };

    window.addEventListener('redalt-api-status', onApiStatus);

    return () => {
      window.removeEventListener('redalt-api-status', onApiStatus);
    };
  }, []);

  useEffect(() => {
    const retryAt = apiStatus?.retryAt;

    if (!retryAt) {
      return;
    }

    const tick = () => {
      const now = Date.now();
      setStatusNow(now);

      if (now >= retryAt) {
        setApiStatus((current) =>
          current?.retryAt === retryAt
            ? { ...current, message: 'You can retry Reddit now.', retryAt: undefined }
            : current,
        );
      }
    };

    tick();
    const intervalId = window.setInterval(tick, 1_000);
    return () => window.clearInterval(intervalId);
  }, [apiStatus?.retryAt]);

  const retryCountdown = apiStatus?.retryAt ? formatRetryCountdown(apiStatus.retryAt - statusNow) : null;

  return (
    <div className="app-shell">
      {apiStatus && (
        <div className={`api-status-banner api-status-${apiStatus.level}`} role="status" aria-live="polite">
          <div className="api-status-copy">
            <span>{apiStatus.message}</span>
            {retryCountdown && <strong>Try again in {retryCountdown}</strong>}
          </div>
          <button type="button" onClick={() => setApiStatus(null)}>
            Dismiss
          </button>
        </div>
      )}

      <header
          className={`app-header${persistentHeader ? '' : ' app-header-static'}${
            videoFeedMode ? ' app-header-media-only' : ''
          }${!videoFeedMode && !headerExpanded ? ' app-header-compact' : ''
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
                  <Link to="/" className="brand-link" aria-label="RedAlt Home">
                    <span className="brand-logo-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 3" />
                        <circle cx="12" cy="12" r="2" fill="currentColor" />
                      </svg>
                    </span>
                    <h1>RedAlt</h1>
                  </Link>
                </div>
                <div className="header-controls">
                  <SubredditSwitcher initialSubreddit={subreddit} />
                  {gatewayStatus && (
                    <span
                      className={`gateway-status-pill gateway-status-${gatewayStatus.state}`}
                      title={gatewayStatus.detail}
                      role="status"
                    >
                      <span className="gateway-status-dot" aria-hidden="true" />
                      {gatewayStatus.label}
                    </span>
                  )}
                  <nav className="header-nav-links" aria-label="Quick links">
                    <Link
                      to="/saved"
                      className={`nav-link-btn${location.pathname === '/saved' ? ' nav-link-active' : ''}`}
                      title="Saved posts"
                    >
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                      </svg>
                      <span>Saved</span>
                    </Link>
                    <Link
                      to="/history"
                      className={`nav-link-btn${location.pathname === '/history' ? ' nav-link-active' : ''}`}
                      title="Viewing history"
                    >
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span>History</span>
                    </Link>
                    <Link
                      to="/settings"
                      className={`menu-toggle settings-nav-link${location.pathname === '/settings' ? ' nav-link-active' : ''}`}
                      aria-label="Settings"
                      title="Settings"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                      <span className="menu-toggle-label">Settings</span>
                    </Link>
                    <button
                      type="button"
                      className="header-expand-toggle"
                      aria-label={headerExpanded ? 'Collapse header' : 'Expand header'}
                      title={headerExpanded ? 'Collapse header' : 'Expand header'}
                      onClick={() => setHeaderExpanded((value) => !value)}
                    >
                      {headerExpanded ? '↑' : '↓'}
                    </button>
                  </nav>
                </div>
              </div>

              {headerExpanded && (
                <div className="header-row">
                  <CustomFeedBuilder currentSubreddit={subreddit} />
                </div>
              )}
            </>
          )}
      </header>

      <main>
        <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/r/:name" element={<SubredditPage />} />
            <Route path="/r/:name/comments/:id" element={<PostDetailPage />} />
            <Route path="/r/:name/comments/:id/:slug" element={<PostDetailPage />} />
            <Route path="/u/:username" element={<UserPage />} />
            <Route path="/user/:username" element={<UserPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/saved" element={<LibraryPage mode="saved" />} />
            <Route path="/history" element={<LibraryPage mode="history" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
