import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A document's page at the whole width, its details as wide as the line
 * beside them was left, and its pages zoomed (0.9.0). jsdom has no layout,
 * so the rules themselves are held to it; Chromium was checked at 1920,
 * 1600, 1280, 900 and 390 px (the screenshots).
 */
const css = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

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

describe('a document’s page at the whole width (0.9.0)', () => {
  it('has no max-width from 768 px, at both wide layouts', () => {
    expect(rulesNaming('.shell-wide .page')['max-width']).toBe('720px');
    for (const shell of ['.shell-wide', '.shell-mid']) {
      expect(rulesNaming(`${shell} .page.doc-panes`)['max-width']).toBe('none');
    }
  });

  it('nothing gives it a max-width back', () => {
    const offenders = RULES.filter((r) =>
      r.body
        .split(';')
        .some((d) => /^\s*max-width\s*:/.test(d) && d.split(':')[1]?.trim() !== 'none'),
    )
      .flatMap((r) => r.selectors)
      .filter((s) => /\.doc-panes$|\.doc-split$/.test(s));
    expect(offenders).toEqual([]);
  });

  it('the details are as wide as their person left them, the line beside them, the pages the rest', () => {
    const grid = rulesNaming('.doc-panes .doc-split');
    expect(grid['grid-template-columns']).toMatch(
      /^var\(--doc-details-w\b.*\) 16px minmax\(0, 1fr\)$/,
    );
    // No width of the details' own in a layout: one rule, for both.
    expect(
      rulesNaming('.shell-mid .doc-panes .doc-split')['grid-template-columns'],
    ).toBeUndefined();
    const line = rulesNaming('.doc-resizer');
    expect(line.cursor).toBe('col-resize');
    expect(line['align-self']).toBe('stretch');
    expect(line['touch-action']).toBe('none');
  });

  it('the action row flows to the details’ width; Move to the Trash stays at its end', () => {
    expect(rulesNaming('.doc-panes .doc-details .action-btn').flex).toBe('1 1 auto');
    // (Its first rule: on a phone it takes a line of its own, as before.)
    expect(RULES.find((r) => r.selectors.includes('.action-trash'))?.body).toMatch(
      /margin-left:\s*auto/,
    );
    // On a phone, as before: nothing of it is the panes'.
    expect(rulesNaming('.doc-details .action-btn').flex).toBeUndefined();
  });

  it('the pages are the window’s height beside the details, so Fit page fits the window', () => {
    expect(rulesNaming('.doc-panes .doc-pages:has(> .viewer-bar)').height).toBe(
      'calc(100dvh - var(--shell-top, 0px) - 68px)',
    );
    expect(rulesNaming('.doc-panes .doc-pages').position).toBe('sticky');
  });
});

describe('the pages, zoomed (0.9.0)', () => {
  it('zoomed past the pane, they scroll both ways from their left edge: never centred out of reach', () => {
    const viewer = rulesNaming('.viewer');
    expect(viewer.overflow).toBe('auto');
    expect(viewer['justify-content']).toBeUndefined();
    expect(rulesNaming('.viewer > *')['margin-inline']).toBe('auto');
    // A pinch over the page is the viewer's; a finger still scrolls it.
    expect(viewer['touch-action']).toBe('pan-x pan-y');
  });

  it('a scan is never filtered or inverted, in either theme (#144)', () => {
    const filtered = RULES.filter((r) => r.selectors.some((s) => /\.viewer\b/.test(s))).filter(
      (r) => /(^|;)\s*(filter|mix-blend-mode|backdrop-filter)\s*:/.test(r.body),
    );
    expect(filtered.flatMap((r) => r.selectors)).toEqual([]);
    expect(rulesNaming('.viewer img').background).toBe('var(--paper)');
  });

  it('each zoom control is a full target', () => {
    expect(rulesNaming('.viewer-zoom-btn')['min-width']).toBe('var(--tap)');
    expect(rulesNaming('.btn-small')['min-height']).toBe('var(--tap)');
    expect(rulesNaming('.viewer-zoom-at')['min-width']).toBe('64px');
  });
});
