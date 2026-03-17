import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { ListingSort, TopTimeRange } from '../lib/redditApi';
import { SortControls } from './SortControls';
import { ThemeSwitcher } from './ThemeSwitcher';
import { useUiSettings } from '../lib/uiSettings';

function getValidatedSort(input: string | null): ListingSort {
  if (input === 'hot' || input === 'new' || input === 'rising' || input === 'top') {
    return input;
  }

  return 'hot';
}

function getValidatedTopTimeRange(input: string | null): TopTimeRange {
  if (
    input === 'hour' ||
    input === 'day' ||
    input === 'week' ||
    input === 'month' ||
    input === 'year' ||
    input === 'all'
  ) {
    return input;
  }

  return 'day';
}

function supportsSortControls(pathname: string): boolean {
  return /^\/r\/[^/]+\/?$/i.test(pathname) || /^\/(?:u|user)\/[^/]+\/?$/i.test(pathname);
}

export function FeedSettings() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { settings, updateSettings } = useUiSettings();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const sort = getValidatedSort(searchParams.get('sort'));
  const topTimeRange = getValidatedTopTimeRange(searchParams.get('t'));
  const canSort = supportsSortControls(location.pathname);

  const onSortChange = (nextSort: ListingSort) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('sort', nextSort);

    if (nextSort !== 'top') {
      nextParams.delete('t');
    } else if (!nextParams.get('t')) {
      nextParams.set('t', 'day');
    }

    setSearchParams(nextParams);
  };

  const onTopTimeRangeChange = (nextRange: TopTimeRange) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('sort', 'top');
    nextParams.set('t', nextRange);
    setSearchParams(nextParams);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;

      if (target && rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open]);

  return (
    <section ref={rootRef} className="feed-settings-menu">
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
          <ThemeSwitcher />

          {canSort && (
            <SortControls
              sort={sort}
              topTimeRange={topTimeRange}
              onSortChange={onSortChange}
              onTopTimeRangeChange={onTopTimeRangeChange}
            />
          )}

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
