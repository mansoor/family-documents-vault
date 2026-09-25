import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, EncryptStream, sealChunk, unwrapKey, type ScopeKeys } from '@fdv/crypto';
import { withHousehold, type Db } from '@fdv/db';
import { adapterFromRow, readAll, type StorageAdapter } from '@fdv/storage';
import { drawPreviews } from './previews.js';
import {
  detectTools,
  drawable,
  ocrImage,
  pdfPageCount,
  readIfExists,
  renderPdfPages,
  thumbnail,
} from './tools.js';

/**
 * The ingest pipeline's background half (design, Ingest pipeline):
 *
 *   stored -> page count -> thumbnail -> OCR -> index -> pages (Essentials)
 *
 * The document is already visible and downloadable; everything here only
 * enriches it. A failed step is recorded on the version and never blocks
 * anything. Thumbnails are encrypted with the version's own file key and
 * cached in the vault; OCR text lands in `document_text` (plain, indexed)
 * or `document_text_sealed` (private documents), never both.
 */

export interface ProcessVersionJob {
  household_id: string;
  version_id: string;
}

export interface ProcessDeps {
  db: Db;
  keys: ScopeKeys;
  credentialsKey: Buffer;
  localRoot: string;
  maxOcrPages: number;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);

export async function processVersion(deps: ProcessDeps, job: ProcessVersionJob): Promise<void> {
  const { household_id: hh, version_id } = job;
  const tools = await detectTools();

  const ctx = await withHousehold(deps.db, hh, async (trx) => {
    const version = await trx
      .selectFrom('document_version')
      .selectAll()
      .where('id', '=', version_id)
      .executeTakeFirst();
    if (!version) return null;
    const doc = await trx
      .selectFrom('document')
      .select(['id', 'visibility', 'owner_member_id', 'is_essential'])
      .where('id', '=', version.document_id)
      .executeTakeFirstOrThrow();
    const vault = await trx
      .selectFrom('vault')
      .selectAll()
      .where('id', '=', version.vault_id)
      .executeTakeFirstOrThrow();
    const scopeKey = await deps.keys.unwrapById(trx, version.wrapped_by_scope);
    const fileKey = unwrapKey(version.file_key_wrapped, scopeKey, `version:${version.document_id}`);
    return {
      version,
      doc,
      adapter: adapterFromRow(vault, deps.credentialsKey, deps.localRoot),
      fileKey,
      scopeKey,
    };
  });
  if (!ctx) {
    deps.log('warn', 'process: version vanished', { version_id });
    return;
  }
  const { version, doc, adapter, fileKey, scopeKey } = ctx;

  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-proc-'));
  try {
    // 1. Plaintext to a temp file. It lives only for this job.
    const ext = version.mime === 'application/pdf' ? 'pdf' : 'img';
    const plainFile = path.join(dir, `source.${ext}`);
    await writeFile(plainFile, await decryptToBuffer(adapter, version.storage_key, fileKey));

    const isPdf = version.mime === 'application/pdf';
    const isImage = IMAGE_MIMES.has(version.mime);
    const update: {
      page_count?: number | null;
      thumbnail_key?: string | null;
      ocr_status: 'done' | 'failed' | 'skipped';
      process_error?: string | null;
      preview_state?: 'unsupported';
      preview_pages?: number;
    } = { ocr_status: 'skipped' };
    const errors: string[] = [];

    // 2. Page count (PDF only).
    if (isPdf && tools.pdftoppm) update.page_count = await pdfPageCount(plainFile);
    if (isImage) update.page_count = 1;

    // 3. Thumbnail, encrypted with the version's key, cached beside the object.
    if ((isPdf || isImage) && tools.magick) {
      try {
        const thumbFile = path.join(dir, 'thumb.jpg');
        await thumbnail(plainFile, thumbFile);
        const bytes = await readIfExists(thumbFile);
        if (bytes) {
          const key = `${version.storage_key}.thumb.enc`;
          await putEncrypted(adapter, key, fileKey, bytes);
          update.thumbnail_key = key;
        }
      } catch (err) {
        errors.push(`thumbnail: ${(err as Error).message}`);
      }
    }

    // 4. OCR, page by page, bounded.
    if ((isPdf || isImage) && tools.tesseract && (!isPdf || tools.pdftoppm)) {
      try {
        const pages = isPdf ? await renderPdfPages(plainFile, dir, deps.maxOcrPages) : [plainFile];
        const texts: string[] = [];
        for (const p of pages) texts.push(await ocrImage(p));
        const content = texts.join('\n\n').trim();
        await storeText(deps.db, hh, version.id, doc, scopeKey, content);
        update.ocr_status = 'done';
      } catch (err) {
        errors.push(`ocr: ${(err as Error).message}`);
        update.ocr_status = 'failed';
      }
    }

    // 5. Page previews (4.7): an Essential's are drawn now, from the
    // plaintext already here, so a phone can keep them; everything else's
    // the first time somebody asks. A kind the vault cannot draw says so.
    if (doc.is_essential && drawable(version.mime) && version.preview_state !== 'ready') {
      try {
        await drawPreviews(deps, hh, { version, adapter, fileKey, dir, plainFile });
      } catch (err) {
        errors.push(`previews: ${(err as Error).message}`);
      }
    } else if (!drawable(version.mime)) {
      update.preview_state = 'unsupported';
      update.preview_pages = 0;
    }

    update.process_error = errors.length ? errors.join('; ') : null;
    await withHousehold(deps.db, hh, (trx) =>
      trx
        .updateTable('document_version')
        .set({ ...update, processed_at: new Date() })
        .where('id', '=', version.id)
        .execute(),
    );
    deps.log(errors.length ? 'warn' : 'info', 'processed version', {
      version_id: version.id,
      pages: update.page_count ?? null,
      thumbnail: Boolean(update.thumbnail_key),
      ocr: update.ocr_status,
      errors: errors.length ? errors : undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function putEncrypted(adapter: StorageAdapter, key: string, fileKey: Buffer, plain: Buffer) {
  const enc = new EncryptStream(fileKey);
  await Promise.all([adapter.put(key, enc), pipeline(Readable.from([plain]), enc)]);
}

/** OCR text goes to exactly one table, decided by the document's visibility (decision 2). */
async function storeText(
  db: Db,
  hh: string,
  versionId: string,
  doc: { id: string; visibility: 'household' | 'adults' | 'private' },
  scopeKey: Buffer,
  content: string,
) {
  await withHousehold(db, hh, async (trx) => {
    await trx.deleteFrom('document_text').where('version_id', '=', versionId).execute();
    await trx.deleteFrom('document_text_sealed').where('version_id', '=', versionId).execute();
    if (doc.visibility === 'private') {
      // One chunk under the member's scope key with a fresh random nonce
      // prefix, stored in front of the ciphertext: `prefix(8) || ct || tag`.
      const prefix = randomBytes(8);
      const plain = Buffer.from(content, 'utf8');
      const sealed = sealChunk(scopeKey, { prefix, chunkSize: plain.length || 1 }, 0, true, plain);
      await trx
        .insertInto('document_text_sealed')
        .values({
          version_id: versionId,
          household_id: hh,
          document_id: doc.id,
          content_cipher: Buffer.concat([prefix, sealed]),
        })
        .execute();
    } else {
      await trx
        .insertInto('document_text')
        .values({ version_id: versionId, household_id: hh, document_id: doc.id, content })
        .execute();
    }
  });
}

export async function decryptToBuffer(
  adapter: StorageAdapter,
  key: string,
  fileKey: Buffer,
): Promise<Buffer> {
  const dec = new DecryptStream(fileKey);
  const [, plain] = await Promise.all([pipeline(await adapter.get(key), dec), readAll(dec)]);
  return plain;
}
