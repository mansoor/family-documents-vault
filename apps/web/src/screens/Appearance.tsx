import { setThemeChoice, THEME_CHOICES, useShownTheme, useThemeChoice } from '../theme.js';
import { SettingsPage } from './Settings.js';

/**
 * Settings → Appearance (0.9.0, the owner's ask of 27 Oct 2026): light, dark,
 * or Auto, as the device is set. Three choices side by side, one of them
 * chosen — a radio group, so the arrow keys move between them and a screen
 * reader says "2 of 3". Chosen, the page changes at once; there is nothing
 * to save. Kept on this browser alone (theme.ts), for every role.
 */
export function AppearanceScreen() {
  const choice = useThemeChoice();
  const shown = useShownTheme();
  return (
    <SettingsPage title="Appearance">
      <section aria-labelledby="theme-h" className="stack">
        <h2 id="theme-h" className="section-h">
          Theme
        </h2>
        <fieldset className="plain" aria-describedby="theme-note">
          <legend className="visually-hidden">Theme</legend>
          <div className="seg">
            {THEME_CHOICES.map((c) => (
              <label key={c.value} className="seg-opt">
                <input
                  type="radio"
                  name="theme"
                  value={c.value}
                  checked={choice === c.value}
                  onChange={() => setThemeChoice(c.value)}
                />
                <span className="seg-words">{c.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p id="theme-note" className="muted">
          {choice === 'auto'
            ? `Auto follows your device, which is set to ${shown} now, and changes when it does.`
            : `${choice === 'dark' ? 'Dark' : 'Light'} on this browser, however your device is set.`}{' '}
          Kept on this browser only: another computer or phone keeps its own.
        </p>
      </section>
    </SettingsPage>
  );
}
