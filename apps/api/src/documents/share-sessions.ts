import type { Db } from '@fdv/db';
import { sql } from 'kysely';

/**
 * Ends the open pages (share_session rows) of links that have just ended —
 * taken back, locked by a tenth wrong PIN, or ended with their collection —
 * every one that is not in use at this moment (the 5.19 review's fourth
 * round). A request in a session holds its session row from its first
 * write (inSession's last_seen_at), and may go on to wait on the link or on
 * the activity log, which whatever ends the link already holds: waiting
 * here on that row was a deadlock, and the owner's delete of a collection
 * answered 500. So a session in use is passed over (SKIP LOCKED), never
 * waited on.
 *
 * What then becomes of it (the fifth round):
 *  - the request in flight goes on after the link has ended, and is
 *    answered by inSession as the link's, gone (404 link_not_valid), all it
 *    did undone and its session removed — asked again as it finishes — so a
 *    later request of that session is 401 share_session_ended;
 *  - a session whose request finished just before the link ended is kept:
 *    its next request finds its link gone first, and is answered 404
 *    link_not_valid and removed;
 *  - left alone, it lapses within four hours;
 *  - and an ended link's pages are removed whatever sessions it has.
 */
export async function endSessions(trx: Db, shareIds: readonly string[]): Promise<void> {
  if (shareIds.length === 0) return;
  await sql`delete from share_session
             where id in (select id from share_session
                           where share_id = any(${[...shareIds]}::uuid[])
                           for update skip locked)`.execute(trx);
}
