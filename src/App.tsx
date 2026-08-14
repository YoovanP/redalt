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
  state: 'official' | 'scrape' | 'degraded';
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
                  <Link to="/"><h1>RedAlt</h1></Link>
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
                    <Link to="/settings" className="menu-toggle settings-nav-link" aria-label="Settings" title="Settings">
                      <span className="menu-toggle-bars" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="menu-toggle-label">Settings</span>
                    </Link>
                    <Link to="/saved">Saved</Link>
                    <Link to="/history">History</Link>
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
