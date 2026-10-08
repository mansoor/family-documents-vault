import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { itemProposalsBinding, itemTextBinding, sealBytes, unwrapKey } from '@fdv/crypto';
import { withSystem, type Db, type Schema } from '@fdv/db';
import {
  can,
  householdDateOrder,
  type BatchReadFailure,
  type KnownIssuer,
  type ProposalContext,
  type ProposalKind,
} from '@fdv/shared';
import { StorageError, type StorageAdapter } from '@fdv/storage';
import { sql, type ExpressionBuilder } from 'kysely';
import { extractText } from './extract-text.js';
import { adapterOf, type IncomingDeps } from './incoming.js';
import { decryptToBuffer } from './process-version.js';
import type { ItemProposer } from './proposal-thread.js';
import { detectTools, pdfLocked, type Tools } from './tools.js';
import { WORD_MIME } from './word-text.js';

/**
 * The vault reads each item and suggests (Phase 6, I2): once an item's pages
 * are drawn, the worker takes its words as it takes a filed document's
 * (`extractText`, 5.37: a PDF's own text first, OCR only for a page with
 * none, a Word file's XML, all under FDV_OCR_MAX_PAGES and the tools'
 * limits), and asks `proposeDetails` — on a thread of its own, with a
 * deadline (proposal-thread.ts) — what they say: the kind, whose it is,
 * the dates, the number, who issued it, each with a confidence.
 *
 * As its uploader would be answered, and only so: the kinds the household
 * keeps (a hidden one is never proposed), the family (never a guest), the
 * issuers of the documents the uploader can see (GET /issuers as they get
 * it), the household's name and how it writes dates. Nothing of a document
 * they cannot see — another's Only me, or Adults only for a teen — is
 * read, so no proposal can name it.
 *
 * Both the words and the proposal are sealed under the item's own file key
 * (its uploader's member key wraps it, as it wraps the file): never in a
 * plain column, never in the search index. They go when the item is
 * decided, and with its row. The words kept are the first
 * PROPOSAL_TEXT_MAX characters, what the proposal read; accepted, the
 * document's own pages are read again, as any upload's are.
 *
 * Pages that cannot be read make the item `failed`, with why — blank, a
 * password, not readable, too slow, a kind not read — never a crash, and a
 * read never throws (the I2 review, P-I2-1). Each taking is counted: taken
 * more than READ_ATTEMPTS times — workers that stopped under it, its bytes
 * not there, the proposal thread dying holding it (twice) — it is not read
 * (`unreadable`): one bad item never holds up its household. What is not
 * the item's fault — the vault's storage out of reach, a key, the thread
 * not to be had, the disk, the database — is not counted against it (the
 * I2 check): it waits behind the others, longer each time (30 s, 2 min,
 * 10 min, an hour, then hourly), and only a day after the first such wait
 * is it given up (`not_reachable`). The whole read has a deadline,
 * READ_DEADLINE_MS, its tools killed when it passes (P-I2-2): under the
 * queue's expiry (BATCH_JOB_EXPIRE_SECONDS), itself under READ_STALE_MS, so
 * a read is never taken again while it is still going. A worker that stops
 * mid-read leaves the item to be taken again. One item a call: the
 * household's queue (batches.ts) keeps the turn.
 */

/** The longest one item's read may take, its tools killed then: it is `too_slow`. */
export const READ_DEADLINE_MS = 8 * 60_000;
/**
 * How long the batch job may run before the queue takes it as lost: a page
 * drawing and a read, with room. Above READ_DEADLINE_MS, under READ_STALE_MS.
 */
export const BATCH_JOB_EXPIRE_SECONDS = 14 * 60;
/** A read taken this long ago, by a worker that has gone, is taken again. */
export const READ_STALE_MS = 20 * 60_000;
/** Taken this many times and never finished: it is not read (`unreadable`). */
export const READ_ATTEMPTS = 3;
/** And where the proposal thread died holding it: asked again once. */
export const THREAD_DIED_ATTEMPTS = 2;
/** The most a taking is counted: the column's own bound (0063). */
const ATTEMPTS_MAX = 100;
/** After a read that could not finish through its own fault, how long before it is taken again. */
export const readAgainAfter = (attempts: number) => 30_000 * 2 ** Math.max(0, attempts - 1);
/**
 * After the vault itself could not finish a read (its storage, a key, the
 * thread), how long before it is tried again: 30 s, 2 min, 10 min, an hour,
 * then hourly.
 */
export const waitAgainAfter = (waits: number) => [30_000, 120_000, 600_000][waits - 1] ?? 3_600_000;
/** Waited on the vault this long since the first time, and it is given up: `not_reachable`. */
export const READ_GIVE_UP_MS = 24 * 3_600_000;
/**
 * The most of an item's words kept and proposed from: what proposeDetails
 * reads (its details are on its first pages), and the API's own bound.
 */
export const PROPOSAL_TEXT_MAX = 60_000;
/** Fewer letters and digits than this, in all its pages, and an item is blank. */
export const BLANK_LETTERS = 4;

export type ReadItemDeps = Pick<
  IncomingDeps,
  'db' | 'keys' | 'credentialsKey' | 'localRoot' | 'log'
>;

export interface ReadOptions {
  /** The most pages read of a PDF (FDV_OCR_MAX_PAGES), as a filed document's. */
  maxPages: number;
  /** The proposal thread. */
  proposer: ItemProposer;
  /** How the words are taken: extractText, unless a test stands in. */
  extract?: typeof extractText;
  tools?: Tools;
  /** The read's deadline: READ_DEADLINE_MS, unless a test shortens it. */
  deadlineMs?: number;
}

/**
 * Waiting to be read — and, after a read that could not finish, its wait
 * over — or taken by a worker that has gone.
 */
export const unread = (eb: ExpressionBuilder<Schema, 'incoming_file'>) =>
  eb.or([
    eb.and([
      eb('read_state', '=', 'waiting'),
      eb.or([eb('read_not_before', 'is', null), eb('read_not_before', '<=', new Date())]),
    ]),
    eb.and([
      eb('read_state', '=', 'reading'),
      eb('read_started_at', '<', new Date(Date.now() - READ_STALE_MS)),
    ]),
  ]);

/** Its pages drawn, or known not to be: read after its preview, never before. */
export const drawnOrNot = (eb: ExpressionBuilder<Schema, 'incoming_file'>) =>
  eb('preview_state', 'not in', ['none', 'drawing']);

const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * One household's next item to read: the oldest drawn and not read, an item
 * tried before behind those never tried. Answers it, and whether more wait
 * now. Never throws.
 */
export async function readNextBatchItem(
  deps: ReadItemDeps,
  hh: string,
  opts: ReadOptions,
): Promise<{ read: string | null; more: boolean }> {
  const ready = () =>
    withSystem(deps.db, hh, (trx) =>
      trx
        .selectFrom('incoming_file')
        .select([
          'id',
          'mime',
          'storage_key',
          'vault_id',
          'file_key_wrapped',
          'wrapped_by_scope',
          'requester_member_id',
        ])
        .where('batch_id', 'is not', null)
        .where('state', '=', 'received')
        .where(unread)
        .where(drawnOrNot)
        .orderBy('read_attempts')
        .orderBy('received_at')
        .orderBy('id')
        .limit(2)
        .execute(),
    );
  try {
    const [next] = await ready();
    if (!next) return { read: null, more: false };
    await readItem(deps, hh, next, opts);
    return { read: next.id, more: (await ready()).length > 0 };
  } catch (err) {
    deps.log('warn', 'could not look for a batch’s item to read', {
      household: hh,
      err: (err as Error).message.slice(0, 200),
    });
    return { read: null, more: false };
  }
}

/**
 * Why a read could not be finished, to be tried again later: the item's own
 * doing (`most` takings in all), or the vault's (not counted against it).
 */
class NotNow extends Error {
  constructor(
    readonly why: string,
    readonly whose: 'item' | 'vault',
    readonly most = READ_ATTEMPTS,
  ) {
    super(why);
  }
}

/** A storage failure that is the vault's, not the item's: anything but its object gone. */
const vaultsFault = (err: unknown) => err instanceof StorageError && err.code !== 'not_found';

/**
 * One item read: taken (stamped and counted), its words taken and proposed
 * for, and both sealed — or why not. Only the read that took it last writes
 * what it read, and only while the item waits: one decided meanwhile keeps
 * nothing. Never throws: a read that could not finish waits its turn again,
 * behind the others, and after a few is not read.
 */
export async function readItem(
  deps: ReadItemDeps,
  hh: string,
  f: {
    id: string;
    mime: string | null;
    storage_key: string;
    vault_id: string;
    file_key_wrapped: Buffer;
    wrapped_by_scope: string;
    requester_member_id: string;
  },
  opts: ReadOptions,
): Promise<void> {
  const stamp = new Date();
  const taken = await withSystem(deps.db, hh, (trx) =>
    trx
      .updateTable('incoming_file')
      .set({
        read_state: 'reading',
        read_started_at: stamp,
        read_failure: null,
        read_not_before: null,
        // Counted, never past the column's bound (the I2 check).
        read_attempts: sql<number>`least(read_attempts + 1, ${ATTEMPTS_MAX})`,
      })
      .where('id', '=', f.id)
      .where('state', '=', 'received')
      .where(unread)
      .returning(['read_attempts', 'read_waits', 'read_waited_since'])
      .executeTakeFirst(),
  ).catch((err: unknown) => {
    deps.log('warn', 'could not take a batch’s item to read', {
      item: f.id,
      err: (err as Error).message.slice(0, 200),
    });
    return undefined;
  });
  if (!taken) return;
  const attempts = taken.read_attempts;
  const ours = (trx: Db) =>
    trx
      .updateTable('incoming_file')
      .where('id', '=', f.id)
      .where('state', '=', 'received')
      .where('read_state', '=', 'reading')
      .where('read_started_at', '=', stamp);
  const failed = (why: BatchReadFailure) =>
    withSystem(deps.db, hh, (trx) =>
      ours(trx)
        .set({ read_state: 'failed', read_failure: why, text_sealed: null, proposals_sealed: null })
        .execute(),
    );
  /**
   * Not finished. The item's own doing: tried again later, behind the
   * others — or, tried enough, not read. The vault's: not counted against
   * it, tried again later and later — and a day on, given up.
   */
  const notNow = async (e: NotNow) => {
    deps.log('warn', 'could not finish reading a batch’s item', {
      item: f.id,
      attempts,
      whose: e.whose,
      why: e.why.slice(0, 200),
    });
    if (e.whose === 'item') {
      if (attempts >= e.most) {
        await failed('unreadable');
        return;
      }
      await withSystem(deps.db, hh, (trx) =>
        ours(trx)
          .set({
            read_state: 'waiting',
            read_started_at: null,
            read_not_before: new Date(Date.now() + readAgainAfter(attempts)),
          })
          .execute(),
      );
      return;
    }
    const since = taken.read_waited_since ?? new Date();
    if (Date.now() - since.getTime() >= READ_GIVE_UP_MS) {
      await failed('not_reachable');
      return;
    }
    const waits = Math.min(taken.read_waits + 1, 1000);
    await withSystem(deps.db, hh, (trx) =>
      ours(trx)
        .set({
          read_state: 'waiting',
          read_started_at: null,
          // This taking is not the item's: not counted.
          read_attempts: Math.max(0, attempts - 1),
          read_waits: waits,
          read_waited_since: since,
          read_not_before: new Date(Date.now() + waitAgainAfter(waits)),
        })
        .execute(),
    );
  };

  // Taken too often already — workers that stopped under it, again and
  // again: not read (the I2 check).
  if (attempts > READ_ATTEMPTS) {
    await failed('unreadable').catch(() => undefined);
    return;
  }

  const deadline = AbortSignal.timeout(opts.deadlineMs ?? READ_DEADLINE_MS);
  let dir: string | null = null;
  try {
    let had: { fileKey: Buffer; ctx: ProposalContext; plain: Buffer };
    let got: { fileKey: Buffer; ctx: ProposalContext; adapter: StorageAdapter };
    try {
      got = await withSystem(deps.db, hh, async (trx) => {
        const scopeKey = await deps.keys.unwrapById(trx, f.wrapped_by_scope);
        return {
          fileKey: unwrapKey(f.file_key_wrapped, scopeKey, `incoming:${f.id}`),
          adapter: await adapterOf(trx, deps, f.vault_id),
          ctx: await proposalContext(trx, hh, f.requester_member_id),
        };
      });
    } catch (err) {
      // Its key, the vault's storage or the database not to be had just now.
      throw new NotNow((err as Error).message, 'vault');
    }
    try {
      had = { ...got, plain: await decryptToBuffer(got.adapter, f.storage_key, got.fileKey) };
    } catch (err) {
      // The vault's storage out of reach; or its object gone, or not what
      // was kept — the item's own.
      throw new NotNow((err as Error).message, vaultsFault(err) ? 'vault' : 'item');
    }
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-read-'));
    const mime = f.mime ?? '';
    const ext = mime === 'application/pdf' ? 'pdf' : mime === WORD_MIME ? 'docx' : 'img';
    const source = path.join(dir, `source.${ext}`);
    await writeFile(source, had.plain);
    const tools = opts.tools ?? (await detectTools());

    if (mime === 'application/pdf' && (await pdfLocked(source, deadline))) {
      await failed('password');
      return;
    }
    let text: string;
    try {
      const got = await (opts.extract ?? extractText)(source, mime, {
        maxPages: opts.maxPages,
        workDir: dir,
        tools,
        signal: deadline,
      });
      deadline.throwIfAborted();
      if (!got) {
        await failed('not_read');
        return;
      }
      text = got.text.slice(0, PROPOSAL_TEXT_MAX);
    } catch (err) {
      // Its deadline passed, its tools killed; or a tool that failed on it,
      // or a file that is not what it says. Logged without a word of it.
      deps.log('warn', 'could not read the pages of a batch’s item', {
        item: f.id,
        err: (err as Error).message.slice(0, 200),
      });
      await failed(
        deadline.aborted
          ? 'too_slow'
          : /password/i.test((err as Error).message)
            ? 'password'
            : 'unreadable',
      );
      return;
    }
    if (letters(text) < BLANK_LETTERS) {
      await failed('blank');
      return;
    }
    const answer = await opts.proposer.propose(text, had.ctx);
    if (answer.state === 'unavailable') {
      throw new NotNow('the proposal thread could not be had', 'vault');
    }
    if (answer.state === 'died') {
      throw new NotNow('the proposal thread stopped holding it', 'item', THREAD_DIED_ATTEMPTS);
    }
    if (answer.state === 'too_slow') {
      await failed('too_slow');
      return;
    }
    if (answer.state === 'failed') {
      await failed('unreadable');
      return;
    }
    await withSystem(deps.db, hh, (trx) =>
      ours(trx)
        .set({
          read_state: 'read',
          read_failure: null,
          text_sealed: sealBytes(had.fileKey, Buffer.from(text, 'utf8'), itemTextBinding(f.id)),
          proposals_sealed: sealBytes(
            had.fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal: answer.proposal }), 'utf8'),
            itemProposalsBinding(f.id),
          ),
        })
        .execute(),
    );
    deps.log('info', 'read a batch’s item', {
      item: f.id,
      // What was proposed, by field, never its value.
      proposed: Object.keys(answer.proposal),
    });
  } catch (err) {
    // Anything else — the database a moment away, the disk full — the vault's.
    const e = err instanceof NotNow ? err : new NotNow((err as Error).message, 'vault');
    await notNow(e).catch(() => undefined);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * What an item's words are read against: the uploader's, and only what they
 * may see — the kinds the household keeps (hidden ones marked, and never
 * proposed), the family (never a guest), the issuers of the documents they
 * can see out of the Trash (GET /issuers' rule: an issuer seen only on
 * somebody else's Only me document, or an Adults only one for a teen, is
 * not there), the household's name and how it writes dates.
 */
export async function proposalContext(
  trx: Db,
  hh: string,
  memberId: string,
): Promise<ProposalContext> {
  const me = await trx
    .selectFrom('account_household')
    .select('role')
    .where('household_id', '=', hh)
    .where('member_id', '=', memberId)
    .executeTakeFirst();
  const seesAdults = me ? can(me.role, 'document.see_adults') : false;
  const kinds = await trx
    .selectFrom('effective_document_type')
    .select([
      'key',
      'label',
      'fields',
      'expiry_driver',
      'hidden',
      'core',
      'issued_by_label',
      'short_label',
    ])
    .where('deleted_at', 'is', null)
    .orderBy('key')
    .execute();
  const family = await trx
    .selectFrom('member')
    .select(['id', 'display_name'])
    .where('kind', '=', 'family')
    .orderBy('id')
    .execute();
  const issuers = await sql<{ value: string; count: number; type_keys: string[] }>`
    select mode() within group (order by d.issued_by) as value,
           count(*)::int as count,
           array_remove(array_agg(distinct d.type_key), null) as type_keys
      from document d
     where d.deleted_at is null
       and d.issued_by is not null
       and (d.visibility = 'household'
         or (d.visibility = 'adults' and ${seesAdults})
         or (d.visibility = 'private' and d.owner_member_id = ${memberId}::uuid))
     group by lower(btrim(d.issued_by))
     order by count desc, value
     limit 50`.execute(trx);
  const household = await trx
    .selectFrom('household')
    .select('name')
    .where('id', '=', hh)
    .executeTakeFirst();
  const profile = await trx
    .selectFrom('household_profile')
    .select('country')
    .where('household_id', '=', hh)
    .executeTakeFirst();
  return {
    types: kinds.map(
      (k) =>
        ({
          key: k.key,
          label: k.label,
          fields: (k.fields ?? []) as ProposalKind['fields'],
          expiry_driver: k.expiry_driver,
          hidden: k.hidden,
          core: k.core as NonNullable<ProposalKind['core']>,
          issued_by_label: k.issued_by_label,
          short_label: k.short_label,
        }) satisfies ProposalKind,
    ),
    people: family.map((m) => ({ id: m.id, name: m.display_name })),
    issuers: issuers.rows.map((r): KnownIssuer => ({
      value: r.value,
      count: r.count,
      typeKeys: r.type_keys,
    })),
    household: household?.name ?? null,
    dateOrder: householdDateOrder(profile?.country),
  };
}
