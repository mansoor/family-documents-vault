import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Settings sub-menu (R1) stays beside a long page as it scrolls, and is
 * never taller than the window: past that it scrolls within itself, so a
 * link tabbed to is always on screen (WCAG 2.4.11). jsdom has no layout, so
 * the rule itself is what is held to it; Chromium was checked by hand at
 * 1280×800 on Settings → Reading (the R4 screenshots' flag).
 */

const css = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleOf(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const decl of (m[1] ?? '').split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  return out;
}

describe('the Settings sub-menu on a long page', () => {
  it('is sticky but never taller than the window, and scrolls within itself', () => {
    const nav = ruleOf('.settings-nav');
    expect(nav.position).toBe('sticky');
    expect(nav['max-height']).toBe('calc(100dvh - var(--shell-top))');
    expect(nav['overflow-y']).toBe('auto');
  });

  it('leaves room for a focused link’s ring inside its scrolling edge', () => {
    const nav = ruleOf('.settings-nav');
    const [top, right] = (nav.padding ?? '').split(/\s+/);
    expect(parseInt(right ?? '0', 10)).toBeGreaterThanOrEqual(4);
    expect(parseInt(top ?? '0', 10)).toBeGreaterThanOrEqual(12);
  });
});
