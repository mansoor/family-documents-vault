import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { colours, darkColours, radii, TAP_MIN, type } from '@fdv/shared';
import { describe, expect, it } from 'vitest';

/**
 * The web's stylesheet and the shared tokens say the same thing.
 *
 * The phone app draws with `@fdv/shared`'s tokens; the web draws with the
 * custom properties in styles.css. Two copies of one design drift unless
 * something holds them together, so this reads the stylesheet and fails
 * when either side has something the other does not, or a colour is
 * written anywhere but the tokens — in either theme (0.9.0): light in
 * `:root`, dark in `:root[data-theme='dark']`.
 */

// Read from disk: under Vitest a stylesheet import is an empty module.
const file = ['src/styles.css', 'apps/web/src/styles.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));
const css = file ? readFileSync(file, 'utf8') : '';

// Every :root block, wherever it is: a media query would add another, and
// its properties must be tokens too.
const ROOT = /:root\s*\{([^}]*)\}/g;
// The dark theme's: its colours, and nothing else.
const DARK = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/g;

const declarations = (pattern: RegExp): Array<[string, string]> =>
  [...css.matchAll(pattern)]
    .map((m) => m[1] ?? '')
    .flatMap((block) =>
      [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m): [string, string] => [
        m[1] ?? '',
        (m[2] ?? '').trim(),
      ]),
    );
const declared = declarations(ROOT);
const dark = declarations(DARK);

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const same = (hex: string) => (v: string) => v.toLowerCase() === hex.toLowerCase();

/** What each custom property must be, from the shared tokens. */
const expected = new Map<string, (value: string) => boolean>([
  ...Object.entries(colours).map(([role, hex]): [string, (v: string) => boolean] => [
    kebab(role),
    same(hex),
  ]),
  ...(['s', 'm', 'l', 'xl'] as const).map((k): [string, (v: string) => boolean] => [
    `radius-${k}`,
    (v) => v === `${radii[k]}px`,
  ]),
  ['tap', (v) => v.startsWith(`${TAP_MIN}px`)],
  ['font-body', (v) => v.startsWith(`${type.families.body},`)],
  ['font-display', (v) => v.startsWith(`${type.families.display},`)],
]);

/** Any way of writing a colour down, bar a custom property. */
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/gi;

describe('styles.css and @fdv/shared agree', () => {
  it('found the stylesheet and its tokens, in both themes', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(declared.length).toBeGreaterThan(10);
    expect([...css.matchAll(DARK)]).toHaveLength(1);
  });

  it('every shared colour is a custom property, with the same value', () => {
    const byName = new Map(declared);
    for (const [role, value] of Object.entries(colours)) {
      const name = kebab(role);
      expect(byName.get(name), `--${name}`).toBeDefined();
      expect(byName.get(name)?.toLowerCase(), `--${name}`).toBe(value.toLowerCase());
    }
  });

  it('every custom property is a shared token, with the same value', () => {
    const wrong = declared
      .filter(([name, value]) => !expected.get(name)?.(value))
      .map(([name, value]) => `--${name}: ${value}`);
    expect(wrong).toEqual([]);
  });

  it('the dark theme gives every colour role its dark value, and nothing else', () => {
    // Each role once, with the shared dark value…
    expect(dark.map(([name]) => name).sort()).toEqual(Object.keys(darkColours).map(kebab).sort());
    const wrong = dark
      .filter(([name, value]) => {
        const role = Object.keys(darkColours).find((r) => kebab(r) === name);
        return (
          !role ||
          value.toLowerCase() !== darkColours[role as keyof typeof darkColours].toLowerCase()
        );
      })
      .map(([name, value]) => `--${name}: ${value}`);
    expect(wrong).toEqual([]);
    // …and the native controls, the scrollbars and the date pickers dark with it.
    const block = [...css.matchAll(DARK)][0]?.[1] ?? '';
    expect(block).toMatch(/(^|\s)color-scheme:\s*dark;/);
    expect([...css.matchAll(ROOT)][0]?.[1]).toMatch(/(^|\s)color-scheme:\s*light;/);
  });

  it('no colour is written outside the tokens, not even white', () => {
    const outside = css.replace(ROOT, '').replace(DARK, '');
    const stray = [...outside.matchAll(COLOUR)].map((m) => m[0].toLowerCase());
    expect(stray).toEqual([]);
    // Nor by its name, where a colour goes.
    const named = [
      ...outside.matchAll(
        /(?:^|[\s;{])(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|outline(?:-color)?|fill|stroke|box-shadow|border|outline):[^;]*\b(white|black|red|green|blue|gray|grey|silver)\b/gim,
      ),
    ].map((m) => m[0].trim());
    expect(named).toEqual([]);
  });

  it('nothing filters or inverts an image: a scan is shown as it is', () => {
    const outside = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(outside).not.toMatch(/(^|[\s;{])(filter|backdrop-filter|mix-blend-mode):/m);
  });
});
