import { createHash } from 'node:crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  COLLECTION_AUDIENCES,
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_ITEMS_PAGE,
  COLLECTION_ITEMS_PAGE_MAX,
  COLLECTION_NAME_MAX,
  collectionItemHint,
  inCollectionAudience,
  type CollectionAudience,
  type CollectionDetail,
  type CollectionInput,
  type CollectionItemView,
  type CollectionView,
  type DocumentView,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import { seenDocument, type DocumentService } from '../documents/service.js';

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
 *  - **Only its maker changes it** (A18): its name, words and audience,
 *    and what is in it, while they are in its audience. Anybody else in
 *    its audience who asks is refused; anybody outside it is told there is
 *    no such collection.
 *  - **Its maker keeps it** (the 5.14 review): made a teen or a viewer, a
 *    maker still sees the collection they made — the documents in it as they may
 *    see them now — and may delete it, but no longer change it. When
 *    nobody may change a collection any more (its maker is outside its audience,
 *    or has no sign-in here), an owner who can see it may delete it: never
 *    change it, and never be given more of it than they see anyway. The
 *    database holds both (0036).
 *  - **You add only what you can see**: a document the maker is not given
 *    is answered as one that does not exist.
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

/**
 * "This caller may see collection `l`", as SQL: `canSeeCollection` for every audience
 * there is, and not deleted. Its maker always may; Only me, its maker
 * alone. An audience it does not name is nobody's.
 */
export const seenCollection = (p: Principal) => {
  const maker = sql<boolean>`coalesce(l.owner_member_id = ${p.memberId}::uuid, false)`;
  return sql<boolean>`(l.deleted_at is null and case l.audience ${sql.join(
    COLLECTION_AUDIENCES.map((a) =>
      a === 'only_me'
        ? sql`when ${sql.lit(a)} then ${maker}`
        : sql`when ${sql.lit(a)} then ${sql.lit(inCollectionAudience(p.role, a))} or ${maker}`,
    ),
    sql` `,
  )} else false end)`;
};

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

/** Only its maker changes a collection (A18). */
const notYours = () =>
  new ApiError(403, 'forbidden', 'Only the person who made this collection can change it.');

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

export class CollectionService {
  constructor(
    private readonly db: Db,
    private readonly documents: DocumentService,
  ) {}

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
      return rows.map((r) => this.view(p, r as CollectionRow, r.item_count));
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
      return rows.map((r) => this.view(p, r as CollectionRow, r.item_count));
    });
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
   * Its name, words or audience, by its maker, made to the collection as they
   * saw it: a stale If-Match is `409 conflict`, with the collection as it now is.
   * A new name is `collection.renamed` in the log; words or audience,
   * `collection.updated`. Neither says what they now are.
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
      const current = await this.mine(trx, p, id);
      if (ifMatch && ifMatch !== collectionEtag(current)) return { id: current.id, stale: true };
      const name = input.name !== undefined ? nameOf(input.name) : current.name;
      const description =
        input.description !== undefined ? descriptionOf(input.description) : current.description;
      const audience =
        input.audience !== undefined ? audienceFor(p, input.audience) : current.audience;
      const renamed = name !== current.name;
      const changed = description !== current.description || audience !== current.audience;
      if (!renamed && !changed) return { id: current.id, stale: false };

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
   * Gone for everybody: by its maker, whatever their role now, or by an
   * owner when nobody may change it any more (`deletable`). The row is
   * kept, marked deleted: its lines in the log find their audience through
   * it. The documents in it are untouched.
   */
  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      const current = await this.deletable(trx, p, id);
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
    });
  }

  /**
   * Documents put in a collection by its maker, at the end, in the order given.
   * Each must be one they can see, out of the Trash: if any is not, none
   * is put in, and the answer is the one a document that does not exist
   * gets. One already in it stays where it is. Each document put in is a
   * line of its own in the log, about the document.
   */
  async addItems(
    p: Principal,
    id: string,
    documentIds: string[],
    meta: RequestMeta,
  ): Promise<CollectionDetail> {
    requireCapability(p, 'collection.manage');
    const collectionId = await withPrincipal(this.db, p, async (trx) => {
      const collection = await this.mine(trx, p, id);
      const asked = [...new Set(documentIds.map((d) => d.toLowerCase()))];
      if (asked.length === 0)
        throw invalid('Choose a document to put in the collection.', 'document_ids');
      // Held while they are checked, in one order: made somebody else's
      // Only me, or taken to the Trash, meanwhile, one is not added.
      const found = await trx
        .selectFrom('document as d')
        .select('d.id')
        .where('d.id', 'in', asked)
        .where('d.deleted_at', 'is', null)
        .where(seenDocument(p))
        .orderBy('d.id')
        .forUpdate()
        .execute();
      if (found.length !== asked.length) throw noDocument();
      // In the order asked, by the rows' own ids.
      const byId = new Map(found.map((d) => [d.id.toLowerCase(), d.id]));
      const ordered = asked.map((a) => byId.get(a) as string);

      const last = await trx
        .selectFrom('doc_collection_item')
        .select((eb) => eb.fn.max('position').as('position'))
        .where('collection_id', '=', collection.id)
        .executeTakeFirst();
      let position = Number(last?.position ?? 0);
      for (const documentId of ordered) {
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
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'collection.item_added',
          objectType: 'document',
          objectId: documentId,
          detail: { collection_id: collection.id },
          ip: meta.ip,
        });
      }
      return collection.id;
    });
    // Read afresh, the change made and let go.
    return this.get(p, collectionId);
  }

  /**
   * A document taken out of a collection by its maker: one they can see, in it, out
   * of the Trash — as the collection shows it. Anything else is not in it.
   */
  async removeItem(p: Principal, id: string, documentId: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'collection.manage');
    await withPrincipal(this.db, p, async (trx) => {
      const collection = await this.mine(trx, p, id);
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
   * A collection the caller may change — they made it, and are in its audience —
   * held until the transaction ends: every change is checked against it as
   * it is. Outside its audience it is 404; in it, but not its maker, 403;
   * its maker, outside it now, 403 too: theirs to see and delete, not to
   * change.
   *
   * Looked at, then held and looked at again: the database holds a collection
   * only for somebody who may change it, and anybody else in its audience
   * is told why not, rather than that it is not there.
   */
  private async mine(trx: Db, p: Principal, id: string): Promise<CollectionRow> {
    const refusal = (row: CollectionRow | null) => {
      if (!row) return notFound();
      if (!isMaker(p, row)) return notYours();
      if (!inCollectionAudience(p.role, row.audience)) return noLongerYours();
      return null;
    };
    const first = refusal(await this.seen(trx, p, id));
    if (first) throw first;
    const held = await this.seen(trx, p, id, true);
    const then = refusal(held);
    if (then) throw then;
    return held as CollectionRow;
  }

  /**
   * A collection the caller may delete, held: one they made, whatever their role
   * now — made a viewer, they may still take back what they named — or,
   * for an owner, one they can see that nobody may change any more
   * (`stranded`). Anybody else without `collection.manage` is told so, whether or
   * not there is a collection; outside its audience it is 404; in it, 403.
   */
  private async deletable(trx: Db, p: Principal, id: string): Promise<CollectionRow> {
    const first = await this.seen(trx, p, id);
    if (!first || !isMaker(p, first)) {
      requireCapability(p, 'collection.manage');
      if (!first) throw notFound();
      // The database asks the same of app_role() (0036).
      if (p.role !== 'owner') throw notYours();
    }
    const held = await this.seen(trx, p, id, true);
    if (held && isMaker(p, held)) return held;
    if (held && p.role === 'owner' && (await this.stranded(trx, p, held))) return held;
    // The database would not hold it for them: still there, it is not theirs.
    const there = held ?? (await this.seen(trx, p, id));
    throw there ? notYours() : notFound();
  }

  /**
   * Whether nobody may change a collection any more: its maker has no sign-in in
   * the household, or is no longer in its audience. Their membership is
   * held while it is looked at, so a role given back meanwhile waits.
   */
  private async stranded(trx: Db, p: Principal, collection: CollectionRow): Promise<boolean> {
    if (collection.owner_member_id === null) return true;
    const maker = await trx
      .selectFrom('account_household')
      .select('role')
      .where('household_id', '=', p.householdId)
      .where('member_id', '=', collection.owner_member_id)
      .forShare()
      .executeTakeFirst();
    return !maker || !inCollectionAudience(maker.role, collection.audience);
  }

  private view(p: Principal, row: CollectionRow, itemCount: number): CollectionView {
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
    };
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
    // Its maker is told who in its audience is not given each one; nobody
    // else is told anything a document they cannot see would leave behind.
    const maker = isMaker(p, collection);
    const items: CollectionItemView[] = shown.map((r, i) => ({
      document: documents[i] as DocumentView,
      added_at: r.on_collection_since.toISOString(),
      hint: maker ? collectionItemHint(collection.audience, r) : null,
    }));
    const last = shown[shown.length - 1];
    const more = rows.length > limit;
    return {
      ...this.view(p, collection, n),
      items,
      next_cursor: more && last ? encodeCursor(last.id) : null,
      has_more: more,
    };
  }
}
