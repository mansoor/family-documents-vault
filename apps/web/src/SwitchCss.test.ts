import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A switch keeps its own shape inside a form's field (0.9.0, the owner's
 * report of 30 Oct 2026: "the toggle control is appearing as a square").
 * `.field input` gives a text box its tap height and padding; a switch in a
 * `.field` (Switch without a word: Edit's "No longer needed", Add a kind's
 * "Required") took both, and its 48 × 28 track was drawn 48 × 44. jsdom has
 * no layout, so the rules themselves are held to it.
 */
const css = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

/** Every rule whose selector list names exactly `selector`: its declarations, merged in order. */
function rulesNaming(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const decl of (m[2] ?? '').split(';')) {
      const at = decl.indexOf(':');
      if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
  }
  return out;
}

/** What gives a box its size and shape. */
const SHAPE =
  /^(width|height|min-width|min-height|max-width|max-height|padding(-.+)?|border-radius)$/;

describe('a switch inside a form field', () => {
  it('sets every part of its shape that a field’s input would give it', () => {
    const field = rulesNaming('.field input');
    const own = rulesNaming('.switch input');
    expect(Object.keys(field).length).toBeGreaterThan(0);
    const given = Object.keys(field).filter((p) => SHAPE.test(p));
    // .field input sets min-height and padding today; whatever else it sets later, too.
    expect(given).toEqual(expect.arrayContaining(['min-height', 'padding']));
    expect(given.filter((p) => !(p in own))).toEqual([]);
  });

  it('is a 48 × 28 track, fully rounded, with no tap height or padding of its own', () => {
    const own = rulesNaming('.switch input');
    expect(own).toMatchObject({
      width: '48px',
      height: '28px',
      'min-height': '0',
      padding: '0',
      'border-radius': '14px',
    });
  });
});
