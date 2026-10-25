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
    // The menu and the line at its edge, kept beside the page (0.9.0)…
    const side = ruleOf('.settings-side');
    expect(side.position).toBe('sticky');
    expect(side.height).toBe('calc(100dvh - var(--shell-top))');
    // …and the menu in it, scrolling within itself.
    const nav = ruleOf('.settings-nav');
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

/** The stylesheet's rules, comments stripped: each selector of a list, and the declarations. */
const RULES = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
  (m) => ({
    selectors: (m[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
    body: m[2] ?? '',
  }),
);

/** Every rule whose selector list names exactly `selector`: its declarations, merged in order. */
function rulesNaming(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES.filter((x) => x.selectors.includes(selector))) {
    for (const decl of r.body.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
  }
  return out;
}

describe('every Settings page at the full width beside the menu (0.9.0)', () => {
  it('the page beside the menu has no max-width, at both wide layouts', () => {
    // The shell's pages are a form's width (720 px) by default…
    expect(rulesNaming('.shell-wide .page')['max-width']).toBe('720px');
    // …and Settings' page, three classes to that rule's two, spans the width.
    for (const shell of ['.shell-wide', '.shell-mid']) {
      expect(rulesNaming(`${shell} .settings-area > .page`)['max-width']).toBe('none');
    }
  });

  it('nothing gives a Settings page a max-width back', () => {
    const offenders = RULES.filter((r) =>
      r.body
        .split(';')
        .some((d) => /^\s*max-width\s*:/.test(d) && d.split(':')[1]?.trim() !== 'none'),
    )
      .flatMap((r) => r.selectors)
      // A rule for the page itself: .settings-page, or the page in the area.
      .filter((s) => /\.settings-page$|\.settings-area > \.page$|\.settings-area \.page$/.test(s));
    expect(offenders).toEqual([]);
  });

  it('the menu has no width of its own in the stylesheet: its person’s, from the line beside it', () => {
    expect(ruleOf('.settings-nav').width).toBeUndefined();
    expect(rulesNaming('.shell-mid .settings-nav').width).toBeUndefined();
    const line = ruleOf('.settings-resizer');
    expect(line.cursor).toBe('col-resize');
    expect(line['touch-action']).toBe('none');
  });
});
