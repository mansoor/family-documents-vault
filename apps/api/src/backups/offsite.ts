import type { FastifyInstance, FastifyRequest } from 'fastify';
import { openBackupOffsiteSecret, sealBackupOffsiteSecret } from '@fdv/crypto';
import { appendAudit, withPrincipal, withSystem, type Db } from '@fdv/db';
import {
  OFFSITE_LATE_DAYS,
  OFFSITE_RETAIN_DEFAULT,
  OFFSITE_RETAIN_MAX,
  OFFSITE_RETAIN_MIN,
  offsiteProblemWords,
  type Edition,
  type OffsiteInput,
  type OffsiteProblem,
  type OffsiteSettings,
  type OffsiteTestResult,
  type OffsiteView,
} from '@fdv/shared';
import { OffsiteError, testOffsite, type OffsiteBucket, type OffsiteTestFound } from '@fdv/storage';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import type { AlertRequest } from '../alert-job.js';
import { ApiError } from '../errors.js';

/**
 * Settings → Backups (0.9.0-dev.76): an off-site copy of the nightly
 * backups, to a bucket on any S3-compatible service an owner names. The
 * API keeps the setting, seals its secret key, and sends a test; the worker
 * copies each backup there (apps/worker/src/jobs/backup-offsite.ts). An
 * owner's alone, as the database's own rule says too.
 */

const ownersOnly = () =>
  new ApiError(403, 'forbidden', 'Only an owner can set up where backups are copied.');
const bad = (words: string) => new ApiError(422, 'validation_failed', words);

/** What a row holds, as the service reads it. */
type Row = {
  household_id: string;
  endpoint: string | null;
  region: string | null;
  bucket: string;
  prefix: string | null;
  path_style: boolean;
  access_key_id: string;
  secret_encrypted: Buffer | null;
  retain_count: number;
  enabled: boolean;
  enabled_at: Date | null;
  status: 'untested' | 'ok' | 'failed';
  last_tested_at: Date | null;
  test_problem: string | null;
  can_delete: boolean | null;
  last_attempt_at: Date | null;
  last_copy_at: Date | null;
  last_copy_object: string | null;
  last_copy_bytes: string | null;
  last_result: 'ok' | 'failed' | null;
  last_problem: string | null;
};

export interface BackupOffsiteDeps {
  /** deriveKey(master, BACKUP_OFFSITE_KEY_PURPOSE). */
  key: Buffer;
  edition: Edition;
  /** Writes a small file there and deletes it: testOffsite, unless a test says otherwise. */
  test?: (b: OffsiteBucket) => Promise<OffsiteTestFound>;
  /**
   * FDV_BACKUP_OFFSITE_LATE_DAYS: a copy older than this, while on, is late
   * (OFFSITE_LATE_DAYS unless said: it assumes nightly backups).
   */
  lateDays?: number;
  /** The owners told (the alert job): the copies kept there lowered while it is on. */
  alert?: (a: AlertRequest) => Promise<void>;
  now?: () => Date;
}

/** An address as it is kept: scheme://host[:port], nothing else; or null for Amazon S3. */
export function offsiteEndpoint(typed: string | null | undefined): string | null {
  const t = (typed ?? '').trim();
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw bad('Enter the address as your provider gives it, such as https://s3.example.com.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw bad('The address starts with https:// (or http:// for a server on your own network).');
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) {
    throw bad(
      'Enter the address alone, such as https://s3.example.com — no bucket, folder or sign-in in it.',
    );
  }
  const out = `${u.protocol}//${u.host}`;
  if (out.length > 300) throw bad('That address is too long.');
  return out;
}

/** A prefix as it is kept: names joined by '/', none of them . or .., or null for none. */
export function offsitePrefix(typed: string | null | undefined): string | null {
  const t = (typed ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!t) return null;
  const parts = t.split('/');
  if (
    t.length > 200 ||
    parts.some((p) => p === '' || p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))
  ) {
    throw bad(
      'The folder may use letters, numbers, dots, dashes and underscores, with / between folders.',
    );
  }
  return t;
}

export class BackupOffsiteService {
  private readonly test_: (b: OffsiteBucket) => Promise<OffsiteTestFound>;
  private readonly now: () => Date;
  private readonly lateDays: number;
  private readonly alert: (a: AlertRequest) => Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly deps: BackupOffsiteDeps,
  ) {
    this.test_ = deps.test ?? testOffsite;
    this.now = deps.now ?? (() => new Date());
    this.lateDays = deps.lateDays ?? OFFSITE_LATE_DAYS;
    this.alert = deps.alert ?? (async () => undefined);
  }

  private gate(p: Principal): void {
    if (p.role !== 'owner') throw ownersOnly();
    if (this.deps.edition === 'hosted') {
      throw new ApiError(
        403,
        'offsite_not_here',
        'This vault’s backups are kept by whoever runs it, so they are not copied from here.',
      );
    }
  }

  private async row(trx: Db): Promise<Row | undefined> {
    return await trx.selectFrom('backup_offsite').selectAll().executeTakeFirst();
  }

  private settings(r: Row): OffsiteSettings {
    const since = [r.last_copy_at, r.enabled_at]
      .filter((d): d is Date => d instanceof Date)
      .reduce<Date | null>((a, d) => (a && a > d ? a : d), null);
    const late =
      r.enabled &&
      since !== null &&
      this.now().getTime() - since.getTime() > this.lateDays * 24 * 3600_000;
    return {
      endpoint: r.endpoint,
      region: r.region,
      bucket: r.bucket,
      prefix: r.prefix,
      path_style: r.path_style,
      access_key_id: r.access_key_id,
      secret_access_key: r.secret_encrypted ? 'set' : 'not_set',
      retain_count: r.retain_count,
      enabled: r.enabled,
      status: r.status,
      last_tested_at: r.last_tested_at?.toISOString() ?? null,
      test_problem: (r.test_problem as OffsiteProblem | null) ?? null,
      can_delete: r.can_delete,
      last_attempt_at: r.last_attempt_at?.toISOString() ?? null,
      last_copy_at: r.last_copy_at?.toISOString() ?? null,
      last_copy_object: r.last_copy_object,
      last_copy_bytes: r.last_copy_bytes === null ? null : Number(r.last_copy_bytes),
      last_result: r.last_result,
      last_problem: (r.last_problem as OffsiteProblem | null) ?? null,
      late,
    };
  }

  private view(r: Row | undefined): OffsiteView {
    return {
      available: this.deps.edition !== 'hosted',
      settings: r ? this.settings(r) : null,
      covers: 'database',
    };
  }

  /** GET /backups/offsite. */
  async get(p: Principal): Promise<OffsiteView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (this.deps.edition === 'hosted') return this.view(undefined);
    return withPrincipal(this.db, p, async (trx) => this.view(await this.row(trx)));
  }

  /**
   * PUT /backups/offsite: saved, and — when anything that reaches the bucket
   * changed — untested and off until a test passes. The secret left out
   * keeps the one set, unless the address, bucket or access key changed.
   */
  async put(p: Principal, input: OffsiteInput, meta: RequestMeta): Promise<OffsiteView> {
    this.gate(p);
    const endpoint = offsiteEndpoint(input.endpoint);
    const region = (input.region ?? '').trim() || null;
    if (region !== null && !/^[A-Za-z0-9-]{1,64}$/.test(region)) {
      throw bad('The region is a short name, such as us-east-1.');
    }
    if (endpoint === null && region === null) {
      throw bad('For Amazon S3, enter the bucket’s region, such as eu-west-2.');
    }
    const bucket = input.bucket.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(bucket)) {
      throw bad('Enter the bucket’s name as your provider shows it.');
    }
    const prefix = offsitePrefix(input.prefix);
    const accessKeyId = input.access_key_id.trim();
    if (!/^[!-~]{1,128}$/.test(accessKeyId)) {
      throw bad('Enter the access key ID as your provider shows it.');
    }
    const pathStyle = input.path_style ?? endpoint !== null;
    const secret = input.secret_access_key?.trim() || undefined;

    const saved = await withPrincipal(this.db, p, async (trx) => {
      const old = await this.row(trx);
      const retain = input.retain_count ?? old?.retain_count ?? OFFSITE_RETAIN_DEFAULT;
      if (!Number.isInteger(retain) || retain < OFFSITE_RETAIN_MIN || retain > OFFSITE_RETAIN_MAX) {
        throw bad(`Keep between ${OFFSITE_RETAIN_MIN} and ${OFFSITE_RETAIN_MAX} copies off-site.`);
      }
      const sameTarget =
        old !== undefined &&
        old.endpoint === endpoint &&
        old.bucket === bucket &&
        old.access_key_id === accessKeyId;
      let sealed: Buffer;
      if (secret !== undefined) {
        sealed = sealBackupOffsiteSecret(this.deps.key, secret, p.householdId, {
          endpoint,
          bucket,
          accessKeyId,
        });
      } else if (sameTarget && old.secret_encrypted) {
        sealed = old.secret_encrypted;
      } else {
        throw new ApiError(
          422,
          'offsite_secret_needed',
          'Enter the secret key: the vault keeps one only for the address, bucket and access key it was given with.',
        );
      }
      const changed =
        old === undefined ||
        secret !== undefined ||
        old.endpoint !== endpoint ||
        old.region !== region ||
        old.bucket !== bucket ||
        old.prefix !== prefix ||
        old.path_style !== pathStyle ||
        old.access_key_id !== accessKeyId;
      const values = {
        endpoint,
        region,
        bucket,
        prefix,
        path_style: pathStyle,
        access_key_id: accessKeyId,
        secret_encrypted: sealed,
        retain_count: retain,
        updated_by: p.accountId,
        updated_at: this.now(),
        // A new bucket, key or secret waits for a test of its own, and is
        // never copied to before one.
        ...(changed
          ? {
              status: 'untested' as const,
              last_tested_at: null,
              test_problem: null,
              can_delete: null,
              enabled: false,
              enabled_at: null,
            }
          : {}),
      };
      if (old) {
        await trx.updateTable('backup_offsite').set(values).execute();
      } else {
        await trx
          .insertInto('backup_offsite')
          .values({ household_id: p.householdId, ...values })
          .execute();
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'backup.offsite_saved',
        objectType: 'household',
        objectId: p.householdId,
        // Whether it must be tested again, and how many are kept: never the
        // address, the bucket or a key.
        detail: { changed, retain_count: retain, turned_off: changed && old?.enabled === true },
        ip: meta.ip,
      });
      // Fewer copies kept while the copy is on: the other owners told, once
      // for each change — fewer copies off the machine is less to restore
      // from, and one way to make the copies useless quietly.
      const lowered =
        old?.enabled === true && !changed && retain < old.retain_count
          ? { was: old.retain_count, now: retain }
          : null;
      const others = lowered
        ? (
            await trx
              .selectFrom('account_household')
              .select('account_id')
              .where('role', '=', 'owner')
              .where('account_id', '<>', p.accountId)
              .execute()
          ).map((o) => o.account_id)
        : [];
      const me = lowered
        ? await trx
            .selectFrom('member')
            .select('display_name')
            .where('id', '=', p.memberId)
            .executeTakeFirst()
        : undefined;
      return { view: this.view(await this.row(trx)), lowered, others, who: me?.display_name };
    });
    if (saved.lowered && saved.others.length > 0) {
      await this.alert({
        householdId: p.householdId,
        accountIds: saved.others,
        emailOnly: true,
        subject: 'Fewer backups are kept off-site now',
        body: `${saved.who ?? 'An owner'} changed Settings → Backups to keep ${saved.lowered.now} off-site ${saved.lowered.now === 1 ? 'copy' : 'copies'} of the backups, down from ${saved.lowered.was}. Older copies there are removed after the next backup. If that is a surprise, ask them about it, and change it back in Settings → Backups.`,
      });
    }
    return saved.view;
  }

  /**
   * POST /backups/offsite/test: a small file written under the prefix,
   * listed and deleted again. It must pass before the copy is turned on.
   */
  async test(p: Principal, meta: RequestMeta): Promise<OffsiteTestResult> {
    this.gate(p);
    const r = await withPrincipal(this.db, p, (trx) => this.row(trx));
    if (!r || !r.secret_encrypted) {
      throw new ApiError(409, 'offsite_not_set_up', 'Save the bucket’s details first.');
    }
    let problem: OffsiteProblem | null = null;
    let secret: string | null = null;
    let found: OffsiteTestFound | null = null;
    try {
      secret = openBackupOffsiteSecret(this.deps.key, r.secret_encrypted, p.householdId, {
        endpoint: r.endpoint,
        bucket: r.bucket,
        accessKeyId: r.access_key_id,
      });
    } catch {
      problem = 'secret_unopened';
    }
    if (secret !== null) {
      try {
        found = await this.test_({
          endpoint: r.endpoint,
          region: r.region,
          bucket: r.bucket,
          prefix: r.prefix,
          pathStyle: r.path_style,
          accessKeyId: r.access_key_id,
          secretAccessKey: secret,
        });
      } catch (err) {
        problem = err instanceof OffsiteError ? err.problem : 'unknown';
      }
    }
    const ok = problem === null;
    await withSystem(this.db, p.householdId, async (trx) => {
      // What was tested, and nothing changed since: a bucket, key or secret
      // saved meanwhile waits for a test of its own. A copy already on is
      // not turned off by a test that failed (a moment's outage would stop
      // the nightly copies): the answer says why, and the worker's own
      // failures tell the owners if it lasts.
      if (ok || !r.enabled) await this.markTested(trx, r, problem, found);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'backup.offsite_tested',
        objectType: 'household',
        objectId: p.householdId,
        detail: { ok, ...(problem ? { problem } : {}) },
        ip: meta.ip,
      });
    });
    return {
      ok,
      problem,
      words: !ok
        ? offsiteProblemWords(problem)
        : found?.canDelete === false
          ? 'The test went, but this key can’t delete, so the vault will not remove old copies there: set a lifecycle rule on the bucket to remove them after a while. You can turn the copy on.'
          : 'The test went: the vault wrote a small file there and deleted it again. You can turn the copy on.',
      view: await this.get(p),
    };
  }

  private async markTested(
    trx: Db,
    r: Row,
    problem: OffsiteProblem | null,
    found: OffsiteTestFound | null,
  ): Promise<void> {
    let q = trx.updateTable('backup_offsite').set(
      found && problem === null
        ? {
            status: 'ok',
            last_tested_at: this.now(),
            test_problem: null,
            can_delete: found.canDelete,
          }
        : {
            status: 'failed',
            last_tested_at: this.now(),
            // A reason of the worker's is never a test's.
            test_problem:
              problem === 'several_households' || problem === 'secret_unopened'
                ? 'unknown'
                : problem,
            can_delete: null,
          },
    );
    // A failure is written only while off: turned on meanwhile, the copy
    // stays on (and the database would refuse an on copy that failed).
    if (!(found && problem === null)) q = q.where('enabled', '=', false);
    await q
      .where('endpoint', 'is not distinct from', r.endpoint)
      .where('region', 'is not distinct from', r.region)
      .where('bucket', '=', r.bucket)
      .where('prefix', 'is not distinct from', r.prefix)
      .where('path_style', '=', r.path_style)
      .where('access_key_id', '=', r.access_key_id)
      .where('secret_encrypted', '=', r.secret_encrypted)
      .execute();
  }

  /** PUT /backups/offsite/enabled: on only once a test of what is saved passed. */
  async setEnabled(p: Principal, enabled: boolean, meta: RequestMeta): Promise<OffsiteView> {
    this.gate(p);
    return withPrincipal(this.db, p, async (trx) => {
      const r = await this.row(trx);
      if (!r) throw new ApiError(409, 'offsite_not_set_up', 'Save the bucket’s details first.');
      if (enabled && r.status !== 'ok') {
        throw new ApiError(
          409,
          'offsite_untested',
          'Send a test first. Backups are only copied somewhere that has passed a test.',
        );
      }
      if (r.enabled !== enabled) {
        await trx
          .updateTable('backup_offsite')
          .set({
            enabled,
            enabled_at: enabled ? this.now() : r.enabled_at,
            updated_by: p.accountId,
            updated_at: this.now(),
          })
          .execute();
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'backup.offsite_changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: { enabled },
          ip: meta.ip,
        });
      }
      return this.view(await this.row(trx));
    });
  }

  /** DELETE /backups/offsite: the bucket forgotten, secret and all. Copies already there stay. */
  async remove(p: Principal, meta: RequestMeta): Promise<OffsiteView> {
    this.gate(p);
    return withPrincipal(this.db, p, async (trx) => {
      const gone = await trx.deleteFrom('backup_offsite').executeTakeFirst();
      if (Number(gone.numDeletedRows) > 0) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'backup.offsite_removed',
          objectType: 'household',
          objectId: p.householdId,
          ip: meta.ip,
        });
      }
      return this.view(undefined);
    });
  }
}

/**
 * GET, PUT and DELETE /backups/offsite, PUT /backups/offsite/enabled and
 * POST /backups/offsite/test. An owner's alone: anybody else is refused
 * before their body is read. A change asks for a passkey or a code
 * (`change_backups`); a test sends only to what is saved.
 */
export function registerBackupOffsite(
  app: FastifyInstance,
  offsite: BackupOffsiteService,
  stepUp?: StepUpService,
): void {
  const owners = {
    preHandler: [
      app.requireAuth,
      async (req: FastifyRequest) => {
        if (req.principal && req.principal.role !== 'owner') throw ownersOnly();
      },
    ],
  };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const noStore = { 'cache-control': 'no-store' };

  app.get('/api/v1/backups/offsite', owners, async (req, reply) => {
    void reply.headers(noStore);
    return offsite.get(principal(req));
  });

  app.put('/api/v1/backups/offsite', owners, async (req, reply) => {
    const body = parse(
      z
        .object({
          endpoint: z.string().max(2048).nullable().optional(),
          region: z.string().max(64).nullable().optional(),
          bucket: z.string().min(1).max(255),
          prefix: z.string().max(255).nullable().optional(),
          path_style: z.boolean().optional(),
          access_key_id: z.string().min(1).max(256),
          secret_access_key: z.string().min(1).max(1024).optional(),
          retain_count: z.number().int().optional(),
        })
        .strict(),
      req.body,
    );
    await stepUp?.requireOwnerPower(principal(req), 'change_backups');
    void reply.headers(noStore);
    return offsite.put(principal(req), body, metaOf(req));
  });

  app.put('/api/v1/backups/offsite/enabled', owners, async (req, reply) => {
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    await stepUp?.requireOwnerPower(principal(req), 'change_backups');
    void reply.headers(noStore);
    return offsite.setEnabled(principal(req), body.enabled, metaOf(req));
  });

  app.delete('/api/v1/backups/offsite', owners, async (req, reply) => {
    await stepUp?.requireOwnerPower(principal(req), 'change_backups');
    void reply.headers(noStore);
    return offsite.remove(principal(req), metaOf(req));
  });

  app.post(
    '/api/v1/backups/offsite/test',
    { ...owners, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      void reply.headers(noStore);
      return offsite.test(principal(req), metaOf(req));
    },
  );
}
