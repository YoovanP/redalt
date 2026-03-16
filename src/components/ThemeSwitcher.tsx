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
        <option value="dark">dark</option>
        <option value="light">light</option>
        <option value="midnight">midnight</option>
        <option value="cyberpunk">cyberpunk</option>
        <option value="forest">forest</option>
        <option value="sunset">sunset</option>
        <option value="ocean">ocean</option>
        <option value="grape">grape</option>
        <option value="desert">desert</option>
        <option value="monochrome">monochrome</option>
      </select>
    </label>
  );
}
