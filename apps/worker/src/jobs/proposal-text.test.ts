import { describe, expect, it } from 'vitest';
import { forProposal, PROPOSAL_TEXT_MAX } from './read-item.js';
import { layoutText, type OcrWord } from './scan-read.js';

/**
 * What a proposal reads of a long scan (0.9.0, R3, the review): laid out in
 * its rows, a scanned page is two or three times its words, and the first
 * PROPOSAL_TEXT_MAX characters would end ten pages or so in. A long file's
 * runs of space are made three first, so its later pages are read too.
 */

/** A page of a statement: rows of a label far left and a value far right. */
const page = (n: number, last: boolean): string => {
  const words: OcrWord[] = [];
  for (let row = 0; row < 40; row += 1) {
    const top = 100 + row * 40;
    const label = last && row === 39 ? 'Payment due by' : `Transaction ${n}-${row} at the shop`;
    const value = last && row === 39 ? '29/04/2026' : `£${row}.${n}0`;
    let x = 100;
    for (const t of label.split(' ')) {
      words.push({
        block: 2 * row + 1,
        par: 1,
        line: 1,
        left: x,
        top,
        width: t.length * 20,
        height: 30,
        conf: 95,
        text: t,
      });
      x += t.length * 20 + 20;
    }
    words.push({
      block: 2 * row + 2,
      par: 1,
      line: 1,
      left: 2200,
      top,
      width: value.length * 20,
      height: 30,
      conf: 95,
      text: value,
    });
  }
  return layoutText(words);
};

describe('what a proposal reads of a long scan (R3)', () => {
  it('a date on a late page of a long scan is still read; a file that fits is read as it is', () => {
    const pages = Array.from({ length: 20 }, (_, i) => page(i + 1, i === 19));
    const text = pages.join('\n\n');
    expect(text.length).toBeGreaterThan(PROPOSAL_TEXT_MAX);
    // As it was: the last page is past what is read.
    expect(text.slice(0, PROPOSAL_TEXT_MAX)).not.toContain('29/04/2026');
    const read = forProposal(text);
    expect(read.length).toBeLessThanOrEqual(PROPOSAL_TEXT_MAX);
    expect(read).toMatch(/Payment due by {3}29\/04\/2026/);
    // Columns still parted by three spaces, as the rules read them.
    expect(read).not.toMatch(/ {4}/);
    const short = pages[0] as string;
    expect(forProposal(short)).toBe(short);
  });
});
