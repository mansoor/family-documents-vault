import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
import { householdToday, type Db } from '@fdv/db';
import {
  DIVIDER_YEARS,
  type DividerAtom,
  type DividerDim,
  DOCUMENT_PAGE_MAX,
  HOUSEHOLD_MEMBER_FILTER,
  LOCATION_SORT_REFUSAL,
  maySortByLocation,
  NOBODY_MEMBER_FILTER,
  NOTE_KIND,
  PLACE_SEPARATOR,
  seesLocation,
  STATUS_ORDER,
  statusRank,
  type DocumentPage,
  type DocumentSort,
  type DocumentView,
  type SortDirection,
} from '@fdv/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Principal } from '../auth/service.js';
import { seenCollection } from '../collections/seen.js';
import { ApiError } from '../errors.js';
import {
  asksStatus,
  datedSql,
  filterClauses,
  issuedBySql,
  issuersSql,
  statusAllowed,
  visibilitySql,
} from './filters.js';
import { touchedSince } from './original-place.js';
import {
  kindGiven,
  rowStatus,
  readDocument,
  seenBy,
  tagFilter,
  tagLabelFilter,
  typeLookup,
  type CabinetConditions,
  type DaySpan,
  type DocRow,
  type ListQuery,
} from './service.js';

/**
 * The Documents table (Phase 6, R2): GET /documents sorted by a column.
 *
 * What a reader is given is what every list of documents gives them, and
 * nothing is decided here about who sees what: the household's rules in
 * the database (row-level security: the tenant, the actor, a viewer's
 * restriction) and the list's own rule for Adults only and Only me
 * (`readDocument`: `seenDocument`, and a caregiver's grant, H1b) narrow
 * the rows; a collection is one the collections themselves would show the
 * reader (`seenCollection`); a kind is named as
 * `types()` would name it to them (`kindGiven`); a person is one the
 * database gives them. A sort or a filter only orders and narrows that.
 *
 * Each sort is one expression over the row (`keyOf`), blanks last in both
 * directions, and then the document's id, so that two rows never tie and
 * a page's cursor — the last row's key and id — says exactly where the
 * next one starts, whatever was added or changed meanwhile. The database
 * sorts it, reading only each row's id and key, and counts it in the same
 * pass; then the page's own rows are read by id. A cursor is the vault's
 * own: signed for the one who was given it (`writeCursor`), and refused
 * (422) if anything in it is changed.
 *
 * The status is the one thing the database does not hold: it is worked
 * out from the document's kind, its dates and what it is missing, as of
 * today (`rowStatus`, the very function its view uses). A sort by status,
 * or a filter on it, reads what the status is made from of every row the
 * other filters give — never a note's words nor what is sealed, only
 * whether there is any — works each one's status out, and pages that, so
 * a page is full and `total` counts what the filter gives.
 *
 * Where the original is kept is the household's (5.41): somebody who may
 * not see it may neither sort nor filter by it (422), and nothing else
 * here orders by it — a status worked out for them never needs it.
 */
export async function documentTable(
  trx: Db,
  p: Principal,
  q: ListQuery & { sort: DocumentSort },
  listed: (rows: DocRow[]) => Promise<DocumentView[]>,
  cursorKey: Uint8Array,
): Promise<DocumentPage> {
  // And its place in a cabinet (0.9.0, C3): the same household's fact.
  if (asksWhereKept(q) && !maySortByLocation(p.role)) {
    throw new ApiError(422, 'validation_failed', LOCATION_SORT_REFUSAL, {
      detail:
        q.sort === 'location' || q.sort === 'original_place'
          ? 'sort'
          : q.location !== undefined
            ? 'location'
            : q.original_place !== undefined
              ? 'original_place'
              : 'source_folder',
    });
  }
  if (q.status !== undefined && !(STATUS_ORDER as readonly string[]).includes(q.status)) {
    throw new ApiError(422, 'validation_failed', 'That is not a status a document can have.', {
      detail: 'status',
    });
  }
  const dir: SortDirection = q.direction ?? 'asc';
  const limit = Math.min(Math.max(q.limit ?? 50, 1), DOCUMENT_PAGE_MAX);
  const cursor = q.cursor ? readCursor(cursorKey, p, q.cursor, q.sort, dir) : null;
  const where = whereOf(p, q);
  // The status, or statuses, asked for (V1): any of them.
  const allowed = statusAllowed(q, q.status);

  let ids: string[];
  let more: boolean;
  let total: number;
  let next: Omit<Cursor, 's' | 'd'> | null = null;

  if (q.sort === 'status') {
    // What every row the filters give has of a status, worked out, sorted here.
    const rows = (
      await sql<StatusRow>`select ${STATUS_COLUMNS} from document d where ${where}`.execute(trx)
    ).rows;
    const ranked = await withStatus(trx, rows, seesLocation(p.role));
    const shown = ranked.filter((r) => allowed(r.status));
    const sign = dir === 'desc' ? -1 : 1;
    shown.sort((a, b) => compareStatus(a, b, sign));
    const after = cursor
      ? shown.filter((r) => compareStatus(r, statusCursor(cursor), sign) > 0)
      : shown;
    total = shown.length;
    more = after.length > limit;
    ids = after.slice(0, limit).map((r) => r.row.id);
    const last = after[limit - 1];
    if (more && last) {
      next = {
        k: `${last.rank}:${last.row.expires_on ? isoDay(last.row.expires_on) : ''}`,
        id: last.row.id,
      };
    }
  } else {
    const key = keyOf(p, q.sort);
    const DIR = sql.raw(dir === 'desc' ? 'desc' : 'asc');
    const order = sql`order by (b.sort_k is null), b.sort_k ${DIR}, b.id ${DIR}`;
    const keyset = cursor ? afterCursor(cursor, key.type, dir) : sql<boolean>`true`;
    type Keyed = { id: string; cursor_k: string | null };
    let keyed: Keyed[];
    if (asksStatus(q, q.status)) {
      // A status filter: what a status is made from, of every row in the
      // database's order, each marked whether it comes after the cursor;
      // then those of that status.
      const rows = (
        await sql<StatusRow & Keyed & { is_after: boolean }>`
          select b.*, b.sort_k::text as cursor_k, ${keyset} as is_after
            from (select ${STATUS_COLUMNS}, ${key.expr} as sort_k
                    from document d ${key.join}
                   where ${where}
                  offset 0) b
           ${order}`.execute(trx)
      ).rows;
      const ranked = await withStatus(trx, rows, seesLocation(p.role));
      const shown = ranked.filter((r) => allowed(r.status));
      total = shown.length;
      const after = shown.filter((r) => r.row.is_after).map((r) => r.row);
      more = after.length > limit;
      keyed = after.slice(0, limit);
    } else {
      // The ids and keys alone, counted as they are read: one pass.
      const rows = (
        await sql<Keyed & { total_n: number }>`
          select b.id, b.sort_k::text as cursor_k, b.total_n
            from (select d.id, ${key.expr} as sort_k, (count(*) over ())::int as total_n
                    from document d ${key.join}
                   where ${where}
                  offset 0) b
           where ${keyset}
           ${order}
           limit ${limit + 1}`.execute(trx)
      ).rows;
      // Past the last page there is nothing to count from: counted again.
      total =
        rows[0]?.total_n ??
        (
          await sql<{ n: number }>`
            select count(*)::int as n from document d where ${where}`.execute(trx)
        ).rows[0]?.n ??
        0;
      more = rows.length > limit;
      keyed = rows.slice(0, limit);
    }
    ids = keyed.map((r) => r.id);
    const last = keyed[keyed.length - 1];
    if (more && last) next = { k: last.cursor_k, id: last.id };
  }

  const page = await rowsOf(trx, p, ids);
  const items = await listed(page);
  const collections = await collectionsOf(trx, p, page);
  return {
    items: items.map((d) => ({ ...d, collections: collections.get(d.id) ?? [] })),
    next_cursor: next ? writeCursor(cursorKey, p, { s: q.sort, d: dir, ...next }) : null,
    has_more: more,
    total,
  };
}

/**
 * Whether the table would answer `q` for this reader, or refuse it (422):
 * by where originals are kept, to whoever may not see one, or by a status
 * there is none of. A folder that asks what its person may no longer ask is
 * counted as nothing to say (0.9.0, C1), never as somebody else's answer.
 */
function tableRefuses(p: Principal, q: ListQuery): boolean {
  if (asksWhereKept(q) && !maySortByLocation(p.role)) return true;
  return q.status !== undefined && !(STATUS_ORDER as readonly string[]).includes(q.status);
}

/**
 * Whether `q` sorts or filters by where originals are kept: the words
 * (`location`, 5.41), the place in a cabinet (`original_place`, C3) or the
 * folder a paper came from (`source_folder`, C4).
 */
function asksWhereKept(q: ListQuery): boolean {
  return (
    q.sort === 'location' ||
    q.sort === 'original_place' ||
    q.location !== undefined ||
    q.original_place !== undefined ||
    q.source_folder !== undefined
  );
}

/** A document's place in a cabinet as one line, "Study › Drawer 2 › Tax 2025"; null for none. */
export function placeLine(alias: string): RawBuilder<string | null> {
  return sql<
    string | null
  >`array_to_string(${sql.ref(`${alias}.original_place`)}, ${PLACE_SEPARATOR})`;
}

/**
 * In this place, whatever the case (0.9.0, C3): the whole path; or the
 * leading part of one — a cabinet, or a cabinet and its drawer — and
 * everything filed inside it. Compared as words, never as a pattern.
 */
export function placeFilter(asked: string, alias = 'd'): RawBuilder<boolean> {
  // Lowered by the database, as the line is, and measured in its characters.
  const want = sql`lower(${asked.trim()}::text)`;
  const line = sql`lower(${placeLine(alias)})`;
  return sql<boolean>`(${line} = ${want}
    or left(${line}, char_length(${want}) + ${PLACE_SEPARATOR.length}::int) = ${want} || ${PLACE_SEPARATOR}::text)`;
}

/** How many folders' counts one statement works out at once. */
const COUNTS_AT_ONCE = 100;

/**
 * How many documents each of `queries` gives this reader (0.9.0, C1: a
 * cabinet's folders): exactly the `total` the table would give each — the
 * same conditions (`whereOf`: the reader's rules, out of the Trash, each
 * filter), the same worked-out status — or null for one the table would
 * refuse them. Those that ask no status are counted together, a statement
 * for each hundred; one that does reads what a status is made from, as the
 * table does.
 */
export async function documentCounts(
  trx: Db,
  p: Principal,
  queries: readonly ListQuery[],
): Promise<Array<number | null>> {
  const out: Array<number | null> = queries.map(() => null);
  const plain: number[] = [];
  const byStatus: number[] = [];
  for (const [i, q] of queries.entries()) {
    if (tableRefuses(p, q)) continue;
    (asksStatus(q, q.status) ? byStatus : plain).push(i);
  }
  if (byStatus.length > 0) {
    // Those that ask a status, all in one reading: what a status is made
    // from, of every document the reader may see out of the Trash, once,
    // with whether each folder's other conditions hold — a column a folder,
    // a statement for each hundred — then each row's status worked out once
    // and counted against each folder's.
    type Row = StatusRow & Record<string, unknown>;
    const rows = new Map<string, Row>();
    for (let at = 0; at < byStatus.length; at += COUNTS_AT_ONCE) {
      const some = byStatus.slice(at, at + COUNTS_AT_ONCE);
      const columns = some.map(
        (i, n) =>
          sql`coalesce(${whereOf(p, queries[i] as ListQuery)}, false) as ${sql.ref(`m${at + n}`)}`,
      );
      const read = (
        await sql<Row>`
          select ${at === 0 ? STATUS_COLUMNS : sql`d.id`}, ${sql.join(columns, sql`, `)}
            from document d
           where ${readDocument(p)} and d.deleted_at is null`.execute(trx)
      ).rows;
      for (const r of read) rows.set(r.id, { ...(rows.get(r.id) ?? {}), ...r });
    }
    const ranked = await withStatus(trx, [...rows.values()], seesLocation(p.role));
    byStatus.forEach((i, n) => {
      const q = queries[i] as ListQuery;
      const allowed = statusAllowed(q, q.status);
      out[i] = ranked.filter((r) => r.row[`m${n}`] === true && allowed(r.status)).length;
    });
  }
  for (let at = 0; at < plain.length; at += COUNTS_AT_ONCE) {
    const some = plain.slice(at, at + COUNTS_AT_ONCE);
    const columns = some.map(
      (i, n) =>
        sql`(count(*) filter (where ${whereOf(p, queries[i] as ListQuery)}))::int as ${sql.ref(`c${n}`)}`,
    );
    // Only what the reader may see, out of the Trash, is read at all.
    const row = (
      await sql<Record<string, number>>`
        select ${sql.join(columns, sql`, `)}
          from document d
         where ${readDocument(p)} and d.deleted_at is null`.execute(trx)
    ).rows[0];
    some.forEach((i, n) => {
      out[i] = row?.[`c${n}`] ?? 0;
    });
  }
  return out;
}

/**
 * Which of `queries` would list document `id` for this reader (0.9.0, C1:
 * "Also in"), by the table's own conditions: none for a document in the
 * Trash, and none the table would refuse them. Whether they may see it at
 * all is the caller's to have asked first.
 */
export async function documentMatches(
  trx: Db,
  p: Principal,
  id: string,
  queries: readonly ListQuery[],
): Promise<boolean[]> {
  const out = queries.map(() => false);
  const asked = queries.map((q, i) => ({ q, i })).filter(({ q }) => !tableRefuses(p, q));
  for (let at = 0; at < asked.length; at += COUNTS_AT_ONCE) {
    const some = asked.slice(at, at + COUNTS_AT_ONCE);
    const columns = some.map(
      ({ q }, n) => sql`coalesce(${whereOf(p, q)}, false) as ${sql.ref(`m${n}`)}`,
    );
    const row = (
      await sql<Record<string, boolean>>`
        select ${sql.join(columns, sql`, `)} from document d where d.id = ${id}::uuid`.execute(trx)
    ).rows[0];
    if (!row) return out;
    some.forEach(({ i }, n) => {
      out[i] = row[`m${n}`] === true;
    });
  }
  // A status is worked out, not stored: for those that ask one, this
  // document's, once.
  const byStatus = asked.filter(({ q, i }) => out[i] && asksStatus(q, q.status));
  if (byStatus.length > 0) {
    const rows = (
      await sql<StatusRow>`select ${STATUS_COLUMNS} from document d where d.id = ${id}::uuid`.execute(
        trx,
      )
    ).rows;
    const [ranked] = await withStatus(trx, rows, seesLocation(p.role));
    for (const { q, i } of byStatus) {
      out[i] = ranked !== undefined && statusAllowed(q, q.status)(ranked.status);
    }
  }
  return out;
}

/** A document the table lists, and how many of a cabinet's folders hold it. */
export interface PlacedDocument {
  id: string;
  owner_member_id: string | null;
  household_owned: boolean;
  category: string | null;
  type_key: string | null;
  /** The year it is about: issued, else added (`datedSql`). */
  year: number;
  /**
   * Who issued it (0.9.0-dev.91): its own issuer key, where it was asked
   * for; null for none given, or where it was not asked.
   */
  issuer: string | null;
  /** How many of the folders hold it, by their question or a pin: each folder once. */
  folders: number;
}

/** What a cabinet's folders hold, worked out in one pass (`documentPlaces`). */
export interface CabinetPlaces {
  /** Every document the table lists, unfiltered, with how many folders hold it. */
  documents: PlacedDocument[];
  /**
   * Each folder's count, as GET /cabinet/counts gives it: what its question
   * lists besides its pins — exactly the table's total for it, notes
   * included if it asks them — and its pins; null for one the table would
   * refuse, or with no question left.
   */
  counts: Array<number | null>;
}

/** What one reading of a paper gives: what it is, and what a status is made from if asked. */
type PlaceRow = Partial<StatusRow> & {
  id: string;
  owner_member_id: string | null;
  household_owned: boolean;
  category: string | null;
  type_key: string | null;
  year: number;
  issuer: string | null;
  is_note: boolean;
} & Record<string, unknown>;

/**
 * What a cabinet's `folders` hold for this reader (19 Nov 2026), worked
 * out in one pass over what they may see, out of the Trash: a reading of
 * every paper for each hundred folders, each folder a column of whether its
 * question lists the paper by the table's own conditions (`whereOf`), each
 * column folded into its folder's count and the paper's folders as it is
 * read. A status is worked out only for the papers a folder that asks one
 * would list. A folder holds a paper its question lists or one pinned into
 * it; one the table would refuse (or with no question left) holds only its
 * pins. The documents are the table's unfiltered list — notes left out: its
 * `total` — each with how many folders hold it: the cabinet's total, those
 * in no folder and those in more than one.
 */
export async function documentPlaces(
  trx: Db,
  p: Principal,
  folders: ReadonlyArray<{ q: ListQuery | null; pins: readonly string[] }>,
  /** Whether each paper's issuer is read too (0.9.0-dev.91): only for a cabinet drawn by it. */
  opts: { issuer?: boolean } = {},
): Promise<CabinetPlaces> {
  const asked = folders.flatMap(({ q }, i) =>
    q && !tableRefuses(p, q)
      ? [{ i, allowed: asksStatus(q, q.status) ? statusAllowed(q, q.status) : null, q }]
      : [],
  );
  const statusAsked = asked.some((a) => a.allowed !== null);
  const pinned = folders.map(({ pins }) => new Set(pins));
  // Each paper's folders, as indexes; each folder's count besides its pins.
  const papers = new Map<string, PlaceRow>();
  const holding = new Map<string, Set<number>>();
  const besidePins = folders.map(() => 0);
  // Papers a folder asking a status would list: [paper, the folder's place in `asked`].
  const byStatus: Array<[string, number]> = [];
  const hold = (id: string, n: number) => {
    const { i } = asked[n] as (typeof asked)[number];
    if (!pinned[i]?.has(id)) besidePins[i] = (besidePins[i] ?? 0) + 1;
    const set = holding.get(id);
    if (set) set.add(i);
    else holding.set(id, new Set([i]));
  };
  for (let at = 0; at === 0 || at < asked.length; at += COUNTS_AT_ONCE) {
    const some = asked.slice(at, at + COUNTS_AT_ONCE);
    const columns = [
      at === 0
        ? sql`${statusAsked ? STATUS_COLUMNS : sql`d.id, d.type_key, d.owner_member_id, d.household_owned`},
              d.category, extract(year from ${datedSql('d')})::int as year,
              ${opts.issuer === true ? sql`d.issuer_key` : sql`null::text`} as issuer,
              d.type_key is not distinct from ${NOTE_KIND} as is_note`
        : sql`d.id`,
      ...some.map(({ q }, n) => sql`coalesce(${whereOf(p, q)}, false) as ${sql.ref(`m${n}`)}`),
    ];
    const read = (
      await sql<PlaceRow>`/* documentPlaces */ select ${sql.join(columns, sql`, `)}
          from document d
         where ${readDocument(p)} and d.deleted_at is null`.execute(trx)
    ).rows;
    for (const r of read) {
      if (at === 0) {
        const { id, owner_member_id, household_owned, category, type_key, year, issuer, is_note } =
          r;
        papers.set(id, {
          ...(statusAsked ? r : {}),
          id,
          owner_member_id,
          household_owned,
          category,
          type_key,
          year,
          issuer,
          is_note,
        });
      }
      some.forEach((a, n) => {
        if (r[`m${n}`] !== true) return;
        if (a.allowed === null) hold(r.id, at + n);
        else byStatus.push([r.id, at + n]);
      });
      if (at === 0 && some.length > 0) {
        // Kept only as what a paper is: each folder's column is folded already.
        const kept = papers.get(r.id) as PlaceRow;
        for (let n = 0; n < some.length; n += 1) delete kept[`m${n}`];
      }
    }
  }
  if (byStatus.length > 0) {
    const ids = [...new Set(byStatus.map(([id]) => id))];
    const ranked = await withStatus(
      trx,
      ids.map((id) => papers.get(id) as StatusRow & PlaceRow),
      seesLocation(p.role),
    );
    const statusOf = new Map(ranked.map((r) => [r.row.id, r.status]));
    for (const [id, n] of byStatus) {
      if ((asked[n] as (typeof asked)[number]).allowed?.(statusOf.get(id) ?? '')) hold(id, n);
    }
  }
  // Pins: each paper pinned once into each folder.
  pinned.forEach((ids, i) => {
    for (const id of ids) {
      if (!papers.has(id)) continue;
      const set = holding.get(id);
      if (set) set.add(i);
      else holding.set(id, new Set([i]));
    }
  });
  const counted = new Set(asked.map((a) => a.i));
  return {
    documents: [...papers.values()]
      .filter((r) => !r.is_note)
      .map((r) => ({
        id: r.id,
        owner_member_id: r.owner_member_id,
        household_owned: r.household_owned,
        category: r.category,
        type_key: r.type_key,
        year: r.year,
        issuer: r.issuer,
        folders: holding.get(r.id)?.size ?? 0,
      })),
    counts: folders.map((f, i) => (counted.has(i) ? (besidePins[i] ?? 0) + f.pins.length : null)),
  };
}

/** The columns of a document a list is made from (`DocRow`): never its search index. */
const COLUMNS = sql.raw(
  [
    'id',
    'type_key',
    'title',
    'owner_member_id',
    'household_owned',
    // Sensitive (0090): its own choice; all said, as the view says.
    'sensitive',
    'category',
    'visibility',
    'issued_on',
    'issued_precision',
    'expires_on',
    'expires_precision',
    'identifier',
    'issued_by',
    'physical_location',
    // Its place in a cabinet (0104, C3): the names, and whose folder it is.
    'original_place',
    'original_place_by',
    'original_place_folder',
    'place_changed_at',
    // The folder it came from (0105, C4).
    'source_folder',
    'is_essential',
    'tags',
    'notes',
    'extra',
    'notes_sealed',
    'extra_sealed',
    'sealed_details',
    'created_by',
    'created_at',
    'updated_at',
    'deleted_at',
    'purge_requested_at',
    'notes_updated_at',
    'notes_updated_by',
    // No longer needed (0082): when, by whom, why, and what replaced it.
    'no_longer_needed_at',
    'no_longer_needed_by',
    'no_longer_needed_reason',
    'no_longer_needed_reason_sealed',
    'replaced_by',
  ]
    .map((c) => `d.${c}`)
    .join(', '),
);

/** A page's rows, in the order of `ids`: read by id once the sort has chosen them. */
async function rowsOf(trx: Db, p: Principal, ids: string[]): Promise<DocRow[]> {
  if (ids.length === 0) return [];
  const rows = (
    await sql<DocRow>`select ${COLUMNS} from document d
                       where d.id = any(${ids}::uuid[]) and ${readDocument(p)}`.execute(trx)
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is DocRow => r !== undefined);
}

/** The documents in collection `l` the caller may see, as `exists` asks it of `d`. */
const inSeenCollection = (p: Principal) =>
  sql`select 1
        from doc_collection_item i
        join doc_collection l on l.id = i.collection_id
       where i.document_id = d.id and ${seenCollection(p)}`;

/** Every filter, as one condition on `d`: each only narrows what the caller may see. */
function whereOf(p: Principal, q: ListQuery): RawBuilder<boolean> {
  const parts: RawBuilder<unknown>[] = [
    readDocument(p),
    q.deleted ? sql`d.deleted_at is not null` : sql`d.deleted_at is null`,
  ];
  // Not sure yet: nobody, and not the household's; or the household's (0.9.0).
  if (q.member_id === NOBODY_MEMBER_FILTER) {
    parts.push(sql`d.owner_member_id is null and not d.household_owned`);
  } else if (q.member_id === HOUSEHOLD_MEMBER_FILTER) parts.push(sql`d.household_owned`);
  else if (q.member_id) parts.push(sql`d.owner_member_id = ${q.member_id}::uuid`);
  if (q.category) parts.push(sql`d.category = ${q.category}`);
  if (q.type_key) parts.push(sql`d.type_key = ${q.type_key}`);
  // Only me is the caller's own, never a paper read through a grant (C2 review).
  if (q.visibility) parts.push(visibilitySql([q.visibility]));
  if (q.essential !== undefined) parts.push(sql`d.is_essential = ${q.essential}`);
  if (q.purge_requested !== undefined) {
    parts.push(
      q.purge_requested ? sql`d.purge_requested_at is not null` : sql`d.purge_requested_at is null`,
    );
  }
  // A tag whatever its case, and a detail tag's label (0.9.0, T1, 0073).
  if (q.tag) parts.push(tagFilter(q.tag, 'd.'));
  if (q.tag_label) parts.push(tagLabelFilter(q.tag_label, 'd.'));
  // As written, or as the household names the same issuer (0.9.0-dev.91).
  if (q.issued_by) parts.push(issuedBySql(q.issued_by, seenBy(p)));
  // Or its place in a cabinet changed since (C3), as the older list asks it.
  if (q.updated_since) parts.push(touchedSince(q.updated_since, 'd'));
  // Any of several, and the days (V1, filters.ts).
  parts.push(...filterClauses(q, 'd', seenBy(p)));
  if (q.location !== undefined) {
    parts.push(sql`lower(btrim(d.physical_location)) = lower(btrim(${q.location}))`);
  }
  // In a place in a cabinet (0.9.0, C3), whatever the case: the whole path,
  // or a cabinet, or a cabinet and its drawer, and everything inside.
  if (q.original_place !== undefined) parts.push(placeFilter(q.original_place));
  // Came from this folder (0.9.0, C4), whatever the case: exactly that
  // folder, never those inside it — each is a folder of its own.
  if (q.source_folder !== undefined) {
    parts.push(sql`lower(d.source_folder) = lower(${q.source_folder.trim()})`);
  }
  // A cabinet folder's pins and dividers (0.9.0, C2): only ever narrower.
  if (q.cabinet) parts.push(...cabinetClauses(q.cabinet, p));
  // A document in the Trash is in no collection until it is brought back,
  // as GET /documents/{id}/collections says of it: in the Trash, every one
  // is in none, and none is in one.
  if (q.collection_id === 'none') {
    if (!q.deleted) parts.push(sql`not exists (${inSeenCollection(p)})`);
  } else if (q.collection_id) {
    parts.push(
      q.deleted
        ? sql`false`
        : sql`exists (${inSeenCollection(p)} and l.id = ${q.collection_id}::uuid)`,
    );
  }
  // In any of several (0.9.0-dev.92), each one the caller may see, or in
  // none of theirs: one condition, the ids an array.
  if (q.collection_ids) {
    const ids = q.collection_ids.filter((c) => c !== 'none');
    const any = [
      ...(q.collection_ids.includes('none')
        ? [q.deleted ? sql`true` : sql`not exists (${inSeenCollection(p)})`]
        : []),
      ...(ids.length > 0
        ? [
            q.deleted
              ? sql`false`
              : sql`exists (${inSeenCollection(p)} and l.id = any(${ids}::uuid[]))`,
          ]
        : []),
    ];
    parts.push(sql`(${sql.join(any, sql` or `)})`);
  }
  return sql<boolean>`${sql.join(parts, sql` and `)}`;
}

/** A divider's days, as one condition on the date `d` is about. */
function spanSql(span: DaySpan): RawBuilder<boolean> {
  const parts: RawBuilder<unknown>[] = [];
  if (span.from !== null) parts.push(sql`${datedSql('d')} >= ${span.from}::date`);
  if (span.to !== null) parts.push(sql`${datedSql('d')} <= ${span.to}::date`);
  return parts.length === 0 ? sql<boolean>`true` : sql<boolean>`(${sql.join(parts, sql` and `)})`;
}

/**
 * One step of a divider (0.9.0-dev.90): a year or range's days, none of
 * them, or a kind, topic or person — read exactly as the grouped count
 * (`documentDividerCounts`) groups it, a value missing as none.
 */
function atomSql(a: DividerAtom, p: Principal): RawBuilder<boolean> {
  if ('within' in a) return spanSql(a.within);
  if ('outside' in a) {
    return a.outside.length === 0
      ? sql<boolean>`true`
      : sql<boolean>`not (${sql.join(a.outside.map(spanSql), sql` or `)})`;
  }
  switch (a.level) {
    case 'kind':
      return a.value === null
        ? sql<boolean>`d.type_key is null`
        : sql<boolean>`d.type_key = ${a.value}`;
    case 'topic':
      return a.value === null
        ? sql<boolean>`d.category is null`
        : sql<boolean>`d.category = ${a.value}`;
    case 'person':
      return a.value === HOUSEHOLD_MEMBER_FILTER
        ? sql<boolean>`d.household_owned`
        : a.value === NOBODY_MEMBER_FILTER
          ? sql<boolean>`(not d.household_owned and d.owner_member_id is null)`
          : sql<boolean>`(not d.household_owned and d.owner_member_id::text = ${a.value})`;
    // Who issued it, as the household names it for the reader (0.9.0-dev.91).
    case 'issuer':
      return a.value === null
        ? sql<boolean>`d.issuer_key is null`
        : issuersSql([a.value], seenBy(p));
  }
}

/** Every step of a divider together. */
function atomsSql(atoms: readonly DividerAtom[], p: Principal): RawBuilder<boolean> {
  return atoms.length === 0
    ? sql<boolean>`true`
    : sql<boolean>`(${sql.join(
        atoms.map((a) => atomSql(a, p)),
        sql` and `,
      )})`;
}

/** A cabinet folder's own conditions (C2), each narrowing what `whereOf` gives. */
function cabinetClauses(c: CabinetConditions, p: Principal): RawBuilder<unknown>[] {
  const parts: RawBuilder<unknown>[] = [];
  if (c.only !== undefined) parts.push(sql`d.id = any(${c.only}::uuid[])`);
  if (c.except !== undefined && c.except.length > 0) {
    parts.push(sql`not (d.id = any(${c.except}::uuid[]))`);
  }
  if (c.divider) {
    parts.push(atomsSql(c.divider.atoms, p));
    for (const leaf of c.divider.none_of ?? []) parts.push(sql`not ${atomsSql(leaf, p)}`);
  }
  return parts;
}

/**
 * One step of a folder's grouped count, as a key's part: what
 * `dividerKeyOf` (@fdv/shared) gives a paper, worked out by Postgres.
 */
function dimSql(dim: DividerDim, spans: readonly DaySpan[]): RawBuilder<string> {
  const year = sql`extract(year from ${datedSql('d')})::int`;
  switch (dim) {
    case 'year':
      return sql<string>`case when ${year} between ${DIVIDER_YEARS.first} and ${DIVIDER_YEARS.last}
                           then 'year:' || ${year}::text else 'other' end`;
    case 'ranges':
      return spans.length === 0
        ? sql<string>`'other'`
        : sql<string>`case ${sql.join(
            spans.map((s, i) => sql`when ${spanSql(s)} then ${`range:${i}`}`),
            sql` `,
          )} else 'other' end`;
    case 'kind':
      return sql<string>`'kind:' || coalesce(d.type_key, '')`;
    case 'topic':
      return sql<string>`'topic:' || coalesce(d.category, '')`;
    case 'person':
      return sql<string>`'person:' || case when d.household_owned then ${HOUSEHOLD_MEMBER_FILTER}
                                        when d.owner_member_id is null then ${NOBODY_MEMBER_FILTER}
                                        else d.owner_member_id::text end`;
    // Who issued it (0.9.0-dev.91), by the paper's own key — `issuer:` for
    // none given — which the cabinet then gathers into the household's
    // groups as the reader knows them.
    case 'issuer':
      return sql<string>`'issuer:' || coalesce(d.issuer_key, '')`;
  }
}

/**
 * How many documents `q` gives this reader behind each of a folder's
 * dividers, in one grouped count: by the key `dividerKeyOf` (@fdv/shared)
 * gives a paper — each of the folder's steps (`dims`: a year, `year:2025`
 * or `other` outside 1000 to 9999; one of its own ranges, `range:N`, N its
 * place among `spans`, or `other`; a kind, a topic or whose it is) joined
 * by `/`; `all` for none. Only keys with something behind them are there.
 * Each count is what the table would count for `q` within that divider —
 * the same conditions (`whereOf`) and, for a question that asks a status,
 * the same worked-out status — so they add up to its total. Nothing for a
 * question the table would refuse.
 */
export async function documentDividerCounts(
  trx: Db,
  p: Principal,
  q: ListQuery,
  dims: readonly DividerDim[],
  spans: readonly DaySpan[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tableRefuses(p, q)) return out;
  const group =
    dims.length === 0
      ? sql<string>`'all'`
      : sql<string>`${sql.join(
          dims.map((d) => dimSql(d, spans)),
          sql` || '/' || `,
        )}`;
  if (asksStatus(q, q.status)) {
    const rows = (
      await sql<StatusRow & { g: string }>`
        select ${STATUS_COLUMNS}, ${group} as g
          from document d
         where ${whereOf(p, q)}`.execute(trx)
    ).rows;
    const allowed = statusAllowed(q, q.status);
    for (const r of await withStatus(trx, rows, seesLocation(p.role))) {
      if (allowed(r.status)) out.set(r.row.g, (out.get(r.row.g) ?? 0) + 1);
    }
    return out;
  }
  const rows = (
    await sql<{ g: string; n: number }>`
      select ${group} as g, count(*)::int as n
        from document d
       where ${whereOf(p, q)}
       group by 1`.execute(trx)
  ).rows;
  for (const r of rows) out.set(r.g, r.n);
  return out;
}

/** Whether the table would refuse `q` for this reader (C1's rule, for the cabinet). */
export function refusedForCabinet(p: Principal, q: ListQuery): boolean {
  return tableRefuses(p, q);
}

/** A sort's key on `d`, its type as a cursor writes it, and what it reads beside the row. */
interface Key {
  expr: RawBuilder<unknown>;
  type: 'text' | 'date' | 'int';
  join: RawBuilder<unknown>;
}

const NO_JOIN = sql``;

function keyOf(p: Principal, sort: Exclude<DocumentSort, 'status'>): Key {
  switch (sort) {
    case 'title':
      return { expr: sql`lower(nullif(btrim(d.title), ''))`, type: 'text', join: NO_JOIN };
    case 'kind':
      // The kind's name, only as types() gives it to this reader (the
      // review's R2-API-1): a kind they are not given sorts as none, and so
      // is never in a cursor. Each read once for the statement.
      return {
        expr: sql`k.label`,
        type: 'text',
        join: sql`left join (select t.key, min(lower(t.label)) as label
                               from document_type t
                              where ${kindGiven(p, sql<boolean>`t.household_id is null`)}
                              group by t.key) k on k.key = d.type_key`,
      };
    case 'person':
      // Whose it is, by the name the household knows them by: a person the
      // database does not give this reader sorts as nobody's.
      return {
        expr: sql`lower(m.display_name)`,
        type: 'text',
        join: sql`left join member m on m.id = d.owner_member_id`,
      };
    case 'issued':
      return { expr: sql`d.issued_on`, type: 'date', join: NO_JOIN };
    case 'expires':
      return { expr: sql`d.expires_on`, type: 'date', join: NO_JOIN };
    case 'dated':
      // The date it is about: issued, else added (0.9.0, C1).
      return { expr: datedSql('d'), type: 'date', join: NO_JOIN };
    case 'visibility':
      // Everyone, then Adults only, then Only me: from the widest.
      return {
        expr: sql`(case d.visibility when 'household' then 0 when 'adults' then 1 else 2 end)`,
        type: 'int',
        join: NO_JOIN,
      };
    case 'collections':
      // The first, by name, of the collections it is in that the reader
      // may see; none in the Trash.
      return {
        expr: sql`c.name`,
        type: 'text',
        join: sql`left join (select i.document_id, min(lower(l.name)) as name
                               from doc_collection_item i
                               join doc_collection l on l.id = i.collection_id
                              where ${seenCollection(p)}
                              group by i.document_id) c
                    on c.document_id = d.id and d.deleted_at is null`,
      };
    case 'location':
      return {
        expr: sql`lower(nullif(btrim(d.physical_location), ''))`,
        type: 'text',
        join: NO_JOIN,
      };
    case 'original_place':
      // By its names as one line (0.9.0, C3): cabinet, then drawer, then folder.
      return { expr: sql`lower(${placeLine('d')})`, type: 'text', join: NO_JOIN };
  }
}

/** Rows after the cursor, in the page's order: blanks last, then by id. */
function afterCursor(c: Cursor, type: Key['type'], dir: SortDirection): RawBuilder<boolean> {
  const beyond = sql.raw(dir === 'desc' ? '<' : '>');
  if (c.k === null) return sql<boolean>`(b.sort_k is null and b.id ${beyond} ${c.id}::uuid)`;
  const pattern = type === 'date' ? DAY : type === 'int' ? WHOLE : null;
  if (pattern && !pattern.test(c.k)) throw badCursor();
  return sql<boolean>`(b.sort_k is null or (b.sort_k, b.id) ${beyond} (${c.k}::${sql.raw(type)}, ${c.id}::uuid))`;
}

// ------------------------------------------------------------- status

/**
 * What a status is worked out from (`rowStatus`): no note's words, sealed
 * or not, and no sealed details — only whether there are any. A note is
 * kept trimmed, and none when blank (the service's write), so being there
 * is having words.
 */
type StatusRow = Pick<
  DocRow,
  | 'id'
  | 'type_key'
  | 'owner_member_id'
  | 'household_owned'
  | 'issued_on'
  | 'issued_precision'
  | 'expires_on'
  | 'expires_precision'
  | 'identifier'
  | 'issued_by'
  | 'physical_location'
  | 'original_place'
  | 'tags'
  | 'extra'
  | 'sealed_details'
  | 'no_longer_needed_at'
> & { has_notes: boolean; has_sealed_notes: boolean };

const STATUS_COLUMNS = sql.raw(
  [
    'id',
    'type_key',
    'owner_member_id',
    'household_owned',
    'issued_on',
    'issued_precision',
    'expires_on',
    'expires_precision',
    'identifier',
    'issued_by',
    'physical_location',
    'original_place',
    'tags',
    'extra',
    'sealed_details',
    'no_longer_needed_at',
  ]
    .map((c) => `d.${c}`)
    .concat(['d.notes is not null as has_notes', 'd.notes_sealed is not null as has_sealed_notes'])
    .join(', '),
);

/** Stands in for words a status needs to know are there, and never reads. */
const THERE = 'there';
const SEALED_THERE = Buffer.alloc(0);

interface Ranked<R> {
  row: R;
  status: string;
  rank: number;
}

/**
 * Each row with its status as its view will say it to this reader, worked
 * out with the household's kinds: for one who may not see where originals
 * are kept, never that a document needs it (`location`, 5.41) — so neither
 * the words, nor the order, nor a filter on it, says it is not written down.
 */
async function withStatus<R extends StatusRow>(
  trx: Db,
  rows: R[],
  location: boolean,
): Promise<Array<Ranked<R>>> {
  // The kinds the rows have, looked up once each; then every row at once.
  const typeOf = typeLookup(trx);
  const today = await householdToday(trx);
  const keys = [...new Set(rows.map((r) => r.type_key).filter((k): k is string => k !== null))];
  const types = new Map(await Promise.all(keys.map(async (k) => [k, await typeOf(k)] as const)));
  return rows.map((row) => {
    const status = rowStatus(
      row.type_key ? types.get(row.type_key) : null,
      {
        ...row,
        notes: row.has_notes ? THERE : null,
        notes_sealed: row.has_sealed_notes ? SEALED_THERE : null,
      },
      location,
      today,
    ).value;
    return { row, status, rank: statusRank(status) };
  });
}

/** By status, most pressing first; then the sooner expiry, none last; then by id. */
function compareStatus(
  a: { rank: number; row: { expires_on: string | null; id: string } },
  b: { rank: number; row: { expires_on: string | null; id: string } },
  sign: number,
): number {
  if (a.rank !== b.rank) return (a.rank - b.rank) * sign;
  const ae = a.row.expires_on ? isoDay(a.row.expires_on) : null;
  const be = b.row.expires_on ? isoDay(b.row.expires_on) : null;
  if (ae !== be) {
    if (ae === null) return 1;
    if (be === null) return -1;
    return (ae < be ? -1 : 1) * sign;
  }
  return a.row.id === b.row.id ? 0 : (a.row.id < b.row.id ? -1 : 1) * sign;
}

/** Where a page sorted by status ended, as `compareStatus` reads a row. */
function statusCursor(c: Cursor): { rank: number; row: { expires_on: string | null; id: string } } {
  const m = /^(\d+):(\d{4}-\d{2}-\d{2})?$/.exec(c.k ?? '');
  if (!m) throw badCursor();
  return { rank: Number(m[1]), row: { expires_on: m[2] ?? null, id: c.id } };
}

const isoDay = (d: string | Date): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

// ------------------------------------------------------------- collections

/**
 * The collections each document of the page is in, of those the reader may
 * see, by name: one statement for the page. None for one in the Trash.
 */
async function collectionsOf(
  trx: Db,
  p: Principal,
  rows: DocRow[],
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const found = new Map<string, Array<{ id: string; name: string }>>();
  const ids = rows.filter((r) => r.deleted_at === null).map((r) => r.id);
  if (ids.length === 0) return found;
  const r = await sql<{ document_id: string; id: string; name: string }>`
    select i.document_id, l.id, l.name
      from doc_collection_item i
      join doc_collection l on l.id = i.collection_id
     where i.document_id = any(${ids}::uuid[]) and ${seenCollection(p)}
     order by lower(l.name), l.created_at, l.id`.execute(trx);
  for (const c of r.rows) {
    const of = found.get(c.document_id) ?? [];
    of.push({ id: c.id, name: c.name });
    found.set(c.document_id, of);
  }
  return found;
}

// ------------------------------------------------------------- the cursor

/**
 * Where a page ended: the sort and direction it was asked with — a cursor
 * is refused with any other — the last row's key, as text, and its id.
 */
interface Cursor {
  s: DocumentSort;
  d: SortDirection;
  k: string | null;
  id: string;
}

/**
 * The key a table's cursors are signed with (the review's R2-API-1): its
 * own purpose of the master key. Nothing signed with it is kept anywhere —
 * a cursor lives in a page and the next request — so rotating the master
 * key moves nothing of it (it is not one of master-rotation's
 * MASTER_SEALED): a cursor handed out before is refused after, and the
 * list is asked again from its first page.
 */
export const CURSOR_KEY_PURPOSE = 'documents-table-cursor';

export function deriveCursorKey(masterSecret: string): Uint8Array {
  return new Uint8Array(deriveKey(masterSecret, CURSOR_KEY_PURPOSE));
}

/** What a cursor's tag covers: the household, the sign-in it was given to, and what it says. */
const tagOf = (key: Uint8Array, p: Principal, body: string) =>
  createHmac('sha256', key)
    .update(`fdv.documents.cursor.1\n${p.householdId}\n${p.accountId}\n${body}`)
    .digest('base64url');

/**
 * A cursor as the vault hands it out: what it says, then its tag, so that
 * nothing in it can be changed, nor a cursor made, and one given to
 * somebody else is nobody's cursor here. Its key is never one the reader
 * may not see: the sort's key is theirs (`keyOf`).
 */
function writeCursor(key: Uint8Array, p: Principal, c: Cursor): string {
  const body = Buffer.from(JSON.stringify(c)).toString('base64url');
  return `${body}.${tagOf(key, p, body)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^\d+$/;

const badCursor = () => new ApiError(422, 'validation_failed', 'That page cursor is not valid.');

function readCursor(
  key: Uint8Array,
  p: Principal,
  s: string,
  sort: DocumentSort,
  dir: SortDirection,
): Cursor {
  const [body, tag, ...rest] = s.split('.');
  if (!body || !tag || rest.length > 0) throw badCursor();
  const want = Buffer.from(tagOf(key, p, body));
  const got = Buffer.from(tag);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw badCursor();
  let c: Partial<Cursor>;
  try {
    c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Cursor>;
  } catch {
    throw badCursor();
  }
  if (
    c === null ||
    typeof c !== 'object' ||
    c.s !== sort ||
    c.d !== dir ||
    typeof c.id !== 'string' ||
    !UUID.test(c.id) ||
    (c.k !== null && typeof c.k !== 'string')
  ) {
    throw badCursor();
  }
  return { s: c.s, d: c.d, k: c.k ?? null, id: c.id.toLowerCase() };
}
