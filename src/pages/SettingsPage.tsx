import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { THEMES } from '../components/ThemeSwitcher';
import {
  useUiSettings,
  type CardMode,
  type FallbackMediaSource,
  type LoadMoreMode,
  type RedditApiSource,
  type ThemeName,
  type UiSettings,
} from '../lib/uiSettings';

const REDDIT_SOURCE_OPTIONS: Array<{ value: RedditApiSource; label: string }> = [
  { value: 'auto', label: 'Auto failover' },
  { value: 'same-origin', label: 'Current deployment' },
  { value: 'render', label: 'Render proxy' },
  { value: 'cloudflare', label: 'Cloudflare Pages proxy' },
];

export function SettingsPage() {
  const { settings, updateSettings } = useUiSettings();
  const [draftSettings, setDraftSettings] = useState<UiSettings>(settings);
  const savedSettingsRef = useRef(settings);
  const committedDraftRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    savedSettingsRef.current = settings;
    setDraftSettings(settings);
  }, [settings]);

  useEffect(() => {
    document.body.dataset.theme = draftSettings.theme;
  }, [draftSettings.theme]);

  useEffect(() => {
    return () => {
      if (!committedDraftRef.current) {
        document.body.dataset.theme = savedSettingsRef.current.theme;
      }
    };
  }, []);

  const updateDraftSettings = (partial: Partial<UiSettings>) => {
    setDraftSettings((previous) => ({ ...previous, ...partial }));
  };

  const returnToPreviousPage = () => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate('/');
  };

  const saveSettings = () => {
    committedDraftRef.current = true;
    document.body.dataset.theme = draftSettings.theme;
    updateSettings(draftSettings);
    returnToPreviousPage();
  };

  return (
    <section className="settings-page">
      <header className="settings-page-header">
        <h2>Settings</h2>
        <div className="settings-page-actions" aria-label="Settings actions">
          <button type="button" className="settings-action-button" onClick={returnToPreviousPage}>
            Return
          </button>
          <button type="button" className="settings-action-button settings-action-button-primary" onClick={saveSettings}>
            Save
          </button>
        </div>
      </header>

      <section className="settings-section" aria-labelledby="settings-source-heading">
        <h3 id="settings-source-heading">Source</h3>
        <div className="settings-field-list">
          <label className="settings-field">
            <span>Reddit instance</span>
            <select
              value={draftSettings.redditApiSource}
              onChange={(event) => updateDraftSettings({ redditApiSource: event.target.value as RedditApiSource })}
            >
              {REDDIT_SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>Media source</span>
            <select
              value={draftSettings.fallbackMediaSource}
              onChange={(event) =>
                updateDraftSettings({ fallbackMediaSource: event.target.value as FallbackMediaSource })
              }
            >
              <option value="instance">Redlib instance HLS/proxy</option>
              <option value="reddit">Original CDN/provider embeds</option>
            </select>
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-layout-heading">
        <h3 id="settings-layout-heading">Layout</h3>
        <div className="settings-field-list">
          <label className="theme-picker">
            Theme
            <select
              value={draftSettings.theme}
              onChange={(event) => updateDraftSettings({ theme: event.target.value as ThemeName })}
            >
              {THEMES.map((theme) => (
                <option key={theme.value} value={theme.value}>
                  {theme.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>Columns</span>
            <select
              value={draftSettings.columns}
              onChange={(event) => updateDraftSettings({ columns: Number(event.target.value) })}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </label>

          <label className="settings-field">
            <span>Card mode</span>
            <select
              value={draftSettings.cardMode}
              onChange={(event) => updateDraftSettings({ cardMode: event.target.value as CardMode })}
            >
              <option value="default">Default</option>
              <option value="compact">Compact</option>
              <option value="content-only">Content only</option>
            </select>
          </label>

          <label className="settings-field">
            <span>Load more posts</span>
            <select
              value={draftSettings.loadMoreMode}
              onChange={(event) => updateDraftSettings({ loadMoreMode: event.target.value as LoadMoreMode })}
            >
              <option value="scroll">Infinite scroll</option>
              <option value="button">Button</option>
            </select>
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-behavior-heading">
        <h3 id="settings-behavior-heading">Behavior</h3>
        <div className="settings-field-list">
          <label className="settings-switch">
            <span>Autoplay videos</span>
            <input
              type="checkbox"
              checked={draftSettings.autoplayVideos}
              onChange={(event) => updateDraftSettings({ autoplayVideos: event.target.checked })}
            />
          </label>

          <label className="settings-switch">
            <span>Autoplay with audio</span>
            <input
              type="checkbox"
              checked={draftSettings.autoplayWithAudio}
              onChange={(event) => updateDraftSettings({ autoplayWithAudio: event.target.checked })}
            />
          </label>

          <label className="settings-switch">
            <span>Media feed mode</span>
            <input
              type="checkbox"
              checked={draftSettings.videoFeedMode}
              onChange={(event) => updateDraftSettings({ videoFeedMode: event.target.checked })}
            />
          </label>

          <label className="settings-switch">
            <span>Sticky header</span>
            <input
              type="checkbox"
              checked={draftSettings.persistentHeader}
              onChange={(event) => updateDraftSettings({ persistentHeader: event.target.checked })}
            />
          </label>

          <label className="settings-switch">
            <span>Open posts in new tab</span>
            <input
              type="checkbox"
              checked={draftSettings.openInNewTab}
              onChange={(event) => updateDraftSettings({ openInNewTab: event.target.checked })}
            />
          </label>
        </div>
      </section>
    </section>
  );
}
