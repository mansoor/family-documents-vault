import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  normaliseTag,
  tagDetail,
  tagKey,
  tagLabelKey,
  tagsProblem,
  normaliseTags,
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
 * tenant, the actor, a viewer's restriction) — out of the Trash, as the
 * list of tags counts them. A tag on documents they cannot see is never
 * counted, never touched and never said to exist: not in a count, not in
 * "it is a tag already", not in what is left. An owner is given nothing
 * more of another member's Only me documents than anybody else is.
 *
 * Who may change a document is who may edit it: owners, adults and teens
 * (`document.edit`), a teen only their own (the teen rule, as an edit).
 * Each document changed moves its `updated_at`, so its ETag, so an edit
 * made against what it was is told it was changed (409); and has its own
 * activity line, which follows the document as an edit's does. The line
 * says what was done — renamed, merged, taken off — never the tag's words:
 * a tag deleted because it held something it should not stays deleted, and
 * is not kept in the log for good.
 */

/** The most tags GET /tags gives at once (`limit`). */
export const TAG_LIST_MAX = 1000;

/** "This caller may change document `d`", as SQL on a row called `d`: an edit's rule. */
function changeable(p: Principal): RawBuilder<boolean> {
  const editor = can(p.role, 'document.edit');
  return p.role === 'teen'
    ? sql<boolean>`(${editor}::boolean and d.owner_member_id = ${p.memberId}::uuid)`
    : sql<boolean>`${editor}::boolean`;
}

/** The documents a tag's change is about: the caller's to see, out of the Trash. */
const live = (p: Principal) => sql<boolean>`(d.deleted_at is null and ${seenDocument(p)})`;

/** A LIKE pattern's own characters, taken as themselves. */
const literal = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * What a tag typed so far is compared by, its end untrimmed: "Locker :  1"
 * is "locker: 1", and "locker: " offers every value of the label.
 */
function startKey(q: string): string {
  const s = q.replace(/\s+/g, ' ').replace(/^ /, '');
  const at = s.indexOf(': ');
  if (at > 0 && s.slice(0, at).trim()) {
    return `${tagLabelKey(s.slice(0, at))}: ${s.slice(at + 2).replace(/^ /, '')}`.toLowerCase();
  }
  return s.toLowerCase();
}

/**
 * GET /tags: the tags on the documents the caller can see, out of the
 * Trash, most used first; with `q`, those that start with it. One spelling
 * of each — the one used most — and each document counted once.
 */
export async function listTags(
  db: Db,
  p: Principal,
  opts: { q?: string | undefined; limit?: number | undefined },
): Promise<TagView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), TAG_LIST_MAX);
  const start = opts.q ? startKey(opts.q) : '';
  return withPrincipal(db, p, async (trx) => {
    const r = await sql<{ tag: string; count: number; changeable: number }>`
      with seen as (
        select d.id, t, (fdv_tag_keys(array[t]))[1] as k, ${changeable(p)} as mine
          from document d, unnest(d.tags) as t
         -- Tags are words people write about their documents, as telling
         -- as a title. Until 0.4.2 this was the one query with no rule.
         where ${live(p)}
      ),
      matching as (
        select * from seen where k is not null ${start ? sql`and k like ${`${literal(start)}%`}` : sql``}
      ),
      spelt as (select k, t, count(distinct id) as n from matching group by k, t)
      select (select s.t from spelt s where s.k = m.k order by s.n desc, s.t limit 1) as tag,
             count(distinct m.id)::int as count,
             count(distinct m.id) filter (where m.mine)::int as changeable
        from matching m
       group by m.k
       order by count desc, tag
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

/** A tag sent to be renamed or deleted, as it is compared; refused when there is none. */
function keyOf(tag: string, what: string): string {
  const key = tagKey(tag);
  if (!key) throw new ApiError(422, 'validation_failed', `Say which tag to ${what}.`);
  return key;
}

/**
 * Each document the caller may change that carries the tag `from`, held
 * until the change is made; and how many they can see that carry it and
 * they may not change.
 */
async function held(trx: Db, p: Principal, from: string) {
  const rows = await sql<{ id: string; tags: string[] }>`
    select d.id, d.tags from document d
     where ${live(p)} and ${changeable(p)} and fdv_tag_keys(d.tags) @> array[${from}]::text[]
     order by d.id
       for update`.execute(trx);
  const kept = await sql<{ n: number }>`
    select count(*)::int as n from document d
     where ${live(p)} and not ${changeable(p)}
       and fdv_tag_keys(d.tags) @> array[${from}]::text[]`.execute(trx);
  return { rows: rows.rows, kept: kept.rows[0]?.n ?? 0 };
}

/** A document's tags written again, by the caller, with its line in the activity log. */
async function rewrite(
  trx: Db,
  p: Principal,
  id: string,
  tags: string[],
  change: 'renamed' | 'merged' | 'removed',
  meta: RequestMeta,
): Promise<void> {
  await trx
    .updateTable('document')
    .set({ tags, updated_at: new Date(), updated_by: p.accountId })
    .where('id', '=', id)
    .execute();
  await appendAudit(trx, {
    householdId: p.householdId,
    actorAccountId: p.accountId,
    action: 'document.tags_changed',
    objectType: 'document',
    objectId: id,
    // What was done, never the tag's words.
    detail: { change },
    ip: meta.ip,
  });
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
  const from = keyOf(input.from, 'rename');
  const to = normaliseTag(input.to);
  if (!to) throw new ApiError(422, 'validation_failed', 'Say what to rename it to.');
  const problem = tagsProblem([to]);
  if (problem) throw new ApiError(422, 'validation_failed', problem, { detail: 'to' });
  const toKey = to.toLowerCase();
  return withPrincipal(db, p, async (trx) => {
    let merged = false;
    if (toKey !== from) {
      // A tag already, on a document the caller can see: only then is it a
      // merge, and said to be. One only on documents they cannot see is
      // nothing they are told of.
      const there = await sql<{ n: number }>`
        select count(*)::int as n from document d
         where ${live(p)} and fdv_tag_keys(d.tags) @> array[${toKey}]::text[]`.execute(trx);
      merged = (there.rows[0]?.n ?? 0) > 0;
      if (merged && input.merge !== true) {
        throw new ApiError(
          409,
          'tag_exists',
          `“${to}” is a tag already. Renaming “${normaliseTag(input.from)}” to it merges the two.`,
        );
      }
    }
    const { rows, kept } = await held(trx, p, from);
    let changed = 0;
    for (const row of rows) {
      const had = row.tags.some((t) => tagKey(t) === toKey && toKey !== from);
      const next = normaliseTags(row.tags.map((t) => (tagKey(t) === from ? to : t)));
      if (next.length === row.tags.length && next.every((t, i) => t === row.tags[i])) continue;
      await rewrite(trx, p, row.id, next, had ? 'merged' : 'renamed', meta);
      changed += 1;
    }
    return { changed, kept, merged };
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
  const key = keyOf(input.tag, 'delete');
  return withPrincipal(db, p, async (trx) => {
    const { rows, kept } = await held(trx, p, key);
    for (const row of rows) {
      await rewrite(
        trx,
        p,
        row.id,
        row.tags.filter((t) => tagKey(t) !== key),
        'removed',
        meta,
      );
    }
    return { changed: rows.length, kept, merged: false };
  });
}
