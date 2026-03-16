import { useState } from 'react';
import { useUiSettings } from '../lib/uiSettings';

export function FeedSettings() {
  const { settings, updateSettings } = useUiSettings();
  const [open, setOpen] = useState(false);

  return (
    <section className="feed-settings-menu">
      <button
        type="button"
        className="menu-toggle"
        aria-label="Open feed settings"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ☰ Feed settings
      </button>

      {open && (
        <div className="feed-settings-panel">
          <label>
            <input
              type="checkbox"
              checked={settings.autoplayVideos}
              onChange={(event) => updateSettings({ autoplayVideos: event.target.checked })}
            />
            Autoplay videos
          </label>

          <label>
            <input
              type="checkbox"
              checked={settings.autoplayWithAudio}
              onChange={(event) => updateSettings({ autoplayWithAudio: event.target.checked })}
            />
            Autoplay with audio
          </label>

          <label>
            Columns
            <select
              value={settings.columns}
              onChange={(event) => updateSettings({ columns: Number(event.target.value) })}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </label>

          <label>
            Card mode
            <select
              value={settings.cardMode}
              onChange={(event) =>
                updateSettings({ cardMode: event.target.value as 'default' | 'compact' | 'content-only' })
              }
            >
              <option value="default">Default</option>
              <option value="compact">Compact</option>
              <option value="content-only">Content only</option>
            </select>
          </label>

          <label>
            <input
              type="checkbox"
              checked={settings.videoFeedMode}
              onChange={(event) => updateSettings({ videoFeedMode: event.target.checked })}
            />
            Media feed mode
          </label>

          <label>
            <input
              type="checkbox"
              checked={settings.persistentHeader}
              onChange={(event) => updateSettings({ persistentHeader: event.target.checked })}
            />
            Persistent header
          </label>
        </div>
      )}
    </section>
  );
}
