import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { colours, radii, TAP_MIN, type } from '@fdv/shared';
import { describe, expect, it } from 'vitest';

/**
 * The web's stylesheet and the shared tokens say the same thing.
 *
 * The phone app draws with `@fdv/shared`'s tokens; the web draws with the
 * custom properties in styles.css. Two copies of one design drift unless
 * something holds them together, so this reads the stylesheet and fails
 * when either side has something the other does not, or a colour is
 * written anywhere but the tokens.
 */

// Read from disk: under Vitest a stylesheet import is an empty module.
const file = ['src/styles.css', 'apps/web/src/styles.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));
const css = file ? readFileSync(file, 'utf8') : '';

// Every :root block, wherever it is: a media query or a dark theme would
// add another, and its properties must be tokens too.
const ROOT = /:root\s*\{([^}]*)\}/g;
const roots = [...css.matchAll(ROOT)].map((m) => m[1] ?? '');
const declared: Array<[string, string]> = roots.flatMap((block) =>
  [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m): [string, string] => [
    m[1] ?? '',
    (m[2] ?? '').trim(),
  ]),
);

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** What each custom property must be, from the shared tokens. */
const expected = new Map<string, (value: string) => boolean>([
  ...Object.entries(colours).map(([role, hex]): [string, (v: string) => boolean] => [
    kebab(role),
    (v) => v.toLowerCase() === hex.toLowerCase(),
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
  it('found the stylesheet and its tokens', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(declared.length).toBeGreaterThan(10);
  });

  it('every shared colour is a custom property, with the same value', () => {
    const byName = new Map(declared);
    for (const [role, value] of Object.entries(colours)) {
      if (role === 'onAccent') continue; // white, written inline
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

  it('no colour is written outside the tokens, except white', () => {
    const outside = css.replace(ROOT, '');
    const stray = [...outside.matchAll(COLOUR)]
      .map((m) => m[0].toLowerCase())
      .filter((c) => c !== '#fff' && c !== '#ffffff');
    expect(stray).toEqual([]);
  });
});
