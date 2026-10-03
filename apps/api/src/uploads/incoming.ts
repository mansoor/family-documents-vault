import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, unwrapKey, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  INCOMING_KEEP_DAYS,
  incomingFileName,
  PREVIEW_MAX_PAGES,
  suspensionInEffect,
  type IncomingAccepted,
  type IncomingFileView,
  type IncomingPreviewState,
  type IncomingScanState,
} from '@fdv/shared';
import { deleteAll, readAll, type StorageAdapter } from '@fdv/storage';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { DocumentService, Enqueue } from '../documents/service.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';

/**
 * Incoming: look before it is filed (5.23, #12).
 *
 * What somebody outside the family sends through a request (5.21) waits in
 * `incoming_file`, encrypted under the key of whoever reviews it, until a
 * reviewer looks at it — the previews the worker drew, or a copy saved —
 * and decides. Filed, it becomes a document, or a new version of one,
 * through the same commit every upload goes through (DocumentService
 * .fileIncoming); refused, its bytes are removed. Until then nothing
 * searches, lists, reminds or counts it: it is not a document.
 *
 * Who: the requester alone for a request they review alone, the owners and
 * adults for one any adult reviews, the owners alone once moved to them
 * from a requester who can no longer review (0047). The database keeps
 * every file to those (0044, 0047), whatever is asked here; a teen or a
 * viewer is answered as if there were no such thing (404).
 *
 * The order every decision takes its locks in, and nothing takes them the
 * other way: the reviewer's own membership (shared: a role changing waits
 * for the decision, and a decision waits for a role changing), then the
 * file, then — filed into a document already there — the document, and the
 * household's activity log last. Its bytes go after the commit: a copy is
 * made before it (filed), and the file's own object, and its previews, are
 * removed after; a removal that fails is made good by the worker's daily
 * sweep (`object_removed_at`).
 */

/** The worker's jobs (apps/worker/src/queue.ts): the names match. */
export const INCOMING_SCAN_JOB = 'incoming.scan';
export const INCOMING_MOVE_JOB = 'incoming.move';
const VERSION_PROCESS_JOB = 'version.process';

/** A page the worker drew, beside its file's object (0047), as a version's are (0027). */
export const incomingPreviewKey = (storageKey: string, n: number) => `${storageKey}.p${n}.enc`;

/** Every page there could be of a file: PREVIEW_MAX_PAGES of them, drawn or not. */
const incomingPageKeys = (storageKey: string) =>
  Array.from({ length: PREVIEW_MAX_PAGES }, (_, i) => incomingPreviewKey(storageKey, i + 1));

export const acceptBody = z
  .object({
    owner_member_id: z.string().uuid().nullable().optional(),
    type_key: z.string().min(1).max(64).nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    visibility: z.enum(['household', 'adults', 'private']).optional(),
    into_document_id: z.string().uuid().optional(),
  })
  .strict();

export interface IncomingOptions {
  enqueue?: Enqueue;
  /**
   * Tests only: called inside a decision's transaction with every row it
   * takes held, just before it commits — for the races, run against
   * another connection.
   */
  beforeCommit?: (what: 'accept' | 'reject', fileId: string) => Promise<void>;
}

/** One teen, one viewer, a file somebody else reviews, a file not there: all the same. */
const notHere = () => new ApiError(404, 'not_found', 'That file is not waiting for you.');

const decidedAlready = () =>
  new ApiError(409, 'already_decided', 'Somebody has filed or refused this file already.');

const notReady = () =>
  new ApiError(
    409,
    'incoming_not_ready',
    'This file is still being got ready to look at. Try again in a minute.',
    { retriable: true, retryAfter: 30 },
  );

/** A role that changed as this was asked: asked again, it is answered as it now is. */
const busy = () =>
  new ApiError(503, 'busy', 'The vault was busy just then. Try again.', {
    retriable: true,
    retryAfter: 1,
  });

const DAY = 864e5;

interface Held {
  id: string;
  request_id: string;
  state: string;
  submitted_at: Date | null;
  original_name: string;
  mime: string | null;
  byte_size: string | number | null;
  sha256: Buffer | null;
  cipher_bytes: string | number | null;
  cipher_sha256: Buffer | null;
  storage_key: string;
  vault_id: string;
  file_key_wrapped: Buffer;
  wrapped_by_scope: string;
  scan_state: string;
  preview_state: string;
  preview_pages: number | null;
  recipient_label: string | null;
}

export class IncomingService {
  private readonly enqueue: Enqueue;

  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    private readonly documents: DocumentService,
    private readonly opts: IncomingOptions = {},
  ) {
    this.enqueue = opts.enqueue ?? (async () => undefined);
  }

  /** Reviewers are the owners and adults, the roles that may ask (A43); anybody else, nothing here. */
  private mayReview(p: Principal): void {
    if (!can(p.role, 'upload_request.create')) throw notHere();
  }

  /**
   * The reviewer as they are now, held until the decision commits: a role
   * changed, a sign-in taken away, or locked (5.28), waits for it, and it
   * for them. One who can no longer review is answered as anybody else who
   * cannot.
   */
  private async stillReviews(trx: Db, p: Principal): Promise<void> {
    const me = await trx
      .selectFrom('account_household')
      .select(['role', 'suspended_at', 'suspended_until'])
      .where('account_id', '=', p.accountId)
      .where('household_id', '=', p.householdId)
      .forShare()
      .executeTakeFirst();
    if (!me || !can(me.role, 'upload_request.create')) throw notHere();
    // Locked, or paused after a restore (5.28): reviews nothing.
    if (suspensionInEffect(me)) throw notHere();
    // The database answers this transaction as the role it was asked with.
    if (me.role !== p.role) throw busy();
  }

  /** The files waiting for the reader, newest first. */
  async list(p: Principal): Promise<IncomingFileView[]> {
    this.mayReview(p);
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('incoming_file as f')
        .innerJoin('upload_request as r', 'r.id', 'f.request_id')
        .leftJoin('upload_request_item as i', 'i.id', 'f.item_id')
        .select([
          'f.id',
          'f.request_id',
          'r.title',
          'r.recipient_label',
          'i.label as item_label',
          'f.original_name',
          'f.mime',
          'f.byte_size',
          'f.sender_note',
          'f.submitted_at',
          'f.received_at',
          'f.scan_state',
          'f.preview_state',
          'f.preview_pages',
          'r.suggested_member_id',
          'r.suggested_type_key',
          'f.review_by',
          'f.owners_only',
        ])
        .where('f.state', '=', 'received')
        .where('f.submitted_at', 'is not', null)
        .where('f.scan_state', '<>', 'infected')
        .orderBy('f.submitted_at', 'desc')
        .orderBy('f.id')
        .execute();
      return rows.map((f) => {
        const scan = f.scan_state as IncomingScanState;
        // Sent: the query asks for nothing else.
        const sent = f.submitted_at as Date;
        const arrived: Date = f.received_at ?? sent;
        return {
          id: f.id,
          request_id: f.request_id,
          request_title: f.title,
          recipient_label: f.recipient_label,
          item_label: f.item_label,
          name: f.original_name ?? 'file',
          content_type: f.mime ?? 'application/octet-stream',
          byte_size: Number(f.byte_size ?? 0),
          sender_note: f.sender_note,
          sent_at: sent.toISOString(),
          removed_at: new Date(arrived.getTime() + INCOMING_KEEP_DAYS * DAY).toISOString(),
          scan_state: scan,
          preview_state: previewState(scan, f.preview_state),
          preview_pages: f.preview_state === 'ready' ? f.preview_pages : null,
          suggested_member_id: f.suggested_member_id,
          suggested_type_key: f.suggested_type_key,
          review_by: f.review_by,
          moved_to_owners: f.owners_only,
        };
      });
    });
  }

  /**
   * One waiting file, as the reader is given it: sent, not decided, not
   * found infected. With `lock`, held for a decision: one decided since is
   * `already_decided`, anything else not there.
   */
  private async waiting(trx: Db, id: string, lock = false): Promise<Held> {
    let q = trx
      .selectFrom('incoming_file as f')
      .select([
        'f.id',
        'f.request_id',
        'f.state',
        'f.submitted_at',
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
        'f.scan_state',
        'f.preview_state',
        'f.preview_pages',
        // Whom it is from, as the request names them (asked unlocked: the
        // file's row is what a decision holds).
        (eb) =>
          eb
            .selectFrom('upload_request as r')
            .select('r.recipient_label')
            .whereRef('r.id', '=', 'f.request_id')
            .as('recipient_label'),
      ])
      .where('f.id', '=', id);
    if (lock) q = q.forUpdate();
    const f = await q.executeTakeFirst();
    if (!f || f.submitted_at === null || f.scan_state === 'infected') throw notHere();
    if (f.state === 'accepted' || f.state === 'rejected') throw decidedAlready();
    if (f.state !== 'received') throw notHere();
    // Waiting, it has its name (only a refused file has none, 0047).
    return { ...f, original_name: f.original_name ?? 'file' };
  }

  /** The file's key, from the one it came in under (bound to it: `incoming:<id>`). */
  private async fileKeyOf(trx: Db, f: Held): Promise<Buffer> {
    const scopeKey = await this.keys.unwrapById(trx, f.wrapped_by_scope);
    return unwrapKey(f.file_key_wrapped, scopeKey, `incoming:${f.id}`);
  }

  /**
   * A page the worker drew for review (0047): a JPEG, decrypted here. Not
   * yet drawn, `preview_pending` (try again in a moment); a kind the vault
   * does not draw, or a page past what it drew, `no_preview`.
   */
  async page(p: Principal, id: string, n: number): Promise<Buffer> {
    this.mayReview(p);
    const out = await withPrincipal(this.db, p, async (trx) => {
      const f = await this.waiting(trx, id);
      const state = previewState(f.scan_state as IncomingScanState, f.preview_state);
      if (state === 'pending') return { kind: 'pending' } as const;
      if (state !== 'ready' || n > PREVIEW_MAX_PAGES || n > (f.preview_pages ?? 0)) {
        return { kind: 'none', why: state } as const;
      }
      return {
        kind: 'ready',
        key: incomingPreviewKey(f.storage_key, n),
        fileKey: await this.fileKeyOf(trx, f),
        adapter: await this.vaults.adapterById(trx, f.vault_id),
      } as const;
    });
    if (out.kind === 'pending') {
      throw new ApiError(
        404,
        'preview_pending',
        'The preview is being made. Try again in a moment.',
        { retriable: true, retryAfter: 3 },
      );
    }
    if (out.kind === 'none') {
      throw new ApiError(
        404,
        'no_preview',
        out.why === 'unsupported'
          ? "There's no preview for this kind of file. You can save a copy to look at it."
          : out.why === 'failed'
            ? "The vault couldn't draw this file's pages. You can save a copy to look at it."
            : "There's no preview of this page. You can save a copy to look at it.",
      );
    }
    const dec = new DecryptStream(out.fileKey);
    const [, plain] = await Promise.all([
      pipeline(await out.adapter.get(out.key), dec),
      readAll(dec),
    ]);
    return plain;
  }

  /**
   * A copy of the file, to look at it: always an attachment, under its own
   * name with the ending its bytes say (never the sender's), and said to be
   * unscanned when it is — this vault scans for nothing (A42). Each copy is
   * in the activity log, for the request's reviewers.
   */
  async content(
    p: Principal,
    id: string,
    meta: RequestMeta,
  ): Promise<{
    stream: Readable;
    total: number;
    contentType: string;
    filename: string;
    scanned: boolean;
  }> {
    this.mayReview(p);
    const got = await withPrincipal(this.db, p, async (trx) => {
      const f = await this.waiting(trx, id);
      if (f.scan_state === 'pending') throw notReady();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'incoming.downloaded',
        objectType: 'incoming_file',
        objectId: f.id,
        detail: { request_id: f.request_id, from: f.recipient_label },
        ip: meta.ip,
      });
      return {
        f,
        fileKey: await this.fileKeyOf(trx, f),
        adapter: await this.vaults.adapterById(trx, f.vault_id),
      };
    });
    const mime = got.f.mime ?? 'application/octet-stream';
    const cipher = await got.adapter.get(got.f.storage_key);
    const dec = new DecryptStream(got.fileKey);
    cipher.on('error', (e) => dec.destroy(e));
    return {
      stream: cipher.pipe(dec),
      total: Number(got.f.byte_size ?? 0),
      contentType: mime,
      filename: incomingFileName(got.f.original_name, mime),
      scanned: got.f.scan_state === 'clean',
    };
  }

  /**
   * Files it (POST /incoming/{id}/accept): a new document for the person,
   * kind, title and visibility chosen, checked as a capture's details are;
   * or `into_document_id`, a new version of a document the reviewer may see
   * and change, as adding a version asks — anything else about that
   * document is 404. Through the commit every upload goes through, in this
   * transaction: the file's key rewrapped for the document, its bytes
   * copied to where versions are kept. `version_id` says what it became.
   * The version's OCR is queued once it has committed, and not before.
   */
  async accept(
    p: Principal,
    id: string,
    input: z.infer<typeof acceptBody>,
    meta: RequestMeta,
  ): Promise<IncomingAccepted> {
    this.mayReview(p);
    const into = input.into_document_id;
    if (
      into &&
      (input.owner_member_id !== undefined ||
        input.type_key !== undefined ||
        input.title !== undefined ||
        input.visibility !== undefined)
    ) {
      throw new ApiError(
        422,
        'validation_failed',
        'Add it to a document, or make a new one with these details: not both.',
      );
    }
    // Where its bytes were copied to, if they were, for undoing that.
    const placed: { key: string | null; vaultId: string | null } = { key: null, vaultId: null };
    let out: { file: Held; documentId: string; versionId: string };
    try {
      out = await withPrincipal(this.db, p, async (trx) => {
        await this.stillReviews(trx, p);
        const f = await this.waiting(trx, id, true);
        if (f.scan_state === 'pending') throw notReady();
        // A kind the household does not have is refused, not filed with no
        // kind as a phone's queued capture is: this is chosen now, from the
        // list as it is.
        if (!into && input.type_key) {
          const kind = await trx
            .selectFrom('effective_document_type')
            .select('key')
            .where('key', '=', input.type_key)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (!kind) {
            throw new ApiError(
              422,
              'validation_failed',
              'That kind of document is not on the list.',
              {
                detail: 'type_key',
              },
            );
          }
        }
        placed.vaultId = f.vault_id;
        const fileKey = await this.fileKeyOf(trx, f);
        const mime = f.mime ?? 'application/octet-stream';
        let version;
        try {
          version = await this.documents.fileIncoming(
            trx,
            p,
            {
              target: into
                ? { kind: 'version', documentId: into }
                : {
                    kind: 'capture',
                    metadata: {
                      ...(input.owner_member_id !== undefined
                        ? { owner_member_id: input.owner_member_id }
                        : {}),
                      ...(input.type_key !== undefined ? { type_key: input.type_key } : {}),
                      ...(input.title !== undefined ? { title: input.title || null } : {}),
                      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
                    },
                  },
              file: {
                filename: incomingFileName(f.original_name, mime),
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
        } catch (err) {
          // A document the reviewer may not see, or may not change: not
          // there, whichever (the teen's rule included).
          if (into && err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            throw new ApiError(404, 'not_found', 'That document is not in the vault.');
          }
          throw err;
        }
        const decided = await trx
          .updateTable('incoming_file')
          .set({
            state: 'accepted',
            decided_by: p.accountId,
            decided_at: new Date(),
            document_id: version.document_id,
            version_id: version.id,
          })
          .where('id', '=', f.id)
          .where('state', '=', 'received')
          .executeTakeFirst();
        // Held since it was read: anything else is a rule that said no.
        if (Number(decided.numUpdatedRows) !== 1) throw decidedAlready();
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'incoming.accepted',
          objectType: 'incoming_file',
          objectId: f.id,
          detail: { request_id: f.request_id, from: f.recipient_label },
          ip: meta.ip,
        });
        await this.opts.beforeCommit?.('accept', f.id);
        return { file: f, documentId: version.document_id, versionId: version.id };
      });
    } catch (err) {
      if (placed.key && placed.vaultId) {
        await this.dropCopy(p, { fileId: id, vaultId: placed.vaultId, key: placed.key });
      }
      throw err;
    }
    await this.removeObjects(p, out.file);
    // The version's page count, thumbnail and OCR: only now it is filed.
    await this.enqueue(VERSION_PROCESS_JOB, {
      household_id: p.householdId,
      version_id: out.versionId,
    }).catch(() => undefined);
    return { document_id: out.documentId, version_id: out.versionId };
  }

  /**
   * Refuses it (POST /incoming/{id}/reject): its bytes and pages go, and so
   * do its name, the sender's note and its hash. What stays is a record
   * that a file of that kind and size came through the request, and who
   * refused it when.
   */
  async reject(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    this.mayReview(p);
    const f = await withPrincipal(this.db, p, async (trx) => {
      await this.stillReviews(trx, p);
      const f = await this.waiting(trx, id, true);
      const decided = await trx
        .updateTable('incoming_file')
        .set({
          state: 'rejected',
          decided_by: p.accountId,
          decided_at: new Date(),
          original_name: null,
          sender_note: null,
          sha256: null,
        })
        .where('id', '=', f.id)
        .where('state', '=', 'received')
        .executeTakeFirst();
      if (Number(decided.numUpdatedRows) !== 1) throw decidedAlready();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'incoming.rejected',
        objectType: 'incoming_file',
        objectId: f.id,
        detail: { request_id: f.request_id, from: f.recipient_label },
        ip: meta.ip,
      });
      await this.opts.beforeCommit?.('reject', f.id);
      return f;
    });
    await this.removeObjects(p, f);
  }

  /**
   * A decided file's object and previews, removed once the decision has
   * committed, and said so. Every page there could be, whatever its row
   * says was drawn: a drawing that stopped part-way (its worker gone) wrote
   * pages its row never counted (F523-3), and a page not there is nothing to
   * remove. A removal that fails is left for the worker's daily sweep, which
   * removes what no row says is gone.
   */
  private async removeObjects(
    p: Principal,
    f: { id: string; storage_key: string; vault_id: string },
  ): Promise<void> {
    try {
      const adapter: StorageAdapter = await withPrincipal(this.db, p, (trx) =>
        this.vaults.adapterById(trx, f.vault_id),
      );
      // Its pages all at once, not thirty round trips the reviewer waits for
      // (N523A-02); its object once they are gone.
      await deleteAll(adapter, incomingPageKeys(f.storage_key));
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
   * A filed file's copy, when filing it failed — only when it certainly did
   * not happen (F523-2). A commit whose answer was lost may still be
   * committing: so first the file's row is held, which that commit holds
   * until it ends, and then read as it is. Filed with this copy, it is the
   * version's file, and stays. Still waiting, or refused, or filed as
   * another version, nothing points at this copy, made under a name of its
   * own for this try, and it goes. Anything unsure — the row not given to
   * the reviewer any more, the wait too long, the database not answering —
   * keeps it: a stray copy is better than a version without its bytes.
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
        // Filed as this copy, or as a version not to be seen: kept.
        if (!filed || filed.storage_key === at.key) return;
      }
      await (await this.vaults.adapterById(trx, at.vaultId)).delete(at.key);
    }).catch(() => undefined);
  }
}

/** Its previews as the reader is told: being got ready until the scan has been and they are drawn. */
function previewState(scan: IncomingScanState, drawn: string): IncomingPreviewState {
  if (scan === 'pending' || drawn === 'none' || drawn === 'drawing') return 'pending';
  return drawn as IncomingPreviewState;
}
