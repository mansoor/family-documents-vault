import { withPrincipal, type Db } from '@fdv/db';
import {
  localAiTestResult,
  mailInTestResult,
  type LocalAiTestFound,
  SETTINGS_CHECK_LATE_MS,
  SETTINGS_CHECK_LATE_WORDS,
  SETTINGS_CHECKS_PER_MINUTE,
  watchVerifyResult,
  type MailInTestFound,
  type SettingsCheckKind,
  type SettingsCheckView,
  type WatchBrowseResult,
  type WatchVerifyFound,
} from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from './auth/service.js';
import type { Enqueue } from './documents/service.js';
import { ApiError } from './errors.js';

/**
 * What an owner asks the worker from Settings (0.9.0, O1): Verify a
 * scanner folder, the folders inside one, or Test the mailbox. The worker
 * alone has the folders mounted into it and the mailbox's password, so the
 * API writes the question (settings_check, the owners' alone in the
 * database) and puts a job on the queue; the worker answers into the same
 * row, and the page asks for it (GET /settings-checks/{id}) until it is
 * there — or, after SETTINGS_CHECK_LATE_MS, says the worker has not answered.
 */

/** The worker's job (apps/worker/src/queue.ts JOBS.settingsCheck): the names match. */
export const SETTINGS_CHECK_JOB = 'settings.check';

const ownersOnly = () =>
  new ApiError(403, 'forbidden', 'Only an owner can check the scanner folder or the mailbox.');
const noCheck = () => new ApiError(404, 'not_found', 'That check is not here.');
const tooMany = () =>
  new ApiError(429, 'rate_limited', 'That was asked for many times just now. Wait a minute.', {
    retriable: true,
    retryAfter: 60,
  });

const underWay = (what: 'mailbox' | 'local_ai') =>
  new ApiError(
    429,
    'rate_limited',
    `${what === 'mailbox' ? 'The mailbox' : 'The local AI'} is being tested now. Wait for its answer, then test it again.`,
    { retriable: true, retryAfter: 15 },
  );

/** How long a Test of the local AI not yet answered holds the next one off (R4): its own time, and more. */
export const LOCAL_AI_TEST_HOLD_MS = 60_000;

/** How long a Test the mailbox not yet answered holds the next one off (the O1 review, L6). */
export const MAILBOX_TEST_HOLD_MS = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SettingsCheckService {
  constructor(
    private readonly db: Db,
    private readonly enqueue: Enqueue,
    /** The clock, for the tests. */
    private readonly now: () => number = Date.now,
  ) {}

  /** A question for the worker, asked as an owner: its row, and the job. */
  async ask(
    p: Principal,
    kind: SettingsCheckKind,
    path: string | null,
  ): Promise<SettingsCheckView> {
    if (p.role !== 'owner') throw ownersOnly();
    const row = await withPrincipal(this.db, p, async (trx) => {
      const recent = await trx
        .selectFrom('settings_check')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('requested_at', '>', new Date(this.now() - 60_000))
        .executeTakeFirstOrThrow();
      if (Number(recent.n) >= SETTINGS_CHECKS_PER_MINUTE) throw tooMany();
      if (kind === 'mailbox' || kind === 'local_ai') {
        // One test of the mailbox at a time: each signs in to it. And of the
        // local AI (R4): each asks the model.
        const running = await trx
          .selectFrom('settings_check')
          .select('id')
          .where('kind', '=', kind)
          .where('done_at', 'is', null)
          .where(
            'requested_at',
            '>',
            new Date(
              this.now() - (kind === 'mailbox' ? MAILBOX_TEST_HOLD_MS : LOCAL_AI_TEST_HOLD_MS),
            ),
          )
          .executeTakeFirst();
        if (running) throw underWay(kind);
      }
      return trx
        .insertInto('settings_check')
        .values({ household_id: p.householdId, kind, path, requested_by: p.accountId })
        .returning(['id', 'kind', 'requested_at', 'done_at', 'result'])
        .executeTakeFirstOrThrow();
    });
    await this.enqueue(SETTINGS_CHECK_JOB, { household_id: p.householdId, check_id: row.id });
    return this.viewOf(row, null);
  }

  /** GET /settings-checks/{id}: one of the household's, as the worker answered it — an owner's. */
  async get(p: Principal, id: string, folder: string | null = null): Promise<SettingsCheckView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (!UUID.test(id)) throw noCheck();
    const row = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('settings_check')
        .select(['id', 'kind', 'requested_at', 'done_at', 'result'])
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (!row) throw noCheck();
    let mailFolder = folder;
    if (row.kind === 'mailbox' && mailFolder === null) {
      mailFolder = await withPrincipal(this.db, p, async (trx) => {
        const own = await trx.selectFrom('mail_in_mailbox').select('folder').executeTakeFirst();
        if (own) return own.folder;
        const server = await this.db
          .selectFrom('mail_in_server')
          .select('folder')
          .executeTakeFirst();
        return server?.folder ?? null;
      });
    }
    return this.viewOf(row, mailFolder);
  }

  private viewOf(
    row: {
      id: string;
      kind: SettingsCheckKind;
      requested_at: Date;
      done_at: Date | null;
      result: Record<string, unknown> | null;
    },
    mailFolder: string | null,
  ): SettingsCheckView {
    const base = {
      id: row.id,
      kind: row.kind,
      requested_at: row.requested_at.toISOString(),
    };
    if (!row.done_at || !row.result) {
      const late = this.now() - row.requested_at.getTime() > SETTINGS_CHECK_LATE_MS;
      return {
        ...base,
        state: late ? 'late' : 'waiting',
        words: late ? SETTINGS_CHECK_LATE_WORDS : null,
      };
    }
    const r = row.result;
    switch (row.kind) {
      case 'folder':
        return {
          ...base,
          state: 'done',
          folder: watchVerifyResult(r as unknown as WatchVerifyFound),
          words: null,
        };
      case 'browse':
        return { ...base, state: 'done', browse: r as unknown as WatchBrowseResult, words: null };
      case 'mailbox':
        return {
          ...base,
          state: 'done',
          mailbox: mailInTestResult(r as unknown as MailInTestFound, mailFolder),
          words: null,
        };
      case 'local_ai':
        // Test the local AI (R4): the model, the host and how long.
        return {
          ...base,
          state: 'done',
          local_ai: localAiTestResult(localAiFound(r)),
          words: null,
        };
    }
  }
}

const PROBLEMS = ['not_set_up', 'unreachable', 'timeout', 'no_model', 'http_error', 'too_big'];

/** What the worker wrote of a Test of the local AI, each field kept only if well formed. */
function localAiFound(r: Record<string, unknown>): LocalAiTestFound {
  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
  return {
    problem:
      typeof r.problem === 'string' && PROBLEMS.includes(r.problem)
        ? (r.problem as LocalAiTestFound['problem'])
        : null,
    model: str(r.model, 200),
    host: str(r.host, 300),
    latency_ms:
      typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms) && r.latency_ms >= 0
        ? Math.round(r.latency_ms)
        : null,
  };
}

/** GET /settings-checks/{id}: an owner's; anybody else is refused before anything is read. */
export function registerSettingsChecks(app: FastifyInstance, checks: SettingsCheckService): void {
  const owners = {
    preHandler: [
      app.requireAuth,
      async (req: FastifyRequest) => {
        if (req.principal && req.principal.role !== 'owner') throw ownersOnly();
      },
    ],
  };
  app.get<{ Params: { id: string } }>('/api/v1/settings-checks/:id', owners, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return checks.get(req.principal as Principal, req.params.id);
  });
}
