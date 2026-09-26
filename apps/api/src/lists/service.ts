import { createHash } from 'node:crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  inListAudience,
  LIST_AUDIENCES,
  LIST_DESCRIPTION_MAX,
  LIST_ITEMS_PAGE,
  LIST_ITEMS_PAGE_MAX,
  LIST_NAME_MAX,
  listItemHint,
  type DocumentView,
  type ListAudience,
  type ListDetail,
  type ListInput,
  type ListItemView,
  type ListView,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import { seenDocument, type DocumentService } from '../documents/service.js';

/**
 * Lists of documents (5.14).
 *
 * A list is a name, a few words, who it is for, and the documents on it.
 * Four rules, each the privacy wall's:
 *
 *  - **Who it is for decides whether it exists** (A17, `canSeeList`): a
 *    list outside the reader's audience is 404, exactly as one that never
 *    was — its name ("Divorce") is information. A viewer sees none. The
 *    database keeps Only me itself (0036), whatever is asked here.
 *  - **It never widens who sees a document.** Each reader is given the
 *    documents on it they could see anyway, by the one visibility rule
 *    (`seenDocument`), out of the Trash; `item_count` is how many that is.
 *    Nothing — a count, a hint, an ETag, an order — says how many are
 *    hidden. A document taken to the Trash, or made somebody else's Only
 *    me, drops out for them at once; brought back, it is there again.
 *  - **Only its maker changes it** (A18): its name, words and audience,
 *    and what is on it, while they are in its audience. Anybody else in
 *    its audience who asks is refused; anybody outside it is told there is
 *    no such list.
 *  - **Its maker keeps it** (the 5.14 review): made a teen or a viewer, a
 *    maker still sees the list they made — the documents on it as they may
 *    see them now — and may delete it, but no longer change it. When
 *    nobody may change a list any more (its maker is outside its audience,
 *    or has no sign-in here), an owner who can see it may delete it: never
 *    change it, and never be given more of it than they see anyway. The
 *    database holds both (0036).
 *  - **You add only what you can see**: a document the maker is not given
 *    is answered as one that does not exist.
 *
 * Every change is checked against the list as it is, held (FOR UPDATE),
 * and the documents put on it are held while they are checked; everything
 * is written against the rows' own ids, never the address's. The answer is
 * read once the change is made and let go, so the household's activity log
 * and the rows are held for the write alone, not while a long list renders.
 */

type ListRow = {
  id: string;
  name: string;
  description: string | null;
  audience: ListAudience;
  owner_member_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

/** A list's columns, as a read selects them. */
const LIST_COLUMNS = [
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
 * "This caller may see list `l`", as SQL: `canSeeList` for every audience
 * there is, and not deleted. Its maker always may; Only me, its maker
 * alone. An audience it does not name is nobody's.
 */
export const seenList = (p: Principal) => {
  const maker = sql<boolean>`coalesce(l.owner_member_id = ${p.memberId}::uuid, false)`;
  return sql<boolean>`(l.deleted_at is null and case l.audience ${sql.join(
    LIST_AUDIENCES.map((a) =>
      a === 'only_me'
        ? sql`when ${sql.lit(a)} then ${maker}`
        : sql`when ${sql.lit(a)} then ${sql.lit(inListAudience(p.role, a))} or ${maker}`,
    ),
    sql` `,
  )} else false end)`;
};

/** The caller made this list. */
const isMaker = (p: Principal, row: { owner_member_id: string | null }) =>
  row.owner_member_id !== null && row.owner_member_id === p.memberId;

/** Which page of a list's documents: after the document a page ended with. */
export interface ItemsPage {
  limit?: number | undefined;
  cursor?: string | undefined;
}

/**
 * A page's cursor names the last document the reader was given, and
 * nothing else: not where it stands on the list, which would count the
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

/** How many of list `l`'s documents the caller may see, out of the Trash. */
const seenCount = (p: Principal) =>
  sql<number>`(select count(*)::int
                 from doc_list_item i
                 join document d on d.id = i.document_id
                where i.list_id = l.id and d.deleted_at is null and ${seenDocument(p)})`;

/**
 * A list's ETag: its name, words and audience as they are now, never what
 * is on it — every reader is given the same one, and one that moved when a
 * document they cannot see went on would say that it had.
 */
function listEtag(row: { id: string; updated_at: Date }): string {
  const seed = `list:${row.id}:${row.updated_at.toISOString()}`;
  return `"${createHash('sha256').update(seed).digest('hex').slice(0, 16)}"`;
}

const notFound = () => new ApiError(404, 'not_found', 'That list does not exist.');
const noDocument = () => new ApiError(404, 'not_found', 'That document is not in the vault.');
const invalid = (message: string, detail: string) =>
  new ApiError(422, 'validation_failed', message, { detail });

/** Only its maker changes a list (A18). */
const notYours = () =>
  new ApiError(403, 'forbidden', 'Only the person who made this list can change it.');

/** Its maker, no longer in its audience: they keep it to see and delete (the 5.14 review). */
const noLongerYours = () =>
  new ApiError(
    403,
    'forbidden',
    'This list is for people you are no longer one of. You can still delete it, but not change it.',
  );

/** A name as the person typed it, spaces tidied; blank is none. */
function nameOf(v: string): string {
  const tidy = v.trim().replace(/\s+/g, ' ');
  if (!tidy) throw invalid('Give the list a name.', 'name');
  if (tidy.length > LIST_NAME_MAX) {
    throw invalid(`A list’s name is too long: ${LIST_NAME_MAX} characters at most.`, 'name');
  }
  return tidy;
}

/** Its few words, trimmed; blank is none. */
function descriptionOf(v: string | null): string | null {
  const trimmed = v?.trim() ?? '';
  if (trimmed.length > LIST_DESCRIPTION_MAX) {
    throw invalid(
      `What a list is for is too long: ${LIST_DESCRIPTION_MAX} characters at most.`,
      'description',
    );
  }
  return trimmed || null;
}

/**
 * Who a list may be for, from its maker: an audience they are in. A teen's
 * list for the adults would be one they could not see as they made it.
 */
function audienceFor(p: Principal, audience: ListAudience): ListAudience {
  if (!inListAudience(p.role, audience)) {
    throw new ApiError(403, 'forbidden', 'Only an adult can make a list for the adults.');
  }
  return audience;
}

export class ListService {
  constructor(
    private readonly db: Db,
    private readonly documents: DocumentService,
  ) {}

  // ---------------------------------------------------------------- reading

  /** Every list the caller may see, by name. A viewer is given none (A17). */
  async lists(p: Principal): Promise<ListView[]> {
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('doc_list as l')
        .select(LIST_COLUMNS)
        .select(seenCount(p).as('item_count'))
        .where(seenList(p))
        .orderBy(sql`lower(l.name)`)
        .orderBy('l.created_at')
        .orderBy('l.id')
        .execute();
      return rows.map((r) => this.view(p, r as ListRow, r.item_count));
    });
  }

  /**
   * One list, and a page of the documents on it the caller may see: 50
   * unless fewer or more are asked for, 200 at most, after the document
   * the last page ended with.
   */
  async get(p: Principal, id: string, page: ItemsPage = {}): Promise<ListDetail> {
    return withPrincipal(this.db, p, async (trx) =>
      this.detail(trx, p, await this.find(trx, p, id), page),
    );
  }

  /**
   * The lists a document is on, of those the caller may see. A document
   * they are not given is not there; one in the Trash is on no list until
   * it is brought back.
   */
  async ofDocument(p: Principal, documentId: string): Promise<ListView[]> {
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
        .selectFrom('doc_list as l')
        .innerJoin('doc_list_item as on_it', 'on_it.list_id', 'l.id')
        .select(LIST_COLUMNS)
        .select(seenCount(p).as('item_count'))
        .where('on_it.document_id', '=', doc.id)
        .where(seenList(p))
        .orderBy(sql`lower(l.name)`)
        .orderBy('l.created_at')
        .orderBy('l.id')
        .execute();
      return rows.map((r) => this.view(p, r as ListRow, r.item_count));
    });
  }

  // --------------------------------------------------------------- changing

  async create(p: Principal, input: ListInput, meta: RequestMeta): Promise<ListDetail> {
    requireCapability(p, 'list.manage');
    if (input.name === undefined) throw invalid('Give the list a name.', 'name');
    if (input.audience === undefined) {
      throw invalid('Say who the list is for.', 'audience');
    }
    const name = nameOf(input.name);
    const description = descriptionOf(input.description ?? null);
    const audience = audienceFor(p, input.audience);
    const made = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .insertInto('doc_list')
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
        action: 'list.created',
        objectType: 'list',
        objectId: row.id,
        ip: meta.ip,
      });
      return row.id;
    });
    return this.get(p, made);
  }

  /**
   * Its name, words or audience, by its maker, made to the list as they
   * saw it: a stale If-Match is `409 conflict`, with the list as it now is.
   * A new name is `list.renamed` in the log; words or audience,
   * `list.updated`. Neither says what they now are.
   */
  async update(
    p: Principal,
    id: string,
    input: ListInput,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<ListDetail> {
    requireCapability(p, 'list.manage');
    const outcome = await withPrincipal(this.db, p, async (trx) => {
      const current = await this.mine(trx, p, id);
      if (ifMatch && ifMatch !== listEtag(current)) return { id: current.id, stale: true };
      const name = input.name !== undefined ? nameOf(input.name) : current.name;
      const description =
        input.description !== undefined ? descriptionOf(input.description) : current.description;
      const audience =
        input.audience !== undefined ? audienceFor(p, input.audience) : current.audience;
      const renamed = name !== current.name;
      const changed = description !== current.description || audience !== current.audience;
      if (!renamed && !changed) return { id: current.id, stale: false };

      await trx
        .updateTable('doc_list')
        .set({ name, description, audience, updated_at: new Date() })
        .where('id', '=', current.id)
        .execute();
      for (const action of [renamed && 'list.renamed', changed && 'list.updated']) {
        if (!action) continue;
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action,
          objectType: 'list',
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
        'This list was changed since you opened it. Reload and try again.',
        { detail: JSON.stringify(now) },
      );
    }
    return now;
  }

  /**
   * Gone for everybody: by its maker, whatever their role now, or by an
   * owner when nobody may change it any more (`deletable`). The row is
   * kept, marked deleted: its lines in the log find their audience through
   * it. The documents on it are untouched.
   */
  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      const current = await this.deletable(trx, p, id);
      await trx
        .updateTable('doc_list')
        .set({ deleted_at: new Date() })
        .where('id', '=', current.id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'list.deleted',
        objectType: 'list',
        objectId: current.id,
        ip: meta.ip,
      });
    });
  }

  /**
   * Documents put on a list by its maker, at the end, in the order given.
   * Each must be one they can see, out of the Trash: if any is not, none
   * is put on, and the answer is the one a document that does not exist
   * gets. One already on it stays where it is. Each document put on is a
   * line of its own in the log, about the document.
   */
  async addItems(
    p: Principal,
    id: string,
    documentIds: string[],
    meta: RequestMeta,
  ): Promise<ListDetail> {
    requireCapability(p, 'list.manage');
    const listId = await withPrincipal(this.db, p, async (trx) => {
      const list = await this.mine(trx, p, id);
      const asked = [...new Set(documentIds.map((d) => d.toLowerCase()))];
      if (asked.length === 0)
        throw invalid('Choose a document to put on the list.', 'document_ids');
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
        .selectFrom('doc_list_item')
        .select((eb) => eb.fn.max('position').as('position'))
        .where('list_id', '=', list.id)
        .executeTakeFirst();
      let position = Number(last?.position ?? 0);
      for (const documentId of ordered) {
        const added = await trx
          .insertInto('doc_list_item')
          .values({
            list_id: list.id,
            document_id: documentId,
            household_id: p.householdId,
            added_by: p.accountId,
            position: position + 1,
          })
          .onConflict((oc) => oc.columns(['list_id', 'document_id']).doNothing())
          .returning('document_id')
          .executeTakeFirst();
        if (!added) continue;
        position += 1;
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'list.item_added',
          objectType: 'document',
          objectId: documentId,
          detail: { list_id: list.id },
          ip: meta.ip,
        });
      }
      return list.id;
    });
    // Read afresh, the change made and let go.
    return this.get(p, listId);
  }

  /**
   * A document taken off a list by its maker: one they can see, on it, out
   * of the Trash — as the list shows it. Anything else is not on it.
   */
  async removeItem(p: Principal, id: string, documentId: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'list.manage');
    await withPrincipal(this.db, p, async (trx) => {
      const list = await this.mine(trx, p, id);
      const doc = await trx
        .selectFrom('document as d')
        .select('d.id')
        .where('d.id', '=', documentId)
        .where('d.deleted_at', 'is', null)
        .where(seenDocument(p))
        .executeTakeFirst();
      if (!doc) throw noDocument();
      const taken = await trx
        .deleteFrom('doc_list_item')
        .where('list_id', '=', list.id)
        .where('document_id', '=', doc.id)
        .returning('document_id')
        .executeTakeFirst();
      if (!taken) throw new ApiError(404, 'not_found', 'That document is not on this list.');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'list.item_removed',
        objectType: 'document',
        objectId: doc.id,
        detail: { list_id: list.id },
        ip: meta.ip,
      });
    });
  }

  // -------------------------------------------------------------- internals

  /**
   * A list the caller may see, or null. Held (FOR UPDATE), it is given only
   * to somebody the database lets change it (0036): its maker, or an owner
   * while nobody else may.
   */
  private async seen(trx: Db, p: Principal, id: string, hold = false): Promise<ListRow | null> {
    let q = trx
      .selectFrom('doc_list as l')
      .select(LIST_COLUMNS)
      .where('l.id', '=', id)
      .where(seenList(p));
    if (hold) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }

  /** A list the caller may see, or 404 — exactly as one that never was. */
  private async find(trx: Db, p: Principal, id: string): Promise<ListRow> {
    const row = await this.seen(trx, p, id);
    if (!row) throw notFound();
    return row;
  }

  /**
   * A list the caller may change — they made it, and are in its audience —
   * held until the transaction ends: every change is checked against it as
   * it is. Outside its audience it is 404; in it, but not its maker, 403;
   * its maker, outside it now, 403 too: theirs to see and delete, not to
   * change.
   *
   * Looked at, then held and looked at again: the database holds a list
   * only for somebody who may change it, and anybody else in its audience
   * is told why not, rather than that it is not there.
   */
  private async mine(trx: Db, p: Principal, id: string): Promise<ListRow> {
    const refusal = (row: ListRow | null) => {
      if (!row) return notFound();
      if (!isMaker(p, row)) return notYours();
      if (!inListAudience(p.role, row.audience)) return noLongerYours();
      return null;
    };
    const first = refusal(await this.seen(trx, p, id));
    if (first) throw first;
    const held = await this.seen(trx, p, id, true);
    const then = refusal(held);
    if (then) throw then;
    return held as ListRow;
  }

  /**
   * A list the caller may delete, held: one they made, whatever their role
   * now — made a viewer, they may still take back what they named — or,
   * for an owner, one they can see that nobody may change any more
   * (`stranded`). Anybody else without `list.manage` is told so, whether or
   * not there is a list; outside its audience it is 404; in it, 403.
   */
  private async deletable(trx: Db, p: Principal, id: string): Promise<ListRow> {
    const first = await this.seen(trx, p, id);
    if (!first || !isMaker(p, first)) {
      requireCapability(p, 'list.manage');
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
   * Whether nobody may change a list any more: its maker has no sign-in in
   * the household, or is no longer in its audience. Their membership is
   * held while it is looked at, so a role given back meanwhile waits.
   */
  private async stranded(trx: Db, p: Principal, list: ListRow): Promise<boolean> {
    if (list.owner_member_id === null) return true;
    const maker = await trx
      .selectFrom('account_household')
      .select('role')
      .where('household_id', '=', p.householdId)
      .where('member_id', '=', list.owner_member_id)
      .forShare()
      .executeTakeFirst();
    return !maker || !inListAudience(maker.role, list.audience);
  }

  private view(p: Principal, row: ListRow, itemCount: number): ListView {
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
      etag: listEtag(row),
    };
  }

  /**
   * A list with a page of the documents on it the caller may see, in the
   * order they were put there, and how many of them there are in all.
   */
  private async detail(
    trx: Db,
    p: Principal,
    list: ListRow,
    page: ItemsPage = {},
  ): Promise<ListDetail> {
    const limit = Math.min(Math.max(page.limit ?? LIST_ITEMS_PAGE, 1), LIST_ITEMS_PAGE_MAX);
    // The documents on it the caller may see, out of the Trash: those they
    // are given, and all they are counted.
    const given = () =>
      trx
        .selectFrom('doc_list_item as i')
        .innerJoin('document as d', 'd.id', 'i.document_id')
        .where('i.list_id', '=', list.id)
        .where('d.deleted_at', 'is', null)
        .where(seenDocument(p));
    let q = given().selectAll('d').select('i.added_at as on_list_since');
    if (page.cursor) {
      // After the one the last page ended with, found as the caller sees
      // the list: one they are not given is a cursor that is not valid,
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
    const documents: DocumentView[] = await this.documents.listed(trx, shown);
    // Its maker is told who in its audience is not given each one; nobody
    // else is told anything a document they cannot see would leave behind.
    const maker = isMaker(p, list);
    const items: ListItemView[] = shown.map((r, i) => ({
      document: documents[i] as DocumentView,
      added_at: r.on_list_since.toISOString(),
      hint: maker ? listItemHint(list.audience, r) : null,
    }));
    const last = shown[shown.length - 1];
    const more = rows.length > limit;
    return {
      ...this.view(p, list, n),
      items,
      next_cursor: more && last ? encodeCursor(last.id) : null,
      has_more: more,
    };
  }
}
