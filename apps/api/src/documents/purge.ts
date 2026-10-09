import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  PREVIEW_MAX_PAGES,
  PURGE_NOTICE_HOURS,
  shareEndWords,
  type DocumentView,
} from '@fdv/shared';
import { StorageError, type StorageAdapter } from '@fdv/storage';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { removableAtOnce, signsInHere } from './purge-rule.js';
import {
  dropDeletedType,
  seenDocument,
  type DocRow,
  type DocumentService,
  type Enqueue,
} from './service.js';

/**
 * Removing a document for good (5.24, D1).
 *
 * Nothing empties the Trash by itself. An owner may remove a document in it
 * for good: at once, one they filed or that is theirs; anybody else's only
 * once its filer has been told and has had a day to bring it back. So the
 * first call for somebody else's document asks (202): whoever filed it and
 * the other owners are told then, and its Trash row says so. A call once
 * `PURGE_NOTICE_HOURS` have passed — on the database's clock, from the
 * moment of asking — removes it, if it is still in the Trash. Bringing it
 * back cancels the request (DocumentService.restore). Every call asks to
 * confirm it's you (`remove_for_good`).
 *
 * A removal is one transaction, in this order:
 *
 *  1. Rows held, in the one order every writer of them takes: the sessions
 *     of the document's own links (a request in a session holds its session
 *     first), its own links, the pages any link drew of it (what keeps a
 *     link's pages holds the link, then those rows, then names the
 *     document), the document, then its versions in id order. The
 *     household's activity log is taken last, as every writer takes it.
 *     So a removal racing a download through a link, the share-pages
 *     worker, an upload of a new version, Bring it back or a collection's
 *     addition waits for it, or is waited for; it never deadlocks with it.
 *  2. Every object it owns written down to be deleted (purge_leftover):
 *     each version's file, its thumbnail, its page previews, the pages any
 *     link to view drew of it, and the file of an upload to it that never
 *     finished.
 *  3. Its tombstone (0045) — who could see it — then the row, every
 *     foreign key to it cascading.
 *  4. The line in the activity log, with no title.
 *
 * Then the objects are deleted, each row going with its object, a missing
 * one being fine. Storage out of reach, or a crash, leaves rows for the
 * worker to finish (purge.leftovers), never a document that can be brought
 * back with half its files (the 5.24 review, M524-2). Their file keys went
 * with the document: what is left meanwhile cannot be read.
 *
 * And a version a restore marked removed for good is looked for first: one
 * whose file is there after all is unmarked, and the removal refused, so
 * nobody removes a file they were told was already gone (D524-02).
 */

export type PurgeOutcome =
  | { removed: true }
  /** Asked, not removed: whoever filed it has been told (202). */
  | { removed: false; document: DocumentView };

type Alert = (input: AlertRequest) => Promise<void>;

/** Where a version's page previews are: the worker's previewKey (jobs/previews.ts). */
const previewKey = (storageKey: string, n: number) => `${storageKey}.p${n}.enc`;
/** Where a link drew its own page: the worker's sharePageKey (jobs/share-pages.ts). */
const sharePageKey = (storageKey: string, shareId: string, n: number) =>
  `${storageKey}.share-${shareId}.p${n}.enc`;
/** Where a version's thumbnail is: process-version.ts writes it beside the file. */
const thumbnailKey = (storageKey: string) => `${storageKey}.thumb.enc`;

const notThere = () => new ApiError(404, 'not_found', 'That document is not in the vault.');

const notInTrash = () =>
  new ApiError(
    409,
    'not_in_trash',
    'Only a document in the Trash can be removed for good. Move it to the Trash first.',
  );

const fileFound = () =>
  new ApiError(
    409,
    'file_found',
    'Its file was found where your files are kept after all, so it can be opened again and was not removed. Look at it before you remove it for good.',
  );

/** The worker's job that finishes a removal's deletions (its JOBS.purgeLeftovers). */
export const PURGE_LEFTOVERS_JOB = 'purge.leftovers';

/** Rows written in one statement: well within what one may carry. */
const LEFTOVER_ROWS = 2000;

/** What a document is, as far as removing it goes. */
type Held = DocRow & { household_id: string; type_key: string | null };

/** What is decided about a document, for the caller, now. */
type Decision = { kind: 'remove' } | { kind: 'ask' } | { kind: 'wait'; allowedFrom: Date };

export class PurgeService {
  constructor(
    private readonly db: Db,
    private readonly vaults: VaultService,
    private readonly docs: DocumentService,
    /** How whoever filed it, and the other owners, are told (alert.send). */
    private readonly alert: Alert = async () => undefined,
    /** How the worker is asked to finish deletions a removal could not. */
    private readonly enqueue: Enqueue = async () => undefined,
  ) {}

  /**
   * What the route asks before confirming it's you: who may, and that the
   * document is there to be asked about and may be removed or asked about
   * now. A refusal here is the same as the call's own, and asks nothing.
   */
  async check(p: Principal, id: string): Promise<void> {
    requireCapability(p, 'document.purge');
    await withPrincipal(this.db, p, async (trx) => {
      const doc = await this.find(trx, p, id, false);
      const decided = await this.decide(trx, p, doc);
      if (decided.kind === 'wait') throw await this.tooSoon(trx, decided.allowedFrom);
    });
  }

  async purge(p: Principal, id: string, meta: RequestMeta): Promise<PurgeOutcome> {
    requireCapability(p, 'document.purge');
    await this.lookAgain(p, id);
    const done = await withPrincipal(this.db, p, async (trx) => {
      await this.holdAround(trx, id);
      const doc = await this.find(trx, p, id, true);
      const decided = await this.decide(trx, p, doc);
      if (decided.kind === 'wait') throw await this.tooSoon(trx, decided.allowedFrom);
      if (decided.kind === 'ask') return this.ask(trx, p, doc, meta);
      await this.remove(trx, p, doc, meta);
      return null;
    });
    if (!done) {
      await this.sweep(p, id);
      return { removed: true };
    }
    // Told once the request is kept, and never in a way that undoes it: the
    // Trash says so whether or not a message gets through.
    for (const message of done.tell) await this.alert(message).catch(() => undefined);
    return { removed: false, document: done.document };
  }

  // ------------------------------------------------- before, and after

  /**
   * Its versions a restore marked removed for good, looked for again: one
   * whose file is where it is kept after all is unmarked, and the removal
   * refused (409 file_found), so nobody removes a file they were told was
   * gone. A place that cannot be reached is no answer, and the marks stand.
   */
  private async lookAgain(p: Principal, id: string): Promise<void> {
    const marked = await withPrincipal(this.db, p, async (trx) => {
      const versions = await trx
        .selectFrom('document_version as v')
        .innerJoin('document as d', 'd.id', 'v.document_id')
        .select(['v.id', 'v.storage_key', 'v.vault_id'])
        .where('v.document_id', '=', id)
        .where('v.file_removed_at', 'is not', null)
        .where('d.deleted_at', 'is not', null)
        .where(seenDocument(p))
        .execute();
      const adapters = new Map<string, StorageAdapter>();
      for (const v of versions) {
        if (!adapters.has(v.vault_id)) {
          adapters.set(v.vault_id, await this.vaults.adapterById(trx, v.vault_id));
        }
      }
      return { versions, adapters };
    });
    const found: string[] = [];
    for (const v of marked.versions) {
      const adapter = marked.adapters.get(v.vault_id);
      const there = await adapter?.stat(v.storage_key).then(
        () => true,
        () => false,
      );
      if (there) found.push(v.id);
    }
    if (found.length === 0) return;
    await withPrincipal(this.db, p, (trx) =>
      trx
        .updateTable('document_version')
        .set({ file_removed_at: null })
        .where('id', 'in', found)
        .execute(),
    );
    throw fileFound();
  }

  /**
   * The objects a removal wrote down, deleted, each row going with its
   * object; a missing one is fine. Whatever cannot be deleted now — storage
   * out of reach — is left for the worker, which is asked to finish it: a
   * place that fails once is not tried again here, so the owner is answered
   * in the time one try takes, not one per object.
   */
  private async sweep(p: Principal, id: string): Promise<void> {
    const rows = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('purge_leftover')
        .select(['id', 'vault_id', 'object_key'])
        .where('removed_document', '=', id)
        .orderBy('id')
        .execute(),
    );
    const done: string[] = [];
    let left = false;
    const byVault = new Map<string, typeof rows>();
    for (const r of rows) byVault.set(r.vault_id, [...(byVault.get(r.vault_id) ?? []), r]);
    for (const [vaultId, held] of byVault) {
      const adapter = await withPrincipal(this.db, p, (trx) =>
        this.vaults.adapterById(trx, vaultId),
      ).catch(() => null);
      if (!adapter) {
        left = true;
        continue;
      }
      for (const r of held) {
        try {
          await adapter.delete(r.object_key);
          done.push(r.id);
        } catch (err) {
          if (err instanceof StorageError && err.code === 'not_found') {
            done.push(r.id);
            continue;
          }
          // Out of reach once is out of reach for the rest: they wait for the
          // worker, and the owner is answered now (the 5.24 check, N524R-3).
          left = true;
          break;
        }
      }
    }
    if (done.length) {
      await withPrincipal(this.db, p, (trx) =>
        trx.deleteFrom('purge_leftover').where('id', 'in', done).execute(),
      );
    }
    if (left) {
      // One queued at a time a household: each finishes all it has.
      await this.enqueue(
        PURGE_LEFTOVERS_JOB,
        { household_id: p.householdId },
        { singletonKey: `purge.leftovers:${p.householdId}` },
      ).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ deciding

  /**
   * The document as the caller may see it, in the Trash; held FOR UPDATE
   * when `hold` (after holdAround). Not seen is not there; out of the
   * Trash is refused.
   */
  private async find(trx: Db, p: Principal, id: string, hold: boolean): Promise<Held> {
    let q = trx
      .selectFrom('document as d')
      .selectAll('d')
      .where('d.id', '=', id)
      .where(seenDocument(p));
    if (hold) q = q.forUpdate();
    const doc = (await q.executeTakeFirst()) as Held | undefined;
    if (!doc) throw notThere();
    if (!doc.deleted_at) throw notInTrash();
    return doc;
  }

  /**
   * Remove now, ask, or wait. One the caller filed — or that is theirs, when
   * nobody filed it or whoever did has left — is removed at once
   * (removableAtOnce). Anybody else's is asked about first, and removed once
   * `PURGE_NOTICE_HOURS` have passed since — counted by the database's clock.
   */
  private async decide(trx: Db, p: Principal, doc: Held): Promise<Decision> {
    if (removableAtOnce(p, doc, await signsInHere(trx, doc.created_by))) {
      return { kind: 'remove' };
    }
    if (!doc.purge_requested_at) return { kind: 'ask' };
    const r = await sql<{ due: boolean; allowed_from: Date }>`
      select purge_requested_at + make_interval(hours => ${PURGE_NOTICE_HOURS}) <= now() as due,
             purge_requested_at + make_interval(hours => ${PURGE_NOTICE_HOURS}) as allowed_from
        from document where id = ${doc.id}`.execute(trx);
    const row = r.rows[0];
    if (!row) throw notThere();
    return row.due ? { kind: 'remove' } : { kind: 'wait', allowedFrom: row.allowed_from };
  }

  /** Asked already, and not yet a day ago: refused, saying from when. */
  private async tooSoon(trx: Db, allowedFrom: Date): Promise<ApiError> {
    const household = await trx
      .selectFrom('household')
      .select('timezone')
      .executeTakeFirstOrThrow();
    return new ApiError(
      409,
      'purge_not_yet',
      `Whoever filed it has been told, and can bring it back until then: it can be removed for good from ${shareEndWords(allowedFrom, household.timezone)}.`,
      { detail: allowedFrom.toISOString() },
    );
  }

  // ------------------------------------------------------------- asking

  /**
   * Somebody else's document: asked about, now. Whoever filed it, while
   * they are in the household, and the other owners are told once the
   * request is kept. Nothing names it in what leaves the vault.
   */
  private async ask(
    trx: Db,
    p: Principal,
    doc: Held,
    meta: RequestMeta,
  ): Promise<{ document: DocumentView; tell: AlertRequest[] }> {
    // Held already (find): the row is still in the Trash and unasked. The
    // database holds the time to its own clock, and the request to an
    // owner in their own name (0045).
    const asked = await trx
      .updateTable('document')
      .set({ purge_requested_at: sql<Date>`now()`, purge_requested_by: p.accountId })
      .where('id', '=', doc.id)
      .where('deleted_at', 'is not', null)
      .where('purge_requested_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!asked) throw new Error('a request to remove a held document was not kept');
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'document.purge_requested',
      objectType: 'document',
      objectId: doc.id,
      ip: meta.ip,
    });

    const [document] = await this.docs.listed(trx, p, [asked]);
    const people = await trx
      .selectFrom('account_household as ah')
      .innerJoin('member as m', 'm.id', 'ah.member_id')
      .select(['ah.account_id', 'ah.role', 'm.display_name', 'm.id as member_id'])
      .where('ah.household_id', '=', p.householdId)
      .execute();
    const household = await trx
      .selectFrom('household')
      .select('timezone')
      .executeTakeFirstOrThrow();
    const asker = people.find((x) => x.account_id === p.accountId)?.display_name ?? 'An owner';
    const at = asked.purge_requested_at as Date;
    const from = new Date(at.getTime() + PURGE_NOTICE_HOURS * 3_600_000);
    const tell: AlertRequest[] = [];
    // Whoever filed it, if they are still one of the household's.
    const filer =
      doc.created_by && doc.created_by !== p.accountId
        ? people.find((x) => x.account_id === doc.created_by)
        : undefined;
    if (filer) {
      // Told how to keep it as they can: bring it back, when they may (the
      // Trash's own rule: who may change documents, a teen only their own);
      // otherwise ask somebody who may.
      const mayKeep =
        can(filer.role, 'document.edit') &&
        (filer.role !== 'teen' || doc.owner_member_id === filer.member_id);
      tell.push({
        householdId: p.householdId,
        accountIds: [filer.account_id],
        subject: 'An owner asked to remove one of your documents for good',
        body:
          `${asker} asked to remove one of the documents you added for good on ` +
          `${shareEndWords(at, household.timezone, { weekday: false })}. ` +
          (mayKeep
            ? 'Bring it back to keep it: it is in the Trash. '
            : 'To keep it, ask an owner or another adult to bring it back from the Trash. ') +
          `Otherwise it can be removed for good from ${shareEndWords(from, household.timezone)}.`,
      });
    }
    // And the other owners: any of them may remove it once the day is over.
    const owners = people
      .filter(
        (x) =>
          x.role === 'owner' && x.account_id !== p.accountId && x.account_id !== filer?.account_id,
      )
      .map((x) => x.account_id);
    if (owners.length) {
      tell.push({
        householdId: p.householdId,
        accountIds: owners,
        subject: 'An owner asked to remove a document for good',
        body:
          `${asker} asked to remove a document in the Trash for good. Whoever added it is told ` +
          'too, if they still sign in here. Bringing it back from the Trash within ' +
          `${PURGE_NOTICE_HOURS} hours keeps it. The activity log says which.`,
      });
    }
    return { document: document as DocumentView, tell };
  }

  // ------------------------------------------------------------ removing

  /**
   * The rows a removal would wait on, held before the document is, in the
   * order the writers of each hold them (see the top of this file). Nothing
   * is held that a writer holding one of these could then be waiting for.
   */
  private async holdAround(trx: Db, id: string): Promise<void> {
    await holdDocumentRows(trx, id);
  }

  private async remove(trx: Db, p: Principal, doc: Held, meta: RequestMeta): Promise<void> {
    // Its versions, held in id order, after the document.
    const versions = await trx
      .selectFrom('document_version')
      .select(['id', 'storage_key', 'thumbnail_key', 'vault_id'])
      .where('document_id', '=', doc.id)
      .orderBy('id')
      .forUpdate()
      .execute();

    // Every object it owns, by the place it is kept.
    const byVault = await ownedObjects(trx, doc.id, versions);

    // Written down, to be deleted once the rows are gone (purge_leftover,
    // 0045): a removal that stops part-way leaves these to finish, never a
    // document that could be brought back with half its files.
    const leftovers = [...byVault].flatMap(([vaultId, keys]) =>
      [...keys].map((key) => ({
        household_id: p.householdId,
        vault_id: vaultId,
        object_key: key,
        removed_document: doc.id,
      })),
    );
    for (let at = 0; at < leftovers.length; at += LEFTOVER_ROWS) {
      await trx
        .insertInto('purge_leftover')
        .values(leftovers.slice(at, at + LEFTOVER_ROWS))
        .onConflict((oc) => oc.columns(['vault_id', 'object_key']).doNothing())
        .execute();
    }

    // Who could see it, and the collections' links that named it, for the
    // activity log (0045): written while the row is there to be checked.
    const named = await trx
      .selectFrom('share_link_item')
      .select('share_id')
      .where('document_id', '=', doc.id)
      .where('kind', 'in', ['ticked', 'followed'])
      .orderBy('share_id')
      .execute();
    await trx
      .insertInto('document_tombstone')
      .values({
        id: doc.id,
        household_id: p.householdId,
        visibility: doc.visibility,
        owner_member_id: doc.owner_member_id,
        link_ids: named.map((n) => n.share_id),
      })
      .execute();
    // Then the row: everything that names it goes with it.
    const gone = await trx.deleteFrom('document').where('id', '=', doc.id).executeTakeFirst();
    if (Number(gone.numDeletedRows) !== 1) {
      throw new Error('a held document was not removed');
    }
    // A kind deleted while this still used it goes with its last document.
    if (doc.type_key) await dropDeletedType(trx, doc.type_key);
    // Last, as every writer takes the log: no title, and only whoever could
    // see it is shown it (its tombstone says who).
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'document.purged',
      objectType: 'document',
      objectId: doc.id,
      detail: { versions: versions.length },
      ip: meta.ip,
    });
  }
}

/**
 * Every object a document owns, by the place it is kept (5.24): each
 * version's file, its thumbnail and page previews, the pages any link to
 * view drew of it, and the file of an upload to it that never finished.
 * Its rows, held already. Also what taking back a document Accept all
 * Ready filed writes down to delete (I3, batches.ts).
 */
export async function ownedObjects(
  trx: Db,
  documentId: string,
  versions: ReadonlyArray<{
    id: string;
    storage_key: string;
    thumbnail_key: string | null;
    vault_id: string;
  }>,
): Promise<Map<string, Set<string>>> {
  const byVault = new Map<string, Set<string>>();
  const add = (vaultId: string | null, key: string | null) => {
    if (!vaultId || !key) return;
    const keys = byVault.get(vaultId) ?? new Set<string>();
    keys.add(key);
    byVault.set(vaultId, keys);
  };
  // The links that drew pages of it, or could have: its own and any
  // collection's whose snapshot names it, to view; and any a page names.
  const drawn = await trx
    .selectFrom('share_page')
    .select(['share_id', 'storage_key', 'version_id'])
    .where('document_id', '=', documentId)
    .execute();
  const viewLinks = await sql<{ id: string }>`
    select l.id from share_link l
     where l.permission = 'view'
       and (l.document_id = ${documentId}
            or exists (select 1 from share_link_item t
                        where t.share_id = l.id and t.document_id = ${documentId}))`.execute(trx);
  const linkIds = new Set([...viewLinks.rows.map((l) => l.id), ...drawn.map((d) => d.share_id)]);
  const vaultOf = new Map(versions.map((v) => [v.id, v.vault_id]));
  for (const v of versions) {
    add(v.vault_id, v.storage_key);
    add(v.vault_id, thumbnailKey(v.storage_key));
    add(v.vault_id, v.thumbnail_key);
    for (let n = 1; n <= PREVIEW_MAX_PAGES; n += 1) {
      add(v.vault_id, previewKey(v.storage_key, n));
      for (const share of linkIds) add(v.vault_id, sharePageKey(v.storage_key, share, n));
    }
  }
  for (const d of drawn) add(vaultOf.get(d.version_id) ?? null, d.storage_key);
  // An upload of a new version that never finished: its bytes, on their way.
  const unfinished = await trx
    .selectFrom('upload_idempotency')
    .select(['temp_key', 'temp_vault_id'])
    .where('document_id', '=', documentId)
    .where('temp_key', 'is not', null)
    .execute();
  for (const u of unfinished) add(u.temp_vault_id, u.temp_key);
  return byVault;
}

/**
 * The rows a removal of a document waits on, held before the document is,
 * in the order the writers of each hold them (see the top of this file):
 * its links' sessions, its links, the pages links drew of it. Taking back a
 * document Accept all Ready filed holds them so too (I3, batches.ts).
 */
export async function holdDocumentRows(trx: Db, id: string): Promise<void> {
  // The sessions of its own links: a request in one holds its session
  // first, then its link, then the log.
  await sql`select s.id from share_session s
             where s.share_id in (select l.id from share_link l where l.document_id = ${id})
             order by s.id for update of s`.execute(trx);
  // Its own links, which go with it.
  await sql`select l.id from share_link l where l.document_id = ${id}
             order by l.id for update`.execute(trx);
  // The pages links drew of it: the share-pages worker holds its link,
  // then these, and only then names the document.
  await sql`select p.share_id from share_page p where p.document_id = ${id}
             order by p.share_id, p.version_id, p.n for update`.execute(trx);
}
