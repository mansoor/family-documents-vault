import { describe, expect, it } from 'vitest';
import {
  CABINET_LIMITS,
  CABINET_TOO_BIG,
  folderQuestionWords,
  layoutProblem,
  mergedName,
  mergeFolderFilters,
  rangeWords,
  type CabinetDrawer,
  type CabinetFolder,
  type CabinetLayout,
} from './cabinet.js';
import { addToDrawing, drawCabinet, type CabinetGroup } from './cabinet-draw.js';

/** My cabinet (0.9.0, C1): what the vault, the client's fake and the web share. */

const year = new Date().getUTCFullYear();
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};
const names = {
  person: (id: string) =>
    ({ olive: 'Olive', sam: 'Sam', household: 'The household', none: 'Not sure yet' })[id] ?? id,
  kind: (key: string) =>
    ({ tax_form: 'W-2', passport: 'Passport', payslip: 'Payslip' })[key] ?? key,
  personOrder: (a: string, b: string) =>
    ['olive', 'sam', 'household', 'none'].indexOf(a) -
    ['olive', 'sam', 'household', 'none'].indexOf(b),
};
/** A household: Olive's tax forms over two years, Sam's payslip and passport, the household's bill, a scan with no topic. */
const HOUSEHOLD: CabinetGroup[] = [
  { person: 'olive', category: 'tax', type_key: 'tax_form', year, n: 2 },
  { person: 'olive', category: 'tax', type_key: 'tax_form', year: year - 1, n: 1 },
  { person: 'sam', category: 'work', type_key: 'payslip', year, n: 3 },
  { person: 'sam', category: 'identity', type_key: 'passport', year: year - 3, n: 1 },
  { person: 'household', category: 'bills', type_key: 'utility_bill', year, n: 1 },
  { person: 'none', category: null, type_key: null, year, n: 2 },
];
const shape = (l: CabinetLayout, counts: Record<string, number>) =>
  l.cabinets.map((c) => [
    c.name,
    c.drawers.map((d) => [d.name, d.folders.map((f) => `${f.name}:${counts[f.id] ?? '?'}`)]),
  ]);

describe('Arrange by', () => {
  it('by person, then topic, then year', () => {
    const d = drawCabinet(['person', 'topic', 'year'], HOUSEHOLD, names, ids());
    expect(shape(d.layout, d.counts)).toEqual([
      ['Olive', [['Tax', [`${year}:2`, `${year - 1}:1`]]]],
      [
        'Sam',
        [
          ['Identity', [`${year - 3}:1`]],
          ['Work', [`${year}:3`]],
        ],
      ],
      ['The household', [['Bills & utilities', [`${year}:1`]]]],
    ]);
    expect(d.documents).toBe(10);
    expect(d.left_out).toBe(2);
    expect(d.layout.cabinets[0]?.drawers[0]?.folders[1]?.filter).toEqual({
      notes: 'exclude',
      member_id: 'olive',
      category: 'tax',
      dated_from: `${year - 1}-01-01`,
      dated_to: `${year - 1}-12-31`,
    });
  });

  it('by topic, then year, then person: a Tax cabinet with a drawer for each year', () => {
    const d = drawCabinet(['topic', 'year', 'person'], HOUSEHOLD, names, ids());
    expect(shape(d.layout, d.counts)).toEqual([
      ['Identity', [[String(year - 3), ['Sam:1']]]],
      [
        'Tax',
        [
          [String(year), ['Olive:2']],
          [String(year - 1), ['Olive:1']],
        ],
      ],
      ['Bills & utilities', [[String(year), ['The household:1']]]],
      ['Work', [[String(year), ['Sam:3']]]],
    ]);
  });

  it('by person, then kind: one cabinet, a drawer for each person', () => {
    const d = drawCabinet(['person', 'kind'], HOUSEHOLD, names, ids());
    expect(shape(d.layout, d.counts)).toEqual([
      [
        'My cabinet',
        [
          ['Olive', ['W-2:3']],
          ['Sam', ['Passport:1', 'Payslip:3']],
          ['The household', ['utility_bill:1']],
        ],
      ],
    ]);
    expect(d.left_out).toBe(2);
    expect(d.layout.cabinets[0]?.drawers[1]?.folders[0]?.filter).toEqual({
      notes: 'exclude',
      member_id: 'sam',
      type_key: 'passport',
    });
  });

  it('draws nothing from nothing', () => {
    const d = drawCabinet(['person', 'topic', 'year'], [], names, ids());
    expect(d.layout.cabinets).toEqual([]);
    expect(d.documents).toBe(0);
  });
});

describe('a drawn cabinet kept up to date', () => {
  /** The owner's 19 Nov cabinet: drawn before the financial papers were added. */
  const BEFORE: CabinetGroup[] = HOUSEHOLD.filter((g) => g.category !== 'work');
  const newIds = () => {
    let n = 0;
    return () => `new${++n}`;
  };

  it('adds a cabinet for a topic that is new, in the drawing’s order: the 19 Nov bug', () => {
    const drawn = drawCabinet(['topic', 'year', 'person'], BEFORE, names, ids()).layout;
    expect(drawn.cabinets.map((c) => c.name)).toEqual(['Identity', 'Tax', 'Bills & utilities']);
    // Sam's bank statement and payslip, Sensitive and kept to the adults, added since.
    const later: CabinetGroup[] = [
      { person: 'sam', category: 'financial', type_key: 'bank_statement', year, n: 1 },
      { person: 'sam', category: 'financial', type_key: 'pay_statement', year, n: 1 },
    ];
    const kept = addToDrawing(drawn, later, names, newIds());
    expect(kept.added).toBe(1);
    expect(kept.layout.cabinets.map((c) => c.name)).toEqual([
      'Identity',
      'Financial',
      'Tax',
      'Bills & utilities',
    ]);
    const financial = kept.layout.cabinets[1];
    expect(financial?.drawers.map((d) => [d.name, d.folders.map((f) => f.name)])).toEqual([
      [String(year), ['Sam']],
    ]);
    expect(financial?.drawers[0]?.folders[0]?.filter).toEqual({
      notes: 'exclude',
      category: 'financial',
      dated_from: `${year}-01-01`,
      dated_to: `${year}-12-31`,
      member_id: 'sam',
    });
    // Everything already there is as it was.
    expect(kept.layout.cabinets.filter((c) => c.name !== 'Financial')).toEqual(drawn.cabinets);
  });

  it('adds a year to the topic’s own cabinet, and a person to the year’s own drawer, even renamed', () => {
    const drawn = drawCabinet(['topic', 'year', 'person'], BEFORE, names, ids()).layout;
    const tax = drawn.cabinets.find((c) => c.name === 'Tax') as (typeof drawn.cabinets)[number];
    tax.name = 'Taxes';
    const kept = addToDrawing(
      drawn,
      [
        { person: 'olive', category: 'tax', type_key: 'tax_form', year: year + 1, n: 1 },
        { person: 'sam', category: 'tax', type_key: 'tax_form', year, n: 1 },
      ],
      names,
      newIds(),
    );
    expect(kept.added).toBe(2);
    const taxes = kept.layout.cabinets.find((c) => c.name === 'Taxes');
    expect(taxes?.drawers.map((d) => [d.name, d.folders.map((f) => f.name)])).toEqual([
      [String(year + 1), ['Olive']],
      [String(year), ['Olive', 'Sam']],
      [String(year - 1), ['Olive']],
    ]);
    expect(kept.layout.cabinets).toHaveLength(3);
  });

  it('by person, then kind: a new kind in the person’s drawer, a new person a drawer of their own', () => {
    const drawn = drawCabinet(['person', 'kind'], BEFORE, names, ids()).layout;
    const kept = addToDrawing(
      drawn,
      [
        { person: 'olive', category: 'identity', type_key: 'passport', year, n: 1 },
        { person: 'none', category: 'other', type_key: 'payslip', year, n: 1 },
      ],
      names,
      newIds(),
    );
    expect(kept.added).toBe(2);
    expect(
      shape(kept.layout, {}).map(([c, ds]) => [c, (ds as unknown[][]).map((d) => d[0])]),
    ).toEqual([['My cabinet', ['Olive', 'Sam', 'The household', 'Not sure yet']]]);
    expect(kept.layout.cabinets[0]?.drawers[0]?.folders.map((f) => f.name)).toEqual([
      'Passport',
      'W-2',
    ]);
  });

  it('never changes a cabinet arranged by hand, nor files a paper with no topic', () => {
    const drawn = drawCabinet(['topic', 'year', 'person'], BEFORE, names, ids()).layout;
    const later: CabinetGroup[] = [
      { person: 'sam', category: 'financial', type_key: 'bank_statement', year, n: 1 },
    ];
    const byHand = { ...drawn, levels: null };
    expect(addToDrawing(byHand, later, names, newIds())).toEqual({
      layout: byHand,
      added: 0,
      left: 0,
    });
    const noTopic: CabinetGroup[] = [
      { person: 'none', category: null, type_key: null, year, n: 2 },
    ];
    expect(addToDrawing(drawn, noTopic, names, newIds()).added).toBe(0);
  });

  it('finds a merged drawer by any of its folders: no drawer beside it', () => {
    const drawn = drawCabinet(['person', 'topic', 'year'], HOUSEHOLD, names, ids()).layout;
    // Sam's Identity and Work drawers merged, as Arrange my cabinet merges them.
    const sam = drawn.cabinets[1] as (typeof drawn.cabinets)[number];
    const [identity, work] = sam.drawers as [CabinetDrawer, CabinetDrawer];
    sam.drawers = [
      { ...identity, name: 'Identity and Work', folders: [...identity.folders, ...work.folders] },
    ];
    const kept = addToDrawing(
      drawn,
      [{ person: 'sam', category: 'work', type_key: 'payslip', year: year + 1, n: 1 }],
      names,
      newIds(),
    );
    expect(kept.added).toBe(1);
    const after = kept.layout.cabinets[1];
    expect(after?.drawers.map((d) => [d.name, d.folders.map((f) => f.name)])).toEqual([
      ['Identity and Work', [String(year + 1), String(year - 3), String(year)]],
    ]);
  });

  it('finds a drawer whose folder asks several topics, merged into one', () => {
    const drawn = drawCabinet(['person', 'topic', 'year'], HOUSEHOLD, names, ids()).layout;
    const sam = drawn.cabinets[1] as (typeof drawn.cabinets)[number];
    const [identity] = sam.drawers as [CabinetDrawer];
    sam.drawers = [
      {
        ...identity,
        name: 'Papers',
        folders: [
          {
            ...(identity.folders[0] as CabinetFolder),
            filter: { ...identity.folders[0]?.filter, category: 'identity,work' },
          },
        ],
      },
    ];
    const kept = addToDrawing(
      drawn,
      [{ person: 'sam', category: 'work', type_key: 'payslip', year: year + 2, n: 1 }],
      names,
      newIds(),
    );
    expect(kept.layout.cabinets[1]?.drawers.map((d) => d.name)).toEqual(['Papers']);
    expect(kept.layout.cabinets[1]?.drawers[0]?.folders).toHaveLength(2);
  });

  it('adds up to what a cabinet may hold, and leaves the rest in no folder', () => {
    const kinds = Array.from({ length: CABINET_LIMITS.folders + 2 }, (_, i) => `k${i}`);
    const full = drawCabinet(
      ['person', 'kind'],
      kinds
        .slice(0, CABINET_LIMITS.folders - 1)
        .map((type_key) => ({ person: 'olive', category: 'other', type_key, year, n: 1 })),
      names,
      ids(),
    ).layout;
    const kept = addToDrawing(
      full,
      kinds
        .slice(CABINET_LIMITS.folders - 1)
        .map((type_key) => ({ person: 'olive', category: 'other', type_key, year, n: 1 })),
      names,
      newIds(),
    );
    expect([kept.added, kept.left]).toEqual([1, 2]);
    expect(kept.layout.cabinets[0]?.drawers[0]?.folders).toHaveLength(CABINET_LIMITS.folders);
    expect(layoutProblem(kept.layout)).toBeNull();
  });

  it('never names a part with " › ", which joins a place’s names', () => {
    const drawn = drawCabinet(['person', 'topic', 'year'], BEFORE, names, ids()).layout;
    const kept = addToDrawing(
      drawn,
      [{ person: 'ann', category: 'tax', type_key: 'tax_form', year, n: 1 }],
      { ...names, person: (id) => (id === 'ann' ? 'Ann › Lee' : names.person(id)) },
      newIds(),
    );
    const names_ = kept.layout.cabinets.map((c) => c.name);
    expect(names_).toContain('Ann - Lee');
    expect(names_.join()).not.toContain(' › ');
  });
});

describe('merging two folders', () => {
  it('joins people, kinds or topics: any of them', () => {
    expect(
      mergeFolderFilters({ member_id: 'a', category: 'tax' }, { member_id: 'b', category: 'tax' }),
    ).toEqual({
      member_id: 'a,b',
      category: 'tax',
    });
    expect(mergeFolderFilters({ tag: 'x' }, { tag: ['y', 'x'] })).toEqual({ tag: ['x', 'y'] });
  });

  it('joins years that meet or overlap, never with a gap', () => {
    const y = (a: number, b = a) => ({
      category: 'tax',
      dated_from: `${a}-01-01`,
      dated_to: `${b}-12-31`,
    });
    expect(mergeFolderFilters(y(2025), y(2024))).toEqual(y(2024, 2025));
    expect(mergeFolderFilters(y(2020, 2023), y(2022, 2025))).toEqual(y(2020, 2025));
    expect(mergeFolderFilters(y(2025), y(2023))).toBeNull();
    // One with no end stays open.
    expect(mergeFolderFilters({ dated_from: '2024-01-01' }, y(2020))).toBeNull();
    expect(
      mergeFolderFilters(
        { dated_from: '2021-01-01' },
        { dated_from: '2020-01-01', dated_to: '2020-12-31' },
      ),
    ).toEqual({ dated_from: '2020-01-01' });
  });

  it('refuses two that differ in more than one thing; the wider stands for one inside it', () => {
    expect(
      mergeFolderFilters({ member_id: 'a', category: 'tax' }, { member_id: 'b', category: 'work' }),
    ).toBeNull();
    expect(mergeFolderFilters({ category: 'tax' }, { category: 'tax', member_id: 'a' })).toEqual({
      category: 'tax',
    });
    expect(mergeFolderFilters({ category: 'tax' }, { category: 'tax' })).toEqual({
      category: 'tax',
    });
  });

  it('names the two as one', () => {
    expect(mergedName('2025', '2024')).toBe('2025 and 2024');
    expect(mergedName('Tax', 'tax')).toBe('Tax');
    expect(mergedName('x'.repeat(CABINET_LIMITS.name - 2), 'yy')).toBe(
      'x'.repeat(CABINET_LIMITS.name - 2),
    );
  });
});

describe('a layout', () => {
  const one = (over: Partial<{ id: string; name: string }> = {}): CabinetLayout => ({
    levels: null,
    cabinets: [
      {
        id: 'c',
        name: 'C',
        hidden: false,
        drawers: [
          {
            id: 'd',
            name: 'D',
            hidden: false,
            folders: [{ id: over.id ?? 'f', name: over.name ?? 'F', hidden: false, filter: {} }],
          },
        ],
      },
    ],
  });

  it('needs names and ids of its own, within its sizes', () => {
    expect(layoutProblem(one())).toBeNull();
    expect(layoutProblem(one({ id: 'd' }))).toMatch(/own id/);
    expect(layoutProblem(one({ id: 'a b' }))).toMatch(/own id/);
    expect(layoutProblem(one({ name: ' ' }))).toMatch(/needs a name/);
    expect(layoutProblem(one({ name: 'x'.repeat(CABINET_LIMITS.name + 1) }))).toMatch(/80/);
    const big = one();
    const drawer = big.cabinets[0]?.drawers[0];
    if (drawer) {
      drawer.folders = Array.from({ length: CABINET_LIMITS.folders + 1 }, (_, i) => ({
        id: `f${i}`,
        name: 'F',
        hidden: false,
        filter: {},
      }));
    }
    expect(layoutProblem(big)).toBe(CABINET_TOO_BIG);
  });
});

describe('in words', () => {
  it('says what a folder holds', () => {
    const words = { person: () => 'Olive', kind: () => 'W-2' };
    expect(
      folderQuestionWords(
        { category: 'tax', member_id: 'o', dated_from: '2025-01-01', dated_to: '2025-12-31' },
        words,
      ),
    ).toBe('Tax papers dated 2025, for Olive.');
    expect(folderQuestionWords({ type_key: 'tax_form', member_id: 'o' }, words)).toBe(
      'W-2, for Olive.',
    );
    expect(rangeWords('2023-01-01', '2025-12-31')).toBe('2023 to 2025');
    expect(rangeWords('2023-03-04', undefined)).toBe('since 4 Mar 2023');
  });
});
