import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  memberPhotoBinding,
  memberPhotoSourceBinding,
  sealBytes,
  unwrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import { appendAudit, withSystem, type Db } from '@fdv/db';
import { adapterFromRow, type StorageAdapter } from '@fdv/storage';
import { sql } from 'kysely';
import { decryptToBuffer } from './process-version.js';
import { detectTools, photoType, squarePhoto, type PhotoCrop } from './tools.js';

/**
 * A person's photo, made (5.17c).
 *
 * The API took the upload and sealed it as it arrived into a temporary
 * object — `<household>/members/<person>/incoming/<photo>.enc`, under a
 * fresh file key wrapped by the household key — and wrote a row that says
 * it is on its way. This job opens it into a folder only the worker can
 * read, works out what it is from its bytes, and makes the square
 * (`squarePhoto`: the first frame, turned upright, cropped, stripped of
 * every tag, under MAGICK_LIMITS). The square is sealed under the household
 * key, bound to the household, the person and the photo, and kept in the
 * row; in one transaction the row is checked again, the person's old photo
 * goes, this one is made ready, the upload's columns are cleared and the
 * activity log says so. Then the upload is deleted, and the folder.
 *
 * A row that is no longer on its way — replaced by a newer photo, taken
 * away, or given up on — is nothing to do. On the queue's last try a photo
 * that could not be made is marked failed, and its upload deleted at once.
 * Nothing of the file is logged: it had no name here, and its bytes never
 * leave the folder.
 */

export interface MemberPhotoJob {
  household_id: string;
  member_id: string;
  photo_id: string;
}

export interface MemberPhotoDeps {
  db: Db;
  keys: ScopeKeys;
  credentialsKey: Buffer;
  localRoot: string;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

/** What the job did: made the photo, found nothing to do, or gave up on it. */
export type MemberPhotoOutcome = 'ready' | 'nothing' | 'failed';

/** One change to a person's photo at a time: the API takes the same lock. */
const lockPerson = (trx: Db, householdId: string, memberId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`member-photo:${householdId}:${memberId}`}, 0))`.execute(
    trx,
  );

export async function makeMemberPhoto(
  deps: MemberPhotoDeps,
  job: MemberPhotoJob,
  attempt: { final: boolean } = { final: true },
): Promise<MemberPhotoOutcome> {
  const { household_id: hh, member_id: memberId, photo_id: photoId } = job;
  const ctx = await withSystem(deps.db, hh, async (trx) => {
    const row = await trx
      .selectFrom('member_photo')
      .select(['state', 'crop', 'source_key', 'source_vault_id', 'source_key_wrapped'])
      .where('id', '=', photoId)
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    if (row?.state !== 'processing' || !row.source_key || !row.source_key_wrapped) return null;
    const vault = row.source_vault_id
      ? await trx
          .selectFrom('vault')
          .selectAll()
          .where('id', '=', row.source_vault_id)
          .executeTakeFirst()
      : undefined;
    const scope = await deps.keys.unwrap(trx, { householdId: hh, kind: 'household' });
    return {
      sourceKey: row.source_key,
      crop: (row.crop ?? null) as PhotoCrop | null,
      adapter: vault ? adapterFromRow(vault, deps.credentialsKey, deps.localRoot) : null,
      scopeKey: scope.key,
      fileKey: unwrapKey(
        row.source_key_wrapped,
        scope.key,
        memberPhotoSourceBinding(hh, memberId, photoId),
      ),
    };
  });
  if (!ctx) {
    deps.log('info', 'member photo: nothing to do', { photo_id: photoId });
    return 'nothing';
  }

  // Only the worker can read it: mkdtemp makes the folder 0700.
  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-photo-'));
  try {
    if (!ctx.adapter) throw new Error('the vault the photo was sent to is gone');
    const tools = await detectTools();
    if (!tools.magick) throw new Error('ImageMagick is not installed');
    const plain = await decryptToBuffer(ctx.adapter, ctx.sourceKey, ctx.fileKey);
    const mime = photoType(plain.subarray(0, 64));
    if (!mime) throw new Error('the upload is not a photo the vault makes squares of');
    const source = path.join(dir, 'source');
    await writeFile(source, plain, { mode: 0o600 });
    const square = await squarePhoto(source, mime, ctx.crop, path.join(dir, 'square.jpg'));
    const sealed = sealBytes(ctx.scopeKey, square, memberPhotoBinding(hh, memberId, photoId));

    const made = await withSystem(deps.db, hh, async (trx) => {
      await lockPerson(trx, hh, memberId);
      // Still this one: not replaced, taken away or given up on meanwhile.
      const still = await trx
        .selectFrom('member_photo')
        .select(['state', 'created_by'])
        .where('id', '=', photoId)
        .forUpdate()
        .executeTakeFirst();
      if (still?.state !== 'processing') return false;
      const old = await trx
        .deleteFrom('member_photo')
        .where('member_id', '=', memberId)
        .where('state', '=', 'ready')
        .returning('id')
        .execute();
      await trx
        .updateTable('member_photo')
        .set({
          state: 'ready',
          sealed,
          ready_at: new Date(),
          source_key: null,
          source_vault_id: null,
          source_key_wrapped: null,
        })
        .where('id', '=', photoId)
        .execute();
      await appendAudit(trx, {
        householdId: hh,
        actorAccountId: still.created_by,
        action: 'member.photo_changed',
        objectType: 'member',
        objectId: memberId,
        detail: { replaced: old.length > 0 },
      });
      return true;
    });
    await dropUpload(ctx.adapter, ctx.sourceKey);
    if (!made) {
      deps.log('info', 'member photo: replaced or taken away while it was made', {
        photo_id: photoId,
      });
      return 'nothing';
    }
    deps.log('info', 'made a member photo', { photo_id: photoId, member_id: memberId });
    return 'ready';
  } catch (err) {
    deps.log('warn', 'could not make a member photo', {
      photo_id: photoId,
      member_id: memberId,
      final: attempt.final,
      err: (err as Error).message,
    });
    if (!attempt.final) throw err;
    // Given up on: refused, and the upload goes at once.
    await withSystem(deps.db, hh, (trx) =>
      trx
        .updateTable('member_photo')
        .set({ state: 'failed', source_key: null, source_vault_id: null, source_key_wrapped: null })
        .where('id', '=', photoId)
        .where('state', '=', 'processing')
        .execute(),
    );
    if (ctx.adapter) await dropUpload(ctx.adapter, ctx.sourceKey);
    return 'failed';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The upload as sent: gone. Its key went with the row's source columns, so
 * whatever a vault that cannot be reached keeps is ciphertext nobody can open.
 */
async function dropUpload(adapter: StorageAdapter, key: string): Promise<void> {
  await adapter.delete(key).catch(() => undefined);
}
