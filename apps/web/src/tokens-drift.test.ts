import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { colours, radii, TAP_MIN } from '@fdv/shared';
import { describe, expect, it } from 'vitest';

/**
 * The web's stylesheet and the shared tokens say the same thing.
 *
 * The phone app draws with `@fdv/shared`'s tokens; the web draws with the
 * custom properties in styles.css. Two copies of one design drift unless
 * something holds them together, so this reads the stylesheet and fails on
 * the first property that disagrees.
 */

// Read from disk: under Vitest a stylesheet import is an empty module.
const file = ['src/styles.css', 'apps/web/src/styles.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));
const css = file ? readFileSync(file, 'utf8') : '';

const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const props: Record<string, string> = Object.fromEntries(
  [...root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m): [string, string] => [
    m[1] ?? '',
    (m[2] ?? '').trim(),
  ]),
);

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe('styles.css and @fdv/shared agree', () => {
  it('found the stylesheet', () => {
    expect(css.length).toBeGreaterThan(1000);
  });

  it('every shared colour is a custom property, with the same value', () => {
    for (const [role, value] of Object.entries(colours)) {
      if (role === 'onAccent') continue; // white, written inline
      const name = kebab(role);
      expect(props[name], `--${name}`).toBeDefined();
      expect(props[name]?.toLowerCase(), `--${name}`).toBe(value.toLowerCase());
    }
  });

  it('the radii and the tap target are the shared ones', () => {
    expect(props['radius-s']).toBe(`${radii.s}px`);
    expect(props['radius-m']).toBe(`${radii.m}px`);
    expect(props['radius-l']).toBe(`${radii.l}px`);
    expect(props['radius-xl']).toBe(`${radii.xl}px`);
    expect(props.tap).toMatch(new RegExp(`^${TAP_MIN}px`));
  });

  it('no colour is written outside the tokens, except white', () => {
    const outside = css.replace(/:root\s*\{[\s\S]*?\n\}/, '');
    const stray = [...outside.matchAll(/#[0-9a-f]{3,8}\b/gi)]
      .map((m) => m[0].toLowerCase())
      .filter((c) => c !== '#fff' && c !== '#ffffff');
    expect(stray).toEqual([]);
  });
});
