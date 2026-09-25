import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, unwrapKey } from '@fdv/crypto';
import { withHousehold, type Db, type PreviewState } from '@fdv/db';
import { PREVIEW_MAX_PAGES } from '@fdv/shared';
import { adapterFromRow, type StorageAdapter } from '@fdv/storage';
import type pg from 'pg';
import { decryptToBuffer, type ProcessDeps } from './process-version.js';
import { detectTools, drawable, renderPreviews } from './tools.js';

/**
 * Pages the vault draws (4.7). Each page of a version becomes a JPEG,
 * 1600 px on the long edge, encrypted under the version's own file key and
 * stored beside it as `<storage_key>.p<n>.enc`. Clients show these instead
 * of rendering a PDF themselves: no PDF renderer on the phone, and no
 * plaintext file on it either.
 *
 * Essentials are drawn eagerly — after processing, when a document
 * becomes Essential, and by a backfill when the worker starts — so a
 * phone can keep them for offline use. Everything else is drawn the
 * first time somebody asks for a page.
 */

export interface RenderPreviewsJob {
  household_id: string;
  version_id: string;
}

/** Where a version's pages are stored: beside its object, in its vault. */
export const previewKey = (storageKey: string, page: number) => `${storageKey}.p${page}.enc`;

export async function renderVersionPreviews(
  deps: ProcessDeps,
  job: RenderPreviewsJob,
): Promise<void> {
  const { household_id: hh, version_id } = job;
  const ctx = await withHousehold(deps.db, hh, async (trx) => {
    const v = await trx
      .selectFrom('document_version')
      .select([
        'id',
        'document_id',
        'storage_key',
        'vault_id',
        'mime',
        'file_key_wrapped',
        'wrapped_by_scope',
        'preview_state',
      ])
      .where('id', '=', version_id)
      .executeTakeFirst();
    if (!v) return null;
    const vault = await trx
      .selectFrom('vault')
      .selectAll()
      .where('id', '=', v.vault_id)
      .executeTakeFirstOrThrow();
    const scopeKey = await deps.keys.unwrapById(trx, v.wrapped_by_scope);
    return {
      version: v,
      adapter: adapterFromRow(vault, deps.credentialsKey, deps.localRoot),
      fileKey: unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`),
    };
  });
  if (!ctx) {
    deps.log('warn', 'previews: version vanished', { version_id });
    return;
  }
  // Twice asked is once drawn.
  if (ctx.version.preview_state === 'ready' || ctx.version.preview_state === 'unsupported') return;

  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-pv-'));
  try {
    const plainFile = path.join(dir, 'source');
    await writeFile(
      plainFile,
      await decryptToBuffer(ctx.adapter, ctx.version.storage_key, ctx.fileKey),
    );
    await drawPreviews(deps, hh, { ...ctx, dir, plainFile });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Draws, encrypts and stores the pages of a version whose plaintext is
 * already in `plainFile` (processing has one; the job decrypts its own),
 * and records the outcome. A failure is recorded and then thrown, so the
 * queue tries again; the file itself is never affected.
 */
export async function drawPreviews(
  deps: ProcessDeps,
  hh: string,
  ctx: {
    version: { id: string; storage_key: string; mime: string };
    adapter: StorageAdapter;
    fileKey: Buffer;
    dir: string;
    plainFile: string;
  },
): Promise<number> {
  const { version } = ctx;
  const record = (preview_state: PreviewState, preview_pages: number | null) =>
    withHousehold(deps.db, hh, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state, preview_pages })
        .where('id', '=', version.id)
        .execute(),
    );
  if (!drawable(version.mime)) {
    await record('unsupported', 0);
    return 0;
  }
  try {
    const tools = await detectTools();
    if (!tools.magick || (version.mime === 'application/pdf' && !tools.pdftoppm)) {
      throw new Error('the tools to draw pages are not installed');
    }
    const out = await mkdtemp(path.join(ctx.dir, 'pages-'));
    const pages = await renderPreviews(ctx.plainFile, version.mime, out, PREVIEW_MAX_PAGES);
    if (!pages.length) throw new Error('no pages came out');
    for (const [i, file] of pages.entries()) {
      await putEncrypted(
        ctx.adapter,
        previewKey(version.storage_key, i + 1),
        ctx.fileKey,
        await readFile(file),
      );
    }
    await record('ready', pages.length);
    deps.log('info', 'drew page previews', { version_id: version.id, pages: pages.length });
    return pages.length;
  } catch (err) {
    await record('failed', 0).catch(() => undefined);
    deps.log('warn', 'could not draw page previews', {
      version_id: version.id,
      err: (err as Error).message,
    });
    throw err;
  }
}

async function putEncrypted(adapter: StorageAdapter, key: string, fileKey: Buffer, plain: Buffer) {
  const enc = new EncryptStream(fileKey);
  await Promise.all([adapter.put(key, enc), pipeline(Readable.from([plain]), enc)]);
}

/**
 * When the worker starts: the current version of every Essential whose
 * pages were never drawn (or whose job was lost on the way) is queued, a
 * bounded number at a time. The queue draws them one by one, so a vault
 * full of Essentials is caught up over a few restarts' worth of quiet
 * work rather than all at once.
 */
export async function backfillPreviews(deps: {
  admin: pg.Pool;
  app: Db;
  send: (job: RenderPreviewsJob) => Promise<unknown>;
  limit?: number;
}): Promise<number> {
  // Which ones, across households (read only); each is then marked queued
  // under its own household's scope, as every other write is.
  const { rows } = await deps.admin.query<{ household_id: string; id: string }>(
    `select id, household_id from (
       select distinct on (v.document_id) v.id, v.household_id, v.preview_state, v.preview_requested_at
         from document_version v
         join document d on d.id = v.document_id
        where d.is_essential and d.deleted_at is null
        order by v.document_id, v.version_no desc
     ) latest
      where preview_state = 'none'
         or (preview_state = 'queued' and preview_requested_at < now() - interval '1 hour')
      order by id
      limit $1`,
    [deps.limit ?? 200],
  );
  let queued = 0;
  for (const r of rows) {
    const marked = await withHousehold(deps.app, r.household_id, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state: 'queued', preview_requested_at: new Date() })
        .where('id', '=', r.id)
        .where('preview_state', 'in', ['none', 'queued'])
        .executeTakeFirst(),
    );
    if (Number(marked.numUpdatedRows) === 0) continue;
    await deps.send({ household_id: r.household_id, version_id: r.id });
    queued += 1;
  }
  return queued;
}
