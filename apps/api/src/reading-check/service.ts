import { openBytes, readingMissesBinding, type ScopeKeys } from '@fdv/crypto';
import { withPrincipal, type Db } from '@fdv/db';
import {
  numbersOnly,
  READING_CHECK_N,
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
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';
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
 * Another owner is told only that one of somebody else's is waiting,
 * running or finished, whose, and when (reading_checks_of_others()), since
 * one runs at a time (the database's unique index: 409
 * reading_check_running); they can neither read, cancel nor remove it (404).
 * The documents that needed typing, and what, are given only for documents
 * the asker can still see, and only for seven days. Nothing here reads a
 * document's words or details.
 */

/** The job's name: the worker's READING_CHECK_JOB. */
export const READING_CHECK_JOB = 'reading.check';
/** One queued and one running a household: the worker's readingCheckKey. */
export const readingCheckKey = (householdId: string) => `reading-check:${householdId}`;
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
      // The others' checks: that each is there, whose and when; nothing more.
      const others = await sql<{
        id: string;
        state: ReadingCheckState;
        member_id: string | null;
        created_at: Date;
        finished_at: Date | null;
      }>`select o.id, o.state, o.member_id, o.created_at, o.finished_at
           from reading_checks_of_others() o`.execute(trx);
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
          id: o.id,
          state: o.state,
          requested_by: {
            member_id: o.member_id,
            name: o.member_id ? (names.get(o.member_id) ?? null) : null,
          },
          created_at: o.created_at.toISOString(),
          finished_at: iso(o.finished_at),
        })),
        filed: await this.filed(trx, p),
      };
    });
  }

  /** Documents filed through review the caller can see, out of the Trash (review_filing's rule, and the visibility rule). */
  private async filed(trx: Db, p: Principal): Promise<number> {
    const row = await trx
      .selectFrom('review_filing as rf')
      .innerJoin('document as d', 'd.id', 'rf.document_id')
      .where('d.deleted_at', 'is', null)
      .where(seenDocument(p))
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
    await this.enqueue(
      READING_CHECK_JOB,
      { household_id: p.householdId, check_id: made.id },
      { singletonKey: readingCheckKey(p.householdId) },
    );
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

  /** POST /reading-checks/{id}/cancel: a check waiting or running, stopped before its next document. */
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
      return this.view(p, await this.rows(trx).where('c.id', '=', id).executeTakeFirstOrThrow());
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
