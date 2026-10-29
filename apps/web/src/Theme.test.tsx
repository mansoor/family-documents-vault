import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn } from './test-api.js';
import {
  applyTheme,
  followTheme,
  setThemeChoice,
  themeChoice,
  themeFor,
  THEME_KEY,
  type ThemeChoice,
} from './theme.js';

/**
 * Light, dark, or Auto (0.9.0, the owner's ask of 27 Oct 2026): what the page
 * is told, from the choice this browser keeps and the system's setting; the
 * script at the top of index.html that tells it before anything is drawn;
 * and the two places to choose, Settings → Appearance and the name menu.
 */

/** The system's setting, as `prefers-color-scheme` says it; and its watchers. */
let systemDark = false;
const systemWatchers = new Set<() => void>();
function mockSystem(dark: boolean, { width = 1280 } = {}) {
  systemDark = dark;
  systemWatchers.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const scheme = /prefers-color-scheme:\s*dark/.test(query);
      return {
        matches: scheme ? systemDark : minWidth ? width >= Number(minWidth[1]) : false,
        media: query,
        onchange: null,
        addEventListener: (_: string, fn: () => void) => systemWatchers.add(fn),
        removeEventListener: (_: string, fn: () => void) => systemWatchers.delete(fn),
        addListener: (fn: () => void) => systemWatchers.add(fn),
        removeListener: (fn: () => void) => systemWatchers.delete(fn),
        dispatchEvent: () => false,
      };
    },
  });
}
/** The system turns light or dark, as a phone does at dusk. */
function systemTurns(dark: boolean) {
  act(() => {
    systemDark = dark;
    for (const w of [...systemWatchers]) w();
  });
}

const html = () => document.documentElement;
const shown = () => html().getAttribute('data-theme');

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute('data-theme');
  html().style.colorScheme = '';
  // Each test starts with nothing chosen that storage would not keep.
  setThemeChoice('auto');
  html().removeAttribute('data-theme');
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('the theme the page is told (theme.ts)', () => {
  it('Light and Dark are themselves; Auto is the system’s', () => {
    mockSystem(false);
    expect(themeFor('light')).toBe('light');
    expect(themeFor('dark')).toBe('dark');
    expect(themeFor('auto')).toBe('light');
    mockSystem(true);
    expect(themeFor('auto')).toBe('dark');
    expect(themeFor('light')).toBe('light');
    // Nowhere to ask: light.
    Reflect.deleteProperty(window, 'matchMedia');
    expect(themeFor('auto')).toBe('light');
  });

  it('each choice sets data-theme and the native controls’ scheme, and is kept as asked', () => {
    mockSystem(true);
    setThemeChoice('light');
    expect(shown()).toBe('light');
    expect(html().style.colorScheme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    setThemeChoice('dark');
    expect(shown()).toBe('dark');
    expect(html().style.colorScheme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    // Auto is what nobody chose: nothing kept, and the system's dark shown.
    setThemeChoice('auto');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(shown()).toBe('dark');
    expect(themeChoice()).toBe('auto');
  });

  it('Auto follows the system as it changes; Light and Dark do not', () => {
    mockSystem(false);
    const stop = followTheme();
    expect(shown()).toBe('light');
    systemTurns(true);
    expect(shown()).toBe('dark');
    systemTurns(false);
    expect(shown()).toBe('light');
    setThemeChoice('dark');
    systemTurns(false);
    expect(shown()).toBe('dark');
    setThemeChoice('light');
    systemTurns(true);
    expect(shown()).toBe('light');
    // Undone: no longer told.
    setThemeChoice('auto');
    stop();
    systemTurns(false);
    expect(shown()).toBe('dark');
  });

  it('a choice made in another tab is shown in this one', () => {
    mockSystem(false);
    const stop = followTheme();
    expect(shown()).toBe('light');
    localStorage.setItem(THEME_KEY, 'dark');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' }));
    });
    expect(shown()).toBe('dark');
    stop();
  });

  it('a stored value it does not know is Auto', () => {
    mockSystem(true);
    for (const kept of ['', 'Dark', 'blue', 'auto']) {
      localStorage.setItem(THEME_KEY, kept);
      expect(themeChoice(), kept).toBe('auto');
      expect(applyTheme(), kept).toBe('dark');
    }
  });

  it('storage that cannot be read is Auto; a choice it will not keep holds for now', () => {
    mockSystem(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(themeChoice()).toBe('auto');
    expect(applyTheme()).toBe('dark');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    setThemeChoice('light');
    expect(themeChoice()).toBe('light');
    expect(shown()).toBe('light');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    setThemeChoice('auto');
    expect(themeChoice()).toBe('auto');
    expect(shown()).toBe('dark');
  });
});

/** index.html, and the one script in it that is not a module. */
const shell = (() => {
  const file = ['index.html', 'apps/web/index.html']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();
const inline = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');

/** The script run as the browser runs it, before anything else. */
function runNoFlash() {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const script = new Function(inline[0] ?? '') as () => void;
  script();
}

describe('no flash: index.html tells the page its theme before anything is drawn', () => {
  it('is in the head, before every stylesheet and the app', () => {
    expect(inline).toHaveLength(1);
    const at = shell.indexOf('<script>');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(shell.indexOf('</head>'));
    expect(at).toBeLessThan(shell.indexOf('rel="stylesheet"'));
    expect(at).toBeLessThan(shell.indexOf('type="module"'));
    // The browser's own controls may be either, as the page says.
    expect(shell).toMatch(/<meta name="color-scheme" content="light dark" \/>/);
    // It reads the key theme.ts keeps.
    expect(inline[0]).toContain(`'${THEME_KEY}'`);
  });

  it.each([
    [null, false],
    [null, true],
    ['light', false],
    ['light', true],
    ['dark', false],
    ['dark', true],
    ['nonsense', true],
  ] as const)('kept %s, the system dark %s: as theme.ts would say', (kept, dark) => {
    mockSystem(dark);
    if (kept !== null) localStorage.setItem(THEME_KEY, kept);
    runNoFlash();
    const expected = themeFor(themeChoice(), dark);
    expect(shown()).toBe(expected);
    expect(html().style.colorScheme).toBe(expected);
  });

  it('storage blocked: the system’s; no matchMedia either: light', () => {
    mockSystem(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    runNoFlash();
    expect(shown()).toBe('dark');
    Reflect.deleteProperty(window, 'matchMedia');
    runNoFlash();
    expect(shown()).toBe('light');
  });
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** The app at `path`, signed in as `role`, the system light or dark. */
function at(path: string, role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner', dark = false) {
  mockSystem(dark);
  installFakeApi(fresh({ members: [{ ...ME, role }, AISHA] }));
  signedIn(role);
  window.history.replaceState({}, '', path);
  return render(<App />);
}

describe('Settings → Appearance', () => {
  it.each(['owner', 'adult', 'teen', 'viewer'] as const)(
    'a %s chooses Light, Dark or Auto, as a radio group, and sees it at once',
    async (role) => {
      at('/settings/appearance', role, true);
      const stop = followTheme();
      await screen.findByRole('heading', { level: 1, name: 'Appearance' });
      expect(document.title).toBe('Settings: appearance – Family Document Vault');
      const group = screen.getByRole('group', { name: 'Theme' });
      const radios = within(group).getAllByRole('radio');
      expect(radios.map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
        'Auto',
        'Light',
        'Dark',
      ]);
      // Nothing chosen: Auto, and what it means now.
      expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked();
      expect(shown()).toBe('dark');
      expect(group).toHaveAccessibleDescription(
        /Auto follows your device, which is set to dark now/,
      );
      // Light, at once, kept.
      fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
      // Chosen and kept at once; the radios are drawn as soon as React is free
      // (on a busy machine, after the app's own loading finishes drawing).
      expect(shown()).toBe('light');
      expect(localStorage.getItem(THEME_KEY)).toBe('light');
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked());
      expect(group).toHaveAccessibleDescription(
        /Light on this browser, however your device is set/,
      );
      fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
      expect(shown()).toBe('dark');
      // Back to Auto, and the system turning light is said and shown.
      fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));
      expect(localStorage.getItem(THEME_KEY)).toBeNull();
      systemTurns(false);
      expect(shown()).toBe('light');
      await waitFor(() => expect(group).toHaveAccessibleDescription(/which is set to light now/));
      await expectAccessible();
      stop();
    },
  );

  it('is in the You group of the menu, after Notifications', async () => {
    at('/settings/account');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const you = within(nav).getByRole('list', { name: 'You' });
    expect(
      within(you)
        .getAllByRole('link')
        .map((l) => l.querySelector('.settings-nav-label')?.textContent),
    ).toEqual(['Your account', 'Notifications', 'Appearance', 'Your data']);
  });
});

describe('the name menu’s quick switch', () => {
  it('Auto, Light and Dark, the one in use checked; choosing leaves the menu open', async () => {
    localStorage.setItem(THEME_KEY, 'dark');
    at('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Your account: Mansoor Seikh' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    const radio = (name: string) => within(menu).getByRole('menuitemradio', { name });
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Auto')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(radio('Light'));
    expect(shown()).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    await waitFor(() => expect(radio('Light')).toHaveAttribute('aria-checked', 'true'));
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menu', { name: 'Your account' })).toBeInTheDocument();
    fireEvent.click(radio('Auto'));
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(shown()).toBe('light');
    await expectAccessible();
  });

  it('and Settings → Appearance says the same choice', async () => {
    at('/settings/appearance');
    await screen.findByRole('heading', { level: 1, name: 'Appearance' });
    fireEvent.click(await screen.findByRole('button', { name: 'Your account: Mansoor Seikh' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Dark' }));
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked());
  });
});

describe('every choice is one of three', () => {
  it('Auto, Light, Dark', () => {
    const all: ThemeChoice[] = ['auto', 'light', 'dark'];
    for (const c of all) {
      setThemeChoice(c);
      expect(themeChoice()).toBe(c);
    }
  });
});
