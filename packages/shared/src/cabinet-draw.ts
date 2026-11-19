import type {
  ArrangeBy,
  Cabinet,
  CabinetDrawer,
  CabinetFolder,
  CabinetLayout,
  FolderFilter,
} from './cabinet.js';
import { CABINET_LIMITS, cabinetName, layoutProblemOf } from './cabinet.js';
import { PLACE_SEPARATOR } from './original-place.js';
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
  /**
   * The values of it a saved folder asks: one as drawn; several once
   * merged ("medical,financial", 2024 to 2025); none when it asks nothing of it.
   */
  values: (f: FolderFilter) => string[];
}

/** A filter's values, as a merged folder asks several: any of them. */
const listOf = (v: string | undefined) => (v ? v.split(',').filter((x) => x !== '') : []);

/** The most years a merged range is read as, one by one. */
const YEARS_READ = 200;

function levels(by: ArrangeBy, names: CabinetNames): [Level, Level, Level] | [Level, Level] {
  const person: Level = {
    key: (g) => g.person,
    name: names.person,
    order: names.personOrder,
    filter: (v) => ({ member_id: v }),
    values: (f) => listOf(f.member_id),
  };
  const category: Level = {
    key: (g) => g.category,
    name: categoryName,
    order: (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
    filter: (v) => ({ category: v }),
    values: (f) => listOf(f.category),
  };
  const year: Level = {
    key: (g) => String(g.year),
    name: (v) => v,
    // The newest first.
    order: (a, b) => Number(b) - Number(a),
    filter: (v) => yearFilter(Number(v)),
    // Whole years, as a drawing asks them, or merged ones: 2024 to 2025 is both.
    values: (f) => {
      const from = Number(f.dated_from?.slice(0, 4));
      const to = Number(f.dated_to?.slice(0, 4));
      if (
        f.dated_from !== `${from}-01-01` ||
        f.dated_to !== `${to}-12-31` ||
        to < from ||
        to - from >= YEARS_READ
      ) {
        return [];
      }
      return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
    },
  };
  const kind: Level = {
    key: (g) => g.type_key,
    name: names.kind,
    order: (a, b) => names.kind(a).localeCompare(names.kind(b)) || a.localeCompare(b),
    filter: (v) => ({ type_key: v }),
    values: (f) => listOf(f.type_key),
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
  // Every name drawn kept to what a cabinet may hold: a long name cut, never
  // refused; and never holding " › ", which joins a place's names (C3).
  const lv = levels(by, {
    ...names,
    person: (id) => drawnName(names.person(id)),
    kind: (key) => drawnName(names.kind(key)),
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

/** A name as a drawing gives it: " › " in it made " - ", then cut to a cabinet's length. */
function drawnName(name: string): string {
  return cabinetName(name.split(PLACE_SEPARATOR).join(' - '));
}

/**
 * The node of `list` for value `v` of a level: one whose every folder asks
 * just it, else one any folder of which asks it among others (a merged
 * drawer, "Medical and Financial"). None for none.
 */
function nodeFor<T>(
  list: readonly T[],
  level: Level,
  v: string,
  foldersOf: (x: T) => readonly CabinetFolder[],
): T | undefined {
  const asks = (f: CabinetFolder) => level.values(f.filter);
  return (
    list.find((x) => {
      const fs = foldersOf(x);
      return fs.length > 0 && fs.every((f) => asks(f).length === 1 && asks(f)[0] === v);
    }) ?? list.find((x) => foldersOf(x).some((f) => asks(f).includes(v)))
  );
}

/**
 * `item`, put among `list` where its level's order puts it: before the
 * first whose value comes after its own. One that asks nothing of the
 * level (a node arranged by hand) is passed over; with none after it, it
 * goes last.
 */
function putInOrder<T>(
  list: T[],
  item: T,
  value: string,
  level: Level,
  foldersOf: (x: T) => readonly CabinetFolder[],
): void {
  const at = list.findIndex((x) => {
    const v = foldersOf(x).flatMap((f) => level.values(f.filter))[0];
    return v !== undefined && level.order(value, v) < 0;
  });
  if (at === -1) list.push(item);
  else list.splice(at, 0, item);
}

const foldersOfCabinet = (c: Cabinet) => c.drawers.flatMap((d) => d.folders);
const foldersOfDrawer = (d: CabinetDrawer) => d.folders;
/** As JSON, in UTF-8 bytes, as Postgres keeps a layout: a character of Chinese is three. */
function bytesOf(x: unknown): number {
  let n = 0;
  for (const ch of JSON.stringify(x)) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * A drawn cabinet kept up to date (19 Nov 2026): a layout drawn by "Arrange
 * by" is a snapshot of the topics, years and people there were when it was
 * drawn, so a paper of a new topic, year or person had no folder, and the
 * cabinet held fewer than the table. Given the papers no folder of it holds
 * (`groups`, counted as `drawCabinet`'s are), this adds their folders where
 * the drawing would have put them — into the cabinet and drawer already
 * there for their topic, person or year (found by what its folders ask, so
 * a renamed or merged one is still found), else a new one, in the drawing's
 * order — and leaves every other folder as it was. Folders are added one at
 * a time, up to what a cabinet may hold (`CABINET_LIMITS`): those past it
 * are not, and their papers stay in no folder. A layout arranged by hand
 * (`arranged_by` null) is never changed. A paper with no topic (or, by
 * kind, no kind) still has no folder.
 */
export function addToDrawing(
  layout: CabinetLayout,
  groups: readonly CabinetGroup[],
  names: CabinetNames,
  newId: () => string,
): { layout: CabinetLayout; added: number; left: number } {
  const by = layout.arranged_by;
  if (by === null || groups.length === 0) return { layout, added: 0, left: 0 };
  const drawn = drawCabinet(by, groups, names, newId);
  const lv = levels(by, names);
  const out = JSON.parse(JSON.stringify(layout)) as CabinetLayout;
  let bytes = bytesOf(out);
  let added = 0;
  let left = 0;
  const three = lv.length === 3;
  const [cabinetLevel, drawerLevel, folderLevel] = three ? lv : [undefined, lv[0], lv[1]];
  const only = (level: Level, f: CabinetFolder) => level.values(f.filter)[0] as string;
  for (const dc of drawn.layout.cabinets) {
    for (const dd of dc.drawers) {
      for (const df of dd.folders) {
        // Its cabinet: the topic's (or person's) own, else a new one; by
        // kind, the one that holds its person's drawer, else the first.
        let cabinet: Cabinet | undefined;
        let newCabinet = false;
        let drawer: CabinetDrawer | undefined;
        if (cabinetLevel) {
          cabinet = nodeFor(out.cabinets, cabinetLevel, only(cabinetLevel, df), foldersOfCabinet);
          drawer = cabinet
            ? nodeFor(cabinet.drawers, drawerLevel, only(drawerLevel, df), foldersOfDrawer)
            : undefined;
        } else {
          for (const c of out.cabinets) {
            drawer = nodeFor(c.drawers, drawerLevel, only(drawerLevel, df), foldersOfDrawer);
            if (drawer) {
              cabinet = c;
              break;
            }
          }
          cabinet ??=
            out.cabinets.find((c) =>
              c.drawers.some((d) => d.folders.some((f) => drawerLevel.values(f.filter).length > 0)),
            ) ?? out.cabinets[0];
        }
        if (!cabinet) {
          cabinet = { id: dc.id, name: dc.name, hidden: false, drawers: [] };
          if (cabinetLevel) {
            putInOrder(
              out.cabinets,
              cabinet,
              only(cabinetLevel, df),
              cabinetLevel,
              foldersOfCabinet,
            );
          } else out.cabinets.push(cabinet);
          newCabinet = true;
        }
        let newDrawer = false;
        if (!drawer) {
          drawer = { id: dd.id, name: dd.name, hidden: false, folders: [] };
          putInOrder(cabinet.drawers, drawer, only(drawerLevel, df), drawerLevel, foldersOfDrawer);
          newDrawer = true;
        }
        putInOrder(drawer.folders, df, only(folderLevel, df), folderLevel, (f: CabinetFolder) => [
          f,
        ]);
        // What it adds, as JSON: the new cabinet, else the new drawer, else the folder.
        const more = bytesOf(newCabinet ? cabinet : newDrawer ? drawer : df) + 1;
        if (bytes + more <= CABINET_LIMITS.layout_bytes && layoutProblemOf(out) === null) {
          bytes += more;
          added += 1;
          continue;
        }
        // Past what a cabinet may hold: taken out again, and left in no folder.
        drawer.folders.splice(drawer.folders.indexOf(df), 1);
        if (newDrawer) cabinet.drawers.splice(cabinet.drawers.indexOf(drawer), 1);
        if (newCabinet) out.cabinets.splice(out.cabinets.indexOf(cabinet), 1);
        left += 1;
      }
    }
  }
  return { layout: added > 0 ? out : layout, added, left };
}
