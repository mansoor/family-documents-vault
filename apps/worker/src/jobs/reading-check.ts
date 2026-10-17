import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  READING_MISSES_KEEP_DAYS,
  scoreReading,
  type BatchDefaults,
  type ItemLevel,
  type LearnedContext,
  type LevelKind,
  type ProposalContext,
  type ReadingCheckSummary,
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
import { detectTools, pdfLocked, type Tools } from './tools.js';
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
 * Then, one at a time and behind the household's own batch items, each is
 * read as a batch's item would be (read-item.ts): its current version
 * opened here, its words taken by `extractText` (a PDF's own text, OCR for
 * a page with none, on the same tools and limits), proposed for on the
 * proposal thread (`proposeDetails`) and levelled (`levelItem`) for the
 * owner, with no folder names, no defaults and no current details. Twice:
 * without the learned rules (I4) — the honest number — and with the rules
 * of whoever filed it, read as them, which is optimistic, as those rules
 * were learned from these same papers.
 *
 * What it offered is scored against the document's details now by the
 * Smart exit's own scorer (@fdv/shared reading-score.ts, through
 * scoreReading). What is kept is the numbers (reading_check.summary,
 * numbers only, held by the database too), and which documents needed
 * typing and what, sealed under the asking owner's member key for
 * READING_MISSES_KEEP_DAYS. While it runs, what it has done so far is
 * sealed the same way. Nothing is written to a document, no item, no
 * proposal and no rule is made, and the log says counts, never a document,
 * a word or a value.
 *
 * A document removed, moved to the Trash or no longer the owner's to see
 * as it runs is skipped. Pages that give no words — a password, a scan OCR
 * cannot read, a file the vault does not read, the thread ending on it —
 * are "not read", never a crash. The vault's own trouble (its storage, a
 * key, the thread not to be had) is tried again later, READING_DOC_TRIES
 * times, and then the document is skipped. One check a household at a
 * time (the database's unique index); cancelled or removed by an owner, it
 * stops before the next document.
 */

/** The job's name, as the API sends it (its READING_CHECK_JOB). */
export const READING_CHECK_JOB = 'reading.check';
/** Each night: a check's misses past their seven days removed. */
export const READING_CHECK_SWEEP_JOB = 'reading.check.sweep';
/** One queued and one running a household: the API's readingCheckKey. */
export const readingCheckKey = (householdId: string) => `reading-check:${householdId}`;
/** How long one run reads before it lets the queue go round. */
export const READING_RUN_MS = 60_000;
/** Behind a household's batch items waiting to be read: looked at again after this. */
export const READING_YIELD_MS = 30_000;
/** After the vault's own trouble with a document, tried again after this. */
export const READING_AGAIN_MS = 60_000;
/** The vault's own trouble with one document this many times, and it is skipped. */
export const READING_DOC_TRIES = 3;
/** A run may take this long before the queue takes it as lost: a document's read, with room. */
export const READING_JOB_EXPIRE_SECONDS = 14 * 60;

export interface ReadingCheckJob {
  household_id: string;
  check_id: string;
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
}

/** Whom a check reads as: the owner who asked. */
export interface Reader {
  accountId: string;
  memberId: string;
  role: Role;
}

/** A document chosen: who last filed it through review, and whether it was changed by hand since. */
interface Chosen {
  id: string;
  filed_by: string | null;
  edited: boolean;
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
}

/** What a running check keeps between runs, sealed under the asking owner's key. */
interface Work {
  v: 1;
  docs: Chosen[];
  rows: WorkRow[];
  skipped: number;
  /** The vault's own trouble with the next document so far. */
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
 * is given them (or every one, for the vault's own CLI): out of the Trash,
 * and, without `includeEdited`, none changed by hand since it was filed.
 */
export async function chooseDocuments(
  trx: Db,
  reader: Reader | null,
  n: number,
  includeEdited: boolean,
): Promise<Chosen[]> {
  const pick = (t: Db) =>
    sql<{ document_id: string; filed_at: Date; filed_by: string | null }>`
      select rf.document_id,
             max(rf.filed_at) as filed_at,
             (array_agg(rf.filed_by order by rf.filed_at desc))[1] as filed_by
        from review_filing rf
        join document d on d.id = rf.document_id
       where d.deleted_at is null
         and ${reader ? seenBy(reader) : sql<boolean>`true`}
       group by rf.document_id
       order by max(rf.filed_at) desc, rf.document_id
       limit 500`.execute(t);
  const { rows } = reader ? await readAs(trx, reader, pick) : await pick(trx);
  if (rows.length === 0) return [];
  // Changed by hand since it was filed: a change of its details, after.
  const { rows: changed } = await sql<{ id: string }>`
    select distinct f.id::text as id
      from unnest(${rows.map((r) => r.document_id)}::uuid[],
                  ${rows.map((r) => r.filed_at)}::timestamptz[]) as f(id, at)
      join audit_event a on a.object_type = 'document' and a.object_id = f.id
     where a.action = 'document.updated' and a.at > f.at`.execute(trx);
  const edited = new Set(changed.map((c) => c.id));
  return rows
    .map((r) => ({ id: r.document_id, filed_by: r.filed_by, edited: edited.has(r.document_id) }))
    .filter((r) => includeEdited || !r.edited)
    .slice(0, n);
}

/**
 * "The reader may see document `d`": the visibility rule every list keeps
 * (the API's seenDocument) — everybody's, Adults only for whoever sees
 * them, and their own Only me, never somebody else's. The database gives a
 * signed-in caller every row, and leaves this to the vault; so it is asked
 * here, on top of what readAs gives, every time a document is chosen or read.
 */
const seenBy = (reader: Reader) => sql<boolean>`(d.visibility = 'household'
  or (d.visibility = 'adults' and ${can(reader.role, 'document.see_adults')})
  or (d.visibility = 'private' and d.owner_member_id = ${reader.memberId}::uuid))`;

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

/** What a run reads against: the reader's context, the kinds, the family, and each filer's rules. */
interface RunContext {
  proposal: ProposalContext;
  kinds: LevelKind[];
  people: Array<{ id: string; name: string }>;
  role: Role;
  me: string;
  rules: Map<string, LearnedContext | null>;
}

async function runContext(trx: Db, hh: string, reader: Reader): Promise<RunContext> {
  const proposal = await proposalContext(trx, hh, reader.memberId);
  return {
    proposal,
    kinds: await levelKinds(trx),
    people: proposal.people.map((p) => ({ id: p.id, name: p.name })),
    role: reader.role,
    me: reader.memberId,
    rules: new Map(),
  };
}

/** A filer's own rules (I4), read as them: none for somebody gone, or who no longer adds. */
async function rulesOf(
  trx: Db,
  hh: string,
  ctx: RunContext,
  accountId: string | null,
): Promise<LearnedContext | null> {
  if (!accountId) return null;
  if (ctx.rules.has(accountId)) return ctx.rules.get(accountId) ?? null;
  const who = await trx
    .selectFrom('account_household')
    .select('member_id')
    .where('household_id', '=', hh)
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  const rules = who ? await learnedContext(trx, hh, who.member_id) : null;
  ctx.rules.set(accountId, rules);
  return rules;
}

/**
 * A keyed hash of the rules a check reads with, each filer's own: the same
 * rules give the same twelve characters, and the characters say nothing of
 * them to anybody without the vault's key.
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

/** The vault's own trouble: tried again later, not the document's doing. */
class Again extends Error {}

type Outcome = { kind: 'gone' } | { kind: 'read'; row: WorkRow };

/**
 * One document read, both ways, for the reader: or `gone` — removed, in
 * the Trash, no longer theirs to see, or with no version. Throws Again for
 * the vault's own trouble. Writes nothing.
 */
async function readDocument(
  deps: ReadItemDeps,
  hh: string,
  chosen: Chosen,
  reader: Reader | null,
  ctx: RunContext,
  opts: ReadingOptions,
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
        learned: await rulesOf(trx, hh, ctx, chosen.filed_by),
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
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-check-'));
    const ext = mime === 'application/pdf' ? 'pdf' : mime === WORD_MIME ? 'docx' : 'img';
    const source = path.join(dir, `source.${ext}`);
    await writeFile(source, plain);
    const tools = opts.tools ?? (await detectTools());
    let text: string;
    let mode: 'text' | 'scan' = unreadAs;
    try {
      if (mime === 'application/pdf' && (await pdfLocked(source, deadline))) {
        return row(unreadAs, notRead, notRead);
      }
      const got = await (opts.extract ?? extractText)(source, mime, {
        maxPages: opts.maxPages,
        workDir: dir,
        tools,
        signal: deadline,
      });
      deadline.throwIfAborted();
      if (!got) return row(unreadAs, notRead, notRead);
      mode = got.ocrPages > 0 || got.source === 'ocr' ? 'scan' : 'text';
      text = got.text.slice(0, PROPOSAL_TEXT_MAX);
    } catch {
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
    return row(mode, without, withRules);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether the household's own batch items wait to be read: they go first. */
async function batchReadsWaiting(deps: ReadItemDeps, hh: string): Promise<boolean> {
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
  return row !== undefined;
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

/** The owner who asked, as they are now: none once they are no owner, or gone. */
async function readerOf(
  trx: Db,
  hh: string,
  check: { requested_by: string | null; member_id: string | null },
): Promise<Reader | null> {
  if (!check.requested_by || !check.member_id) return null;
  const who = await trx
    .selectFrom('account_household')
    .select(['account_id', 'member_id', 'role'])
    .where('household_id', '=', hh)
    .where('account_id', '=', check.requested_by)
    .where('member_id', '=', check.member_id)
    .executeTakeFirst();
  if (!who || who.role !== 'owner') return null;
  return { accountId: who.account_id, memberId: who.member_id, role: who.role };
}

/**
 * One run of a check: started if it is waiting (its documents chosen as
 * its owner, sealed), then documents read one after another until the run
 * has had READING_RUN_MS, the household's batch items wait to be read, the
 * vault has trouble, or none are left — then its numbers kept and its
 * misses sealed. Answers when to run again. Never throws: what it cannot
 * finish it says in its row (`failed`, `stopped`).
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
        .set({ state: 'failed', failure: 'stopped', finished_at: new Date() })
        .where('id', '=', job.check_id)
        .where('state', 'in', ['waiting', 'running'])
        .execute();
      await trx.deleteFrom('reading_check_sealed').where('check_id', '=', job.check_id).execute();
    }).catch(() => undefined);
  try {
    const start = await withSystem(deps.db, hh, async (trx) => {
      const check = await trx
        .selectFrom('reading_check')
        .selectAll()
        .where('id', '=', job.check_id)
        .executeTakeFirst();
      if (!check) return null;
      if (check.state !== 'waiting' && check.state !== 'running') {
        // Cancelled: what it had done so far let go.
        await trx
          .deleteFrom('reading_check_sealed')
          .where('check_id', '=', check.id)
          .where('work_sealed', 'is not', null)
          .execute();
        return null;
      }
      return { check, reader: await readerOf(trx, hh, check) };
    });
    if (!start) return { next: null };
    const { check, reader } = start;
    if (!reader) {
      // Its owner is no owner now, or gone: nobody to read as.
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
        const context = await runContext(trx, hh, reader);
        const sets: Array<LearnedContext | null> = [];
        for (const filer of new Set(docs.map((d) => d.filed_by))) {
          sets.push(await rulesOf(trx, hh, context, filer));
        }
        const fresh: Work = { v: 1, docs, rows: [], skipped: 0, tries: 0 };
        const taken = await trx
          .updateTable('reading_check')
          .set({
            state: 'running',
            started_at: new Date(),
            total: docs.length,
            done: 0,
            server_version: deps.serverVersion,
            rules_hash: rulesHash(deps.rulesKey, sets),
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
          ? { sealed: row.work_sealed, context: await runContext(trx, hh, reader) }
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
      } catch {
        // Not to be opened (a key changed since): it cannot go on.
        await stop();
        return { next: null };
      }
      ctx = kept.context;
    }

    /** What is done so far kept: only while it is still running (not cancelled or removed). */
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
          .set({ work_sealed: seal(work) })
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
      if (await batchReadsWaiting(deps, hh)) {
        return { next: new Date(Date.now() + READING_YIELD_MS) };
      }
      const next = work.docs[work.rows.length + work.skipped] as Chosen;
      try {
        const out = await readDocument(deps, hh, next, reader, ctx, opts);
        if (out.kind === 'gone') work.skipped += 1;
        else work.rows.push(out.row);
        work.tries = 0;
      } catch (err) {
        if (!(err instanceof Again)) throw err;
        work.tries += 1;
        deps.log('warn', 'a reading check could not read a document just now', {
          check: check.id,
          tries: work.tries,
        });
        if (work.tries >= READING_DOC_TRIES) {
          work.skipped += 1;
          work.tries = 0;
        } else {
          if (!(await save())) return { next: null };
          return { next: new Date(Date.now() + READING_AGAIN_MS) };
        }
      }
      if (!(await save())) return { next: null };
    }

    // All read: the numbers kept, the misses sealed, what it did let go.
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
    // Anything else — the database a moment away — later, as the vault's.
    deps.log('warn', 'a reading check could not go on just now', {
      check: job.check_id,
      // Its kind alone: a database's message can carry a value.
      err: (err as Error).name,
    });
    return { next: new Date(Date.now() + READING_AGAIN_MS) };
  }
}

/**
 * The vault's own measure, for the operator's CLI: the last `n` documents
 * filed through review, every one (it is the vault itself asking), read as
 * the household's first owner would read them, scored, and the numbers
 * given — kept nowhere, and nothing but numbers.
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
      ctx: await runContext(trx, hh, reader),
    };
  });
  const work: Work = { v: 1, docs: prepared.docs, rows: [], skipped: 0, tries: 0 };
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
 * Each night: misses past their seven days removed, and what a check that
 * no longer runs had done so far (the owning role, every household at once).
 */
export async function sweepReadingChecks(admin: pg.Pool): Promise<number> {
  const r = await admin.query(
    `delete from reading_check_sealed s
      where s.expires_at <= now()
         or (s.work_sealed is not null
             and not exists (select 1 from reading_check c
                              where c.id = s.check_id and c.state in ('waiting', 'running')))`,
  );
  return r.rowCount ?? 0;
}

/**
 * On the worker's start: checks waiting or running whose job was lost, sent
 * again. Answers how many.
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
