import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, unwrapKey } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import { shareEndWords } from '@fdv/shared';
import { adapterFromRow, type StorageAdapter } from '@fdv/storage';
import { sql } from 'kysely';
import type pg from 'pg';
import { renderVersionPreviews, previewKey } from './previews.js';
import { decryptToBuffer, type ProcessDeps } from './process-version.js';
import { watermarkPage } from './tools.js';

/**
 * A view-only link's pages (5.18, A22).
 *
 * A link to view never gives the file. It gives the pages the vault drew
 * of it (4.7), drawn again for the link with whom it is for and the day it
 * was made written across each (watermarkPage), encrypted under the
 * version's own file key and kept beside it as
 * `<storage_key>.share-<share>.p<n>.enc`, one `share_page` row each. The
 * first 30 pages, as the previews are.
 *
 * The API asks for them when the link is made, again when a page is asked
 * for and there are none (a newer version, a lost job), and afresh when an
 * owner turns the link back on after a restore. When the link ends —
 * taken back, run out, locked, or opened as often as it allows with no
 * page still open — `share.pages.prune` removes them: at once when it is
 * taken back, and every night for the rest.
 */

export interface SharePagesJob {
  household_id: string;
  share_id: string;
  /** Draw them again even where they are drawn: their files may be gone (a restore). */
  redraw?: boolean;
}

/** Where a link's page is kept: beside its version's object, in its vault. */
export const sharePageKey = (storageKey: string, shareId: string, page: number) =>
  `${storageKey}.share-${shareId}.p${page}.enc`;

/** What is written across a link's pages: whom it is for, and the day it was made. */
export function watermarkText(
  link: { recipient_label: string | null; created_at: Date },
  timezone: string,
): string {
  const who = link.recipient_label?.trim()
    ? `Shared with ${link.recipient_label.trim()}`
    : 'Shared by link';
  const day = shareEndWords(link.created_at, timezone, { weekday: false }).replace(/ at .*$/, '');
  const year = new Intl.DateTimeFormat('en-GB', { timeZone: safeZone(timezone), year: 'numeric' })
    .format(link.created_at)
    .trim();
  return `${who} · ${day} ${year}`;
}

function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/**
 * Draws one view-only link's pages. `final` is the queue's last try, as for
 * the previews: a version whose own pages cannot be drawn is recorded as
 * failed then, and the API says so to the sharer and the recipient.
 */
export async function drawSharePages(
  deps: ProcessDeps,
  job: SharePagesJob,
  attempt: { final: boolean } = { final: true },
): Promise<{ drawn: number }> {
  const hh = job.household_id;
  const found = await withSystem(deps.db, hh, async (trx) => {
    const link = await trx
      .selectFrom('share_link')
      .select([
        'id',
        'document_id',
        'permission',
        'recipient_label',
        'created_at',
        'revoked_at',
        'paused_at',
        'expires_at',
        'attempts',
      ])
      .where('id', '=', job.share_id)
      .executeTakeFirst();
    if (!link) return null;
    const version = await trx
      .selectFrom('document_version')
      .select(['id', 'preview_state', 'preview_pages'])
      .where('document_id', '=', link.document_id)
      .orderBy('version_no', 'desc')
      .executeTakeFirst();
    const drawn = version
      ? await trx
          .selectFrom('share_page')
          .select('n')
          .where('share_id', '=', link.id)
          .where('version_id', '=', version.id)
          .execute()
      : [];
    return { link, version, drawn: drawn.length };
  });
  // Nothing to draw for a link that gives the file, or has ended (its pages
  // are the prune's), or is paused (turned back on, it asks again).
  if (!found?.version) return { drawn: 0 };
  const { link } = found;
  if (
    link.permission !== 'view' ||
    link.revoked_at ||
    link.paused_at ||
    link.expires_at.getTime() <= Date.now() ||
    link.attempts >= 10
  ) {
    return { drawn: 0 };
  }
  if (found.drawn > 0 && !job.redraw) return { drawn: found.drawn };

  // The version's own pages first, drawn now if they are not yet: a link
  // made the moment its file arrived waits no longer than they take.
  let version = found.version;
  if (version.preview_state === 'none' || version.preview_state === 'queued') {
    await renderVersionPreviews(deps, { household_id: hh, version_id: version.id }, attempt);
    version = await withSystem(deps.db, hh, (trx) =>
      trx
        .selectFrom('document_version')
        .select(['id', 'preview_state', 'preview_pages'])
        .where('id', '=', found.version?.id ?? '')
        .executeTakeFirstOrThrow(),
    );
  }
  const pages = version.preview_pages ?? 0;
  // A file the vault cannot draw, or could not: nothing to show, and the
  // API tells both ends so.
  if (version.preview_state !== 'ready' || pages < 1) return { drawn: 0 };

  const ctx = await withSystem(deps.db, hh, async (trx) => {
    const v = await trx
      .selectFrom('document_version')
      .select(['document_id', 'storage_key', 'vault_id', 'file_key_wrapped', 'wrapped_by_scope'])
      .where('id', '=', version.id)
      .executeTakeFirstOrThrow();
    const vault = await trx
      .selectFrom('vault')
      .selectAll()
      .where('id', '=', v.vault_id)
      .executeTakeFirstOrThrow();
    const household = await trx
      .selectFrom('household')
      .select('timezone')
      .executeTakeFirstOrThrow();
    const scopeKey = await deps.keys.unwrapById(trx, v.wrapped_by_scope);
    return {
      storageKey: v.storage_key,
      documentId: v.document_id,
      adapter: adapterFromRow(vault, deps.credentialsKey, deps.localRoot),
      fileKey: unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`),
      timezone: household.timezone,
    };
  });

  const text = watermarkText(link, ctx.timezone);
  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-sp-'));
  const keys: string[] = [];
  try {
    for (let n = 1; n <= pages; n += 1) {
      const plain = path.join(dir, `page-${n}.jpg`);
      const marked = path.join(dir, `marked-${n}.jpg`);
      await writeFile(
        plain,
        await decryptToBuffer(ctx.adapter, previewKey(ctx.storageKey, n), ctx.fileKey),
      );
      await watermarkPage(plain, marked, text);
      const key = sharePageKey(ctx.storageKey, link.id, n);
      await putEncrypted(ctx.adapter, key, ctx.fileKey, await readFile(marked));
      keys.push(key);
      await rm(plain, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // All of them at once: until now the link had none of this version's, and
  // said "being drawn"; from now it has every one.
  const stale = await withSystem(deps.db, hh, async (trx) => {
    const old = await trx
      .deleteFrom('share_page')
      .where('share_id', '=', link.id)
      .returning('storage_key')
      .execute();
    await trx
      .insertInto('share_page')
      .values(
        keys.map((storage_key, i) => ({
          household_id: hh,
          share_id: link.id,
          document_id: ctx.documentId,
          version_id: version.id,
          n: i + 1,
          storage_key,
        })),
      )
      .execute();
    return old.map((o) => o.storage_key).filter((k) => !keys.includes(k));
  });
  // An older version's pages, drawn before a newer one came.
  for (const key of stale) await ctx.adapter.delete(key).catch(() => undefined);
  deps.log('info', "drew a link's pages", { share_id: link.id, pages: keys.length });
  return { drawn: keys.length };
}

async function putEncrypted(adapter: StorageAdapter, key: string, fileKey: Buffer, plain: Buffer) {
  const enc = new EncryptStream(fileKey);
  await Promise.all([adapter.put(key, enc), pipeline(Readable.from([plain]), enc)]);
}

export interface PruneSharePagesDeps {
  admin: pg.Pool;
  app: Db;
  credentialsKey: Buffer;
  localRoot: string;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * The pages whose link has ended — taken back, run out, locked by wrong
 * PINs, or opened as often as it allows with no page open on it any more —
 * and those of a version a newer one has replaced. As SQL, over share_page
 * `p` and its share_link `l`.
 */
const ENDED = `(l.revoked_at is not null
    or l.expires_at <= now()
    or l.attempts >= 10
    or (l.max_opens is not null and l.open_count >= l.max_opens
        and not exists (select 1 from share_session s
                         where s.share_id = l.id and s.expires_at > now()))
    or p.version_id <> (select v.id from document_version v
                         where v.document_id = p.document_id
                         order by v.version_no desc limit 1))`;

/**
 * Removes ended links' pages: their files, then their rows. One link's, when
 * it has just been taken back; every household's, each night. A file that
 * is not there any more is not an error, and a vault that cannot be reached
 * keeps its rows until the next time, so no file is ever forgotten.
 */
export async function pruneSharePages(
  deps: PruneSharePagesDeps,
  only?: { household_id: string; share_id: string },
): Promise<{ removed: number }> {
  const households = only
    ? [only.household_id]
    : (
        await deps.admin.query<{ household_id: string }>(
          `select distinct p.household_id from share_page p
             join share_link l on l.id = p.share_id
            where ${ENDED}`,
        )
      ).rows.map((r) => r.household_id);
  let removed = 0;
  for (const hh of households) {
    const rows = await withSystem(deps.app, hh, async (trx) => {
      const found = await sql<{
        share_id: string;
        version_id: string;
        n: number;
        storage_key: string;
        vault_id: string;
      }>`select p.share_id, p.version_id, p.n, p.storage_key, v.vault_id
           from share_page p
           join share_link l on l.id = p.share_id
           join document_version v on v.id = p.version_id
          where ${sql.raw(ENDED)}
            and (${only?.share_id ?? null}::uuid is null or p.share_id = ${only?.share_id ?? null}::uuid)`.execute(
        trx,
      );
      return found.rows;
    });
    const adapters = new Map<string, StorageAdapter | null>();
    const done: typeof rows = [];
    for (const r of rows) {
      if (!adapters.has(r.vault_id)) {
        const vault = await withSystem(deps.app, hh, (trx) =>
          trx.selectFrom('vault').selectAll().where('id', '=', r.vault_id).executeTakeFirst(),
        );
        adapters.set(
          r.vault_id,
          vault ? adapterFromRow(vault, deps.credentialsKey, deps.localRoot) : null,
        );
      }
      const adapter = adapters.get(r.vault_id);
      if (!adapter) continue;
      // Not there any more is removed too; unreachable waits for next time.
      const ok = await adapter.delete(r.storage_key).then(
        () => true,
        () => false,
      );
      if (ok) done.push(r);
    }
    if (!done.length) continue;
    await withSystem(deps.app, hh, async (trx) => {
      for (const r of done) {
        await trx
          .deleteFrom('share_page')
          .where('share_id', '=', r.share_id)
          .where('version_id', '=', r.version_id)
          .where('n', '=', r.n)
          .execute();
      }
    });
    removed += done.length;
  }
  if (removed) deps.log?.('info', "removed ended links' pages", { removed });
  return { removed };
}
