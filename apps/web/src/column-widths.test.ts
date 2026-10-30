import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLUMN_SIZES,
  columnWidths,
  columnWidthsKey,
  fitWidth,
  HEAD_CHROME,
  readKeptWidths,
  TITLE_SHARE,
  writeKeptWidths,
} from './column-widths.js';
import { COLUMNS, PICK_WIDTH, type ColumnKey } from './documents-table.js';

/**
 * The Documents table's widths (0.9.0, TW): each column as wide as what it
 * usually says, its header whole, on one line; the title what is left,
 * within a range; and what each person gave them, kept here.
 */

const ALL = COLUMNS.map((c) => c.key);
/** The ⋯ at each row's end (Documents.tsx's MORE_WIDTH). */
const MORE = 56;
/**
 * The room the columns share at a window this wide, from 1024 px: the
 * window less the sidebar (216 px), the page's padding (48 px), the box's
 * border (2 px), its scroll bar (`bar`), the pick box and the ⋯.
 */
const roomAt = (px: number, bar = 0) => px - 216 - 50 - bar - PICK_WIDTH - MORE;
const sum = (w: Record<string, number>) => Object.values(w).reduce((s, n) => s + n, 0);

/**
 * What each header says, measured in Chromium in Figtree at 12 px, bold,
 * 0.06em apart, in capitals (jsdom has no layout): "WHO SEES IT" is the
 * visibility column's.
 */
const HEADER_TEXT: Record<ColumnKey, number> = {
  title: 35,
  kind: 33,
  person: 53,
  issued: 47,
  expires: 54,
  status: 49,
  visibility: 84,
  location: 68,
  collections: 92,
};
/**
 * What each column usually says, measured the same way at 14 px, with its
 * cell's padding (16 px): the brief's own examples.
 */
const USUAL: Partial<Record<ColumnKey, number>> = {
  kind: 145 + 16, // "Visa / residence permit"
  person: 55 + 16, // "Mansoor"
  issued: 90 + 16, // "28 Sept 2026", figures of one width
  expires: 90 + 16,
  status: 10 + 6 + 149 + 16, // the dot, "Valid for 1 year 1 month" in bold
  visibility: 71 + 16, // "Adults only"
  location: 106 + 16, // "Safe deposit box"
  collections: 78 + 4 + 34 + 16, // a chip, "+2"
};

describe('each column as wide as what it usually says (0.9.0, TW)', () => {
  it('has every header whole, on one line, however narrow it is made or drawn', () => {
    for (const key of ALL) {
      const s = COLUMN_SIZES[key];
      const head = HEADER_TEXT[key] + HEAD_CHROME;
      expect(s.min, key).toBeGreaterThanOrEqual(Math.max(64, head));
      expect(s.tight, key).toBeGreaterThanOrEqual(s.min);
      expect(s.base, key).toBeGreaterThanOrEqual(s.tight);
      expect(s.max, key).toBeGreaterThan(s.base);
    }
    // And at every band, drawn by itself.
    for (const px of [1920, 1650, 1280, 1024, 900]) {
      const w = columnWidths(ALL, roomAt(px));
      for (const key of ALL) {
        expect(w[key], `${key} at ${px}`).toBeGreaterThanOrEqual(HEADER_TEXT[key] + HEAD_CHROME);
      }
    }
  });

  it('starts each column but the title wide enough for what it usually says', () => {
    for (const [key, usual] of Object.entries(USUAL)) {
      expect(COLUMN_SIZES[key as ColumnKey].base, key).toBeGreaterThanOrEqual(usual);
    }
    // A date is never cut short by itself.
    expect(COLUMN_SIZES.issued.tight).toBe(COLUMN_SIZES.issued.base);
    expect(COLUMN_SIZES.expires.tight).toBe(COLUMN_SIZES.expires.base);
  });

  it('at 1,650 px — the owner’s window — fits every column whole, the title what is left', () => {
    for (const bar of [0, 15]) {
      const room = roomAt(1650, bar);
      const w = columnWidths(ALL, room);
      for (const key of ALL) {
        if (key !== 'title') expect(w[key], key).toBeGreaterThanOrEqual(COLUMN_SIZES[key].base);
      }
      expect(w.title).toBeGreaterThanOrEqual(240);
      expect(w.title).toBeLessThanOrEqual(Math.floor(room * TITLE_SHARE));
      // The room filled exactly: no box that scrolls, nothing left over.
      expect(sum(w)).toBe(room);
    }
    expect(columnWidths(ALL, roomAt(1650))).toEqual({
      title: 262,
      kind: 162,
      person: 92,
      issued: 106,
      expires: 106,
      status: 184,
      visibility: 118,
      location: 122,
      collections: 132,
    });
  });

  it('at 1,920 px, caps the title at a quarter of the room and shares the rest by weight', () => {
    const room = roomAt(1920);
    const w = columnWidths(ALL, room);
    expect(w.title).toBe(Math.floor(room * TITLE_SHARE));
    expect(w).toEqual({
      title: 388,
      kind: 196,
      person: 103,
      issued: 117,
      expires: 117,
      status: 206,
      visibility: 129,
      location: 144,
      collections: 154,
    });
    expect(sum(w)).toBe(room);
    // A very wide window: the title still a quarter, the others spread out.
    const huge = columnWidths(ALL, 3000);
    expect(huge.title).toBe(750);
    expect(sum(huge)).toBe(3000);
    expect(huge.kind).toBeGreaterThan(huge.person ?? 0);
  });

  it('at 1,280 and 1,024 px, keeps every column whole and the title at 240 px: the box scrolls sideways', () => {
    for (const px of [1280, 1024]) {
      const room = roomAt(px, 15);
      const w = columnWidths(ALL, room);
      expect(w.title).toBe(240);
      for (const key of ALL) {
        if (key !== 'title') expect(w[key], `${key} at ${px}`).toBe(COLUMN_SIZES[key].base);
      }
      expect(sum(w)).toBeGreaterThan(room);
    }
  });

  it('a little short of room, cuts the others short in proportion, never below their tight width', () => {
    const fits = sumBases() + 240;
    const w = columnWidths(ALL, fits - 40);
    expect(sum(w)).toBe(fits - 40);
    expect(w.title).toBe(240);
    for (const key of ALL) {
      expect(w[key], key).toBeGreaterThanOrEqual(COLUMN_SIZES[key].tight);
      expect(w[key], key).toBeLessThanOrEqual(COLUMN_SIZES[key].base);
    }
    expect(w.kind).toBeLessThan(COLUMN_SIZES.kind.base);
    // The dates are never cut.
    expect(w.issued).toBe(COLUMN_SIZES.issued.base);
  });

  it('gives a hidden column’s room back to the rest', () => {
    const room = roomAt(1650);
    const all = columnWidths(ALL, room);
    const fewer = columnWidths(
      ALL.filter((k) => k !== 'location' && k !== 'collections'),
      room,
    );
    expect(fewer.location).toBeUndefined();
    expect(fewer.collections).toBeUndefined();
    expect(sum(fewer)).toBe(room);
    expect(fewer.title).toBeGreaterThan(all.title ?? 0);
    expect(fewer.kind).toBeGreaterThan(all.kind ?? 0);
    // At 1,280 px, with them hidden, everything fits that did not.
    const narrow = roomAt(1280, 15);
    expect(sum(columnWidths(ALL, narrow))).toBeGreaterThan(narrow);
    expect(
      sum(
        columnWidths(
          ALL.filter((k) => !['location', 'collections', 'visibility'].includes(k)),
          narrow,
        ),
      ),
    ).toBeLessThanOrEqual(narrow);
  });

  it('keeps a width this person gave, within its bounds; the others fill the room', () => {
    const room = roomAt(1650);
    const w = columnWidths(ALL, room, { title: 400 });
    expect(w.title).toBe(400);
    // The others give up what they can, then the table is wider than its box.
    expect(sum(w)).toBeGreaterThanOrEqual(room);
    const narrow = columnWidths(ALL, room, { title: 160 });
    expect(narrow.title).toBe(160);
    expect(sum(narrow)).toBe(room);
    expect(narrow.kind).toBeGreaterThan(COLUMN_SIZES.kind.base);
    // Out of bounds: as near as it may be.
    expect(columnWidths(ALL, room, { title: 20, kind: 5000 })).toMatchObject({
      title: 160,
      kind: 640,
    });
    // Every column theirs, narrower than the room: the table as wide as they are.
    const mine = Object.fromEntries(ALL.map((k) => [k, COLUMN_SIZES[k].min]));
    expect(columnWidths(ALL, room, mine)).toEqual(mine);
  });

  it('fits a column to the widest of what it shows, within its bounds', () => {
    expect(fitWidth('kind', [80, 211.2, 120])).toBe(212);
    expect(fitWidth('kind', [10])).toBe(COLUMN_SIZES.kind.min);
    expect(fitWidth('title', [5000])).toBe(COLUMN_SIZES.title.max);
    expect(fitWidth('person', [])).toBe(COLUMN_SIZES.person.min);
  });
});

function sumBases() {
  return ALL.filter((k) => k !== 'title').reduce((s, k) => s + COLUMN_SIZES[k].base, 0);
}

describe('the widths kept, per person, on this device (0.9.0, TW)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('keeps each person’s apart, and a collection’s table apart from Documents’', () => {
    expect(columnWidthsKey('documents', 'me')).toBe('fdv.documents.columns.me');
    expect(columnWidthsKey('collection', 'me')).toBe('fdv.collection.columns.me');
    expect(columnWidthsKey('documents', null)).toBe('fdv.documents.columns.nobody');
  });

  it('reads back what was kept, within each column’s bounds, and nothing that is not a width', () => {
    const key = columnWidthsKey('documents', 'me');
    writeKeptWidths(key, { title: 300, kind: 200 });
    expect(readKeptWidths(key)).toEqual({ title: 300, kind: 200 });
    localStorage.setItem(
      key,
      JSON.stringify({ title: 5000, kind: 3, person: 'wide', nonsense: 200, status: 150.6 }),
    );
    expect(readKeptWidths(key)).toEqual({ title: 960, kind: 72, status: 151 });
    for (const junk of ['[1,2]', 'null', '"wide"', '{', '']) {
      localStorage.setItem(key, junk);
      expect(readKeptWidths(key), junk).toEqual({});
    }
    // None kept: nothing left there.
    writeKeptWidths(key, {});
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('with storage blocked, starts as it starts and keeps nothing, without failing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readKeptWidths('fdv.documents.columns.me')).toEqual({});
    expect(() => writeKeptWidths('fdv.documents.columns.me', { title: 300 })).not.toThrow();
    expect(() => writeKeptWidths('fdv.documents.columns.me', {})).not.toThrow();
  });
});
