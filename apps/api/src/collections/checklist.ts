import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  CHECKLIST_ITEMS_MAX,
  CHECKLIST_TEXT_MAX,
  checkChecklist,
  checklistMissing,
  itemAgain,
  savedItem,
  type ChecklistAdded,
  type ChecklistContext,
  type ChecklistDoc,
  type ChecklistItem,
  type ChecklistReadItem,
  type ChecklistReading,
  type CollectionChecklist,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import { kindGiven, seenDocument, typeView, type DocumentService } from '../documents/service.js';
import type { ChecklistReader } from '../documents/proposal-pool.js';
import type { CollectionService } from './service.js';

/**
 * A collection from a checklist (0.9.0, C1; @fdv/shared checklist.ts for
 * how a list is read and matched).
 *
 * - **Read off the event loop.** What a family types is read on the
 *   proposal thread (proposal-pool.ts), as a page's words are, with its
 *   deadline: past it, or with the queue full, the answer is `503
 *   checklist_unavailable`, and nothing is lost. CHECKLIST_TEXT_MAX
 *   characters at most, refused before anything reads them.
 * - **Matched as the reader sees.** Only documents the caller may see, out
 *   of the Trash, by the one visibility rule (`seenDocument`): somebody
 *   else's Only me document is never a match, nor counted. People are the
 *   family the caller may choose — a teen only themselves, never a guest —
 *   so a name that is anybody else is nobody to them.
 * - **Nothing is put in until its maker ticks it.** POST reads and matches
 *   and writes nothing; PUT keeps the list; `add` puts in the documents
 *   chosen, through the collection's own rules (`addWithin`: its links, its
 *   warnings, its log), each one the caller may still see, out of the
 *   Trash, not in it already — the rest said, and why.
 * - **The checklist is the collection's**, kept in plain text as its name
 *   and words are, given only to the family who see the collection (an
 *   owner, an adult or a teen; 0077 keeps viewers, guests and every link
 *   out), and changed by its maker alone (A18).
 */

/** The family who may read a collection's checklist: never a viewer or a guest. */
const FAMILY = new Set(['owner', 'adult', 'teen']);

const forTheFamily = () =>
  new ApiError(403, 'forbidden', 'A collection’s checklist is for the family who see it.');
const notTheMaker = () =>
  new ApiError(
    403,
    'forbidden',
    'Only the person who made this collection can fill it from a checklist.',
  );
const unread = () =>
  new ApiError(
    503,
    'checklist_unavailable',
    'The list could not be read just now. Try again in a moment.',
  );

/** The most documents of one kind a checklist is matched against: the newest. */
const DOCS_PER_KIND = 2_000;

const today = () => new Date().toISOString().slice(0, 10);

interface Context {
  ctx: ChecklistContext;
  audience: string;
  mine: boolean;
}

export class ChecklistService {
  constructor(
    private readonly db: Db,
    private readonly collections: CollectionService,
    private readonly reader: ChecklistReader,
    private readonly documents: DocumentService,
  ) {}

  /** The checklist kept on a collection, matched again for the reader; none kept is empty. */
  async get(p: Principal, id: string): Promise<CollectionChecklist> {
    if (!FAMILY.has(p.role) || p.guest) throw forTheFamily();
    return withPrincipal(this.db, p, async (trx) => {
      const c = await this.context(trx, p, id, false);
      const kept = await trx
        .selectFrom('collection_checklist')
        .select(['items', 'updated_at'])
        .where('collection_id', '=', id)
        .executeTakeFirst();
      if (!kept)
        return { saved_at: null, items: [], missing: [], to_add: 0, left_out: 0, mine: c.mine };
      const items = storedItems(kept.items).map((i) => itemAgain(i, c.ctx));
      return this.answer(trx, p, id, c, { items, left_out: 0 }, kept.updated_at.toISOString());
    });
  }

  /** A list read, or items as the person set them, and matched: nothing is kept. */
  async check(
    p: Principal,
    id: string,
    input: { text?: string | undefined; items?: ChecklistItem[] | undefined },
  ): Promise<CollectionChecklist> {
    requireCapability(p, 'collection.manage');
    const first = await withPrincipal(this.db, p, (trx) => this.context(trx, p, id, false));
    if (!first.mine) throw notTheMaker();
    const reading = await this.read(first.ctx, input);
    return withPrincipal(this.db, p, async (trx) => {
      const c = await this.context(trx, p, id, false);
      return this.answer(trx, p, id, c, again(reading, c.ctx), null);
    });
  }

  /** The checklist kept on the collection, by its maker; its activity line says it was changed. */
  async save(
    p: Principal,
    id: string,
    items: ChecklistItem[],
    meta: RequestMeta,
  ): Promise<CollectionChecklist> {
    requireCapability(p, 'collection.manage');
    return withPrincipal(this.db, p, async (trx) => {
      const c = await this.context(trx, p, id, true);
      const kept = items.slice(0, CHECKLIST_ITEMS_MAX).map((i) => savedItem(itemAgain(i, c.ctx)));
      const json = JSON.stringify(kept);
      // The same list again is no change: nothing written, and no line in the log.
      const was = await trx
        .selectFrom('collection_checklist')
        .select(['items', 'updated_at'])
        .where('collection_id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (was && JSON.stringify(storedItems(was.items).map(savedItem)) === json) {
        return this.answer(
          trx,
          p,
          id,
          c,
          { items: kept.map((i) => itemAgain(i, c.ctx)), left_out: 0 },
          was.updated_at.toISOString(),
        );
      }
      const saved = await trx
        .insertInto('collection_checklist')
        .values({
          collection_id: id,
          household_id: p.householdId,
          items: json,
          updated_by: p.accountId,
        })
        .onConflict((oc) =>
          oc.column('collection_id').doUpdateSet({
            items: json,
            updated_at: new Date(),
            updated_by: p.accountId,
          }),
        )
        .returning('updated_at')
        .executeTakeFirstOrThrow();
      // Its words changed: as a collection's words are said, never what they now are.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.updated',
        objectType: 'collection',
        objectId: id,
        detail: { checklist: true },
        ip: meta.ip,
      });
      return this.answer(
        trx,
        p,
        id,
        c,
        { items: kept.map((i) => itemAgain(i, c.ctx)), left_out: 0 },
        saved.updated_at.toISOString(),
      );
    });
  }

  /**
   * The documents ticked, put in by the collection's own rules, in one
   * transaction: each the caller may see, out of the Trash, and not in it
   * already; the others skipped, and why. Nothing is put in that was not
   * asked for.
   */
  async add(
    p: Principal,
    id: string,
    documentIds: string[],
    meta: RequestMeta,
  ): Promise<ChecklistAdded> {
    requireCapability(p, 'collection.manage');
    const asked = [...new Set(documentIds.map((d) => d.toLowerCase()))];
    const done = await withPrincipal(this.db, p, async (trx) => {
      await this.context(trx, p, id, true);
      // Held, in one order, as the collection's own add holds them: one
      // taken to the Trash, or out of the caller's sight, meanwhile is
      // skipped as not there — the rest still go in (the C1 review).
      const there = await trx
        .selectFrom('document as d')
        .select(['d.id'])
        .where('d.id', 'in', asked)
        .where('d.deleted_at', 'is', null)
        .where(seenDocument(p))
        .orderBy('d.id')
        .forUpdate()
        .execute();
      const inIt = new Set(
        (
          await trx
            .selectFrom('doc_collection_item')
            .select('document_id')
            .where('collection_id', '=', id)
            .where(
              'document_id',
              'in',
              there.length > 0 ? there.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000'],
            )
            .execute()
        ).map((r) => r.document_id),
      );
      const byId = new Map(
        there.map((r) => [r.id.toLowerCase(), { id: r.id, in_it: inIt.has(r.id) }]),
      );
      const skipped: ChecklistAdded['skipped'] = [];
      const adding: string[] = [];
      for (const a of asked) {
        const r = byId.get(a);
        if (!r) skipped.push({ document_id: a, why: 'not_found' });
        else if (r.in_it) skipped.push({ document_id: r.id, why: 'in_collection' });
        else adding.push(r.id);
      }
      const warnings =
        adding.length > 0 ? await this.collections.addWithin(trx, p, id, adding, meta) : [];
      return { added: adding, skipped, warnings };
    });
    // Read afresh, the change made and let go.
    const collection = await this.collections.get(p, id);
    return { ...done, collection };
  }

  // -------------------------------------------------------------- internals

  /** A list read on the thread, or the items given, read again for what they lack. */
  private async read(
    ctx: ChecklistContext,
    input: { text?: string | undefined; items?: ChecklistItem[] | undefined },
  ): Promise<ChecklistReading> {
    if (input.items !== undefined) {
      return {
        items: input.items.slice(0, CHECKLIST_ITEMS_MAX).map((i) => itemAgain(i, ctx)),
        left_out: Math.max(0, input.items.length - CHECKLIST_ITEMS_MAX),
      };
    }
    const text = (input.text ?? '').slice(0, CHECKLIST_TEXT_MAX);
    if (text.trim() === '') return { items: [], left_out: 0 };
    const reading = await this.reader.readChecklist(text, ctx);
    if (!reading) throw unread();
    return reading;
  }

  /**
   * What reading needs, as the caller is given it now: the collection (held
   * for a change), the kinds GET /document-types gives them, and the family
   * they may choose — a teen only themselves, never a guest.
   */
  private async context(trx: Db, p: Principal, id: string, held: boolean): Promise<Context> {
    const collection = await this.collections.checklistOf(trx, p, id, held);
    const kinds = await trx
      .selectFrom('effective_document_type as t')
      .selectAll('t')
      .where(kindGiven(p, sql<boolean>`t.builtin`))
      .execute();
    const family = await trx
      .selectFrom('member')
      .select(['id', 'display_name'])
      .where('kind', '=', 'family')
      .$if(p.role === 'teen', (q) => q.where('id', '=', p.memberId))
      .orderBy('created_at')
      .execute();
    return {
      audience: collection.audience,
      mine: collection.mine,
      ctx: {
        types: kinds.map(typeView).map((t) => ({
          key: t.key,
          label: t.label,
          short_label: t.short_label ?? null,
          hidden: t.hidden ?? false,
        })),
        people: family.map((m) => ({ id: m.id, name: m.display_name })),
        me: p.memberId,
        today: today(),
      },
    };
  }

  /** The items matched against what the caller may see. */
  private async answer(
    trx: Db,
    p: Principal,
    id: string,
    c: Context,
    reading: { items: ChecklistReadItem[]; left_out: number },
    savedAt: string | null,
  ): Promise<CollectionChecklist> {
    const asked = new Set(
      reading.items.filter((i) => i.understood && !i.skipped).map((i) => i.type_key as string),
    );
    // An investment line offers the bank statements it was filed as before 0077.
    if (asked.has('investment_statement')) asked.add('bank_statement');
    const kinds = [...asked];
    // The newest DOCS_PER_KIND of each kind the caller may see, out of the Trash.
    const ranked = trx
      .selectFrom('document as d')
      .leftJoin('doc_collection_item as i', (j) =>
        j.onRef('i.document_id', '=', 'd.id').on('i.collection_id', '=', id),
      )
      .select([
        'd.id',
        'd.title',
        'd.type_key',
        'd.owner_member_id',
        'd.visibility',
        'd.issued_on',
        'd.issued_precision',
        'd.expires_on',
        'd.expires_precision',
        'd.created_at',
        // A tax form's or a return's year, as kept; an Only me one's is sealed…
        sql<string | null>`case when d.visibility = 'private' then null
                                else d.extra->>'tax_year' end`.as('tax_year'),
        // …and opened below for its owner alone.
        sql<Buffer | null>`case when d.visibility = 'private'
                                 and d.owner_member_id = ${p.memberId}::uuid
                                then d.extra_sealed end`.as('own_sealed'),
        'i.document_id as in_it',
        sql<number>`row_number() over (partition by d.type_key
                      order by d.issued_on desc nulls last, d.created_at desc, d.id)`.as('rn'),
      ])
      .where('d.type_key', 'in', kinds.length > 0 ? kinds : ['-'])
      .where('d.deleted_at', 'is', null)
      .where(seenDocument(p));
    const rows =
      kinds.length === 0
        ? []
        : await trx
            .selectFrom(ranked.as('r'))
            .selectAll('r')
            .where('r.rn', '<=', DOCS_PER_KIND)
            .orderBy('r.type_key')
            .orderBy('r.rn')
            .execute();
    const opened = await this.documents.ownSealedDetails(
      trx,
      p,
      rows.map((r) => ({ id: r.id, sealed: r.own_sealed })),
    );
    const docs: ChecklistDoc[] = rows.map((r) => {
      const own = opened.get(r.id)?.tax_year;
      return {
        id: r.id,
        title: r.title,
        type_key: r.type_key,
        owner_member_id: r.owner_member_id,
        visibility: r.visibility,
        issued: r.issued_on ? { date: r.issued_on, precision: r.issued_precision ?? 'day' } : null,
        expires: r.expires_on
          ? { date: r.expires_on, precision: r.expires_precision ?? 'day' }
          : null,
        created_at: r.created_at.toISOString(),
        tax_year:
          r.tax_year ?? (typeof own === 'string' || typeof own === 'number' ? String(own) : null),
        in_collection: r.in_it !== null,
      };
    });
    const items = checkChecklist(reading.items, docs, {
      today: c.ctx.today,
      audience: c.audience,
      people: c.ctx.people,
      types: c.ctx.types,
    });
    const ticked = new Set(
      items.flatMap((i) => i.matches.filter((m) => m.ticked).map((m) => m.document_id)),
    );
    return {
      saved_at: savedAt,
      items,
      missing: checklistMissing(items),
      to_add: ticked.size,
      left_out: reading.left_out,
      mine: c.mine,
    };
  }
}

/** A reading's items read again for the caller: a person they may not choose is nobody. */
function again(reading: ChecklistReading, ctx: ChecklistContext): ChecklistReading {
  return {
    left_out: reading.left_out,
    // What the reading asked about (whose, of two) it still asks, and what it said.
    items: reading.items.map((i) => {
      const read = itemAgain(i, ctx);
      const years = i.problem === 'years' && read.problem === null;
      return {
        ...read,
        note: i.note ?? null,
        ...(years ? { problem: 'years' as const, understood: false } : {}),
      };
    }),
  };
}

/** Items as kept: what the API wrote, each read as an item, anything else none. */
function storedItems(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ChecklistItem[] = [];
  for (const r of raw.slice(0, CHECKLIST_ITEMS_MAX)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
    out.push({
      line: typeof o.line === 'string' ? o.line : '',
      heading: typeof o.heading === 'string' ? o.heading : null,
      type_key: typeof o.type_key === 'string' ? o.type_key : null,
      member_id: typeof o.member_id === 'string' ? o.member_id : null,
      count: n(o.count),
      months: n(o.months),
      years: Array.isArray(o.years) ? o.years.filter((y): y is number => Number.isInteger(y)) : [],
      in_months: Array.isArray(o.in_months)
        ? o.in_months.filter((m): m is string => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m))
        : [],
      within: n(o.within),
      current: o.current === true,
      form: typeof o.form === 'string' ? o.form : null,
      skipped: o.skipped === true,
      unresolved:
        o.unresolved === 'person_unknown' || o.unresolved === 'person_shared' ? o.unresolved : null,
    });
  }
  return out;
}
