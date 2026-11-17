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
 * As the owning role: these rows are the vault's alone to remove, every
 * household's at once, and none of them says anything about a person.
 */
export const APP_INTAKE_KEEP_DAYS = 90;

/** A send still arriving after this long died on its way: its row and its part-sent item go. */
export const APP_ARRIVING_GIVE_UP_MINUTES = 60;

export async function sweepApps(
  admin: pg.Pool,
): Promise<{ nonces: number; sent: number; stuck: number }> {
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
  return {
    nonces: nonces.rowCount ?? 0,
    sent: sent.rowCount ?? 0,
    stuck: gone.rowCount ?? 0,
  };
}
