import { withSystem, type Db } from '@fdv/db';
import { sql } from 'kysely';
import type pg from 'pg';

export interface EndedSharingDeps {
  admin: pg.Pool;
  db: Db;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface EndedSharingReport {
  /** Households that keep ended links and requests for a while (not Never). */
  households: number;
  links: number;
  requests: number;
  /** Filed files whose request went, each keeping its row (and so its document's history). */
  filesKept: number;
  /** Households whose turn failed this night: tried again the next. */
  failed: number;
}

/** Rows removed in one transaction, so a household with many never holds one long one. */
export const ENDED_SHARING_BATCH = 200;
/** Batches a household a night, at most: what is left waits for the next night. */
const MAX_BATCHES = 50;
const DAY = 86_400_000;

/**
 * Each night (0.9.0, RQ; the owner's ask of 16 Nov 2026): links outside the
 * family and requests to send documents that ended for good longer ago than
 * the household keeps them (household.ended_sharing_days: 30, 90 or 365
 * days; null, never), removed — a household at a time, a batch at a time.
 *
 * Ended for good is what nothing brings back, counted from the earliest
 * moment it came to: a link taken back or past its end; a request taken
 * back, closed, or past its end. A paused one, a used-up one (a page opened
 * on it lasts to its end) and one stopped by wrong codes are left until
 * their end has passed too. Emergency links (H4) are never removed here.
 * The time counts from the later of that moment and when the household's
 * keeping began (household.ended_sharing_from: the upgrade to 0106, or a
 * restore of a backup from before it), so nothing goes sooner than the
 * household's time after the upgrade.
 *
 * A household whose turn fails is said in the log by its id and the
 * error's code alone, and the others have theirs; it is tried again the
 * next night.
 *
 * Nothing else is lost:
 *  - a link waits until the nightly prune has deleted its pages' files (its
 *    rows go with it); a collection's link leaves a tombstone, so the
 *    activity log still knows whom its lines are for (0106);
 *  - a request waits while any file it brought is waiting or on its way, or
 *    a decided file's bytes are still to be removed. A file filed from it
 *    keeps its row, let go of the request, so its document's history still
 *    says where the version came from; a refused file's row goes. Its
 *    tombstone keeps whom its lines in the activity log are for;
 *  - every line of the activity log stays: none has a key to either.
 *
 * The log says how many, never a title, a recipient or an address.
 */
export async function removeEndedSharing(deps: EndedSharingDeps): Promise<EndedSharingReport> {
  const now = deps.now?.() ?? new Date();
  const report: EndedSharingReport = {
    households: 0,
    links: 0,
    requests: 0,
    filesKept: 0,
    failed: 0,
  };
  const { rows } = await deps.admin.query<{ id: string; days: number; from: Date }>(
    `select id, ended_sharing_days as days, ended_sharing_from as "from"
       from household where ended_sharing_days is not null`,
  );
  for (const { id: hh, days, from } of rows) {
    report.households++;
    const before = new Date(now.getTime() - days * DAY);
    // Its time has not passed since the keeping began: nothing of it goes yet.
    if (from.getTime() >= before.getTime()) continue;
    try {
      for (let i = 0; i < MAX_BATCHES; i++) {
        const n = await removeLinks(deps.db, hh, before);
        report.links += n;
        if (n < ENDED_SHARING_BATCH) break;
      }
      for (let i = 0; i < MAX_BATCHES; i++) {
        const r = await removeRequests(deps.db, hh, before, now);
        report.requests += r.requests;
        report.filesKept += r.filesKept;
        if (r.requests < ENDED_SHARING_BATCH) break;
      }
    } catch (err) {
      report.failed++;
      const code = (err as { code?: unknown } | null)?.code;
      deps.log?.('warn', 'ended links and requests of a household could not be removed', {
        household: hh,
        code: typeof code === 'string' ? code : 'unknown',
      });
    }
  }
  if (report.links || report.requests || report.failed) {
    deps.log?.('info', 'ended links and requests removed', { ...report });
  }
  return report;
}

/** One batch of a household's links that ended for good before `before`. */
async function removeLinks(db: Db, hh: string, before: Date): Promise<number> {
  return withSystem(db, hh, async (trx) => {
    const ended = await sql<{ id: string }>`
      select l.id
        from share_link l
       where l.emergency_member_id is null
         and least(l.revoked_at, l.expires_at) < ${before}
         -- Its pages' files deleted first, by the nightly prune.
         and not exists (select 1 from share_page p where p.share_id = l.id)
       order by l.id
       limit ${ENDED_SHARING_BATCH}
         for update of l skip locked`.execute(trx);
    const ids = ended.rows.map((r) => r.id);
    if (ids.length === 0) return 0;
    // A collection's link: who made it, its collection, and what it was
    // made with or followed — for the activity log's rule (5.19).
    await sql`
      insert into share_link_tombstone (id, household_id, created_by, collection_id, document_ids)
      select l.id, l.household_id, l.created_by, l.collection_id,
             array(select i.document_id from share_link_item i
                    where i.share_id = l.id and i.kind in ('ticked', 'followed')
                    order by i.position)
        from share_link l
       where l.id = any(${ids}::uuid[]) and l.collection_id is not null
      on conflict (id) do nothing`.execute(trx);
    const gone = await trx.deleteFrom('share_link').where('id', 'in', ids).executeTakeFirst();
    return Number(gone.numDeletedRows);
  });
}

/** One batch of a household's requests that ended for good before `before`. */
async function removeRequests(
  db: Db,
  hh: string,
  before: Date,
  now: Date,
): Promise<{ requests: number; filesKept: number }> {
  return withSystem(db, hh, async (trx) => {
    const ended = await sql<{ id: string }>`
      select r.id
        from upload_request r
       where least(r.revoked_at, r.closed_at, r.expires_at) < ${before}
         and not exists (
               select 1 from incoming_file f
                where f.request_id = r.id
                  and (f.state in ('uploading', 'received') or f.object_removed_at is null))
       order by r.id
       limit ${ENDED_SHARING_BATCH}
         for update of r skip locked`.execute(trx);
    const ids = ended.rows.map((r) => r.id);
    if (ids.length === 0) return { requests: 0, filesKept: 0 };
    // A filed file keeps its row: let go of the request, its item and its
    // session, keeping whom it was for in the family's words.
    const kept = await sql`
      update incoming_file f
         set request_id = null, item_id = null, session_id = null,
             request_removed_at = ${now}, request_label = r.recipient_label
        from upload_request r
       where r.id = f.request_id
         and f.request_id = any(${ids}::uuid[])
         and f.state = 'accepted'`.execute(trx);
    await sql`
      insert into upload_request_tombstone
             (id, household_id, requester_member_id, review_by, moved_to_owners_at)
      select r.id, r.household_id, r.requester_member_id, r.review_by, r.moved_to_owners_at
        from upload_request r
       where r.id = any(${ids}::uuid[])
      on conflict (id) do nothing`.execute(trx);
    // With its items, sessions and codes, and its refused files' rows.
    const gone = await trx.deleteFrom('upload_request').where('id', 'in', ids).executeTakeFirst();
    return { requests: Number(gone.numDeletedRows), filesKept: Number(kept.numAffectedRows ?? 0) };
  });
}
