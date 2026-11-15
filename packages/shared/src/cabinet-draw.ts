import type {
  ArrangeBy,
  Cabinet,
  CabinetDrawer,
  CabinetFolder,
  CabinetLayout,
  FolderFilter,
} from './cabinet.js';
import { cabinetName } from './cabinet.js';
import { CATEGORY_LABELS } from './tokens.js';

/**
 * Arrange by (0.9.0, C1): a cabinet drawn from what the vault knows (the
 * vault's POST /cabinet/preview, and the client's fake). Pure:
 * given how many documents the caller can see of each person, topic, kind
 * and year (`CabinetGroup`, counted by the database with the rules every list
 * keeps), it lays out cabinets, drawers and folders, each folder the
 * list's own question for exactly the documents counted into it — so a
 * folder holds what its drawing said it would.
 *
 *  - By person, then topic, then year: a cabinet for each person, a drawer
 *    for each topic, a folder for each year.
 *  - By topic, then year, then person: a cabinet for each topic (a Tax
 *    cabinet), a drawer for each year, a folder for each person.
 *  - By person, then kind: one cabinet, a drawer for each person, a folder
 *    for each kind.
 *
 * A paper with no topic (or, by kind, no kind) has no folder yet: it is
 * counted as left out, and lands in its folder once its details say where.
 */

/** How many documents share one person, topic, kind and year. */
export interface CabinetGroup {
  /** A person's id, `household`, or `none` (Not sure yet). */
  person: string;
  category: string | null;
  type_key: string | null;
  /** The year the paper is about: issued, else added. */
  year: number;
  n: number;
}

/** What the drawing names people and kinds by, as the caller is given them. */
export interface CabinetNames {
  person: (id: string) => string;
  kind: (key: string) => string;
  /** People in the order their cabinets go: the caller first. */
  personOrder: (a: string, b: string) => number;
}

export interface CabinetDrawn {
  layout: CabinetLayout;
  counts: Record<string, number>;
  documents: number;
  left_out: number;
}

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
const categoryRank = (c: string) => {
  const at = CATEGORY_ORDER.indexOf(c);
  return at === -1 ? CATEGORY_ORDER.length : at;
};
const categoryName = (c: string) => CATEGORY_LABELS[c] ?? c;

/** A year's question: the date a paper is about, within it. */
const yearFilter = (year: number): FolderFilter => ({
  dated_from: `${year}-01-01`,
  dated_to: `${year}-12-31`,
});

/** One level of a drawing: which value of a group it sorts by, named and ordered. */
interface Level {
  key: (g: CabinetGroup) => string | null;
  name: (v: string) => string;
  order: (a: string, b: string) => number;
  filter: (v: string) => FolderFilter;
}

function levels(by: ArrangeBy, names: CabinetNames): [Level, Level, Level] | [Level, Level] {
  const person: Level = {
    key: (g) => g.person,
    name: names.person,
    order: names.personOrder,
    filter: (v) => ({ member_id: v }),
  };
  const category: Level = {
    key: (g) => g.category,
    name: categoryName,
    order: (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
    filter: (v) => ({ category: v }),
  };
  const year: Level = {
    key: (g) => String(g.year),
    name: (v) => v,
    // The newest first.
    order: (a, b) => Number(b) - Number(a),
    filter: (v) => yearFilter(Number(v)),
  };
  const kind: Level = {
    key: (g) => g.type_key,
    name: names.kind,
    order: (a, b) => names.kind(a).localeCompare(names.kind(b)) || a.localeCompare(b),
    filter: (v) => ({ type_key: v }),
  };
  switch (by) {
    case 'person_category_year':
      return [person, category, year];
    case 'category_year_person':
      return [category, year, person];
    case 'person_kind':
      return [person, kind];
  }
}

/** The groups under one value of a level, each value once, in its level's order. */
function split(groups: readonly CabinetGroup[], level: Level): Array<[string, CabinetGroup[]]> {
  const by = new Map<string, CabinetGroup[]>();
  for (const g of groups) {
    const v = level.key(g);
    if (v === null || v === undefined) continue;
    by.set(v, [...(by.get(v) ?? []), g]);
  }
  return [...by].sort(([a], [b]) => level.order(a, b));
}

const total = (gs: readonly CabinetGroup[]) => gs.reduce((n, g) => n + g.n, 0);

/**
 * The cabinet `by` draws from `groups`: every folder a question for what it
 * was counted from. `newId` gives each node its id (short, random, unique).
 */
export function drawCabinet(
  by: ArrangeBy,
  groups: readonly CabinetGroup[],
  names: CabinetNames,
  newId: () => string,
): CabinetDrawn {
  const counts: Record<string, number> = {};
  // Every name drawn kept to what a cabinet may hold: a long name cut, never refused.
  const lv = levels(by, {
    ...names,
    person: (id) => cabinetName(names.person(id)),
    kind: (key) => cabinetName(names.kind(key)),
  });
  // Notes are kept apart, as the Documents table keeps them.
  const base: FolderFilter = { notes: 'exclude' };
  const folder = (name: string, filter: FolderFilter, n: number): CabinetFolder => {
    const id = newId();
    counts[id] = n;
    return { id, name, hidden: false, filter: { ...base, ...filter } };
  };
  let cabinets: Cabinet[];
  if (lv.length === 3) {
    const [first, second, third] = lv;
    cabinets = split(groups, first).map(([a, ga]) => ({
      id: newId(),
      name: first.name(a),
      hidden: false,
      drawers: split(ga, second).map(([b, gb]): CabinetDrawer => ({
        id: newId(),
        name: second.name(b),
        hidden: false,
        folders: split(gb, third).map(([c, gc]) =>
          folder(
            third.name(c),
            { ...first.filter(a), ...second.filter(b), ...third.filter(c) },
            total(gc),
          ),
        ),
      })),
    }));
  } else {
    const [first, second] = lv;
    cabinets = [
      {
        id: newId(),
        name: 'My cabinet',
        hidden: false,
        drawers: split(groups, first).map(([a, ga]): CabinetDrawer => ({
          id: newId(),
          name: first.name(a),
          hidden: false,
          folders: split(ga, second).map(([b, gb]) =>
            folder(second.name(b), { ...first.filter(a), ...second.filter(b) }, total(gb)),
          ),
        })),
      },
    ];
  }
  // Nothing drawn where a level found nothing to sort by.
  cabinets = cabinets
    .map((c) => ({ ...c, drawers: c.drawers.filter((d) => d.folders.length > 0) }))
    .filter((c) => c.drawers.length > 0);
  const documents = total(groups);
  const filed = Object.values(counts);
  // Each document is in one folder of a drawing: the rest have no topic, or no kind.
  const left_out = documents - filed.reduce((n, x) => n + x, 0);
  return { layout: { arranged_by: by, cabinets }, counts, documents, left_out };
}
