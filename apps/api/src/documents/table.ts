import type { Db } from '@fdv/db';
import {
  DOCUMENT_PAGE_MAX,
  LOCATION_SORT_REFUSAL,
  maySortByLocation,
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
import { rowStatus, seenDocument, typeLookup, type DocRow, type ListQuery } from './service.js';

/**
 * The Documents table (Phase 6, R2): GET /documents sorted by a column.
 *
 * What a reader is given is what every list of documents gives them, and
 * nothing is decided here about who sees what: the household's rules in
 * the database (row-level security: the tenant, the actor, a viewer's
 * restriction) and the list's own rule for Adults only and Only me
 * (`seenDocument`) narrow the rows; a collection is one the collections
 * themselves would show the reader (`seenCollection`); a person, a kind,
 * is one the database gives them. A sort or a filter only orders and
 * narrows that.
 *
 * Each sort is one expression over the row (`keyOf`), blanks last in both
 * directions, and then the document's id, so that two rows never tie and
 * a page's cursor — the last row's key and id — says exactly where the
 * next one starts, whatever was added or changed meanwhile. The database
 * sorts it: a household's few thousand documents, by the indexes it has
 * on the household, in one statement for the page and one for the count.
 *
 * The status is the one thing the database does not hold: it is worked
 * out from the document's kind, its dates and what it is missing, as of
 * today (`rowStatus`, the very function its view uses). A sort by status,
 * or a filter on it, reads every row the other filters give, works each
 * one's status out, and pages that — so a page is full and `total` counts
 * what the filter gives, as with every other filter.
 *
 * Where the original is kept is the household's (5.41): somebody who may
 * not see it may neither sort nor filter by it (422), and nothing else
 * here orders by it.
 */
export async function documentTable(
  trx: Db,
  p: Principal,
  q: ListQuery & { sort: DocumentSort },
  listed: (rows: DocRow[]) => Promise<DocumentView[]>,
): Promise<DocumentPage> {
  if ((q.sort === 'location' || q.location !== undefined) && !maySortByLocation(p.role)) {
    throw new ApiError(422, 'validation_failed', LOCATION_SORT_REFUSAL, {
      detail: q.sort === 'location' ? 'sort' : 'location',
    });
  }
  if (q.status !== undefined && !(STATUS_ORDER as readonly string[]).includes(q.status)) {
    throw new ApiError(422, 'validation_failed', 'That is not a status a document can have.', {
      detail: 'status',
    });
  }
  const dir: SortDirection = q.direction ?? 'asc';
  const limit = Math.min(Math.max(q.limit ?? 50, 1), DOCUMENT_PAGE_MAX);
  const cursor = q.cursor ? readCursor(q.cursor, q.sort, dir) : null;
  const where = whereOf(p, q);

  let page: DocRow[];
  let more: boolean;
  let total: number;
  let next: Omit<Cursor, 's' | 'd'> | null = null;

  if (q.sort === 'status') {
    // Every row the filters give, its status worked out, then sorted here.
    const rows = (await sql<DocRow>`select ${COLUMNS} from document d where ${where}`.execute(trx))
      .rows;
    const ranked = await withStatus(trx, rows);
    const shown = q.status ? ranked.filter((r) => r.status === q.status) : ranked;
    const sign = dir === 'desc' ? -1 : 1;
    shown.sort((a, b) => compareStatus(a, b, sign));
    const after = cursor
      ? shown.filter((r) => compareStatus(r, statusCursor(cursor), sign) > 0)
      : shown;
    total = shown.length;
    more = after.length > limit;
    page = after.slice(0, limit).map((r) => r.row);
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
    const inner = sql`select ${COLUMNS}, ${key.expr} as sort_k
                        from document d ${key.join}
                       where ${where}
                      offset 0`;
    const order = sql`order by (b.sort_k is null), b.sort_k ${DIR}, b.id ${DIR}`;
    const keyset = cursor ? afterCursor(cursor, key.type, dir) : sql<boolean>`true`;
    type Keyed = DocRow & { cursor_k: string | null };
    if (q.status) {
      // A status filter: every row in the database's order, each marked
      // whether it comes after the cursor, then those of that status.
      const rows = (
        await sql<Keyed & { is_after: boolean }>`
          select b.*, b.sort_k::text as cursor_k, ${keyset} as is_after
            from (${inner}) b
           ${order}`.execute(trx)
      ).rows;
      const ranked = await withStatus(trx, rows);
      const shown = ranked.filter((r) => r.status === q.status);
      total = shown.length;
      const after = shown.filter((r) => r.row.is_after).map((r) => r.row);
      more = after.length > limit;
      page = after.slice(0, limit);
    } else {
      const rows = (
        await sql<Keyed>`
          select b.*, b.sort_k::text as cursor_k
            from (${inner}) b
           where ${keyset}
           ${order}
           limit ${limit + 1}`.execute(trx)
      ).rows;
      const counted = await sql<{ n: number }>`
        select count(*)::int as n from document d where ${where}`.execute(trx);
      total = counted.rows[0]?.n ?? 0;
      more = rows.length > limit;
      page = rows.slice(0, limit);
    }
    const last = page[page.length - 1] as Keyed | undefined;
    if (more && last) next = { k: last.cursor_k, id: last.id };
  }

  const items = await listed(page.map(plainRow));
  const collections = await collectionsOf(trx, p, page);
  return {
    items: items.map((d) => ({ ...d, collections: collections.get(d.id) ?? [] })),
    next_cursor: next ? writeCursor({ s: q.sort, d: dir, ...next }) : null,
    has_more: more,
    total,
  };
}

/** The columns of a document a list is made from (`DocRow`): never its search index. */
const COLUMNS = sql.raw(
  [
    'id',
    'type_key',
    'title',
    'owner_member_id',
    'category',
    'visibility',
    'issued_on',
    'issued_precision',
    'expires_on',
    'expires_precision',
    'identifier',
    'issued_by',
    'physical_location',
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
  ]
    .map((c) => `d.${c}`)
    .join(', '),
);

/** A row as a list's view takes it: what the page's query added taken off. */
function plainRow(r: DocRow): DocRow {
  const row: Record<string, unknown> = { ...r };
  delete row.sort_k;
  delete row.cursor_k;
  delete row.is_after;
  return row as DocRow;
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
    seenDocument(p),
    q.deleted ? sql`d.deleted_at is not null` : sql`d.deleted_at is null`,
  ];
  if (q.member_id === 'none') parts.push(sql`d.owner_member_id is null`);
  else if (q.member_id) parts.push(sql`d.owner_member_id = ${q.member_id}::uuid`);
  if (q.category) parts.push(sql`d.category = ${q.category}`);
  if (q.type_key) parts.push(sql`d.type_key = ${q.type_key}`);
  if (q.visibility) parts.push(sql`d.visibility = ${q.visibility}`);
  if (q.essential !== undefined) parts.push(sql`d.is_essential = ${q.essential}`);
  if (q.purge_requested !== undefined) {
    parts.push(
      q.purge_requested ? sql`d.purge_requested_at is not null` : sql`d.purge_requested_at is null`,
    );
  }
  if (q.tag) parts.push(sql`d.tags @> array[${q.tag}]::text[]`);
  if (q.issued_by) parts.push(sql`lower(d.issued_by) = lower(${q.issued_by.trim()})`);
  if (q.updated_since) parts.push(sql`d.updated_at > ${new Date(q.updated_since)}`);
  if (q.location !== undefined) {
    parts.push(sql`lower(btrim(d.physical_location)) = lower(btrim(${q.location}))`);
  }
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
  return sql<boolean>`${sql.join(parts, sql` and `)}`;
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
      // The kind's name, as the household's kinds give it to this reader:
      // each read once for the statement, not once a row.
      return {
        expr: sql`k.label`,
        type: 'text',
        join: sql`left join (select t.key, min(lower(t.label)) as label
                               from document_type t group by t.key) k on k.key = d.type_key`,
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

interface Ranked<R> {
  row: R;
  status: string;
  rank: number;
}

/** Each row with its status as its view will say it, worked out with the household's kinds. */
async function withStatus<R extends DocRow>(trx: Db, rows: R[]): Promise<Array<Ranked<R>>> {
  const typeOf = typeLookup(trx);
  return Promise.all(
    rows.map(async (row) => {
      const status = rowStatus(row.type_key ? await typeOf(row.type_key) : null, row).value;
      return { row, status, rank: statusRank(status) };
    }),
  );
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^\d+$/;

const badCursor = () => new ApiError(422, 'validation_failed', 'That page cursor is not valid.');

const writeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function readCursor(s: string, sort: DocumentSort, dir: SortDirection): Cursor {
  let c: Partial<Cursor>;
  try {
    c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Partial<Cursor>;
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
