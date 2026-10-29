// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The guard that keeps every colour a token (0.9.0, the dark theme): a
 * colour written into a screen — `stroke="#fff"`, `style={{ borderColor:
 * '#b45309' }}` — is the same in both themes, and one of them is wrong. So
 * no file of the web app writes one down; it names a token from styles.css
 * (a class, or `var(--…)`) instead. tokens-drift.test.ts holds the
 * stylesheet itself to the same. The few exceptions are listed here, each
 * with why — a new one is a decision, not an accident.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

/** [file, what it writes, why it may]. */
const ALLOWED: Array<[string, string, string]> = [
  // A comment naming a pull request, not a colour.
  ['app-context.tsx', '#100', 'PR #100, in a comment'],
];

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/gi;
/** A colour by its name, where a colour goes: an attribute or a style's property. */
const NAMED =
  /\b(?:fill|stroke|stopColor|stop-color|color|background|backgroundColor|borderColor|outlineColor)\s*[=:]\s*\{?\s*['"`](white|black|red|green|blue|gray|grey|silver|orange|yellow|purple)['"`]/gi;

/** Every colour a source writes down: [file, what]. */
function coloursIn(rel: string, text: string): Array<[string, string]> {
  return [...text.matchAll(COLOUR), ...text.matchAll(NAMED)].map((m): [string, string] => [
    rel,
    m[0].replace(/\s+/g, ' '),
  ]);
}

const sources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, e.name);
      if (e.isDirectory()) walk(at);
      // The tests describe colours as data; the screens draw them.
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(at);
    }
  };
  walk(SRC);
  return out;
};

describe('no colour is written into a screen (0.9.0)', () => {
  it('catches what it should, and lets a token by', () => {
    for (const code of [
      '<svg stroke="#fff" />',
      "<div style={{ borderColor: '#b45309' }} />",
      "const c = 'rgba(0, 0, 0, 0.5)';",
      "ctx.fillStyle = 'hsl(120 50% 50%)';",
      '<path fill="white" />',
      "<p style={{ color: 'black' }} />",
    ]) {
      expect(coloursIn('x.tsx', code).length, code).toBeGreaterThan(0);
    }
    for (const code of [
      '<svg stroke="currentColor" fill="none" />',
      "<div style={{ borderColor: 'var(--warn)' }} />",
      '<a href="#main-content">Skip</a>',
      "<p className='white-space'>",
    ]) {
      expect(coloursIn('x.tsx', code), code).toEqual([]);
    }
  });

  it('no file of the web app writes a colour, but the listed few', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(60);
    const found = files.flatMap((f) =>
      coloursIn(relative(SRC, f).split(sep).join('/'), readFileSync(f, 'utf8')),
    );
    const unlisted = found.filter(
      ([file, what]) => !ALLOWED.some(([f, w]) => f === file && w === what),
    );
    expect(unlisted).toEqual([]);
    // And each exception is still there: one no longer needed is taken off.
    for (const [file, what] of ALLOWED) {
      expect(found, `${file}: ${what}`).toContainEqual([file, what]);
    }
  });
});
