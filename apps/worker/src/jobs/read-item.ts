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
 * password, not readable, too slow, a kind not read — never a crash; a
 * worker that stops mid-read leaves the item to be taken again. One item a
 * call: the household's queue (batches.ts) keeps the turn.
 */

/** A read taken this long ago, by a worker that has gone, is taken again. */
export const READ_STALE_MS = 15 * 60_000;
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
}

/** Waiting to be read, or taken by a worker that has gone. */
export const unread = (eb: ExpressionBuilder<Schema, 'incoming_file'>) =>
  eb.or([
    eb('read_state', '=', 'waiting'),
    eb.and([
      eb('read_state', '=', 'reading'),
      eb('read_started_at', '<', new Date(Date.now() - READ_STALE_MS)),
    ]),
  ]);

/** Its pages drawn, or known not to be: read after its preview, never before. */
export const drawnOrNot = (eb: ExpressionBuilder<Schema, 'incoming_file'>) =>
  eb('preview_state', 'not in', ['none', 'drawing']);

const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** One household's next item to read: the oldest drawn and not read. Answers it, and whether more wait. */
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
        .orderBy('received_at')
        .orderBy('id')
        .limit(2)
        .execute(),
    );
  const [next] = await ready();
  if (!next) return { read: null, more: false };
  await readItem(deps, hh, next, opts);
  return { read: next.id, more: (await ready()).length > 0 };
}

/**
 * One item read: taken (stamped), its words taken and proposed for, and both
 * sealed — or why not. Only the read that took it last writes what it read,
 * and only while the item waits: one decided meanwhile keeps nothing.
 * Throws, with the item left to be read again, when the file or the thread
 * cannot be had just now.
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
      .set({ read_state: 'reading', read_started_at: stamp, read_failure: null })
      .where('id', '=', f.id)
      .where('state', '=', 'received')
      .where(unread)
      .executeTakeFirst(),
  );
  if (Number(taken.numUpdatedRows) !== 1) return;
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
  const again = () =>
    withSystem(deps.db, hh, (trx) =>
      ours(trx).set({ read_state: 'waiting', read_started_at: null }).execute(),
    ).catch(() => undefined);

  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-read-'));
  try {
    let had: { fileKey: Buffer; ctx: ProposalContext; plain: Buffer };
    try {
      const got = await withSystem(deps.db, hh, async (trx) => {
        const scopeKey = await deps.keys.unwrapById(trx, f.wrapped_by_scope);
        return {
          fileKey: unwrapKey(f.file_key_wrapped, scopeKey, `incoming:${f.id}`),
          adapter: await adapterOf(trx, deps, f.vault_id),
          ctx: await proposalContext(trx, hh, f.requester_member_id),
        };
      });
      had = { ...got, plain: await decryptToBuffer(got.adapter, f.storage_key, got.fileKey) };
    } catch (err) {
      // Its bytes or its key not to be had just now: read again later.
      await again();
      throw err;
    }
    const mime = f.mime ?? '';
    const ext = mime === 'application/pdf' ? 'pdf' : mime === WORD_MIME ? 'docx' : 'img';
    const source = path.join(dir, `source.${ext}`);
    await writeFile(source, had.plain);
    const tools = opts.tools ?? (await detectTools());

    if (mime === 'application/pdf' && (await pdfLocked(source))) {
      await failed('password');
      return;
    }
    let text: string;
    try {
      const got = await (opts.extract ?? extractText)(source, mime, {
        maxPages: opts.maxPages,
        workDir: dir,
        tools,
      });
      if (!got) {
        await failed('not_read');
        return;
      }
      text = got.text.slice(0, PROPOSAL_TEXT_MAX);
    } catch (err) {
      // A tool that failed on it, or a file that is not what it says. Logged
      // without a word of what it holds.
      deps.log('warn', 'could not read the pages of a batch’s item', {
        item: f.id,
        err: (err as Error).message.slice(0, 200),
      });
      await failed(/password/i.test((err as Error).message) ? 'password' : 'unreadable');
      return;
    }
    if (letters(text) < BLANK_LETTERS) {
      await failed('blank');
      return;
    }
    const answer = await opts.proposer.propose(text, had.ctx);
    if (answer.state === 'unavailable') {
      await again();
      throw new Error('the proposal thread could not be had: the item is read again later');
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
  } finally {
    await rm(dir, { recursive: true, force: true });
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
