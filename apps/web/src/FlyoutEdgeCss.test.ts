import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAY_WIDTH } from './flyout-store.js';

/**
 * The edge of the document beside the list, alone (0.9.0-dev.88): where it
 * can be taken hold of is inside the pane, from its left border inwards,
 * so nothing of it lies over the list. jsdom has no layout, so the rules
 * themselves are held to it, at the pane's width as any window works it
 * out (--pane-w): the edge's left is the window less its `right` and its
 * width, and the pane's left is the window less the tray and --pane-w.
 */
const css = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})().replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  media: string | null;
  selectors: string[];
  decls: Record<string, string>;
}

/** The stylesheet's rules, those inside an @media with its condition. */
const RULES: Rule[] = (() => {
  const out: Rule[] = [];
  const declsOf = (body: string) => {
    const decls: Record<string, string> = {};
    for (const d of body.split(';')) {
      const at = d.indexOf(':');
      if (at > 0)
        decls[d.slice(0, at).trim()] = d
          .slice(at + 1)
          .trim()
          .replace(/\s+/g, ' ');
    }
    return decls;
  };
  const selectorsOf = (head: string) => head.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    if (head.startsWith('@media')) {
      // Its rules, one level in, to the brace that closes it.
      let j = open + 1;
      for (;;) {
        const next = css.indexOf('{', j);
        const shut = css.indexOf('}', j);
        if (shut < 0) break;
        if (next < 0 || shut < next) {
          j = shut + 1;
          break;
        }
        const close = css.indexOf('}', next);
        out.push({
          media: head,
          selectors: selectorsOf(css.slice(j, next)),
          decls: declsOf(css.slice(next + 1, close)),
        });
        j = close + 1;
      }
      i = j;
      continue;
    }
    const close = css.indexOf('}', open);
    out.push({
      media: null,
      selectors: selectorsOf(head),
      decls: declsOf(css.slice(open + 1, close)),
    });
    i = close + 1;
  }
  return out;
})();

/** The declarations for `selector`, outside any @media or in the one named, merged in order. */
function rule(selector: string, media: string | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES) {
    if (r.media !== media || !r.selectors.includes(selector)) continue;
    Object.assign(out, r.decls);
  }
  return out;
}

const px = (v: string | undefined) => {
  const m = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(v ?? '');
  return m ? Number(m[1]) : NaN;
};

/**
 * Where the edge takes hold, from the pane's left border (0) inwards, at a
 * pane `paneW` wide and a tray TRAY_WIDTH wide: its `right` must be
 * calc(var(--tray-now, 0px) + var(--pane-w) - N).
 */
function spanOf(decls: Record<string, string>, paneW: number): [number, number] {
  const m = /^calc\(var\(--tray-now, 0px\) \+ var\(--pane-w\) - (\d+(?:\.\d+)?)px\)$/.exec(
    decls.right ?? '',
  );
  expect(m, `right: ${decls.right}`).not.toBeNull();
  const viewport = 1280;
  const right = TRAY_WIDTH + paneW - Number(m?.[1]);
  const width = px(decls.width);
  const left = viewport - right - width;
  const paneLeft = viewport - TRAY_WIDTH - paneW;
  return [left - paneLeft, left - paneLeft + width];
}

const COARSE = '@media (pointer: coarse)';

describe('the edge of the document beside the list (0.9.0-dev.88)', () => {
  it('is fixed, as wide as the pane says, under the bar on top to the foot', () => {
    const edge = rule('.flyout-edge');
    expect(edge.position).toBe('fixed');
    expect(edge.top).toBe('var(--shell-top, 0px)');
    expect(edge.bottom).toBe('0');
    expect(edge['touch-action']).toBe('none');
  });

  it('takes hold only inside the pane: none of it over the list, none past its left padding', () => {
    const padding = rule('.flyout').padding?.split(' ') ?? [];
    // padding: top, sides, bottom.
    const paddingLeft = px(padding[1]);
    expect(paddingLeft).toBe(20);
    for (const paneW of [360, 794, 1068]) {
      const [from, to] = spanOf(rule('.flyout-edge'), paneW);
      expect(from).toBe(0);
      expect(to).toBe(12);
      expect(to).toBeLessThanOrEqual(paddingLeft);
    }
  });

  it('a finger takes hold of 24 px, from the border inwards, within the padding the pane keeps then', () => {
    const coarse = { ...rule('.flyout-edge'), ...rule('.flyout-edge', COARSE) };
    const paddingLeft = px(
      rule('.flyout:not(.flyout-side):not(.flyout-full)', COARSE)['padding-left'],
    );
    expect(paddingLeft).toBe(24);
    for (const paneW of [360, 794, 1068]) {
      const [from, to] = spanOf(coarse, paneW);
      expect(from).toBe(0);
      expect(to).toBe(24);
      expect(to).toBeLessThanOrEqual(paddingLeft);
    }
  });

  it('its line and its grip on the border, never left of it', () => {
    for (const media of [null, COARSE]) {
      for (const part of ['.flyout-edge::before', '.flyout-edge::after']) {
        const left = rule(part, media).left;
        if (left === undefined) continue;
        expect(px(left), `${part} ${media ?? ''}`).toBe(0);
      }
    }
    expect(px(rule('.flyout-edge::before').width)).toBe(2);
    expect(rule('.flyout-edge::before').left).toBe('0');
  });
});
