import type {
  Cabinet,
  CabinetDrawer,
  CabinetFolder,
  CabinetLayout,
  CabinetLevel,
  CabinetPreviewAsk,
  DrawnFrom,
  FolderFilter,
} from './cabinet.js';
import {
  CABINET_LEVELS,
  CABINET_LIMITS,
  cabinetName,
  drawnCabinets,
  LEVEL_LIMITS,
  layoutProblemOf,
  levelsProblem,
  ownLevelsProblem,
} from './cabinet.js';
import { compareIssuerNames, NO_ISSUER, NO_ISSUER_GIVEN } from './issuer-groups.js';
import { PLACE_SEPARATOR } from './original-place.js';
import { CATEGORY_LABELS } from './tokens.js';

/**
 * Arranging a cabinet by levels (0.9.0; any order of levels since
 * 0.9.0-dev.90): a cabinet drawn from what the vault knows (the vault's
 * POST /cabinet/preview, and the client's fake). Pure: given how many
 * documents the caller can see of each person, topic, kind and year
 * (`CabinetGroup`, counted by the database with the rules every list
 * keeps), it lays out cabinets, drawers and folders, each folder the list's
 * own question for exactly the documents counted into it — so a folder
 * holds what its drawing said it would.
 *
 * Only the first three levels make cabinets, drawers and folders (two
 * levels: one cabinet, "My cabinet", its drawers and folders). The fourth
 * and fifth are written on each folder as its divider levels, worked out
 * when it opens; with none, Year is the divider unless it is a level above.
 * A cabinet may have its own levels below it (`DrawnFrom.levels`).
 *
 * A paper with no topic (or no kind) where Topic (or Kind) makes a cabinet,
 * drawer or folder has no folder yet: it is counted as left out, and lands
 * in its folder once its details say where. A paper with no issuer where
 * Who issued it makes one (0.9.0-dev.91) is in "No issuer given" instead:
 * many papers have none, and would otherwise be in no folder at all.
 */

/** How many documents share one person, topic, kind and year. */
export interface CabinetGroup {
  /** A person's id, `household`, or `none` (Not sure yet). */
  person: string;
  category: string | null;
  type_key: string | null;
  /** The year the paper is about: issued, else added. */
  year: number;
  /**
   * Who issued it (0.9.0-dev.91): its issuer key, the household's "Same as"
   * list applied; null or absent for none given.
   */
  issuer?: string | null | undefined;
  n: number;
}

/** What the drawing names people and kinds by, as the caller is given them. */
export interface CabinetNames {
  person: (id: string) => string;
  kind: (key: string) => string;
  /** An issuer key's name, the household's spelling (0.9.0-dev.91); the key itself where absent. */
  issuer?: ((key: string) => string) | undefined;
  /** People in the order their cabinets go: the caller first. */
  personOrder: (a: string, b: string) => number;
}

export interface CabinetDrawn {
  layout: CabinetLayout;
  counts: Record<string, number>;
  documents: number;
  left_out: number;
  /** Drawn no further past `DRAWN_MOST` folders: too big to hold, whatever else it would make. */
  capped?: boolean;
}

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
/** A topic's place in the vault's own order: one it does not know, after them. */
export const categoryRank = (c: string) => {
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
interface LevelDef {
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

function levelDefs(names: CabinetNames): Record<CabinetLevel, LevelDef> {
  return {
    person: {
      key: (g) => g.person,
      name: names.person,
      order: names.personOrder,
      filter: (v) => ({ member_id: v }),
      values: (f) => listOf(f.member_id),
    },
    topic: {
      key: (g) => g.category,
      name: categoryName,
      order: (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
      filter: (v) => ({ category: v }),
      values: (f) => listOf(f.category),
    },
    year: {
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
    },
    kind: {
      key: (g) => g.type_key,
      name: names.kind,
      order: (a, b) => names.kind(a).localeCompare(names.kind(b)) || a.localeCompare(b),
      filter: (v) => ({ type_key: v }),
      values: (f) => listOf(f.type_key),
    },
    // Who issued it (0.9.0-dev.91): by name, "No issuer given" last.
    issuer: {
      key: (g) => g.issuer ?? NO_ISSUER,
      name: (v) => (v === NO_ISSUER ? NO_ISSUER_GIVEN : (names.issuer?.(v) ?? v)),
      order: (a, b) => {
        if (a === NO_ISSUER || b === NO_ISSUER) return a === b ? 0 : a === NO_ISSUER ? 1 : -1;
        const name = (v: string) => names.issuer?.(v) ?? v;
        return compareIssuerNames(name(a), name(b)) || compareIssuerNames(a, b);
      },
      filter: (v) => ({ issuer: v }),
      values: (f) => listOf(f.issuer),
    },
  };
}

/** The levels that make nodes: cabinet, drawer and folder; with two, the drawer and the folder. */
export function nodeLevels(levels: readonly CabinetLevel[]): CabinetLevel[] {
  return levels.slice(0, levels.length <= LEVEL_LIMITS.fewest ? levels.length : LEVEL_LIMITS.nodes);
}

/**
 * A drawn folder's divider levels: levels 4 and 5 of its cabinet's; with
 * none, Year, unless it is a level above already — never a "2026" divider
 * in a 2026 drawer.
 */
export function dividerLevelsOf(levels: readonly CabinetLevel[]): CabinetLevel[] {
  const below = levels.length <= LEVEL_LIMITS.nodes ? [] : levels.slice(LEVEL_LIMITS.nodes);
  return below.length === 0 && !levels.includes('year') ? ['year'] : below;
}

/**
 * The levels a drawn cabinet follows, all of them from its own first: the
 * default's, or its own below the default's first level. Null for a layout
 * without levels, or a cabinet not drawn by them.
 */
export function cabinetLevels(
  layout: Pick<CabinetLayout, 'levels'>,
  cabinet: Pick<Cabinet, 'drawn'>,
): CabinetLevel[] | null {
  const levels = layout.levels;
  if (!levels || !cabinet.drawn) return null;
  const own = levels.length >= LEVEL_LIMITS.nodes ? cabinet.drawn.levels : undefined;
  return own ? [levels[0] as CabinetLevel, ...own] : [...levels];
}

/** The groups under one value of a level, each value once, in its level's order. */
function split(groups: readonly CabinetGroup[], level: LevelDef): Array<[string, CabinetGroup[]]> {
  const by = new Map<string, CabinetGroup[]>();
  for (const g of groups) {
    const v = level.key(g);
    if (v === null || v === undefined) continue;
    const list = by.get(v);
    if (list) list.push(g);
    else by.set(v, [g]);
  }
  return [...by].sort(([a], [b]) => level.order(a, b));
}

const total = (gs: readonly CabinetGroup[]) => gs.reduce((n, g) => n + g.n, 0);

/** A name as a drawing gives it: " › " in it made " - ", then cut to a cabinet's length. */
function drawnName(name: string): string {
  return cabinetName(name.split(PLACE_SEPARATOR).join(' - '));
}

/** Names kept to what a cabinet may hold: a long name cut, never refused; never holding " › ". */
function drawnNames(names: CabinetNames): CabinetNames {
  return {
    ...names,
    person: (id) => drawnName(names.person(id)),
    kind: (key) => drawnName(names.kind(key)),
    issuer: (key) => drawnName(names.issuer?.(key) ?? key),
  };
}

/**
 * The most folders one drawing makes: one past what a cabinet may hold, so
 * a drawing too big is still drawn too big (and said so), but never drawn
 * whole, however many groups there are.
 */
export const DRAWN_MOST = CABINET_LIMITS.folders_total + 1;

/** What the drawing of one cabinet needs, and how many folders it has made. */
interface Pen {
  defs: Record<CabinetLevel, LevelDef>;
  newId: () => string;
  counts: Record<string, number>;
  folders: number;
  capped: boolean;
}
const penOf = (defs: Record<CabinetLevel, LevelDef>, newId: () => string): Pen => ({
  defs,
  newId,
  counts: {},
  folders: 0,
  capped: false,
});

/**
 * The drawers and folders of one cabinet: `eff` its levels from its own
 * first (two: no cabinet level), `above` the cabinet's own question.
 */
function drawersOf(
  pen: Pen,
  eff: readonly CabinetLevel[],
  groups: readonly CabinetGroup[],
  above: FolderFilter,
): CabinetDrawer[] {
  const at = eff.length <= LEVEL_LIMITS.fewest ? 0 : 1;
  const drawerLevel = pen.defs[eff[at] as CabinetLevel];
  const folderLevel = pen.defs[eff[at + 1] as CabinetLevel];
  const dividers = dividerLevelsOf(eff);
  const drawers = split(groups, drawerLevel);
  // Past the most drawers a cabinet holds: drawn no further, and said so.
  if (drawers.length > CABINET_LIMITS.drawers + 1) {
    pen.capped = true;
    drawers.length = CABINET_LIMITS.drawers + 1;
  }
  return drawers
    .map(([b, gb]): CabinetDrawer => ({
      id: pen.newId(),
      name: drawerLevel.name(b),
      hidden: false,
      folders: split(gb, folderLevel).flatMap(([c, gc]): CabinetFolder[] => {
        // Past the most a drawing makes: drawn no further.
        if (pen.folders >= DRAWN_MOST) {
          pen.capped = true;
          return [];
        }
        pen.folders += 1;
        const id = pen.newId();
        pen.counts[id] = total(gc);
        const folder: CabinetFolder = {
          id,
          name: folderLevel.name(c),
          hidden: false,
          // Notes are kept apart, as the Documents table keeps them.
          filter: {
            notes: 'exclude',
            ...above,
            ...drawerLevel.filter(b),
            ...folderLevel.filter(c),
          },
          dividers: { levels: [...dividers], ranges: [] },
        };
        return [folder];
      }),
    }))
    .filter((d) => d.folders.length > 0);
}

/** One drawn cabinet: the default's first level's value `a`, its own levels below it if any. */
function cabinetOf(
  pen: Pen,
  levels: readonly CabinetLevel[],
  a: string,
  groups: readonly CabinetGroup[],
  own: readonly CabinetLevel[] | undefined,
): Cabinet {
  const first = pen.defs[levels[0] as CabinetLevel];
  const eff = own ? [levels[0] as CabinetLevel, ...own] : levels;
  const drawn: DrawnFrom = own ? { value: a, levels: [...own] } : { value: a };
  return {
    id: pen.newId(),
    name: first.name(a),
    hidden: false,
    drawn,
    drawers: drawersOf(pen, eff, groups, first.filter(a)),
  };
}

/** The groups a cabinet of value `a` holds. */
function groupsUnder(
  pen: Pen,
  levels: readonly CabinetLevel[],
  a: string,
  groups: readonly CabinetGroup[],
): CabinetGroup[] {
  const first = pen.defs[levels[0] as CabinetLevel];
  return groups.filter((g) => first.key(g) === a);
}

/**
 * The cabinet `levels` draws from `groups`: every folder a question for
 * what it was counted from. `newId` gives each node its id (short, random,
 * unique). `own` gives a cabinet, by its value, its own levels below it.
 */
export function drawCabinet(
  levels: readonly CabinetLevel[],
  groups: readonly CabinetGroup[],
  names: CabinetNames,
  newId: () => string,
  own: ReadonlyMap<string, readonly CabinetLevel[]> = new Map(),
): CabinetDrawn {
  const pen = penOf(levelDefs(drawnNames(names)), newId);
  let cabinets: Cabinet[];
  if (levels.length <= LEVEL_LIMITS.fewest) {
    cabinets = [
      {
        id: newId(),
        name: 'My cabinet',
        hidden: false,
        drawn: { value: null },
        drawers: drawersOf(pen, levels, groups, {}),
      },
    ];
  } else {
    const first = pen.defs[levels[0] as CabinetLevel];
    const values = split(groups, first);
    // Past the most cabinets a layout holds (a level of many values first,
    // Who issued it say): drawn no further, and said so.
    if (values.length > CABINET_LIMITS.cabinets + 1) {
      pen.capped = true;
      values.length = CABINET_LIMITS.cabinets + 1;
    }
    cabinets = values.map(([a, ga]) => cabinetOf(pen, levels, a, ga, own.get(a)));
  }
  // Nothing drawn where a level found nothing to sort by.
  cabinets = cabinets.filter((c) => c.drawers.length > 0);
  const documents = total(groups);
  // Each document is in one folder of a drawing: the rest have no topic, or no kind.
  const left_out = documents - Object.values(pen.counts).reduce((n, x) => n + x, 0);
  return {
    layout: { levels: [...levels], cabinets },
    counts: pen.counts,
    documents,
    left_out,
    ...(pen.capped ? { capped: true } : {}),
  };
}

// ------------------------------------------------------------- redrawing

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A question as one string, whatever the order of its keys or of a tag list. */
function questionKey(f: FolderFilter): string {
  return JSON.stringify(
    Object.entries(f)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

/** Each level's values, read from a question: no names needed. */
const READER: Record<CabinetLevel, (f: FolderFilter) => string[]> = (() => {
  const plain: CabinetNames = { person: (x) => x, kind: (x) => x, personOrder: () => 0 };
  const defs = levelDefs(plain);
  return {
    topic: defs.topic.values,
    person: defs.person.values,
    year: defs.year.values,
    kind: defs.kind.values,
    issuer: defs.issuer.values,
  };
})();

/** The one value a question asks of a level, or undefined where it asks none or several. */
function oneValue(f: FolderFilter, level: CabinetLevel): string | undefined {
  const vs = READER[level](f);
  return vs.length === 1 ? vs[0] : undefined;
}

/** A drawer's value at a level: the one every one of its folders asks; else undefined. */
function drawerValue(d: CabinetDrawer, level: CabinetLevel): string | undefined {
  const vs = d.folders.map((f) => oneValue(f.filter, level));
  const v = vs[0];
  return v !== undefined && vs.every((x) => x === v) ? v : undefined;
}

/** A cabinet there before, with the levels it was drawn by. */
interface Before {
  cabinet: Cabinet;
  levels: readonly CabinetLevel[];
}

/**
 * Parts already there that a redraw may take the place of, each taken
 * once: a drawn cabinet by its value (only while the cabinet level stays),
 * a drawer by what its folders all ask at its own level and the cabinet's,
 * a folder by its whole question. A drawer or folder keeps its name only
 * where it was drawn by the same level: "Tax" never names a person's drawer.
 * Each is looked up by an index made once, so a redraw is as quick for a
 * thousand folders as for ten.
 */
class Kept {
  private readonly used = new Set<string>();
  private readonly cabinets = new Map<string, Cabinet[]>();
  private readonly drawers = new Map<
    string,
    Array<{ drawer: CabinetDrawer; values: Map<CabinetLevel, string | undefined> }>
  >();
  private readonly folders = new Map<
    string,
    Array<{ folder: CabinetFolder; level: CabinetLevel }>
  >();
  constructor(
    before: readonly Before[],
    /** Whether the cabinets were drawn by the same first level as now. */
    private readonly sameCabinets: boolean,
  ) {
    const add = <T>(map: Map<string, T[]>, key: string, x: T) => {
      const list = map.get(key);
      if (list) list.push(x);
      else map.set(key, [x]);
    };
    for (const b of before) {
      const two = b.levels.length <= LEVEL_LIMITS.fewest;
      const drawerLevel = b.levels[two ? 0 : 1];
      const folderLevel = b.levels[two ? 1 : 2];
      if (b.cabinet.drawn) add(this.cabinets, String(b.cabinet.drawn.value), b.cabinet);
      for (const d of b.cabinet.drawers) {
        if (d.folders.length > 0 && drawerLevel) {
          const values = new Map(CABINET_LEVELS.map((l) => [l, drawerValue(d, l)] as const));
          const v = values.get(drawerLevel);
          if (v !== undefined) add(this.drawers, `${drawerLevel}=${v}`, { drawer: d, values });
        }
        for (const f of d.folders) {
          if (folderLevel)
            add(this.folders, questionKey(f.filter), { folder: f, level: folderLevel });
        }
      }
    }
  }
  private free<T extends { id: string }>(list: readonly T[] | undefined): T | undefined {
    const x = list?.find((y) => !this.used.has(y.id));
    if (x) this.used.add(x.id);
    return x;
  }
  cabinet(value: string | null): Cabinet | undefined {
    return this.sameCabinets ? this.free(this.cabinets.get(String(value))) : undefined;
  }
  /** A drawer of `level` holding `value`, in a cabinet of `above` (none: one cabinet of two levels). */
  drawer(
    level: CabinetLevel,
    value: string,
    above: [CabinetLevel, string] | null,
  ): CabinetDrawer | undefined {
    const found = this.drawers
      .get(`${level}=${value}`)
      ?.find(
        (x) =>
          !this.used.has(x.drawer.id) && (above === null || x.values.get(above[0]) === above[1]),
      );
    if (found) this.used.add(found.drawer.id);
    return found?.drawer;
  }
  /** The folder of this very question, and whether it was drawn by `level` too. */
  folder(
    filter: FolderFilter,
    level: CabinetLevel,
  ): { folder: CabinetFolder; sameLevel: boolean } | undefined {
    const found = this.folders.get(questionKey(filter))?.find((x) => !this.used.has(x.folder.id));
    if (!found) return undefined;
    this.used.add(found.folder.id);
    return { folder: found.folder, sameLevel: found.level === level };
  }
}

/**
 * A cabinet drawn afresh, each part that is the same as one already there
 * (`kept`) taking its place: its id, whether it is hidden, and its name
 * where it was drawn by the same level — and, a folder, its pins (they
 * follow its id) and its own date ranges. Its counts follow the ids.
 */
function keepWhatFits(
  fresh: Cabinet,
  levels: readonly CabinetLevel[],
  kept: Kept,
  counts: Record<string, number>,
): Cabinet {
  const two = levels.length <= LEVEL_LIMITS.fewest;
  const eff = two
    ? levels
    : [levels[0] as CabinetLevel, ...(fresh.drawn?.levels ?? levels.slice(1))];
  const drawerLevel = eff[two ? 0 : 1] as CabinetLevel;
  const folderLevel = eff[two ? 1 : 2] as CabinetLevel;
  const value = fresh.drawn?.value ?? null;
  const was = kept.cabinet(value);
  const above: [CabinetLevel, string] | null =
    two || value === null ? null : [levels[0] as CabinetLevel, value];
  const drawers = fresh.drawers.map((d): CabinetDrawer => {
    const v = drawerValue(d, drawerLevel);
    const old = v === undefined ? undefined : kept.drawer(drawerLevel, v, above);
    const folders = d.folders.map((f): CabinetFolder => {
      const o = kept.folder(f.filter, folderLevel);
      if (!o) return f;
      const n = counts[f.id];
      delete counts[f.id];
      if (n !== undefined) counts[o.folder.id] = n;
      return {
        ...f,
        id: o.folder.id,
        name: o.sameLevel ? o.folder.name : f.name,
        hidden: o.folder.hidden,
        dividers: {
          levels: f.dividers?.levels ?? [],
          ranges: clone(o.folder.dividers?.ranges ?? []),
        },
      };
    });
    return old
      ? { ...d, id: old.id, name: old.name, hidden: old.hidden, folders }
      : { ...d, folders };
  });
  return was
    ? { ...fresh, id: was.id, name: was.name, hidden: was.hidden, drawers }
    : { ...fresh, drawers };
}

/**
 * A drawn cabinet's folders with the divider levels its new levels give
 * them: nothing redrawn, every part, pin and range of its own kept (only
 * levels 4 and 5 changed). A folder whose dividers were set by hand — no
 * longer what the old levels wrote — keeps them.
 */
function newDividers(
  c: Cabinet,
  before: readonly CabinetLevel[],
  after: readonly CabinetLevel[],
): Cabinet {
  const was = dividerLevelsOf(before);
  const now = dividerLevelsOf(after);
  return {
    ...c,
    drawers: c.drawers.map((d) => ({
      ...d,
      folders: d.folders.map((f) =>
        same(f.dividers?.levels ?? ['year'], was)
          ? { ...f, dividers: { levels: [...now], ranges: f.dividers?.ranges ?? [] } }
          : f,
      ),
    })),
  };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** What a redraw is refused with: the ask, in words. */
export class RedrawRefused extends Error {}

/**
 * A layout redrawn by levels (0.9.0-dev.90), over what is there (`base`),
 * never saved: POST /cabinet/preview, and the client's fake.
 *
 *  - The default's levels 4 and 5 only: no folder redrawn; each drawn
 *    folder's divider levels rewritten.
 *  - Its levels 2 and 3: every drawn cabinet that follows the default is
 *    drawn again; one with its own arrangement is kept as it is.
 *  - Its first level (or no levels before): every cabinet drawn again,
 *    their own arrangements let go — the cabinets themselves change.
 *  - One cabinet's own levels (`ask.cabinet`, null for the default's
 *    again): that cabinet alone, below the default's first level, its
 *    levels 4 and 5 alone only rewriting its dividers.
 *
 * One structure (0.9.0-dev.94): every cabinet is drawn, and one not drawn
 * by the levels — or any, over no levels — is not kept. Wherever the same
 * cabinet, drawer or folder is drawn again, it keeps its id, name and
 * hidden flag — a folder its pins and its own date ranges too. Kept and
 * redrawn cabinets stay where the person put them; a new one goes in its
 * level's order among them, else last.
 */
export function redrawCabinet(
  base: CabinetLayout | null,
  ask: Pick<CabinetPreviewAsk, 'levels' | 'cabinet'>,
  groups: readonly CabinetGroup[],
  names: CabinetNames,
  newId: () => string,
): CabinetDrawn {
  const wrong = levelsProblem(ask.levels);
  if (wrong) throw new RedrawRefused(wrong);
  const levels = [...ask.levels];
  const before: CabinetLayout = base ? clone(base) : { levels: null, cabinets: [] };
  // Only drawn cabinets, and none over no levels: one structure.
  before.cabinets = drawnCabinets(before);
  const old = before.levels;
  const defs = levelDefs(drawnNames(names));
  const ownOf = (cabs: readonly Cabinet[]) =>
    new Map(
      cabs.flatMap((c) =>
        c.drawn?.levels && c.drawn.value !== null ? [[c.drawn.value, c.drawn.levels] as const] : [],
      ),
    );
  const documents = total(groups);
  const done = (
    cabinets: Cabinet[],
    counts: Record<string, number>,
    capped = false,
  ): CabinetDrawn => {
    const layout: CabinetLayout = { levels, cabinets };
    // What no folder of the drawn cabinets holds, as the whole drawing would leave out.
    let n = 0;
    const whole = drawCabinet(levels, groups, names, () => `left-${++n}`, ownOf(cabinets));
    return {
      layout,
      counts,
      documents,
      left_out: whole.left_out,
      ...(capped || whole.capped ? { capped: true } : {}),
    };
  };

  if (ask.cabinet) {
    // One cabinet's own arrangement: over a layout drawn by these very levels.
    if (old === null || !same(old, levels)) {
      throw new RedrawRefused(
        'Use the arrangement for every cabinet first, then arrange one cabinet.',
      );
    }
    const at = before.cabinets.findIndex((c) => c.id === ask.cabinet?.id);
    const was = before.cabinets[at];
    if (!was) {
      throw new RedrawRefused(
        'That cabinet isn’t there any more: it may have been changed in another window. Load your cabinet again and try once more.',
      );
    }
    if (!was.drawn || was.drawn.value === null) {
      throw new RedrawRefused(
        'A cabinet can have its own arrangement only while your cabinet is arranged by three levels or more.',
      );
    }
    const own = ask.cabinet.levels;
    // Its levels as they are: nothing to redraw.
    if (same(own ?? [], was.drawn.levels ?? [])) return done(before.cabinets, {});
    if (own !== null) {
      const ownWrong = ownLevelsProblem(own, levels);
      if (ownWrong) throw new RedrawRefused(ownWrong);
    }
    const effOld = cabinetLevels(before, was) as CabinetLevel[];
    const effNew = own ? [levels[0] as CabinetLevel, ...own] : levels;
    const drawn: DrawnFrom = own
      ? { value: was.drawn.value, levels: [...own] }
      : { value: was.drawn.value };
    const cabinets = [...before.cabinets];
    if (same(nodeLevels(effOld), nodeLevels(effNew))) {
      cabinets[at] = { ...newDividers(was, effOld, effNew), drawn };
      return done(cabinets, {});
    }
    const pen = penOf(defs, newId);
    const value = was.drawn.value;
    const fresh = cabinetOf(
      pen,
      levels,
      value,
      groupsUnder(pen, levels, value, groups),
      own ?? undefined,
    );
    const kept = new Kept([{ cabinet: was, levels: effOld }], true);
    cabinets[at] = keepWhatFits(fresh, levels, kept, pen.counts);
    return done(cabinets, pen.counts, pen.capped);
  }

  // The same levels: nothing to redraw, everything as it is.
  if (old !== null && same(old, levels)) return done(before.cabinets, {});

  // The default: levels 4 and 5 alone redraw nothing.
  if (old !== null && same(nodeLevels(old), nodeLevels(levels))) {
    const out = { levels, cabinets: before.cabinets };
    return done(
      before.cabinets.map((c) => {
        const was = cabinetLevels(before, c);
        const now = cabinetLevels(out, c);
        return was && now ? newDividers(c, was, now) : c;
      }),
      {},
    );
  }
  const firstKept =
    old !== null &&
    old.length >= LEVEL_LIMITS.nodes &&
    levels.length >= LEVEL_LIMITS.nodes &&
    old[0] === levels[0];
  // Own arrangements stay while the cabinet level does; else they are let go.
  const ownKept = firstKept ? ownOf(before.cabinets) : new Map();
  const drawing = drawCabinet(levels, groups, names, newId, ownKept);
  const counts = drawing.counts;
  const ownOne = (c: Cabinet) => c.drawn?.value != null && ownKept.has(c.drawn.value);
  const replaced = before.cabinets.filter((c) => !ownOne(c));
  const bothTwo =
    old !== null && old.length <= LEVEL_LIMITS.fewest && levels.length <= LEVEL_LIMITS.fewest;
  const kept = new Kept(
    replaced.map((c) => ({ cabinet: c, levels: cabinetLevels(before, c) ?? [] })),
    firstKept || bothTwo,
  );
  const fresh = drawing.layout.cabinets
    .filter((c) => !ownOne(c))
    .map((c) => keepWhatFits(c, levels, kept, counts));
  // Where each goes: a redrawn one in the place of the one it took, kept
  // ones where they were, the rest in their level's order among them.
  const byId = new Map(fresh.map((c) => [c.id, c]));
  const out: Cabinet[] = [];
  for (const c of before.cabinets) {
    if (ownOne(c)) out.push(c);
    else {
      const now = byId.get(c.id);
      if (now) {
        out.push(now);
        byId.delete(c.id);
      }
    }
  }
  const first = defs[levels[0] as CabinetLevel];
  for (const c of fresh.filter((x) => byId.has(x.id))) {
    const v = c.drawn?.value ?? null;
    const at =
      v === null || levels.length <= LEVEL_LIMITS.fewest
        ? -1
        : out.findIndex((x) => x.drawn?.value != null && first.order(v, x.drawn.value) < 0);
    // Else last.
    out.splice(at !== -1 ? at : out.length, 0, c);
  }
  return done(out, counts, drawing.capped);
}

// ------------------------------------------------------------- growing

/**
 * The node of `list` for value `v` of a level: one whose every folder asks
 * just it, else one any folder of which asks it among others (a merged
 * drawer, "Medical and Financial"). None for none.
 */
function nodeFor<T>(
  list: readonly T[],
  level: LevelDef,
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
 * level (a drawer merged by hand, say) is passed over; with none after it,
 * it goes last.
 */
function putInOrder<T>(
  list: T[],
  item: T,
  value: string,
  level: LevelDef,
  foldersOf: (x: T) => readonly CabinetFolder[],
): void {
  const at = list.findIndex((x) => {
    const v = foldersOf(x).flatMap((f) => level.values(f.filter))[0];
    return v !== undefined && level.order(value, v) < 0;
  });
  if (at === -1) list.push(item);
  else list.splice(at, 0, item);
}

const foldersOfDrawer = (d: CabinetDrawer) => d.folders;
/** As JSON, in UTF-8 bytes, as Postgres keeps a layout: a character of Chinese is three. */
export function bytesOf(x: unknown): number {
  let n = 0;
  for (const ch of JSON.stringify(x)) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * A drawn cabinet kept up to date (19 Nov 2026): a layout drawn by levels
 * is a snapshot of the topics, years and people there were when it was
 * drawn, so a paper of a new topic, year or person had no folder. Given the
 * papers no folder of it holds (`groups`, counted as `drawCabinet`'s are),
 * this adds their folders where the drawing would have put them — into the
 * drawn cabinet of their value (found by `drawn.value`, so a renamed or
 * empty one is still found), with its own levels if it has any, and the
 * drawer already there for theirs (found by what its folders ask), else new
 * ones, in the drawing's order — and leaves every other folder as it was.
 * Levels 4 and 5 never need growing: dividers are worked out as a folder
 * opens. Folders are added one at a time, up to what a cabinet may hold
 * (`CABINET_LIMITS`): those past it are not, and their papers stay in no
 * folder. A layout without levels is never changed.
 */
export function addToDrawing(
  layout: CabinetLayout,
  groups: readonly CabinetGroup[],
  names: CabinetNames,
  newId: () => string,
): { layout: CabinetLayout; added: number; left: number } {
  const levels = layout.levels;
  if (!Array.isArray(levels) || levelsProblem(levels) !== null || groups.length === 0) {
    return { layout, added: 0, left: 0 };
  }
  const two = levels.length <= LEVEL_LIMITS.fewest;
  const own = new Map(
    two
      ? []
      : layout.cabinets.flatMap((c) =>
          c.drawn?.levels &&
          c.drawn.value !== null &&
          ownLevelsProblem(c.drawn.levels, levels) === null
            ? [[c.drawn.value, c.drawn.levels] as const]
            : [],
        ),
  );
  const drawn = drawCabinet(levels, groups, names, newId, own);
  const defs = levelDefs(names);
  const out = clone(layout);
  let bytes = bytesOf(out);
  let added = 0;
  let left = 0;
  const first = defs[levels[0] as CabinetLevel];
  const only = (level: CabinetLevel, f: CabinetFolder) => defs[level].values(f.filter)[0] as string;
  for (const dc of drawn.layout.cabinets) {
    const value = dc.drawn?.value ?? null;
    const mine = value === null ? undefined : own.get(value);
    const eff = two ? levels : mine ? [levels[0] as CabinetLevel, ...mine] : levels;
    const drawerLevel = eff[two ? 0 : 1] as CabinetLevel;
    const folderLevel = eff[two ? 1 : 2] as CabinetLevel;
    for (const dd of dc.drawers) {
      for (const df of dd.folders) {
        // Its cabinet: the drawn one of its value, else a new one.
        let cabinet = out.cabinets.find((c) => c.drawn && (c.drawn.value ?? null) === value);
        let newCabinet = false;
        if (!cabinet) {
          cabinet = {
            id: dc.id,
            name: dc.name,
            hidden: false,
            drawn: clone(dc.drawn),
            drawers: [],
          };
          const at =
            value === null
              ? -1
              : out.cabinets.findIndex(
                  (c) => c.drawn?.value != null && first.order(value, c.drawn.value) < 0,
                );
          if (at === -1) out.cabinets.push(cabinet);
          else out.cabinets.splice(at, 0, cabinet);
          newCabinet = true;
        }
        let drawer = nodeFor(
          cabinet.drawers,
          defs[drawerLevel],
          only(drawerLevel, df),
          foldersOfDrawer,
        );
        let newDrawer = false;
        if (!drawer) {
          drawer = { id: dd.id, name: dd.name, hidden: false, folders: [] };
          putInOrder(
            cabinet.drawers,
            drawer,
            only(drawerLevel, df),
            defs[drawerLevel],
            foldersOfDrawer,
          );
          newDrawer = true;
        }
        putInOrder(
          drawer.folders,
          df,
          only(folderLevel, df),
          defs[folderLevel],
          (f: CabinetFolder) => [f],
        );
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

// ------------------------------------------------------------- issuers said to be one

/**
 * A drawn cabinet made one again where the household said two issuers are
 * the same (0.9.0-dev.91): folders, drawers or cabinets drawn for each of
 * them hold the same papers now, so each set of them is merged into one —
 * `rootOf` says which group a key is in, `prefer` which of a set's keys the
 * survivor should have (the one the reader knows the group by), else the
 * first in order. The survivor keeps its id, name and place; a folder its
 * dividers (taking the other's own ranges where it has none), shown if
 * either was; each merged folder's pins go to it (`moved`). Only parts that
 * differ by issuer alone: a part merged or renamed by hand otherwise is
 * left as it is. Separating them needs nothing here: the papers
 * that leave a group are in no folder, and the drawing grows one for them.
 */
export function mergeSameIssuers(
  layout: CabinetLayout,
  rootOf: (key: string) => string,
  prefer: (key: string) => boolean = () => false,
): { layout: CabinetLayout; moved: Array<{ from: string; to: string }>; changed: boolean } {
  const levels = layout.levels;
  const moved: Array<{ from: string; to: string }> = [];
  if (!Array.isArray(levels)) return { layout, moved, changed: false };
  const out = clone(layout);
  out.cabinets = drawnCabinets(out);
  let changed = false;
  /** A question with its issuers as their groups: the same papers, the same question. */
  const canon = (f: FolderFilter): FolderFilter =>
    f.issuer === undefined
      ? f
      : {
          ...f,
          issuer: [
            ...new Set(
              f.issuer
                .split(',')
                .filter((x) => x !== '')
                .map(rootOf),
            ),
          ]
            .sort()
            .join(','),
        };
  const preferred = <T>(list: T[], keyOf: (x: T) => string | undefined): T =>
    list.find((x) => {
      const k = keyOf(x);
      return k !== undefined && k.split(',').some(prefer);
    }) ?? (list[0] as T);
  /** Sets of `list` the same by `key` (and different as written), each merged into one. */
  const mergeAll = <T>(
    list: T[],
    key: (x: T) => string | undefined,
    written: (x: T) => string | undefined,
    issuerOf: (x: T) => string | undefined,
    into: (survivor: T, other: T) => void,
  ): T[] => {
    const sets = new Map<string, T[]>();
    for (const x of list) {
      const k = key(x);
      if (k === undefined) continue;
      sets.set(k, [...(sets.get(k) ?? []), x]);
    }
    const gone = new Set<T>();
    for (const set of sets.values()) {
      if (set.length < 2 || new Set(set.map(written)).size < 2) continue;
      const survivor = preferred(set, issuerOf);
      for (const other of set) {
        if (other === survivor) continue;
        into(survivor, other);
        gone.add(other);
        changed = true;
      }
    }
    return gone.size === 0 ? list : list.filter((x) => !gone.has(x));
  };
  const mergeFolders = (folders: CabinetFolder[]) =>
    mergeAll(
      folders,
      (f) => (f.filter.issuer === undefined ? undefined : questionKey(canon(f.filter))),
      (f) => questionKey(f.filter),
      (f) => f.filter.issuer,
      (s, o) => {
        moved.push({ from: o.id, to: s.id });
        s.hidden = s.hidden && o.hidden;
        if ((s.dividers?.ranges.length ?? 0) === 0 && (o.dividers?.ranges.length ?? 0) > 0) {
          s.dividers = {
            levels: s.dividers?.levels ?? [],
            ranges: clone(o.dividers?.ranges ?? []),
          };
        }
      },
    );
  const drawerIssuer = (d: CabinetDrawer) => {
    const vs = d.folders.map((f) => f.filter.issuer);
    return vs[0] !== undefined && vs.every((v) => v === vs[0]) ? vs[0] : undefined;
  };
  /** Cabinets another was merged into: their drawers of one value are merged in turn. */
  const joined = new Set<Cabinet>();
  // Cabinets of one issuer's group, where Who issued it makes the cabinets.
  if (levels[0] === 'issuer' && levels.length > LEVEL_LIMITS.fewest) {
    const kept = mergeAll(
      out.cabinets,
      (c) => (c.drawn?.value ? rootOf(c.drawn.value) : undefined),
      (c) => c.drawn?.value ?? undefined,
      (c) => c.drawn?.value ?? undefined,
      (s, o) => {
        s.hidden = s.hidden && o.hidden;
        s.drawers.push(...o.drawers);
        joined.add(s);
      },
    );
    out.cabinets = out.cabinets.filter((c) => kept.includes(c));
  }
  for (const c of out.cabinets) {
    const eff = cabinetLevels(out, c) ?? [];
    const drawerLevel = eff[eff.length <= LEVEL_LIMITS.fewest ? 0 : 1];
    // Drawers of one issuer's group, where Who issued it makes the drawers.
    if (drawerLevel === 'issuer') {
      c.drawers = mergeAll(
        c.drawers,
        (d) => {
          const v = drawerIssuer(d);
          return v === undefined ? undefined : canon({ issuer: v }).issuer;
        },
        drawerIssuer,
        drawerIssuer,
        (s, o) => {
          s.hidden = s.hidden && o.hidden;
          s.folders.push(...o.folders);
        },
      );
    } else if (joined.has(c) && drawerLevel !== undefined) {
      // Drawers by another level, merged by their value, once their cabinets were.
      const level = drawerLevel as CabinetLevel;
      c.drawers = mergeAll(
        c.drawers,
        (d) => drawerValue(d, level),
        (d) => d.id,
        () => undefined,
        (s, o) => {
          s.hidden = s.hidden && o.hidden;
          s.folders.push(...o.folders);
        },
      );
    }
    for (const d of c.drawers) d.folders = mergeFolders(d.folders);
  }
  return changed ? { layout: out, moved, changed } : { layout, moved: [], changed: false };
}
