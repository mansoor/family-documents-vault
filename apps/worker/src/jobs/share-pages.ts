import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, unwrapKey } from '@fdv/crypto';
import { withScope, withSystem, type Db } from '@fdv/db';
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
 * The API asks for them when the link is made, whenever the link is looked
 * at while they are still to be drawn (a newer version, a lost job), and
 * afresh when an owner turns the link back on after a restore. When the
 * link ends — taken back, run out, locked, or opened as often as it allows
 * with no page still open — `share.pages.prune` removes them: at once when
 * it is taken back, and every night for the rest. A drawing that fails
 * part-way removes what it wrote, and one that finishes after its link has
 * ended keeps nothing (5.18 review).
 *
 * A collection's link to view (5.19) has pages for each document it gives
 * now. Which those are is asked of the database as the link itself (0042's
 * rules decide, and nothing here says them again); the job names one of
 * their versions, or none for all of them.
 */

export interface SharePagesJob {
  household_id: string;
  share_id: string;
  /**
   * The version the API saw (its queue key). A document's link draws its
   * newest whatever this says; a collection's draws this one, when it is
   * the newest of a document the link gives, or all of them when unsaid.
   */
  version_id?: string;
  /** Draw them again even where they are drawn: their files may be gone (a restore). */
  redraw?: boolean;
}

/** Where a link's page is kept: beside its version's object, in its vault. */
export const sharePageKey = (storageKey: string, shareId: string, page: number) =>
  `${storageKey}.share-${shareId}.p${page}.enc`;

/** A label as it is drawn: one line, with nothing in it that is not to be seen. */
const cleanLabel = (label: string) =>
  label
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/**
 * What is written across a link's pages: whom it is for, and the day it was
 * made. The label is set apart (U+2068…U+2069), so a name in Arabic or
 * Hebrew keeps to its own place and the date stays after it.
 */
export function watermarkText(
  link: { recipient_label: string | null; created_at: Date },
  timezone: string,
): string {
  const label = link.recipient_label ? cleanLabel(link.recipient_label) : '';
  const who = label ? `Shared with ⁨${label}⁩` : 'Shared by link';
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

/** Whether a link can no longer be opened, and nobody has a page of it open. */
function ended(
  link: {
    revoked_at: Date | null;
    paused_at: Date | null;
    expires_at: Date;
    attempts: number;
    open_count: number;
    max_opens: number | null;
  },
  openSessions: number,
): boolean {
  return (
    link.revoked_at !== null ||
    link.paused_at !== null ||
    link.expires_at.getTime() <= Date.now() ||
    link.attempts >= 10 ||
    (link.max_opens !== null && link.open_count >= link.max_opens && openSessions === 0)
  );
}

const LINK_COLUMNS = [
  'id',
  'document_id',
  'collection_id',
  'permission',
  'recipient_label',
  'created_at',
  'revoked_at',
  'paused_at',
  'expires_at',
  'attempts',
  'open_count',
  'max_opens',
] as const;

/** Sessions of a link still open: a page opened before it was used up may still ask. */
const openSessionsOf = async (trx: Db, shareId: string) =>
  Number(
    (
      await trx
        .selectFrom('share_session')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('share_id', '=', shareId)
        .where('expires_at', '>', new Date())
        .executeTakeFirstOrThrow()
    ).n,
  );

/**
 * Draws one view-only link's pages. `final` is the queue's last try, as for
 * the previews: then a drawing that fails is recorded for the link, the
 * version and when (`share_page_failure`, 0042 — 0041 kept one on the
 * link), and the API says so to the sharer and the recipient rather than
 * "being drawn" for ever — for an hour, after which somebody looking at the
 * link asks for them again (a storage outage passes; the version's own
 * previews failing does not). A collection's link, each of its documents
 * alike: one failing leaves the others drawn.
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
      .select([...LINK_COLUMNS])
      .where('id', '=', job.share_id)
      .executeTakeFirst();
    if (!link) return null;
    // A document's link: its document's newest version, in the same
    // transaction, as 5.18 found it.
    const first =
      link.document_id !== null ? await newestDrawn(trx, link.id, link.document_id) : null;
    return { link, first, open: await openSessionsOf(trx, link.id) };
  });
  // Nothing to draw for a link that gives the file, or has ended (its pages
  // are the prune's), or is paused (turned back on, it asks again).
  if (!found) return { drawn: 0 };
  const { link } = found;
  if (link.permission !== 'view' || ended(link, found.open)) return { drawn: 0 };
  if (link.document_id !== null) {
    return drawDocumentPages(deps, job, link, link.document_id, attempt, found.first);
  }

  // A collection's: the documents it gives now, as the database gives them
  // to the link itself — the newest version of each — or the one the job
  // names.
  const documents = (
    await withScope(
      deps.db,
      { householdId: hh, actor: { kind: 'link', shareId: link.id } },
      (trx) => trx.selectFrom('document_version').select(['id', 'document_id']).execute(),
    )
  )
    .filter((v) => !job.version_id || v.id === job.version_id)
    .map((v) => v.document_id);

  let drawn = 0;
  let failure: Error | null = null;
  for (const documentId of documents) {
    try {
      drawn += (await drawDocumentPages(deps, job, link, documentId, attempt)).drawn;
    } catch (err) {
      // The others are drawn all the same; the queue tries again for this one.
      failure ??= err instanceof Error ? err : new Error(String(err));
    }
  }
  if (failure) throw failure;
  return { drawn };
}

type LinkOf = {
  id: string;
  document_id: string | null;
  collection_id: string | null;
  recipient_label: string | null;
  created_at: Date;
};

/** A document's newest version, and how many of its pages the link has drawn. */
async function newestDrawn(trx: Db, shareId: string, documentId: string) {
  const version = await trx
    .selectFrom('document_version')
    .select(['id', 'preview_state', 'preview_pages'])
    .where('document_id', '=', documentId)
    .orderBy('version_no', 'desc')
    .executeTakeFirst();
  const drawn = version
    ? await trx
        .selectFrom('share_page')
        .select('n')
        .where('share_id', '=', shareId)
        .where('version_id', '=', version.id)
        .execute()
    : [];
  return { version, drawn: drawn.length };
}

/**
 * One document's pages of a link to view: its newest version's, drawn and
 * kept. `given` is that version as the caller found it already.
 */
async function drawDocumentPages(
  deps: ProcessDeps,
  job: SharePagesJob,
  link: LinkOf,
  documentId: string,
  attempt: { final: boolean },
  given?: Awaited<ReturnType<typeof newestDrawn>> | null,
): Promise<{ drawn: number }> {
  const hh = job.household_id;
  const found =
    given ?? (await withSystem(deps.db, hh, (trx) => newestDrawn(trx, link.id, documentId)));
  if (!found.version) return { drawn: 0 };
  if (found.drawn > 0 && !job.redraw) return { drawn: found.drawn };

  const versionId = found.version.id;
  const keys: string[] = [];
  let adapter: StorageAdapter | null = null;
  try {
    // The version's own pages first, drawn now if they are not yet: a link
    // made the moment its file arrived waits no longer than they take.
    let version = found.version;
    if (version.preview_state === 'none' || version.preview_state === 'queued') {
      await renderVersionPreviews(deps, { household_id: hh, version_id: versionId }, attempt);
      version = await withSystem(deps.db, hh, (trx) =>
        trx
          .selectFrom('document_version')
          .select(['id', 'preview_state', 'preview_pages'])
          .where('id', '=', versionId)
          .executeTakeFirstOrThrow(),
      );
    }
    const pages = version.preview_pages ?? 0;
    // A file the vault cannot draw, or could not: nothing to show, and the
    // API tells both ends so from the version itself.
    if (version.preview_state !== 'ready' || pages < 1) return { drawn: 0 };

    const ctx = await withSystem(deps.db, hh, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .select(['document_id', 'storage_key', 'vault_id', 'file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', versionId)
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
    adapter = ctx.adapter;

    const text = watermarkText(link, ctx.timezone);
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-sp-'));
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

    // All of them at once, and only if the link is still there to show them:
    // taken back (or run out, or locked) while they were being drawn, it
    // keeps none — the prune its taking back asked for has already run, and
    // found nothing to remove. The link is held while this is decided —
    // against its being taken back, run out or locked, which change it;
    // not against a document's following it, which only names it (FOR NO
    // KEY UPDATE, the 5.19 review's second round: FOR UPDATE waited on a
    // collection's addition while it held the document this goes on to
    // name, and one of the two was ended as a deadlock).
    const kept = await withSystem(deps.db, hh, async (trx) => {
      const now = await trx
        .selectFrom('share_link')
        .select([...LINK_COLUMNS])
        .where('id', '=', link.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!now || ended(now, await openSessionsOf(trx, link.id))) return null;
      // This document's pages of the link: a collection's has others'.
      const old = await trx
        .deleteFrom('share_page')
        .where('share_id', '=', link.id)
        .where('document_id', '=', ctx.documentId)
        .returning('storage_key')
        .execute();
      await trx
        .insertInto('share_page')
        .values(
          keys.map((storage_key, i) => ({
            household_id: hh,
            share_id: link.id,
            document_id: ctx.documentId,
            version_id: versionId,
            n: i + 1,
            storage_key,
          })),
        )
        .execute();
      // Drawn: any failure this document's pages had on this link, of this
      // version or an older one, is over (0042, a version at a time).
      await trx
        .deleteFrom('share_page_failure')
        .where('share_id', '=', link.id)
        .where('document_id', '=', ctx.documentId)
        .execute();
      return { stale: old.map((o) => o.storage_key).filter((k) => !keys.includes(k)) };
    });
    if (!kept) {
      // What this drawing wrote and no row names; a file a row still names
      // is the prune's, with its row.
      await removeAll(ctx.adapter, await unnamed(deps.db, hh, link.id, keys));
      deps.log('info', 'a link ended while its pages were drawn: they were not kept', {
        share_id: link.id,
      });
      return { drawn: 0 };
    }
    // An older version's pages, drawn before a newer one came.
    await removeAll(ctx.adapter, kept.stale);
    deps.log('info', "drew a link's pages", { share_id: link.id, pages: keys.length });
    return { drawn: keys.length };
  } catch (err) {
    // What was written of a drawing that did not finish, and no row names,
    // would never be removed by anything else. A redraw writes where the
    // pages it redraws are kept (5.18 review): those files are still the
    // pages a row names, and are served, so they stay. Only a redraw's keys
    // can be named: a first drawing's are all removed, without asking the
    // database — which may be why it failed (the third review). (The queue
    // draws one link and version at a time, so nothing else names them.)
    if (adapter) {
      const orphans =
        found.drawn > 0
          ? await unnamed(deps.db, hh, link.id, keys).catch(() => [] as string[])
          : keys;
      await removeAll(adapter, orphans);
    }
    if (attempt.final) {
      // This version of this document, and when: a document's link and each
      // document of a collection's alike (0042). Tried again an hour later.
      await withSystem(deps.db, hh, (trx) =>
        trx
          .insertInto('share_page_failure')
          .values({
            household_id: hh,
            share_id: link.id,
            document_id: documentId,
            version_id: versionId,
            failed_at: new Date(),
          })
          .onConflict((oc) =>
            oc.columns(['share_id', 'version_id']).doUpdateSet({ failed_at: new Date() }),
          )
          .execute(),
      ).catch(() => undefined);
    }
    deps.log('warn', "could not draw a link's pages", {
      share_id: link.id,
      final: attempt.final,
      err: (err as Error).message,
    });
    throw err;
  }
}

async function removeAll(adapter: StorageAdapter, keys: string[]) {
  for (const key of keys) await adapter.delete(key).catch(() => undefined);
}

/** Of the keys a drawing wrote, those no `share_page` row of the link names. */
async function unnamed(db: Db, hh: string, shareId: string, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const named = await withSystem(db, hh, (trx) =>
    trx
      .selectFrom('share_page')
      .select('storage_key')
      .where('share_id', '=', shareId)
      .where('storage_key', 'in', keys)
      .execute(),
  );
  const kept = new Set(named.map((r) => r.storage_key));
  return keys.filter((k) => !kept.has(k));
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
