import { useUiSettings } from '../lib/uiSettings';

export function ThemeSwitcher() {
  const { settings, updateSettings } = useUiSettings();

  return (
    <label className="theme-picker">
      Theme
      <select
        value={settings.theme}
        onChange={(event) => updateSettings({ theme: event.target.value as typeof settings.theme })}
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="midnight">Midnight</option>
        <option value="cyberpunk">Cyberpunk</option>
        <option value="forest">Forest</option>
        <option value="sunset">Sunset</option>
        <option value="ocean">Ocean</option>
        <option value="grape">Grape</option>
        <option value="desert">Desert</option>
        <option value="monochrome">Monochrome</option>
      </select>
    </label>
  );
}
