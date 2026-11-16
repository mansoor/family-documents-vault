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
     where s.share_id = any(${ids}::uuid[])
    union all
    -- A collection's link removed once it had ended (0106, RQ): what its
    -- tombstone says it was made with or followed, each document as its row
    -- or its own tombstone says; one found in neither counts as nobody's.
    select g.id, coalesce(d.visibility, x.visibility, 'private'::visibility),
           case when d.id is not null then d.owner_member_id else x.owner_member_id end
      from share_link_tombstone g
     cross join lateral unnest(g.document_ids) as k(document_id)
      left join document d on d.id = k.document_id
      left join document_tombstone x on x.id = k.document_id
     where g.id = any(${ids}::uuid[])`.execute(trx);
  return r.rows;
}
