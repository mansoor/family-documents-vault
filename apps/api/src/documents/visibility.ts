import { randomBytes } from 'node:crypto';
import { openChunk, sealChunk, unwrapKey, wrapKey, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db, type Visibility } from '@fdv/db';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';

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

  async change(p: Principal, documentId: string, to: Visibility, meta: RequestMeta): Promise<void> {
    if (p.role === 'viewer' || p.role === 'teen') {
      throw new ApiError(403, 'forbidden', 'Only adults can change who sees a document.');
    }
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const doc = await trx
        .selectFrom('document')
        .select(['id', 'visibility', 'owner_member_id'])
        .where('id', '=', documentId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!doc) throw new ApiError(404, 'not_found', 'That document is not in the vault.');
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
      if (doc.visibility === to) return;

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
