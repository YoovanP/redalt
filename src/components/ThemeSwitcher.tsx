import { useUiSettings } from '../lib/uiSettings';

export const THEMES = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'cyberpunk', label: 'Cyberpunk' },
  { value: 'forest', label: 'Forest' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'grape', label: 'Grape' },
  { value: 'desert', label: 'Desert' },
  { value: 'monochrome', label: 'Mono' },
  { value: 'true-black', label: 'True Black' },
] as const;

type ThemeSwitcherProps = {
  compact?: boolean;
};

export function ThemeSwitcher({ compact }: ThemeSwitcherProps) {
  const { settings, updateSettings } = useUiSettings();

  if (compact) {
    return (
      <select
        className="header-theme-select"
        value={settings.theme}
        aria-label="Switch theme"
        onChange={(event) => updateSettings({ theme: event.target.value as typeof settings.theme })}
      >
        {THEMES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <label className="theme-picker">
      Theme
      <select
        value={settings.theme}
        onChange={(event) => updateSettings({ theme: event.target.value as typeof settings.theme })}
      >
        {THEMES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
