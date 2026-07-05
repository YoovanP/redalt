import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

const PANEL_GUTTER = 8;
const PANEL_OFFSET = 8;
const PANEL_MAX_WIDTH = 380;

function getPanelStyle(trigger: HTMLElement): CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(240, Math.min(PANEL_MAX_WIDTH, viewportWidth - PANEL_GUTTER * 2));
  const left = Math.min(
    Math.max(rect.left, PANEL_GUTTER),
    Math.max(PANEL_GUTTER, viewportWidth - width - PANEL_GUTTER),
  );
  const top = rect.bottom + PANEL_OFFSET;

  return {
    position: 'fixed',
    top,
    left,
    width,
    maxHeight: Math.max(160, viewportHeight - top - PANEL_GUTTER),
  };
}

export function FeedSettings() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { settings, updateSettings } = useUiSettings();
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>();
  const rootRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
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

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }

    const updatePanelStyle = () => {
      if (buttonRef.current) {
        setPanelStyle(getPanelStyle(buttonRef.current));
      }
    };

    updatePanelStyle();
    window.addEventListener('resize', updatePanelStyle);
    window.addEventListener('scroll', updatePanelStyle, true);

    return () => {
      window.removeEventListener('resize', updatePanelStyle);
      window.removeEventListener('scroll', updatePanelStyle, true);
    };
  }, [open]);

  return (
    <section ref={rootRef} className="feed-settings-menu">
      <button
        ref={buttonRef}
        type="button"
        className="menu-toggle"
        aria-label="Open feed settings"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ☰
      </button>

      {open && (
        <div className="feed-settings-panel" style={panelStyle}>
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
            Sticky header
          </label>

          <label>
            <input
              type="checkbox"
              checked={settings.openInNewTab}
              onChange={(event) => updateSettings({ openInNewTab: event.target.checked })}
            />
            Open posts in new tab
          </label>

          <label>
            Media source
            <select
              value={settings.fallbackMediaSource}
              onChange={(event) =>
                updateSettings({ fallbackMediaSource: event.target.value as 'instance' | 'reddit' })
              }
            >
              <option value="instance">Redlib instance HLS/proxy (privacy)</option>
              <option value="reddit">Original CDN/provider embeds</option>
            </select>
          </label>

          <label>
            Load more posts
            <select
              value={settings.loadMoreMode}
              onChange={(event) =>
                updateSettings({ loadMoreMode: event.target.value as 'scroll' | 'button' })
              }
            >
              <option value="scroll">Automatically (Infinite scroll)</option>
              <option value="button">With a button (Click to load)</option>
            </select>
          </label>
        </div>
      )}
    </section>
  );
}
