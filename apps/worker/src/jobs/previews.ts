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
 * There is one way a version's pages are drawn: a `version.previews` job,
 * at most one per version queued or running (the queue is `exclusive` on
 * `previewJobKey`). Essentials are queued eagerly — after processing, when
 * a document becomes Essential, and by a backfill when the worker starts —
 * so a phone can keep them for offline use; everything else is queued the
 * first time somebody asks for a page.
 */

export interface RenderPreviewsJob {
  household_id: string;
  version_id: string;
}

/** Queues a version's drawing; the queue drops it while one is already on its way. */
export type SendPreviews = (
  job: RenderPreviewsJob,
  opts?: { priority?: number },
) => Promise<unknown>;

/** The queue's singleton key: one job per version, queued or running. */
export const previewJobKey = (versionId: string) => `previews:${versionId}`;

/** Where a version's pages are stored: beside its object, in its vault. */
export const previewKey = (storageKey: string, page: number) => `${storageKey}.p${page}.enc`;

/**
 * Draws one version's pages. `final` says whether this is the queue's last
 * try: until then a failure leaves the version queued — a reader keeps
 * hearing "being made" while the queue tries again — and on the last try it
 * is recorded as failed. The file itself is never affected.
 */
export async function renderVersionPreviews(
  deps: ProcessDeps,
  job: RenderPreviewsJob,
  attempt: { final: boolean } = { final: true },
): Promise<void> {
  const { household_id: hh, version_id } = job;
  const current = await withHousehold(deps.db, hh, (trx) =>
    trx
      .selectFrom('document_version')
      .select(['preview_state', 'mime'])
      .where('id', '=', version_id)
      .executeTakeFirst(),
  );
  if (!current) {
    deps.log('warn', 'previews: version vanished', { version_id });
    return;
  }
  // Drawn, not drawable, or given up on (asking again queues it afresh).
  if (current.preview_state !== 'none' && current.preview_state !== 'queued') return;

  // Only ever from waiting to an outcome: a result already recorded stays.
  const record = (preview_state: PreviewState, preview_pages: number | null) =>
    withHousehold(deps.db, hh, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state, preview_pages })
        .where('id', '=', version_id)
        .where('preview_state', 'in', ['none', 'queued'])
        .execute(),
    );
  if (!drawable(current.mime)) {
    await record('unsupported', 0);
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-pv-'));
  try {
    const ctx = await withHousehold(deps.db, hh, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .select(['document_id', 'storage_key', 'vault_id', 'file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', version_id)
        .executeTakeFirstOrThrow();
      const vault = await trx
        .selectFrom('vault')
        .selectAll()
        .where('id', '=', v.vault_id)
        .executeTakeFirstOrThrow();
      const scopeKey = await deps.keys.unwrapById(trx, v.wrapped_by_scope);
      return {
        storageKey: v.storage_key,
        adapter: adapterFromRow(vault, deps.credentialsKey, deps.localRoot),
        fileKey: unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`),
      };
    });
    const tools = await detectTools();
    if (!tools.magick || (current.mime === 'application/pdf' && !tools.pdftoppm)) {
      throw new Error('the tools to draw pages are not installed');
    }
    const plainFile = path.join(dir, 'source');
    await writeFile(plainFile, await decryptToBuffer(ctx.adapter, ctx.storageKey, ctx.fileKey));
    const out = await mkdtemp(path.join(dir, 'pages-'));
    const pages = await renderPreviews(plainFile, current.mime, out, PREVIEW_MAX_PAGES);
    if (!pages.length) throw new Error('no pages came out');
    for (const [i, file] of pages.entries()) {
      await putEncrypted(
        ctx.adapter,
        previewKey(ctx.storageKey, i + 1),
        ctx.fileKey,
        await readFile(file),
      );
    }
    await record('ready', pages.length);
    deps.log('info', 'drew page previews', { version_id, pages: pages.length });
  } catch (err) {
    if (attempt.final) {
      await record('failed', 0).catch(() => undefined);
    } else {
      // Still on its way: the queue tries again, and nobody re-queues it meanwhile.
      await withHousehold(deps.db, hh, (trx) =>
        trx
          .updateTable('document_version')
          .set({ preview_state: 'queued', preview_requested_at: new Date() })
          .where('id', '=', version_id)
          .where('preview_state', 'in', ['none', 'queued'])
          .execute(),
      ).catch(() => undefined);
    }
    deps.log('warn', 'could not draw page previews', {
      version_id,
      final: attempt.final,
      err: (err as Error).message,
    });
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function putEncrypted(adapter: StorageAdapter, key: string, fileKey: Buffer, plain: Buffer) {
  const enc = new EncryptStream(fileKey);
  await Promise.all([adapter.put(key, enc), pipeline(Readable.from([plain]), enc)]);
}

/**
 * When the worker starts: the current version of every Essential whose
 * pages were never drawn, whose job was lost on the way, or whose drawing
 * failed more than a day ago, is queued — a bounded number at a time. The
 * queue draws them one by one, so a vault full of Essentials is caught up
 * over a few restarts' worth of quiet work rather than all at once.
 */
export async function backfillPreviews(deps: {
  admin: pg.Pool;
  app: Db;
  send: SendPreviews;
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
         or (preview_state = 'failed' and preview_requested_at < now() - interval '1 day')
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
        .where('preview_state', 'in', ['none', 'queued', 'failed'])
        .executeTakeFirst(),
    );
    if (Number(marked.numUpdatedRows) === 0) continue;
    await deps.send({ household_id: r.household_id, version_id: r.id });
    queued += 1;
  }
  return queued;
}
