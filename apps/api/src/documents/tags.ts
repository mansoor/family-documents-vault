import { appendAuditMany, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  normaliseTag,
  tagDetail,
  tagsProblem,
  type TagChangeResult,
  type TagView,
} from '@fdv/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import { seenDocument } from './service.js';

/**
 * Tags you can use (0.9.0, T1): the list of tags with how many of the
 * caller's documents carry each, and a tag renamed, merged into another or
 * deleted across the documents the caller may change.
 *
 * What a caller is told, and what they touch, is only ever of documents
 * they can see (`seenDocument`, and row-level security beneath it: the
 * tenant, the actor, a viewer's restriction). The list counts those out of
 * the Trash; a rename or a delete reaches the Trash too, as the Trash list
 * shows it to them, so that a tag deleted is not given back by a restore. A
 * tag on documents they cannot see is never counted, never touched and
 * never said to exist: not in a count, not in "it is a tag already", not in
 * what is left. An owner is given nothing more of another member's Only me
 * documents than anybody else is.
 *
 * Tags are compared by the database alone (0073: the stored `tag_keys`, and
 * `fdv_tag_key` of what is asked), never by JavaScript, whose lower case is
 * not the database's ("İ", a final "ς").
 *
 * Who may change a document is who may edit it: owners, adults and teens
 * (`document.edit`), a teen only their own (the teen rule, as an edit).
 * Each document changed moves its `updated_at`, so its ETag, so an edit
 * made against what it was is told it was changed (409); and has its own
 * activity line, which follows the document as an edit's does. The line
 * says what was done — renamed, merged, taken off — never the tag's words:
 * a tag deleted because it held something it should not stays deleted, and
 * is not kept in the log for good.
 *
 * A rename or a delete is one statement for every document, and one for
 * their lines, whatever their number (the review's H3: one a document held
 * the household's log for 34 s at 2,000). The documents are held first, in
 * the order of their ids, and only then the log: an edit holds its one
 * document and then the log, so neither waits on the other in a circle.
 */

/** The most tags GET /tags gives at once (`limit`). */
export const TAG_LIST_MAX = 1000;

/**
 * The most documents one rename or delete changes: past it, refused before
 * anything is held, to be done in parts. Measured through the API (T1
 * review): 2,000 in about 2 s, 5,000 in about 4 s, 20,000 in 12 to 14 s —
 * most of it the writing of each row (its search index and its triggers),
 * which an edit of any one field of 20,000 documents costs as much. So one
 * call holds the household's documents and its log for a few seconds at
 * most.
 */
export const TAG_CHANGE_MAX = 5_000;

/** "This caller may change document `d`", as SQL on a row called `d`: an edit's rule. */
function changeable(p: Principal): RawBuilder<boolean> {
  const editor = can(p.role, 'document.edit');
  return p.role === 'teen'
    ? sql<boolean>`(${editor}::boolean and d.owner_member_id = ${p.memberId}::uuid)`
    : sql<boolean>`${editor}::boolean`;
}

/** The documents the list of tags counts: the caller's to see, out of the Trash. */
const live = (p: Principal) => sql<boolean>`(d.deleted_at is null and ${seenDocument(p)})`;

/**
 * GET /tags: the tags on the documents the caller can see, out of the
 * Trash, most used first; with `q`, those whose key starts as its key does
 * ("locker: " offers every value of the label). One spelling of each — the
 * one used most — and each document counted once. Every key is read from
 * the stored column: nothing is worked out per row (the review's H1).
 */
export async function listTags(
  db: Db,
  p: Principal,
  opts: { q?: string | undefined; limit?: number | undefined },
): Promise<TagView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), TAG_LIST_MAX);
  const q = opts.q?.trim() ? opts.q : null;
  return withPrincipal(db, p, async (trx) => {
    const r = await sql<{ tag: string; count: number; changeable: number }>`
      with seen as (
        select d.id, u.t, u.k, ${changeable(p)} as mine
          from document d, unnest(d.tags, d.tag_keys) as u(t, k)
         -- Tags are words people write about their documents, as telling
         -- as a title. Until 0.4.2 this was the one query with no rule.
         where ${live(p)} and u.k <> ''
           ${
             q
               ? // "locker: " keeps its space: the values of the label, not "locker:9".
                 sql`and u.k like replace(replace(replace(
                          fdv_tag_key(${q}) || case when ${q} ~ ':\\s+$' then ' ' else '' end,
                          '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`
               : sql``
           }
      ),
      spelt as (select k, t, count(*) as n from seen group by k, t),
      best as (select distinct on (k) k, t from spelt order by k, n desc, t),
      counted as (
        select k, count(distinct id)::int as count,
               (count(distinct id) filter (where mine))::int as changeable
          from seen group by k
      )
      select b.t as tag, c.count, c.changeable
        from counted c join best b on b.k = c.k
       order by c.count desc, b.t
       limit ${limit}`.execute(trx);
    return r.rows.map((row) => {
      const d = tagDetail(row.tag);
      return {
        tag: row.tag,
        count: row.count,
        label: d ? d.label.toLowerCase() : null,
        value: d ? d.value : null,
        changeable: row.changeable,
      };
    });
  });
}

/** A tag sent to be renamed or deleted; refused when there is none. */
function asked(tag: string, what: string): string {
  if (!normaliseTag(tag)) throw new ApiError(422, 'validation_failed', `Say which tag to ${what}.`);
  return tag;
}

/**
 * Each document the caller may change that carries the tag keyed `from`,
 * in the Trash or not, held in the order of their ids until the change is
 * made; whether each carries `also` (a merge's other tag) already; and how
 * many they can see that carry it and they may not change.
 */
async function held(trx: Db, p: Principal, from: string, also: string | null) {
  // Too many for one call: said before any of them is held.
  const count = await sql<{ n: number }>`
    select count(*)::int as n from document d
     where ${seenDocument(p)} and ${changeable(p)}
       and d.tag_keys @> array[fdv_tag_key(${from})]`.execute(trx);
  const n = count.rows[0]?.n ?? 0;
  if (n > TAG_CHANGE_MAX) {
    throw new ApiError(
      422,
      'too_many_documents',
      `That tag is on ${n.toLocaleString('en-GB')} documents you can change, and one change reaches ${TAG_CHANGE_MAX.toLocaleString('en-GB')} at most. Do it in parts: in Documents, filter by the tag, choose some of them, and use Tags → Remove a tag… (or add the new one first), then try again.`,
    );
  }
  const rows = await sql<{ id: string; had: boolean; trashed: boolean }>`
    select d.id, ${also === null ? sql`false` : sql`d.tag_keys @> array[fdv_tag_key(${also})]`} as had,
           d.deleted_at is not null as trashed
      from document d
     where ${seenDocument(p)} and ${changeable(p)}
       and d.tag_keys @> array[fdv_tag_key(${from})]
     order by d.id
       for update`.execute(trx);
  const kept = await sql<{ n: number }>`
    select count(*)::int as n from document d
     where ${seenDocument(p)} and not ${changeable(p)}
       and d.tag_keys @> array[fdv_tag_key(${from})]`.execute(trx);
  return { rows: rows.rows, kept: kept.rows[0]?.n ?? 0 };
}

/**
 * The documents' tags written again, in one statement, by the caller — only
 * where they change — and a line in the activity log for each that did, in
 * one. `next` is SQL for the new tags of a row called `d`. Its other tags
 * are left as they were kept (a tag an older release kept with two spaces
 * keeps them), but that two that are now one tag, whatever their case, are
 * one: the first.
 */
async function rewrite(
  trx: Db,
  p: Principal,
  ids: string[],
  next: RawBuilder<string[]>,
  change: (id: string) => 'renamed' | 'merged' | 'removed',
  meta: RequestMeta,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const changed = await sql<{ id: string }>`
    with target as (
      select d.id, ${next} as tags from document d where d.id = any(${ids}::uuid[])
    )
    update document d
       set tags = target.tags, updated_at = ${new Date()}, updated_by = ${p.accountId}::uuid
      from target
     where d.id = target.id and d.tags is distinct from target.tags
    returning d.id`.execute(trx);
  const done = new Set(changed.rows.map((r) => r.id));
  const kept = ids.filter((id) => done.has(id));
  await appendAuditMany(
    trx,
    kept.map((id) => ({
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'document.tags_changed',
      objectType: 'document',
      objectId: id,
      // What was done, never the tag's words.
      detail: { change: change(id) },
      ip: meta.ip,
    })),
  );
  return kept;
}

/**
 * POST /tags/rename: `from` becomes `to` on every document the caller may
 * change. Renamed to a tag one of the documents they can see carries
 * already, the two are merged — asked first: without `merge: true` it is
 * `409 tag_exists`. A document that has both keeps one, the first.
 */
export async function renameTag(
  db: Db,
  p: Principal,
  input: { from: string; to: string; merge?: boolean | undefined },
  meta: RequestMeta,
): Promise<TagChangeResult> {
  requireCapability(p, 'document.edit');
  const from = asked(input.from, 'rename');
  const to = normaliseTag(input.to);
  if (!to) throw new ApiError(422, 'validation_failed', 'Say what to rename it to.');
  const problem = tagsProblem([to]);
  if (problem) throw new ApiError(422, 'validation_failed', problem, { detail: 'to' });
  return withPrincipal(db, p, async (trx) => {
    // A tag already, on a document the caller can see out of the Trash:
    // only then is it a merge, and said to be. One only on documents they
    // cannot see is nothing they are told of.
    const there = await sql<{ same: boolean; n: number }>`
      select fdv_tag_key(${from}) = fdv_tag_key(${to}) as same,
             (select count(*)::int from document d
               where ${live(p)} and d.tag_keys @> array[fdv_tag_key(${to})]) as n`.execute(trx);
    const same = there.rows[0]?.same === true;
    const merged = !same && (there.rows[0]?.n ?? 0) > 0;
    if (merged && input.merge !== true) {
      throw new ApiError(
        409,
        'tag_exists',
        `“${to}” is a tag already. Renaming “${normaliseTag(input.from)}” to it merges the two.`,
      );
    }
    const { rows, kept } = await held(trx, p, from, same ? null : to);
    const had = new Set(rows.filter((r) => r.had).map((r) => r.id));
    // Each tag keyed `from` is `to`; then the first of each key is kept.
    const next = sql<string[]>`(
      select coalesce(array_agg(x.t order by x.n), '{}'::text[])
        from (select distinct on (y.k) y.t, y.n
                from (select case when u.k = fdv_tag_key(${from}) then ${to}::text else u.t end as t,
                             case when u.k = fdv_tag_key(${from}) then fdv_tag_key(${to}) else u.k end as k,
                             u.n
                        from unnest(d.tags, d.tag_keys) with ordinality as u(t, k, n)) as y
               order by y.k, y.n) as x)`;
    const changed = await rewrite(
      trx,
      p,
      rows.map((r) => r.id),
      next,
      (id) => (had.has(id) ? 'merged' : 'renamed'),
      meta,
    );
    const done = new Set(changed);
    return {
      changed: changed.length,
      kept,
      merged,
      in_trash: rows.filter((r) => r.trashed && done.has(r.id)).length,
    };
  });
}

/** POST /tags/delete: the tag taken off every document the caller may change. */
export async function deleteTag(
  db: Db,
  p: Principal,
  input: { tag: string },
  meta: RequestMeta,
): Promise<TagChangeResult> {
  requireCapability(p, 'document.edit');
  const tag = asked(input.tag, 'delete');
  return withPrincipal(db, p, async (trx) => {
    const { rows, kept } = await held(trx, p, tag, null);
    const next = sql<string[]>`(
      select coalesce(array_agg(u.t order by u.n), '{}'::text[])
        from unnest(d.tags, d.tag_keys) with ordinality as u(t, k, n)
       where u.k <> fdv_tag_key(${tag}))`;
    const changed = await rewrite(
      trx,
      p,
      rows.map((r) => r.id),
      next,
      () => 'removed',
      meta,
    );
    const done = new Set(changed);
    return {
      changed: changed.length,
      kept,
      merged: false,
      in_trash: rows.filter((r) => r.trashed && done.has(r.id)).length,
    };
  });
}
