import { aiReaderMonthCount, withSystem, type Db } from '@fdv/db';
import {
  AI_READER_CAP_DEFAULT,
  AI_READER_KIND_NAMES,
  aiReaderCapWarnAt,
  mayReadWith,
  type AiReaderHeldBack,
  type AiReaderPaper,
  type AiReaderRunsAt,
  type LocalAiOffer,
  type LocalAiReading,
  type StoredLocalAi,
} from '@fdv/shared';
import { CompiledQuery, sql } from 'kysely';
import type { AiReader, LocalAiAnswer, LocalAiWithout } from './ai-reader.js';

/**
 * Who may be sent to a reader, and how many (0.9.0, AIR3): the ONE way the
 * worker asks any AI reader about a paper — a batch's item (read-item.ts),
 * the Reading check (reading-check.ts), and whatever reads with one later.
 * Nothing else calls a reader's `read`.
 *
 *  1. **The sending rule** (`mayReadWith`, @fdv/shared, decisions 4 and 6),
 *     asked of the paper as it is now — read again inside the gate's own
 *     transaction (`load`), and once more once the reader's turn is the
 *     paper's, right before its words go (`stillMay`; the AIR3 review, S2)
 *     — and of its kind's Sensitive by default as the household has it now.
 *     A paper made Only me or sensitive while it was read is never sent, and
 *     a kind's default changed holds back the next read of every paper left
 *     as its kind says. "Also send sensitive papers" counts only for the
 *     reader it was turned on for (`identity`; S3). A paper held back is
 *     read without the AI, and its proposal says why.
 *  2. **The month's cap** (decision 10), for a cloud reader: one household's
 *     sends wait for each other (an advisory lock), so the count holds
 *     however many ask at once; a second send of the same words (an
 *     OpenAI-compatible server's json_object retry) counts too (M2); past the
 *     cap, read without it; at 80% — however it got there, a cap lowered
 *     below the count included — the owners are told once a month, the
 *     email queued in the same transaction as the month's mark (M3). A call
 *     that never left the reader's line is not counted.
 *  3. **What was sent is written down** (decision 11): which paper, which
 *     reader, when, how long, whether it answered — never a word sent or
 *     received — in `ai_reader_send`, the owners' to read.
 */

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** A reader as the gate needs it: its kind, where it runs, which it is, and its read. */
export type GateReader = Pick<AiReader, 'read' | 'kind' | 'runsAt' | 'identity'>;

/** An email to the owners, as the worker's alert job takes it. */
export interface OwnersAlert {
  household_id: string;
  account_ids: string[];
  subject: string;
  body: string;
  email_only?: boolean;
}

/** The queue's own way into a transaction (pg-boss's `db` option): its SQL run as part of it. */
export interface QueueDb {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** A transaction, for the queue to send a job as part of it. */
export const queueDbOf = (trx: Db): QueueDb => ({
  executeSql: async (text, values) => ({
    rows: (await trx.executeQuery(CompiledQuery.raw(text, values ?? []))).rows,
  }),
});

export interface AiSendDeps {
  db: Db;
  log: Log;
  /**
   * Queues an alert to the owners (the alert job) for the 80% email, as
   * part of the transaction it is given (the AIR3 review, M3): none, and it
   * is not sent.
   */
  tell?: ((a: OwnersAlert, db: QueueDb) => Promise<void>) | null;
}

/** Which paper it is, for the log of what was sent. */
export type AiPaperRef =
  { purpose: 'item'; incomingFileId: string } | { purpose: 'check'; documentId: string };

/**
 * The paper as it is now, read inside the gate's transaction (S2): null,
 * gone — and nothing is sent.
 */
export type PaperLoader = (trx: Db) => Promise<AiReaderPaper | null>;

/** What the gate came to: the reader's answer, or why it was not asked. */
export interface AiAsked {
  /** Its answer; null, not asked. */
  asked: LocalAiAnswer | null;
  /** Held back by the rule or the cap (with the household having it on). */
  held?: AiReaderHeldBack;
}

/** Whether a reader counts as a cloud service for the rule: anything not on the household's own network. */
export const isCloudReader = (r: Pick<AiReader, 'runsAt'> | null | undefined): boolean =>
  !!r && r.runsAt !== 'own_network';

/** What became of a call, for its row: nothing left the vault where it rested, was refused, held or never had its turn. */
const outcomeOf = (a: LocalAiAnswer): 'read' | 'without' | 'not_sent' =>
  a.state === 'replied'
    ? 'read'
    : a.queued || (['resting', 'refused', 'held'] as LocalAiWithout[]).includes(a.why)
      ? 'not_sent'
      : 'without';

/**
 * A paper as the rule asks of it, from what is known of it: its own
 * visibility and Sensitive, and its kind as the household keeps it now
 * (`effective_document_type`: its Sensitive by default, its default
 * visibility). A kind not known is none — and the rule counts the paper as
 * sensitive. Read inside the household's scope.
 */
export async function paperForRule(
  trx: Db,
  p: { visibility: string | null; sensitive: boolean | null; typeKey: string | null },
): Promise<AiReaderPaper> {
  const kind = p.typeKey
    ? await trx
        .selectFrom('effective_document_type')
        .select(['sensitive_default', 'default_visibility'])
        .where('key', '=', p.typeKey)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
    : undefined;
  return { visibility: p.visibility, sensitive: p.sensitive, kind: kind ?? null };
}

/**
 * A batch's item not yet filed, as the rule asks of it (the AIR3 review,
 * D1): only what its batch itself says. A batch that names its kind gives
 * that kind's Sensitive by default and default visibility; one that names
 * none makes the item sensitive, whatever else it says — never the kind the
 * rules guess — and, naming no visibility either, of a visibility nobody
 * knows, which the rule holds as Only me.
 */
export async function itemPaperForRule(
  trx: Db,
  b: { visibility: string | null; sensitive: boolean | null; typeKey: string | null },
): Promise<AiReaderPaper> {
  if (!b.typeKey) return { visibility: b.visibility, sensitive: true, kind: null };
  return paperForRule(trx, b);
}

/** The household's "Also send sensitive papers", for this reader alone (S3). */
async function sendsSensitiveTo(trx: Db, hh: string, reader: GateReader): Promise<boolean> {
  const h = await trx
    .selectFrom('household')
    .select(['ai_send_sensitive', 'ai_send_sensitive_for'])
    .where('id', '=', hh)
    .executeTakeFirst();
  return h?.ai_send_sensitive === true && h.ai_send_sensitive_for === reader.identity;
}

/** The rule asked of the paper as it is now: why not, or null — it may go. */
async function heldNow(
  trx: Db,
  hh: string,
  reader: GateReader,
  assumed: AiReaderRunsAt | null,
  load: PaperLoader,
): Promise<AiReaderHeldBack | 'gone' | null> {
  const paper = await load(trx);
  if (!paper) return 'gone';
  const rule = mayReadWith(paper, {
    runs_at: assumed,
    send_sensitive: await sendsSensitiveTo(trx, hh, reader),
  });
  return rule.may ? null : rule.why;
}

/** One household's sends, one at a time: the count holds however many ask. */
const lockMonth = (trx: Db, hh: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`ai-reader:${hh}`}, 0))`.execute(trx);

/** The month's cap for the household's reader: the saved one's, else the default. */
async function capOf(trx: Db, hh: string): Promise<number> {
  const saved = await trx
    .selectFrom('ai_reader')
    .select('monthly_cap')
    .where('household_id', '=', hh)
    .executeTakeFirst();
  return saved?.monthly_cap ?? AI_READER_CAP_DEFAULT;
}

/** A send written down before it goes; what became of it said after. */
async function writeSend(
  trx: Db,
  hh: string,
  reader: GateReader,
  cloud: boolean,
  ref: AiPaperRef,
): Promise<string> {
  const row = await trx
    .insertInto('ai_reader_send')
    .values({
      household_id: hh,
      kind: reader.kind,
      runs_at: cloud ? 'cloud' : 'own_network',
      purpose: ref.purpose,
      incoming_file_id: ref.purpose === 'item' ? ref.incomingFileId : null,
      document_id: ref.purpose === 'check' ? ref.documentId : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Asks the household's reader about a paper's words — or holds it back, and
 * says why. Never rejects for the reader's sake: the reader never rejects,
 * and what the vault could not write is logged and the paper read without it.
 */
export async function askAiReader(
  deps: AiSendDeps,
  hh: string,
  reader: GateReader | null | undefined,
  on: boolean,
  text: string,
  offer: LocalAiOffer,
  load: PaperLoader,
  ref: AiPaperRef,
  o: { priority: 'interactive' | 'check'; signal?: AbortSignal },
): Promise<AiAsked> {
  if (!reader || !on) return { asked: null };
  // Where the rule takes it to run, said to the reader too (M5): on the
  // household's own network, and a public address found is not sent to.
  const assumed = reader.runsAt;
  const cloud = assumed !== 'own_network';
  const ids: string[] = [];
  // Decided, and written down, in one go: the paper as it is now, the
  // household's switch, the month's count, the row of what is sent.
  const gate = await withSystem(deps.db, hh, async (trx) => {
    const held = await heldNow(trx, hh, reader, assumed, load);
    if (held) return { held } as const;
    if (cloud) {
      await lockMonth(trx, hh);
      const cap = await capOf(trx, hh);
      const month = await aiReaderMonthCount(trx);
      const full = month.sent >= cap;
      // At 80% — this paper bringing it there, or a cap lowered below what
      // was sent — the owners told, once a month (M3).
      if (!month.warned && month.sent + (full ? 0 : 1) >= aiReaderCapWarnAt(cap)) {
        await warnOwners(deps, trx, hh, reader.kind, {
          month: month.month,
          sent: month.sent + (full ? 0 : 1),
          cap,
        });
      }
      if (full) return { held: 'cap' } as const;
    }
    ids.push(await writeSend(trx, hh, reader, cloud, ref));
    // What was sent is kept a year and a month, then let go.
    await trx
      .deleteFrom('ai_reader_send')
      .where('household_id', '=', hh)
      .where('sent_at', '<', sql<Date>`now() - interval '400 days'`)
      .execute();
    return { sending: true } as const;
  });
  if ('held' in gate) {
    if (gate.held === 'gone') return { asked: null };
    deps.log('info', 'a paper was read without the AI reader', {
      kind: reader.kind,
      held: gate.held,
      purpose: ref.purpose,
    });
    return { asked: null, held: gate.held };
  }
  // Asked once more once the reader's turn is this paper's (S2).
  let lastHeld: AiReaderHeldBack = 'sensitive';
  const stillMay = async () => {
    const now = await withSystem(deps.db, hh, (trx) => heldNow(trx, hh, reader, assumed, load));
    if (now === null) return true;
    if (now !== 'gone') lastHeld = now;
    return false;
  };
  // The same words sent again (M2): a send of its own, within the cap.
  const again = async () =>
    withSystem(deps.db, hh, async (trx) => {
      if (cloud) {
        await lockMonth(trx, hh);
        if ((await aiReaderMonthCount(trx)).sent >= (await capOf(trx, hh))) return false;
      }
      ids.push(await writeSend(trx, hh, reader, cloud, ref));
      return true;
    });
  const asked = await reader.read(text, offer, {
    ...o,
    stillMay,
    again,
    assumed,
  });
  const ms = Math.max(0, Math.min(3_600_000, Math.round(asked.ms)));
  await withSystem(deps.db, hh, async (trx) => {
    const last = ids[ids.length - 1];
    for (const id of ids) {
      await trx
        .updateTable('ai_reader_send')
        // An earlier send of the same words, answered with a refusal.
        .set({ ms, outcome: id === last ? outcomeOf(asked) : 'without' })
        .where('id', '=', id)
        .execute();
    }
  }).catch((err: unknown) =>
    deps.log('warn', 'could not write down what the AI reader was sent', {
      err: (err as Error).message.slice(0, 200),
    }),
  );
  if (asked.state === 'without' && asked.why === 'held') {
    deps.log('info', 'a paper was read without the AI reader', {
      kind: reader.kind,
      held: lastHeld,
      purpose: ref.purpose,
      at: 'its turn',
    });
    return { asked: null, held: lastHeld };
  }
  return { asked };
}

/**
 * The owners told at 80% of the month's cap (decision 10; the AIR3 review,
 * M3): the month's mark and the email's job written in one transaction, in
 * a savepoint of the gate's — so either both are kept or neither, and a
 * queue that could not take it leaves the next paper to try again. Never
 * fails the paper.
 */
async function warnOwners(
  deps: AiSendDeps,
  trx: Db,
  hh: string,
  kind: GateReader['kind'],
  at: { month: string; sent: number; cap: number },
): Promise<void> {
  const tell = deps.tell;
  if (!tell) return;
  await sql`savepoint ai_reader_warning`.execute(trx);
  try {
    const first = await trx
      .insertInto('ai_reader_cap_warning')
      .values({ household_id: hh, month: at.month })
      .onConflict((oc) => oc.doNothing())
      .returning('month')
      .executeTakeFirst();
    if (first) {
      const owners = await trx
        .selectFrom('account_household')
        .select('account_id')
        .where('household_id', '=', hh)
        .where('role', '=', 'owner')
        .execute();
      if (owners.length > 0) {
        await tell(
          {
            household_id: hh,
            account_ids: owners.map((r) => r.account_id),
            subject: 'The AI reader has read most of this month’s papers',
            body: `The vault has sent ${at.sent} of this month’s ${at.cap} papers to the AI reader (${AI_READER_KIND_NAMES[kind]}). Past ${at.cap}, papers are read by the vault’s own rules alone until next month. An owner can change the limit in Settings → Reading → The AI reader.`,
            email_only: true,
          },
          queueDbOf(trx),
        );
      }
    }
    await sql`release savepoint ai_reader_warning`.execute(trx);
  } catch (err) {
    await sql`rollback to savepoint ai_reader_warning`.execute(trx);
    deps.log('warn', 'could not tell the owners the AI reader is near its monthly limit', {
      err: (err as Error).message.slice(0, 200),
    });
  }
}

/**
 * What is sealed of the AI beside the proposal (R4; AIR3): nothing where it
 * was not asked; that it was held back, and why; what it read; or that the
 * paper was read without it.
 */
export function sealedAi(
  got: AiAsked,
  read: LocalAiReading | null | undefined,
): StoredLocalAi | undefined {
  if (got.held) return { state: 'without', held: got.held };
  if (!got.asked) return undefined;
  if (got.asked.state === 'replied' && read) return { state: 'read', fields: read };
  return { state: 'without' };
}
