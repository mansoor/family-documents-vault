import { randomBytes } from 'node:crypto';
import { withPrincipal, type Db } from '@fdv/db';
import {
  addFolderTree,
  addToDrawing,
  askedFolders,
  cabinetSize,
  compareFolders,
  dividerAsks,
  dividerDims,
  NAME_HOLDS_SEPARATOR,
  PLACE_SEPARATOR,
  dividersProblemOf,
  redrawCabinet,
  RedrawRefused,
  resolvedRanges,
  PIN_IN_TRASH,
  PIN_LIMITS,
  shownDividers,
  TOO_MANY_PINS,
  CABINET_CHANGED,
  CABINET_LIMITS,
  CABINET_TOO_BIG,
  HOUSEHOLD_MEMBER_FILTER,
  layoutProblemOf,
  layoutSize,
  LOCATION_SORT_REFUSAL,
  maySortByLocation,
  NOBODY_MEMBER_FILTER,
  NOT_SURE_YET,
  NOTE_KIND,
  shortName,
  THE_HOUSEHOLD,
  type AlsoIn,
  type CabinetCounts,
  type CabinetFolder,
  type CabinetFromFolders,
  type CabinetGroup,
  type CabinetLayout,
  type CabinetNames,
  type CabinetPreview,
  type CabinetPreviewAsk,
  type CabinetView,
  type DividerAsk,
  type DocumentPage,
  type FolderContents,
  type FolderDivider,
  type PinsMoved,
  type SourceFolder,
} from '@fdv/shared';
import { sql } from 'kysely';
import { parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError, notFound } from '../errors.js';
import { datedSql } from '../documents/filters.js';
import { followLayout, placeRefused } from '../documents/original-place.js';
import { folderQuery, listQueryOf } from '../documents/list-query.js';
import { readDocument, type DocumentService, type ListQuery } from '../documents/service.js';
import {
  documentDividerCounts,
  documentMatches,
  documentPlaces,
  refusedForCabinet,
  type CabinetPlaces,
  type PlacedDocument,
} from '../documents/table.js';

/** The most folders one drawing reads: past what any cabinet can hold (CABINET_LIMITS.folders_total). */
const FROM_FOLDERS_MOST = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A folder shown, with where it is: hidden ones, and those in a hidden drawer or cabinet, are not. */
interface Placed {
  folder: CabinetFolder;
  path: [string, string, string];
}

function shownFolders(layout: CabinetLayout): Placed[] {
  // Only a saved layout is read, and only one the API checked is saved;
  // anything else holds no folders rather than failing.
  if (!Array.isArray(layout?.cabinets)) return [];
  return layout.cabinets
    .filter((c) => !c.hidden)
    .flatMap((c) =>
      c.drawers
        .filter((d) => !d.hidden)
        .flatMap((d) =>
          d.folders
            .filter((f) => !f.hidden)
            .map((folder): Placed => ({ folder, path: [c.name, d.name, folder.name] })),
        ),
    );
}

/** Every folder of a layout, shown or hidden: what a pin may be put in. */
function everyFolder(layout: CabinetLayout): CabinetFolder[] {
  if (!Array.isArray(layout?.cabinets)) return [];
  return layout.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders));
}

/**
 * The dividers a folder is opened with, each counted, from one grouped
 * count of its question (its pins left out): by each of its divider steps —
 * a year, one of its own ranges, a kind, a topic or whose it is — so that
 * every paper of the folder is behind exactly one of them. Which are shown,
 * and which steps are passed over, is `shownDividers`'s, as the fakes work
 * it out too; people and kinds are named as the reader is given them.
 */
async function foldersDividers(
  trx: Db,
  p: Principal,
  folder: CabinetFolder,
  q: ListQuery,
  names: () => Promise<CabinetNames>,
): Promise<FolderDivider[]> {
  const counted = await dividerCounts(trx, p, folder, q);
  return shownDividers(counted.shape, counted.counts, counted.named ? await names() : undefined);
}

/**
 * A folder's grouped count (`foldersDividers`), without naming its
 * dividers yet: whether people or kinds will need names (`named`), and
 * whether kinds do (`kinds`), which are read only then.
 */
async function dividerCounts(trx: Db, p: Principal, folder: CabinetFolder, q: ListQuery) {
  const shape = { filter: folder.filter, dividers: dividersOf(folder) };
  const dims = dividerDims(shape);
  const counts = await documentDividerCounts(trx, p, q, dims, resolvedRanges(shape.dividers));
  return {
    shape,
    counts,
    named: dims.some((d) => d === 'kind' || d === 'person'),
    kinds: dims.includes('kind'),
  };
}

/**
 * A folder's dividers, as they may be asked: a layout is checked as it is
 * saved, but one that would no longer pass (saved by a build before the
 * checks) is divided by year rather than asked what Postgres cannot read.
 */
function dividersOf(folder: CabinetFolder) {
  return folder.dividers && dividersProblemOf(folder.dividers) === null
    ? folder.dividers
    : undefined;
}

/**
 * What one divider of a folder asks beside its question, by its key; null
 * for none of its (`dividerAsks`). Everything else (`rest`) needs the
 * dividers shown, worked out again.
 */
async function dividerOf(
  folder: CabinetFolder,
  key: string,
  shown: () => Promise<FolderDivider[]>,
): Promise<DividerAsk | null> {
  const shape = { filter: folder.filter, dividers: dividersOf(folder) };
  return dividerAsks(shape, key, key === 'rest' ? await shown() : undefined);
}

/**
 * A layout as the vault reads it (0.9.0-dev.90): its levels, or null —
 * arranged by hand, as a layout saved before levels reads — and a folder's
 * dividers left off where they are not as this release keeps them.
 */
export function readLayout(raw: unknown): CabinetLayout {
  const l = raw as Partial<CabinetLayout> | null | undefined;
  const cabinets = Array.isArray(l?.cabinets) ? l.cabinets : [];
  return {
    levels: Array.isArray(l?.levels) ? l.levels : null,
    cabinets: cabinets.map((c) => ({
      ...c,
      drawers: (Array.isArray(c.drawers) ? c.drawers : []).map((d) => ({
        ...d,
        folders: (Array.isArray(d.folders) ? d.folders : []).map((f) => {
          if (f.dividers === undefined || dividersProblemOf(f.dividers) === null) return f;
          const rest = { ...f };
          delete rest.dividers;
          return rest;
        }),
      })),
    })),
  };
}

/** A layout as it is answered: with `arranged_by` null, which older apps read (deprecated). */
function answered(layout: CabinetLayout): CabinetLayout {
  return { levels: layout.levels, arranged_by: null, cabinets: layout.cabinets };
}

/**
 * A saved folder's question, as the list reads it; or null for one it
 * would no longer take (a layout saved by an older release, say): such a
 * folder holds nothing to tell, never more.
 */
function questionOf(f: CabinetFolder): ListQuery | null {
  try {
    return listQueryOf(parse(folderQuery, f.filter));
  } catch {
    return null;
  }
}

/**
 * My cabinet (0.9.0, C1): each person's own layout of cabinets, drawers and
 * folders (`cabinet_layout`, 0097, theirs alone by the database's rules),
 * and what its folders hold — worked out as the Documents table works it
 * out (table.ts: `documentCounts`, `documentMatches`), for whoever asks,
 * every time. A folder's question is the list's own parameters, read by the
 * list's own parser; it only narrows what its person may see already.
 */
export class CabinetService {
  constructor(
    private readonly db: Db,
    private readonly docs: DocumentService,
  ) {}

  /**
   * GET /cabinet: the caller's layout; none until they save one. One drawn
   * by levels is kept up to date first (19 Nov 2026): a paper no folder of
   * its drawn cabinets holds, shown or hidden, by its question or a pin — one of
   * a topic, year or person there was none of when it was drawn — gets the
   * folder the drawing would have given it (`addToDrawing`), up to what a
   * cabinet may hold, saved as a new version made to the one read. A layout
   * arranged by hand is never changed. The papers are only looked over when
   * one the caller sees was added or changed since the layout was saved, and
   * not again while nothing has changed since they last were.
   */
  async get(p: Principal): Promise<CabinetView> {
    const read = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('cabinet_layout')
        .select(['layout', 'version', 'updated_at'])
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      if (!row) return null;
      const layout = readLayout(row.layout);
      const view: CabinetView = {
        layout: answered(layout),
        version: row.version,
        updated_at: row.updated_at.toISOString(),
      };
      if (layout.levels === null) return { view, unheld: [] };
      const stamp = await stampOf(trx, p);
      const key = `${p.householdId}:${p.memberId}`;
      const looked = `${row.version}|${stamp.key}`;
      // Nothing added or changed since it was saved, or since it was last looked over.
      if (
        LOOKED_OVER.get(key) === looked ||
        stamp.last === null ||
        stamp.last.getTime() <= row.updated_at.getTime()
      ) {
        return { view, unheld: [] };
      }
      // Held by a drawn cabinet's folder or pin: one arranged by hand holds
      // nothing for the drawing, which grows a folder of its own beside it.
      const drawn = { ...layout, cabinets: layout.cabinets.filter((c) => c.drawn) };
      const placed = await placesOf(trx, p, drawn, 'every');
      remember(LOOKED_OVER, key, looked);
      return { view, unheld: placed.documents.filter((d) => d.folders === 0) };
    });
    if (!read) return { layout: null, version: 0, updated_at: null };
    const { view, unheld } = read;
    const layout = readLayout(view.layout);
    if (unheld.length === 0) return view;
    // Folders to add: named as the caller is given people and kinds, and
    // saved only over the version read — a change made meanwhile wins.
    const kinds = await this.kindNames(p);
    return withPrincipal(this.db, p, async (trx) => {
      const kept = addToDrawing(layout, groupsOf(unheld), await namesFor(trx, p, kinds), () =>
        randomBytes(6).toString('base64url'),
      );
      if (kept.added === 0) return view;
      const json = JSON.stringify(kept.layout);
      // Checked again as PUT /cabinet checks it: never saved past its limits.
      if (
        layoutProblemOf(kept.layout) !== null ||
        Buffer.byteLength(json) > CABINET_LIMITS.layout_bytes
      ) {
        return view;
      }
      const saved = await trx
        .updateTable('cabinet_layout')
        .set({ layout: json, version: sql<number>`version + 1`, updated_at: sql<Date>`now()` })
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .where('version', '=', view.version)
        .returning(['version', 'updated_at'])
        .executeTakeFirst();
      // Changed meanwhile, somewhere else: that version is what is read next.
      if (!saved) return view;
      return {
        layout: answered(kept.layout),
        version: saved.version,
        updated_at: saved.updated_at.toISOString(),
      };
    });
  }

  /** Each kind's name, as `types()` gives it to the caller. */
  private async kindNames(p: Principal): Promise<Map<string, string>> {
    return new Map((await this.docs.types(p, { all: true })).map((t) => [t.key, t.label] as const));
  }

  /**
   * PUT /cabinet: the whole layout, made to the version the caller last
   * read (0 for none yet) — else `409 conflict`, nothing saved. Its shape
   * and size are checked, and each folder's question by the list's own
   * parser: a folder never asks what the list would refuse its person.
   */
  async save(
    p: Principal,
    layout: CabinetLayout,
    version: number,
    pinsMoved: PinsMoved[] = [],
  ): Promise<CabinetView> {
    // Each name kept as it is checked: trimmed (C3 review). A name of
    // spaces before its words would otherwise pass as its trimmed words,
    // and be kept, and written on documents, as more than the database takes.
    layout = trimmedNames(layout);
    // As it is kept (0.9.0-dev.90): its levels, null for none sent, and
    // nothing of `arranged_by`, which older apps still send.
    layout = { levels: layout.levels ?? null, cabinets: layout.cabinets };
    checkLayout(p, layout);
    const json = JSON.stringify(layout);
    return withPrincipal(this.db, p, async (trx) => {
      // A new name may not hold " › ", which joins a place's names into one
      // line (C3): a name kept from before may, as it was.
      const before = await trx
        .selectFrom('cabinet_layout')
        .select('layout')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      const had = new Map(
        nodesOf(before ? readLayout(before.layout) : undefined).map((n) => [n.id, n.name]),
      );
      const joined = nodesOf(layout).find(
        (n) => n.name.includes(PLACE_SEPARATOR) && had.get(n.id) !== n.name,
      );
      if (joined) {
        throw new ApiError(422, 'validation_failed', `“${joined.name}”: ${NAME_HOLDS_SEPARATOR}`, {
          detail: `node ${joined.id}: name`,
        });
      }
      const write = () =>
        version === 0
          ? trx
              .insertInto('cabinet_layout')
              .values({ household_id: p.householdId, member_id: p.memberId, layout: json })
              .onConflict((oc) => oc.columns(['household_id', 'member_id']).doNothing())
              .returning(['version', 'updated_at'])
              .executeTakeFirst()
          : trx
              .updateTable('cabinet_layout')
              .set({
                layout: json,
                version: sql<number>`version + 1`,
                updated_at: sql<Date>`now()`,
              })
              .where('household_id', '=', p.householdId)
              .where('member_id', '=', p.memberId)
              .where('version', '=', version)
              .returning(['version', 'updated_at'])
              .executeTakeFirst();
      let saved: Awaited<ReturnType<typeof write>>;
      try {
        saved = await write();
      } catch (e) {
        // The database's own floor for a layout's size (0097): never reached
        // past checkLayout's, but a refusal in words if it ever is.
        const pg = e as { code?: string; constraint?: string };
        if (pg.code === '23514' && pg.constraint === 'cabinet_layout_size') {
          throw new ApiError(422, 'cabinet_too_big', CABINET_TOO_BIG, { detail: 'layout' });
        }
        throw e;
      }
      if (!saved) {
        throw new ApiError(409, 'conflict', CABINET_CHANGED, {
          detail: `version ${version} is not the cabinet's`,
        });
      }
      await keepPins(trx, p, layout, pinsMoved);
      // Where originals are, in its folders (C3): their names kept up with
      // it, and let go of the folders it no longer has.
      await followLayout(trx, p, layout).catch(placeRefused);
      return {
        layout: answered(layout),
        version: saved.version,
        updated_at: saved.updated_at.toISOString(),
      };
    });
  }

  /**
   * POST /cabinet/preview: a layout drawn by levels from what the caller
   * can see, over their arrangement (`ask.layout`, else the one saved), not
   * saved (`redrawCabinet`): the default levels, or one cabinet's own.
   * Counted by the database with the rules every list keeps: the caller's
   * own, out of the Trash, notes left out; a person named as the caller is
   * given them, a kind as `types()` gives it. A drawing past what a cabinet
   * may hold is described (`size.over`), never refused: PUT /cabinet refuses it.
   */
  async preview(p: Principal, ask: CabinetPreviewAsk): Promise<CabinetPreview> {
    const kinds = await this.kindNames(p);
    const { groups, names, saved } = await withPrincipal(this.db, p, async (trx) => {
      const rows = (
        await sql<{
          owner_member_id: string | null;
          household_owned: boolean;
          category: string | null;
          type_key: string | null;
          year: number;
          n: number;
        }>`
          select d.owner_member_id, d.household_owned, d.category, d.type_key,
                 extract(year from ${datedSql('d')})::int as year, count(*)::int as n
            from document d
           where ${readDocument(p)} and d.deleted_at is null
             and d.type_key is distinct from ${NOTE_KIND}
           group by 1, 2, 3, 4, 5`.execute(trx)
      ).rows;
      const row = ask.layout
        ? undefined
        : await trx
            .selectFrom('cabinet_layout')
            .select('layout')
            .where('household_id', '=', p.householdId)
            .where('member_id', '=', p.memberId)
            .executeTakeFirst();
      return {
        names: await namesFor(trx, p, kinds),
        saved: row ? readLayout(row.layout) : null,
        groups: rows.map((r): CabinetGroup => ({
          person: personOf(r),
          category: r.category,
          type_key: r.type_key,
          year: r.year,
          n: r.n,
        })),
      };
    });
    const base = ask.layout ? readLayout(ask.layout) : saved;
    let drawn;
    try {
      drawn = redrawCabinet(base, ask, groups, names, () => randomBytes(6).toString('base64url'));
    } catch (e) {
      if (e instanceof RedrawRefused) {
        throw new ApiError(422, 'cabinet_levels', e.message, { detail: 'levels' });
      }
      throw e;
    }
    return { ...drawn, layout: answered(drawn.layout), size: cabinetSize(drawn.layout) };
  }

  /**
   * GET /cabinet/from-folders (0.9.0, C4): the caller's cabinet with a
   * folder for each folder their papers came from — those they filed
   * themselves from a batch's item that had one, still theirs to see, out of
   * the Trash — added beside what is there (`addFolderTree`), not saved.
   * Each folder asks for exactly its folder (`source_folder`), and is
   * counted as `preview` counts: the caller's own rules, notes left out.
   * Only for whoever sees where originals are kept (403 otherwise), as the
   * folder's question is. The caller keeps it with PUT /cabinet, made to
   * `version`: a cabinet changed since is a 409, never overwritten.
   */
  async fromFolders(p: Principal): Promise<CabinetFromFolders> {
    if (!maySortByLocation(p.role)) {
      throw new ApiError(403, 'forbidden', LOCATION_SORT_REFUSAL, { detail: 'source_folder' });
    }
    const { row, rows, asked } = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('cabinet_layout')
        .select(['layout', 'version'])
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      // One folder whatever its case (Postgres' `lower`, as the filter
      // compares it), named as it was first kept; only folders the caller
      // filed something from, counted with every paper from it they see —
      // what the folder will hold. How many there are in all, past the
      // most read, is counted too.
      const rows = (
        await sql<{ path: string; key: string; documents: number; total: number }>`
          select min(d.source_folder) as path, lower(d.source_folder) as key,
                 count(*)::int as documents, (count(*) over ())::int as total
            from document d
           where ${readDocument(p)} and d.deleted_at is null
             and d.source_folder is not null
             and d.type_key is distinct from ${NOTE_KIND}
           group by lower(d.source_folder)
          having bool_or(d.created_by = ${p.accountId}::uuid)
           order by 2
           limit ${FROM_FOLDERS_MOST}`.execute(trx)
      ).rows;
      // What the layout's folders ask, lowered as the filter lowers them.
      const asked = await loweredFolders(trx, row?.layout as CabinetLayout | undefined);
      return { row, rows, asked };
    });
    const folders: SourceFolder[] = rows
      .map((r) => ({ path: r.path, documents: r.documents }))
      .sort((a, b) => compareFolders(a.path, b.path));
    const drawn = addFolderTree(
      row ? readLayout(row.layout) : null,
      rows.map((r) => ({ path: r.path, documents: r.documents, key: r.key })),
      () => randomBytes(6).toString('base64url'),
      { key: (path) => asked.get(path) ?? path.toLowerCase() },
    );
    // Past the most read: never drawn, and said so.
    const unread = Math.max(0, (rows[0]?.total ?? 0) - rows.length);
    return {
      version: row?.version ?? 0,
      folders,
      ...drawn,
      layout: answered(drawn.layout),
      left_out: drawn.left_out + unread,
    };
  }

  /**
   * GET /cabinet/counts: how many documents each shown folder holds for the
   * caller, each exactly the total the Documents table would give them for
   * its question; null for one they may no longer ask.
   */
  async counts(p: Principal): Promise<CabinetCounts> {
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('cabinet_layout')
        .select(['layout', 'version'])
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      // Folders papers came from that this cabinet has none for yet (C4):
      // whether there are any, asked cheaply, for the page to offer them.
      const newFolders = maySortByLocation(p.role)
        ? await hasNewFolders(trx, p, row?.layout as CabinetLayout | undefined)
        : undefined;
      const fresh = newFolders === undefined ? {} : { new_folders: newFolders };
      if (!row) return { version: 0, counts: {}, ...fresh };
      const shown = shownFolders(readLayout(row.layout));
      // Each folder's pins the caller may still open, counted once: its
      // question counts what it holds besides them (C2).
      const pins = await livePins(trx, p);
      const questions = shown.map((s) => {
        const q = questionOf(s.folder);
        const pinned = pins.get(s.folder.id);
        return q && pinned ? { ...q, cabinet: { except: pinned } } : q;
      });
      // One pass (19 Nov 2026): each folder's count, and what the cabinet
      // holds in all — each paper once, the table's own total; those no shown
      // folder holds; those several do.
      const placed = await documentPlaces(
        trx,
        p,
        shown.map((s, i) => ({ q: questions[i] ?? null, pins: pins.get(s.folder.id) ?? [] })),
      );
      const counts: Record<string, number | null> = {};
      shown.forEach((s, i) => {
        counts[s.folder.id] = placed.counts[i] ?? null;
      });
      // Every folder's live pins, hidden ones too: what saving a new
      // arrangement would let go of, said before it is (C2 review).
      const pinsOf: Record<string, number> = {};
      for (const [folder, docs] of pins) pinsOf[folder] = docs.length;
      return {
        version: row.version,
        counts,
        pins: pinsOf,
        ...fresh,
        documents: placed.documents.length,
        unfiled: placed.documents.filter((d) => d.folders === 0).length,
        in_several: placed.documents.filter((d) => d.folders > 1).length,
      };
    });
  }

  /**
   * GET /cabinet/unfiled (19 Nov 2026): the papers no shown folder of the
   * caller's holds — by its question or a pin — newest first, a page at a
   * time, as the table lists them: `total` is GET /cabinet/counts's
   * `unfiled`. With no cabinet saved, every paper the table lists. Worked
   * out once and paged through: again only once the layout, a paper the
   * caller sees or one of their pins has changed.
   */
  async unfiled(
    p: Principal,
    q: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<DocumentPage> {
    const ids = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('cabinet_layout')
        .select(['layout', 'version'])
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      const key = `${p.householdId}:${p.memberId}`;
      const stamp = `${row?.version ?? 0}|${(await stampOf(trx, p)).key}`;
      const had = UNFILED.get(key);
      if (had?.stamp === stamp) return had.ids;
      const layout: CabinetLayout = row ? readLayout(row.layout) : { levels: null, cabinets: [] };
      const ids = (await placesOf(trx, p, layout, 'shown')).documents
        .filter((d) => d.folders === 0)
        .map((d) => d.id);
      remember(UNFILED, key, { stamp, ids });
      return ids;
    });
    return this.docs.table(p, {
      cabinet: { only: ids },
      sort: 'dated',
      direction: 'desc',
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
  }

  /**
   * GET /documents/{id}/also-in: the caller's shown folders that document
   * `id` is in, by the same rules — a document they may not see is not
   * there (404), and one in the Trash is in none.
   */
  async alsoIn(p: Principal, id: string): Promise<AlsoIn> {
    if (!UUID.test(id)) throw notFound('That document');
    return withPrincipal(this.db, p, async (trx) => {
      const seen = (
        await sql<{ id: string }>`
          select d.id from document d where d.id = ${id}::uuid and ${readDocument(p)}`.execute(trx)
      ).rows[0];
      if (!seen) throw notFound('That document');
      const row = await trx
        .selectFrom('cabinet_layout')
        .select('layout')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      if (!row) return { items: [] };
      const shown = shownFolders(readLayout(row.layout));
      const asked = shown.flatMap((s) => {
        const q = questionOf(s.folder);
        return q ? [{ q, s }] : [];
      });
      const matches = await documentMatches(
        trx,
        p,
        id,
        asked.map((a) => a.q),
      );
      const matched = new Set(asked.filter((_, n) => matches[n]).map(({ s }) => s.folder.id));
      // Pinned there too (C2): only while it may be opened, out of the Trash.
      const pinnedIn = new Set((await livePins(trx, p, { document: id })).keys());
      return {
        items: shown
          .filter((s) => matched.has(s.folder.id) || pinnedIn.has(s.folder.id))
          .map((s) => ({
            id: s.folder.id,
            name: s.folder.name,
            path: s.path,
            ...(pinnedIn.has(s.folder.id) ? { pinned: true } : {}),
          })),
      };
    });
  }

  /**
   * GET /cabinet/folders/{id} (C2): one of the caller's shown folders,
   * opened — its pinned papers they may still open, then its dividers
   * newest first, each counted by the table's own conditions, the pinned
   * left out of them; `total` exactly GET /cabinet/counts's for it.
   */
  async folder(p: Principal, folderId: string): Promise<FolderContents> {
    const read = await withPrincipal(this.db, p, async (trx) => {
      const { folder, version } = await shownFolder(trx, p, folderId);
      const pinned = (await livePins(trx, p, { folder: folderId })).get(folderId) ?? [];
      const q = questionOf(folder);
      if (!q || refusedForCabinet(p, q)) return { version, pinned, counted: null, people: null };
      // One grouped count: a year a status leaves nothing behind is no
      // divider; a range of the folder's own is one, empty or not; Other
      // years, only with something; a level of one, passed over.
      const counted = await dividerCounts(trx, p, folder, { ...q, cabinet: { except: pinned } });
      // People as the reader is given them; kinds, if any, read after.
      const people = counted.named ? await namesFor(trx, p, new Map()) : null;
      return { version, pinned, counted, people };
    });
    // Kinds named as `types()` gives them, only for a folder divided by kind.
    const kinds = read.counted?.kinds ? await this.kindNames(p) : null;
    const names =
      read.people && kinds
        ? { ...read.people, kind: (key: string) => kinds.get(key) ?? 'Another kind' }
        : (read.people ?? undefined);
    const found = {
      version: read.version,
      pinned: read.pinned,
      dividers: read.counted ? shownDividers(read.counted.shape, read.counted.counts, names) : null,
    };
    const pinned =
      found.pinned.length === 0
        ? []
        : (
            await this.docs.table(p, {
              cabinet: { only: found.pinned },
              sort: 'dated',
              direction: 'desc',
              limit: PIN_LIMITS.folder,
            })
          ).items;
    return {
      folder_id: folderId,
      version: found.version,
      total:
        found.dividers === null
          ? null
          : pinned.length + found.dividers.reduce((n, d) => n + d.count, 0),
      pinned,
      dividers: found.dividers ?? [],
    };
  }

  /**
   * GET /cabinet/folders/{id}/documents (C2): the papers behind one of a
   * folder's dividers, newest first, a page at a time — the table's own
   * listing of the folder's question, its pinned papers left out (they are
   * shown above the dividers). A divider it does not have is 404.
   */
  async folderDocuments(
    p: Principal,
    folderId: string,
    q: { divider: string; cursor?: string | undefined; limit?: number | undefined },
  ): Promise<DocumentPage> {
    const kinds = q.divider === 'rest' ? await this.kindNames(p) : new Map<string, string>();
    const asked = await withPrincipal(this.db, p, async (trx) => {
      const { folder } = await shownFolder(trx, p, folderId);
      const question = questionOf(folder);
      if (!question || refusedForCabinet(p, question)) throw notFound('That divider');
      const pinned = (await livePins(trx, p, { folder: folderId })).get(folderId) ?? [];
      const rest = { ...question, cabinet: { except: pinned } };
      const more = await dividerOf(folder, q.divider, () =>
        foldersDividers(trx, p, folder, rest, () => namesFor(trx, p, kinds)),
      );
      if (more === null) throw notFound('That divider');
      return { ...question, cabinet: { except: pinned, divider: more } };
    });
    return this.docs.table(p, {
      ...asked,
      sort: 'dated',
      direction: 'desc',
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
  }

  /**
   * POST /cabinet/folders/{id}/pins (C2): papers pinned into one of the
   * caller's folders — their own arrangement, never a change to a paper.
   * Each must be one they may open (else nothing is pinned: 404), out of
   * the Trash (422). Pinning one pinned already is nothing new. A folder
   * holds at most 200, a person 2,000; pins of papers they may no longer
   * open are let go first, before a cap refuses.
   */
  async pin(p: Principal, folderId: string, documentIds: string[]): Promise<{ pinned: number }> {
    const ids = [...new Set(documentIds.map((i) => i.toLowerCase()))];
    if (ids.length === 0 || ids.some((i) => !UUID.test(i))) throw notFound('That document');
    return withPrincipal(this.db, p, async (trx) => {
      // Their layout's row, held: one person's pins and saves go one at a time.
      const row = await trx
        .selectFrom('cabinet_layout')
        .select('layout')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .forUpdate()
        .executeTakeFirst();
      // A shown folder of theirs: a hidden one is not offered, and not taken (C2 review).
      if (!row || !shownFolders(readLayout(row.layout)).some((s) => s.folder.id === folderId)) {
        throw notFound('That folder');
      }
      const seen = (
        await sql<{ id: string; in_trash: boolean }>`
          select d.id, d.deleted_at is not null as in_trash
            from document d
           where d.id = any(${ids}::uuid[]) and ${readDocument(p)}`.execute(trx)
      ).rows;
      if (seen.length !== ids.length) throw notFound('That document');
      if (seen.some((d) => d.in_trash)) {
        throw new ApiError(422, 'cabinet_pin_in_trash', PIN_IN_TRASH);
      }
      await sql`
        insert into cabinet_pin (household_id, member_id, folder_id, document_id)
        select ${p.householdId}::uuid, ${p.memberId}::uuid, ${folderId}, x
          from unnest(${ids}::uuid[]) as x
        on conflict do nothing`.execute(trx);
      const over = async () => {
        const n = (
          await sql<{ here: number; every: number }>`
            select (count(*) filter (where folder_id = ${folderId}))::int as here,
                   count(*)::int as every
              from cabinet_pin
             where household_id = ${p.householdId}::uuid
               and member_id = ${p.memberId}::uuid`.execute(trx)
        ).rows[0];
        return (n?.here ?? 0) > PIN_LIMITS.folder || (n?.every ?? 0) > PIN_LIMITS.total;
      };
      if (await over()) {
        // Room first, from pins of papers they may no longer open: never shown.
        await sql`
          delete from cabinet_pin cp
           where cp.household_id = ${p.householdId}::uuid
             and cp.member_id = ${p.memberId}::uuid
             and not exists (
               select 1 from document d where d.id = cp.document_id and ${readDocument(p)})`.execute(
          trx,
        );
        if (await over()) {
          throw new ApiError(422, 'cabinet_too_many_pins', TOO_MANY_PINS, {
            detail: `at most ${PIN_LIMITS.folder} a folder, ${PIN_LIMITS.total} in all`,
          });
        }
      }
      return { pinned: ids.length };
    });
  }

  /**
   * DELETE /cabinet/folders/{id}/pins/{documentId} (C2): unpinned — the
   * caller's own row taken away, whatever the paper: `204` for any id, so
   * somebody who may no longer open a paper can still let its pin go, and
   * the answer says nothing of whether there was one, or such a paper.
   */
  async unpin(p: Principal, folderId: string, documentId: string): Promise<void> {
    if (!UUID.test(documentId)) return;
    await withPrincipal(this.db, p, async (trx) => {
      await trx
        .deleteFrom('cabinet_pin')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .where('folder_id', '=', folderId)
        .where('document_id', '=', documentId)
        .execute();
    });
  }
}

/** One of the caller's shown folders, and their layout's version; else 404. */
async function shownFolder(
  trx: Db,
  p: Principal,
  folderId: string,
): Promise<{ folder: CabinetFolder; version: number }> {
  const row = await trx
    .selectFrom('cabinet_layout')
    .select(['layout', 'version'])
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .executeTakeFirst();
  const placed = row
    ? shownFolders(readLayout(row.layout)).find((s) => s.folder.id === folderId)
    : undefined;
  if (!row || !placed) throw notFound('That folder');
  return { folder: placed.folder, version: row.version };
}

/**
 * The caller's pins, by folder, of papers they may still open, out of the
 * Trash, oldest pin first — read only joined to the document under the
 * reader's own rules, so a pin never says more than they may see. One
 * folder's, or one paper's, when asked.
 */
async function livePins(
  trx: Db,
  p: Principal,
  only: { folder?: string; document?: string } = {},
): Promise<Map<string, string[]>> {
  const rows = (
    await sql<{ folder_id: string; document_id: string }>`
      select cp.folder_id, cp.document_id
        from cabinet_pin cp
        join document d on d.id = cp.document_id
       where cp.household_id = ${p.householdId}::uuid
         and cp.member_id = ${p.memberId}::uuid
         ${only.folder !== undefined ? sql`and cp.folder_id = ${only.folder}` : sql``}
         ${only.document !== undefined ? sql`and cp.document_id = ${only.document}::uuid` : sql``}
         and ${readDocument(p)} and d.deleted_at is null
       order by cp.pinned_at, cp.document_id`.execute(trx)
  ).rows;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.folder_id, [...(out.get(r.folder_id) ?? []), r.document_id]);
  return out;
}

/**
 * A layout saved (C2): the pins of folders merged into others moved with
 * them, then those of folders it no longer has let go. Only a folder the
 * layout no longer has moves: a move from one it keeps would copy its pins.
 * A folder over its cap of pins, or a person over theirs, is refused,
 * nothing saved — counting only the pins they may still open, out of the
 * Trash, so a refusal never says a pin they cannot see is there.
 */
async function keepPins(
  trx: Db,
  p: Principal,
  layout: CabinetLayout,
  moved: PinsMoved[],
): Promise<void> {
  const ids = everyFolder(layout).map((f) => f.id);
  // In the order they were made: B into A, then A into Z, takes B's to Z too.
  const target = new Map<string, string>();
  for (const m of moved.filter((x) => !ids.includes(x.from))) {
    for (const [from, to] of target) if (to === m.from) target.set(from, m.to);
    if (!target.has(m.from)) target.set(m.from, m.to);
  }
  const moves = [...target]
    .map(([from, to]) => ({ from, to }))
    .filter((m) => m.from !== m.to && ids.includes(m.to));
  if (moves.length > 0) {
    await sql`
      insert into cabinet_pin (household_id, member_id, folder_id, document_id, pinned_at)
      select cp.household_id, cp.member_id, m.to_id, cp.document_id, cp.pinned_at
        from cabinet_pin cp
        join unnest(${moves.map((m) => m.from)}::text[], ${moves.map((m) => m.to)}::text[])
               as m(from_id, to_id) on m.from_id = cp.folder_id
       where cp.household_id = ${p.householdId}::uuid and cp.member_id = ${p.memberId}::uuid
      on conflict do nothing`.execute(trx);
  }
  await sql`
    delete from cabinet_pin
     where household_id = ${p.householdId}::uuid and member_id = ${p.memberId}::uuid
       and not (folder_id = any(${ids}::text[]))`.execute(trx);
  const live = await livePins(trx, p);
  const every = [...live.values()].reduce((n, docs) => n + docs.length, 0);
  const fullest = Math.max(0, ...[...live.values()].map((docs) => docs.length));
  if (fullest > PIN_LIMITS.folder || every > PIN_LIMITS.total) {
    throw new ApiError(422, 'cabinet_too_many_pins', TOO_MANY_PINS, { detail: 'merged folders' });
  }
}

/**
 * A layout as it may be saved: within its sizes, every node named and with
 * an id of its own, and every folder's question the list's own — read by
 * its parser, small, and nothing the list would refuse this person (where
 * originals are kept, to whoever may not see one). Each refusal names the
 * folder.
 */
function checkLayout(p: Principal, layout: CabinetLayout): void {
  // By its bytes, as Postgres keeps it: a name in Chinese is three a character.
  if (Buffer.byteLength(JSON.stringify(layout)) > CABINET_LIMITS.layout_bytes) {
    throw new ApiError(422, 'cabinet_too_big', CABINET_TOO_BIG, { detail: 'layout' });
  }
  const problem = layoutProblemOf(layout);
  if (problem !== null) {
    throw new ApiError(422, problem.code, problem.message, {
      detail: JSON.stringify(layoutSize(layout)),
    });
  }
  for (const c of layout.cabinets) {
    for (const d of c.drawers) {
      for (const f of d.folders) {
        const refuse = (message: string, detail: string): never => {
          throw new ApiError(422, 'validation_failed', `The folder “${f.name}”: ${message}`, {
            detail: `folder ${f.id}: ${detail}`,
          });
        };
        if (Buffer.byteLength(JSON.stringify(f.filter)) > CABINET_LIMITS.filter_bytes) {
          refuse('it asks for too much at once.', 'filter too big');
        }
        let q: ListQuery;
        try {
          q = listQueryOf(parse(folderQuery, f.filter));
        } catch (e) {
          if (e instanceof ApiError) refuse(e.message, e.options.detail ?? e.code);
          throw e;
        }
        if (q.location !== undefined && !maySortByLocation(p.role)) {
          refuse(LOCATION_SORT_REFUSAL, 'location');
        }
        if (q.original_place !== undefined && !maySortByLocation(p.role)) {
          refuse(LOCATION_SORT_REFUSAL, 'original_place');
        }
        if (q.source_folder !== undefined && !maySortByLocation(p.role)) {
          refuse(LOCATION_SORT_REFUSAL, 'source_folder');
        }
      }
    }
  }
}

/** A layout with every cabinet's, drawer's and folder's name trimmed, as it is kept (C3 review). */
function trimmedNames(layout: CabinetLayout): CabinetLayout {
  if (!Array.isArray(layout?.cabinets)) return layout;
  const trim = <T>(name: T): T => (typeof name === 'string' ? (name.trim() as T) : name);
  return {
    ...layout,
    cabinets: layout.cabinets.map((c) => ({
      ...c,
      name: trim(c.name),
      drawers: Array.isArray(c.drawers)
        ? c.drawers.map((d) => ({
            ...d,
            name: trim(d.name),
            folders: Array.isArray(d.folders)
              ? d.folders.map((f) => ({ ...f, name: trim(f.name) }))
              : d.folders,
          }))
        : c.drawers,
    })),
  };
}

/**
 * Each folder a layout's folders ask for (`source_folder`, C4), lowered by
 * Postgres as the list's filter lowers it: "already there" is then what the
 * filter would match, whatever the case.
 */
async function loweredFolders(
  trx: Db,
  layout: CabinetLayout | null | undefined,
): Promise<Map<string, string>> {
  const asked = [...new Set(askedFolders(Array.isArray(layout?.cabinets) ? layout : null))];
  if (asked.length === 0) return new Map();
  const rows = (
    await sql<{ path: string; key: string }>`
      select x as path, lower(x) as key from unnest(${asked}::text[]) as x`.execute(trx)
  ).rows;
  return new Map(rows.map((r) => [r.path, r.key]));
}

/**
 * Whether the caller filed a paper they still see, out of the Trash, from a
 * folder their layout asks for nowhere (C4): one row at most, never the
 * grouping GET /cabinet/from-folders does.
 */
async function hasNewFolders(
  trx: Db,
  p: Principal,
  layout: CabinetLayout | null | undefined,
): Promise<boolean> {
  const asked = [...new Set(askedFolders(Array.isArray(layout?.cabinets) ? layout : null))];
  const row = (
    await sql<{ any: boolean }>`
      select exists (
        select 1 from document d
         where ${readDocument(p)} and d.deleted_at is null
           and d.source_folder is not null
           and d.created_by = ${p.accountId}::uuid
           and d.type_key is distinct from ${NOTE_KIND}
           and lower(d.source_folder) <> all (
                 select lower(x) from unnest(${asked}::text[]) as x)
      ) as any`.execute(trx)
  ).rows[0];
  return row?.any === true;
}

/** Every cabinet, drawer and folder of a saved layout, by id and name. */
function nodesOf(layout: CabinetLayout | null | undefined): Array<{ id: string; name: string }> {
  if (!Array.isArray(layout?.cabinets)) return [];
  return layout.cabinets.flatMap((c) => [c, ...c.drawers.flatMap((d) => [d, ...d.folders])]);
}

/** Whose a paper is, as a drawing names them: a person, the household's, or Not sure yet. */
function personOf(r: { household_owned: boolean; owner_member_id: string | null }): string {
  return r.household_owned ? HOUSEHOLD_MEMBER_FILTER : (r.owner_member_id ?? NOBODY_MEMBER_FILTER);
}

/** Papers counted into a drawing's groups: by person, topic, kind and year. */
function groupsOf(docs: readonly PlacedDocument[]): CabinetGroup[] {
  const by = new Map<string, CabinetGroup>();
  for (const d of docs) {
    const g: CabinetGroup = {
      person: personOf(d),
      category: d.category,
      type_key: d.type_key,
      year: d.year,
      n: 1,
    };
    const key = JSON.stringify([g.person, g.category, g.type_key, g.year]);
    const had = by.get(key);
    if (had) had.n += 1;
    else by.set(key, g);
  }
  return [...by.values()];
}

/**
 * How a drawing names people and kinds for the caller: people as the
 * database gives them, the caller first, then the family by name, the
 * household's, Not sure yet last; kinds as `types()` gives them.
 */
async function namesFor(trx: Db, p: Principal, kinds: Map<string, string>): Promise<CabinetNames> {
  const people = await trx.selectFrom('member').select(['id', 'display_name']).execute();
  const short = shortName(people);
  const full = new Map(people.map((m) => [m.id, m.display_name] as const));
  const rank = (id: string) =>
    id === p.memberId
      ? 0
      : id === HOUSEHOLD_MEMBER_FILTER
        ? 2
        : id === NOBODY_MEMBER_FILTER
          ? 3
          : 1;
  return {
    person: (id) =>
      id === HOUSEHOLD_MEMBER_FILTER
        ? THE_HOUSEHOLD
        : id === NOBODY_MEMBER_FILTER
          ? NOT_SURE_YET
          : (short.get(id) ?? 'Someone in the family'),
    kind: (key) => kinds.get(key) ?? 'Another kind',
    personOrder: (a, b) =>
      rank(a) - rank(b) ||
      (full.get(a) ?? '').localeCompare(full.get(b) ?? '') ||
      a.localeCompare(b),
  };
}

/**
 * Every paper the table lists the caller, with how many of a layout's
 * folders hold it — its shown ones, or every one, hidden too — by its
 * question (the list's own) or a live pin.
 */
async function placesOf(
  trx: Db,
  p: Principal,
  layout: CabinetLayout,
  which: 'shown' | 'every',
): Promise<CabinetPlaces> {
  const folders =
    which === 'shown' ? shownFolders(layout).map((s) => s.folder) : everyFolder(layout);
  const pins = await livePins(trx, p);
  return documentPlaces(
    trx,
    p,
    folders.map((f) => ({ q: questionOf(f), pins: pins.get(f.id) ?? [] })),
  );
}

/**
 * What has changed for the caller, cheaply (19 Nov 2026): the latest a
 * paper they see was added or changed, how many there are (one gone shows
 * too), and their pins. The same stamp, the same papers in the same folders.
 */
async function stampOf(trx: Db, p: Principal): Promise<{ last: Date | null; key: string }> {
  const r = (
    await sql<{ last: Date | null; n: number; pins: number; pinned: Date | null }>`
      select greatest(max(d.updated_at), max(d.created_at)) as last, count(*)::int as n,
             (select count(*)::int from cabinet_pin cp
               where cp.household_id = ${p.householdId}::uuid
                 and cp.member_id = ${p.memberId}::uuid) as pins,
             (select max(cp.pinned_at) from cabinet_pin cp
               where cp.household_id = ${p.householdId}::uuid
                 and cp.member_id = ${p.memberId}::uuid) as pinned
        from document d
       where ${readDocument(p)} and d.deleted_at is null`.execute(trx)
  ).rows[0];
  const last = r?.last ?? null;
  return {
    last,
    key: [last?.getTime() ?? 0, r?.n ?? 0, r?.pins ?? 0, r?.pinned?.getTime() ?? 0].join(':'),
  };
}

/** The most people each of these remembers: past it, the longest unasked is let go. */
const REMEMBERED = 1000;

/** Each person's drawn cabinet, as it was when last looked over for papers in no folder. */
const LOOKED_OVER = new Map<string, string>();
/** Each person's papers in no folder, as last worked out, and for what. */
const UNFILED = new Map<string, { stamp: string; ids: string[] }>();

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value as string);
}
