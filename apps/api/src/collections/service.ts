import { createHash } from 'node:crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  canSee,
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_ITEMS_PAGE,
  COLLECTION_ITEMS_PAGE_MAX,
  COLLECTION_NAME_MAX,
  collectionItemHint,
  inCollectionAudience,
  withinCollectionAudience,
  type CollectionAudience,
  type CollectionDetail,
  type CollectionInput,
  type CollectionItemView,
  type CollectionManager,
  type CollectionPowers,
  type CollectionSharedOutside,
  type CollectionView,
  type DocumentView,
  SENSITIVE_FOLLOW_CONFIRM,
  sensitiveNotFollowed,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import { seenDocument, type DocumentService } from '../documents/service.js';
import { madeWith } from '../documents/made-with.js';
import { sensitiveSql } from '../documents/filters.js';
import { sensitiveConfirm } from '../documents/sensitive-start.js';
import { endSessions } from '../documents/share-sessions.js';
import { proposalPool, type ChecklistReader } from '../documents/proposal-pool.js';
import { ChecklistService } from './checklist.js';
import { ManagerService, ofTheFamily } from './managers.js';
import { seenCollection } from './seen.js';

/**
 * Collections of documents (5.14).
 *
 * A collection is a name, a few words, who it is for, and the documents in it.
 * Four rules, each the privacy wall's:
 *
 *  - **Who it is for decides whether it exists** (A17, `canSeeCollection`): a
 *    collection outside the reader's audience is 404, exactly as one that never
 *    was — its name ("Divorce") is information. A viewer sees none. The
 *    database keeps Only me itself (0036), whatever is asked here.
 *  - **It never widens who sees a document.** Each reader is given the
 *    documents in it they could see anyway, by the one visibility rule
 *    (`seenDocument`), out of the Trash; `item_count` is how many that is.
 *    Nothing — a count, a hint, an ETag, an order — says how many are
 *    hidden. A document taken to the Trash, or made somebody else's Only
 *    me, drops out for them at once; brought back, it is there again.
 *  - **Its maker, or a manager with that power, changes it** (A18, and the
 *    owner's decision of 13 Nov 2026, 0095): its maker — while they are in
 *    its audience — may do everything; each manager they chose may put
 *    documents in and take them out, fill it from a checklist, change or
 *    clear the checklist, and rename it and change its words, and besides,
 *    only as its maker turned each on for them, change who it is for (never
 *    to Only me), delete it, or choose managers. A manager is somebody of
 *    the family with a sign-in in its audience now; made for fewer people,
 *    those outside it are managers no more (`update`). Anybody else in its
 *    audience who asks is refused; anybody outside it is told there is no
 *    such collection. `my_powers` says what each reader may do.
 *  - **Its maker keeps it** (the 5.14 review): made a teen or a viewer, a
 *    maker still sees the collection they made — the documents in it as they may
 *    see them now — and may delete it, but no longer change it. No manager
 *    makes it for people its maker is not one of. When its maker may no
 *    longer change it (outside its audience, or no sign-in here), an owner
 *    who can see it may take its managers away, and — unless a live manager
 *    may delete it — delete it: never change it, and never be given more of
 *    it than they see anyway. The database holds all of it (0036, 0095).
 *  - **You add only what you can see**: a document the maker, or a manager,
 *    is not given is answered as one that does not exist; one taken out is
 *    one they can see, and one they cannot is answered the same way —
 *    never how many there are.
 *  - **Shared outside, it says so** (5.19): each reader is told whether a
 *    link outside the family still works for it, with whom — only those who
 *    may share are told names — and whether it keeps up with the
 *    collection. Deleting a collection, or making it Only me, ends its
 *    links for good; a document put in one whose link keeps up with it, and
 *    that goes out, is a line of its own in the log.
 *
 * Every change is checked against the collection as it is, held (FOR UPDATE),
 * and the documents put in it are held while they are checked; everything
 * is written against the rows' own ids, never the address's. The answer is
 * read once the change is made and let go, so the household's activity log
 * and the rows are held for the write alone, not while a long collection renders.
 */

type CollectionRow = {
  id: string;
  name: string;
  description: string | null;
  audience: CollectionAudience;
  owner_member_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

/** A collection's columns, as a read selects them. */
const COLLECTION_COLUMNS = [
  'l.id',
  'l.name',
  'l.description',
  'l.audience',
  'l.owner_member_id',
  'l.created_at',
  'l.updated_at',
  'l.deleted_at',
] as const;

/** "This caller may see collection `l`", as SQL (seen.ts, on its own since R2). */
export { seenCollection };

/** The caller made this collection. */
const isMaker = (p: Principal, row: { owner_member_id: string | null }) =>
  row.owner_member_id !== null && row.owner_member_id === p.memberId;

/** Which page of a collection's documents: after the document a page ended with. */
export interface ItemsPage {
  limit?: number | undefined;
  cursor?: string | undefined;
}

/**
 * A page's cursor names the last document the reader was given, and
 * nothing else: not where it stands in the collection, which would count the
 * ones before it they were not given.
 */
const encodeCursor = (documentId: string) =>
  Buffer.from(JSON.stringify({ after: documentId })).toString('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badCursor = () => new ApiError(422, 'validation_failed', 'That page cursor is not valid.');
function cursorDocument(cursor: string): string {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { after?: unknown };
    if (typeof c.after === 'string' && UUID.test(c.after)) return c.after;
  } catch {
    // below
  }
  throw badCursor();
}

/** How many of collection `l`'s documents the caller may see, out of the Trash. */
const seenCount = (p: Principal) =>
  sql<number>`(select count(*)::int
                 from doc_collection_item i
                 join document d on d.id = i.document_id
                where i.collection_id = l.id and d.deleted_at is null and ${seenDocument(p)})`;

/**
 * A collection's ETag: its name, words and audience as they are now, never what
 * is in it — every reader is given the same one, and one that moved when a
 * document they cannot see went in would say that it had.
 */
function collectionEtag(row: { id: string; updated_at: Date }): string {
  const seed = `collection:${row.id}:${row.updated_at.toISOString()}`;
  return `"${createHash('sha256').update(seed).digest('hex').slice(0, 16)}"`;
}

const notFound = () => new ApiError(404, 'not_found', 'That collection does not exist.');
const noDocument = () => new ApiError(404, 'not_found', 'That document is not in the vault.');
const invalid = (message: string, detail: string) =>
  new ApiError(422, 'validation_failed', message, { detail });

/** Only its maker, or a manager they chose, changes a collection (A18, 0095). */
export const NOT_YOURS =
  'Only the person who made this collection, or someone they chose to manage it, can change it.';
const notYours = () => new ApiError(403, 'forbidden', NOT_YOURS);

/** What somebody may be asked to do with a collection: `CollectionPowers`, by the API's name. */
export type CollectionPower = 'edit' | 'audience' | 'delete' | 'managers' | 'unmanage';

/** A manager asking for what their maker did not let them do, in plain words. */
const NOT_LET: Record<Exclude<CollectionPower, 'edit'>, string> = {
  audience:
    'You manage this collection, but only the person who made it, or a manager they let, can change who it’s for.',
  delete:
    'You manage this collection, but only the person who made it, or a manager they let, can delete it.',
  managers:
    'Only the person who made this collection, or a manager they let, can choose who manages it.',
  unmanage:
    'Only the person who made this collection, or a manager they let, can choose who manages it.',
};

/** What an owner is told of a collection whose maker may no longer change it (0036, 0095). */
export interface Stranded {
  /** Its maker has no sign-in here, or is outside its audience. */
  maker: boolean;
  /** …and no live manager may delete it: an owner may. */
  nobodyDeletes: boolean;
}
const NOT_STRANDED: Stranded = { maker: false, nobodyDeletes: false };

/** Only me is its maker's alone: no manager makes it theirs. */
const onlyTheMakerOnlyMe = () =>
  new ApiError(403, 'forbidden', 'Only the person who made this collection can make it Only me.');

/** The caller's own row as one of a collection's managers, if they are one. */
type ManagerRow = {
  may_change_audience: boolean;
  may_delete: boolean;
  may_choose_managers: boolean;
};

/**
 * What the caller may do with a collection now (0.9.0): its maker, in its
 * audience, everything, and out of it, still delete it; a manager — named,
 * of the family, in its audience, never of an Only me one — edit, and the
 * three others as their row says; an owner, while its maker may no
 * longer change it, take its managers away, and delete it once nobody
 * else may (`Stranded`). The database asks the same (0095).
 */
export function powersFor(
  p: Principal,
  row: { owner_member_id: string | null; audience: CollectionAudience },
  managing: ManagerRow | undefined,
  stranded: Stranded,
): CollectionPowers {
  const maker = isMaker(p, row);
  const inIt = inCollectionAudience(p.role, row.audience);
  const makerNow = maker && inIt;
  const manager =
    !maker && managing !== undefined && ofTheFamily(p) && inIt && row.audience !== 'only_me';
  const owner = !maker && p.role === 'owner';
  const chooses = makerNow || (manager && managing.may_choose_managers);
  return {
    maker,
    manager,
    edit: makerNow || manager,
    change_audience: makerNow || (manager && managing.may_change_audience),
    delete: maker || (manager && managing.may_delete) || (owner && stranded.nobodyDeletes),
    choose_managers: chooses,
    remove_managers: chooses || (owner && stranded.maker),
  };
}

/** Whether the powers give what was asked. */
const holds = (powers: CollectionPowers, power: CollectionPower) =>
  power === 'edit'
    ? powers.edit
    : power === 'audience'
      ? powers.change_audience
      : power === 'delete'
        ? powers.delete
        : power === 'managers'
          ? powers.choose_managers
          : powers.remove_managers;

/** Its maker, no longer in its audience: they keep it to see and delete (the 5.14 review). */
const noLongerYours = () =>
  new ApiError(
    403,
    'forbidden',
    'This collection is for people you are no longer one of. You can still delete it, but not change it.',
  );

/** A name as the person typed it, spaces tidied; blank is none. */
function nameOf(v: string): string {
  const tidy = v.trim().replace(/\s+/g, ' ');
  if (!tidy) throw invalid('Give the collection a name.', 'name');
  if (tidy.length > COLLECTION_NAME_MAX) {
    throw invalid(
      `A collection’s name is too long: ${COLLECTION_NAME_MAX} characters at most.`,
      'name',
    );
  }
  return tidy;
}

/** Its few words, trimmed; blank is none. */
function descriptionOf(v: string | null): string | null {
  const trimmed = v?.trim() ?? '';
  if (trimmed.length > COLLECTION_DESCRIPTION_MAX) {
    throw invalid(
      `What a collection is for is too long: ${COLLECTION_DESCRIPTION_MAX} characters at most.`,
      'description',
    );
  }
  return trimmed || null;
}

/**
 * Who a collection may be for, from its maker: an audience they are in. A teen's
 * collection for the adults would be one they could not see as they made it.
 */
function audienceFor(p: Principal, audience: CollectionAudience): CollectionAudience {
  if (!inCollectionAudience(p.role, audience)) {
    throw new ApiError(403, 'forbidden', 'Only an adult can make a collection for the adults.');
  }
  return audience;
}

/** "Jane (viewer) will be able to see this" (5.33): of what was just put in a collection. */
export function viewerWillSee(
  name: string,
  sees: number,
  added: number,
  kind: 'family' | 'guest' = 'family',
): string {
  const what = added === 1 ? 'this' : sees === added ? 'these' : `${sees} of these`;
  // Somebody from outside the family is said to be one (the 5.34 review).
  return `${name} (${kind === 'guest' ? 'guest' : 'viewer'}) will be able to see ${what}.`;
}

export class CollectionService {
  /** A collection's checklist (0.9.0, C1): read on the proposal thread. */
  readonly checklists: ChecklistService;
  /** Who manages a collection besides its maker (0.9.0). */
  readonly managers: ManagerService;

  constructor(
    private readonly db: Db,
    private readonly documents: DocumentService,
    reader: ChecklistReader = proposalPool,
    alert: (a: AlertRequest) => Promise<unknown> = async () => undefined,
  ) {
    this.checklists = new ChecklistService(db, this, reader, documents);
    this.managers = new ManagerService(db, this, alert);
  }

  // ---------------------------------------------------------------- reading

  /** Every collection the caller may see, by name. A viewer is given none (A17). */
  async collections(p: Principal): Promise<CollectionView[]> {
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('doc_collection as l')
        .select(COLLECTION_COLUMNS)
        .select(seenCount(p).as('item_count'))
        .where(seenCollection(p))
        .orderBy(sql`lower(l.name)`)
        .orderBy('l.created_at')
        .orderBy('l.id')
        .execute();
      return this.views(trx, p, rows);
    });
  }

  /**
   * One collection, and a page of the documents in it the caller may see: 50
   * unless fewer or more are asked for, 200 at most, after the document
   * the last page ended with.
   */
  async get(p: Principal, id: string, page: ItemsPage = {}): Promise<CollectionDetail> {
    return withPrincipal(this.db, p, async (trx) =>
      this.detail(trx, p, await this.find(trx, p, id), page),
    );
  }

  /**
   * The collections a document is in, of those the caller may see. A document
   * they are not given is not there; one in the Trash is in no collection until
   * it is brought back.
   */
  async ofDocument(p: Principal, documentId: string): Promise<CollectionView[]> {
    return withPrincipal(this.db, p, async (trx) => {
      const doc = await trx
        .selectFrom('document as d')
        .select(['d.id', 'd.deleted_at'])
        .where('d.id', '=', documentId)
        .where(seenDocument(p))
        .executeTakeFirst();
      if (!doc) throw noDocument();
      if (doc.deleted_at) return [];
      const rows = await trx
        .selectFrom('doc_collection as l')
        .innerJoin('doc_collection_item as on_it', 'on_it.collection_id', 'l.id')
        .select(COLLECTION_COLUMNS)
        .select(seenCount(p).as('item_count'))
        .where('on_it.document_id', '=', doc.id)
        .where(seenCollection(p))
        .orderBy(sql`lower(l.name)`)
        .orderBy('l.created_at')
        .orderBy('l.id')
        .execute();
      return this.views(trx, p, rows);
    });
  }

  /** Rows as the caller is given them: whether each is shared outside, what they may do, who manages it. */
  private async views(
    trx: Db,
    p: Principal,
    rows: Array<CollectionRow & { item_count: number }>,
  ): Promise<CollectionView[]> {
    const ids = rows.map((r) => r.id);
    const shared = await this.sharedOutside(trx, p, ids);
    const { powers, managers } = await this.managing(trx, p, rows);
    return rows.map((r) =>
      this.view(
        p,
        r,
        r.item_count,
        shared.get(r.id) ?? null,
        powers.get(r.id) as CollectionPowers,
        managers.get(r.id) ?? null,
      ),
    );
  }

  /**
   * What the caller may do with each collection, and who manages each — for
   * the family who see them; a viewer or a guest is told nobody (null).
   * One query of each, whatever the number of collections.
   */
  private async managing(
    trx: Db,
    p: Principal,
    rows: CollectionRow[],
  ): Promise<{
    powers: Map<string, CollectionPowers>;
    managers: Map<string, CollectionManager[] | null>;
  }> {
    const powers = new Map<string, CollectionPowers>();
    const managers = new Map<string, CollectionManager[] | null>();
    if (rows.length === 0) return { powers, managers };
    const ids = rows.map((r) => r.id);
    const family = ofTheFamily(p);
    const all = family
      ? await trx
          .selectFrom('doc_collection_manager as m')
          .innerJoin('member as who', 'who.id', 'm.member_id')
          .select([
            'm.collection_id',
            'm.member_id',
            'who.display_name',
            'm.may_change_audience',
            'm.may_delete',
            'm.may_choose_managers',
            'm.added_at',
          ])
          .where('m.collection_id', 'in', ids)
          .orderBy(sql`lower(who.display_name)`)
          .orderBy('m.member_id')
          .execute()
      : [];
    // An owner, of one its maker may no longer change: the database's own answers.
    const stranded = new Map<string, Stranded>();
    if (p.role === 'owner') {
      const others = rows.filter((r) => !isMaker(p, r)).map((r) => r.id);
      if (others.length > 0) {
        const found = await trx
          .selectFrom('doc_collection as l')
          .select([
            'l.id',
            sql<boolean>`coalesce(doc_collection_stranded(l.owner_member_id, l.audience), false)`.as(
              'maker',
            ),
            sql<boolean>`coalesce(doc_collection_nobody_deletes(l.id, l.owner_member_id, l.audience), false)`.as(
              'nobody_deletes',
            ),
          ])
          .where('l.id', 'in', others)
          .execute();
        for (const f of found) {
          stranded.set(f.id, { maker: f.maker, nobodyDeletes: f.nobody_deletes });
        }
      }
    }
    for (const r of rows) {
      const theirs = all.filter((m) => m.collection_id === r.id);
      const own = theirs.find((m) => m.member_id === p.memberId);
      powers.set(r.id, powersFor(p, r, own, stranded.get(r.id) ?? NOT_STRANDED));
      managers.set(
        r.id,
        family
          ? theirs.map((m) => ({
              member_id: m.member_id,
              display_name: m.display_name,
              may_change_audience: m.may_change_audience,
              may_delete: m.may_delete,
              may_choose_managers: m.may_choose_managers,
              added_at: m.added_at.toISOString(),
            }))
          : null,
      );
    }
    return { powers, managers };
  }

  /**
   * What the caller may do with one collection now, read afresh: their own
   * row as a manager, and for an owner whether its maker may no longer
   * change it and whether nobody may delete it — the maker's membership held
   * while it is looked at, so a role given back meanwhile waits.
   */
  async powersOf(trx: Db, p: Principal, row: CollectionRow): Promise<CollectionPowers> {
    const own = await trx
      .selectFrom('doc_collection_manager')
      .select(['may_change_audience', 'may_delete', 'may_choose_managers'])
      .where('collection_id', '=', row.id)
      .where('member_id', '=', p.memberId)
      .executeTakeFirst();
    const stranded =
      p.role === 'owner' && !isMaker(p, row) ? await this.nobodyChanges(trx, p, row) : NOT_STRANDED;
    return powersFor(p, row, own, stranded);
  }

  // --------------------------------------------------------------- changing

  async create(p: Principal, input: CollectionInput, meta: RequestMeta): Promise<CollectionDetail> {
    requireCapability(p, 'collection.manage');
    if (input.name === undefined) throw invalid('Give the collection a name.', 'name');
    if (input.audience === undefined) {
      throw invalid('Say who the collection is for.', 'audience');
    }
    const name = nameOf(input.name);
    const description = descriptionOf(input.description ?? null);
    const audience = audienceFor(p, input.audience);
    const made = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .insertInto('doc_collection')
        .values({
          household_id: p.householdId,
          name,
          description,
          audience,
          owner_member_id: p.memberId,
          created_by: p.accountId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.created',
        objectType: 'collection',
        objectId: row.id,
        ip: meta.ip,
      });
      return row.id;
    });
    return this.get(p, made);
  }

  /**
   * Its name, words or audience, by its maker or a manager — who it is for
   * only by a manager its maker let, and never to Only me — made to the
   * collection as they saw it: a stale If-Match is `409 conflict`, with the
   * collection as it now is. A new name is `collection.renamed` in the log;
   * words or audience, `collection.updated`. Neither says what they now are.
   * Made for fewer people, its managers who could no longer see it are no
   * longer its managers (0095, in this transaction), each a line of its own.
   */
  async update(
    p: Principal,
    id: string,
    input: CollectionInput,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<CollectionDetail> {
    requireCapability(p, 'collection.manage');
    const outcome = await withPrincipal(this.db, p, async (trx) => {
      const { row: current, powers } = await this.managed(trx, p, id, 'edit');
      if (ifMatch && ifMatch !== collectionEtag(current)) return { id: current.id, stale: true };
      const name = input.name !== undefined ? nameOf(input.name) : current.name;
      const description =
        input.description !== undefined ? descriptionOf(input.description) : current.description;
      let audience = current.audience;
      if (input.audience !== undefined && input.audience !== current.audience) {
        if (!powers.change_audience) throw new ApiError(403, 'forbidden', NOT_LET.audience);
        if (input.audience === 'only_me' && !powers.maker) throw onlyTheMakerOnlyMe();
        audience = audienceFor(p, input.audience);
        // A manager never pushes its maker out of their own collection.
        if (!powers.maker) await this.keepsTheMaker(trx, p, current, audience);
      }
      const renamed = name !== current.name;
      const changed = description !== current.description || audience !== current.audience;
      if (!renamed && !changed) return { id: current.id, stale: false };
      // Made Only me, its links end: held before the log is (endLinks).
      const ending = audience === 'only_me' && current.audience !== 'only_me';
      if (ending) await this.holdLinks(trx, current.id);
      // Who manages it, before: made for fewer people, those who could no
      // longer see it go (doc_collection_drops_managers), and the log says so.
      const narrowing = audience !== current.audience;
      const before = narrowing ? await this.managerIds(trx, current.id) : [];

      await trx
        .updateTable('doc_collection')
        .set({ name, description, audience, updated_at: new Date() })
        .where('id', '=', current.id)
        .execute();
      for (const action of [renamed && 'collection.renamed', changed && 'collection.updated']) {
        if (!action) continue;
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action,
          objectType: 'collection',
          objectId: current.id,
          ip: meta.ip,
        });
      }
      if (narrowing) {
        const after = new Set(await this.managerIds(trx, current.id));
        for (const gone of before.filter((m) => !after.has(m))) {
          await appendAudit(trx, {
            householdId: p.householdId,
            actorAccountId: p.accountId,
            action: 'collection.manager_removed',
            objectType: 'collection',
            objectId: current.id,
            detail: { member_id: gone, why: 'audience' },
            ip: meta.ip,
          });
        }
      }
      // Made its maker's alone, it goes nowhere any more (5.19): its links
      // end for good, and do not come back should it be widened again.
      if (ending) await this.endLinks(trx, p, current.id, 'collection_only_me', meta);
      return { id: current.id, stale: false };
    });
    // Read afresh, the change made and let go.
    const now = await this.get(p, outcome.id);
    if (outcome.stale) {
      throw new ApiError(
        409,
        'conflict',
        'This collection was changed since you opened it. Reload and try again.',
        { detail: JSON.stringify(now) },
      );
    }
    return now;
  }

  /**
   * Gone for everybody: by its maker, whatever their role now, by a manager
   * its maker let delete it, or by an owner when nobody may change it any
   * more (`deletable`). The row is
   * kept, marked deleted: its lines in the log find their audience through
   * it. The documents in it are untouched.
   */
  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      const current = await this.deletable(trx, p, id);
      // Its links end with it: held before the log is (endLinks).
      await this.holdLinks(trx, current.id);
      const marked = await trx
        .updateTable('doc_collection')
        .set({ deleted_at: new Date() })
        .where('id', '=', current.id)
        .executeTakeFirst();
      // The database's rules decide as the row is written: a maker's
      // sign-in given back meanwhile means the collection is no longer an
      // owner's to clear. Nothing was deleted, so nothing is logged.
      if (marked.numUpdatedRows === 0n) throw notYours();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.deleted',
        objectType: 'collection',
        objectId: current.id,
        ip: meta.ip,
      });
      // And its links outside the family end with it (5.19).
      await this.endLinks(trx, p, current.id, 'collection_deleted', meta);
    });
  }

  /**
   * Documents put in a collection by its maker, at the end, in the order given.
   * Each must be one they can see, out of the Trash: if any is not, none
   * is put in, and the answer is the one a document that does not exist
   * gets. One already in it stays where it is. Each document put in is a
   * line of its own in the log, about the document.
   *
   * A sensitive document that a link keeping up with the collection would
   * send outside the family asks first (0.9.0, H1a): `409
   * sensitive_confirm`, and nothing is put in, unless `confirmSensitive`.
   */
  async addItems(
    p: Principal,
    id: string,
    documentIds: string[],
    meta: RequestMeta,
    confirmSensitive = false,
  ): Promise<CollectionDetail> {
    requireCapability(p, 'collection.manage');
    const { collectionId, warnings } = await withPrincipal(this.db, p, (trx) =>
      this.addIn(trx, p, id, documentIds, meta, { sensitive: confirmSensitive ? 'send' : 'ask' }),
    );
    // Read afresh, the change made and let go.
    const now = await this.get(p, collectionId);
    return warnings.length > 0 ? { ...now, warnings } : now;
  }

  /**
   * The same, inside a transaction of the caller's own (Phase 6, I1): a
   * batch's item accepted into the collection its card names, in the
   * transaction that files it — filed in it, or not filed at all. What it
   * answers is who else will now see it ("Jane (viewer) will be able to see
   * this"). Nobody was asked about a sensitive one (0.9.0, H1a): it is put
   * in, but a link keeping up with the collection does not send it, and
   * the answer says so.
   */
  async addWithin(
    trx: Db,
    p: Principal,
    id: string,
    documentIds: string[],
    meta: RequestMeta,
  ): Promise<string[]> {
    requireCapability(p, 'collection.manage');
    return (await this.addIn(trx, p, id, documentIds, meta)).warnings;
  }

  /**
   * A collection the caller may put documents in, held until the
   * transaction ends (I1: a batch's default, checked as it is chosen), or
   * refused as adding to it would be.
   */
  async mayAddTo(trx: Db, p: Principal, id: string): Promise<void> {
    requireCapability(p, 'collection.manage');
    await this.managed(trx, p, id, 'edit');
  }

  /**
   * A collection the caller may see, for its checklist (0.9.0, C1): its id,
   * audience and whether the caller may change it — its maker or a manager
   * — or 404 as one that never was. With `held`, one the caller may change,
   * held until the transaction ends, or refused as a change to it would be.
   */
  async checklistOf(
    trx: Db,
    p: Principal,
    id: string,
    held: boolean,
  ): Promise<{ id: string; audience: CollectionAudience; mine: boolean }> {
    if (held) {
      const { row } = await this.managed(trx, p, id, 'edit');
      return { id: row.id, audience: row.audience, mine: true };
    }
    const row = await this.find(trx, p, id);
    return { id: row.id, audience: row.audience, mine: (await this.powersOf(trx, p, row)).edit };
  }

  /**
   * A collection the caller may do `power` with, and what else they may,
   * held until the transaction ends (0.9.0). What anybody may do, the
   * routes for managers ask through this too.
   */
  async heldFor(
    trx: Db,
    p: Principal,
    id: string,
    power: CollectionPower,
  ): Promise<{ row: CollectionRow; powers: CollectionPowers }> {
    return this.managed(trx, p, id, power);
  }

  /** A collection as the caller may see it, and what they may do with it, not held. */
  async seenWith(
    trx: Db,
    p: Principal,
    id: string,
  ): Promise<{ row: CollectionRow; powers: CollectionPowers }> {
    const row = await this.find(trx, p, id);
    return { row, powers: await this.powersOf(trx, p, row) };
  }

  /** The members who manage a collection now, by id, as the caller is given them. */
  private async managerIds(trx: Db, collectionId: string): Promise<string[]> {
    return (
      await trx
        .selectFrom('doc_collection_manager')
        .select('member_id')
        .where('collection_id', '=', collectionId)
        .orderBy('member_id')
        .execute()
    ).map((m) => m.member_id);
  }

  private async addIn(
    trx: Db,
    p: Principal,
    id: string,
    documentIds: string[],
    meta: RequestMeta,
    /**
     * A sensitive document a link keeping up with the collection would
     * send (0.9.0, H1a): `ask` refuses `409 sensitive_confirm`; `send`, the
     * adder having been asked, sends it; `keep` puts it in without
     * sending it, and says so.
     */
    opts: { sensitive: 'ask' | 'send' | 'keep' } = { sensitive: 'keep' },
  ): Promise<{ collectionId: string; warnings: string[] }> {
    const { row: collection } = await this.managed(trx, p, id, 'edit');
    const asked = [...new Set(documentIds.map((d) => d.toLowerCase()))];
    if (asked.length === 0)
      throw invalid('Choose a document to put in the collection.', 'document_ids');
    // Its links that keep up with it (5.19): each decides once, here, as a
    // document goes in, whether it goes out too — and the log says so.
    // What is decided is written down, and a link gives nothing else
    // (the 5.19 review): nothing that changes later sends out anything
    // more. Only what an owner or an adult puts in follows; a teen's
    // stays in the family. Held (FOR KEY SHARE) before the documents
    // are, as what writes a link's pages holds the link before the
    // documents it names (the second review): in one order, never a
    // deadlock between the two.
    const following =
      p.role === 'owner' || p.role === 'adult'
        ? await this.linksOf(trx, collection.id, { following: true, hold: true })
        : [];
    // Held while they are checked, in one order: made somebody else's
    // Only me, or taken to the Trash, meanwhile, one is not added.
    const found = await trx
      .selectFrom('document as d')
      .select(['d.id', 'd.visibility', 'd.title'])
      .where('d.id', 'in', asked)
      .where('d.deleted_at', 'is', null)
      .where(seenDocument(p))
      .orderBy('d.id')
      .forUpdate()
      .execute();
    if (found.length !== asked.length) throw noDocument();
    // Which are sensitive, all said (H1a): asked only where a link may
    // take one, of the rows now held.
    const sensitive = new Set<string>();
    if (following.length > 0) {
      const marked = await sql<{ id: string }>`select d.id from document d
         where d.id = any(${found.map((d) => d.id)}::uuid[]) and ${sensitiveSql('d')}`.execute(trx);
      for (const r of marked.rows) sensitive.add(r.id);
    }
    const keptHome: string[] = [];
    // In the order asked, by the rows' own ids.
    const byId = new Map(found.map((d) => [d.id.toLowerCase(), d]));
    const ordered = asked.map((a) => byId.get(a) as (typeof found)[number]);

    const last = await trx
      .selectFrom('doc_collection_item')
      .select((eb) => eb.fn.max('position').as('position'))
      .where('collection_id', '=', collection.id)
      .executeTakeFirst();
    let position = Number(last?.position ?? 0);
    const addedIds: string[] = [];
    for (const { id: documentId, visibility } of ordered) {
      const added = await trx
        .insertInto('doc_collection_item')
        .values({
          collection_id: collection.id,
          document_id: documentId,
          household_id: p.householdId,
          added_by: p.accountId,
          position: position + 1,
        })
        .onConflict((oc) => oc.columns(['collection_id', 'document_id']).doNothing())
        .returning('document_id')
        .executeTakeFirst();
      if (!added) continue;
      position += 1;
      addedIds.push(documentId);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.item_added',
        objectType: 'document',
        objectId: documentId,
        detail: { collection_id: collection.id },
        ip: meta.ip,
      });
      // For the whole of the collection's audience now, and of the one
      // the link was made for — never private (neither gives it).
      if (!withinCollectionAudience(collection.audience, visibility)) continue;
      for (const link of following) {
        if (!link.follow_audience) continue;
        if (!withinCollectionAudience(link.follow_audience, visibility)) continue;
        // Sensitive (0.9.0, H1a): sent outside the family only once its
        // adder says so. One the link has decided already is left as it is.
        if (sensitive.has(documentId) && opts.sensitive !== 'send') {
          const decided = await trx
            .selectFrom('share_link_item')
            .select('document_id')
            .where('share_id', '=', link.id)
            .where('document_id', '=', documentId)
            .executeTakeFirst();
          if (decided) continue;
          if (opts.sensitive === 'ask') throw sensitiveConfirm(SENSITIVE_FOLLOW_CONFIRM);
          if (!keptHome.includes(documentId)) keptHome.push(documentId);
          continue;
        }
        // Once: a document the link was made with, or without (left out),
        // is not decided again; one that followed is decided again only
        // once it has been taken out (removeItem).
        const followed = await trx
          .insertInto('share_link_item')
          .values({
            share_id: link.id,
            household_id: p.householdId,
            collection_id: collection.id,
            document_id: documentId,
            position,
            kind: 'followed',
          })
          .onConflict((oc) => oc.columns(['share_id', 'document_id']).doNothing())
          .returning('document_id')
          .executeTakeFirst();
        if (!followed) continue;
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'share.followed',
          objectType: 'document',
          objectId: documentId,
          detail: { collection_id: collection.id, share_id: link.id },
          ip: meta.ip,
        });
      }
    }
    // Who else will now see them (5.33): a viewer the collection is given
    // to, by their grant as it now is (0055) — "Jane (viewer) will be able
    // to see this". Only for a collection for Everyone: no other is given.
    const viewers =
      addedIds.length > 0 && collection.audience === 'everyone'
        ? (
            await sql<{ display_name: string; documents: number; kind: 'family' | 'guest' }>`
                select g.display_name, g.documents, m.kind
                  from collection_viewers_given(${collection.id}::uuid, ${addedIds}::uuid[]) g
                  join member m on m.id = g.member_id
                 order by g.display_name, g.member_id`.execute(trx)
          ).rows
        : [];
    const titles = new Map(found.map((d) => [d.id, d.title]));
    return {
      collectionId: collection.id,
      warnings: [
        ...viewers.map((v) => viewerWillSee(v.display_name, v.documents, addedIds.length, v.kind)),
        // Put in, but kept in the family (H1a): nobody was asked.
        ...keptHome.map((d) => sensitiveNotFollowed(titles.get(d) ?? null)),
      ],
    };
  }

  /**
   * A document taken out of a collection by its maker: one they can see, in it, out
   * of the Trash — as the collection shows it. Anything else is not in it.
   */
  async removeItem(p: Principal, id: string, documentId: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'collection.manage');
    await withPrincipal(this.db, p, async (trx) => {
      const { row: collection } = await this.managed(trx, p, id, 'edit');
      const doc = await trx
        .selectFrom('document as d')
        .select('d.id')
        .where('d.id', '=', documentId)
        .where('d.deleted_at', 'is', null)
        .where(seenDocument(p))
        .executeTakeFirst();
      if (!doc) throw noDocument();
      const taken = await trx
        .deleteFrom('doc_collection_item')
        .where('collection_id', '=', collection.id)
        .where('document_id', '=', doc.id)
        .returning('document_id')
        .executeTakeFirst();
      if (!taken) throw new ApiError(404, 'not_found', 'That document is not in this collection.');
      // What followed its links goes with it (the 5.19 review's second
      // round): put back, it is decided again — by whoever puts it back,
      // for the audiences then — and the log says so again. What a link
      // was made with, ticked or left out, stays as it was made.
      await trx
        .deleteFrom('share_link_item')
        .where('collection_id', '=', collection.id)
        .where('document_id', '=', doc.id)
        .where('kind', '=', 'followed')
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.item_removed',
        objectType: 'document',
        objectId: doc.id,
        detail: { collection_id: collection.id },
        ip: meta.ip,
      });
    });
  }

  // -------------------------------------------------------------- internals

  /**
   * A collection the caller may see, or null. Held (FOR UPDATE), it is given only
   * to somebody the database lets change it (0036): its maker, or an owner
   * while nobody else may.
   */
  private async seen(
    trx: Db,
    p: Principal,
    id: string,
    hold = false,
  ): Promise<CollectionRow | null> {
    let q = trx
      .selectFrom('doc_collection as l')
      .select(COLLECTION_COLUMNS)
      .where('l.id', '=', id)
      .where(seenCollection(p));
    if (hold) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }

  /** A collection the caller may see, or 404 — exactly as one that never was. */
  private async find(trx: Db, p: Principal, id: string): Promise<CollectionRow> {
    const row = await this.seen(trx, p, id);
    if (!row) throw notFound();
    return row;
  }

  /**
   * A collection the caller may do `power` with — its maker, in its
   * audience; a manager its maker chose, with that power; for `delete`, its
   * maker whatever their role now, or an owner when nobody may change it —
   * held until the transaction ends: every change is checked against it as
   * it is. Outside its audience it is 404; in it, but neither its maker nor
   * a manager, 403; a manager without the power, 403 saying so; its maker,
   * outside it now, 403 too: theirs to see and delete, not to change.
   *
   * Looked at, then held and looked at again: the database holds a collection
   * only for somebody who may change it, and anybody else in its audience
   * is told why not, rather than that it is not there.
   */
  private async managed(
    trx: Db,
    p: Principal,
    id: string,
    power: CollectionPower,
  ): Promise<{ row: CollectionRow; powers: CollectionPowers }> {
    const check = async (row: CollectionRow) => {
      const powers = await this.powersOf(trx, p, row);
      if (holds(powers, power)) return { powers };
      if (powers.maker) return { refused: noLongerYours() };
      if (power !== 'edit' && (powers.manager || power === 'managers' || power === 'unmanage')) {
        return { refused: new ApiError(403, 'forbidden', NOT_LET[power]) };
      }
      return { refused: notYours() };
    };
    const first = await this.seen(trx, p, id);
    if (!first) throw notFound();
    const looked = await check(first);
    if (looked.refused) throw looked.refused;
    const held = await this.seen(trx, p, id, true);
    if (!held) {
      // The database would not hold it for them: still there, it is not theirs.
      throw (await this.seen(trx, p, id)) ? notYours() : notFound();
    }
    const then = await check(held);
    if (then.refused) throw then.refused;
    return { row: held, powers: then.powers };
  }

  /**
   * A collection the caller may delete, held: one they made, whatever their role
   * now — made a viewer, they may still take back what they named — one a
   * manager its maker let delete it, or, for an owner, one they can see that
   * nobody may change any more (`nobodyChanges`). Anybody else without
   * `collection.manage` is told so, whether or not there is a collection;
   * outside its audience it is 404; in it, 403.
   */
  private async deletable(trx: Db, p: Principal, id: string): Promise<CollectionRow> {
    const first = await this.seen(trx, p, id);
    if (!first || !isMaker(p, first)) requireCapability(p, 'collection.manage');
    return (await this.managed(trx, p, id, 'delete')).row;
  }

  /**
   * Whether a collection's maker may no longer change it — no sign-in in the
   * household, or no longer in its audience — and whether, besides, no live
   * manager may delete it (the database's own answers, doc_collection_stranded
   * and doc_collection_nobody_deletes). The maker's membership is held while
   * it is looked at, so a role given back meanwhile waits.
   */
  private async nobodyChanges(trx: Db, p: Principal, collection: CollectionRow): Promise<Stranded> {
    if (collection.owner_member_id !== null) {
      await trx
        .selectFrom('account_household')
        .select('role')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', collection.owner_member_id)
        .forShare()
        .execute();
    }
    const { rows } = await sql<{ maker: boolean; nobody: boolean }>`
      select coalesce(doc_collection_stranded(${collection.owner_member_id}::uuid,
                                              ${collection.audience}), false) as maker,
             coalesce(doc_collection_nobody_deletes(${collection.id}::uuid,
                                                    ${collection.owner_member_id}::uuid,
                                                    ${collection.audience}), false) as nobody`.execute(
      trx,
    );
    return { maker: rows[0]?.maker === true, nobodyDeletes: rows[0]?.nobody === true };
  }

  /**
   * B1 of the managers review: somebody other than its maker changing who a
   * collection is for never leaves its maker outside it — their role now,
   * held, must be in the new audience. Refused in words.
   */
  private async keepsTheMaker(
    trx: Db,
    p: Principal,
    collection: CollectionRow,
    audience: CollectionAudience,
  ): Promise<void> {
    if (collection.owner_member_id === null) {
      throw invalid(
        'That would leave the person who made it unable to see their own collection.',
        'audience',
      );
    }
    const signIn = await trx
      .selectFrom('account_household')
      .select('role')
      .where('household_id', '=', p.householdId)
      .where('member_id', '=', collection.owner_member_id)
      .forShare()
      .executeTakeFirst();
    if (signIn && audience !== 'only_me' && inCollectionAudience(signIn.role, audience)) return;
    const maker = await trx
      .selectFrom('member')
      .select('display_name')
      .where('id', '=', collection.owner_member_id)
      .executeTakeFirst();
    throw invalid(
      `That would leave ${maker?.display_name ?? 'the person who made it'} unable to see their own collection.`,
      'audience',
    );
  }

  private view(
    p: Principal,
    row: CollectionRow,
    itemCount: number,
    shared: CollectionSharedOutside | null,
    powers: CollectionPowers,
    managers: CollectionManager[] | null,
  ): CollectionView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      audience: row.audience,
      owner_member_id: row.owner_member_id,
      mine: row.owner_member_id !== null && row.owner_member_id === p.memberId,
      item_count: itemCount,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      etag: collectionEtag(row),
      shared_outside: shared,
      my_powers: powers,
      managers,
    };
  }

  // ------------------------------------------------ shared outside (5.19)

  /**
   * A collection's links outside the family that still work: not taken
   * back, paused, run out or locked, made by somebody who may still share
   * (an owner or an adult, still in the household). What ShareService.live()
   * asks of each; `following`, only those that keep up with it; `hold`,
   * each held FOR KEY SHARE — against nothing but its going, which a link
   * never does, and so waiting on nothing that writes to it.
   */
  private linksOf(
    trx: Db,
    collectionIds: string | string[],
    opts: { following?: boolean; hold?: boolean } = {},
  ) {
    const ids = Array.isArray(collectionIds) ? collectionIds : [collectionIds];
    let q = trx
      .selectFrom('share_link as s')
      .innerJoin('account_household as ah', (j) =>
        j
          .onRef('ah.account_id', '=', 's.created_by')
          .onRef('ah.household_id', '=', 's.household_id'),
      )
      .select([
        's.id',
        's.collection_id',
        's.recipient_label',
        's.follow_collection',
        's.follow_audience',
        's.created_by',
      ])
      .where('s.collection_id', 'in', ids)
      .where('s.revoked_at', 'is', null)
      .where('s.paused_at', 'is', null)
      .where('s.expires_at', '>', new Date())
      .where('s.attempts', '<', 10)
      .where('ah.role', 'in', ['owner', 'adult']);
    if (opts.following) q = q.where('s.follow_collection', '=', true);
    if (opts.hold) q = q.forKeyShare('s');
    return q.orderBy('s.created_at').execute();
  }

  /**
   * Whether each collection is shared outside, and with whom. A link's name
   * only to a reader GET /shares would give the link: one who may share,
   * and made it or can see every document it was made with. To anybody
   * else, only that the collection is shared.
   */
  private async sharedOutside(
    trx: Db,
    p: Principal,
    collectionIds: string[],
  ): Promise<Map<string, CollectionSharedOutside>> {
    const found = new Map<string, CollectionSharedOutside>();
    if (collectionIds.length === 0) return found;
    const links = await this.linksOf(trx, collectionIds);
    const named = can(p.role, 'document.share');
    const unseen = new Set<string>();
    if (named && links.length) {
      const reader = p;
      // Removed for good since, as its tombstone says, too (5.24).
      const items = await madeWith(
        trx,
        links.map((l) => l.id),
      );
      for (const i of items) if (!canSee(reader, i)) unseen.add(i.share_id);
    }
    for (const link of links) {
      const id = link.collection_id as string;
      const now = found.get(id) ?? { with: [], following: false };
      const label = link.recipient_label?.trim();
      const told = named && (link.created_by === p.accountId || !unseen.has(link.id));
      if (told && label && !now.with.includes(label)) now.with.push(label);
      now.following ||= link.follow_collection;
      found.set(id, now);
    }
    return found;
  }

  /**
   * The collection's links that may still be ended, held (FOR NO KEY
   * UPDATE, in id order) before the household's log is — the order every
   * other writer of a link takes the two in: taking one back, an Open, a
   * wrong PIN, a download (the 5.19 review's third round). Deleting a
   * collection, or making it Only me, took the log first and then waited on
   * a link an Open held, which waited on the log: one of them was ended as a
   * deadlock. The collection itself is already held (deletable, mine), so a
   * link being made meanwhile either is here, or waits and then finds the
   * collection gone or Only me (C519-07).
   */
  private async holdLinks(trx: Db, collectionId: string): Promise<void> {
    await trx
      .selectFrom('share_link')
      .select('id')
      .where('collection_id', '=', collectionId)
      .where('revoked_at', 'is', null)
      .orderBy('id')
      .forNoKeyUpdate()
      .execute();
  }

  /**
   * Ends a collection's links outside the family for good (5.19): deleted,
   * or made Only me. Each is taken back — its sessions ended — and the log
   * says so, and why. A link that has already run out is left as it is.
   * Its links are held first (holdLinks).
   */
  private async endLinks(
    trx: Db,
    p: Principal,
    collectionId: string,
    why: 'collection_deleted' | 'collection_only_me',
    meta: RequestMeta,
  ): Promise<void> {
    // Called after the change is in the log, its links held since before:
    // appendAudit has taken the household's log lock, which a link being
    // made takes too before it looks at the collection again (C519-07).
    // Made first, it is here to be ended; made after, it finds the
    // collection Only me, or deleted.
    // With the address a code went to (5.20): an ended link keeps nobody's.
    const ended = await trx
      .updateTable('share_link')
      .set({
        revoked_at: new Date(),
        revoked_by: p.accountId,
        revoked_why: why,
        code_email: null,
      })
      .where('collection_id', '=', collectionId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returning('id')
      .execute();
    if (ended.length === 0) return;
    // Their open pages end too — but one in use this moment, whose request
    // holds it and may be waiting on the log held here: not waited on
    // (endSessions, the fourth review); that request removes it itself as
    // it finds the link gone, and one left behind is refused at its next.
    await endSessions(
      trx,
      ended.map((e) => e.id),
    );
    for (const link of ended) {
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'share.revoked',
        objectType: 'collection',
        objectId: collectionId,
        detail: { share_id: link.id, why },
        ip: meta.ip,
      });
    }
  }

  /**
   * A collection with a page of the documents in it the caller may see, in the
   * order they were put there, and how many of them there are in all.
   */
  private async detail(
    trx: Db,
    p: Principal,
    collection: CollectionRow,
    page: ItemsPage = {},
  ): Promise<CollectionDetail> {
    const limit = Math.min(
      Math.max(page.limit ?? COLLECTION_ITEMS_PAGE, 1),
      COLLECTION_ITEMS_PAGE_MAX,
    );
    // The documents in it the caller may see, out of the Trash: those they
    // are given, and all they are counted.
    const given = () =>
      trx
        .selectFrom('doc_collection_item as i')
        .innerJoin('document as d', 'd.id', 'i.document_id')
        .where('i.collection_id', '=', collection.id)
        .where('d.deleted_at', 'is', null)
        .where(seenDocument(p));
    let q = given().selectAll('d').select('i.added_at as on_collection_since');
    if (page.cursor) {
      // After the one the last page ended with, found as the caller sees
      // the collection: one they are not given is a cursor that is not valid,
      // exactly as one that names nothing.
      const after = await given()
        .select(['i.position', 'i.document_id'])
        .where('i.document_id', '=', cursorDocument(page.cursor))
        .executeTakeFirst();
      if (!after) throw badCursor();
      q = q.where(
        sql<boolean>`(i.position, i.document_id) > (${after.position}, ${after.document_id}::uuid)`,
      );
    }
    const rows = await q
      .orderBy('i.position')
      .orderBy('i.document_id')
      .limit(limit + 1)
      .execute();
    const shown = rows.slice(0, limit);
    const { n } = await given()
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow();
    const documents: DocumentView[] = await this.documents.listed(trx, p, shown);
    const shared = await this.sharedOutside(trx, p, [collection.id]);
    const { powers, managers } = await this.managing(trx, p, [collection]);
    const mine = powers.get(collection.id) as CollectionPowers;
    // Its maker, and its managers, are told who in its audience is not
    // given each one they see; nobody is told anything a document they
    // cannot see would leave behind.
    const told = mine.maker || mine.manager;
    const items: CollectionItemView[] = shown.map((r, i) => ({
      document: documents[i] as DocumentView,
      added_at: r.on_collection_since.toISOString(),
      hint: told ? collectionItemHint(collection.audience, r) : null,
    }));
    const last = shown[shown.length - 1];
    const more = rows.length > limit;
    return {
      ...this.view(
        p,
        collection,
        n,
        shared.get(collection.id) ?? null,
        mine,
        managers.get(collection.id) ?? null,
      ),
      items,
      next_cursor: more && last ? encodeCursor(last.id) : null,
      has_more: more,
    };
  }
}
