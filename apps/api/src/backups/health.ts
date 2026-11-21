import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withPrincipal, type Db } from '@fdv/db';
import {
  AUDIT_CHECK_LATE_DAYS,
  BACKUP_LATE_DAYS,
  DRILL_DUE_DAYS,
  HEALTH_EVENTS,
  OFFSITE_LATE_DAYS,
  SIGN_IN_FAILURES_MANY,
  type Edition,
  type OffsiteProblem,
  type SecurityHealthView,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';

/**
 * Settings → Security & health (0.9.0), an owner's: the last backup and its
 * copy off-site, the last restore drill, the activity log's last check,
 * and the day's failed sign-ins and sign-ins used from two places — all
 * read from what the vault already keeps (its activity log, the off-site
 * copy's setting), nothing new collected. Reading it asks no passkey or
 * code: it changes nothing.
 */

const ownersOnly = () =>
  new ApiError(403, 'forbidden', 'Only an owner can see the vault’s security and health.');

const DAY = 24 * 3600_000;

export interface SecurityHealthDeps {
  edition: Edition;
  /** FDV_BACKUP_LATE_DAYS: a backup older than this is late (BACKUP_LATE_DAYS: nightly). */
  lateDays?: number;
  /** FDV_BACKUP_OFFSITE_LATE_DAYS: the off-site copy's own, as Settings → Backups says it. */
  offsiteLateDays?: number;
  now?: () => Date;
}

interface Facts {
  created_at: Date;
  installation: boolean;
  made_at: Date | null;
  failed_at: Date | null;
  drill_at: Date | null;
  drill_ok: boolean | null;
  checked_at: Date | null;
  checked_ok: boolean | null;
  sign_in_failures: number;
  reuse: number;
  offsite_enabled: boolean | null;
  offsite_enabled_at: Date | null;
  offsite_last_copy_at: Date | null;
  offsite_last_result: 'ok' | 'failed' | null;
  offsite_last_attempt_at: Date | null;
  offsite_last_problem: string | null;
}

export class SecurityHealthService {
  private readonly now: () => Date;
  private readonly lateDays: number;
  private readonly offsiteLateDays: number;

  constructor(
    private readonly db: Db,
    private readonly deps: SecurityHealthDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.lateDays = deps.lateDays ?? BACKUP_LATE_DAYS;
    this.offsiteLateDays = deps.offsiteLateDays ?? OFFSITE_LATE_DAYS;
  }

  /** GET /household/health. */
  async get(p: Principal): Promise<SecurityHealthView> {
    if (p.role !== 'owner') throw ownersOnly();
    const hosted = this.deps.edition === 'hosted';
    const facts = await withPrincipal(this.db, p, async (trx) => {
      const hh = p.householdId;
      // The household's newest line of a kind, found by the log's index
      // (household, action, id: 0125).
      const newest = (action: string, alias: string) => sql`left join lateral (
          select e.at, e.detail from audit_event e
           where e.household_id = ${hh} and e.action = ${action}
           order by e.id desc limit 1) ${sql.raw(alias)} on true`;
      const none = (alias: string) =>
        sql`left join lateral (select null::timestamptz as at, null::jsonb as detail) ${sql.raw(alias)} on true`;
      // The server's lines — its backups and drill — are the installation's
      // own household's alone, and nobody's on the hosted edition: asked
      // for only there.
      const server = hosted
        ? false
        : ((await sql<{ yes: boolean }>`select app_is_installation_household() as yes`.execute(trx))
            .rows[0]?.yes ?? false);
      const r = await sql<Omit<Facts, 'installation'>>`
        with bound as (
          -- The last line before the day began: the day's are the lines
          -- after it, counted by (household, action, id).
          select coalesce((select id from audit_event
                            where household_id = ${hh} and at <= now() - interval '24 hours'
                            order by id desc limit 1), 0) as id)
        select h.created_at,
               m.at as made_at, f.at as failed_at,
               d.at as drill_at, (d.detail->>'ok') = 'true' as drill_ok,
               c.at as checked_at, (c.detail->>'ok') = 'true' as checked_ok,
               (select count(*)::int from audit_event
                 where household_id = ${hh} and action = 'auth.sign_in_failed'
                   and id > (select id from bound)
                   and at > now() - interval '24 hours') as sign_in_failures,
               (select count(*)::int from audit_event
                 where household_id = ${hh} and action = 'auth.session_revoked'
                   and id > (select id from bound)
                   and at > now() - interval '24 hours'
                   and detail->>'reason' = 'refresh token reuse') as reuse,
               o.enabled as offsite_enabled, o.enabled_at as offsite_enabled_at,
               o.last_copy_at as offsite_last_copy_at, o.last_result as offsite_last_result,
               o.last_attempt_at as offsite_last_attempt_at,
               o.last_problem as offsite_last_problem
          from household h
          ${server ? newest(HEALTH_EVENTS.backupMade, 'm') : none('m')}
          ${server ? newest(HEALTH_EVENTS.backupFailed, 'f') : none('f')}
          ${server ? newest(HEALTH_EVENTS.restoreDrilled, 'd') : none('d')}
          ${newest(HEALTH_EVENTS.auditChecked, 'c')}
          left join backup_offsite o on ${server ? sql`o.household_id = h.id` : sql`false`}
         where h.id = ${hh}`.execute(trx);
      const row = r.rows[0];
      return row ? { ...row, installation: server } : undefined;
    });
    if (!facts) throw ownersOnly();
    return this.view(facts, hosted);
  }

  private view(f: Facts, hosted: boolean): SecurityHealthView {
    const now = this.now().getTime();
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    const older = (d: Date, days: number) => now - d.getTime() > days * DAY;
    const server = f.installation;

    let backup: SecurityHealthView['backup'] = null;
    if (server) {
      const failedLast = f.failed_at !== null && (f.made_at === null || f.failed_at > f.made_at);
      backup = {
        // Late from the last backup; with none yet, from the day the vault
        // was set up: its first nightly backup lands within a day.
        state: failedLast
          ? 'failed'
          : older(f.made_at ?? f.created_at, this.lateDays)
            ? 'late'
            : f.made_at
              ? 'fine'
              : 'not_yet',
        last_at: iso(f.made_at),
      };
    }

    let offsite: SecurityHealthView['offsite'] = null;
    if (server && f.offsite_enabled !== null) {
      // As Settings → Backups says it: a failure since it was turned on,
      // or nothing gone for its late days since the last copy or turning on.
      const since = [f.offsite_last_copy_at, f.offsite_enabled_at]
        .filter((d): d is Date => d instanceof Date)
        .reduce<Date | null>((a, d) => (a && a > d ? a : d), null);
      const failed =
        f.offsite_last_result === 'failed' &&
        f.offsite_last_attempt_at !== null &&
        (f.offsite_enabled_at === null || f.offsite_last_attempt_at >= f.offsite_enabled_at);
      offsite = {
        state: !f.offsite_enabled
          ? 'off'
          : failed
            ? 'failed'
            : since !== null && older(since, this.offsiteLateDays)
              ? 'late'
              : 'fine',
        last_at: iso(f.offsite_last_copy_at),
        problem: failed ? ((f.offsite_last_problem as OffsiteProblem | null) ?? 'unknown') : null,
      };
    }

    const restore_drill: SecurityHealthView['restore_drill'] = !server
      ? null
      : {
          state:
            f.drill_at === null
              ? 'never'
              : f.drill_ok !== true
                ? 'failed'
                : older(f.drill_at, DRILL_DUE_DAYS)
                  ? 'due'
                  : 'fine',
          last_at: iso(f.drill_at),
        };

    // Never checked says nothing wrong: it is checked each night.
    const audit_chain: SecurityHealthView['audit_chain'] = {
      state:
        f.checked_at === null
          ? 'not_yet'
          : f.checked_ok !== true
            ? 'broken'
            : older(f.checked_at, AUDIT_CHECK_LATE_DAYS)
              ? 'late'
              : 'fine',
      last_at: iso(f.checked_at),
    };

    return {
      hosted,
      backup,
      offsite,
      restore_drill,
      audit_chain,
      failed_sign_ins: {
        state: f.sign_in_failures >= SIGN_IN_FAILURES_MANY ? 'many' : 'fine',
        count: f.sign_in_failures,
      },
      token_reuse: { state: f.reuse > 0 ? 'seen' : 'fine', count: f.reuse },
    };
  }
}

/** GET /api/v1/household/health: an owner's; nobody else is told any of it. */
export function registerSecurityHealth(app: FastifyInstance, health: SecurityHealthService): void {
  app.get(
    '/api/v1/household/health',
    {
      preHandler: [
        app.requireAuth,
        async (req: FastifyRequest) => {
          if (req.principal && req.principal.role !== 'owner') throw ownersOnly();
        },
      ],
    },
    async (req, reply) => {
      void reply.headers({ 'cache-control': 'no-store' });
      return health.get(req.principal as Principal);
    },
  );
}
