import type pg from 'pg';

/**
 * Connected apps (0.9.0, APP1): the hourly sweep.
 *
 * A nonce is kept only while a signature with it could be taken (its
 * `created` and five minutes): past that, the window refuses the request
 * anyway, so the row is let go (the API also lets an app's own go as it
 * checks a new one). And what an app sent that was refused or removed is
 * remembered for 90 days — its file's hash and size, so a send of the
 * same file is recognised — then forgotten: its
 * external id is free, and nothing of it is left. A filed one is kept as
 * long as its row is (APP2 says when it stops being the app's).
 *
 * An app's changes feed (APP2) keeps 90 days of lines: older ones go, and
 * the app is told a cursor from before them is too old (its
 * changes_pruned_to). What it was told of a document it can no longer read
 * goes after 90 days too; a revoked app's feed goes at once.
 *
 * An app's links (APP3) work for two minutes, and their sessions for ten:
 * a link is kept 8 days after it was minted, so Settings can say how many
 * were opened in the last week, then it goes; a revoked app's at once. Only
 * hashes are kept of its token and its session, never either.
 *
 * As the owning role: these rows are the vault's alone to remove, every
 * household's at once, and none of them says anything about a person.
 */
export const APP_INTAKE_KEEP_DAYS = 90;

/** A send still arriving after this long died on its way: its row and its part-sent item go. */
export const APP_ARRIVING_GIVE_UP_MINUTES = 60;

/** Lines of an app's changes feed are kept this many days (APP2). */
export const APP_CHANGES_KEEP_DAYS = 90;

/** An app's link is kept this many days after it was minted (APP3): Settings counts a week. */
export const APP_LINKS_KEEP_DAYS = 8;

export async function sweepApps(
  admin: pg.Pool,
): Promise<{ nonces: number; sent: number; stuck: number; changes: number; links: number }> {
  const nonces = await admin.query(
    'delete from public.connected_app_nonce where expires_at < now()',
  );
  const sent = await admin.query(
    `delete from public.connected_app_intake
      where state in ('refused', 'removed')
        and decided_at < now() - make_interval(days => $1)`,
    [APP_INTAKE_KEEP_DAYS],
  );
  // A send that never finished: its claim on the external id let go, and
  // the item it had begun with it — whose bytes are owed to purge_leftover
  // as the row goes (0062's incoming_file_leaves_bytes), and removed with
  // the rest of what a removal leaves.
  const gone = await admin.query<{ incoming_file_id: string | null }>(
    `delete from public.connected_app_intake
      where state = 'arriving' and started_at < now() - make_interval(mins => $1)
      returning incoming_file_id`,
    [APP_ARRIVING_GIVE_UP_MINUTES],
  );
  const items = gone.rows.map((r) => r.incoming_file_id).filter((id): id is string => !!id);
  if (items.length > 0) {
    await admin.query(
      `delete from public.incoming_file where id = any($1::uuid[]) and state = 'uploading'`,
      [items],
    );
  }
  // The feed's old lines, in one statement with one cut-off: each live
  // app's last line let go is noted on it, and exactly those lines go, so a
  // cursor before them is answered as too old, never as nothing new. The
  // note waits for a feed being read (which holds its app's row), and a feed
  // read after sees both. A removed app's feed goes whole.
  const changes = await admin.query(
    `with cut as (
       select app_id, max(seq) as last from public.connected_app_change
        where at < now() - make_interval(days => $1)
        group by app_id
     ), noted as (
       update public.connected_app a
          set changes_pruned_to = cut.last
         from cut
        where a.id = cut.app_id and a.revoked_at is null and a.changes_pruned_to < cut.last
        returning a.id
     )
     delete from public.connected_app_change c
      where c.seq <= (select cut.last from cut where cut.app_id = c.app_id)
         or exists (select 1 from public.connected_app a
                     where a.id = c.app_id and a.revoked_at is not null)`,
    [APP_CHANGES_KEEP_DAYS],
  );
  await admin.query(
    `delete from public.connected_app_seen s
      where (not s.available and s.changed_at < now() - make_interval(days => $1))
         or exists (select 1 from public.connected_app a
                     where a.id = s.app_id and a.revoked_at is not null)`,
    [APP_CHANGES_KEEP_DAYS],
  );
  const links = await admin.query(
    `delete from public.connected_app_link l
      where l.created_at < now() - make_interval(days => $1)
         or exists (select 1 from public.connected_app a
                     where a.id = l.app_id and a.revoked_at is not null)`,
    [APP_LINKS_KEEP_DAYS],
  );
  return {
    nonces: nonces.rowCount ?? 0,
    sent: sent.rowCount ?? 0,
    stuck: gone.rowCount ?? 0,
    changes: changes.rowCount ?? 0,
    links: links.rowCount ?? 0,
  };
}
