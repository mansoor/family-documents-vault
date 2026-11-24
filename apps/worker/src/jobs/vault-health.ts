import { appendAudit, householdZone, withSystem, type Db } from '@fdv/db';
import { HEALTH_EVENTS, shareEndWords, type HealthAlertAbout } from '@fdv/shared';
import { sql } from 'kysely';
import type pg from 'pg';
import { queueDbOf, type OwnersAlert, type QueueDb } from '../ai-send.js';

/**
 * What Settings → System health reads (0.9.0), written as the worker
 * does its own work: a line in the activity log when a backup is made or
 * fails and when the restore drill is run — in the installation's own
 * household's log (the first one set up), since those are the server's —
 * and in every household's when its log is checked. About the vault, never
 * about anybody, and in nobody's Activity (no rule names them). Then the
 * owners told, once, when the backups stop or the check fails; not again
 * until it clears.
 */

type Event = (typeof HEALTH_EVENTS)[keyof typeof HEALTH_EVENTS];

interface Dbs {
  admin: pg.Pool;
  db: Db;
}

/** The installation's own household: the first one set up, as vault_display_name() names it. */
export async function installationHousehold(admin: pg.Pool): Promise<string | null> {
  const { rows } = await admin.query<{ id: string }>(
    'select id from public.household where deleted_at is null order by created_at, id limit 1',
  );
  return rows[0]?.id ?? null;
}

const write = (deps: Dbs, hh: string, action: Event, detail: Record<string, unknown>) =>
  withSystem(deps.db, hh, (trx) =>
    appendAudit(trx, { householdId: hh, action, objectType: 'household', objectId: hh, detail }),
  );

/**
 * A line about the server — a backup made or failed, a drill run — in the
 * installation's own household's log; or, `every`, a line in each
 * household's (its log checked), each with its own detail.
 */
export async function noteVaultCheck(
  deps: Dbs,
  action: Event,
  detail: (householdId: string) => Record<string, unknown> = () => ({}),
  opts: { every?: boolean } = {},
): Promise<void> {
  const ids = opts.every
    ? (
        await deps.admin.query<{ id: string }>(
          'select id from public.household where deleted_at is null order by created_at, id',
        )
      ).rows.map((r) => r.id)
    : [await installationHousehold(deps.admin)].filter((id): id is string => id !== null);
  for (const id of ids) await write(deps, id, action, detail(id));
}

/** Since when a problem has stood: the last time the thing was fine, or the start of time. */
interface Problem {
  about: HealthAlertAbout;
  /** The last time it was fine; null for never. */
  fineAt: Date | null;
  subject: string;
  body: string;
}

/**
 * Tells the owners, once a problem, when the nightly backup has not been
 * made for `lateDays` (FDV_BACKUP_LATE_DAYS) or the last one failed — the
 * installation's own household's owners, the server being theirs — or a
 * household's last check of its activity log found it changed. A problem
 * is told once: its line (`vault.owners_told`) is written after the last
 * time it was fine, so it clears when a backup is made or a check passes,
 * and the next problem is told again. `backups` false (the hosted edition,
 * whose operator keeps the backups): never told of them, and a failed
 * check says to contact whoever runs the vault.
 */
export async function noticeHealth(deps: {
  admin: pg.Pool;
  db: Db;
  tell: (a: OwnersAlert, db: QueueDb) => Promise<void>;
  lateDays: number;
  backups: boolean;
  /** Tests: the clock that says what is late. */
  now?: () => number;
}): Promise<number> {
  const { rows } = await deps.admin.query<{ id: string }>(
    'select id from public.household where deleted_at is null order by created_at, id',
  );
  const installation = rows[0]?.id ?? null;
  const lateDays = Math.max(1, Math.round(deps.lateDays));
  let told = 0;
  for (const { id: hh } of rows) {
    const server = deps.backups && hh === installation;
    told += await withSystem(deps.db, hh, async (trx) => {
      // One household's alerts at a time, whichever worker asks.
      await sql`select pg_advisory_xact_lock(hashtext('fdv:health-alert:' || ${hh}::text))`.execute(
        trx,
      );
      // Each the household's newest line of its kind, by the log's index
      // (household, action, id: 0125); the server's only where they are its.
      const newest = (action: string, alias: string, where = sql`true`) => sql`left join lateral (
          select e.at, e.detail from audit_event e
           where e.household_id = ${hh} and e.action = ${action} and ${where}
           order by e.id desc limit 1) ${sql.raw(alias)} on true`;
      const none = (alias: string) =>
        sql`left join lateral (select null::timestamptz as at, null::jsonb as detail) ${sql.raw(alias)} on true`;
      const facts = (
        await sql<{
          timezone: string | null;
          made_at: Date | null;
          failed_at: Date | null;
          created_at: Date;
          checked_at: Date | null;
          checked_ok: boolean | null;
          checked_ok_at: Date | null;
        }>`select h.timezone, h.created_at, m.at as made_at, f.at as failed_at,
                  c.at as checked_at, (c.detail->>'ok') = 'true' as checked_ok,
                  k.at as checked_ok_at
             from household h
             ${server ? newest(HEALTH_EVENTS.backupMade, 'm') : none('m')}
             ${server ? newest(HEALTH_EVENTS.backupFailed, 'f') : none('f')}
             ${newest(HEALTH_EVENTS.auditChecked, 'c')}
             ${newest(HEALTH_EVENTS.auditChecked, 'k', sql`e.detail->>'ok' = 'true'`)}
            where h.id = ${hh}`.execute(trx)
      ).rows[0];
      if (!facts) return 0;
      const zone = householdZone(facts.timezone);
      const day = (d: Date) => shareEndWords(d, zone, { weekday: false, year: true });
      const problems: Problem[] = [];
      const lateBy = (deps.now?.() ?? Date.now()) - lateDays * 24 * 3600_000;
      const failedLast =
        facts.failed_at !== null &&
        (facts.made_at === null || facts.failed_at.getTime() > facts.made_at.getTime());
      // Late from the last backup; with none yet, from the day the vault
      // was set up (its first nightly backup lands within a day).
      const late = (facts.made_at ?? facts.created_at).getTime() < lateBy;
      if (server && (failedLast || late)) {
        const last = facts.made_at
          ? `The last backup was made on ${day(facts.made_at)}.`
          : 'No backup has been made yet.';
        problems.push({
          about: 'backup',
          fineAt: facts.made_at,
          subject: failedLast
            ? 'Your vault’s backup didn’t finish'
            : 'Your vault hasn’t made a backup lately',
          body: [
            failedLast
              ? 'The vault’s nightly backup didn’t finish, after trying again.'
              : `The vault hasn’t made a backup for more than ${lateDays} ${lateDays === 1 ? 'day' : 'days'}.`,
            last,
            'Check that the vault’s worker is running: on the server, run docker compose ps, and docker compose logs worker to see why.',
            'Settings → System health shows when it’s fixed. You won’t be told again until a backup is made.',
          ].join(' '),
        });
      }
      if (facts.checked_at !== null && facts.checked_ok === false) {
        problems.push({
          about: 'audit_chain',
          fineAt: facts.checked_ok_at,
          subject: 'Your vault’s activity log failed its check',
          body: [
            `The nightly check on ${day(facts.checked_at)} found a line of the activity log changed or missing.`,
            ...(deps.backups
              ? [
                  'Someone may have changed the vault’s database directly, outside the app.',
                  'Restore a backup from before then, or ask whoever helps you run the vault.',
                ]
              : ['Contact whoever runs your vault.']),
            'Settings → System health shows the latest check. You won’t be told again until a check passes.',
          ].join(' '),
        });
      }
      let sent = 0;
      for (const p of problems) {
        const last = await sql<{ at: Date }>`
          select at from audit_event
           where household_id = ${hh} and action = ${HEALTH_EVENTS.ownersTold}
             and detail->>'about' = ${p.about}
           order by id desc limit 1`.execute(trx);
        const toldAt = last.rows[0]?.at ?? null;
        if (toldAt && (p.fineAt === null || toldAt > p.fineAt)) continue;
        const owners = (
          await trx
            .selectFrom('account_household')
            .select('account_id')
            .where('household_id', '=', hh)
            .where('role', '=', 'owner')
            .execute()
        ).map((o) => o.account_id);
        if (owners.length === 0) continue;
        // Told and noted in one transaction: the email goes once, or not at all.
        await appendAudit(trx, {
          householdId: hh,
          action: HEALTH_EVENTS.ownersTold,
          objectType: 'household',
          objectId: hh,
          detail: { about: p.about },
        });
        await deps.tell(
          { household_id: hh, account_ids: owners, subject: p.subject, body: p.body },
          queueDbOf(trx),
        );
        sent += 1;
      }
      return sent;
    });
  }
  return told;
}

/**
 * Whether a job is on its last try (pg-boss's retry count against its
 * limit): a backup that fails and is tried again is said only once no try
 * is left, so one that a retry makes is never told.
 */
export const lastTry = (job: { retryCount?: number; retryLimit?: number } | undefined): boolean =>
  job?.retryCount === undefined || job.retryLimit === undefined || job.retryCount >= job.retryLimit;
