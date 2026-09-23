import { randomBytes } from 'node:crypto';
import { openChunk, sealChunk, unwrapKey, wrapKey, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db, type Visibility } from '@fdv/db';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { requireCapability } from '../authz.js';
import { canSee } from '@fdv/shared';

/**
 * Changing a document's visibility (SEC-13, FND-07, decision 2).
 *
 * The file is never re-encrypted: each version's file key is unwrapped
 * with the old scope key and rewrapped with the new one, 32 bytes at a
 * time. OCR text moves between the plain table (household, adults) and the
 * sealed table (private), so a private document's words leave the index
 * in the same transaction that hides the document.
 */
export class VisibilityService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
  ) {}

  /**
   * The sentence that has to be said at the moment it becomes true
   * (SEC-19). It is a message about death, so it is brief, plain and
   * unsentimental, and it is said once per document and never again.
   */
  static readonly PRIVATE_NOTICE = {
    title: 'Only you can open this',
    body: 'Nobody can open it after you, unless you leave a key. Leaving a key with someone you trust is not built yet; when it is, this document will be on the list.',
  };

  async change(
    p: Principal,
    documentId: string,
    to: Visibility,
    meta: RequestMeta,
  ): Promise<{ notice: { title: string; body: string } | null }> {
    requireCapability(p, 'document.visibility');
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const doc = await trx
        .selectFrom('document')
        .select(['id', 'visibility', 'owner_member_id'])
        .where('id', '=', documentId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // Somebody else's private document is not there, as it is everywhere
      // else — a 403 here would confirm that it exists.
      if (!doc || !canSee({ role: p.role, memberId: p.memberId }, doc)) {
        throw new ApiError(404, 'not_found', 'That document is not in the vault.');
      }
      // Only the owning member may see a private document, so only they may
      // move one in or out of private.
      if (
        (doc.visibility === 'private' || to === 'private') &&
        doc.owner_member_id !== p.memberId
      ) {
        throw new ApiError(
          403,
          'forbidden',
          'Only the person a document belongs to can make it private, or un-private it.',
        );
      }
      if (doc.visibility === to) return { notice: null };

      const from = await this.keys.unwrap(
        trx,
        scopeRef(p.householdId, doc.visibility, doc.owner_member_id),
      );
      const target = await this.keys.unwrap(trx, scopeRef(p.householdId, to, doc.owner_member_id));

      const versions = await trx
        .selectFrom('document_version')
        .select(['id', 'file_key_wrapped'])
        .where('document_id', '=', documentId)
        .execute();
      for (const v of versions) {
        const fileKey = unwrapKey(v.file_key_wrapped, from.key, `version:${documentId}`);
        await trx
          .updateTable('document_version')
          .set({
            file_key_wrapped: wrapKey(fileKey, target.key, `version:${documentId}`),
            wrapped_by_scope: target.id,
          })
          .where('id', '=', v.id)
          .execute();
      }

      // Move the text.
      if (to === 'private') {
        const plain = await trx
          .selectFrom('document_text')
          .selectAll()
          .where('document_id', '=', documentId)
          .execute();
        for (const row of plain) {
          const prefix = randomBytes(8);
          const bytes = Buffer.from(row.content, 'utf8');
          const sealed = sealChunk(
            target.key,
            { prefix, chunkSize: bytes.length || 1 },
            0,
            true,
            bytes,
          );
          await trx
            .insertInto('document_text_sealed')
            .values({
              version_id: row.version_id,
              household_id: p.householdId,
              document_id: documentId,
              content_cipher: Buffer.concat([prefix, sealed]),
            })
            .execute();
        }
        await trx.deleteFrom('document_text').where('document_id', '=', documentId).execute();
      } else if (doc.visibility === 'private') {
        const sealed = await trx
          .selectFrom('document_text_sealed')
          .selectAll()
          .where('document_id', '=', documentId)
          .execute();
        for (const row of sealed) {
          const prefix = row.content_cipher.subarray(0, 8);
          const body = row.content_cipher.subarray(8);
          const content = openChunk(
            from.key,
            { prefix, chunkSize: body.length - 16 },
            0,
            true,
            body,
          ).toString('utf8');
          await trx
            .insertInto('document_text')
            .values({
              version_id: row.version_id,
              household_id: p.householdId,
              document_id: documentId,
              content,
            })
            .execute();
        }
        await trx
          .deleteFrom('document_text_sealed')
          .where('document_id', '=', documentId)
          .execute();
      }

      await trx
        .updateTable('document')
        .set({ visibility: to, updated_at: new Date(), updated_by: p.accountId })
        .where('id', '=', documentId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.visibility_changed',
        objectType: 'document',
        objectId: documentId,
        detail: { from: doc.visibility, to, versions: versions.length },
        ip: meta.ip,
      });

      if (to !== 'private') return { notice: null };
      // Told once per document, per person. A second visit to the same
      // decision is not a second chance to warn somebody; it is a nag.
      const already = await trx
        .selectFrom('private_notice')
        .select(['document_id'])
        .where('document_id', '=', documentId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      if (already) return { notice: null };
      await trx
        .insertInto('private_notice')
        .values({
          household_id: p.householdId,
          document_id: documentId,
          member_id: p.memberId,
        })
        .execute();
      return { notice: VisibilityService.PRIVATE_NOTICE };
    });
  }
}

function scopeRef(householdId: string, visibility: Visibility, ownerMemberId: string | null) {
  switch (visibility) {
    case 'household':
      return { householdId, kind: 'household' as const };
    case 'adults':
      return { householdId, kind: 'adults' as const };
    case 'private':
      return { householdId, kind: 'member' as const, memberId: ownerMemberId };
  }
}
