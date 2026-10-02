import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  PREVIEW_MAX_PAGES,
  PURGE_NOTICE_HOURS,
  shareEndWords,
  type DocumentView,
} from '@fdv/shared';
import { StorageError } from '@fdv/storage';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { dropDeletedType, seenDocument, type DocRow, type DocumentService } from './service.js';

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
 *  2. Every object it owns deleted from storage: each version's file, its
 *     thumbnail, its page previews, the pages any link to view drew of it,
 *     and the file of an upload to it that never finished. A missing one is
 *     fine; one that cannot be reached undoes the whole removal, to be
 *     tried again.
 *  3. Its tombstone (0045) — who could see it — then the row, every
 *     foreign key to it cascading.
 *  4. The line in the activity log, with no title.
 *
 * A crash before the commit leaves the row, to be removed again; the files
 * it had are gone or go then. Never files that nothing names.
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

const storageUnreachable = (detail: string) =>
  new ApiError(
    503,
    'storage_unreachable',
    "We can't reach where your files are kept, so nothing was removed. Try again.",
    { detail, retriable: true, retryAfter: 30 },
  );

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
    const done = await withPrincipal(this.db, p, async (trx) => {
      await this.holdAround(trx, id);
      const doc = await this.find(trx, p, id, true);
      const decided = await this.decide(trx, p, doc);
      if (decided.kind === 'wait') throw await this.tooSoon(trx, decided.allowedFrom);
      if (decided.kind === 'ask') return this.ask(trx, p, doc, meta);
      await this.remove(trx, p, doc, meta);
      return null;
    });
    if (!done) return { removed: true };
    // Told once the request is kept, and never in a way that undoes it: the
    // Trash says so whether or not a message gets through.
    for (const message of done.tell) await this.alert(message).catch(() => undefined);
    return { removed: false, document: done.document };
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
   * Remove now, ask, or wait. One the caller filed, or that is theirs, is
   * removed at once. Anybody else's is asked about first, and removed once
   * `PURGE_NOTICE_HOURS` have passed since — counted by the database's clock.
   */
  private async decide(trx: Db, p: Principal, doc: Held): Promise<Decision> {
    const theirs =
      (doc.created_by !== null && doc.created_by === p.accountId) ||
      (doc.owner_member_id !== null && doc.owner_member_id === p.memberId);
    if (theirs) return { kind: 'remove' };
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
      tell.push({
        householdId: p.householdId,
        accountIds: [filer.account_id],
        subject: 'An owner asked to remove one of your documents for good',
        body:
          `${asker} asked to remove one of the documents you added for good on ` +
          `${shareEndWords(at, household.timezone, { weekday: false })}. Bring it back to keep it: ` +
          'it is in Settings → Trash. Otherwise it can be removed for good from ' +
          `${shareEndWords(from, household.timezone)}.`,
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
          `${asker} asked to remove a document in the Trash for good. Whoever added it has been ` +
          `told, and can bring it back from Settings → Trash within ${PURGE_NOTICE_HOURS} hours. ` +
          'The activity log says which.',
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
      .where('document_id', '=', doc.id)
      .execute();
    const viewLinks = await sql<{ id: string }>`
      select l.id from share_link l
       where l.permission = 'view'
         and (l.document_id = ${doc.id}
              or exists (select 1 from share_link_item t
                          where t.share_id = l.id and t.document_id = ${doc.id}))`.execute(trx);
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
      .where('document_id', '=', doc.id)
      .where('temp_key', 'is not', null)
      .execute();
    for (const u of unfinished) add(u.temp_vault_id, u.temp_key);

    // Objects first, a missing one being fine (a provider that answers a
    // delete of nothing with "not found" included). Anything else stops the
    // removal, row and all, to be tried again.
    for (const [vaultId, keys] of byVault) {
      const adapter = await this.vaults.adapterById(trx, vaultId);
      for (const key of keys) {
        try {
          await adapter.delete(key);
        } catch (err) {
          if (err instanceof StorageError && err.code === 'not_found') continue;
          throw storageUnreachable((err as Error).message);
        }
      }
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
