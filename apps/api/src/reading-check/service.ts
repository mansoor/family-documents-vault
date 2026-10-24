import { openBytes, readingMissesBinding, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  numbersOnly,
  READING_CHECK_N,
  READING_MODEL_STALE_MS,
  type ReadingCheckDetail,
  type ReadingCheckFailure,
  type ReadingCheckInput,
  type ReadingCheckOther,
  type ReadingCheckState,
  type ReadingCheckSummary,
  type ReadingCheckView,
  type ReadingChecksList,
  type ReadingMiss,
  type ReadingMissView,
  type ReadingSettings,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { seenDocument, type Enqueue } from '../documents/service.js';
import { ApiError } from '../errors.js';

/**
 * The Reading check (0.9.0, R0): an owner's measure of the reader on the
 * family's own papers (@fdv/shared reading-check.ts; the worker's
 * jobs/reading-check.ts reads them).
 *
 * An owner's alone: anybody else is refused before anything is read. And a
 * check is its asker's alone (the owner's decision, R0 review), here and in
 * the database (0074's reading_check_actor asks the member): its numbers —
 * numbers only, held so by the database and again here — and its misses.
 * Another owner is told only whose checks there are and the state of each
 * — not when, nor anything it found (reading_checks_of_others()), since
 * one runs at a time (the database's unique index: 409
 * reading_check_running); they can neither read, cancel nor remove it (404).
 * The documents that needed typing, and what, are given only for documents
 * the asker can still see, and only for seven days. Nothing here reads a
 * document's words or details.
 */

/** The job's name: the worker's READING_CHECK_JOB. */
export const READING_CHECK_JOB = 'reading.check';
/** One queued and one running a check (the R0 review, R-1): the worker's readingCheckKey. */
export const readingCheckKey = (checkId: string) => `reading-check:${checkId}`;
/** Below every other job: the worker's READING_CHECK_PRIORITY. */
export const READING_CHECK_PRIORITY = -10;
/** The checks a household keeps: the newest, the rest let go as a new one starts. */
export const READING_CHECKS_KEPT = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An owner's: anybody else is refused (403). */
export function ownerOnly(p: Principal): void {
  if (p.role !== 'owner') {
    throw new ApiError(403, 'forbidden', 'Only an owner can run the Reading check.');
  }
}
const notFound = () => new ApiError(404, 'not_found', 'That check is not here.');
const running = () =>
  new ApiError(
    409,
    'reading_check_running',
    'A Reading check is already running for your household. Wait for it to finish, or cancel it.',
  );
const notStarted = () =>
  new ApiError(
    503,
    'reading_check_not_started',
    'The vault could not start the check just now. Try again in a moment.',
    { retriable: true },
  );
const notRunning = () =>
  new ApiError(409, 'reading_check_not_running', 'That check has already finished.');

interface CheckRow {
  id: string;
  state: ReadingCheckState;
  failure: ReadingCheckFailure | null;
  n: number;
  include_edited: boolean;
  requested_by: string | null;
  member_id: string | null;
  member_name: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  total: number;
  done: number;
  server_version: string | null;
  rules_hash: string | null;
  summary: unknown;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class ReadingCheckService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly enqueue: Enqueue,
  ) {}

  private rows(trx: Db) {
    return trx
      .selectFrom('reading_check as c')
      .leftJoin('member as m', 'm.id', 'c.member_id')
      .select([
        'c.id',
        'c.state',
        'c.failure',
        'c.n',
        'c.include_edited',
        'c.requested_by',
        'c.member_id',
        'm.display_name as member_name',
        'c.created_at',
        'c.started_at',
        'c.finished_at',
        'c.total',
        'c.done',
        'c.server_version',
        'c.rules_hash',
        'c.summary',
      ]);
  }

  private view(p: Principal, r: CheckRow): ReadingCheckView {
    // Numbers only, or none: the database holds it so, and so does this.
    const summary =
      r.summary !== null && numbersOnly(r.summary) ? (r.summary as ReadingCheckSummary) : null;
    return {
      id: r.id,
      state: r.state,
      failure: r.failure,
      n: r.n,
      include_edited: r.include_edited,
      requested_by: { member_id: r.member_id, name: r.member_name },
      mine: r.requested_by === p.accountId && r.member_id === p.memberId,
      created_at: r.created_at.toISOString(),
      started_at: iso(r.started_at),
      finished_at: iso(r.finished_at),
      progress: { total: r.total, done: r.done },
      reader: { server_version: r.server_version, rules: r.rules_hash },
      summary,
    };
  }

  /** GET /reading-checks: the household's checks, newest first, and how many could be read. */
  async list(p: Principal): Promise<ReadingChecksList> {
    ownerOnly(p);
    return withPrincipal(this.db, p, async (trx) => {
      const rows = (await this.rows(trx)
        .orderBy('c.created_at', 'desc')
        .orderBy('c.id')
        .limit(READING_CHECKS_KEPT)
        .execute()) as CheckRow[];
      // The others' checks: whose, and the state of each; nothing more (P-1).
      const others = await sql<{
        state: ReadingCheckState;
        member_id: string | null;
      }>`select o.state, o.member_id from reading_checks_of_others() o`.execute(trx);
      const names = new Map(
        (
          await trx
            .selectFrom('member')
            .select(['id', 'display_name'])
            .where(
              'id',
              'in',
              [...new Set(others.rows.map((o) => o.member_id))]
                .filter((m): m is string => m !== null)
                .concat(['00000000-0000-0000-0000-000000000000']),
            )
            .execute()
        ).map((m) => [m.id, m.display_name]),
      );
      return {
        items: rows.map((r) => this.view(p, r)),
        others: others.rows.map((o): ReadingCheckOther => ({
          state: o.state,
          requested_by: {
            member_id: o.member_id,
            name: o.member_id ? (names.get(o.member_id) ?? null) : null,
          },
        })),
        filed: await this.filed(trx, p),
      };
    });
  }

  /**
   * Documents filed through review the caller can see, out of the Trash
   * (review_filing's rule, and the visibility rule), with a scored detail a
   * person confirmed as they filed it.
   */
  private async filed(trx: Db, p: Principal): Promise<number> {
    const row = await trx
      .selectFrom('review_filing as rf')
      .innerJoin('document as d', 'd.id', 'rf.document_id')
      .where('d.deleted_at', 'is', null)
      .where(seenDocument(p))
      .where(sql<boolean>`rf.confirmed && array['kind', 'person', 'expiry']::text[]`)
      .select(sql<number>`count(distinct rf.document_id)::int`.as('n'))
      .executeTakeFirstOrThrow();
    return row.n;
  }

  /** POST /reading-checks: a check started, waiting for the worker (202). */
  async start(p: Principal, input: ReadingCheckInput): Promise<ReadingCheckView> {
    ownerOnly(p);
    const n = input.n ?? READING_CHECK_N.default;
    let made: CheckRow;
    try {
      made = await withPrincipal(this.db, p, async (trx) => {
        const { id } = await trx
          .insertInto('reading_check')
          .values({
            household_id: p.householdId,
            requested_by: p.accountId,
            member_id: p.memberId,
            n,
            include_edited: input.include_edited ?? true,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        // The newest kept; older ones let go, their misses with them.
        await trx
          .deleteFrom('reading_check')
          .where('state', 'in', ['done', 'cancelled', 'failed'])
          .where(
            'id',
            'not in',
            trx
              .selectFrom('reading_check')
              .select('id')
              .orderBy('created_at', 'desc')
              .limit(READING_CHECKS_KEPT),
          )
          .execute();
        return await this.rows(trx).where('c.id', '=', id).executeTakeFirstOrThrow();
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw running();
      throw err;
    }
    try {
      await this.enqueue(
        READING_CHECK_JOB,
        { household_id: p.householdId, check_id: made.id },
        { singletonKey: readingCheckKey(made.id), priority: READING_CHECK_PRIORITY },
      );
    } catch {
      // Not sent: not started, and nothing left to wait for a job that
      // will never come (R-4).
      await withPrincipal(this.db, p, (trx) =>
        trx.deleteFrom('reading_check').where('id', '=', made.id).execute(),
      ).catch(() => undefined);
      throw notStarted();
    }
    return this.view(p, made);
  }

  /**
   * GET /reading-checks/{id}: the check, and — to the owner who ran it
   * alone, while they are kept — the documents that needed typing that they
   * can still see.
   */
  async get(p: Principal, id: string): Promise<ReadingCheckDetail> {
    ownerOnly(p);
    if (!UUID.test(id)) throw notFound();
    return withPrincipal(this.db, p, async (trx) => {
      const row = (await this.rows(trx).where('c.id', '=', id).executeTakeFirst()) as
        CheckRow | undefined;
      if (!row) throw notFound();
      const view = this.view(p, row);
      if (!view.mine || row.state !== 'done') return { ...view, misses: null, misses_until: null };
      // Their own alone, by the database's rule too (reading_check_sealed_actor).
      const sealed = await trx
        .selectFrom('reading_check_sealed')
        .select(['misses_sealed', 'wrapped_by_scope', 'expires_at'])
        .where('check_id', '=', id)
        .where('member_id', '=', p.memberId)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      if (!sealed?.misses_sealed) return { ...view, misses: null, misses_until: null };
      let misses: ReadingMiss[];
      try {
        const key = await this.keys.unwrap(trx, {
          householdId: p.householdId,
          kind: 'member',
          memberId: p.memberId,
        });
        if (key.id !== sealed.wrapped_by_scope) throw new Error('another key');
        const raw = JSON.parse(
          openBytes(key.key, sealed.misses_sealed, readingMissesBinding(id)).toString('utf8'),
        ) as { misses?: ReadingMiss[] };
        misses = Array.isArray(raw.misses) ? raw.misses : [];
      } catch {
        // Not to be opened (their key changed since): none to show.
        return { ...view, misses: null, misses_until: null };
      }
      const ids = misses.map((m) => m.document_id).filter((d) => UUID.test(d));
      // Only those they can see now, out of the Trash, by the visibility rule
      // every list keeps: the database gives a signed-in caller every row.
      const seen =
        ids.length > 0
          ? await trx
              .selectFrom('document as d')
              .select(['d.id', 'd.title', 'd.type_key'])
              .where('d.id', 'in', ids)
              .where('d.deleted_at', 'is', null)
              .where(seenDocument(p))
              .execute()
          : [];
      const byId = new Map(seen.map((d) => [d.id, d]));
      const shown: ReadingMissView[] = misses.flatMap((m) => {
        const d = byId.get(m.document_id);
        return d
          ? [
              {
                document_id: d.id,
                title: d.title,
                type_key: d.type_key,
                fields: m.fields,
                level: m.level,
                wrong_ready: m.wrong_ready,
              },
            ]
          : [];
      });
      return { ...view, misses: shown, misses_until: sealed.expires_at.toISOString() };
    });
  }

  /** POST /reading-checks/{id}/cancel: a check waiting or running, stopped — its document let go at once — and what it read so far removed. */
  async cancel(p: Principal, id: string): Promise<ReadingCheckView> {
    ownerOnly(p);
    if (!UUID.test(id)) throw notFound();
    return withPrincipal(this.db, p, async (trx) => {
      const had = await trx
        .selectFrom('reading_check')
        .select('state')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!had) throw notFound();
      if (had.state !== 'waiting' && had.state !== 'running') throw notRunning();
      await trx
        .updateTable('reading_check')
        .set({ state: 'cancelled', finished_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
      // What it read so far, let go at once (P-2): "nothing it read was kept".
      await trx.deleteFrom('reading_check_sealed').where('check_id', '=', id).execute();
      return this.view(p, await this.rows(trx).where('c.id', '=', id).executeTakeFirstOrThrow());
    });
  }

  /**
   * GET /household/reading (0.9.0, R2): whether the vault's reading model
   * reads the household's batches beside the rules. An owner's.
   */
  async readingSettings(p: Principal): Promise<ReadingSettings> {
    ownerOnly(p);
    // Asked before the transaction, never inside it: a second connection
    // taken while one is held starves the pool (the R2 re-check).
    const loaded = await this.modelLoaded();
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('household')
        .select('reading_model')
        .where('id', '=', p.householdId)
        .executeTakeFirst();
      return { reading_model: row?.reading_model !== false, loaded };
    });
  }

  /**
   * Whether the workers have the reading model's weights loaded, as they
   * said lately (reading_model_state, 0079; the R2 review and its re-check):
   * at least one worker said so within READING_MODEL_STALE_MS, and every
   * worker that said anything in that time said "loaded". None said lately —
   * stopped, or a row a restore brought back — no.
   */
  async modelLoaded(): Promise<boolean> {
    // Not tenant data: the installation's, as watch_dir is. Ages by the
    // database's own clock, as the worker's rows are written by it.
    const rows = await this.db
      .selectFrom('reading_model_state')
      .select('state')
      .where(
        'checked_at',
        '>',
        sql<Date>`now() - make_interval(secs => ${READING_MODEL_STALE_MS / 1000})`,
      )
      .execute();
    return rows.length > 0 && rows.every((r) => r.state === 'loaded');
  }

  /**
   * PUT /household/reading (R2): the reading model on or off, an owner's
   * (and the database's: 0079's household_reading_model_rule). Pages read
   * from now on are read so; a card already read keeps what it was read
   * with. Said in the activity log, for the owners.
   */
  async setReadingSettings(
    p: Principal,
    input: ReadingSettings,
    meta: RequestMeta,
  ): Promise<ReadingSettings> {
    ownerOnly(p);
    // Before the transaction and its lock, never inside them (the R2 re-check).
    const loaded = await this.modelLoaded();
    return withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('household')
        .select('reading_model')
        .where('id', '=', p.householdId)
        .forUpdate()
        .executeTakeFirst();
      if (before && before.reading_model !== input.reading_model) {
        await trx
          .updateTable('household')
          .set({ reading_model: input.reading_model })
          .where('id', '=', p.householdId)
          .execute();
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'household.reading_model_changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: { reading_model: input.reading_model },
          ip: meta.ip,
        });
      }
      return { reading_model: input.reading_model, loaded };
    });
  }

  /** DELETE /reading-checks/{id}: a check removed, its numbers and misses with it; a running one stops. */
  async remove(p: Principal, id: string): Promise<void> {
    ownerOnly(p);
    if (!UUID.test(id)) throw notFound();
    const gone = await withPrincipal(this.db, p, (trx) =>
      trx.deleteFrom('reading_check').where('id', '=', id).executeTakeFirst(),
    );
    if (Number(gone.numDeletedRows) !== 1) throw notFound();
  }
}
