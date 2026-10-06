import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
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
import {
  kindGiven,
  rowStatus,
  seenDocument,
  typeLookup,
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
 * (`seenDocument`) narrow the rows; a collection is one the collections
 * themselves would show the reader (`seenCollection`); a kind is named as
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
 * here orders by it.
 */
export async function documentTable(
  trx: Db,
  p: Principal,
  q: ListQuery & { sort: DocumentSort },
  listed: (rows: DocRow[]) => Promise<DocumentView[]>,
  cursorKey: Uint8Array,
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
  const cursor = q.cursor ? readCursor(cursorKey, p, q.cursor, q.sort, dir) : null;
  const where = whereOf(p, q);

  let ids: string[];
  let more: boolean;
  let total: number;
  let next: Omit<Cursor, 's' | 'd'> | null = null;

  if (q.sort === 'status') {
    // What every row the filters give has of a status, worked out, sorted here.
    const rows = (
      await sql<StatusRow>`select ${STATUS_COLUMNS} from document d where ${where}`.execute(trx)
    ).rows;
    const ranked = await withStatus(trx, rows);
    const shown = q.status ? ranked.filter((r) => r.status === q.status) : ranked;
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
    if (q.status) {
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
      const ranked = await withStatus(trx, rows);
      const shown = ranked.filter((r) => r.status === q.status);
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

/** A page's rows, in the order of `ids`: read by id once the sort has chosen them. */
async function rowsOf(trx: Db, p: Principal, ids: string[]): Promise<DocRow[]> {
  if (ids.length === 0) return [];
  const rows = (
    await sql<DocRow>`select ${COLUMNS} from document d
                       where d.id = any(${ids}::uuid[]) and ${seenDocument(p)}`.execute(trx)
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
  | 'issued_on'
  | 'issued_precision'
  | 'expires_on'
  | 'expires_precision'
  | 'identifier'
  | 'issued_by'
  | 'physical_location'
  | 'tags'
  | 'extra'
  | 'sealed_details'
> & { has_notes: boolean; has_sealed_notes: boolean };

const STATUS_COLUMNS = sql.raw(
  [
    'id',
    'type_key',
    'owner_member_id',
    'issued_on',
    'issued_precision',
    'expires_on',
    'expires_precision',
    'identifier',
    'issued_by',
    'physical_location',
    'tags',
    'extra',
    'sealed_details',
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

/** Each row with its status as its view will say it, worked out with the household's kinds. */
async function withStatus<R extends StatusRow>(trx: Db, rows: R[]): Promise<Array<Ranked<R>>> {
  // The kinds the rows have, looked up once each; then every row at once.
  const typeOf = typeLookup(trx);
  const keys = [...new Set(rows.map((r) => r.type_key).filter((k): k is string => k !== null))];
  const types = new Map(await Promise.all(keys.map(async (k) => [k, await typeOf(k)] as const)));
  return rows.map((row) => {
    const status = rowStatus(row.type_key ? types.get(row.type_key) : null, {
      ...row,
      notes: row.has_notes ? THERE : null,
      notes_sealed: row.has_sealed_notes ? SEALED_THERE : null,
    }).value;
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
