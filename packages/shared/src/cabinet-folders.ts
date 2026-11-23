/**
 * Bring your tree (0.9.0, C4; the owner's idea 6 of 13 Nov 2026): the
 * folders a family's papers came from, kept as the cabinet's own.
 *
 * A document filed from a batch's item that had a folder — Add → Many
 * documents with a folder, the scanner folder, a paired computer — keeps it
 * (`DocumentView.source_folder`, "Taxes/2025"). "Keep this folder tree as my
 * cabinet" draws a cabinet folder for each folder the caller's papers came
 * from, asking for exactly that folder (`source_folder`), so the papers in
 * it now — and any filed from it later — are in it by themselves.
 *
 * A folder tree is deeper than a cabinet (cabinet › drawer › folder), so it
 * is laid out in one cabinet, "My folders": each top folder a drawer, and
 * each folder under it one of the drawer's folders, named by its path under
 * the top ("2025", "2025 / Payslips"); papers right in the top folder are in
 * a folder of the drawer's own name.
 *
 * Nothing already there is changed: the drawing is added beside the
 * caller's cabinets (into a shown "My folders" if they have one, and its
 * drawers by name), and a folder their cabinet asks for already, shown or
 * hidden, is left as it is. What a cabinet cannot hold is left out and
 * counted. The vault draws it (GET /cabinet/from-folders) and the caller
 * keeps it, after looking at it, with PUT /cabinet.
 */

import {
  CABINET_LIMITS,
  layoutSize,
  type Cabinet,
  type CabinetDrawer,
  type CabinetFolder,
  type CabinetLayout,
} from './cabinet.js';
import { PLACE_SEPARATOR } from './original-place.js';

/** The cabinet a folder tree is laid out in. */
export const FOLDERS_CABINET = 'My folders';

/** A folder papers came from, and how many of the caller's documents did. */
export interface SourceFolder {
  /** "Taxes/2025": its folders, joined by `/`, as the document keeps them. */
  path: string;
  /** How many documents the caller sees from it, notes left out, out of the Trash. */
  documents: number;
}

/** GET /cabinet/from-folders: the caller's cabinet with their folders added, not saved. */
export interface CabinetFromFolders {
  /** The version of the cabinet it was drawn on: PUT /cabinet with it, else 409. */
  version: number;
  /** The cabinet as it would be: everything there now, as it is, and the folders added. */
  layout: CabinetLayout;
  /** Every folder the caller's papers came from, in order. */
  folders: SourceFolder[];
  /** What is new. */
  added: { cabinets: number; drawers: number; folders: number };
  /** Each new folder, by its id, and how many documents it holds for the caller. */
  counts: Record<string, number>;
  /** Folders the cabinet asks for already (shown or hidden): left as they are. */
  already: number;
  /** Folders past what a cabinet can hold: left out. */
  left_out: number;
}

/** A path's folders: "Taxes/2025" → ["Taxes", "2025"]. */
export function folderParts(path: string): string[] {
  return path.split('/').filter((s) => s.trim() !== '');
}

/**
 * A name kept to `most` characters from its end, "…" before it: the end of
 * a path is what tells two folders apart ("…/Payslips 2024", "…/Payslips 2025").
 */
function keepEnd(name: string, most: number): string {
  const chars = [...name.trim()];
  return chars.length <= most
    ? chars.join('')
    : `…${chars
        .slice(-(most - 1))
        .join('')
        .trimStart()}`;
}

/** A path's part, as a cabinet may name it: never holding " › " (C3), at most 80 characters, its end kept. */
function nodeName(name: string): string {
  return keepEnd(name.split(PLACE_SEPARATOR).join(' - '), CABINET_LIMITS.name);
}

/**
 * `name`, or — when a sibling has it already, whatever the case — `name (2)`,
 * `name (3)`…, each within 80 characters: no two in a drawer (or a cabinet)
 * share a name.
 */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${keepEnd(name, CABINET_LIMITS.name - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders in the order a tree is read: each part in turn, a folder before those inside it. */
export function compareFolders(a: string, b: string): number {
  const pa = folderParts(a);
  const pb = folderParts(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = collator.compare(pa[i] as string, pb[i] as string);
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}

/** Where a folder goes: its drawer (the top folder) and its own name there. */
export function folderPlace(path: string): { drawer: string; folder: string } {
  const parts = folderParts(path);
  const top = parts[0] ?? path;
  return {
    drawer: nodeName(top),
    folder: nodeName(parts.length > 1 ? parts.slice(1).join(' / ') : top),
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const namesOf = (nodes: ReadonlyArray<{ name: string }>) =>
  new Set(nodes.map((n) => n.name.trim().toLowerCase()));
/** A value's JSON, in UTF-8 bytes. */
function bytesOf(v: unknown): number {
  let n = 0;
  for (const ch of JSON.stringify(v)) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** A folder to add: as GET /cabinet/from-folders gives it, with the key it is compared by. */
export type FolderToAdd = SourceFolder & {
  /** The path as the vault compares it, whatever the case (Postgres' `lower`); else lowered here. */
  key?: string;
};

/** Every folder a layout's folders ask for (`source_folder`), shown or hidden. */
export function askedFolders(layout: CabinetLayout | null): string[] {
  return (layout?.cabinets ?? []).flatMap((c) =>
    c.drawers.flatMap((d) =>
      d.folders.flatMap((f) =>
        typeof f.filter.source_folder === 'string' ? [f.filter.source_folder] : [],
      ),
    ),
  );
}

/**
 * The caller's cabinet with a folder for each of `folders` it does not ask
 * for already, added as the module says; nothing of it changed. `newId`
 * gives each new cabinet, drawer and folder its id. A folder is compared by
 * its `key`, and a layout's question by `opts.key` — the vault gives both
 * as Postgres lowers them, so "already there" is what its filter matches —
 * else each is lowered here.
 */
export function addFolderTree(
  layout: CabinetLayout | null,
  folders: readonly FolderToAdd[],
  newId: () => string,
  opts: { key?: (path: string) => string } = {},
): Omit<CabinetFromFolders, 'version' | 'folders'> {
  const keyOf = opts.key ?? ((path: string) => path.toLowerCase());
  const out: CabinetLayout = layout
    ? (JSON.parse(JSON.stringify(layout)) as CabinetLayout)
    : { levels: null, cabinets: [] };
  const asked = new Set(askedFolders(out).map(keyOf));
  const added = { cabinets: 0, drawers: 0, folders: 0 };
  const counts: Record<string, number> = {};
  let already = 0;
  let leftOut = 0;
  const todo = [...folders]
    .filter((f) => {
      if (!asked.has(f.key ?? keyOf(f.path))) return true;
      already += 1;
      return false;
    })
    .sort((a, b) => compareFolders(a.path, b.path));
  if (todo.length === 0) return { layout: out, added, counts, already, left_out: 0 };

  let cabinet: Cabinet | undefined = out.cabinets.find(
    (c) => !c.hidden && same(c.name, FOLDERS_CABINET),
  );
  let made: Cabinet | null = null;
  if (!cabinet) {
    if (out.cabinets.length >= CABINET_LIMITS.cabinets) {
      return { layout: out, added, counts, already, left_out: todo.length };
    }
    made = { id: newId(), name: FOLDERS_CABINET, hidden: false, drawers: [] };
    cabinet = made;
  }
  const size = layoutSize(out);
  let nodes = size.nodes + (made ? 1 : 0);
  let folderCount = size.folders;
  // By its bytes, as the vault keeps it, with room to spare (CABINET_LIMITS.layout_bytes).
  let bytes = bytesOf(out) + (made ? bytesOf(made) : 0);
  const room = CABINET_LIMITS.layout_bytes - 1024;
  // The drawers there before, matched by name; those made here, by their top folder.
  const before = cabinet.drawers.filter((d) => !d.hidden);
  const madeDrawers = new Map<string, CabinetDrawer>();

  for (const f of todo) {
    const where = folderPlace(f.path);
    const top = (folderParts(f.path)[0] ?? f.path).toLowerCase();
    let drawer: CabinetDrawer | undefined =
      madeDrawers.get(top) ?? before.find((d) => same(d.name, where.drawer));
    const newDrawer: CabinetDrawer | null = drawer
      ? null
      : {
          id: newId(),
          name: uniqueName(where.drawer, namesOf(cabinet.drawers)),
          hidden: false,
          folders: [],
        };
    const folder: CabinetFolder = {
      id: newId(),
      name: uniqueName(where.folder, namesOf((drawer ?? newDrawer)?.folders ?? [])),
      hidden: false,
      filter: { source_folder: f.path, notes: 'exclude' },
    };
    const more = bytesOf(folder) + 1 + (newDrawer ? bytesOf(newDrawer) + 1 : 0);
    if (
      nodes + (newDrawer ? 2 : 1) > CABINET_LIMITS.nodes ||
      folderCount + 1 > CABINET_LIMITS.folders_total ||
      (newDrawer
        ? cabinet.drawers.length + 1 > CABINET_LIMITS.drawers
        : (drawer as CabinetDrawer).folders.length + 1 > CABINET_LIMITS.folders) ||
      bytes + more > room
    ) {
      leftOut += 1;
      continue;
    }
    if (newDrawer) {
      cabinet.drawers.push(newDrawer);
      madeDrawers.set(top, newDrawer);
      drawer = newDrawer;
      added.drawers += 1;
      nodes += 1;
    }
    (drawer as CabinetDrawer).folders.push(folder);
    counts[folder.id] = f.documents;
    added.folders += 1;
    nodes += 1;
    folderCount += 1;
    bytes += more;
  }
  if (made && added.folders > 0) {
    out.cabinets.push(made);
    added.cabinets = 1;
  }
  return { layout: out, added, counts, already, left_out: leftOut };
}

/** What adding a folder tree does, in a sentence: "12 folders in 3 drawers, in the cabinet “My folders”." */
export function folderTreeWords(added: CabinetFromFolders['added']): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (added.folders === 0) return 'Your cabinet has a folder for each of them already.';
  const drawers = added.drawers > 0 ? `, ${n(added.drawers, 'new drawer', 'new drawers')}` : '';
  return `${n(added.folders, 'new folder', 'new folders')}${drawers}, in the cabinet “${FOLDERS_CABINET}”${added.cabinets > 0 ? ' (new)' : ''}.`;
}
