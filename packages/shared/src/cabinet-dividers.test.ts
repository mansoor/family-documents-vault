import { describe, expect, it } from 'vitest';
import {
  asksOneYear,
  daySpanWords,
  isDay,
  isDividerEnd,
  resolvedRanges,
  dividerKeyOf,
  dividerMode,
  dividersProblemOf,
  rangesNewestFirst,
  schoolStages,
  dividerDims,
  shownDividers,
  type FolderDividers,
} from './cabinet-dividers.js';
import { layoutProblemOf, type CabinetLayout } from './cabinet.js';

/** Dividers in a cabinet's folder (0.9.0, C2): the rules the vault, the fakes and the web share. */

/** A paper of a day, as the dividers read it. */
const paper = (day: string) => ({ day, type_key: null, category: null, person: 'me' });

const SCHOOL: FolderDividers = {
  levels: ['year'],
  ranges: [
    { name: 'Elementary', from: '2014-09-01', to: '2020-08-31' },
    { name: 'College', from: '2027-09-01', to: null },
    { name: 'Middle school', from: '2020-09-01', to: '2023-08-31' },
  ],
};

describe('dividers', () => {
  it('are years unless turned off, and ranges replace them', () => {
    expect(dividerMode(undefined)).toBe('years');
    expect(dividerMode({ levels: ['kind', 'year'], ranges: [] })).toBe('levels');
    expect(dividerMode({ levels: [], ranges: [] })).toBe('none');
    expect(dividerMode({ levels: [], ranges: SCHOOL.ranges })).toBe('ranges');
  });

  it('put each day behind one divider: its year, its range, or Other years', () => {
    expect(dividerKeyOf({ filter: {}, dividers: undefined }, paper('2025-03-01'))).toBe(
      'year:2025',
    );
    expect(
      dividerKeyOf({ filter: {}, dividers: { levels: [], ranges: [] } }, paper('2025-03-01')),
    ).toBe('all');
    expect(dividerKeyOf({ filter: {}, dividers: SCHOOL }, paper('2020-08-31'))).toBe('range:0');
    expect(dividerKeyOf({ filter: {}, dividers: SCHOOL }, paper('2020-09-01'))).toBe('range:2');
    expect(dividerKeyOf({ filter: {}, dividers: SCHOOL }, paper('2040-01-01'))).toBe('range:1');
    expect(dividerKeyOf({ filter: {}, dividers: SCHOOL }, paper('2024-01-01'))).toBe('other');
    expect(dividerKeyOf({ filter: {}, dividers: SCHOOL }, paper('2001-01-01'))).toBe('other');
  });

  it('are listed newest first, whatever order they were made in', () => {
    expect(rangesNewestFirst(SCHOOL).map((r) => [r.key, r.range.name])).toEqual([
      ['range:1', 'College'],
      ['range:2', 'Middle school'],
      ['range:0', 'Elementary'],
    ]);
  });

  it('refuse ranges that share a day, are not ranges, or are too many, each by its code', () => {
    expect(dividersProblemOf(SCHOOL)).toBeNull();
    const code = (ranges: FolderDividers['ranges']) =>
      dividersProblemOf({ levels: ['year'], ranges })?.code;
    expect(
      code([
        { name: 'A', from: '2014-01-01', to: '2020-12-31' },
        { name: 'B', from: '2020-12-31', to: null },
      ]),
    ).toBe('cabinet_divider_overlap');
    // Open at its start, it reaches back as far as there is.
    expect(
      code([
        { name: 'A', from: null, to: '2010-01-01' },
        { name: 'B', from: '2009-01-01', to: '2009-12-31' },
      ]),
    ).toBe('cabinet_divider_overlap');
    expect(
      code([
        { name: 'A', from: null, to: '2010-01-01' },
        { name: 'B', from: '2010-01-02', to: null },
      ]),
    ).toBeUndefined();
    expect(code([{ name: 'A', from: null, to: null }])).toBe('cabinet_divider_dates');
    expect(code([{ name: 'A', from: '2021-02-29', to: null }])).toBe('cabinet_divider_dates');
    expect(code([{ name: 'A', from: '2022-01-01', to: '2021-01-01' }])).toBe(
      'cabinet_divider_dates',
    );
    expect(code([{ name: ' ', from: '2022-01-01', to: null }])).toBe(
      'cabinet_divider_name_missing',
    );
    expect(code([{ name: 'é'.repeat(81), from: '2022-01-01', to: null }])).toBe(
      'cabinet_divider_name_too_long',
    );
    expect(
      code(
        Array.from({ length: 21 }, (_, i) => ({
          name: `Y${i}`,
          from: `${2000 + i}-01-01`,
          to: `${2000 + i}-12-31`,
        })),
      ),
    ).toBe('cabinet_too_many_dividers');
  });

  it('are checked with the layout, the folder named', () => {
    const layout: CabinetLayout = {
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
              folders: [
                {
                  id: 'f',
                  name: 'School',
                  hidden: false,
                  filter: {},
                  dividers: { levels: ['year'], ranges: [{ name: 'A', from: null, to: null }] },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(layoutProblemOf(layout)).toMatchObject({
      code: 'cabinet_divider_dates',
      message: expect.stringMatching(/^The folder “School”: The divider “A”/) as unknown,
    });
  });

  it('take a year or a full date, from 1000 to 9999 alone', () => {
    expect(isDividerEnd('2014')).toBe(true);
    expect(isDividerEnd('2014-09-01')).toBe(true);
    for (const bad of ['201', '0000', '0999', '0000-01-01', '2014-02-30', '2014-9-1', '10000']) {
      expect(isDividerEnd(bad), bad).toBe(false);
    }
    expect(isDay('0000-01-01')).toBe(false);
    expect(isDay('9999-12-31')).toBe(true);
    expect(
      dividersProblemOf({ levels: ['year'], ranges: [{ name: 'A', from: '0000-01-01', to: null }] })
        ?.code,
    ).toBe('cabinet_divider_dates');
  });

  it('give a shared year, typed as years on both sides, to the later range: the owner’s own example', () => {
    const owner: FolderDividers = {
      levels: ['year'],
      ranges: [
        { name: 'Elementary', from: '2014', to: '2020' },
        { name: 'Middle school', from: '2020', to: '2023' },
        { name: 'High school', from: '2023', to: '2027' },
        { name: 'College', from: '2027', to: null },
      ],
    };
    expect(dividersProblemOf(owner)).toBeNull();
    expect(resolvedRanges(owner)).toEqual([
      { from: '2014-01-01', to: '2019-12-31' },
      { from: '2020-01-01', to: '2022-12-31' },
      { from: '2023-01-01', to: '2026-12-31' },
      { from: '2027-01-01', to: null },
    ]);
    expect(dividerKeyOf({ filter: {}, dividers: owner }, paper('2019-12-31'))).toBe('range:0');
    expect(dividerKeyOf({ filter: {}, dividers: owner }, paper('2020-01-01'))).toBe('range:1');
    expect(dividerKeyOf({ filter: {}, dividers: owner }, paper('2026-06-01'))).toBe('range:2');
    expect(dividerKeyOf({ filter: {}, dividers: owner }, paper('2031-06-01'))).toBe('range:3');
    expect(daySpanWords(resolvedRanges(owner)[0] as { from: string; to: string })).toBe(
      '1 Jan 2014 – 31 Dec 2019',
    );
    expect(daySpanWords({ from: '2027-01-01', to: null })).toBe('from 1 Jan 2027');
    // Typed as full dates, the same overlap is refused.
    expect(
      dividersProblemOf({
        levels: ['year'],
        ranges: [
          { name: 'Elementary', from: '2014', to: '2020-12-31' },
          { name: 'Middle school', from: '2020', to: '2023' },
        ],
      })?.code,
    ).toBe('cabinet_divider_overlap');
    expect(
      dividersProblemOf({
        levels: ['year'],
        ranges: [
          { name: 'Elementary', from: '2014', to: '2020' },
          { name: 'Middle school', from: '2020-01-01', to: '2023' },
        ],
      })?.code,
    ).toBe('cabinet_divider_overlap');
  });

  it('put a year outside 1000 to 9999 behind Other years', () => {
    expect(dividerKeyOf({ filter: {}, dividers: undefined }, paper('0500-01-01'))).toBe('other');
    expect(dividerKeyOf({ filter: {}, dividers: undefined }, paper('1000-01-01'))).toBe(
      'year:1000',
    );
  });
});

describe('school stages', () => {
  it('start the September somebody is five: the owner’s own example', () => {
    expect(schoolStages('2009-04-20')).toEqual([
      { name: 'College', from: '2027-09-01', to: null },
      { name: 'High school', from: '2023-09-01', to: '2027-08-31' },
      { name: 'Middle school', from: '2020-09-01', to: '2023-08-31' },
      { name: 'Elementary', from: '2014-09-01', to: '2020-08-31' },
    ]);
  });

  it('wait a year for a birthday after 1 September, and never overlap', () => {
    expect(schoolStages('2009-09-01')?.at(-1)?.from).toBe('2014-09-01');
    expect(schoolStages('2009-09-02')?.at(-1)?.from).toBe('2015-09-01');
    const stages = schoolStages('2016-04-02');
    expect(stages && dividersProblemOf({ levels: ['year'], ranges: stages })).toBeNull();
    expect(schoolStages('not a day')).toBeNull();
  });
});

describe('a level with one group, passed over', () => {
  const counts = (o: Record<string, number>) => new Map(Object.entries(o));
  const keys = (ds: ReturnType<typeof shownDividers>) => ds.map((d) => [d.key, d.count]);
  const year2026 = { dated_from: '2026-01-01', dated_to: '2026-12-31' };

  it('knows a folder that is one year already, as a drawing asks it or a part of one', () => {
    expect(asksOneYear(year2026)).toBe(true);
    expect(asksOneYear({ dated_from: '2026-03-01', dated_to: '2026-06-30' })).toBe(true);
    expect(asksOneYear({ issued_from: '2026-01-01', issued_to: '2026-12-31' })).toBe(true);
    // Two years merged, an open end, or no dates: not one year.
    expect(asksOneYear({ dated_from: '2025-01-01', dated_to: '2026-12-31' })).toBe(false);
    expect(asksOneYear({ dated_from: '2026-01-01' })).toBe(false);
    expect(asksOneYear({ added_from: '2026-01-01', added_to: '2026-12-31' })).toBe(false);
    expect(asksOneYear({ category: 'tax' })).toBe(false);
    expect(asksOneYear({ dated_from: '2026-12-31', dated_to: '2026-01-01' })).toBe(false);
  });

  it('never divides a year folder by year: the repeated “2026” in a 2026 drawer', () => {
    const folder = { filter: { member_id: 'me', ...year2026 } };
    expect(dividerDims(folder)).toEqual([]);
    expect(keys(shownDividers(folder, counts({ 'year:2026': 4 })))).toEqual([['all', 4]]);
    // Nothing behind it yet: still one plain list, empty.
    expect(keys(shownDividers(folder, counts({})))).toEqual([['all', 0]]);
    // Its own ranges are kept, a year folder or not; and dividers turned off stay off.
    const ranged = { ...folder, dividers: SCHOOL };
    expect(dividerDims(ranged)).toEqual(['ranges']);
    expect(dividerDims({ ...folder, dividers: { levels: [], ranges: [] } })).toEqual([]);
  });

  it('hides year dividers with only one year to show, in a folder that asks no year too', () => {
    // A folder that asks no year, whose papers happen to be all of 2026.
    const byHand = { filter: { category: 'financial' } };
    expect(keys(shownDividers(byHand, counts({ 'year:2026': 3 })))).toEqual([['all', 3]]);
    // Only papers dated outside the years with dividers: one group too.
    expect(keys(shownDividers(byHand, counts({ other: 2 })))).toEqual([['all', 2]]);
    // A year a status leaves nothing behind is no group.
    expect(keys(shownDividers(byHand, counts({ 'year:2026': 3, 'year:2025': 0 })))).toEqual([
      ['all', 3],
    ]);
    // Two groups: each its divider, newest first, Other years last.
    expect(keys(shownDividers(byHand, counts({ 'year:2024': 1, 'year:2026': 3 })))).toEqual([
      ['year:2026', 3],
      ['year:2024', 1],
    ]);
    expect(keys(shownDividers(byHand, counts({ 'year:2024': 1, other: 1 })))).toEqual([
      ['year:2024', 1],
      ['other', 1],
    ]);
    const [newest] = shownDividers(byHand, counts({ 'year:2024': 1, 'year:2026': 3 }));
    expect(newest).toEqual({
      key: 'year:2026',
      kind: 'year',
      name: '2026',
      from: '2026-01-01',
      to: '2026-12-31',
      count: 3,
      path: [{ level: 'year', key: 'year:2026', name: '2026' }],
    });
    // Nothing at all: no dividers, as before.
    expect(shownDividers(byHand, counts({}))).toEqual([]);
  });

  it('never passes over a folder’s own ranges, even one of them, even empty', () => {
    const one = {
      filter: year2026,
      dividers: {
        levels: ['year' as const],
        ranges: [{ name: 'College', from: '2027-09-01', to: null }],
      },
    };
    expect(keys(shownDividers(one, counts({})))).toEqual([['range:0', 0]]);
    expect(
      keys(shownDividers({ filter: {}, dividers: SCHOOL }, counts({ 'range:2': 2, other: 1 }))),
    ).toEqual([
      ['range:1', 0],
      ['range:2', 2],
      ['range:0', 0],
      ['other', 1],
    ]);
  });
});
