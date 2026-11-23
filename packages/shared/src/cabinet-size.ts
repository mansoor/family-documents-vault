import {
  CABINET_LIMITS,
  layoutProblemOf,
  layoutSize,
  LEVEL_LIMITS,
  CABINET_LEVEL_WORDS,
  type CabinetLayout,
  type CabinetLevel,
  type CabinetSize,
} from './cabinet.js';
import { bytesOf } from './cabinet-draw.js';

/**
 * How big a cabinet is, and the warning before it is saved (0.9.0-dev.90):
 * a layout is refused only past `CABINET_LIMITS`, but long before that a
 * cabinet takes many clicks to open. The level picker says so, and offers
 * to move the level that makes so many folders down to the dividers, where
 * it costs none.
 */

/** Above these a cabinet takes many clicks: said, never refused. */
export const CABINET_WARN = {
  /** Folders in all. */
  folders_total: 300,
  /** Folders in one drawer. */
  folders: 40,
  /** Drawers in one cabinet. */
  drawers: 30,
  /** Of a hard limit: a cabinet that grows will reach it. */
  near: 0.8,
} as const;

/** A layout's size: its parts, its fullest drawer, its cabinet with most drawers, and what refuses it. */
export function cabinetSize(layout: CabinetLayout): CabinetSize {
  const size = layoutSize(layout);
  let biggestDrawer: CabinetSize['biggest_drawer'] = null;
  let biggestCabinet: CabinetSize['biggest_cabinet'] = null;
  for (const c of layout.cabinets) {
    if (!biggestCabinet || c.drawers.length > biggestCabinet.drawers) {
      biggestCabinet = { cabinet_id: c.id, name: c.name, drawers: c.drawers.length };
    }
    for (const d of c.drawers) {
      if (!biggestDrawer || d.folders.length > biggestDrawer.folders) {
        biggestDrawer = { cabinet_id: c.id, path: [c.name, d.name], folders: d.folders.length };
      }
    }
  }
  const problem = layoutProblemOf(layout);
  const over =
    problem?.code === 'cabinet_too_big' || problem?.code === 'cabinet_too_many_status_folders'
      ? problem.code
      : bytesOf(layout) > CABINET_LIMITS.layout_bytes
        ? 'cabinet_too_big'
        : null;
  return { ...size, biggest_drawer: biggestDrawer, biggest_cabinet: biggestCabinet, over };
}

/** What a size warns of: too many folders, a full drawer, a cabinet of many drawers, or near a limit. */
export type SizeWarning =
  | { code: 'folders_total'; folders: number }
  | { code: 'folders'; path: [string, string]; folders: number; cabinet_id: string }
  | { code: 'drawers'; name: string; drawers: number; cabinet_id: string }
  | { code: 'near'; folders: number };

/** Each warning a size gives, the worst first: what the picker says in amber. */
export function sizeWarnings(size: CabinetSize): SizeWarning[] {
  const out: SizeWarning[] = [];
  const d = size.biggest_drawer;
  if (d && d.folders > CABINET_WARN.folders) {
    out.push({ code: 'folders', path: d.path, folders: d.folders, cabinet_id: d.cabinet_id });
  }
  const c = size.biggest_cabinet;
  if (c && c.drawers > CABINET_WARN.drawers) {
    out.push({ code: 'drawers', name: c.name, drawers: c.drawers, cabinet_id: c.cabinet_id });
  }
  if (size.folders > CABINET_WARN.folders_total) {
    out.push({ code: 'folders_total', folders: size.folders });
  }
  const near = (n: number, limit: number) => n >= limit * CABINET_WARN.near;
  if (
    out.length === 0 &&
    (near(size.folders, CABINET_LIMITS.folders_total) ||
      near(size.nodes, CABINET_LIMITS.nodes) ||
      near(size.cabinets, CABINET_LIMITS.cabinets) ||
      (c !== null && near(c.drawers, CABINET_LIMITS.drawers)) ||
      (d !== null && near(d.folders, CABINET_LIMITS.folders)))
  ) {
    out.push({ code: 'near', folders: size.folders });
  }
  return out;
}

const NUMBER = new Intl.NumberFormat('en-GB');
const count = (n: number, one: string, many: string) =>
  `${NUMBER.format(n)} ${n === 1 ? one : many}`;

/** A warning in words, for a family to read. */
export function sizeWarningWords(w: SizeWarning): string {
  switch (w.code) {
    case 'folders':
      return `The drawer ${w.path.join(' › ')} alone holds ${count(w.folders, 'folder', 'folders')}.`;
    case 'drawers':
      return `The cabinet ${w.name} has ${count(w.drawers, 'drawer', 'drawers')}.`;
    case 'folders_total':
      return `This makes ${count(w.folders, 'folder', 'folders')} in your cabinet.`;
    case 'near':
      return `This makes ${count(w.folders, 'folder', 'folders')}, close to the most a cabinet can hold, and it grows as papers are added.`;
  }
}

/** A way out of a warning: the level that makes so many, and the levels with it moved down. */
export interface MoveDown {
  level: CabinetLevel;
  levels: CabinetLevel[];
  /** A level not in use put in above it, where it could go no further down by itself. */
  added?: CabinetLevel;
  /** Whether it ends up a divider inside the folders, costing none. */
  divider: boolean;
}

/** Which level not in use goes in above one that can go no further down: the fewest groups first. */
const SPARE_ORDER: readonly CabinetLevel[] = ['year', 'person', 'topic', 'kind'];

/**
 * The level a warning comes from, among the levels being chosen (`levels`,
 * from the cabinet's own first, or from its drawer for one cabinet's own
 * arrangement: `below` true, `taken` the cabinet's own level): the
 * folders' level for too many folders, the drawers' for a cabinet of many
 * drawers. And where it goes: down to the first divider, else as far down
 * as there is; already last, a level not in use goes in above it (Year
 * first), pushing it down — Topic › Year › Kind becomes Topic › Year ›
 * Person › Kind, its kinds dividers. Null where there is no way: five
 * levels already, or none left to put in.
 */
export function moveDownFor(
  levels: readonly CabinetLevel[],
  w: SizeWarning,
  below = false,
  taken: readonly CabinetLevel[] = [],
): MoveDown | null {
  const two = !below && levels.length <= LEVEL_LIMITS.fewest;
  // Where the drawer, the folder and the first divider are in this list.
  const drawerAt = two ? 0 : below ? 0 : 1;
  const folderAt = drawerAt + 1;
  const firstDivider = below ? LEVEL_LIMITS.nodes - 1 : LEVEL_LIMITS.nodes;
  const from = w.code === 'drawers' ? drawerAt : folderAt;
  const level = levels[from];
  if (level === undefined) return null;
  /** Its place among every level, the cabinet's own first. */
  const placeOf = (list: readonly CabinetLevel[]) => list.indexOf(level) + (below ? 1 : 0);
  const to = Math.min(firstDivider, levels.length - 1);
  if (to > from) {
    const out = levels.filter((_, i) => i !== from);
    out.splice(to, 0, level);
    return { level, levels: out, divider: placeOf(out) >= LEVEL_LIMITS.nodes };
  }
  if (levels.length + taken.length >= LEVEL_LIMITS.most) return null;
  const spare = SPARE_ORDER.find((l) => !levels.includes(l) && !taken.includes(l));
  if (!spare) return null;
  const out = [...levels];
  out.splice(from, 0, spare);
  return { level, levels: out, added: spare, divider: placeOf(out) >= LEVEL_LIMITS.nodes };
}

/** The offer to move a level down, in words. */
export function moveDownWords(fix: MoveDown): string {
  const name = CABINET_LEVEL_WORDS[fix.level].name;
  const where = fix.divider
    ? 'where it becomes dividers inside them and costs no folders'
    : 'where it makes fewer folders';
  return fix.added
    ? `Add ${CABINET_LEVEL_WORDS[fix.added].name} above ${name}, which then goes below the folders, ${where}.`
    : fix.divider
      ? `Move ${name} below the folders, ${where}.`
      : `Move ${name} further down, ${where}.`;
}

/** What to do where there is no level to move down for the person, in words. */
export const NO_MOVE_WORDS =
  'Choose a level with fewer groups for the folders — Year or Person usually have fewest — or put the one with most groups fourth or fifth, where it makes dividers instead of folders.';
