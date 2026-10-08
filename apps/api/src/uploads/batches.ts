import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DecryptStream,
  EncryptStream,
  newKey,
  unwrapKey,
  wrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import { withPrincipal, type Db } from '@fdv/db';
import {
  BATCH_MAX_FILES,
  BATCH_NAME_MAX,
  batchVisibility,
  can,
  dropFileName,
  INCOMING_KEEP_DAYS,
  incomingFileName,
  lockInEffect,
  PREVIEW_MAX_PAGES,
  PRIVATE_TO_THEM,
  refusalFor,
  seesLocation,
  type BatchAccepted,
  type BatchAcceptInput,
  type BatchCounts,
  type BatchDefaults,
  type BatchDetail,
  type BatchDuplicate,
  type BatchInput,
  type BatchItemView,
  type BatchReadState,
  type BatchView,
  type CaptureMetadata,
  type IncomingPreviewState,
  type Visibility,
} from '@fdv/shared';
import { deleteAll, readAll, type StorageAdapter } from '@fdv/storage';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { CollectionService } from '../collections/service.js';
import {
  seenDocument,
  sniffStream,
  type DocumentService,
  type Enqueue,
} from '../documents/service.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { incomingPreviewKey } from './incoming.js';

/**
 * Many documents at once (Phase 6, I1).
 *
 * Somebody who may add documents makes a batch — a name, and defaults
 * that fill only what is blank (the owner's decision Q4) — and sends its
 * files to it one request at a time, up to BATCH_MAX_FILES. Each file is an
 * item: an incoming file (0044, 0047) that names its batch, not a request,
 * encrypted from its first byte under the uploader's own member key, its
 * pages drawn by the worker one at a time a household (`batch.previews`).
 * It waits in the uploader's Inbox until they accept it — filed as a
 * document through the commit every upload goes through
 * (DocumentService.fileIncoming), with every detail the single add's card
 * takes, and a collection — or remove it, which removes its bytes as a
 * refused file's are. What nobody decides is removed with its batch, 30
 * days after the batch was made, by the worker's daily sweep.
 *
 * Who: only the uploader (Q3). The database keeps a batch and its items to
 * the member who made them, while they may add documents (0062): another
 * adult, an owner, a teen, a viewer and a guest are given nothing — no
 * batch, no item, no count. Until an item is accepted there is no line in
 * the activity log either: filed, it is a document's lines, as any new
 * document's are. A viewer or a guest is refused (403), as adding is.
 *
 * Duplicates by SHA-256: of a document the uploader can see — never one
 * they cannot, which would say another person's Only me document exists —
 * or of another of their own items waiting, sent before it. Worked out as
 * it is asked, so a document made Only me since is no longer named.
 *
 * The order every decision takes its locks in, as a file sent in does
 * (incoming.ts): the uploader's own membership (shared), the batch, the
 * item, then the document and its collection, and the activity log last.
 */

/** The worker's job (apps/worker/src/queue.ts JOBS.batchPreviews): the names match. */
export const BATCH_PREVIEWS_JOB = 'batch.previews';
/** One queued and one being drawn a household: a batch of 200 never starves the rest. */
export const batchPreviewsKey = (householdId: string) => `batch-previews:${householdId}`;
/** The worker's job for a version's page count, thumbnail and OCR. */
const VERSION_PROCESS_JOB = 'version.process';
/** And the leftovers of a removal the vault finishes (purge.leftovers). */
const PURGE_LEFTOVERS_JOB = 'purge.leftovers';

const DAY = 864e5;

/** An upload whose bytes have stopped arriving this long ago holds no place in its batch. */
const UPLOAD_FRESH_MS = 15 * 60_000;

const defaultsBody = z
  .object({
    owner_member_id: z.string().uuid().nullable(),
    type_key: z.string().min(1).max(64).nullable(),
    visibility: z.enum(['household', 'adults', 'private']).nullable(),
    physical_location: z.string().max(500).nullable(),
    collection_id: z.string().uuid().nullable(),
    tags: z.array(z.string().max(40)).max(50),
    is_essential: z.boolean(),
  })
  .partial()
  .strict();

export const batchBody = z
  .object({
    name: z.string().max(200).nullable(),
    defaults: defaultsBody,
  })
  .partial()
  .strict();

export interface BatchUpload {
  filename: string;
  /**
   * The uploader's Idempotency-Key for this file, when they sent one: a
   * file sent again after its answer was lost is answered with the item it
   * made, not made twice (the I1 review).
   */
  idempotencyKey?: string;
  /** What the browser said it is: only Word and Excel are taken at its word, as a single add's. */
  mime: string;
  stream: Readable;
  /** True when the multipart parser cut the file off at the size limit. */
  truncated: () => boolean;
  /** Once the file has arrived: the route's last chance to refuse (anything sent after it). */
  finished: () => Promise<void>;
}

const notHere = () => new ApiError(404, 'not_found', 'That batch is not here.');
const noItem = () => new ApiError(404, 'not_found', 'That file is not waiting in this batch.');
const decidedAlready = () =>
  new ApiError(409, 'already_decided', 'This file has been accepted or removed already.');
const refused = () => new ApiError(403, 'forbidden', refusalFor('document.add'));
const inProgress = () =>
  new ApiError(
    409,
    'upload_in_progress',
    'This file is already on its way. Trying again in a moment.',
    {
      retriable: true,
      retryAfter: 5,
    },
  );
const busy = () =>
  new ApiError(503, 'busy', 'The vault was busy just then. Try again.', {
    retriable: true,
    retryAfter: 1,
  });
const tooLarge = () => new ApiError(413, 'too_large', 'That file is too big for this vault.');
const storageUnreachable = (detail: string) =>
  new ApiError(
    503,
    'storage_unreachable',
    "We can't reach where your files are kept. That file was not saved; try it again.",
    { detail, retriable: true, retryAfter: 30 },
  );
const invalid = (message: string, detail: string) =>
  new ApiError(422, 'validation_failed', message, { detail });

/** Every page there could be of an item: PREVIEW_MAX_PAGES of them, drawn or not. */
const pageKeys = (storageKey: string) =>
  Array.from({ length: PREVIEW_MAX_PAGES }, (_, i) => incomingPreviewKey(storageKey, i + 1));

interface BatchRow {
  id: string;
  name: string | null;
  created_at: Date;
  ends_at: Date;
  default_owner_member_id: string | null;
  default_type_key: string | null;
  default_visibility: Visibility | null;
  default_physical_location: string | null;
  default_collection_id: string | null;
  default_tags: string[];
  default_essential: boolean;
}

interface ItemRow {
  id: string;
  batch_id: string | null;
  batch_name: string | null;
  batch_created_at: Date;
  original_name: string | null;
  mime: string | null;
  byte_size: string | number | null;
  sha256: Buffer | null;
  received_at: Date | null;
  state: string;
  read_state: string | null;
  preview_state: string;
  preview_pages: number | null;
  document_id: string | null;
  document_seen: boolean | null;
}

const BATCH_COLUMNS = [
  'b.id',
  'b.name',
  'b.created_at',
  'b.ends_at',
  'b.default_owner_member_id',
  'b.default_type_key',
  'b.default_visibility',
  'b.default_physical_location',
  'b.default_collection_id',
  'b.default_tags',
  'b.default_essential',
] as const;

export interface BatchOptions {
  /** A batch's removal, held once it is fenced and before its rows go (the I1 review): for the races. */
  betweenRemoval?: (batchId: string) => Promise<void>;
}

export class BatchService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    private readonly documents: DocumentService,
    private readonly collections: CollectionService,
    private readonly maxUploadBytes: number,
    private readonly enqueue: Enqueue = async () => undefined,
    private readonly opts: BatchOptions = {},
  ) {}

  /** The most one file may be: a single add's limit (FDV_MAX_UPLOAD_BYTES). */
  get fileLimit(): number {
    return this.maxUploadBytes;
  }

  /** Only whoever may add documents: a viewer or a guest is refused, as adding is. */
  private mayAdd(p: Principal): void {
    if (!can(p.role, 'document.add')) throw refused();
  }

  /**
   * The uploader as they are now, held until the change commits: a role
   * changed, a sign-in taken away or locked (5.28) waits for it, and it for
   * them. One who can no longer add documents is refused as anybody else
   * who cannot.
   */
  private async stillAdds(trx: Db, p: Principal): Promise<void> {
    const me = await trx
      .selectFrom('account_household')
      .select(['role', 'suspended_at', 'suspended_until', 'suspend_reason'])
      .where('account_id', '=', p.accountId)
      .where('household_id', '=', p.householdId)
      .forShare()
      .executeTakeFirst();
    if (!me || !can(me.role, 'document.add') || lockInEffect(me)) throw refused();
    // The database answers this transaction as the role it was asked with.
    if (me.role !== p.role) throw busy();
  }

  // ------------------------------------------------------------- batches

  /** POST /batches: a batch of the caller's own, with its defaults. */
  async create(p: Principal, input: BatchInput, _meta: RequestMeta): Promise<BatchDetail> {
    this.mayAdd(p);
    const id = await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      const defaults = await this.checkedDefaults(trx, p, input.defaults ?? {}, null);
      const now = new Date();
      const row = await trx
        .insertInto('intake_batch')
        .values({
          household_id: p.householdId,
          created_by: p.accountId,
          member_id: p.memberId,
          name: nameOf(input.name),
          ...defaults,
          created_at: now,
          ends_at: new Date(now.getTime() + INCOMING_KEEP_DAYS * DAY),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    return this.get(p, id);
  }

  /**
   * GET /batches: the caller's own batches, newest first. Nobody else's,
   * ever. Their counts are counted by the database (the I1 review): a
   * duplicate, as an item's page says one — of a document the caller can
   * see out of the Trash, or of one of their own items waiting, sent before
   * it — found once an item, never item against item.
   */
  async list(p: Principal): Promise<BatchView[]> {
    this.mayAdd(p);
    return withPrincipal(this.db, p, async (trx) => {
      const batches = await trx
        .selectFrom('intake_batch as b')
        .select(BATCH_COLUMNS)
        .orderBy('b.created_at', 'desc')
        .orderBy('b.id')
        .execute();
      if (batches.length === 0) return [];
      const ids = batches.map((b) => b.id);
      // Every batch of theirs is here, so their waiting items are too: an
      // item sent after another with the same bytes is ranked after it.
      const counted = await sql<{
        batch_id: string;
        items: string;
        waiting: string;
        accepted: string;
        duplicates: string;
      }>`
        select w.batch_id,
               count(*) as items,
               count(*) filter (where w.state = 'received') as waiting,
               count(*) filter (where w.state = 'accepted') as accepted,
               count(*) filter (
                 where w.state = 'received' and w.sha256 is not null
                   and (w.nth > 1
                        or exists (select 1
                                     from document_version v
                                     join document d on d.id = v.document_id
                                    where v.household_id = ${p.householdId}::uuid
                                      and v.sha256 = w.sha256
                                      and d.deleted_at is null
                                      and ${seenDocument(p)}))
               ) as duplicates
          from (select f.batch_id, f.state, f.sha256,
                       row_number() over (partition by f.state, f.sha256
                                          order by f.received_at, f.id) as nth
                  from incoming_file f
                 where f.batch_id = any(${ids}::uuid[])
                   and f.requester_member_id = ${p.memberId}::uuid
                   and f.state in ('received', 'accepted')) w
         group by w.batch_id`.execute(trx);
      const by = new Map(counted.rows.map((c) => [c.batch_id, c]));
      return batches.map((b) => {
        const c = by.get(b.id);
        return this.view(p, b, {
          items: Number(c?.items ?? 0),
          waiting: Number(c?.waiting ?? 0),
          accepted: Number(c?.accepted ?? 0),
          duplicates: Number(c?.duplicates ?? 0),
        });
      });
    });
  }

  /** GET /batches/{id}: one of the caller's batches, and its items not removed, oldest first. */
  async get(p: Principal, id: string): Promise<BatchDetail> {
    this.mayAdd(p);
    return withPrincipal(this.db, p, async (trx) => {
      const b = await this.batch(trx, id);
      const items = await this.itemsOf(trx, p, [b.id]);
      return { ...this.view(p, b, countsOf(items)), items };
    });
  }

  /** PATCH /batches/{id}: its name and defaults, each as sent; what is not sent stays. */
  async update(p: Principal, id: string, input: BatchInput, _meta: RequestMeta) {
    this.mayAdd(p);
    await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      const b = await this.batch(trx, id, true);
      const defaults = await this.checkedDefaults(trx, p, input.defaults ?? {}, b);
      const set = {
        ...(input.name !== undefined ? { name: nameOf(input.name) } : {}),
        ...defaults,
      };
      // Nothing sent: nothing changes.
      if (Object.keys(set).length === 0) return;
      await trx.updateTable('intake_batch').set(set).where('id', '=', b.id).execute();
    });
    return this.get(p, id);
  }

  /**
   * DELETE /batches/{id}: what is undecided in it removed, its bytes and
   * pages as a refused file's are; and the batch with it. What was accepted
   * is a document already, and stays one.
   *
   * Fenced first (the I1 review): its end is brought to now, so nothing
   * more is let in — by this API (`batch_ended`) or by the database's own
   * rule — while what is in it is removed. A file on its way is stopped:
   * its row goes now, and its bytes after (its own sending, finding no row,
   * removes them too). Then, held again, anything still undecided is taken
   * with it before the batch goes; and a row that goes before its bytes are
   * known to be gone leaves them to purge_leftover (0047, 0062).
   */
  async remove(p: Principal, id: string, _meta: RequestMeta): Promise<void> {
    this.mayAdd(p);
    const first = await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      const b = await this.batch(trx, id, true);
      await trx
        .updateTable('intake_batch')
        .set({ ends_at: sql<Date>`least(ends_at, now())` })
        .where('id', '=', b.id)
        .execute();
      return this.undecidedOut(trx, p, b.id);
    });
    await this.removeAll(p, first);
    await this.opts.betweenRemoval?.(id);
    const last = await withPrincipal(this.db, p, async (trx) => {
      // Held again: whatever got in after all is taken with it.
      const held = await trx
        .selectFrom('intake_batch')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!held) return { out: { rejected: [], stopped: [] }, owed: 0 };
      const out = await this.undecidedOut(trx, p, id);
      // The rows of what was decided in it: an item whose bytes could not
      // be removed leaves them to be removed with the rest of a removal's
      // leftovers (0047's incoming_file_leaves_bytes), now.
      const left = await trx
        .selectFrom('incoming_file')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('batch_id', '=', id)
        .where('state', 'in', ['accepted', 'rejected'])
        .where('object_removed_at', 'is', null)
        .executeTakeFirstOrThrow();
      await trx.deleteFrom('intake_batch').where('id', '=', id).execute();
      return { out, owed: Number(left.n) + out.stopped.length };
    });
    await this.removeAll(p, last.out);
    if (last.owed > 0 || first.stopped.length > 0) {
      await this.enqueue(
        PURGE_LEFTOVERS_JOB,
        { household_id: p.householdId },
        { singletonKey: `purge.leftovers:${p.householdId}` },
      ).catch(() => undefined);
    }
  }

  /**
   * What is undecided in a held batch, taken out of it: a file on its way,
   * its row gone (its bytes owed to purge_leftover until they are removed);
   * a file waiting, removed as a refused file is — its name and hash gone.
   */
  private async undecidedOut(trx: Db, p: Principal, batchId: string) {
    const stopped = await trx
      .deleteFrom('incoming_file')
      .where('batch_id', '=', batchId)
      .where('state', '=', 'uploading')
      .returning(['id', 'storage_key', 'vault_id'])
      .execute();
    const rejected = await trx
      .updateTable('incoming_file')
      .set({
        state: 'rejected',
        decided_by: p.accountId,
        decided_at: new Date(),
        original_name: null,
        sender_note: null,
        sha256: null,
        proposals_sealed: null,
      })
      .where('batch_id', '=', batchId)
      .where('state', '=', 'received')
      .returning(['id', 'storage_key', 'vault_id'])
      .execute();
    return { stopped, rejected };
  }

  /** Their bytes and pages, once what took them out has committed. */
  private async removeAll(
    p: Principal,
    out: {
      stopped: Array<{ id: string; storage_key: string; vault_id: string }>;
      rejected: Array<{ id: string; storage_key: string; vault_id: string }>;
    },
  ): Promise<void> {
    for (const f of out.rejected) await this.removeObjects(p, f);
    for (const f of out.stopped) {
      try {
        const adapter = await withPrincipal(this.db, p, (trx) =>
          this.vaults.adapterById(trx, f.vault_id),
        );
        await adapter.delete(f.storage_key);
      } catch {
        // Owed to purge_leftover already (0062): removed with the rest.
      }
    }
  }

  // --------------------------------------------------------------- items

  /**
   * POST /batches/{id}/items: one file into one of the caller's batches,
   * before its end, while it holds fewer than BATCH_MAX_FILES (a 201st is
   * `422 batch_full`), within the vault's size limit for a file (413), of
   * a kind a single add takes (415). Its row is made first, on its way, and
   * holds its place, so files sent at once never pass the limit together;
   * then its bytes, sniffed and counted as they come, encrypted under the
   * uploader's own member key straight to its object; then it is finished
   * and the worker asked to draw its pages. Refused anywhere, its object
   * and its row go.
   *
   * With an Idempotency-Key (the I1 review): a file sent again with the key
   * of one that arrived is answered with the item it made, `replayed`, and
   * nothing more is kept; one still on its way is `409 upload_in_progress`;
   * one removed since, `409 already_decided`.
   */
  async addItem(
    p: Principal,
    batchId: string,
    upload: BatchUpload,
    _meta: RequestMeta,
  ): Promise<{ item: BatchItemView; replayed: boolean }> {
    this.mayAdd(p);
    const dead: Array<{ id: string; storage_key: string; vault_id: string }> = [];
    const ctx = await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      // Held: what is counted against the limit cannot change under it.
      const b = await this.batch(trx, batchId, true);
      const key = upload.idempotencyKey ?? null;
      if (key) {
        const prior = await trx
          .selectFrom('incoming_file')
          .select(['id', 'state', 'created_at', 'storage_key', 'vault_id'])
          .where('batch_id', '=', b.id)
          .where('idempotency_key', '=', key)
          .executeTakeFirst();
        if (prior?.state === 'received' || prior?.state === 'accepted') {
          const [item] = (await this.itemsOf(trx, p, [b.id])).filter((i) => i.id === prior.id);
          if (!item) throw notHere();
          return { replay: item } as const;
        }
        if (prior?.state === 'rejected') throw decidedAlready();
        if (prior?.state === 'uploading') {
          if (prior.created_at.getTime() > Date.now() - UPLOAD_FRESH_MS) throw inProgress();
          // A try that died on its way: gone, and this one in its place.
          await trx.deleteFrom('incoming_file').where('id', '=', prior.id).execute();
          dead.push(prior);
        }
      }
      if (b.ends_at.getTime() <= Date.now()) {
        throw new ApiError(
          409,
          'batch_ended',
          'This batch has ended: what was not accepted in it has been removed. Start a new one.',
        );
      }
      const taken = await trx
        .selectFrom('incoming_file')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('batch_id', '=', b.id)
        .where((eb) =>
          eb.or([
            eb('state', 'in', ['received', 'accepted']),
            eb.and([
              eb('state', '=', 'uploading'),
              eb('created_at', '>', new Date(Date.now() - UPLOAD_FRESH_MS)),
            ]),
          ]),
        )
        .executeTakeFirstOrThrow();
      if (Number(taken.n) >= BATCH_MAX_FILES) {
        throw new ApiError(
          422,
          'batch_full',
          `A batch holds ${BATCH_MAX_FILES} files at most. Start another batch for the rest.`,
        );
      }
      const active = await this.vaults.activeAdapter(trx, p.householdId);
      const scopeKey = await this.keys.unwrap(trx, {
        householdId: p.householdId,
        kind: 'member',
        memberId: p.memberId,
      });
      const fileKey = newKey();
      const fileId = randomUUID();
      const row = await trx
        .insertInto('incoming_file')
        .values({
          id: fileId,
          household_id: p.householdId,
          request_id: null,
          batch_id: b.id,
          review_by: 'me',
          requester_member_id: p.memberId,
          original_name: dropFileName(upload.filename),
          // The object's name says nothing about the file.
          storage_key: `${p.householdId}/batches/${b.id}/${randomBytes(16).toString('hex')}.enc`,
          vault_id: active.vaultId,
          // Bound to the item it is for: a wrapped key copied to another row does not open.
          file_key_wrapped: wrapKey(fileKey, scopeKey.key, `incoming:${fileId}`),
          wrapped_by_scope: scopeKey.id,
          scope: 'member',
          // The family's own file: this vault scans nothing (A42).
          scan_state: 'unscanned',
          read_state: 'waiting',
          idempotency_key: key,
        })
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      return { fileId: row.id, key: row.storage_key, adapter: active.adapter, fileKey };
    });
    if (dead.length > 0) await this.removeAll(p, { stopped: dead, rejected: [] });
    if ('replay' in ctx) return { item: ctx.replay, replayed: true };

    const discard = async () => {
      await ctx.adapter.delete(ctx.key).catch(() => undefined);
      await withPrincipal(this.db, p, (trx) =>
        trx
          .deleteFrom('incoming_file')
          .where('id', '=', ctx.fileId)
          .where('state', '=', 'uploading')
          .execute(),
      ).catch(() => undefined);
    };

    // The kinds a single add takes, told from the bytes as they flow; the
    // plain bytes counted and hashed on the way in.
    const sniffer = sniffStream(upload.mime, upload.filename);
    const plainHash = createHash('sha256');
    let bytes = 0;
    const counted = new PassThrough();
    counted.on('data', (chunk: Buffer) => {
      plainHash.update(chunk);
      bytes += chunk.length;
      if (bytes > this.maxUploadBytes) counted.destroy(tooLarge());
    });
    const enc = new EncryptStream(ctx.fileKey);
    const storing = ctx.adapter.put(ctx.key, enc);
    const flowing = pipeline(upload.stream, sniffer.stream, counted, enc);
    let put: { bytes: number; sha256: string };
    let mime: string;
    try {
      const [stored, , detected] = await Promise.all([storing, flowing, sniffer.detected]);
      put = stored;
      mime = detected.mime;
      if (upload.truncated()) throw tooLarge();
      await upload.finished();
    } catch (err) {
      enc.destroy();
      await Promise.allSettled([storing, flowing]);
      await discard();
      if (err instanceof ApiError) throw err;
      throw storageUnreachable((err as Error).message);
    }

    let view: BatchItemView;
    try {
      view = await withPrincipal(this.db, p, async (trx) => {
        const now = new Date();
        const done = await trx
          .updateTable('incoming_file')
          .set({
            state: 'received',
            mime,
            byte_size: bytes,
            sha256: plainHash.digest(),
            cipher_bytes: put.bytes,
            cipher_sha256: Buffer.from(put.sha256, 'hex'),
            received_at: now,
            submitted_at: now,
          })
          .where('id', '=', ctx.fileId)
          .where('state', '=', 'uploading')
          .returning('id')
          .executeTakeFirst();
        // Its batch removed as it arrived: nothing to put it in.
        if (!done) throw notHere();
        const [item] = (await this.itemsOf(trx, p, [batchId])).filter((i) => i.id === ctx.fileId);
        if (!item) throw notHere();
        return item;
      });
    } catch (err) {
      await discard();
      throw err;
    }
    // Its pages, drawn one at a time a household: queued once, whatever is
    // already waiting (the worker's `stately` queue keeps one per key).
    await this.enqueue(
      BATCH_PREVIEWS_JOB,
      { household_id: p.householdId },
      { singletonKey: batchPreviewsKey(p.householdId) },
    ).catch(() => undefined);
    return { item: view, replayed: false };
  }

  /**
   * DELETE /batches/{id}/items/{itemId}: removed, as a refused file is —
   * its bytes and pages go, and so do its name and its hash. What stays,
   * until the batch goes, is that a file of that kind and size was in it.
   */
  async removeItem(p: Principal, batchId: string, itemId: string, _meta: RequestMeta) {
    this.mayAdd(p);
    const f = await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      await this.batch(trx, batchId);
      const f = await this.waiting(trx, batchId, itemId);
      const decided = await trx
        .updateTable('incoming_file')
        .set({
          state: 'rejected',
          decided_by: p.accountId,
          decided_at: new Date(),
          original_name: null,
          sender_note: null,
          sha256: null,
          proposals_sealed: null,
        })
        .where('id', '=', f.id)
        .where('state', '=', 'received')
        .executeTakeFirst();
      if (Number(decided.numUpdatedRows) !== 1) throw decidedAlready();
      return f;
    });
    await this.removeObjects(p, f);
  }

  /**
   * POST /batches/{id}/items/{itemId}/accept: filed as a new document,
   * through the commit every upload goes through, with every detail the
   * single add's card takes — a detail not sent takes the batch's default
   * (Q4) — checked as a capture's are: the person, the kind, its fields,
   * Only me for one's own only, never Adults only for a teen, a teen's own.
   * Its key is unwrapped from the uploader's and wrapped for the document;
   * its bytes copied to where versions are kept. In the same transaction it
   * goes in the collection named, which must be one the uploader may add
   * to. Its pages are read for search once it has committed (version.process),
   * sealed if it is Only me, exactly as a single add's.
   */
  async accept(
    p: Principal,
    batchId: string,
    itemId: string,
    input: BatchAcceptInput,
    meta: RequestMeta,
  ): Promise<BatchAccepted> {
    this.mayAdd(p);
    const placed: { key: string | null; vaultId: string | null } = { key: null, vaultId: null };
    let out: {
      file: { id: string; storage_key: string; vault_id: string };
      documentId: string;
      versionId: string;
      warnings: string[];
    };
    try {
      out = await withPrincipal(this.db, p, async (trx) => {
        await this.stillAdds(trx, p);
        const b = await this.batch(trx, batchId);
        const f = await this.waiting(trx, batchId, itemId, true);
        const { collection_id: sentCollection, ...sent } = input;
        const metadata = await this.filled(trx, p, sent, b);
        const collectionId =
          sentCollection !== undefined ? sentCollection : b.default_collection_id;
        placed.vaultId = f.vault_id;
        const scopeKey = await this.keys.unwrapById(trx, f.wrapped_by_scope);
        const fileKey = unwrapKey(f.file_key_wrapped, scopeKey, `incoming:${f.id}`);
        const mime = f.mime ?? 'application/octet-stream';
        const version = await this.documents.fileIncoming(
          trx,
          p,
          {
            target: { kind: 'capture', metadata },
            file: {
              filename: incomingFileName(f.original_name ?? 'file', mime),
              mime,
              bytes: Number(f.byte_size ?? 0),
              sha256: f.sha256 as Buffer,
              cipherBytes: Number(f.cipher_bytes ?? 0),
              cipherSha256: f.cipher_sha256 as Buffer,
              storageKey: f.storage_key,
              vaultId: f.vault_id,
              fileKey,
            },
            placed,
          },
          meta,
        );
        const warnings = collectionId
          ? await this.collections.addWithin(trx, p, collectionId, [version.document_id], meta)
          : [];
        const decided = await trx
          .updateTable('incoming_file')
          .set({
            state: 'accepted',
            decided_by: p.accountId,
            decided_at: new Date(),
            document_id: version.document_id,
            version_id: version.id,
            proposals_sealed: null,
          })
          .where('id', '=', f.id)
          .where('state', '=', 'received')
          .executeTakeFirst();
        // Held since it was read: anything else is a rule that said no.
        if (Number(decided.numUpdatedRows) !== 1) throw decidedAlready();
        return { file: f, documentId: version.document_id, versionId: version.id, warnings };
      });
    } catch (err) {
      if (placed.key && placed.vaultId) {
        await this.dropCopy(p, { fileId: itemId, vaultId: placed.vaultId, key: placed.key });
      }
      throw err;
    }
    await this.removeObjects(p, out.file);
    // The version's page count, thumbnail and OCR — sealed if it is Only
    // me — only now it is filed, as a single add's.
    await this.enqueue(VERSION_PROCESS_JOB, {
      household_id: p.householdId,
      version_id: out.versionId,
    }).catch(() => undefined);
    return {
      document_id: out.documentId,
      version_id: out.versionId,
      ...(out.warnings.length > 0 ? { warnings: out.warnings } : {}),
    };
  }

  /**
   * GET /batches/{id}/items/{itemId}/pages/{n}: a page the worker drew, a
   * JPEG decrypted here. Not drawn yet, `preview_pending`; a kind it does
   * not draw, or a page past what it drew, `no_preview`.
   */
  async page(p: Principal, batchId: string, itemId: string, n: number): Promise<Buffer> {
    this.mayAdd(p);
    const out = await withPrincipal(this.db, p, async (trx) => {
      await this.batch(trx, batchId);
      const f = await this.waiting(trx, batchId, itemId);
      const state = previewState(f.preview_state);
      if (state === 'pending') return { kind: 'pending' } as const;
      if (state !== 'ready' || n > PREVIEW_MAX_PAGES || n > (f.preview_pages ?? 0)) {
        return { kind: 'none' } as const;
      }
      const scopeKey = await this.keys.unwrapById(trx, f.wrapped_by_scope);
      return {
        kind: 'ready',
        key: incomingPreviewKey(f.storage_key, n),
        fileKey: unwrapKey(f.file_key_wrapped, scopeKey, `incoming:${f.id}`),
        adapter: await this.vaults.adapterById(trx, f.vault_id),
      } as const;
    });
    if (out.kind === 'pending') {
      throw new ApiError(
        404,
        'preview_pending',
        'The preview is being made. Try again in a moment.',
        {
          retriable: true,
          retryAfter: 3,
        },
      );
    }
    if (out.kind === 'none') {
      throw new ApiError(404, 'no_preview', "There's no preview of this page.");
    }
    const dec = new DecryptStream(out.fileKey);
    const [, plain] = await Promise.all([
      pipeline(await out.adapter.get(out.key), dec),
      readAll(dec),
    ]);
    return plain;
  }

  // ----------------------------------------------------------- internals

  /** One of the caller's batches (the database gives no other), or not here. Held, with `hold`. */
  private async batch(trx: Db, id: string, hold = false): Promise<BatchRow> {
    let q = trx.selectFrom('intake_batch as b').select(BATCH_COLUMNS).where('b.id', '=', id);
    if (hold) q = q.forUpdate();
    const b = await q.executeTakeFirst();
    if (!b) throw notHere();
    return b;
  }

  /** An item of this batch, waiting; held for a decision with `lock`. */
  private async waiting(trx: Db, batchId: string, itemId: string, lock = false) {
    let q = trx
      .selectFrom('incoming_file as f')
      .select([
        'f.id',
        'f.state',
        'f.original_name',
        'f.mime',
        'f.byte_size',
        'f.sha256',
        'f.cipher_bytes',
        'f.cipher_sha256',
        'f.storage_key',
        'f.vault_id',
        'f.file_key_wrapped',
        'f.wrapped_by_scope',
        'f.preview_state',
        'f.preview_pages',
      ])
      .where('f.id', '=', itemId)
      .where('f.batch_id', '=', batchId);
    if (lock) q = q.forUpdate();
    const f = await q.executeTakeFirst();
    if (!f || f.state === 'uploading') throw noItem();
    if (f.state !== 'received') throw decidedAlready();
    return f;
  }

  /**
   * A batch's defaults as sent, checked as the card would check them: a
   * person of the family (a teen's own only), a kind the household has, a
   * visibility the uploader may choose (never Adults only for a teen; Only
   * me only for one's own documents), where the paper copies are only for
   * whoever sees that, a collection the uploader may put documents in, and
   * tags as a document's are. What is not sent is left as it is.
   */
  private async checkedDefaults(
    trx: Db,
    p: Principal,
    d: Partial<BatchDefaults>,
    current: BatchRow | null,
  ) {
    const out: Record<string, unknown> = {};
    if (d.owner_member_id !== undefined) {
      if (d.owner_member_id !== null) {
        if (p.role === 'teen' && d.owner_member_id !== p.memberId) {
          throw new ApiError(403, 'forbidden', 'You can only add documents that belong to you.', {
            detail: 'owner_member_id',
          });
        }
        const m = await trx
          .selectFrom('member')
          .select('id')
          .where('id', '=', d.owner_member_id)
          .where('kind', '=', 'family')
          .executeTakeFirst();
        if (!m) throw invalid('That person is not in the family.', 'owner_member_id');
      }
      out.default_owner_member_id = d.owner_member_id;
    }
    if (d.type_key !== undefined) {
      if (d.type_key !== null) {
        const t = await trx
          .selectFrom('effective_document_type')
          .select('key')
          .where('key', '=', d.type_key)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!t) throw invalid('That kind of document is not on the list.', 'type_key');
      }
      out.default_type_key = d.type_key;
    }
    if (d.visibility !== undefined) {
      if (d.visibility === 'adults' && !can(p.role, 'document.see_adults')) {
        throw new ApiError(403, 'forbidden', 'Only an adult can make a document adults-only.', {
          detail: 'visibility',
        });
      }
      out.default_visibility = d.visibility;
    }
    // Only me is for one's own documents (the I1 review): a batch made Only
    // me is its uploader's own, so whose they are is the uploader where
    // nobody is chosen — never a guess that widens it later. A batch of
    // somebody else's documents is not Only me, as a single add's is not.
    const owner =
      d.owner_member_id !== undefined
        ? d.owner_member_id
        : (current?.default_owner_member_id ?? null);
    const vis = d.visibility !== undefined ? d.visibility : (current?.default_visibility ?? null);
    if (vis === 'private') {
      if (owner !== null && owner !== p.memberId) throw invalid(PRIVATE_TO_THEM, 'visibility');
      if (owner === null) out.default_owner_member_id = p.memberId;
    }
    if (d.physical_location !== undefined) {
      if (!seesLocation(p.role)) {
        throw new ApiError(403, 'forbidden', refusalFor('document.see_location'), {
          detail: 'physical_location',
        });
      }
      out.default_physical_location = d.physical_location?.trim() || null;
    }
    if (d.collection_id !== undefined) {
      if (d.collection_id !== null) await this.collections.mayAddTo(trx, p, d.collection_id);
      out.default_collection_id = d.collection_id;
    }
    if (d.tags !== undefined) {
      out.default_tags = [...new Set(d.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    }
    if (d.is_essential !== undefined) out.default_essential = d.is_essential;
    return out as {
      default_owner_member_id?: string | null;
      default_type_key?: string | null;
      default_visibility?: Visibility | null;
      default_physical_location?: string | null;
      default_collection_id?: string | null;
      default_tags?: string[];
      default_essential?: boolean;
    };
  }

  /**
   * What an accept files: what was sent, and for each detail not sent, the
   * batch's default (Q4) — a person, a kind, where the paper copies are,
   * tags, Essential; and who can see it, as `batchVisibility` says for the
   * kind and the person filed, never wider than the batch's choice. A
   * teen's are their own. A batch made Only me files Only me, the
   * uploader's own where nobody is sent: one sent as somebody else's, with
   * nobody saying who can see it, is refused as a single add's is
   * (PRIVATE_TO_THEM), never widened (the I1 review).
   */
  private async filled(
    trx: Db,
    p: Principal,
    sent: CaptureMetadata,
    b: BatchRow,
  ): Promise<CaptureMetadata> {
    const out: CaptureMetadata = { ...sent };
    if (out.owner_member_id === undefined) {
      if (b.default_owner_member_id !== null) out.owner_member_id = b.default_owner_member_id;
      else if (b.default_visibility === 'private') out.owner_member_id = p.memberId;
    }
    if (out.type_key === undefined && b.default_type_key !== null) {
      out.type_key = b.default_type_key;
    }
    if (out.physical_location === undefined && b.default_physical_location !== null) {
      out.physical_location = b.default_physical_location;
    }
    if (out.tags === undefined && b.default_tags.length > 0) out.tags = b.default_tags;
    if (out.is_essential === undefined && b.default_essential) out.is_essential = true;
    // A kind the household does not have is refused, not filed with no
    // kind as a phone's queued capture is: it is chosen now, from the list
    // as it is (as a file sent in is, incoming.ts).
    const type = out.type_key
      ? await trx
          .selectFrom('effective_document_type')
          .select('default_visibility')
          .where('key', '=', out.type_key)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
      : undefined;
    if (out.type_key && !type) {
      throw invalid('That kind of document is not on the list.', 'type_key');
    }
    if (out.visibility === undefined) {
      const owner = out.owner_member_id ?? (p.role === 'teen' ? p.memberId : null);
      out.visibility = batchVisibility({
        chosen: b.default_visibility,
        type: type ?? null,
        role: p.role,
        owner,
        me: p.memberId,
      });
    }
    return out;
  }

  /**
   * Items of these batches not removed, oldest first, each with what it
   * duplicates: a document the caller can see out of the Trash, or else an
   * item of theirs waiting, sent before it — in this batch first. Asked
   * now, under the caller's own rules, so nothing they cannot see is named.
   * Found in one pass (the I1 review): the first of each hash of theirs is
   * asked of the database, the first in each batch read from its own rows.
   */
  private async itemsOf(trx: Db, p: Principal, batchIds: string[]): Promise<BatchItemView[]> {
    const rows = (await trx
      .selectFrom('incoming_file as f')
      .innerJoin('intake_batch as ib', 'ib.id', 'f.batch_id')
      .leftJoin('document as d', (j) => j.onRef('d.id', '=', 'f.document_id').on(seenDocument(p)))
      .select([
        'f.id',
        'f.batch_id',
        'ib.name as batch_name',
        'ib.created_at as batch_created_at',
        'f.original_name',
        'f.mime',
        'f.byte_size',
        'f.sha256',
        'f.received_at',
        'f.state',
        'f.read_state',
        'f.preview_state',
        'f.preview_pages',
        'f.document_id',
        sql<boolean>`d.id is not null`.as('document_seen'),
      ])
      .where('f.batch_id', 'in', batchIds)
      .where('f.state', 'in', ['received', 'accepted'])
      .orderBy('f.received_at')
      .orderBy('f.id')
      .execute()) as ItemRow[];
    const waiting = rows.filter((r) => r.state === 'received' && r.sha256);
    const hashes = [...new Set(waiting.map((r) => (r.sha256 as Buffer).toString('hex')))];
    const docs = new Map<string, { id: string; title: string | null }>();
    interface Other {
      id: string;
      batch_id: string;
      name: string | null;
      created_at: Date;
      sha: string;
      received_at: Date;
    }
    // The first of each hash among all their items waiting, whichever batch.
    const firstOf = new Map<string, Other>();
    if (hashes.length > 0) {
      const bytes = sql`(select decode(h, 'hex') from unnest(${hashes}::text[]) as h)`;
      const found = await sql<{ sha: string; id: string; title: string | null }>`
        select distinct on (v.sha256) encode(v.sha256, 'hex') as sha, d.id, d.title
          from document_version v
          join document d on d.id = v.document_id
         where v.household_id = ${p.householdId}
           and v.sha256 in ${bytes}
           and d.deleted_at is null
           and ${seenDocument(p)}
         order by v.sha256, d.created_at, d.id`.execute(trx);
      for (const r of found.rows) docs.set(r.sha, { id: r.id, title: r.title });
      // The batch each first is in, named once it is found: one a hash.
      const firsts = await sql<Other>`
        select f.id, f.batch_id, b.name, b.created_at, f.sha, f.received_at
          from (select distinct on (o.sha256)
                       o.id, o.batch_id, encode(o.sha256, 'hex') as sha, o.received_at
                  from incoming_file o
                 where o.batch_id is not null
                   and o.state = 'received'
                   and o.requester_member_id = ${p.memberId}::uuid
                   and o.sha256 in ${bytes}
                 order by o.sha256, o.received_at, o.id) f
          join intake_batch b on b.id = f.batch_id`.execute(trx);
      for (const o of firsts.rows) firstOf.set(o.sha, o);
    }
    const before = (a: { received_at: Date; id: string }, b: { received_at: Date; id: string }) =>
      a.received_at.getTime() < b.received_at.getTime() ||
      (a.received_at.getTime() === b.received_at.getTime() && a.id < b.id);
    // And the first of each hash in each of these batches: their own rows, oldest first.
    const firstIn = new Map<string, Other>();
    for (const r of waiting) {
      const sha = (r.sha256 as Buffer).toString('hex');
      const inBatch = `${sha}:${r.batch_id}`;
      if (firstIn.has(inBatch)) continue;
      firstIn.set(inBatch, {
        id: r.id,
        batch_id: r.batch_id as string,
        name: r.batch_name,
        created_at: r.batch_created_at,
        sha,
        received_at: r.received_at as Date,
      });
    }
    return rows.map((r) => {
      const sha = r.sha256 ? r.sha256.toString('hex') : '';
      let duplicate: BatchDuplicate | null = null;
      if (r.state === 'received' && sha) {
        const doc = docs.get(sha);
        if (doc) {
          duplicate = { of: 'document', document_id: doc.id, title: doc.title };
        } else {
          // Sent before it: in this batch first, then in any of theirs.
          const me = { id: r.id, received_at: r.received_at as Date };
          const same = firstIn.get(`${sha}:${r.batch_id}`);
          const any = firstOf.get(sha);
          const first =
            same && same.id !== r.id && before(same, me)
              ? same
              : any && any.id !== r.id && before(any, me)
                ? any
                : null;
          if (first) {
            duplicate = {
              of: 'item',
              batch_id: first.batch_id,
              batch_name: first.name,
              batch_created_at: first.created_at.toISOString(),
              item_id: first.id,
              same_batch: first.batch_id === r.batch_id,
            };
          }
        }
      }
      // A decided item's pages went with its bytes: none to ask for (the I1 review).
      const decided = r.state !== 'received';
      return {
        id: r.id,
        batch_id: r.batch_id as string,
        name: r.original_name ?? 'file',
        content_type: r.mime ?? 'application/octet-stream',
        byte_size: Number(r.byte_size ?? 0),
        sha256: sha,
        arrived_at: (r.received_at as Date).toISOString(),
        state: r.state === 'accepted' ? 'accepted' : 'waiting',
        reading: (r.read_state ?? 'waiting') as BatchReadState,
        preview_state: decided ? 'none' : previewState(r.preview_state),
        preview_pages: !decided && r.preview_state === 'ready' ? r.preview_pages : null,
        duplicate,
        document_id: r.state === 'accepted' && r.document_seen ? r.document_id : null,
      };
    });
  }

  private view(p: Principal, b: BatchRow, counts: BatchCounts): BatchView {
    return {
      id: b.id,
      name: b.name,
      created_at: b.created_at.toISOString(),
      ends_at: b.ends_at.toISOString(),
      defaults: {
        owner_member_id: b.default_owner_member_id,
        type_key: b.default_type_key,
        visibility: b.default_visibility,
        // Where the family keeps its originals is for whoever sees that (5.41).
        physical_location: seesLocation(p.role) ? b.default_physical_location : null,
        collection_id: b.default_collection_id,
        tags: b.default_tags,
        is_essential: b.default_essential,
      },
      counts,
    };
  }

  /**
   * A decided item's object and pages, removed once the decision has
   * committed, and said so. Every page there could be, whatever its row
   * says was drawn (F523-3). A removal that fails is left for the worker's
   * daily sweep.
   */
  private async removeObjects(
    p: Principal,
    f: { id: string; storage_key: string; vault_id: string },
  ): Promise<void> {
    try {
      const adapter: StorageAdapter = await withPrincipal(this.db, p, (trx) =>
        this.vaults.adapterById(trx, f.vault_id),
      );
      await deleteAll(adapter, pageKeys(f.storage_key));
      await adapter.delete(f.storage_key);
      await withPrincipal(this.db, p, (trx) =>
        trx
          .updateTable('incoming_file')
          .set({ object_removed_at: new Date() })
          .where('id', '=', f.id)
          .where('object_removed_at', 'is', null)
          .execute(),
      );
    } catch {
      // The sweep makes it good.
    }
  }

  /**
   * An accepted item's copy, when filing it failed — only when it certainly
   * did not happen (F523-2, as incoming.ts): the item's row held first, which
   * a commit whose answer was lost holds until it ends, then read as it is.
   */
  private async dropCopy(
    p: Principal,
    at: { fileId: string; vaultId: string; key: string },
  ): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      await sql`set local lock_timeout = '30s'`.execute(trx);
      const f = await trx
        .selectFrom('incoming_file')
        .select(['state', 'version_id'])
        .where('id', '=', at.fileId)
        .forUpdate()
        .executeTakeFirst();
      if (!f) return;
      if (f.state === 'accepted') {
        if (!f.version_id) return;
        const filed = await trx
          .selectFrom('document_version')
          .select('storage_key')
          .where('id', '=', f.version_id)
          .executeTakeFirst();
        if (!filed || filed.storage_key === at.key) return;
      }
      await (await this.vaults.adapterById(trx, at.vaultId)).delete(at.key);
    }).catch(() => undefined);
  }
}

/** A batch's counts, from its items as its page gives them. */
function countsOf(items: BatchItemView[]): BatchCounts {
  return {
    items: items.length,
    waiting: items.filter((i) => i.state === 'waiting').length,
    accepted: items.filter((i) => i.state === 'accepted').length,
    duplicates: items.filter((i) => i.state === 'waiting' && i.duplicate !== null).length,
  };
}

/** A name as typed, spaces tidied; blank is none. */
function nameOf(v: string | null | undefined): string | null {
  const tidy = (v ?? '').trim().replace(/\s+/g, ' ');
  if (tidy.length > BATCH_NAME_MAX) {
    throw invalid(`A batch’s name is too long: ${BATCH_NAME_MAX} characters at most.`, 'name');
  }
  return tidy || null;
}

/** Its pages as the uploader is told: being drawn until they are, or why there are none. */
function previewState(drawn: string): IncomingPreviewState {
  if (drawn === 'none' || drawn === 'drawing') return 'pending';
  return drawn as IncomingPreviewState;
}
