import type { Db, Visibility } from '@fdv/db';
import { sql } from 'kysely';

/** A document a collection's link was made with, or has followed, as who may see it. */
export interface MadeWith {
  share_id: string;
  visibility: Visibility;
  owner_member_id: string | null;
}

/**
 * What each of these collections' links was made with, or has followed —
 * the documents of its snapshot, ticked or followed — as who may see each.
 * A reader is told of a collection's link (GET /shares, the collection's
 * "shared outside", taking it back, its lines in the activity log) only
 * when they can see every one of them, or made it (5.19).
 *
 * A document removed for good (5.24) has left the snapshot with its row,
 * and is here as its tombstone says: without it, a link the reader was not
 * told of — made with a document they could not see — would become theirs
 * to know, recipient and all, the moment that document was removed. What
 * it was made without (left out) never counts.
 */
export async function madeWith(trx: Db, shareIds: readonly string[]): Promise<MadeWith[]> {
  if (shareIds.length === 0) return [];
  const ids = [...shareIds];
  const r = await sql<MadeWith>`
    select t.share_id, d.visibility, d.owner_member_id
      from share_link_item t
      join document d on d.id = t.document_id
     where t.share_id = any(${ids}::uuid[])
       and t.kind in ('ticked', 'followed')
    union all
    select s.share_id, x.visibility, x.owner_member_id
      from document_tombstone x
     cross join lateral unnest(x.link_ids) as s(share_id)
     where s.share_id = any(${ids}::uuid[])`.execute(trx);
  return r.rows;
}
