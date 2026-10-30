import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Documents table's columns (0.9.0, TW): one line each, cut short with
 * an ellipsis; each header's line to drag, astride its edge; and the
 * pinned headers over what scrolls under them. jsdom has no layout, so the
 * rules themselves are held to it; Chromium was checked at 1920, 1650,
 * 1280, 1024 and 390 px (the screenshots).
 */
const css = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

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

/** Documents.tsx's HEAD_LAYER: the first header that scrolls; each after it one lower. */
const HEAD_LAYER = 20;

describe('the Documents table’s columns, as styles.css draws them (0.9.0, TW)', () => {
  it('draws each column’s words on one line, cut short with an ellipsis, never wrapped mid-word', () => {
    const cell = rulesNaming('.docs-tbl td:not(.col-title) .clip');
    expect(cell).toMatchObject({
      display: 'block',
      'white-space': 'nowrap',
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
      'overflow-wrap': 'normal',
    });
    expect(rulesNaming('.docs-tbl th')['white-space']).toBe('nowrap');
    // A status's and who-can-see-it's words are cut, not hidden whole.
    expect(rulesNaming('.clip .status').display).toBe('inline');
    expect(rulesNaming('.docs-tbl .clip .vis').display).toBe('inline');
    // A collection's chip gives way; the "+2" never wraps under it.
    expect(rulesNaming('.docs-tbl td .clip.clip-chips')).toMatchObject({ display: 'flex' });
    expect(rulesNaming('.docs-tbl td .clip.clip-chips')['flex-wrap']).not.toBe('wrap');
    expect(rulesNaming('.docs-tbl .clip.clip-chips .chip:first-child')['min-width']).toBe('0');
  });

  it('leaves the app’s other tables’ words as they were: two lines', () => {
    expect(rulesNaming('.clip')).toMatchObject({
      display: '-webkit-box',
      '-webkit-line-clamp': '2',
      'overflow-wrap': 'anywhere',
    });
    // Every new rule is the Documents table's own.
    const added = RULES.flatMap((r) => r.selectors).filter((s) => /col-resize|docs-tbl/.test(s));
    expect(added.length).toBeGreaterThan(0);
    for (const s of added) expect(s, s).toMatch(/^(\.tbl)?\.docs-tbl|^\.col-resize/);
  });

  it('gives each header a line 24 px wide, astride its edge, seen on hover and in focus', () => {
    expect(rulesNaming('.col-resize')).toMatchObject({
      position: 'absolute',
      width: '24px',
      right: '-12px',
      cursor: 'col-resize',
      'touch-action': 'none',
    });
    expect(rulesNaming('.col-resize.col-resize-last').right).toBe('0');
    expect(rulesNaming('.col-resize::before').background).toBe('var(--border-strong)');
    for (const s of ['.col-resize:hover::before', '.col-resize:focus-visible::before']) {
      expect(rulesNaming(s).background, s).toBe('var(--accent)');
    }
    expect(rulesNaming('.col-resize:focus-visible').outline).toBe('2px solid var(--ink)');
  });

  it('keeps the pinned headers over every one that scrolls under them, inside the table’s box', () => {
    for (const s of [
      '.tbl.docs-tbl th.col-pick',
      '.tbl.docs-tbl th.col-title',
      '.tbl.docs-tbl th.col-more',
    ]) {
      expect(Number(rulesNaming(s)['z-index']), s).toBeGreaterThan(HEAD_LAYER);
    }
    // Over `.tbl th.col-more`'s own layer, which comes later in the file.
    expect(Number(rulesNaming('.tbl th.col-more')['z-index'])).toBeLessThan(HEAD_LAYER);
    // Their layers the box's own, never over the page's menus.
    expect(rulesNaming('.docs-tbl-wrap').isolation).toBe('isolate');
  });
});
