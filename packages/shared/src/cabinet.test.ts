import { describe, expect, it } from 'vitest';
import {
  CABINET_LIMITS,
  CABINET_TOO_BIG,
  folderQuestionWords,
  layoutProblem,
  mergedName,
  mergeFolderFilters,
  rangeWords,
  type CabinetLayout,
} from './cabinet.js';
import { drawCabinet, type CabinetGroup } from './cabinet-draw.js';

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
    const d = drawCabinet('person_category_year', HOUSEHOLD, names, ids());
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
    const d = drawCabinet('category_year_person', HOUSEHOLD, names, ids());
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
    const d = drawCabinet('person_kind', HOUSEHOLD, names, ids());
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
    const d = drawCabinet('person_category_year', [], names, ids());
    expect(d.layout.cabinets).toEqual([]);
    expect(d.documents).toBe(0);
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
    arranged_by: null,
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
