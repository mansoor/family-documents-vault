import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DecryptStream,
  EncryptStream,
  itemProposalsBinding,
  newKey,
  openBytes,
  unwrapKey,
  wrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  ACCEPT_READY_MAX,
  ACCEPT_UNDO_MINUTES,
  untouchedAccept,
  type AcceptReadySkip,
  type BatchAcceptReadyInput,
  type BatchAcceptReadyResult,
  type BatchLevel,
  type BatchLevelCounts,
  type BatchUndoInput,
  type BatchUndoResult,
  type UndoKept,
  BATCH_MAX_FILES,
  BATCH_NAME_MAX,
  batchVisibility,
  can,
  dropFileName,
  INCOMING_KEEP_DAYS,
  incomingFileName,
  levelItem,
  lockInEffect,
  PREVIEW_MAX_PAGES,
  PRIVATE_TO_THEM,
  refusalFor,
  seesLocation,
  storedProposal,
  type BatchAccepted,
  type BatchAcceptInput,
  type BatchCounts,
  type BatchDefaults,
  type BatchDetail,
  type BatchDuplicate,
  type BatchInput,
  type BatchItemView,
  type BatchReadFailure,
  type BatchReadState,
  type BatchView,
  type CaptureMetadata,
  type DetailProposal,
  type IncomingPreviewState,
  type LevelKind,
  type Visibility,
} from '@fdv/shared';
import { deleteAll, readAll, StorageError, type StorageAdapter } from '@fdv/storage';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { CollectionService } from '../collections/service.js';
import {
  seenDocument,
  sniffStream,
  typeView,
  type DocumentService,
  type Enqueue,
} from '../documents/service.js';
import { holdDocumentRows, ownedObjects } from '../documents/purge.js';
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
 * Read and proposed for (I2): the worker reads each item once its pages are
 * drawn, and seals what its words propose under the item's own key. Each
 * item's level, tags, clashes and what its card starts from are worked out
 * here, as it is asked, for the uploader alone (`levelItem`): from what the
 * pages proposed, the batch's defaults as they are now and the kinds as
 * they are now — so a default or a kind changed re-levels every item, and
 * nothing is read again. An accept takes what it is sent, and the batch's
 * defaults for what is not: never a proposal nobody chose.
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

/** Why a document Accept all Ready filed is kept, in words (I3). */
const UNDO_KEPT: Readonly<Record<UndoKept, string>> = {
  too_late: `More than ${ACCEPT_UNDO_MINUTES} minutes have passed, so it stays a document. Move it to the Trash from Documents if it should not be there.`,
  not_undoable: 'It was not filed by Accept all Ready, or it has been taken back already.',
  changed:
    'It stays a document: since it was filed, somebody changed it, made a link to it, added a copy or moved it to the Trash.',
  not_found: 'That file is not in this batch.',
  failed: 'It could not be taken back just then, so it is still a document. Try again.',
};

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
  read_failure: string | null;
  proposals_sealed: Buffer | null;
  file_key_wrapped: Buffer;
  wrapped_by_scope: string;
  preview_state: string;
  preview_pages: number | null;
  document_id: string | null;
  document_seen: boolean | null;
}

/** An item waiting, as a decision reads it. */
interface WaitingRow {
  id: string;
  state: string;
  original_name: string | null;
  mime: string | null;
  byte_size: string | number | null;
  sha256: Buffer | null;
  cipher_bytes: string | number | null;
  cipher_sha256: Buffer | null;
  storage_key: string;
  vault_id: string;
  file_key_wrapped: Buffer;
  wrapped_by_scope: string;
  preview_state: string;
  preview_pages: number | null;
}

/** Where a filing put its copy of the file: removed if its transaction fails. */
interface Placed {
  key: string | null;
  vaultId: string | null;
}

/** What one item filed became. */
interface Filed {
  file: { id: string; storage_key: string; vault_id: string };
  documentId: string;
  versionId: string;
  warnings: string[];
  /** Filed by Accept all Ready: until when it may be taken back. */
  undoUntil: Date | null;
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
  /** Told of each item whose sealed proposal is opened (the I2 review): for the tests. */
  opened?: (itemId: string) => void;
  /** An Undo, held once it holds the item and the document, before it changes them (I3): for the races. */
  undoHeld?: (itemId: string) => Promise<void>;
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
  async list(p: Principal, opts: { levels?: boolean } = {}): Promise<BatchView[]> {
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
        removed: string;
        duplicates: string;
      }>`
        select w.batch_id,
               count(*) filter (where w.state <> 'rejected') as items,
               count(*) filter (where w.state = 'received') as waiting,
               count(*) filter (where w.state = 'accepted') as accepted,
               count(*) filter (where w.state = 'rejected') as removed,
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
                   and f.state in ('received', 'accepted', 'rejected')) w
         group by w.batch_id`.execute(trx);
      const by = new Map(counted.rows.map((c) => [c.batch_id, c]));
      // Each batch's levels, asked for (I3): what each waiting item's pages
      // proposed is opened to level it, as the batch's own page does.
      const levels = opts.levels ? levelsOf(await this.itemsOf(trx, p, ids)) : null;
      return batches.map((b) => {
        const c = by.get(b.id);
        const view = this.view(p, b, {
          items: Number(c?.items ?? 0),
          waiting: Number(c?.waiting ?? 0),
          accepted: Number(c?.accepted ?? 0),
          removed: Number(c?.removed ?? 0),
          duplicates: Number(c?.duplicates ?? 0),
        });
        return levels ? { ...view, levels: levels.get(b.id) ?? noLevels() } : view;
      });
    });
  }

  /** GET /batches/{id}: one of the caller's batches, and its items not removed, oldest first. */
  async get(p: Principal, id: string): Promise<BatchDetail> {
    this.mayAdd(p);
    return withPrincipal(this.db, p, async (trx) => {
      const b = await this.batch(trx, id);
      const items = await this.itemsOf(trx, p, [b.id]);
      // And how many were removed: the queue's Done says so (I3).
      const removed = await trx
        .selectFrom('incoming_file')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('batch_id', '=', b.id)
        .where('state', '=', 'rejected')
        .executeTakeFirstOrThrow();
      return { ...this.view(p, b, { ...countsOf(items), removed: Number(removed.n) }), items };
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
        text_sealed: null,
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
          const [item] = (await this.itemsOf(trx, p, [b.id], prior.id)).filter(
            (i) => i.id === prior.id,
          );
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
        const [item] = (await this.itemsOf(trx, p, [batchId], ctx.fileId)).filter(
          (i) => i.id === ctx.fileId,
        );
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
          text_sealed: null,
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
    const placed: Placed = { key: null, vaultId: null };
    let out: Filed;
    try {
      out = await withPrincipal(this.db, p, async (trx) => {
        await this.stillAdds(trx, p);
        const b = await this.batch(trx, batchId);
        const f = await this.waiting(trx, batchId, itemId, true);
        return this.file(trx, p, b, f, input, meta, placed, false);
      });
    } catch (err) {
      await this.dropPlaced(p, itemId, placed);
      throw err;
    }
    await this.filedAfter(p, out);
    return {
      document_id: out.documentId,
      version_id: out.versionId,
      ...(out.warnings.length > 0 ? { warnings: out.warnings } : {}),
    };
  }

  /**
   * One held item filed (accept, and each of Accept all Ready's): its
   * details filled from the batch's defaults where not sent, its key
   * unwrapped from the uploader's and wrapped for the document, its bytes
   * copied to where versions are kept, put in the collection named, and the
   * item decided — its words and proposals let go. Filed by Accept all
   * Ready (`undoable`), until when it may be taken back (I3, 0064).
   */
  private async file(
    trx: Db,
    p: Principal,
    b: BatchRow,
    f: WaitingRow,
    input: BatchAcceptInput,
    meta: RequestMeta,
    placed: Placed,
    undoable: boolean,
  ): Promise<Filed> {
    const { collection_id: sentCollection, ...sent } = input;
    const metadata = await this.filled(trx, p, sent, b);
    const collectionId = sentCollection !== undefined ? sentCollection : b.default_collection_id;
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
        text_sealed: null,
        // On the database's clock, as the rule that holds it (0064).
        ...(undoable
          ? { undo_until: sql<Date>`now() + make_interval(mins => ${ACCEPT_UNDO_MINUTES})` }
          : {}),
      })
      .where('id', '=', f.id)
      .where('state', '=', 'received')
      .returning('undo_until')
      .executeTakeFirst();
    // Held since it was read: anything else is a rule that said no.
    if (!decided) throw decidedAlready();
    return {
      file: f,
      documentId: version.document_id,
      versionId: version.id,
      warnings,
      undoUntil: decided.undo_until,
    };
  }

  /** A filing's copy, when its transaction failed: only when it certainly did not happen. */
  private async dropPlaced(p: Principal, itemId: string, placed: Placed): Promise<void> {
    if (placed.key && placed.vaultId) {
      await this.dropCopy(p, { fileId: itemId, vaultId: placed.vaultId, key: placed.key });
    }
  }

  /**
   * Once filed and committed: the item's object and pages removed, and the
   * version's page count, thumbnail and OCR asked for — sealed if it is
   * Only me — only now it is filed, as a single add's.
   */
  private async filedAfter(p: Principal, out: Filed): Promise<void> {
    await this.removeObjects(p, out.file);
    await this.enqueue(VERSION_PROCESS_JOB, {
      household_id: p.householdId,
      version_id: out.versionId,
    }).catch(() => undefined);
  }

  // ------------------------------------------------ the review queue (I3)

  /**
   * POST /batches/{id}/accept-ready: every item Ready now filed, each as its
   * card would file it untouched (`untouchedAccept`) — the merged proposal,
   * who can see it as the batch and its kind say, the batch's collection,
   * tags and Essential. Ready is the vault's own word, worked out again for
   * each item inside its own transaction, with the batch held for share so
   * its defaults cannot change under it: never a client's list taken on
   * trust. Named items (`item_ids`) are those the client showed Ready; one
   * not Ready now is skipped, and said so.
   *
   * Each item is its own transaction, as a single accept is: one refused is
   * named with why, and kept waiting; the rest are filed. At most
   * ACCEPT_READY_MAX a request. Each filed so may be taken back for
   * ACCEPT_UNDO_MINUTES (`undo`).
   */
  async acceptReady(
    p: Principal,
    batchId: string,
    input: BatchAcceptReadyInput,
    meta: RequestMeta,
  ): Promise<BatchAcceptReadyResult> {
    this.mayAdd(p);
    const named = input.item_ids ? [...new Set(input.item_ids)] : null;
    if (named && named.length > ACCEPT_READY_MAX) {
      throw invalid(`Accept ${ACCEPT_READY_MAX} at most at a time.`, 'item_ids');
    }
    const asked = await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      const b = await this.batch(trx, batchId);
      if (named) return { ids: named, more: false };
      const items = await this.itemsOf(trx, p, [b.id]);
      const ready = items.filter((i) => i.state === 'waiting' && i.level === 'ready');
      return {
        ids: ready.slice(0, ACCEPT_READY_MAX).map((i) => i.id),
        more: ready.length > ACCEPT_READY_MAX,
      };
    });
    const out: BatchAcceptReadyResult = {
      accepted: [],
      skipped: [],
      failed: [],
      undo_until: null,
      more: asked.more,
    };
    let until: Date | null = null;
    for (const itemId of asked.ids) {
      const placed: Placed = { key: null, vaultId: null };
      let done: Filed | { skip: AcceptReadySkip; level?: BatchLevel | null };
      try {
        done = await withPrincipal(this.db, p, async (trx) => {
          await this.stillAdds(trx, p);
          const b = await this.batch(trx, batchId, 'share');
          let f: WaitingRow;
          try {
            f = await this.waiting(trx, b.id, itemId, true);
          } catch (err) {
            if (err instanceof ApiError && err.code === 'already_decided') {
              return { skip: 'decided' as const };
            }
            if (err instanceof ApiError && err.status === 404)
              return { skip: 'not_found' as const };
            throw err;
          }
          // Its level now, as the vault works it out: the batch's defaults
          // and the kinds as they are in this transaction.
          const [item] = (await this.itemsOf(trx, p, [b.id], f.id)).filter((i) => i.id === f.id);
          if (!item || item.level !== 'ready' || !item.proposals) {
            return { skip: 'not_ready' as const, level: item?.level ?? null };
          }
          const levelling = await this.levelling(trx, [b.id]);
          const body = untouchedAccept({
            proposals: item.proposals,
            defaults: levelling.defaults(b.id),
            types: levelling.views,
            people: levelling.people.map((m) => ({ id: m.id, display_name: m.name })),
            role: p.role,
            me: p.memberId,
          });
          return this.file(trx, p, b, f, body, meta, placed, true);
        });
      } catch (err) {
        await this.dropPlaced(p, itemId, placed);
        // Named with why, as its own accept would say it; storage out of
        // reach as a single add says it.
        const said =
          err instanceof ApiError
            ? err
            : err instanceof StorageError
              ? storageUnreachable(err.message)
              : null;
        out.failed.push(
          said
            ? { item_id: itemId, code: said.code, message: said.message }
            : {
                item_id: itemId,
                code: 'not_accepted',
                message: 'It could not be accepted just then: it is still waiting. Try it again.',
              },
        );
        continue;
      }
      if ('skip' in done) {
        out.skipped.push({
          item_id: itemId,
          reason: done.skip,
          ...(done.skip === 'not_ready' ? { level: done.level ?? null } : {}),
        });
        continue;
      }
      await this.filedAfter(p, done);
      out.accepted.push({
        item_id: itemId,
        document_id: done.documentId,
        version_id: done.versionId,
        ...(done.warnings.length > 0 ? { warnings: done.warnings } : {}),
      });
      // The soonest any of them stops being taken back.
      if (done.undoUntil && (!until || done.undoUntil < until)) until = done.undoUntil;
    }
    out.undo_until = until ? until.toISOString() : null;
    return out;
  }

  /**
   * POST /batches/{id}/accept-ready/undo: documents Accept all Ready filed,
   * taken back into the queue while the uploader still may (`undo_until`,
   * ACCEPT_UNDO_MINUTES): each removed for good, and its file waiting again
   * as its item, to be drawn and read again. Nothing of it is left that
   * anybody else is shown: its rows go, every object it owns is written down
   * to be deleted (purge_leftover), and no tombstone is left, so its lines
   * in the activity log are nobody's (0045, 0064). Each item is its own
   * transaction. Kept, and said so: one past its time, one not filed by
   * Accept all Ready, and one somebody has changed, made a link to, added a
   * copy to or moved to the Trash since.
   */
  async undo(
    p: Principal,
    batchId: string,
    input: BatchUndoInput,
    meta: RequestMeta,
  ): Promise<BatchUndoResult> {
    this.mayAdd(p);
    const ids = [...new Set(input.item_ids)];
    if (ids.length > BATCH_MAX_FILES) {
      throw invalid(`A batch holds ${BATCH_MAX_FILES} files at most.`, 'item_ids');
    }
    // Asked first: somebody else's batch is not here, for any of them.
    await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      await this.batch(trx, batchId);
    });
    const out: BatchUndoResult = { restored: [], kept: [] };
    let restored = false;
    for (const itemId of ids) {
      const kept = await this.undoOne(p, batchId, itemId, meta).catch(() => 'failed' as const);
      if (kept) out.kept.push({ item_id: itemId, reason: kept, message: UNDO_KEPT[kept] });
      else {
        out.restored.push(itemId);
        restored = true;
      }
    }
    if (restored) {
      // Drawn and read again, one at a time a household; the document's
      // objects deleted by the worker, as a removal's leftovers are.
      await this.enqueue(
        BATCH_PREVIEWS_JOB,
        { household_id: p.householdId },
        { singletonKey: batchPreviewsKey(p.householdId) },
      ).catch(() => undefined);
      await this.enqueue(
        PURGE_LEFTOVERS_JOB,
        { household_id: p.householdId },
        { singletonKey: `purge.leftovers:${p.householdId}` },
      ).catch(() => undefined);
    }
    return out;
  }

  /** One item taken back, or why it is kept. */
  private async undoOne(
    p: Principal,
    batchId: string,
    itemId: string,
    meta: RequestMeta,
  ): Promise<UndoKept | null> {
    // Where its file is now: the version's own copy, the same encrypted bytes.
    const found = await withPrincipal(this.db, p, async (trx) => {
      await this.stillAdds(trx, p);
      const f = await trx
        .selectFrom('incoming_file as f')
        .leftJoin('document_version as v', 'v.id', 'f.version_id')
        .select([
          'f.id',
          'f.state',
          'f.decided_by',
          'f.document_id',
          'f.version_id',
          'f.vault_id',
          'f.cipher_sha256',
          'v.storage_key as version_key',
          'v.vault_id as version_vault',
          sql<boolean>`f.undo_until > now()`.as('in_time'),
        ])
        .where('f.id', '=', itemId)
        .where('f.batch_id', '=', batchId)
        .executeTakeFirst();
      if (!f || f.state === 'uploading') return { kept: 'not_found' as const };
      if (f.state !== 'accepted' || f.in_time === null || f.decided_by !== p.accountId) {
        return { kept: 'not_undoable' as const };
      }
      // Its time is asked once it is held, below: the database's clock, then.
      if (!f.version_key || !f.version_vault || !f.document_id) return { kept: 'changed' as const };
      return {
        f,
        from: await this.vaults.adapterById(trx, f.version_vault),
        to: await this.vaults.adapterById(trx, f.vault_id),
      };
    });
    if ('kept' in found) return found.kept;
    const { f } = found;
    // Copied back first, out of the transaction, to an object of its own:
    // checked against what was stored, or nothing is taken back.
    const key = `${p.householdId}/batches/${batchId}/${randomBytes(16).toString('hex')}.enc`;
    try {
      const put = await found.to.put(key, await found.from.get(f.version_key as string));
      if (put.sha256 !== (f.cipher_sha256 as Buffer).toString('hex')) {
        throw storageUnreachable('the copy of a filed file taken back did not match');
      }
    } catch (err) {
      await found.to.delete(key).catch(() => undefined);
      throw err;
    }
    let kept: UndoKept | null;
    try {
      kept = await withPrincipal(this.db, p, async (trx) => {
        await this.stillAdds(trx, p);
        const b = await this.batch(trx, batchId);
        const held = await trx
          .selectFrom('incoming_file')
          .select([
            'id',
            'state',
            'decided_by',
            'document_id',
            'version_id',
            'storage_key',
            'vault_id',
            'object_removed_at',
            sql<boolean>`undo_until > now()`.as('in_time'),
          ])
          .where('id', '=', itemId)
          .forUpdate()
          .executeTakeFirst();
        if (!held || held.state !== 'accepted' || held.decided_by !== p.accountId) {
          return 'not_undoable';
        }
        if (!held.in_time || b.ends_at.getTime() <= Date.now()) return 'too_late';
        const docId = held.document_id;
        if (!docId || docId !== f.document_id) return 'changed';
        // Held as a removal for good holds them (purge.ts): its links'
        // sessions, its links, the pages links drew; the document; its versions.
        await holdDocumentRows(trx, docId);
        const doc = await trx
          .selectFrom('document as d')
          .select(['d.id', 'd.deleted_at', 'd.updated_by'])
          .where('d.id', '=', docId)
          .where(seenDocument(p))
          .forUpdate()
          .executeTakeFirst();
        if (!doc) return 'changed';
        await this.opts.undoHeld?.(itemId);
        const versions = await trx
          .selectFrom('document_version')
          .select(['id', 'storage_key', 'thumbnail_key', 'vault_id'])
          .where('document_id', '=', docId)
          .orderBy('id')
          .forUpdate()
          .execute();
        const linked = await trx
          .selectFrom('share_link')
          .select('id')
          .where('document_id', '=', docId)
          .executeTakeFirst();
        // Somebody's since: changed, a copy added, a link made, the Trash.
        if (
          doc.deleted_at !== null ||
          doc.updated_by !== p.accountId ||
          versions.length !== 1 ||
          versions[0]?.id !== held.version_id ||
          linked
        ) {
          return 'changed';
        }
        // Every object it owns written down to be deleted, as a removal
        // for good writes them — and the item's own old object, should its
        // removal after the accept have failed.
        const byVault = await ownedObjects(trx, docId, versions);
        if (!held.object_removed_at) {
          const keys = byVault.get(held.vault_id) ?? new Set<string>();
          for (const k of [held.storage_key, ...pageKeys(held.storage_key)]) keys.add(k);
          byVault.set(held.vault_id, keys);
        }
        const leftovers = [...byVault].flatMap(([vaultId, keys]) =>
          [...keys].map((k) => ({
            household_id: p.householdId,
            vault_id: vaultId,
            object_key: k,
            removed_document: docId,
          })),
        );
        for (let at = 0; at < leftovers.length; at += 2000) {
          await trx
            .insertInto('purge_leftover')
            .values(leftovers.slice(at, at + 2000))
            .onConflict((oc) => oc.columns(['vault_id', 'object_key']).doNothing())
            .execute();
        }
        // Waiting again, at its new object: drawn and read again by the
        // worker. It lets go of the document before the document goes (its
        // removal would take the row with it, 0047).
        await trx
          .updateTable('incoming_file')
          .set({
            state: 'received',
            decided_by: null,
            decided_at: null,
            document_id: null,
            version_id: null,
            undo_until: null,
            object_removed_at: null,
            storage_key: key,
            preview_state: 'none',
            preview_requested_at: null,
            preview_pages: null,
            read_state: 'waiting',
            read_failure: null,
            read_started_at: null,
            read_attempts: 0,
            read_not_before: null,
          })
          .where('id', '=', held.id)
          .execute();
        const gone = await trx.deleteFrom('document').where('id', '=', docId).executeTakeFirst();
        if (Number(gone.numDeletedRows) !== 1) throw new Error('a held document was not removed');
        // Its lines, this one too, have no tombstone to be shown by: nobody's (0064).
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'batch.accept_undone',
          objectType: 'document',
          objectId: docId,
          detail: { batch_id: batchId },
          ip: meta.ip,
        });
        return null;
      });
    } catch (err) {
      await this.dropUndoCopy(p, itemId, key, found.to);
      throw err;
    }
    if (kept) await found.to.delete(key).catch(() => undefined);
    return kept;
  }

  /**
   * A copy taken back, when its transaction failed: only when it certainly
   * did not take — the item's row held first, which a commit whose answer
   * was lost holds until it ends, then read as it is (as dropCopy).
   */
  private async dropUndoCopy(
    p: Principal,
    itemId: string,
    key: string,
    adapter: StorageAdapter,
  ): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      await sql`set local lock_timeout = '30s'`.execute(trx);
      const f = await trx
        .selectFrom('incoming_file')
        .select('storage_key')
        .where('id', '=', itemId)
        .forUpdate()
        .executeTakeFirst();
      if (f?.storage_key === key) return;
      await adapter.delete(key);
    }).catch(() => undefined);
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

  /**
   * One of the caller's batches (the database gives no other), or not here.
   * Held, with `hold`; held for share, with 'share': its defaults cannot
   * change until this transaction ends (Accept all Ready, I3).
   */
  private async batch(trx: Db, id: string, hold: boolean | 'share' = false): Promise<BatchRow> {
    let q = trx.selectFrom('intake_batch as b').select(BATCH_COLUMNS).where('b.id', '=', id);
    if (hold === 'share') q = q.forShare();
    else if (hold) q = q.forUpdate();
    const b = await q.executeTakeFirst();
    if (!b) throw notHere();
    return b;
  }

  /** An item of this batch, waiting; held for a decision with `lock`. */
  private async waiting(
    trx: Db,
    batchId: string,
    itemId: string,
    lock = false,
  ): Promise<WaitingRow> {
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
  private async itemsOf(
    trx: Db,
    p: Principal,
    batchIds: string[],
    /**
     * Only this item is answered (the I2 review, P-I2-3): only its proposal is
     * opened; the rest are still read for what they duplicate.
     */
    only?: string,
  ): Promise<BatchItemView[]> {
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
        'f.read_failure',
        // What the pages proposed, opened below for the uploader: only while it waits.
        sql<Buffer | null>`case when f.state = 'received' then f.proposals_sealed end`.as(
          'proposals_sealed',
        ),
        'f.file_key_wrapped',
        'f.wrapped_by_scope',
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
    const levelling = await this.levelling(trx, batchIds);
    const proposed = new Map<string, DetailProposal | null>();
    for (const r of rows) {
      if (r.state === 'received' && r.read_state === 'read' && (!only || r.id === only)) {
        proposed.set(r.id, await levelling.open(r));
      }
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
      const state = r.state === 'accepted' ? 'accepted' : 'waiting';
      const reading = (r.read_state ?? 'waiting') as BatchReadState;
      const failure =
        reading === 'failed' ? ((r.read_failure ?? 'unreadable') as BatchReadFailure) : null;
      const levelled = levelItem({
        state,
        reading,
        failure,
        proposal: proposed.get(r.id) ?? null,
        duplicate,
        defaults: levelling.defaults(r.batch_id as string),
        types: levelling.types,
        people: levelling.people,
        role: p.role,
        me: p.memberId,
      });
      return {
        id: r.id,
        batch_id: r.batch_id as string,
        name: r.original_name ?? 'file',
        content_type: r.mime ?? 'application/octet-stream',
        byte_size: Number(r.byte_size ?? 0),
        sha256: sha,
        arrived_at: (r.received_at as Date).toISOString(),
        state,
        reading,
        read_failure: failure,
        preview_state: decided ? 'none' : previewState(r.preview_state),
        preview_pages: !decided && r.preview_state === 'ready' ? r.preview_pages : null,
        duplicate,
        document_id: r.state === 'accepted' && r.document_seen ? r.document_id : null,
        level: levelled.level,
        tags: levelled.tags,
        proposals: levelled.proposals,
        clashes: levelled.clashes,
      };
    });
  }

  /**
   * What levelling these batches' items needs, asked once (I2): each
   * batch's defaults as they are now, the household's kinds as they are now
   * (not deleted), the family — never a guest — and an opener for what the
   * worker sealed under each item's own key, each scope key unwrapped once.
   * A blob that does not open is nothing proposed, never an error.
   */
  private async levelling(trx: Db, batchIds: string[]) {
    const batches = await trx
      .selectFrom('intake_batch as b')
      .select(BATCH_COLUMNS)
      .where('b.id', 'in', batchIds)
      .execute();
    const kinds = await trx
      .selectFrom('effective_document_type')
      .selectAll()
      .where('deleted_at', 'is', null)
      .execute();
    const family = await trx
      .selectFrom('member')
      .select(['id', 'display_name'])
      .where('kind', '=', 'family')
      .execute();
    const byBatch = new Map(batches.map((b) => [b.id, b]));
    const scopes = new Map<string, Promise<Buffer>>();
    const scopeKey = (id: string) => {
      let k = scopes.get(id);
      if (!k) {
        k = this.keys.unwrapById(trx, id);
        scopes.set(id, k);
      }
      return k;
    };
    return {
      types: kinds.map(typeView) as LevelKind[],
      /** The kinds as GET /document-types gives them: what a card starts from (I3). */
      views: kinds.map(typeView),
      people: family.map((m) => ({ id: m.id, name: m.display_name })),
      defaults: (batchId: string): BatchDefaults => {
        const b = byBatch.get(batchId);
        return {
          owner_member_id: b?.default_owner_member_id ?? null,
          type_key: b?.default_type_key ?? null,
          visibility: b?.default_visibility ?? null,
          physical_location: b?.default_physical_location ?? null,
          collection_id: b?.default_collection_id ?? null,
          tags: b?.default_tags ?? [],
          is_essential: b?.default_essential ?? false,
        };
      },
      open: async (r: ItemRow): Promise<DetailProposal | null> => {
        if (!r.proposals_sealed) return null;
        this.opts.opened?.(r.id);
        try {
          const fileKey = unwrapKey(
            r.file_key_wrapped,
            await scopeKey(r.wrapped_by_scope),
            `incoming:${r.id}`,
          );
          const plain = openBytes(fileKey, r.proposals_sealed, itemProposalsBinding(r.id));
          return storedProposal(JSON.parse(plain.toString('utf8')));
        } catch {
          return null;
        }
      },
    };
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

/** No waiting item at any level. */
const noLevels = (): BatchLevelCounts => ({
  ready: 0,
  check: 0,
  unrecognised: 0,
  problem: 0,
  unread: 0,
});

/** Each batch's waiting items, counted by level (I3); one not levelled yet is still to be read. */
function levelsOf(items: BatchItemView[]): Map<string, BatchLevelCounts> {
  const out = new Map<string, BatchLevelCounts>();
  for (const i of items) {
    if (i.state !== 'waiting') continue;
    const c = out.get(i.batch_id) ?? noLevels();
    c[i.level ?? 'unread'] += 1;
    out.set(i.batch_id, c);
  }
  return out;
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
