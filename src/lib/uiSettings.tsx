import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeName =
  | 'dark'
  | 'light'
  | 'midnight'
  | 'cyberpunk'
  | 'forest'
  | 'sunset'
  | 'ocean'
  | 'grape'
  | 'desert'
  | 'monochrome';

export type CardMode = 'default' | 'compact' | 'content-only';

type UiSettings = {
  theme: ThemeName;
  autoplayVideos: boolean;
  autoplayWithAudio: boolean;
  columns: number;
  videoFeedMode: boolean;
  cardMode: CardMode;
};

type UiSettingsContextType = {
  settings: UiSettings;
  updateSettings: (partial: Partial<UiSettings>) => void;
};

const STORAGE_KEY = 'redalt.uiSettings';

const defaultSettings: UiSettings = {
  theme: 'dark',
  autoplayVideos: false,
  autoplayWithAudio: false,
  columns: 1,
  videoFeedMode: false,
  cardMode: 'default',
};

const UiSettingsContext = createContext<UiSettingsContextType | null>(null);

function normalizeSettings(input: unknown): UiSettings {
  if (!input || typeof input !== 'object') {
    return defaultSettings;
  }

  const value = input as Partial<UiSettings>;
  const theme =
    value.theme === 'dark' ||
    value.theme === 'light' ||
    value.theme === 'midnight' ||
    value.theme === 'cyberpunk' ||
    value.theme === 'forest' ||
    value.theme === 'sunset' ||
    value.theme === 'ocean' ||
    value.theme === 'grape' ||
    value.theme === 'desert' ||
    value.theme === 'monochrome'
      ? value.theme
      : defaultSettings.theme;

  const columns =
    typeof value.columns === 'number' && value.columns >= 1 && value.columns <= 4
      ? Math.floor(value.columns)
      : defaultSettings.columns;

  const cardMode =
    value.cardMode === 'default' || value.cardMode === 'compact' || value.cardMode === 'content-only'
      ? value.cardMode
      : defaultSettings.cardMode;

  return {
    theme,
    autoplayVideos: Boolean(value.autoplayVideos),
    autoplayWithAudio: Boolean(value.autoplayWithAudio),
    columns,
    videoFeedMode: Boolean(value.videoFeedMode),
    cardMode,
  };
}

export function UiSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<UiSettings>(defaultSettings);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as unknown;
      setSettings(normalizeSettings(parsed));
    } catch {
      setSettings(defaultSettings);
    }
  }, []);

  useEffect(() => {
    document.body.dataset.theme = settings.theme;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const value = useMemo(
    () => ({
      settings,
      updateSettings: (partial: Partial<UiSettings>) => {
        setSettings((previous) => normalizeSettings({ ...previous, ...partial }));
      },
    }),
    [settings],
  );

  return <UiSettingsContext.Provider value={value}>{children}</UiSettingsContext.Provider>;
}

export function useUiSettings() {
  const context = useContext(UiSettingsContext);

  if (!context) {
    throw new Error('useUiSettings must be used within UiSettingsProvider');
  }

  return context;
}
