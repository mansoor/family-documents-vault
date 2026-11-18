import { appendAudit, householdZone, withSystem, type Db } from '@fdv/db';
import { APP_KEY_WARN_DAYS, shareEndWords } from '@fdv/shared';
import { sql } from 'kysely';
import type pg from 'pg';
import { queueDbOf, type OwnersAlert, type QueueDb } from '../ai-send.js';

/**
 * Connected apps (0.9.0, APP1): the hourly sweep.
 *
 * What an app sent that was refused or removed is remembered for 90 days — its file's hash and size, so a send of the
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
): Promise<{ sent: number; stuck: number; changes: number; links: number }> {
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
    sent: sent.rowCount ?? 0,
    stuck: gone.rowCount ?? 0,
    changes: changes.rowCount ?? 0,
    links: links.rowCount ?? 0,
  };
}

/** A key the owners are told of: which, of which app, and when it stops. */
interface KeyNotice {
  client_id: string;
  name: string | null;
  expires_at: Date;
  app_id: string;
  app: string;
  member_id: string;
}

/**
 * An app's API keys (0.9.0-dev.63, APP6): the owners are told, once, 14
 * days before a key expires — when it was made to last longer than that —
 * and once when it has expired: an activity line (for the owners and the
 * person the app acts as) and an email to the owners, queued in the same
 * transaction that marks the key told, so neither is ever sent twice nor
 * lost. A revoked key, or one of a removed app, is told of no more. The
 * hourly sweep runs it.
 */
export async function noticeAppKeys(deps: {
  admin: pg.Pool;
  db: Db;
  tell: (a: OwnersAlert, db: QueueDb) => Promise<void>;
}): Promise<{ expiring: number; expired: number }> {
  const { rows } = await deps.admin.query<{ household_id: string }>(
    `select distinct k.household_id
       from public.connected_app_key k
       join public.connected_app a on a.id = k.app_id
      where k.revoked_at is null and a.revoked_at is null
        and k.expires_at is not null and k.expired_told_at is null
        and (k.expires_at <= now()
             or (k.warned_at is null
                 and k.expires_at <= now() + make_interval(days => $1)
                 and k.expires_at - k.created_at > make_interval(days => $1)))`,
    [APP_KEY_WARN_DAYS],
  );
  let expiring = 0;
  let expired = 0;
  for (const { household_id: hh } of rows) {
    const told = await withSystem(deps.db, hh, async (trx) => {
      const ended = await sql<KeyNotice>`
        update connected_app_key k set expired_told_at = now()
          from connected_app a
         where a.id = k.app_id and a.revoked_at is null and k.revoked_at is null
           and k.expires_at <= now() and k.expired_told_at is null
        returning k.client_id, k.name, k.expires_at, a.id as app_id, a.name as app, a.member_id`.execute(
        trx,
      );
      const soon = await sql<KeyNotice>`
        update connected_app_key k set warned_at = now()
          from connected_app a
         where a.id = k.app_id and a.revoked_at is null and k.revoked_at is null
           and k.warned_at is null and k.expired_told_at is null
           and k.expires_at > now()
           and k.expires_at <= now() + make_interval(days => ${APP_KEY_WARN_DAYS}::int)
           and k.expires_at - k.created_at > make_interval(days => ${APP_KEY_WARN_DAYS}::int)
        returning k.client_id, k.name, k.expires_at, a.id as app_id, a.name as app, a.member_id`.execute(
        trx,
      );
      if (ended.rows.length + soon.rows.length === 0) return { soon: 0, ended: 0 };
      const hhRow = await trx.selectFrom('household').select('timezone').executeTakeFirstOrThrow();
      const zone = householdZone(hhRow.timezone);
      const owners = (
        await trx
          .selectFrom('account_household')
          .select('account_id')
          .where('role', '=', 'owner')
          .execute()
      ).map((o) => o.account_id);
      const which = (k: KeyNotice) => `${k.client_id}${k.name ? ` (“${k.name}”)` : ''}`;
      const day = (d: Date) => shareEndWords(d, zone, { weekday: false, year: true });
      for (const k of soon.rows) {
        await appendAudit(trx, {
          householdId: hh,
          action: 'app.key_expiring',
          objectType: 'member',
          objectId: k.member_id,
          detail: {
            app_id: k.app_id,
            app: k.app,
            client_id: k.client_id,
            expires_at: k.expires_at.toISOString(),
          },
        });
        if (owners.length > 0) {
          await deps.tell(
            {
              household_id: hh,
              account_ids: owners,
              subject: `An API key of ${k.app} expires on ${day(k.expires_at)}`,
              body: `The API key ${which(k)} of ${k.app} expires on ${day(k.expires_at)}. To keep ${k.app} working, generate a new key in Settings → Connected apps, give it to ${k.app}, then revoke this one.`,
            },
            queueDbOf(trx),
          );
        }
      }
      for (const k of ended.rows) {
        await appendAudit(trx, {
          householdId: hh,
          action: 'app.key_expired',
          objectType: 'member',
          objectId: k.member_id,
          detail: {
            app_id: k.app_id,
            app: k.app,
            client_id: k.client_id,
            expires_at: k.expires_at.toISOString(),
          },
        });
        if (owners.length > 0) {
          await deps.tell(
            {
              household_id: hh,
              account_ids: owners,
              subject: `An API key of ${k.app} has expired`,
              body: `The API key ${which(k)} of ${k.app} expired on ${day(k.expires_at)}, and the vault refuses it now. If ${k.app} still needs to reach the vault, generate a new key in Settings → Connected apps and give it to ${k.app}.`,
            },
            queueDbOf(trx),
          );
        }
      }
      return { soon: soon.rows.length, ended: ended.rows.length };
    });
    expiring += told.soon;
    expired += told.ended;
  }
  return { expiring, expired };
}

/**
 * Whether an item just read was sent by an app that files automatically
 * (0.9.0, APP4): in an app's batch, never taken back by an Undo, the app on,
 * turned on, allowed to send, and its switch on — its own, or a backfill's
 * while it lasts. Then the worker asks the API to file it
 * (`apps.file_ready`), which asks all of this again, and whether the item is
 * sure and complete, in its own transaction as the app's person.
 */
export async function appFilesAutomatically(
  db: Db,
  hh: string,
  itemId: string,
  now: Date,
): Promise<boolean> {
  const found = await withSystem(db, hh, (trx) =>
    trx
      .selectFrom('incoming_file as f')
      .innerJoin('intake_batch as ib', 'ib.id', 'f.batch_id')
      .innerJoin('connected_app as a', 'a.id', 'ib.app_id')
      .innerJoin('connected_app_intake as i', (j) =>
        j.onRef('i.incoming_file_id', '=', 'f.id').onRef('i.app_id', '=', 'a.id'),
      )
      .select('a.id')
      .where('f.id', '=', itemId)
      .where('f.state', '=', 'received')
      .where('i.state', '=', 'waiting')
      .where('i.auto_file_held', '=', false)
      .where('a.revoked_at', 'is', null)
      .where('a.paused_reason', 'is', null)
      .where('a.approval', '=', 'approved')
      .where((eb) =>
        eb.or([
          eb('a.auto_file', '=', true),
          eb.and([eb('a.backfill_auto_file', '=', true), eb('a.backfill_until', '>', now)]),
        ]),
      )
      .executeTakeFirst(),
  );
  return found !== undefined;
}
