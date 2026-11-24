import { describe, expect, it } from 'vitest';
import {
  CABINET_LEVELS,
  CABINET_LIMITS,
  layoutProblemOf,
  levelsProblem,
  ownLevelsProblem,
  type Cabinet,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetLevel,
} from './cabinet.js';
import {
  addToDrawing,
  DRAWN_MOST,
  dividerLevelsOf,
  drawCabinet,
  nodeLevels,
  redrawCabinet,
  RedrawRefused,
  type CabinetGroup,
} from './cabinet-draw.js';
import {
  DIVIDER_LIMITS,
  dividerAsks,
  dividerKeyOf,
  EVERYTHING_ELSE,
  NO_KIND_YET,
  paperBehind,
  shownDividers,
  type DividerPaper,
  type FolderDividers,
} from './cabinet-dividers.js';
import { cabinetSize, moveDownFor, moveDownWords, sizeWarnings } from './cabinet-size.js';

/** Cabinet levels (0.9.0-dev.90): what the vault, the client's fake and the web share. */

const year = 2026;
const ids = (prefix = 'n') => {
  let n = 0;
  return () => `${prefix}${++n}`;
};
const names = {
  person: (id: string) =>
    ({ olive: 'Olive', sam: 'Sam', household: 'The household', none: 'Not sure yet' })[id] ?? id,
  kind: (key: string) =>
    ({
      tax_form: 'W-2',
      passport: 'Passport',
      payslip: 'Payslip',
      bank_statement: 'Bank statement',
      utility_bill: 'Utility bill',
    })[key] ?? key,
  personOrder: (a: string, b: string) =>
    ['olive', 'sam', 'household', 'none'].indexOf(a) -
    ['olive', 'sam', 'household', 'none'].indexOf(b),
};
const HOUSEHOLD: CabinetGroup[] = [
  { person: 'olive', category: 'tax', type_key: 'tax_form', year, n: 2 },
  { person: 'olive', category: 'tax', type_key: 'tax_form', year: year - 1, n: 1 },
  { person: 'olive', category: 'financial', type_key: 'bank_statement', year, n: 4 },
  { person: 'sam', category: 'financial', type_key: 'payslip', year, n: 3 },
  { person: 'sam', category: 'financial', type_key: 'bank_statement', year: year - 1, n: 1 },
  { person: 'sam', category: 'identity', type_key: 'passport', year: year - 3, n: 1 },
  { person: 'household', category: 'bills', type_key: 'utility_bill', year, n: 1 },
  { person: 'none', category: null, type_key: null, year, n: 2 },
];
const folders = (l: CabinetLayout) =>
  l.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders));
const byName = (l: CabinetLayout, ...path: string[]) => {
  const c = l.cabinets.find((x) => x.name === path[0]);
  const d = c?.drawers.find((x) => x.name === path[1]);
  return path.length === 2 ? d : d?.folders.find((x) => x.name === path[2]);
};
/** What a folder asks of a level: its one value, as a drawing writes it. */
const asks = (f: CabinetFolder, l: CabinetLevel): string | undefined =>
  ({
    topic: f.filter.category,
    person: f.filter.member_id,
    kind: f.filter.type_key,
    year: f.filter.dated_from?.slice(0, 4),
    issuer: f.filter.issuer,
  })[l];

/** Every ordered pick of `k` levels. */
function orders(k: number): CabinetLevel[][] {
  if (k === 0) return [[]];
  return orders(k - 1).flatMap((o) =>
    CABINET_LEVELS.filter((l) => !o.includes(l)).map((l) => [...o, l]),
  );
}

describe('the levels', () => {
  it('are 2 to 5, each once; a cabinet’s own 2 to 4 below it, never its own level', () => {
    expect(levelsProblem(['topic', 'year'])).toBeNull();
    expect(levelsProblem(['year'])).toMatch(/from 2 to 5/);
    expect(levelsProblem(['year', 'year'])).toMatch(/only once/);
    expect(levelsProblem(['year', 'colour'])).toMatch(/not something/);
    expect(ownLevelsProblem(['year', 'person'], ['topic', 'year', 'person'])).toBeNull();
    expect(ownLevelsProblem(['topic', 'person'], ['topic', 'year', 'person'])).toMatch(
      /Topic is the cabinet itself/,
    );
    expect(ownLevelsProblem(['year'], ['topic', 'year', 'person'])).toMatch(/from 2 to 4/);
    // Two levels: one cabinet, which has the default's own.
    expect(ownLevelsProblem(['year', 'kind'], ['person', 'kind'])).toMatch(/three levels/);
  });

  it('make nodes of the first three, and dividers of the rest, Year never twice', () => {
    expect(nodeLevels(['person', 'kind'])).toEqual(['person', 'kind']);
    expect(nodeLevels(['topic', 'year', 'person', 'kind'])).toEqual(['topic', 'year', 'person']);
    expect(dividerLevelsOf(['person', 'kind'])).toEqual(['year']);
    expect(dividerLevelsOf(['topic', 'year', 'person'])).toEqual([]);
    expect(dividerLevelsOf(['topic', 'person', 'kind'])).toEqual(['year']);
    expect(dividerLevelsOf(['topic', 'year', 'person', 'kind'])).toEqual(['kind']);
    expect(dividerLevelsOf(['topic', 'person', 'kind', 'year'])).toEqual(['year']);
  });
});

describe('drawing in any order of levels', () => {
  const documents = HOUSEHOLD.reduce((n, g) => n + g.n, 0);
  for (const levels of [...orders(2), ...orders(3), ...orders(4)]) {
    it(`by ${levels.join(' › ')}`, () => {
      const d = drawCabinet(levels, HOUSEHOLD, names, ids());
      const nodes = nodeLevels(levels);
      expect(d.layout.levels).toEqual(levels);
      expect(layoutProblemOf(d.layout)).toBeNull();
      // Each folder asks one value of each level that makes a node, and holds what it was counted from.
      for (const c of d.layout.cabinets) {
        if (levels.length === 2) expect(c.drawn).toEqual({ value: null });
        for (const dr of c.drawers) {
          for (const f of dr.folders) {
            for (const l of nodes) expect(asks(f, l), l).toBeDefined();
            if (levels.length > 2) expect(asks(f, levels[0] as CabinetLevel)).toBe(c.drawn?.value);
            expect(f.dividers).toEqual({ levels: dividerLevelsOf(levels), ranges: [] });
            const counted = HOUSEHOLD.filter((g) =>
              nodes.every((l) => {
                const v = {
                  topic: g.category,
                  person: g.person,
                  kind: g.type_key,
                  year: String(g.year),
                  issuer: g.issuer ?? '_none',
                }[l];
                return v === asks(f, l);
              }),
            ).reduce((n, g) => n + g.n, 0);
            expect(d.counts[f.id]).toBe(counted);
          }
        }
      }
      // A paper with no topic or kind, where one makes a node, is left out.
      const leftOut = nodes.some((l) => l === 'topic' || l === 'kind') ? 2 : 0;
      expect(d.left_out).toBe(leftOut);
      expect(Object.values(d.counts).reduce((n, x) => n + x, 0)).toBe(documents - leftOut);
    });
  }

  it('gives a cabinet its own levels below it', () => {
    const d = drawCabinet(
      ['topic', 'year', 'person'],
      HOUSEHOLD,
      names,
      ids(),
      new Map([['financial', ['person', 'kind', 'year'] as CabinetLevel[]]]),
    );
    const fin = d.layout.cabinets.find((c) => c.drawn?.value === 'financial') as Cabinet;
    expect(fin.drawn).toEqual({ value: 'financial', levels: ['person', 'kind', 'year'] });
    expect(fin.drawers.map((x) => [x.name, x.folders.map((f) => f.name)])).toEqual([
      ['Olive', ['Bank statement']],
      ['Sam', ['Bank statement', 'Payslip']],
    ]);
    for (const f of fin.drawers.flatMap((x) => x.folders)) {
      expect(f.dividers).toEqual({ levels: ['year'], ranges: [] });
    }
    // Every other cabinet follows the default.
    const tax = d.layout.cabinets.find((c) => c.drawn?.value === 'tax') as Cabinet;
    expect(tax.drawn).toEqual({ value: 'tax' });
    expect(tax.drawers.map((x) => x.name)).toEqual([String(year), String(year - 1)]);
  });
});

describe('redrawing', () => {
  const base = () => {
    const d = drawCabinet(['person', 'topic', 'year'], HOUSEHOLD, names, ids('old'));
    const l = d.layout;
    // Olive's 2026 Tax folder: renamed, hidden, with ranges of its own.
    const tax = byName(l, 'Olive', 'Tax', String(year)) as CabinetFolder;
    tax.name = 'Tax this year';
    tax.hidden = true;
    tax.dividers = {
      levels: [],
      ranges: [{ name: 'Spring', from: `${year}-03-01`, to: `${year}-05-31` }],
    };
    return l;
  };
  /** A cabinet not drawn by the levels, as no release keeps any more. */
  const loose = (): Cabinet => ({
    id: 'loose',
    name: 'My folders',
    hidden: false,
    drawers: [
      {
        id: 'loose-d',
        name: 'Scans',
        hidden: false,
        folders: [
          { id: 'loose-f', name: 'Scans', hidden: false, filter: { source_folder: 'Scans' } },
        ],
      },
    ],
  });

  it('keeps names, hidden folders, ranges and ids wherever the same folder is drawn again', () => {
    const before = base();
    const tax = byName(before, 'Olive', 'Tax', String(year)) as CabinetFolder;
    expect(tax).toBeUndefined(); // renamed
    const was = folders(before).find((f) => f.name === 'Tax this year') as CabinetFolder;
    // Person › Year › Topic: the same folders, by another drawer level.
    const after = redrawCabinet(
      before,
      { levels: ['person', 'year', 'topic'] },
      HOUSEHOLD,
      names,
      ids('new'),
    );
    const same = folders(after.layout).find((f) => f.id === was.id) as CabinetFolder;
    expect(same.filter).toEqual(was.filter);
    expect(same.hidden).toBe(true);
    expect(same.dividers?.ranges).toEqual(was.dividers?.ranges);
    // Its name was given at the folder's level then (Year), and is Topic's now: drawn afresh.
    expect(same.name).toBe('Tax');
    // The cabinets, by the same first level, keep their ids.
    expect(after.layout.cabinets.map((c) => c.id)).toEqual(before.cabinets.map((c) => c.id));
    expect(after.counts[was.id]).toBe(2);
    // Back again, by Person › Topic › Year: the folder's name from Topic is drawn afresh as its year.
    const back = redrawCabinet(
      after.layout,
      { levels: ['person', 'topic', 'year'] },
      HOUSEHOLD,
      names,
      ids('b'),
    );
    expect(folders(back.layout).find((f) => f.id === was.id)?.name).toBe(String(year));
  });

  it('keeps a renamed folder’s name where its level stays', () => {
    const before = base();
    const was = folders(before).find((f) => f.name === 'Tax this year') as CabinetFolder;
    // Person › Topic › Year › Kind: a divider added, nothing else.
    const after = redrawCabinet(
      before,
      { levels: ['person', 'topic', 'year', 'kind'] },
      HOUSEHOLD,
      names,
      ids('new'),
    );
    const same = folders(after.layout).find((f) => f.id === was.id) as CabinetFolder;
    expect(same.name).toBe('Tax this year');
    expect(same.dividers).toEqual({ levels: ['kind'], ranges: was.dividers?.ranges });
  });

  it('redraws no folder when only levels 4 and 5 change', () => {
    const four = redrawCabinet(
      base(),
      { levels: ['person', 'topic', 'year', 'kind'] },
      HOUSEHOLD,
      names,
      ids('a'),
    ).layout;
    expect(folders(four).map((f) => f.id)).toEqual(folders(base()).map((f) => f.id));
    const again = redrawCabinet(
      four,
      { levels: ['person', 'topic', 'year', 'kind'] },
      HOUSEHOLD,
      names,
      ids('b'),
    );
    expect(again.layout).toEqual(four);
    const swapped = redrawCabinet(
      { ...four, levels: ['person', 'topic', 'year', 'kind'] },
      { levels: ['person', 'topic', 'year'] },
      HOUSEHOLD,
      names,
      ids('c'),
    );
    expect(swapped.counts).toEqual({});
    expect(folders(swapped.layout).map((f) => f.id)).toEqual(folders(four).map((f) => f.id));
    for (const f of folders(swapped.layout).filter((x) => x.filter.member_id)) {
      expect(f.dividers?.levels).toEqual([]);
    }
  });

  it('gives one cabinet its own order, redrawing it alone, and the default again', () => {
    const drawn = redrawCabinet(
      base(),
      { levels: ['topic', 'year', 'person'] },
      HOUSEHOLD,
      names,
      ids('a'),
    ).layout;
    const fin = drawn.cabinets.find((c) => c.drawn?.value === 'financial') as Cabinet;
    const own = redrawCabinet(
      drawn,
      { levels: ['topic', 'year', 'person'], cabinet: { id: fin.id, levels: ['person', 'kind'] } },
      HOUSEHOLD,
      names,
      ids('o'),
    ).layout;
    const ownFin = own.cabinets.find((c) => c.id === fin.id) as Cabinet;
    expect(ownFin.drawn).toEqual({ value: 'financial', levels: ['person', 'kind'] });
    expect(ownFin.drawers.map((d) => [d.name, d.folders.map((f) => f.name)])).toEqual([
      ['Olive', ['Bank statement']],
      ['Sam', ['Bank statement', 'Payslip']],
    ]);
    expect(own.cabinets.filter((c) => c.id !== fin.id)).toEqual(
      drawn.cabinets.filter((c) => c.id !== fin.id),
    );
    // The default's levels 2 and 3 changed: Financial keeps its own; the rest are redrawn.
    const moved = redrawCabinet(
      own,
      { levels: ['topic', 'person', 'year'] },
      HOUSEHOLD,
      names,
      ids('m'),
    ).layout;
    expect(moved.cabinets.find((c) => c.id === fin.id)).toEqual(ownFin);
    const tax = moved.cabinets.find((c) => c.drawn?.value === 'tax') as Cabinet;
    expect(tax.drawers.map((d) => d.name)).toEqual(['Olive']);
    // The first level changed: every own arrangement let go.
    const person = redrawCabinet(
      own,
      { levels: ['person', 'topic', 'year'] },
      HOUSEHOLD,
      names,
      ids('p'),
    ).layout;
    expect(person.cabinets.filter((c) => c.drawn?.levels)).toEqual([]);
    expect(person.cabinets.map((c) => c.name)).toEqual(['Olive', 'Sam', 'The household']);
    // The default again.
    const back = redrawCabinet(
      own,
      { levels: ['topic', 'year', 'person'], cabinet: { id: fin.id, levels: null } },
      HOUSEHOLD,
      names,
      ids('d'),
    ).layout;
    const again = back.cabinets.find((c) => c.id === fin.id) as Cabinet;
    expect(again.drawn).toEqual({ value: 'financial' });
    expect(again.drawers.map((d) => d.name)).toEqual(
      (drawn.cabinets.find((c) => c.id === fin.id) as Cabinet).drawers.map((d) => d.name),
    );
    // Its own levels 4 and 5 alone: no folder redrawn there either.
    const divided = redrawCabinet(
      own,
      {
        levels: ['topic', 'year', 'person'],
        cabinet: { id: fin.id, levels: ['person', 'kind', 'year'] },
      },
      HOUSEHOLD,
      names,
      ids('v'),
    ).layout;
    const dfin = divided.cabinets.find((c) => c.id === fin.id) as Cabinet;
    expect(dfin.drawn?.levels).toEqual(['person', 'kind', 'year']);
    expect(folders({ levels: null, cabinets: [dfin] }).map((f) => f.id)).toEqual(
      folders({ levels: null, cabinets: [ownFin] }).map((f) => f.id),
    );
  });

  it('refuses a cabinet’s own levels that are not below it, or over other levels', () => {
    const drawn = redrawCabinet(
      null,
      { levels: ['topic', 'year', 'person'] },
      HOUSEHOLD,
      names,
      ids(),
    ).layout;
    const fin = drawn.cabinets.find((c) => c.drawn?.value === 'financial') as Cabinet;
    const refused =
      (ask: Parameters<typeof redrawCabinet>[1], over = drawn) =>
      () =>
        redrawCabinet(over, ask, HOUSEHOLD, names, ids());
    expect(
      refused({
        levels: ['topic', 'year', 'person'],
        cabinet: { id: fin.id, levels: ['topic', 'kind'] },
      }),
    ).toThrow(RedrawRefused);
    expect(
      refused({
        levels: ['topic', 'person', 'year'],
        cabinet: { id: fin.id, levels: ['kind', 'year'] },
      }),
    ).toThrow(RedrawRefused);
    expect(
      refused({
        levels: ['topic', 'year', 'person'],
        cabinet: { id: 'nope', levels: ['kind', 'year'] },
      }),
    ).toThrow(RedrawRefused);
    expect(refused({ levels: ['topic'] as CabinetLevel[] })).toThrow(RedrawRefused);
  });

  it('keeps one structure: a cabinet not drawn by the levels is let go, a drawn one’s own changes kept', () => {
    const before = base();
    before.cabinets.unshift(loose());
    const was = folders(before).find((f) => f.name === 'Tax this year') as CabinetFolder;
    // The same levels, levels 4 and 5, levels 2 and 3, the first: never kept.
    for (const levels of [
      ['person', 'topic', 'year'],
      ['person', 'topic', 'year', 'kind'],
      ['person', 'year', 'topic'],
      ['topic', 'year', 'person'],
    ] as CabinetLevel[][]) {
      const after = redrawCabinet(before, { levels }, HOUSEHOLD, names, ids('n')).layout;
      expect(after.cabinets.every((c) => c.drawn)).toBe(true);
      expect(after.cabinets.some((c) => c.id === 'loose')).toBe(false);
      expect(folders(after).some((f) => f.id === 'loose-f')).toBe(false);
    }
    // A drawn folder's name, hidden flag and ranges kept, its level the same.
    const four = redrawCabinet(
      before,
      { levels: ['person', 'topic', 'year', 'kind'] },
      HOUSEHOLD,
      names,
      ids('f'),
    ).layout;
    const same = folders(four).find((f) => f.id === was.id) as CabinetFolder;
    expect(same.name).toBe('Tax this year');
    expect(same.hidden).toBe(true);
    expect(same.dividers?.ranges).toEqual(was.dividers?.ranges);
    // A renamed, hidden cabinet drawn again by the same first level: kept as it was set.
    const olive = before.cabinets.find((c) => c.name === 'Olive') as Cabinet;
    olive.name = 'Olive’s papers';
    olive.hidden = true;
    const redrawn = redrawCabinet(
      before,
      { levels: ['person', 'year', 'topic'] },
      HOUSEHOLD,
      names,
      ids('r'),
    ).layout;
    expect(redrawn.cabinets.find((c) => c.id === olive.id)).toMatchObject({
      name: 'Olive’s papers',
      hidden: true,
    });
  });

  it('draws afresh over a layout with no levels: nothing of it kept', () => {
    const noLevels: CabinetLayout = { ...base(), levels: null };
    noLevels.cabinets.push(loose());
    const after = redrawCabinet(
      noLevels,
      { levels: ['person', 'kind'] },
      HOUSEHOLD,
      names,
      ids('n'),
    ).layout;
    expect(after.cabinets.map((c) => [c.name, c.drawn ?? null])).toEqual([
      ['My cabinet', { value: null }],
    ]);
    const fresh = redrawCabinet(null, { levels: ['person', 'kind'] }, HOUSEHOLD, names, ids('n'));
    expect(after).toEqual(fresh.layout);
  });
});

describe('redrawing keeps what was set by hand', () => {
  const drawn = () => {
    const l = drawCabinet(['person', 'kind'], HOUSEHOLD, names, ids('o')).layout;
    // Sam's payslips: "No dividers", set by hand; Olive's W-2: by year, as drawn.
    const pay = folders(l).find((f) => f.filter.type_key === 'payslip') as CabinetFolder;
    pay.dividers = { levels: [], ranges: [] };
    return l;
  };

  it('changes nothing for the same levels', () => {
    const before = drawn();
    const again = redrawCabinet(before, { levels: ['person', 'kind'] }, HOUSEHOLD, names, ids());
    expect(again.layout).toEqual(before);
    expect(again.counts).toEqual({});
  });

  it('rewrites only the dividers the old levels wrote when levels 4 and 5 change', () => {
    const base = drawCabinet(['person', 'topic', 'year'], HOUSEHOLD, names, ids('o')).layout;
    const tax = folders(base).find((f) => f.filter.category === 'tax') as CabinetFolder;
    // By kind, set by hand where the drawing wrote none.
    tax.dividers = { levels: ['kind'], ranges: [] };
    const four = redrawCabinet(
      base,
      { levels: ['person', 'topic', 'year', 'kind'] },
      HOUSEHOLD,
      names,
      ids(),
    ).layout;
    const now = folders(four).find((f) => f.id === tax.id) as CabinetFolder;
    expect(now.dividers).toEqual({ levels: ['kind'], ranges: [] });
    // Back to three: one set by hand since stays; the drawing's go back to none.
    now.dividers = { levels: ['person'], ranges: [] };
    const back = redrawCabinet(
      four,
      { levels: ['person', 'topic', 'year'] },
      HOUSEHOLD,
      names,
      ids(),
    ).layout;
    for (const f of folders(back)) {
      expect(f.dividers?.levels, f.name).toEqual(f.id === tax.id ? ['person'] : []);
    }
  });

  it('keeps a cabinet’s own as it is for its own levels again, and says a cabinet gone is gone', () => {
    const l = drawCabinet(
      ['topic', 'year', 'person'],
      HOUSEHOLD,
      names,
      ids(),
      new Map([['financial', ['person', 'kind'] as CabinetLevel[]]]),
    ).layout;
    const fin = l.cabinets.find((c) => c.drawn?.value === 'financial') as Cabinet;
    const f = fin.drawers[0]?.folders[0] as CabinetFolder;
    f.dividers = { levels: [], ranges: [] };
    const same = redrawCabinet(
      l,
      { levels: ['topic', 'year', 'person'], cabinet: { id: fin.id, levels: ['person', 'kind'] } },
      HOUSEHOLD,
      names,
      ids(),
    );
    expect(same.layout).toEqual(l);
    expect(() =>
      redrawCabinet(
        l,
        { levels: ['topic', 'year', 'person'], cabinet: { id: 'gone', levels: ['kind', 'year'] } },
        HOUSEHOLD,
        names,
        ids(),
      ),
    ).toThrow(/isn’t there any more/);
  });
});

describe('a drawing at the limits', () => {
  it('redraws a thousand folders over eight thousand groups quickly, drawing no further than too big', () => {
    const kinds = (n: number, year: number) =>
      Array.from({ length: n }, (_, i): CabinetGroup => ({
        person: i % 2 ? 'olive' : 'sam',
        category: 'financial',
        type_key: `k${i}`,
        year,
        n: 1,
      }));
    const saved = drawCabinet(['person', 'kind'], kinds(1000, 2026), names, ids('s')).layout;
    expect(folders(saved)).toHaveLength(1000);
    const groups = [...kinds(4000, 2026), ...kinds(4000, 2025)];
    const started = Date.now();
    const redrawn = redrawCabinet(saved, { levels: ['kind', 'person'] }, groups, names, ids('r'));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(redrawn.capped).toBe(true);
    expect(folders(redrawn.layout).length).toBeLessThanOrEqual(DRAWN_MOST);
    expect(cabinetSize(redrawn.layout).over).toBe('cabinet_too_big');
    // The folders asked the same keep their ids, found by an index.
    const kept = new Set(folders(saved).map((f) => f.id));
    expect(folders(redrawn.layout).filter((f) => kept.has(f.id)).length).toBeGreaterThan(0);
  });
});

describe('growing a drawing by its levels', () => {
  it('adds a paper to a cabinet’s own levels, and to an empty cabinet found by its value', () => {
    const drawn = drawCabinet(
      ['topic', 'year', 'person'],
      HOUSEHOLD,
      names,
      ids(),
      new Map([['financial', ['person', 'kind'] as CabinetLevel[]]]),
    ).layout;
    // Tax emptied by hand: still the Tax cabinet, found by its value.
    const tax = drawn.cabinets.find((c) => c.drawn?.value === 'tax') as Cabinet;
    tax.name = 'Taxes';
    tax.drawers = [];
    const kept = addToDrawing(
      drawn,
      [
        { person: 'olive', category: 'financial', type_key: 'payslip', year, n: 1 },
        { person: 'sam', category: 'tax', type_key: 'tax_form', year, n: 1 },
      ],
      names,
      ids('g'),
    );
    expect(kept.added).toBe(2);
    const fin = kept.layout.cabinets.find((c) => c.drawn?.value === 'financial') as Cabinet;
    expect(fin.drawers.find((d) => d.name === 'Olive')?.folders.map((f) => f.name)).toEqual([
      'Bank statement',
      'Payslip',
    ]);
    const taxes = kept.layout.cabinets.filter((c) => c.drawn?.value === 'tax');
    expect(taxes.map((c) => [c.name, c.drawers.map((d) => d.name)])).toEqual([
      ['Taxes', [String(year)]],
    ]);
  });

  it('writes levels 4 and 5 on a new folder, and grows nothing over no levels', () => {
    const drawn = drawCabinet(['person', 'topic', 'year', 'kind'], HOUSEHOLD, names, ids()).layout;
    const kept = addToDrawing(
      drawn,
      [{ person: 'olive', category: 'tax', type_key: 'tax_form', year: year + 1, n: 1 }],
      names,
      ids('g'),
    );
    expect(kept.added).toBe(1);
    const folder = byName(kept.layout, 'Olive', 'Tax', String(year + 1)) as CabinetFolder;
    expect(folder.dividers).toEqual({ levels: ['kind'], ranges: [] });
    // A layout with no levels: nothing at all.
    const noLevels = { ...drawn, levels: null };
    expect(
      addToDrawing(
        noLevels,
        [{ person: 'olive', category: 'tax', type_key: 'tax_form', year: year + 2, n: 1 }],
        names,
        ids(),
      ).added,
    ).toBe(0);
  });
});

describe('how big, and the warning', () => {
  const big = (levels: CabinetLevel[], groups: CabinetGroup[]) =>
    drawCabinet(levels, groups, names, ids()).layout;
  const many = (n: number) =>
    Array.from({ length: n }, (_, i): CabinetGroup => ({
      person: 'olive',
      category: 'financial',
      type_key: `k${i}`,
      year: 2000 + (i % 50),
      n: 1,
    }));

  it('counts a layout and warns above 40 folders in a drawer', () => {
    const l = big(['person', 'topic', 'kind'], many(45));
    const size = cabinetSize(l);
    expect(size).toMatchObject({ cabinets: 1, drawers: 1, folders: 45, over: null });
    expect(size.biggest_drawer).toMatchObject({ path: ['Olive', 'Financial'], folders: 45 });
    expect(sizeWarnings(size).map((w) => w.code)).toEqual(['folders']);
    // Move it down: Kind from the folders to the dividers, where it costs none.
    expect(
      moveDownFor(['person', 'topic', 'kind', 'year'], sizeWarnings(size)[0] as never),
    ).toEqual({
      level: 'kind',
      levels: ['person', 'topic', 'year', 'kind'],
      divider: true,
    });
    // Three levels, Kind last already: Year put in above it, and Kind becomes the dividers.
    const three = moveDownFor(['person', 'topic', 'kind'], sizeWarnings(size)[0] as never);
    expect(three).toEqual({
      level: 'kind',
      levels: ['person', 'topic', 'year', 'kind'],
      added: 'year',
      divider: true,
    });
    expect(three && moveDownWords(three)).toBe(
      'Add Year above Kind, which then goes below the folders, where it becomes dividers inside them and costs no folders.',
    );
    // Two levels: a drawer level put in above the folders.
    expect(moveDownFor(['person', 'kind'], { code: 'folders_total', folders: 400 })).toMatchObject({
      levels: ['person', 'year', 'kind'],
      added: 'year',
      divider: false,
    });
    // One cabinet's own: its folder level, the second below it, to the first divider.
    expect(
      moveDownFor(['kind', 'year', 'person'], { code: 'folders_total', folders: 400 }, true, [
        'topic',
      ]),
    ).toEqual({
      level: 'year',
      levels: ['kind', 'person', 'year'],
      divider: true,
    });
    // Its own two levels: a spare one put in, never the cabinet's own level.
    expect(
      moveDownFor(['year', 'kind'], { code: 'folders_total', folders: 400 }, true, ['person']),
    ).toMatchObject({ levels: ['year', 'topic', 'kind'], added: 'topic', divider: true });
    // No level left to put in: no way, said in words instead.
    expect(
      moveDownFor(['person', 'kind'], { code: 'folders_total', folders: 400 }, true, [
        'topic',
        'year',
      ]),
    ).toBeNull();
  });

  it('warns above 30 drawers in a cabinet, 300 folders in all, and refuses only past the limits', () => {
    const drawers = cabinetSize(big(['person', 'year', 'kind'], many(40)));
    expect(sizeWarnings(drawers).map((w) => w.code)).toEqual(['drawers']);
    const lots = cabinetSize(big(['person', 'year', 'kind'], many(320)));
    expect(sizeWarnings(lots).map((w) => w.code)).toContain('folders_total');
    expect(lots.over).toBeNull();
    const tooMany = cabinetSize(big(['person', 'topic', 'kind'], many(CABINET_LIMITS.folders + 1)));
    expect(tooMany.over).toBe('cabinet_too_big');
  });
});

describe('dividers by levels', () => {
  const folder = (levels: CabinetLevel[], ranges: FolderDividers['ranges'] = []) => ({
    filter: { member_id: 'olive' },
    dividers: { levels, ranges },
  });
  const papers: DividerPaper[] = [
    { day: '2025-02-01', type_key: 'bank_statement', category: 'financial', person: 'olive' },
    { day: '2026-02-01', type_key: 'bank_statement', category: 'financial', person: 'olive' },
    { day: '2026-03-01', type_key: 'bank_statement', category: 'financial', person: 'olive' },
    { day: '2026-04-01', type_key: 'payslip', category: 'financial', person: 'olive' },
    { day: '2026-05-01', type_key: null, category: null, person: 'olive' },
  ];
  const counted = (f: ReturnType<typeof folder>) => {
    const m = new Map<string, number>();
    for (const p of papers) {
      const k = dividerKeyOf(f, p);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };

  it('lists one leaf for each, named by its steps, the second passed over where it has one value', () => {
    const f = folder(['kind', 'year']);
    expect(dividerKeyOf(f, papers[0] as DividerPaper)).toBe('kind:bank_statement/year:2025');
    const shown = shownDividers(f, counted(f), names);
    expect(shown.map((d) => [d.key, d.name, d.kind, d.count])).toEqual([
      ['kind:bank_statement/year:2026', 'Bank statement · 2026', 'group', 2],
      ['kind:bank_statement/year:2025', 'Bank statement · 2025', 'group', 1],
      ['kind:payslip', 'Payslip', 'group', 1],
      ['kind:', NO_KIND_YET, 'group', 1],
    ]);
    expect(shown[0]?.path).toEqual([
      { level: 'kind', key: 'kind:bank_statement', name: 'Bank statement' },
      { level: 'year', key: 'year:2026', name: '2026' },
    ]);
    expect(shown[0]).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    // Each one's papers, as the vault asks them.
    for (const d of shown) {
      const ask = dividerAsks(f, d.key);
      expect(ask, d.key).not.toBeNull();
      expect(papers.filter((p) => paperBehind(ask as never, p)).length, d.key).toBe(d.count);
    }
  });

  it('passes over a first step with one value, and both: one plain list', () => {
    const onlyBank = (l: CabinetLevel[]) => {
      const f = folder(l);
      const m = new Map<string, number>();
      for (const p of papers.slice(0, 3)) {
        const k = dividerKeyOf(f, p);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return shownDividers(f, m, names);
    };
    expect(onlyBank(['kind', 'year']).map((d) => [d.key, d.name])).toEqual([
      ['year:2026', '2026'],
      ['year:2025', '2025'],
    ]);
    expect(onlyBank(['kind', 'topic']).map((d) => d.key)).toEqual(['all']);
  });

  it('puts a folder’s own ranges first where Year is no level, and never passes them over', () => {
    const f = folder(['kind'], [{ name: 'This year', from: '2026', to: null }]);
    const shown = shownDividers(f, counted(f), names);
    expect(shown.map((d) => d.key)).toEqual([
      'range:0/kind:bank_statement',
      'range:0/kind:payslip',
      'range:0/kind:',
      'other',
    ]);
    expect(dividerAsks(f, 'all')).toBeNull();
  });

  it('answers only the steps a folder is divided by, in its order', () => {
    const f = folder(['kind', 'year']);
    expect(dividerAsks(f, 'year:2026')).not.toBeNull();
    expect(dividerAsks(f, 'year:2026/kind:payslip')).toBeNull();
    expect(dividerAsks(f, 'topic:financial')).toBeNull();
    expect(dividerAsks(f, 'person:')).toBeNull();
    expect(dividerAsks(f, 'all')).toEqual({ atoms: [] });
  });

  it('shows at most 100, the smallest behind Everything else', () => {
    const f = { filter: {}, dividers: { levels: ['kind'] as CabinetLevel[], ranges: [] } };
    const m = new Map(
      Array.from(
        { length: 120 },
        (_, i) => [`kind:k${String(i).padStart(3, '0')}`, i + 1] as const,
      ),
    );
    const shown = shownDividers(f, m, names);
    expect(shown).toHaveLength(DIVIDER_LIMITS.shown);
    const rest = shown.at(-1);
    expect(rest).toMatchObject({ key: 'rest', name: EVERYTHING_ELSE, count: (21 * 22) / 2 });
    const ask = dividerAsks(f, 'rest', shown);
    expect(ask?.none_of).toHaveLength(99);
    expect(
      paperBehind(ask as never, {
        day: '2026-01-01',
        type_key: 'k000',
        category: null,
        person: 'x',
      }),
    ).toBe(true);
    expect(
      paperBehind(ask as never, {
        day: '2026-01-01',
        type_key: 'k119',
        category: null,
        person: 'x',
      }),
    ).toBe(false);
    expect(dividerAsks(f, 'rest')).toBeNull();
  });
});
