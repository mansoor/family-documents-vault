import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openBytes,
  readingMissesBinding,
  readingWorkBinding,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { readAs, withSystem, type Db } from '@fdv/db';
import {
  can,
  levelItem,
  numbersOnly,
  READING_FIELDS,
  READING_MISSES_KEEP_DAYS,
  READING_SCORED_FIELDS,
  scoreReading,
  suspensionInEffect,
  type BatchDefaults,
  type ItemLevel,
  type LearnedContext,
  type LevelKind,
  type ProposalContext,
  type ReadingCheckSummary,
  type ReadingField,
  type ReadingMiss,
  type ReadingTruth,
  type Role,
  type SmartSeen,
  type TypeField,
} from '@fdv/shared';
import { StorageError } from '@fdv/storage';
import { sql } from 'kysely';
import type pg from 'pg';
import { extractText } from './extract-text.js';
import { adapterOf } from './incoming.js';
import { decryptToBuffer } from './process-version.js';
import type { ItemProposer, ThreadAnswer } from './proposal-thread.js';
import {
  BLANK_LETTERS,
  drawnOrNot,
  learnedContext,
  PROPOSAL_TEXT_MAX,
  proposalContext,
  READ_DEADLINE_MS,
  unread,
  type ReadItemDeps,
} from './read-item.js';
import { atLowPriority, detectTools, pdfLocked, type Tools } from './tools.js';
import { WORD_MIME } from './word-text.js';

/**
 * The Reading check (0.9.0, R0), in the worker: the reader as it is now,
 * measured on a family's own papers, without a word of them leaving here.
 *
 * An owner starts a check (the API makes its row, 0074, and sends this
 * job). The worker chooses the last N documents filed through review
 * (review_filing: a version an accepted batch item or Inbox file made) —
 * as the owner who asked — through `readAs`, and the visibility rule every
 * list keeps (`seenBy`) — so only documents they can see, out of the Trash:
 * never somebody else's Only me. Each is asked again as it is read.
 *
 * Only what a person confirmed is the truth (the R0 review, A-2): a batch's
 * item filed as a document of its own confirmed every detail its card
 * filed; an Inbox file, or a version added to a document already there,
 * only what its accept set; and a detail changed by hand since — after the
 * filing's line in the activity log, a scored detail only (A-1) — is
 * confirmed by that. A detail not confirmed is not scored; a document with
 * none of kind, person and expiry confirmed is not read.
 *
 * Then, one at a time and behind anything else waiting to be read or drawn
 * (R-3), each is read as a batch's item would be (read-item.ts): its
 * current version opened here, its words taken by `extractText` — its tools
 * niced, one thread — proposed for on the proposal thread
 * (`proposeDetails`) and levelled (`levelItem`) for the owner, with no
 * folder names, no defaults and no current details. Twice: without the
 * learned rules (I4) — the honest number — and with the asking owner's own
 * rules on the documents they filed themselves, which is optimistic, as
 * those rules were learned from these same papers: on a document somebody
 * else filed, "with" is "without", so no owner's numbers reflect another
 * person's rules.
 *
 * What it offered is scored against the document's details now by the
 * Smart exit's own scorer (@fdv/shared reading-score.ts, through
 * scoreReading). What is kept is the numbers (reading_check.summary,
 * numbers only, held by the database too), and which documents needed
 * typing and what, sealed under the asking owner's member key for
 * READING_MISSES_KEEP_DAYS. While it runs, what it has done so far is
 * sealed the same way, and let go at once as it finishes or is cancelled.
 * Nothing is written to a document, no item, no proposal and no rule is
 * made, and the log says counts, never a document, a word or a value.
 *
 * A document removed, moved to the Trash or no longer the owner's to see
 * as it runs is skipped. Pages that give no words — a password, a scan OCR
 * cannot read, a file the vault does not read, the thread ending on it —
 * are "not read", never a crash. Any trouble with one document is tried
 * again later, READING_DOC_TRIES times, and then the document is skipped;
 * READING_CHECK_ERRORS_MAX in all, and the check stops (R-2). One check a
 * household at a time (the database's unique index), one run of it at a
 * time (its lease); cancelled or removed by an owner, the document being
 * read is let go at once, its tools killed. Its owner no longer an owner,
 * locked or paused, and it stops (P-3).
 */

/** The job's name, as the API sends it (its READING_CHECK_JOB). */
export const READING_CHECK_JOB = 'reading.check';
/** Each night: a check's misses past their seven days removed. */
export const READING_CHECK_SWEEP_JOB = 'reading.check.sweep';
/**
 * One queued and one running a check (the R0 review, R-1): keyed by the
 * check, never the household, so a check started after another was
 * cancelled is never left waiting behind the cancelled one's job.
 */
export const readingCheckKey = (checkId: string) => `reading-check:${checkId}`;
/** And a later run of it, waiting its time, under a key of its own. */
export const readingCheckLaterKey = (checkId: string) => `${readingCheckKey(checkId)}:later`;
/** Below every other job (pg-boss takes the highest first). */
export const READING_CHECK_PRIORITY = -10;
/** How long one run reads before it lets the queue go round. */
export const READING_RUN_MS = 60_000;
/** Behind other work waiting to be read or drawn: looked at again after this. */
export const READING_YIELD_MS = 30_000;
/** After trouble with a document, tried again after this. */
export const READING_AGAIN_MS = 60_000;
/** Trouble with one document this many times, and it is skipped. */
export const READING_DOC_TRIES = 3;
/** Trouble this many times in all, and the check stops. */
export const READING_CHECK_ERRORS_MAX = 10;
/** How often, while a document is read, the worker looks whether the check was cancelled. */
export const READING_CANCEL_POLL_MS = 2_000;
/** A run may take this long before the queue takes it as lost: a document's read, with room. */
export const READING_JOB_EXPIRE_SECONDS = 14 * 60;
/** A run holds its check this long at most: its job's expiry. */
const LEASE_SECONDS = READING_JOB_EXPIRE_SECONDS;
/** The folders a document's read is written to, removed as it ends — or at the worker's start. */
export const READING_TEMP_PREFIX = 'fdv-check-';

export interface ReadingCheckJob {
  household_id: string;
  check_id: string;
}

/** The queue, as much of it as sending a check's job needs. */
export interface ReadingCheckQueue {
  send(
    name: string,
    data: object,
    options: { singletonKey: string; priority: number; startAfter?: Date },
  ): Promise<unknown>;
}

/** A check's job sent: now, or later — keyed by the check, at the lowest priority. */
export async function sendReadingCheck(
  boss: ReadingCheckQueue,
  job: ReadingCheckJob,
  after?: Date,
): Promise<void> {
  await boss.send(
    READING_CHECK_JOB,
    { ...job },
    after
      ? {
          singletonKey: readingCheckLaterKey(job.check_id),
          startAfter: after,
          priority: READING_CHECK_PRIORITY,
        }
      : { singletonKey: readingCheckKey(job.check_id), priority: READING_CHECK_PRIORITY },
  );
}

export interface ReadingCheckDeps extends ReadItemDeps {
  /** What the hash of the rules is keyed with (READING_RULES_KEY_PURPOSE). */
  rulesKey: Buffer;
  /** This release. */
  serverVersion: string;
}

export interface ReadingOptions {
  /** The most pages read of a PDF (FDV_OCR_MAX_PAGES). */
  maxPages: number;
  proposer: ItemProposer;
  /** How the words are taken: extractText, unless a test stands in. */
  extract?: typeof extractText;
  tools?: Tools;
  deadlineMs?: number;
  /** How long one run reads: READING_RUN_MS, unless a test says. */
  runMs?: number;
  /** How often a read looks whether it was cancelled: READING_CANCEL_POLL_MS, unless a test says. */
  cancelPollMs?: number;
}

/** Whom a check reads as: the owner who asked. */
export interface Reader {
  accountId: string;
  memberId: string;
  role: Role;
}

/** A document chosen: who last filed it through review, what a person confirmed, and whether by hand since. */
interface Chosen {
  id: string;
  filed_by: string | null;
  edited: boolean;
  confirmed: ReadingField[];
}

/** One document read: its details now, and what each reading made of it. Sealed, never plain. */
interface WorkRow {
  document_id: string;
  only_me: boolean;
  mode: 'text' | 'scan';
  truth: ReadingTruth;
  without: SmartSeen;
  with: SmartSeen;
  edited: boolean;
  confirmed: ReadingField[];
}

/** What a running check keeps between runs, sealed under the asking owner's key. */
interface Work {
  v: 2;
  docs: Chosen[];
  rows: WorkRow[];
  skipped: number;
  /** Trouble with the next document so far. */
  tries: number;
}

/** What one run came to: when to run again, if at all. */
export type ReadingRunAnswer = { next: null } | { next: 'now' } | { next: Date };

const EMPTY_DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: null,
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * The last `n` documents filed through review, newest first, as `reader`
 * is given them — or, for the vault's own CLI, every one but the Only me
 * documents, anybody's: out of the Trash, with a scored detail a person
 * confirmed, and, without `includeEdited`, none whose scored details were
 * changed by hand since it was filed — all of that asked before the last
 * `n` are taken (A-3).
 */
export async function chooseDocuments(
  trx: Db,
  reader: Reader | null,
  n: number,
  includeEdited: boolean,
): Promise<Chosen[]> {
  const scored = sql`array['kind', 'person', 'expiry']::text[]`;
  const pick = (t: Db) =>
    sql<{
      document_id: string;
      filed_by: string | null;
      confirmed: string[];
      by_hand: string[];
    }>`
      with filed as (
        select rf.document_id,
               max(rf.filed_at) as filed_at,
               (array_agg(rf.filed_by order by rf.filed_at desc))[1] as filed_by,
               min(rf.filed_audit_id) as since
          from review_filing rf
          join document d on d.id = rf.document_id
         where d.deleted_at is null
           and ${reader ? seenBy(reader) : sql<boolean>`d.visibility <> 'private'`}
         group by rf.document_id
      ), facts as (
        select f.*,
               array(select distinct c from review_filing r2, unnest(r2.confirmed) c
                      where r2.document_id = f.document_id) as confirmed,
               -- Changed by hand since it was filed: its scored or detail
               -- fields, in lines after the filing's (an accept's own lines,
               -- as a version's changes, are before it).
               array(select distinct m.field
                       from audit_event a
                       cross join lateral jsonb_array_elements_text(
                         case when jsonb_typeof(a.detail -> 'fields') = 'array'
                              then a.detail -> 'fields' else '[]'::jsonb end) e(name)
                       join (values ('type_key', 'kind'), ('owner_member_id', 'person'),
                                    ('expires', 'expiry'), ('issued', 'issued'),
                                    ('identifier', 'number'), ('issued_by', 'issuer'))
                            as m(name, field) on m.name = e.name
                      where a.object_type = 'document' and a.object_id = f.document_id
                        and a.id > f.since and a.action = 'document.updated') as by_hand
          from filed f
      )
      select document_id, filed_by, confirmed, by_hand
        from facts
       where (confirmed || by_hand) && ${scored}
         and (${includeEdited} or not (by_hand && ${scored}))
       order by filed_at desc, document_id
       limit ${n}`.execute(t);
  const { rows } = reader ? await readAs(trx, reader, pick) : await pick(trx);
  return rows.map((r) => {
    const byHand = r.by_hand as ReadingField[];
    return {
      id: r.document_id,
      filed_by: r.filed_by,
      edited: byHand.some((f) => READING_SCORED_FIELDS.includes(f)),
      confirmed: READING_FIELDS.filter((f) => r.confirmed.includes(f) || byHand.includes(f)),
    };
  });
}

/**
 * "The reader may see document `d`": the visibility rule every list keeps
 * (the API's seenDocument; held to @fdv/shared's canSee by the API's
 * visibility-rule test) — everybody's, Adults only for whoever sees them,
 * and their own Only me, never somebody else's. The database gives a
 * signed-in caller every row, and leaves this to the vault; so it is asked
 * here, on top of what readAs gives, every time a document is chosen or read.
 */
export const seenBy = (
  reader: Pick<Reader, 'memberId' | 'role'>,
) => sql<boolean>`(d.visibility = 'household'
  or (d.visibility = 'adults' and ${can(reader.role, 'document.see_adults')})
  or (d.visibility = 'private' and d.owner_member_id = ${reader.memberId}::uuid))`;

/** The documents `seenBy` gives a reader, out of the Trash or not: for the parity test. */
export async function seenByIds(
  trx: Db,
  reader: Pick<Reader, 'memberId' | 'role'>,
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`select d.id::text as id from document d
    where ${seenBy(reader)} order by d.id`.execute(trx);
  return rows.map((r) => r.id);
}

/** The kinds as a card is levelled against them: GET /document-types' view, as much as levelling needs. */
async function levelKinds(trx: Db): Promise<LevelKind[]> {
  const kinds = await trx
    .selectFrom('effective_document_type')
    .select([
      'key',
      'label',
      'fields',
      'expiry_driver',
      'default_visibility',
      'core',
      'short_label',
      'remind_from',
    ])
    .where('deleted_at', 'is', null)
    .orderBy('key')
    .execute();
  return kinds.map((k) => {
    const core = { ...(k.core as NonNullable<LevelKind['core']>) };
    core.expires = { ...core.expires, required: k.expiry_driver !== null };
    return {
      key: k.key,
      label: k.label,
      default_visibility: k.default_visibility,
      expiry_driver: k.expiry_driver,
      short_label: k.short_label,
      core,
      // The date reminders come from is always asked for, as typeView says.
      fields: ((k.fields ?? []) as TypeField[]).map((f) => ({
        ...f,
        required: f.required === true || f.key === k.remind_from,
      })),
    };
  });
}

/**
 * What a run reads against: the reader's context, the kinds, the family;
 * and the asking owner's own rules, used only on the documents they filed
 * themselves (`rulesFor`). The CLI has none.
 */
interface RunContext {
  proposal: ProposalContext;
  kinds: LevelKind[];
  people: Array<{ id: string; name: string }>;
  role: Role;
  me: string;
  /** The account whose own filings the rules are used on; null, none. */
  rulesFor: string | null;
  rules: LearnedContext | null;
}

/**
 * `withRules`: the asking owner's — read as them (readAs, inside
 * learnedContext), so the database gives theirs and nobody else's. The CLI
 * reads with the general reader alone: no rules, and no issuer seen only on
 * somebody's Only me document.
 */
async function runContext(
  trx: Db,
  hh: string,
  reader: Reader,
  withRules: boolean,
): Promise<RunContext> {
  const proposal = await proposalContext(trx, hh, reader.memberId, { onlyMe: withRules });
  return {
    proposal,
    kinds: await levelKinds(trx),
    people: proposal.people.map((p) => ({ id: p.id, name: p.name })),
    role: reader.role,
    me: reader.memberId,
    rulesFor: withRules ? reader.accountId : null,
    rules: withRules ? await learnedContext(trx, hh, reader.memberId) : null,
  };
}

/**
 * A keyed hash of the rules a check reads with, the asking owner's own: the
 * same rules give the same twelve characters, and the characters say nothing
 * of them to anybody without the vault's key.
 */
export function rulesHash(key: Buffer, sets: ReadonlyArray<LearnedContext | null>): string {
  const canon = sets
    .filter((s): s is LearnedContext => s !== null)
    .map((s) => ({
      me: s.me,
      rules: s.rules
        .map((r) => [r.issuer_key, r.field, r.value, r.confirmed, r.contradicted] as const)
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    }))
    .sort((a, b) => (a.me < b.me ? -1 : a.me > b.me ? 1 : 0));
  return createHmac('sha256', key).update(JSON.stringify(canon)).digest('hex').slice(0, 12);
}

const notRead: SmartSeen = {
  level: null,
  duplicate: false,
  failure: 'not_read',
  kind: null,
  person: null,
  issued: null,
  expires: null,
  number: null,
  issuer: null,
};

/** What a card starts from, as the Smart exit reads it off GET /batches/{id}. */
const seenOf = (lv: ItemLevel): SmartSeen => ({
  level: lv.level,
  duplicate: false,
  failure: null,
  kind: lv.proposals?.type_key?.value ?? null,
  person: lv.proposals?.owner_member_id?.value ?? null,
  issued: lv.proposals?.issued?.value.date ?? null,
  expires: lv.proposals?.expires?.value.date ?? null,
  number: lv.proposals?.identifier?.value ?? null,
  issuer: lv.proposals?.issued_by?.value ?? null,
});

/** Trouble with a document that is not its own doing: tried again later. */
class Again extends Error {}
/** The check was cancelled or removed while a document was being read. */
class Cancelled extends Error {}

type Outcome = { kind: 'gone' } | { kind: 'read'; row: WorkRow };

/**
 * One document read, both ways, for the reader: or `gone` — removed, in
 * the Trash, no longer theirs to see, or with no version. Throws Again for
 * the vault's own trouble, and Cancelled once `cancel` aborts (its tools
 * killed). Writes nothing.
 */
async function readDocument(
  deps: ReadItemDeps,
  hh: string,
  chosen: Chosen,
  reader: Reader | null,
  ctx: RunContext,
  opts: ReadingOptions,
  cancel?: AbortSignal,
): Promise<Outcome> {
  let had;
  try {
    had = await withSystem(deps.db, hh, async (trx) => {
      const doc = await trx
        .selectFrom('document')
        .select([
          'id',
          'type_key',
          'owner_member_id',
          'visibility',
          'issued_on',
          'expires_on',
          'identifier',
          'issued_by',
          'deleted_at',
        ])
        .where('id', '=', chosen.id)
        .executeTakeFirst();
      if (!doc || doc.deleted_at) return null;
      // The vault's own CLI reads no Only me document, anybody's.
      if (!reader && doc.visibility === 'private') return null;
      // Still the reader's to see, now: out of the Trash, and theirs by the visibility rule.
      if (reader) {
        const seen = await readAs(trx, reader, (t) =>
          sql<{ id: string }>`select d.id from document d
                               where d.id = ${chosen.id}::uuid and d.deleted_at is null
                                 and ${seenBy(reader)}`.execute(t),
        );
        if (seen.rows.length === 0) return null;
      }
      const version = await trx
        .selectFrom('document_version')
        .select(['id', 'mime', 'storage_key', 'vault_id', 'file_key_wrapped', 'wrapped_by_scope'])
        .where('document_id', '=', chosen.id)
        .orderBy('version_no', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!version) return null;
      const scopeKey = await deps.keys.unwrapById(trx, version.wrapped_by_scope);
      return {
        doc,
        version,
        fileKey: unwrapKey(version.file_key_wrapped, scopeKey, `version:${doc.id}`),
        adapter: await adapterOf(trx, deps, version.vault_id),
        // The asker's own rules, on a document they filed themselves alone.
        learned: ctx.rulesFor !== null && chosen.filed_by === ctx.rulesFor ? ctx.rules : null,
      };
    });
  } catch (err) {
    throw new Again((err as Error).message);
  }
  if (!had) return { kind: 'gone' };
  const { doc, version } = had;
  const truth: ReadingTruth = {
    kind: doc.type_key,
    person: doc.owner_member_id,
    issued: doc.issued_on ? String(doc.issued_on).slice(0, 10) : null,
    expires: doc.expires_on ? String(doc.expires_on).slice(0, 10) : null,
    number: doc.identifier,
    issuer: doc.issued_by,
  };
  const mime = version.mime ?? '';
  const row = (mode: 'text' | 'scan', without: SmartSeen, withRules: SmartSeen): Outcome => ({
    kind: 'read',
    row: {
      document_id: doc.id,
      only_me: doc.visibility === 'private',
      mode,
      truth,
      without,
      with: withRules,
      edited: chosen.edited,
      confirmed: chosen.confirmed,
    },
  });
  const unreadAs = mime.startsWith('image/') ? 'scan' : 'text';

  let plain: Buffer;
  try {
    plain = await decryptToBuffer(had.adapter, version.storage_key, had.fileKey);
  } catch (err) {
    // Its object gone or not what was kept: not read. Storage out of reach: later.
    if (err instanceof StorageError && err.code !== 'not_found') throw new Again(err.message);
    return row(unreadAs, notRead, notRead);
  }
  const deadline = AbortSignal.timeout(opts.deadlineMs ?? READ_DEADLINE_MS);
  const signal = cancel ? AbortSignal.any([deadline, cancel]) : deadline;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), READING_TEMP_PREFIX));
    const ext = mime === 'application/pdf' ? 'pdf' : mime === WORD_MIME ? 'docx' : 'img';
    const source = path.join(dir, `source.${ext}`);
    await writeFile(source, plain);
    const workDir = dir;
    const tools = opts.tools ?? (await detectTools());
    let text: string;
    let mode: 'text' | 'scan' = unreadAs;
    try {
      // Its tools niced, one thread: nobody is waiting on this (R-3).
      const got = await atLowPriority(async () => {
        if (mime === 'application/pdf' && (await pdfLocked(source, signal))) return 'locked';
        return (opts.extract ?? extractText)(source, mime, {
          maxPages: opts.maxPages,
          workDir,
          tools,
          signal,
        });
      });
      if (cancel?.aborted) throw new Cancelled();
      deadline.throwIfAborted();
      if (got === 'locked' || !got) return row(unreadAs, notRead, notRead);
      mode = got.ocrPages > 0 || got.source === 'ocr' ? 'scan' : 'text';
      text = got.text.slice(0, PROPOSAL_TEXT_MAX);
    } catch (err) {
      if (err instanceof Cancelled || cancel?.aborted) throw new Cancelled();
      // OCR that failed, a tool killed at the deadline, a file not what it
      // says: not read. Never a word of it logged.
      return row(unreadAs, notRead, notRead);
    }
    if (letters(text) < BLANK_LETTERS) return row(mode, notRead, notRead);
    const level = (answer: ThreadAnswer): SmartSeen => {
      if (answer.state === 'unavailable') throw new Again('the proposal thread could not be had');
      if (answer.state !== 'done') return notRead;
      return seenOf(
        levelItem({
          state: 'waiting',
          reading: 'read',
          failure: null,
          proposal: answer.proposal,
          learnedClash: answer.clash ?? null,
          duplicate: null,
          renewal: null,
          folder: null,
          defaults: EMPTY_DEFAULTS,
          types: ctx.kinds,
          people: ctx.people,
          role: ctx.role,
          me: ctx.me,
        }),
      );
    };
    const without = level(await opts.proposer.propose(text, ctx.proposal, null));
    const withRules =
      had.learned && had.learned.rules.length > 0
        ? level(await opts.proposer.propose(text, ctx.proposal, had.learned))
        : without;
    if (cancel?.aborted) throw new Cancelled();
    return row(mode, without, withRules);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The queues of reading and drawing the family waits on: a check goes behind them (R-3). */
const FAMILY_QUEUES = [
  'version.process',
  'version.previews',
  'batch.previews',
  'incoming.scan',
  'share.pages',
  'member.photo',
];

/**
 * Whether anything else is waiting to be read or drawn: the household's
 * batch items (from Many documents, the scanner folder, email in or a
 * computer) to read, or, in any household, a version to process, pages to
 * draw, files sent in to scan.
 */
export async function otherWorkWaiting(deps: ReadItemDeps, hh: string): Promise<boolean> {
  const row = await withSystem(deps.db, hh, (trx) =>
    trx
      .selectFrom('incoming_file')
      .select('id')
      .where('batch_id', 'is not', null)
      .where('state', '=', 'received')
      .where(unread)
      .where(drawnOrNot)
      .limit(1)
      .executeTakeFirst(),
  );
  if (row !== undefined) return true;
  const queue = await sql<{
    has: boolean;
  }>`select to_regclass('pgboss.job') is not null as has`.execute(deps.db);
  if (queue.rows[0]?.has !== true) return false;
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from (
      select 1 from pgboss.job
       where name = any(${FAMILY_QUEUES}::text[])
         and state in ('created', 'retry', 'active')
         and start_after <= now()
       limit 1) j`.execute(deps.db);
  return (rows[0]?.n ?? 0) > 0;
}

/** The documents read, scored both ways: the numbers, and the honest reading's misses. */
export function scoreWork(
  work: Pick<Work, 'docs' | 'rows' | 'skipped'>,
  expiring: (kind: string) => boolean,
): { summary: ReadingCheckSummary; misses: ReadingMiss[] } {
  const as = (which: 'without' | 'with') =>
    scoreReading(
      work.rows.map((r) => ({
        document_id: r.document_id,
        only_me: r.only_me,
        mode: r.mode,
        truth: r.truth,
        seen: r[which],
        confirmed: r.confirmed,
      })),
      expiring,
    );
  const without = as('without');
  const withRules = as('with');
  const summary: ReadingCheckSummary = {
    chosen: work.docs.length,
    read: work.rows.length,
    skipped: work.skipped,
    edited: work.rows.filter((r) => r.edited).length,
    partly_confirmed: work.rows.filter((r) => r.confirmed.length < READING_FIELDS.length).length,
    without_rules: without.result,
    with_rules: withRules.result,
  };
  if (!numbersOnly(summary)) throw new Error('a reading check’s summary must be numbers only');
  return { summary, misses: without.misses };
}

/** Which kinds keep an expiry, as the household's kinds say now. */
async function expiringKinds(trx: Db): Promise<(kind: string) => boolean> {
  const rows = await trx
    .selectFrom('effective_document_type')
    .select(['key', 'expiry_driver'])
    .execute();
  const set = new Set(rows.filter((r) => r.expiry_driver !== null).map((r) => r.key));
  return (k) => set.has(k);
}

/** The owner who asked, as they are now: none once they are no owner, gone, locked or paused (P-3). */
async function readerOf(
  trx: Db,
  hh: string,
  check: { requested_by: string | null; member_id: string | null },
): Promise<Reader | null> {
  if (!check.requested_by || !check.member_id) return null;
  const who = await trx
    .selectFrom('account_household')
    .select(['account_id', 'member_id', 'role', 'suspended_at', 'suspended_until'])
    .where('household_id', '=', hh)
    .where('account_id', '=', check.requested_by)
    .where('member_id', '=', check.member_id)
    .executeTakeFirst();
  if (!who || who.role !== 'owner' || suspensionInEffect(who)) return null;
  return { accountId: who.account_id, memberId: who.member_id, role: who.role };
}

/**
 * One run of a check: its lease taken (one run at a time), started if it
 * is waiting (its documents chosen as its owner, sealed), then documents
 * read one after another until the run has had READING_RUN_MS, other work
 * waits to be read or drawn, there is trouble, or none are left — then its
 * numbers kept, its misses sealed and what it did let go. Answers when to
 * run again. Never throws: what it cannot finish it says in its row
 * (`failed`, `stopped`).
 */
export async function workReadingCheck(
  deps: ReadingCheckDeps,
  job: ReadingCheckJob,
  opts: ReadingOptions,
): Promise<ReadingRunAnswer> {
  const hh = job.household_id;
  const began = Date.now();
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    deps.log('info', msg, { check: job.check_id, ...extra });
  const stop = () =>
    withSystem(deps.db, hh, async (trx) => {
      await trx
        .updateTable('reading_check')
        .set({ state: 'failed', failure: 'stopped', finished_at: new Date(), lease_until: null })
        .where('id', '=', job.check_id)
        .where('state', 'in', ['waiting', 'running'])
        .execute();
      await trx.deleteFrom('reading_check_sealed').where('check_id', '=', job.check_id).execute();
    }).catch(() => undefined);
  /** Trouble, counted against the check: too much, and it stops (R-2). */
  const trouble = async (): Promise<boolean> => {
    const n = await withSystem(deps.db, hh, (trx) =>
      trx
        .updateTable('reading_check')
        .set({ errors: sql<number>`least(errors + 1, 1000)` })
        .where('id', '=', job.check_id)
        .returning('errors')
        .executeTakeFirst(),
    ).catch(() => undefined);
    if (n && n.errors >= READING_CHECK_ERRORS_MAX) {
      await stop();
      log('a reading check stopped: too much trouble');
      return true;
    }
    return false;
  };
  let leased = false;
  const release = () =>
    withSystem(deps.db, hh, (trx) =>
      trx
        .updateTable('reading_check')
        .set({ lease_until: null })
        .where('id', '=', job.check_id)
        .execute(),
    ).catch(() => undefined);
  try {
    const start = await withSystem(deps.db, hh, async (trx) => {
      // One run at a time: its lease, or nothing.
      const check = await trx
        .updateTable('reading_check')
        .set({ lease_until: sql<Date>`now() + make_interval(secs => ${LEASE_SECONDS})` })
        .where('id', '=', job.check_id)
        .where('state', 'in', ['waiting', 'running'])
        .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', new Date())]))
        .returningAll()
        .executeTakeFirst();
      if (!check) {
        // Cancelled, finished or removed: what it had done so far let go.
        await trx
          .deleteFrom('reading_check_sealed')
          .where('check_id', '=', job.check_id)
          .where('work_sealed', 'is not', null)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('reading_check as c')
                  .select('c.id')
                  .whereRef('c.id', '=', 'reading_check_sealed.check_id')
                  .where('c.state', 'in', ['waiting', 'running']),
              ),
            ),
          )
          .execute();
        return null;
      }
      return { check, reader: await readerOf(trx, hh, check) };
    });
    if (!start) return { next: null };
    leased = true;
    const { check, reader } = start;
    if (!reader) {
      // Its owner is no owner now, gone, locked or paused: nobody to read as.
      await stop();
      log('a reading check stopped: its owner can no longer have it');
      return { next: null };
    }
    const scope = await withSystem(deps.db, hh, (trx) =>
      deps.keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: reader.memberId }),
    );
    const seal = (work: Work) =>
      sealBytes(scope.key, Buffer.from(JSON.stringify(work), 'utf8'), readingWorkBinding(check.id));

    let work: Work;
    let ctx: RunContext;
    if (check.state === 'waiting') {
      const begun = await withSystem(deps.db, hh, async (trx) => {
        const docs = await chooseDocuments(trx, reader, check.n, check.include_edited);
        const context = await runContext(trx, hh, reader, true);
        const fresh: Work = { v: 2, docs, rows: [], skipped: 0, tries: 0 };
        const taken = await trx
          .updateTable('reading_check')
          .set({
            state: 'running',
            started_at: new Date(),
            total: docs.length,
            done: 0,
            server_version: deps.serverVersion,
            rules_hash: rulesHash(deps.rulesKey, [context.rules]),
          })
          .where('id', '=', check.id)
          .where('state', '=', 'waiting')
          .executeTakeFirst();
        if (Number(taken.numUpdatedRows) !== 1) return null;
        await trx
          .insertInto('reading_check_sealed')
          .values({
            check_id: check.id,
            household_id: hh,
            member_id: reader.memberId,
            wrapped_by_scope: scope.id,
            work_sealed: seal(fresh),
            misses_sealed: null,
            expires_at: sql<Date>`now() + make_interval(days => ${READING_MISSES_KEEP_DAYS})`,
          })
          .execute();
        return { fresh, context };
      });
      if (!begun) return { next: null };
      work = begun.fresh;
      ctx = begun.context;
      log('a reading check started', { documents: work.docs.length });
    } else {
      const kept = await withSystem(deps.db, hh, async (trx) => {
        const row = await trx
          .selectFrom('reading_check_sealed')
          .select(['work_sealed'])
          .where('check_id', '=', check.id)
          .executeTakeFirst();
        return row?.work_sealed
          ? { sealed: row.work_sealed, context: await runContext(trx, hh, reader, true) }
          : null;
      });
      if (!kept) {
        await stop();
        return { next: null };
      }
      try {
        work = JSON.parse(
          openBytes(scope.key, kept.sealed, readingWorkBinding(check.id)).toString('utf8'),
        ) as Work;
        if (work.v !== 2) throw new Error('an older run');
      } catch {
        // Not to be opened (a key changed since), or of an older run: it cannot go on.
        await stop();
        return { next: null };
      }
      ctx = kept.context;
    }

    /**
     * What is done so far kept, and kept another seven days (R-5): only
     * while it is still running (not cancelled or removed).
     */
    const save = async () =>
      withSystem(deps.db, hh, async (trx) => {
        const still = await trx
          .updateTable('reading_check')
          .set({ done: work.rows.length + work.skipped })
          .where('id', '=', check.id)
          .where('state', '=', 'running')
          .executeTakeFirst();
        if (Number(still.numUpdatedRows) !== 1) return false;
        await trx
          .updateTable('reading_check_sealed')
          .set({
            work_sealed: seal(work),
            expires_at: sql<Date>`now() + make_interval(days => ${READING_MISSES_KEEP_DAYS})`,
          })
          .where('check_id', '=', check.id)
          .execute();
        return true;
      });
    const running = async () =>
      (
        await withSystem(deps.db, hh, (trx) =>
          trx
            .selectFrom('reading_check')
            .select('state')
            .where('id', '=', check.id)
            .executeTakeFirst(),
        )
      )?.state === 'running';

    while (work.rows.length + work.skipped < work.docs.length) {
      if (Date.now() - began >= (opts.runMs ?? READING_RUN_MS)) return { next: 'now' };
      if (!(await running())) return { next: null };
      if (await otherWorkWaiting(deps, hh)) {
        return { next: new Date(Date.now() + READING_YIELD_MS) };
      }
      const next = work.docs[work.rows.length + work.skipped] as Chosen;
      // Cancelled or removed while it reads: let go at once, its tools killed.
      const cancel = new AbortController();
      const watch = setInterval(() => {
        void running().then(
          (still) => {
            if (!still) cancel.abort();
          },
          () => undefined,
        );
      }, opts.cancelPollMs ?? READING_CANCEL_POLL_MS);
      try {
        const out = await readDocument(deps, hh, next, reader, ctx, opts, cancel.signal);
        if (out.kind === 'gone') work.skipped += 1;
        else work.rows.push(out.row);
        work.tries = 0;
      } catch (err) {
        if (err instanceof Cancelled) return { next: null };
        // Any trouble with a document, counted (R-2).
        work.tries += 1;
        deps.log('warn', 'a reading check could not read a document just now', {
          check: check.id,
          tries: work.tries,
        });
        if (await trouble()) return { next: null };
        if (work.tries >= READING_DOC_TRIES) {
          work.skipped += 1;
          work.tries = 0;
        } else {
          if (!(await save())) return { next: null };
          return { next: new Date(Date.now() + READING_AGAIN_MS) };
        }
      } finally {
        clearInterval(watch);
      }
      if (!(await save())) return { next: null };
    }

    // All read: the numbers kept, the misses sealed, what it did let go at once.
    const done = await withSystem(deps.db, hh, async (trx) => {
      const { summary, misses } = scoreWork(work, await expiringKinds(trx));
      const finished = await trx
        .updateTable('reading_check')
        .set({
          state: 'done',
          done: work.rows.length + work.skipped,
          summary: JSON.stringify(summary),
          finished_at: new Date(),
        })
        .where('id', '=', check.id)
        .where('state', '=', 'running')
        .executeTakeFirst();
      if (Number(finished.numUpdatedRows) !== 1) return null;
      await trx
        .updateTable('reading_check_sealed')
        .set({
          work_sealed: null,
          misses_sealed: sealBytes(
            scope.key,
            Buffer.from(JSON.stringify({ v: 1, misses }), 'utf8'),
            readingMissesBinding(check.id),
          ),
          expires_at: sql<Date>`now() + make_interval(days => ${READING_MISSES_KEEP_DAYS})`,
        })
        .where('check_id', '=', check.id)
        .execute();
      return summary;
    });
    if (done) {
      log('a reading check finished', {
        read: done.read,
        skipped: done.skipped,
        needs_typing: done.without_rules.all.needs_typing,
        wrong_ready: done.without_rules.all.wrong_ready,
      });
    }
    return { next: null };
  } catch (err) {
    // Anything else — the database a moment away — counted, and later (R-2).
    deps.log('warn', 'a reading check could not go on just now', {
      check: job.check_id,
      // Its kind alone: a database's message can carry a value.
      err: (err as Error).name,
    });
    if (await trouble()) return { next: null };
    return { next: new Date(Date.now() + READING_AGAIN_MS) };
  } finally {
    if (leased) await release();
  }
}

/**
 * The vault's own measure, for the operator's CLI: the last `n` documents
 * filed through review but the Only me ones, anybody's (the owner's
 * decision, R0 review), read by the general reader alone — no learned
 * rules, and the household's first owner's kinds and family without any
 * Only me issuer — scored, and the numbers given: kept nowhere, and nothing
 * but numbers. With rules is without.
 */
export async function readingCheckNow(
  deps: ReadingCheckDeps,
  hh: string,
  n: number,
  opts: ReadingOptions,
): Promise<ReadingCheckSummary> {
  const prepared = await withSystem(deps.db, hh, async (trx) => {
    const owner = await trx
      .selectFrom('account_household')
      .select(['account_id', 'member_id'])
      .where('household_id', '=', hh)
      .where('role', '=', 'owner')
      .orderBy('joined_at')
      .orderBy('account_id')
      .executeTakeFirst();
    if (!owner) throw new Error('the household has no owner to read as');
    const reader: Reader = {
      accountId: owner.account_id,
      memberId: owner.member_id,
      role: 'owner',
    };
    return {
      docs: await chooseDocuments(trx, null, n, true),
      ctx: await runContext(trx, hh, reader, false),
    };
  });
  const work: Work = { v: 2, docs: prepared.docs, rows: [], skipped: 0, tries: 0 };
  for (const d of work.docs) {
    let out: Outcome | null = null;
    for (let tries = 0; tries < READING_DOC_TRIES && out === null; tries++) {
      try {
        out = await readDocument(deps, hh, d, null, prepared.ctx, opts);
      } catch (err) {
        if (!(err instanceof Again)) throw err;
      }
    }
    if (!out || out.kind === 'gone') work.skipped += 1;
    else work.rows.push(out.row);
  }
  const expiring = await withSystem(deps.db, hh, expiringKinds);
  return scoreWork(work, expiring).summary;
}

/**
 * Each night: misses past their seven days removed; what a check that no
 * longer runs had done so far; and the checks of an owner who is one no
 * longer — gone, or made an adult, a teen or a viewer — whom nobody can
 * ask for (M-2). The owning role, every household at once.
 */
export async function sweepReadingChecks(admin: pg.Pool): Promise<number> {
  const orphans = await admin.query(
    `delete from reading_check c
      where c.member_id is null
         or not exists (select 1 from account_household a
                         where a.household_id = c.household_id and a.member_id = c.member_id
                           and a.account_id = c.requested_by and a.role = 'owner')`,
  );
  const r = await admin.query(
    `delete from reading_check_sealed s
      where s.expires_at <= now()
         or (s.work_sealed is not null
             and not exists (select 1 from reading_check c
                              where c.id = s.check_id and c.state in ('waiting', 'running')))`,
  );
  return (orphans.rowCount ?? 0) + (r.rowCount ?? 0);
}

/**
 * On the worker's start: checks waiting or running whose job was lost —
 * a check never sent, or one a stopped worker held — sent again (R-4).
 * Answers how many.
 */
export async function resumeReadingChecks(
  admin: pg.Pool,
  send: (job: ReadingCheckJob) => Promise<void>,
): Promise<number> {
  const { rows } = await admin.query<{ id: string; household_id: string }>(
    "select id, household_id from reading_check where state in ('waiting', 'running') order by created_at",
  );
  for (const r of rows) await send({ household_id: r.household_id, check_id: r.id });
  return rows.length;
}

/**
 * On the worker's start: the folders documents were read into by a worker
 * that stopped mid-read (P-5), removed — a document's plain bytes, never
 * left behind. Answers how many.
 */
export async function sweepReadingTemp(dir: string = tmpdir()): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(READING_TEMP_PREFIX)) continue;
    await rm(path.join(dir, name), { recursive: true, force: true }).then(
      () => (n += 1),
      () => undefined,
    );
  }
  return n;
}
