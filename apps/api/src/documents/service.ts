import {
  checkCaptureMetadata,
  effectiveVisibility,
  issuerCandidates,
  type IssuerCount,
  type IssuerSuggestions,
  type KnownIssuer,
  type CaptureMetadata,
  type UploadStatus,
  type SearchHit as WireSearchHit,
} from '@fdv/shared';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DecryptStream,
  decryptRange,
  EncryptStream,
  newKey,
  unwrapKey,
  wrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import { appendAudit, withScope, type Db, type Visibility } from '@fdv/db';
import {
  deriveStatus,
  type DateValue,
  type DocumentTypeView,
  type DocumentView,
  type VersionView,
} from '@fdv/shared';
import { objectKey, readAll, type StorageAdapter } from '@fdv/storage';
import { sql, type Expression, type SqlBool } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import type { ReminderService } from '../reminders/service.js';
import { signSealedToken } from './sealed-token.js';
import { openSealedText } from './sealed-text.js';
import { allows, requireCapability } from '../authz.js';
import { canSee, PREVIEW_MAX_PAGES } from '@fdv/shared';

/**
 * Documents: the metadata rows and their immutable, encrypted versions.
 *
 * Access: every query is already tenant-scoped by RLS. On top of that, a
 * document is visible to a principal when its visibility is `household`,
 * or `adults` and the role is owner/adult, or `private` and the principal
 * *is* the owning member. That rule is applied in SQL to every read so a
 * forgotten check in one handler cannot leak a private document.
 *
 * Content: each version gets its own file key, wrapped by the scope key
 * that matches the document's visibility at upload time. Changing
 * visibility (1.6) rewraps those keys; the ciphertext never moves.
 */

export interface DocumentInput {
  type_key?: string | null | undefined;
  title?: string | null | undefined;
  owner_member_id?: string | null | undefined;
  category?: string | null | undefined;
  visibility?: Visibility | undefined;
  issued?: DateValue | null | undefined;
  expires?: DateValue | null | undefined;
  identifier?: string | null | undefined;
  issued_by?: string | null | undefined;
  physical_location?: string | null | undefined;
  is_essential?: boolean | undefined;
  tags?: string[] | undefined;
  notes?: string | null | undefined;
  extra?: Record<string, unknown> | undefined;
}

export interface ListQuery {
  member_id?: string | undefined;
  category?: string | undefined;
  /** Who issued it: the filter chips (0.4.10), matched regardless of case. */
  issued_by?: string | undefined;
  type_key?: string | undefined;
  tag?: string | undefined;
  visibility?: Visibility | undefined;
  essential?: boolean | undefined;
  status?: string | undefined;
  deleted?: boolean | undefined;
  updated_since?: string | undefined;
  sort?: 'recent' | 'expiring' | 'alpha' | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface UploadInput {
  filename: string;
  mime: string;
  stream: Readable;
  idempotencyKey: string;
  /** True when the multipart parser cut the file off at the size limit. */
  truncated?: () => boolean;
  /**
   * Called once the file has arrived, before anything is committed: the
   * route's last chance to refuse the request (a field sent after the file).
   */
  finished?: () => Promise<void>;
}

/** What an upload is for: a new document (capture), or a new version of one. */
export type UploadTarget =
  { kind: 'capture'; metadata?: CaptureMetadata } | { kind: 'version'; documentId: string };

/** A try that holds its key: everything the stream and the commit need. */
interface Claim {
  key: string;
  nonce: string;
  documentId: string;
  /** A capture's new document, as it will be inserted. */
  values: Record<string, never>;
  scope: ReturnType<typeof scopeFor>;
  vaultId: string;
  adapter: StorageAdapter;
  scopeKeyId: string;
  fileKey: ReturnType<typeof newKey>;
  fileKeyWrapped: ReturnType<typeof wrapKey>;
  tempKey: string;
}

type DocRow = {
  id: string;
  type_key: string | null;
  title: string | null;
  owner_member_id: string | null;
  category: string | null;
  visibility: Visibility;
  issued_on: string | null;
  issued_precision: 'day' | 'month' | 'year' | null;
  expires_on: string | null;
  expires_precision: 'day' | 'month' | 'year' | null;
  identifier: string | null;
  issued_by: string | null;
  physical_location: string | null;
  is_essential: boolean;
  tags: string[];
  notes: string | null;
  extra: unknown;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

const isoDate = (d: string | null): string | null => (d === null ? null : d.slice(0, 10));

const today = () => new Date().toISOString().slice(0, 10);

const notFound = () => new ApiError(404, 'not_found', 'That document is not in the vault.');

/**
 * Changed when a migration changes what documents say without anyone
 * editing them, and so without touching updated_at: every ETag handed out
 * before goes stale, and a write made from an older view is refused (412)
 * instead of putting back what the migration moved. 2: 0025 moved issuers
 * out of extra.
 */
const ETAG_EPOCH = 2;

export function etagOf(id: string, updatedAt: Date): string {
  const seed = `${id}:${updatedAt.toISOString()}:${ETAG_EPOCH}`;
  return `"${createHash('sha256').update(seed).digest('hex').slice(0, 16)}"`;
}

/** How the API hands work to the worker. The server wires pg-boss; tests collect. */
/**
 * Puts a job on the worker's queue. `singletonKey` holds one job per key on
 * a queue that asks for it (page previews: one per version); a higher
 * `priority` is taken first.
 */
export type Enqueue = (
  name: string,
  data: Record<string, unknown>,
  options?: { singletonKey?: string; priority?: number },
) => Promise<void>;

export interface SearchQuery {
  q: string;
  member_id?: string | undefined;
  category?: string | undefined;
  issued_by?: string | undefined;
  limit?: number | undefined;
}

/** A search result: the shared wire type, with the rank the server always sends. */
export type SearchHit = WireSearchHit & { rank: number };

export class DocumentService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    private readonly maxUploadBytes: number,
    private readonly enqueue: Enqueue = async () => undefined,
    private readonly reminders: ReminderService | null = null,
    /** Signs the handle on the second pass of search; null disables it. */
    private readonly sealedKey: Uint8Array | null = null,
  ) {}

  // ---------------------------------------------------------------- types

  async types(): Promise<DocumentTypeView[]> {
    const rows = await this.db
      .selectFrom('document_type')
      .selectAll()
      .orderBy('sort_order')
      .execute();
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      category: r.category,
      fields: r.fields as DocumentTypeView['fields'],
      expiry_driver: r.expiry_driver,
      reminder_leads: r.reminder_leads,
      usually_essential: r.usually_essential,
      default_visibility: r.default_visibility,
      issued_by_label: r.issued_by_label,
    }));
  }

  private async typeOrThrow(key: string, db: Db = this.db) {
    const t = await db
      .selectFrom('document_type')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst();
    if (!t)
      throw new ApiError(422, 'validation_failed', 'That kind of document is not on the list.');
    return t;
  }

  // ---------------------------------------------------------------- access

  /** The SQL predicate for "this principal may see this document". */
  private visibleTo(p: Principal) {
    return (eb: {
      or: (xs: Expression<SqlBool>[]) => Expression<SqlBool>;
      and: (xs: Expression<SqlBool>[]) => Expression<SqlBool>;
      <A extends string, B>(a: A, op: '=', b: B): Expression<SqlBool>;
    }) => {
      const clauses: Expression<SqlBool>[] = [eb('document.visibility', '=', 'household')];
      if (allows(p, 'document.see_adults')) {
        clauses.push(eb('document.visibility', '=', 'adults'));
      }
      clauses.push(
        eb.and([
          eb('document.visibility', '=', 'private'),
          eb('document.owner_member_id', '=', p.memberId),
        ]),
      );
      return eb.or(clauses);
    };
  }

  /**
   * Who may move a document from one person to another.
   *
   * A private document never changes hands here: its file keys are
   * wrapped for its owner alone, and handing it over would either strand
   * them or need a rewrap nobody asked for. Make it visible first.
   *
   * And a document that belongs to somebody with their own sign-in is
   * theirs to hand over. Otherwise another adult could make themselves its
   * owner and then mark it "Only me" — taking it from the person it
   * belonged to, in a way their own activity log would not even show.
   */
  private async mayHandOver(
    trx: Db,
    p: Principal,
    current: { visibility: string; owner_member_id: string | null },
  ): Promise<void> {
    if (current.visibility === 'private') {
      throw new ApiError(
        422,
        'validation_failed',
        'A private document stays with the person it belongs to. Make it visible to the family before handing it to somebody else.',
      );
    }
    const from = current.owner_member_id;
    if (!from || from === p.memberId) return;
    const holder = await trx
      .selectFrom('account_household')
      .innerJoin('member', 'member.id', 'account_household.member_id')
      .select(['member.display_name'])
      .where('account_household.member_id', '=', from)
      .executeTakeFirst();
    if (holder) {
      throw new ApiError(
        403,
        'forbidden',
        `This belongs to ${holder.display_name}, who signs in themselves, so only they can hand it to somebody else.`,
      );
    }
  }

  private canWrite(p: Principal): void {
    requireCapability(p, 'document.edit');
  }

  /**
   * The ownership half of the teen rule: the matrix says a teen may change
   * documents, this says only their own. It applies to the trash as much
   * as to editing — being unable to correct a parent's council tax bill
   * but able to throw it away would be a strange kind of protection.
   */
  private mustOwnIfTeen(p: Principal, row: { owner_member_id: string | null }): void {
    if (p.role === 'teen' && row.owner_member_id !== p.memberId) {
      throw new ApiError(403, 'forbidden', 'You can only change your own documents.');
    }
  }

  private async fetch(trx: Db, p: Principal, id: string, includeDeleted = false): Promise<DocRow> {
    let q = trx
      .selectFrom('document')
      .selectAll()
      .where('id', '=', id)
      .where(this.visibleTo(p) as never);
    if (!includeDeleted) q = q.where('deleted_at', 'is', null);
    const row = await q.executeTakeFirst();
    if (!row) throw notFound();
    return row;
  }

  // ---------------------------------------------------------------- views

  private async view(trx: Db, row: DocRow): Promise<DocumentView> {
    const type = row.type_key ? await this.typeCached(trx, row.type_key) : null;
    const versions = await trx
      .selectFrom('document_version')
      .select(['id', 'version_no'])
      .where('document_id', '=', row.id)
      .orderBy('version_no', 'desc')
      .execute();
    const issued = row.issued_on
      ? {
          date: isoDate(row.issued_on) as string,
          precision: row.issued_precision as DateValue['precision'],
        }
      : null;
    const expires = row.expires_on
      ? {
          date: isoDate(row.expires_on) as string,
          precision: row.expires_precision as DateValue['precision'],
        }
      : null;
    return {
      id: row.id,
      type_key: row.type_key,
      title: row.title,
      owner_member_id: row.owner_member_id,
      category: row.category,
      visibility: row.visibility,
      issued,
      expires,
      identifier: row.identifier,
      issued_by: row.issued_by,
      physical_location: row.physical_location,
      is_essential: row.is_essential,
      tags: row.tags,
      notes: row.notes,
      extra: (row.extra ?? {}) as Record<string, unknown>,
      status: deriveStatus(
        {
          type: type
            ? {
                key: type.key,
                expiry_driver: type.expiry_driver,
                reminder_leads: type.reminder_leads,
              }
            : null,
          owner_member_id: row.owner_member_id,
          expires,
        },
        today(),
      ),
      versions: versions.length,
      latest_version_id: versions[0]?.id ?? null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      deleted_at: row.deleted_at?.toISOString() ?? null,
      etag: etagOf(row.id, row.updated_at),
    };
  }

  private typeCache = new Map<
    string,
    {
      key: string;
      expiry_driver: string | null;
      reminder_leads: number[];
      category: string;
      default_visibility: Visibility;
    }
  >();
  private async typeCached(trx: Db, key: string) {
    const hit = this.typeCache.get(key);
    if (hit) return hit;
    const t = await trx
      .selectFrom('document_type')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst();
    if (!t) return null;
    const v = {
      key: t.key,
      expiry_driver: t.expiry_driver,
      reminder_leads: t.reminder_leads,
      category: t.category,
      default_visibility: t.default_visibility,
    };
    this.typeCache.set(key, v);
    return v;
  }

  // ---------------------------------------------------------------- CRUD

  async create(p: Principal, input: DocumentInput, meta: RequestMeta): Promise<DocumentView> {
    this.canWrite(p);
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const values = await this.columns(trx, p, await this.ownVisibility(trx, p, input), null);
      // A teen's documents are their own, and only their own. Without
      // this, adding one without naming a person makes a family document
      // they are immediately unable to change — which is what the rule
      // says if nobody asks what "their own" means at the moment of
      // creation. Naming somebody else is refused for the same reason:
      // it would put the document out of their reach as they filed it.
      const named = (values as { owner_member_id?: string | null }).owner_member_id;
      if (p.role === 'teen' && named != null && named !== p.memberId) {
        throw new ApiError(403, 'forbidden', 'You can only add documents that belong to you.');
      }
      const mine = p.role === 'teen' ? { owner_member_id: p.memberId } : {};
      const row = await trx
        .insertInto('document')
        .values({
          household_id: p.householdId,
          created_by: p.accountId,
          updated_by: p.accountId,
          ...values,
          ...mine,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.reminders?.regenerateDerived(trx, p.householdId, row.id);
      await this.toldPrivate(trx, p, row);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.created',
        objectType: 'document',
        objectId: row.id,
        detail: { title: row.title, type_key: row.type_key },
        ip: meta.ip,
      });
      return this.view(trx, row);
    });
  }

  /**
   * A new document's visibility, for a role that cannot see Adults only
   * documents (a teen): never Adults only, whether asked for or left to
   * the type's default — their own document would vanish from them as they
   * filed it. Asking is refused; the default becomes Everyone.
   */
  private async ownVisibility(trx: Db, p: Principal, input: DocumentInput): Promise<DocumentInput> {
    if (allows(p, 'document.see_adults')) return input;
    if (input.visibility === 'adults') {
      throw new ApiError(403, 'forbidden', 'Only an adult can make a document adults-only.');
    }
    if (input.visibility !== undefined || !input.type_key) return input;
    const t = await this.typeOrThrow(input.type_key, trx);
    return t.default_visibility === 'adults' ? { ...input, visibility: 'household' } : input;
  }

  /**
   * SEC-19: whoever makes a document Only me is told what that means, on
   * the card, before they save — so a document made private from the start
   * is recorded as told, as the visibility change records it.
   */
  private async toldPrivate(
    trx: Db,
    p: Principal,
    row: { id: string; visibility: Visibility; owner_member_id: string | null },
  ): Promise<void> {
    if (row.visibility !== 'private' || row.owner_member_id !== p.memberId) return;
    await trx
      .insertInto('private_notice')
      .values({ household_id: p.householdId, document_id: row.id, member_id: p.memberId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async get(p: Principal, id: string): Promise<DocumentView> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) =>
      this.view(trx, await this.fetch(trx, p, id, true)),
    );
  }

  async update(
    p: Principal,
    id: string,
    input: DocumentInput,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ) {
    this.canWrite(p);
    let drawNow: string | null = null;
    const view = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const current = await this.fetch(trx, p, id);
      if (ifMatch && ifMatch !== etagOf(current.id, current.updated_at)) {
        throw new ApiError(
          409,
          'conflict',
          'Someone else changed this document. Reload and try again.',
          {
            detail: JSON.stringify(await this.view(trx, current)),
          },
        );
      }
      this.mustOwnIfTeen(p, current);
      const values = await this.columns(trx, p, input, current);
      const row = await trx
        .updateTable('document')
        .set({ ...values, updated_at: new Date(), updated_by: p.accountId })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.expires !== undefined || input.type_key !== undefined) {
        await this.reminders?.regenerateDerived(trx, p.householdId, id);
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.updated',
        objectType: 'document',
        objectId: id,
        detail: { fields: Object.keys(input) },
        ip: meta.ip,
      });
      // Becoming Essential: its current version's pages are drawn now, so
      // a phone can keep them for when there is no connection (0.4.12).
      if (row.is_essential && !current.is_essential) {
        const latest = await trx
          .updateTable('document_version')
          .set({ preview_state: 'queued', preview_requested_at: new Date() })
          .where('id', '=', (eb) =>
            eb
              .selectFrom('document_version')
              .select('id')
              .where('document_id', '=', id)
              .orderBy('version_no', 'desc')
              .limit(1),
          )
          .where('preview_state', 'in', ['none', 'failed'])
          .returning('id')
          .executeTakeFirst();
        drawNow = latest?.id ?? null;
      }
      return this.view(trx, row);
    });
    if (drawNow) {
      await this.enqueue(
        PREVIEWS_JOB,
        { household_id: p.householdId, version_id: drawNow },
        { singletonKey: previewJobKey(drawNow), priority: 5 },
      ).catch(() => undefined);
    }
    return view;
  }

  /** ORG-08: soft delete, recoverable for 30 days. */
  async softDelete(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    this.canWrite(p);
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      this.mustOwnIfTeen(p, await this.fetch(trx, p, id));
      await trx
        .updateTable('document')
        .set({ deleted_at: new Date(), updated_at: new Date(), updated_by: p.accountId })
        .where('id', '=', id)
        .execute();
      await this.reminders?.regenerateDerived(trx, p.householdId, id);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.deleted',
        objectType: 'document',
        objectId: id,
        ip: meta.ip,
      });
    });
  }

  async restore(p: Principal, id: string, meta: RequestMeta): Promise<DocumentView> {
    this.canWrite(p);
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await this.fetch(trx, p, id, true);
      this.mustOwnIfTeen(p, row);
      if (!row.deleted_at) return this.view(trx, row);
      const restored = await trx
        .updateTable('document')
        .set({ deleted_at: null, updated_at: new Date(), updated_by: p.accountId })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.reminders?.regenerateDerived(trx, p.householdId, id);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.restored',
        objectType: 'document',
        objectId: id,
        ip: meta.ip,
      });
      return this.view(trx, restored);
    });
  }

  async list(
    p: Principal,
    q: ListQuery,
  ): Promise<{ items: DocumentView[]; next_cursor: string | null; has_more: boolean }> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      let query = trx
        .selectFrom('document')
        .selectAll()
        .where(this.visibleTo(p) as never);
      query = q.deleted
        ? query.where('deleted_at', 'is not', null)
        : query.where('deleted_at', 'is', null);
      if (q.member_id) query = query.where('owner_member_id', '=', q.member_id);
      if (q.category) query = query.where('category', '=', q.category);
      if (q.type_key) query = query.where('type_key', '=', q.type_key);
      if (q.visibility) query = query.where('visibility', '=', q.visibility);
      if (q.essential !== undefined) query = query.where('is_essential', '=', q.essential);
      if (q.tag) query = query.where(sql<boolean>`${sql.ref('tags')} @> array[${q.tag}]::text[]`);
      if (q.issued_by) {
        query = query.where(sql<boolean>`lower(issued_by) = lower(${q.issued_by.trim()})`);
      }
      if (q.updated_since) query = query.where('updated_at', '>', new Date(q.updated_since));

      const sort = q.sort ?? 'recent';
      if (sort === 'alpha') query = query.orderBy('title').orderBy('id');
      else if (sort === 'expiring') query = query.orderBy(sql`expires_on nulls last`).orderBy('id');
      else query = query.orderBy('updated_at', 'desc').orderBy('id');

      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (sort === 'recent') {
          query = query.where(sql<boolean>`(updated_at, id) < (${new Date(c.k)}, ${c.id}::uuid)`);
        } else if (sort === 'alpha') {
          query = query.where(sql<boolean>`(title, id) > (${c.k}, ${c.id}::uuid)`);
        } else {
          query = query.where(
            sql<boolean>`(coalesce(expires_on, 'infinity'::date), id) > (${c.k}::date, ${c.id}::uuid)`,
          );
        }
      }
      const rows = (await query.limit(limit + 1).execute()) as unknown as DocRow[];
      const page = rows.slice(0, limit);
      const items = await Promise.all(page.map((r) => this.view(trx, r)));
      const filtered = q.status ? items.filter((d) => d.status.value === q.status) : items;
      const last = page[page.length - 1];
      const next =
        rows.length > limit && last
          ? encodeCursor(
              sort === 'recent'
                ? { k: last.updated_at.toISOString(), id: last.id }
                : sort === 'alpha'
                  ? { k: last.title ?? '', id: last.id }
                  : { k: isoDate(last.expires_on) ?? 'infinity', id: last.id },
            )
          : null;
      return { items: filtered, next_cursor: next, has_more: rows.length > limit };
    });
  }

  async tags(p: Principal, q: string | undefined): Promise<Array<{ tag: string; count: number }>> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const r = await sql<{ tag: string; count: number }>`
        select t as tag, count(*)::int as count
        from document d, unnest(d.tags) as t
        where d.deleted_at is null
          -- Tags are words people write about their documents, as telling
          -- as a title. Until 0.4.2 this was the one query with no rule.
          and (d.visibility = 'household'
            or (d.visibility = 'adults' and ${allows(p, 'document.see_adults')})
            or (d.visibility = 'private' and d.owner_member_id = ${p.memberId}::uuid))
          ${q ? sql`and t ilike ${`${q}%`}` : sql``}
        group by t order by count desc, t limit 50`.execute(trx);
      return r.rows;
    });
  }

  /**
   * GET /issuers: who issued the household's documents, as far as the
   * caller can see them — the filter chips, and the card's "the household's
   * previous issuers first" (0.4.10). An issuer is as telling as a title, so
   * the rule is exactly the one tags() keeps: an issuer seen only on
   * somebody else's Only me or Adults only document is not there, and does
   * not count. One spelling per issuer, the one used most.
   */
  async issuers(
    p: Principal,
    f: {
      q?: string | undefined;
      type_key?: string | undefined;
      member_id?: string | undefined;
      category?: string | undefined;
    },
  ): Promise<IssuerCount[]> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) =>
      (await this.knownIssuers(trx, p, f))
        // For a type, only who has issued that type before: a passport card
        // offering "From Barclays?" helps nobody.
        .filter((k) => !f.type_key || (k.typeKeys ?? []).includes(f.type_key))
        .map((k) => ({ issued_by: k.value, count: k.count })),
    );
  }

  private async knownIssuers(
    trx: Db,
    p: Principal,
    f: {
      q?: string | undefined;
      type_key?: string | undefined;
      member_id?: string | undefined;
      category?: string | undefined;
    },
  ): Promise<KnownIssuer[]> {
    const prefix = f.q?.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    const r = await sql<{ value: string; count: number; type_keys: string[]; for_type: number }>`
      select mode() within group (order by d.issued_by) as value,
             count(*)::int as count,
             array_remove(array_agg(distinct d.type_key), null) as type_keys,
             count(*) filter (where d.type_key = ${f.type_key ?? null})::int as for_type
        from document d
       where d.deleted_at is null
         and d.issued_by is not null
         and (d.visibility = 'household'
           or (d.visibility = 'adults' and ${allows(p, 'document.see_adults')})
           or (d.visibility = 'private' and d.owner_member_id = ${p.memberId}::uuid))
         ${f.member_id ? sql`and d.owner_member_id = ${f.member_id}::uuid` : sql``}
         ${f.category ? sql`and d.category = ${f.category}` : sql``}
         ${prefix ? sql`and d.issued_by ilike ${`${prefix}%`}` : sql``}
       group by lower(btrim(d.issued_by))
       order by for_type desc, count desc, value
       limit 50`.execute(trx);
    return r.rows.map((row) => ({ value: row.value, count: row.count, typeKeys: row.type_keys }));
  }

  /**
   * GET /documents/{id}/issuer-suggestions: who probably issued it, going
   * by the words on its latest pages and the household's own issuers —
   * offered as a question ("From Barclays?"), never filled in (0.4.10).
   * Worked out now, in memory, and never kept: a private document's text is
   * opened only here, in its owner's own request, as the second search pass
   * opens it. 'pending' while the pages have not been read yet.
   */
  async issuerSuggestions(p: Principal, id: string): Promise<IssuerSuggestions> {
    this.canWrite(p);
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const doc = await this.fetch(trx, p, id);
      this.mustOwnIfTeen(p, doc);
      const version = await trx
        .selectFrom('document_version')
        .select(['id', 'ocr_status', 'wrapped_by_scope'])
        .where('document_id', '=', id)
        .orderBy('version_no', 'desc')
        .executeTakeFirst();
      if (!version) return { state: 'unavailable', items: [] };

      let text: string | null = null;
      if (doc.visibility === 'private') {
        const sealed = await trx
          .selectFrom('document_text_sealed')
          .select('content_cipher')
          .where('version_id', '=', version.id)
          .executeTakeFirst();
        if (sealed) {
          const key = await this.keys.unwrapById(trx, version.wrapped_by_scope);
          text = openSealedText(key, sealed.content_cipher);
        }
      } else {
        const plain = await trx
          .selectFrom('document_text')
          .select('content')
          .where('version_id', '=', version.id)
          .executeTakeFirst();
        text = plain?.content ?? null;
      }
      if (text === null) {
        return { state: version.ocr_status === 'pending' ? 'pending' : 'unavailable', items: [] };
      }

      const known = await this.knownIssuers(trx, p, { type_key: doc.type_key ?? undefined });
      // Whose name is on the letter is never who sent it.
      const members = await trx.selectFrom('member').select('display_name').execute();
      const household = await trx
        .selectFrom('household')
        .select('name')
        .where('id', '=', p.householdId)
        .executeTakeFirst();
      const people = [
        ...members.map((m) => m.display_name),
        ...(household ? [household.name] : []),
      ];
      const found = issuerCandidates(text.slice(0, 60_000), {
        known,
        typeKey: doc.type_key,
        people,
      });
      return {
        state: 'ready',
        items: found.map((c) => ({
          value: c.value,
          source: c.source === 'page' ? 'page' : 'known',
        })),
      };
    });
  }

  /** Counts by member and by category, for the home screen tiles (ORG-02). */
  async counts(p: Principal) {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const base = trx
        .selectFrom('document')
        .where(this.visibleTo(p) as never)
        .where('deleted_at', 'is', null);
      const byMember = await base
        .select(['owner_member_id', sql<number>`count(*)::int`.as('count')])
        .groupBy('owner_member_id')
        .execute();
      const byCategory = await base
        .select(['category', sql<number>`count(*)::int`.as('count')])
        .groupBy('category')
        .execute();
      return {
        by_member: byMember.map((r) => ({ member_id: r.owner_member_id, count: r.count })),
        by_category: byCategory.map((r) => ({ category: r.category, count: r.count })),
      };
    });
  }

  // ---------------------------------------------------------------- versions

  async versions(p: Principal, documentId: string): Promise<VersionView[]> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      await this.fetch(trx, p, documentId, true);
      const rows = await trx
        .selectFrom('document_version')
        .selectAll()
        .where('document_id', '=', documentId)
        .orderBy('version_no', 'desc')
        .execute();
      return rows.map(versionView);
    });
  }

  /**
   * Adds a version to a document: sniffs the type, encrypts under a fresh
   * file key wrapped by the document's scope key, stores, records. A retry
   * with the same Idempotency-Key returns the version the first try made.
   */
  async upload(
    p: Principal,
    documentId: string,
    input: UploadInput,
    meta: RequestMeta,
  ): Promise<VersionView> {
    return (await this.accept(p, { kind: 'version', documentId }, input, meta)).version;
  }

  /**
   * CAP-05: one file in, one document out, with the card's details if they
   * were sent (0.4.9), or as Needs info if not. The document and its first
   * version are made together, at the commit, so an upload that fails
   * leaves no empty document behind (CAP-13), and the file is wrapped for
   * the people the details say from its first byte.
   */
  async capture(
    p: Principal,
    input: UploadInput,
    meta: RequestMeta,
    metadata?: CaptureMetadata,
  ): Promise<{ document_id: string; version_id: string; replayed: boolean }> {
    const target: UploadTarget = metadata ? { kind: 'capture', metadata } : { kind: 'capture' };
    const { version, replayed } = await this.accept(p, target, input, meta);
    return { document_id: version.document_id, version_id: version.id, replayed };
  }

  /**
   * Every upload, a capture or a new version, is reserve-then-commit on its
   * Idempotency-Key:
   *
   *  1. Claim, under a lock on the key: a pending row naming the account,
   *     the kind of request, the document and a nonce for this try. A key
   *     that is done is answered with what it made, but only to the account
   *     that made it, for the same request, while they can still see it;
   *     any other use of the key is refused without saying what it made. A
   *     key pending for less than 15 minutes is another try still running.
   *  2. Stream the bytes, encrypted, to a temporary object for this try.
   *  3. Commit, in one transaction: the claim is still this try's, the
   *     document (for a capture) and the version are made, the key is done.
   *
   * A try that fails deletes its temporary object and its claim, so the
   * same key works again and nothing is left behind.
   */
  async accept(
    p: Principal,
    target: UploadTarget,
    input: UploadInput,
    meta: RequestMeta,
  ): Promise<{ version: VersionView; replayed: boolean }> {
    this.canWrite(p);
    if (!UUID.test(input.idempotencyKey)) {
      throw new ApiError(
        422,
        'validation_failed',
        'Idempotency-Key must be a UUID, written like 123e4567-e89b-42d3-a456-426614174000.',
      );
    }
    const claimed = await this.claim(p, target, input.idempotencyKey);
    if ('replay' in claimed) return { version: claimed.replay, replayed: true };
    const c = claimed;

    // The real type is detected from the bytes as they flow (CAP-03), and
    // the plaintext hash is computed on the way in; the adapter verifies
    // the ciphertext on the way out.
    const sniffer = sniffStream(input.mime, input.filename);
    const plainHash = createHash('sha256');
    let plainBytes = 0;
    const counted = new PassThrough();
    counted.on('data', (chunk: Buffer) => {
      plainHash.update(chunk);
      plainBytes += chunk.length;
      if (plainBytes > this.maxUploadBytes) counted.destroy(tooLarge());
    });
    const enc = new EncryptStream(c.fileKey);

    let put;
    let mime: string;
    let ext: string;
    const storing = c.adapter.put(c.tempKey, enc);
    const flowing = pipeline(input.stream, sniffer.stream, counted, enc);
    try {
      const [stored, , detected] = await Promise.all([storing, flowing, sniffer.detected]);
      put = stored;
      ({ mime, ext } = detected);
      // Cut off at the size limit on the way in: what arrived is not the file.
      if (input.truncated?.()) throw tooLarge();
      await input.finished?.();
    } catch (err) {
      // Stop the bytes and let the write finish failing before cleaning up:
      // a refusal that comes early (a type the vault does not take) would
      // otherwise leave a temporary object written after it was deleted.
      enc.destroy();
      await Promise.allSettled([storing, flowing]);
      await this.release(p, c);
      if (err instanceof ApiError) throw err;
      throw storageUnreachable((err as Error).message);
    }
    const sha256 = plainHash.digest();

    const moved: { to: string | null } = { to: null };
    let version: VersionView;
    try {
      version = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
        await lockKey(trx, p.householdId, c.key);
        const still = await trx
          .selectFrom('upload_idempotency')
          .select('idempotency_key')
          .where('idempotency_key', '=', c.key)
          .where('state', '=', 'pending')
          .where('claim_nonce', '=', c.nonce)
          .executeTakeFirst();
        // Another try took the key over while this one was slow: it wins.
        if (!still) throw uploadInProgress();

        if (target.kind === 'version') {
          // The document's row, locked before anything is read from it:
          // version numbers, and who it is wrapped for, cannot change under
          // this commit. Making it private takes the same lock (visibility.ts).
          await trx
            .selectFrom('document')
            .select('id')
            .where('id', '=', c.documentId)
            .forUpdate()
            .execute();
        }

        if (target.kind === 'capture') {
          const row = await trx
            .insertInto('document')
            .values({
              id: c.documentId,
              household_id: p.householdId,
              created_by: p.accountId,
              updated_by: p.accountId,
              ...c.values,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await this.reminders?.regenerateDerived(trx, p.householdId, row.id);
          await this.toldPrivate(trx, p, row);
          await appendAudit(trx, {
            householdId: p.householdId,
            actorAccountId: p.accountId,
            action: 'document.created',
            objectType: 'document',
            objectId: row.id,
            detail: { title: row.title, type_key: row.type_key },
            ip: meta.ip,
          });
        } else {
          // The file was encrypted for the document as it was when the
          // upload began. If it has since been made private, or moved to
          // somebody else, that key is the wrong one — and the uploader may
          // no longer be allowed to see it at all. Ask again, under the lock.
          const now = await this.fetch(trx, p, c.documentId);
          this.mustOwnIfTeen(p, now);
          const is = scopeFor(now, p.householdId);
          if (c.scope.kind !== is.kind || c.scope.memberId !== is.memberId) {
            throw new ApiError(
              409,
              'document_changed',
              'Who can see this document changed while the file was uploading. Try again.',
              { retriable: true },
            );
          }
        }

        const last = await trx
          .selectFrom('document_version')
          .select(sql<number>`coalesce(max(version_no), 0)`.as('n'))
          .where('document_id', '=', c.documentId)
          .executeTakeFirstOrThrow();
        const versionNo = Number(last.n) + 1;
        moved.to = objectKey({
          householdId: p.householdId,
          documentId: c.documentId,
          versionNo,
          name: randomBytes(8).toString('hex'),
          ext,
        });
        const storageKey = await moveObject(c.adapter, c.tempKey, moved.to);

        const row = await trx
          .insertInto('document_version')
          .values({
            household_id: p.householdId,
            document_id: c.documentId,
            version_no: versionNo,
            filename: input.filename,
            mime,
            byte_size: plainBytes,
            sha256,
            cipher_bytes: put.bytes,
            cipher_sha256: Buffer.from(put.sha256, 'hex'),
            storage_key: storageKey,
            vault_id: c.vaultId,
            file_key_wrapped: c.fileKeyWrapped,
            wrapped_by_scope: c.scopeKeyId,
            uploaded_by: p.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('upload_idempotency')
          .set({
            state: 'done',
            document_id: c.documentId,
            version_id: row.id,
            temp_key: null,
            temp_vault_id: null,
          })
          .where('idempotency_key', '=', c.key)
          .execute();
        await trx
          .updateTable('document')
          .set({ updated_at: new Date(), updated_by: p.accountId })
          .where('id', '=', c.documentId)
          .execute();
        // REM-08: the user renewed and scanned it; do not also ask them to
        // dismiss a notification.
        if (versionNo > 1)
          await this.reminders?.resolveOpen(trx, p.householdId, c.documentId, p.accountId);
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'document.version_added',
          objectType: 'document',
          objectId: c.documentId,
          detail: { version_no: versionNo, mime, bytes: plainBytes },
          ip: meta.ip,
        });
        return versionView(row);
      });
    } catch (err) {
      await this.release(p, c, moved.to);
      throw err;
    }

    // Enrichment runs after the version is committed and visible. A queue
    // hiccup must not fail an upload that is already safely stored.
    await this.enqueue('version.process', {
      household_id: p.householdId,
      version_id: version.id,
    }).catch(() => undefined);
    return { version, replayed: false };
  }

  /** Step 1 of accept(): the key is this try's, or it is answered or refused. */
  private async claim(
    p: Principal,
    target: UploadTarget,
    key: string,
  ): Promise<{ replay: VersionView } | Claim> {
    const nonce = randomUUID();
    // A stale try's temporary object, deleted once the takeover is committed.
    const leftovers: { key: string; vaultId: string }[] = [];
    const out = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      await lockKey(trx, p.householdId, key);
      // A document the caller cannot see is not there, whatever the key.
      const doc = target.kind === 'version' ? await this.fetch(trx, p, target.documentId) : null;
      const row = await trx
        .selectFrom('upload_idempotency')
        .selectAll()
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (row) {
        const same =
          row.account_id === p.accountId &&
          row.request_kind === target.kind &&
          (target.kind === 'capture' || row.document_id === target.documentId);
        if (!same) throw keyReused();
        if (row.state === 'done') {
          const visible = await this.fetch(trx, p, row.document_id as string).then(
            () => true,
            () => false,
          );
          if (!visible) throw keyReused();
          const v = await trx
            .selectFrom('document_version')
            .selectAll()
            .where('id', '=', row.version_id as string)
            .executeTakeFirstOrThrow();
          return { replay: versionView(v) };
        }
        if (Date.now() - row.claimed_at.getTime() < CLAIM_FRESH_MS) throw uploadInProgress();
        if (row.temp_key && row.temp_vault_id) {
          leftovers.push({ key: row.temp_key, vaultId: row.temp_vault_id });
        }
      }

      // What the bytes will be encrypted for.
      let documentId: string;
      let scope: ReturnType<typeof scopeFor>;
      let values: Record<string, never> = {};
      if (doc) {
        // A new copy replaces the document and settles its reminders, which
        // is changing it: a teen may do that to their own documents only.
        this.mustOwnIfTeen(p, doc);
        documentId = doc.id;
        scope = scopeFor(doc, p.householdId);
      } else {
        // The id is minted now, so the file key is wrapped for it.
        documentId = randomUUID();
        values = await this.captureColumns(
          trx,
          p,
          target.kind === 'capture' ? (target.metadata ?? {}) : {},
        );
        scope = scopeFor(
          {
            visibility: (values.visibility as Visibility | undefined) ?? 'household',
            owner_member_id: (values.owner_member_id as string | null | undefined) ?? null,
          },
          p.householdId,
        );
      }
      const active = await this.vaults.activeAdapter(trx, p.householdId);
      const scopeKey = await this.keys.unwrap(trx, scope);
      const fileKey = newKey();
      const tempKey = `${p.householdId}/${documentId}/incoming/${key.toLowerCase()}.${nonce}.enc`;
      const claimRow = {
        account_id: p.accountId,
        state: 'pending' as const,
        request_kind: target.kind,
        document_id: target.kind === 'version' ? documentId : null,
        version_id: null,
        claim_nonce: nonce,
        claimed_at: new Date(),
        temp_key: tempKey,
        temp_vault_id: active.vaultId,
      };
      // Taking over a stale claim: the nightly sweep may have deleted it
      // meanwhile, in which case it is simply made again.
      const taken = row
        ? await trx
            .updateTable('upload_idempotency')
            .set(claimRow)
            .where('idempotency_key', '=', key)
            .executeTakeFirst()
        : null;
      if (!taken || Number(taken.numUpdatedRows) === 0) {
        await trx
          .insertInto('upload_idempotency')
          .values({ idempotency_key: key, household_id: p.householdId, ...claimRow })
          .execute();
      }
      return {
        key,
        nonce,
        documentId,
        values,
        scope,
        vaultId: active.vaultId,
        adapter: active.adapter,
        scopeKeyId: scopeKey.id,
        fileKey,
        fileKeyWrapped: wrapKey(fileKey, scopeKey.key, `version:${documentId}`),
        tempKey,
      } satisfies Claim;
    });
    for (const l of leftovers) await this.dropObject(p.householdId, l).catch(() => undefined);
    return out;
  }

  /**
   * What a captured document starts as: the card's details, checked by the
   * rules the phone checks before it queues a scan (checkCaptureMetadata),
   * then as POST /documents checks them. Untitled when the card was
   * skipped; a teen's own. Runs inside the claim, so a refusal claims
   * nothing and the same key works again.
   */
  private async captureColumns(
    trx: Db,
    p: Principal,
    metadata: CaptureMetadata,
  ): Promise<Record<string, never>> {
    // Through the claim's own transaction: a second connection taken while
    // holding one could empty the pool under enough captures at once.
    const members = await trx.selectFrom('member').select('id').execute();
    const types = await trx
      .selectFrom('document_type')
      .select(['key', 'expiry_driver', 'default_visibility'])
      .execute();
    const problem = checkCaptureMetadata(metadata, {
      me: { member_id: p.memberId, role: p.role },
      members,
      types,
    });
    if (problem) {
      throw new ApiError(
        problem.status,
        problem.status === 403 ? 'forbidden' : 'validation_failed',
        problem.message,
        { detail: problem.field },
      );
    }
    const input: DocumentInput = { title: null, ...metadata };
    if (p.role === 'teen') input.owner_member_id = p.memberId;
    // Decided here, so the file is wrapped for exactly the people the
    // document will be for (never Adults only for a teen).
    input.visibility = effectiveVisibility(
      metadata,
      types.find((t) => t.key === metadata.type_key),
      p.role,
    );
    return this.columns(trx, p, input, null);
  }

  /**
   * A failed try: its temporary object, the object it may have moved into
   * place, and its claim — only while the claim is still this try's.
   */
  private async release(p: Principal, c: Claim, moved: string | null = null): Promise<void> {
    await c.adapter.delete(c.tempKey).catch(() => undefined);
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      // A commit whose answer was lost still holds this lock until it ends.
      await lockKey(trx, p.householdId, c.key);
      if (moved) {
        // Only if no version points at it: a commit that did happen, with
        // the answer lost on the way back, must keep its file.
        const used = await trx
          .selectFrom('document_version')
          .select('id')
          .where('storage_key', '=', moved)
          .executeTakeFirst();
        if (!used) await c.adapter.delete(moved).catch(() => undefined);
      }
      await trx
        .deleteFrom('upload_idempotency')
        .where('idempotency_key', '=', c.key)
        .where('state', '=', 'pending')
        .where('claim_nonce', '=', c.nonce)
        .execute();
    }).catch(() => undefined);
  }

  private async dropObject(householdId: string, at: { key: string; vaultId: string }) {
    const adapter = await withScope(this.db, { householdId }, (trx) =>
      this.vaults.adapterById(trx, at.vaultId),
    );
    await adapter.delete(at.key);
  }

  /**
   * GET /uploads/{key}: what became of one of the caller's own uploads.
   * Someone else's key, a key never seen, and a try that failed or died
   * all look the same: not found.
   */
  async uploadStatus(p: Principal, key: string): Promise<UploadStatus> {
    if (!UUID.test(key)) throw unknownUpload();
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .selectFrom('upload_idempotency')
        .select(['state', 'document_id', 'version_id', 'claimed_at'])
        .where('idempotency_key', '=', key)
        .where('account_id', '=', p.accountId)
        .executeTakeFirst();
      if (!row) throw unknownUpload();
      if (row.state === 'done' && row.document_id && row.version_id) {
        const visible = await this.fetch(trx, p, row.document_id).then(
          () => true,
          () => false,
        );
        if (!visible) throw unknownUpload();
        return { state: 'done', document_id: row.document_id, version_id: row.version_id };
      }
      if (row.state === 'pending' && Date.now() - row.claimed_at.getTime() < CLAIM_FRESH_MS) {
        return { state: 'in_progress', since: row.claimed_at.toISOString() };
      }
      throw unknownUpload();
    });
  }

  /**
   * FND-01: one query over titles, identifiers, tags, notes and the OCR text
   * of every version, ranked, with a highlighted snippet.
   *
   * Private documents' text is sealed and has no index, so it is not
   * searched here. `sealed_pending` says how many of the caller's own
   * documents were left unopened and hands out a token for the second
   * pass (FND-08); a client that ignores it still works.
   */
  async search(
    p: Principal,
    q: SearchQuery,
  ): Promise<{
    items: SearchHit[];
    sealed_pending: { count: number; token?: string };
  }> {
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const adultsOk = allows(p, 'document.see_adults');
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const rows = await sql<{
        document_id: string;
        title: string | null;
        type_key: string | null;
        category: string | null;
        owner_member_id: string | null;
        expires_on: string | null;
        expires_precision: DateValue['precision'] | null;
        issued_by: string | null;
        issued_on: string | null;
        issued_precision: DateValue['precision'] | null;
        rank: number;
        snippet: string;
        matched_in: 'title' | 'content';
      }>`
        with query as (select websearch_to_tsquery('simple', ${q.q}) as tsq),
        doc_hits as (
          select d.id, ts_rank(d.search_tsv, query.tsq) * 2 as rank,
                 ts_headline('simple',
                   coalesce(d.title, '') || ' ' || coalesce(d.issued_by, '') || ' ' ||
                   coalesce(d.identifier, '') || ' ' || coalesce(d.notes, ''),
                   query.tsq, 'MaxFragments=1, MaxWords=18, MinWords=6, StartSel=<em>, StopSel=</em>') as snippet,
                 'title'::text as matched_in
          from document d, query
          where d.deleted_at is null and d.search_tsv @@ query.tsq
        ),
        text_hits as (
          select t.document_id as id, max(ts_rank(t.tsv, query.tsq)) as rank,
                 (array_agg(ts_headline('simple', t.content, query.tsq,
                   'MaxFragments=1, MaxWords=18, MinWords=6, StartSel=<em>, StopSel=</em>')
                   order by t.created_at desc))[1] as snippet,
                 'content'::text as matched_in
          from document_text t, query
          where t.tsv @@ query.tsq
          group by t.document_id
        ),
        hits as (
          select id, max(rank) as rank,
                 (array_agg(snippet order by rank desc))[1] as snippet,
                 (array_agg(matched_in order by rank desc))[1] as matched_in
          from (select * from doc_hits union all select * from text_hits) u
          group by id
        )
        select d.id as document_id, d.title, d.type_key, d.category, d.owner_member_id,
               d.expires_on, d.expires_precision, d.issued_by, d.issued_on, d.issued_precision,
               h.rank, h.snippet, h.matched_in
        from hits h join document d on d.id = h.id
        where d.deleted_at is null
          and (d.visibility = 'household'
               or (d.visibility = 'adults' and ${adultsOk})
               or (d.visibility = 'private' and d.owner_member_id = ${p.memberId}::uuid))
          ${q.member_id ? sql`and d.owner_member_id = ${q.member_id}::uuid` : sql``}
          ${q.category ? sql`and d.category = ${q.category}` : sql``}
          ${q.issued_by ? sql`and lower(d.issued_by) = lower(${q.issued_by.trim()})` : sql``}
        order by h.rank desc, d.updated_at desc
        limit ${limit}`.execute(trx);

      const items: SearchHit[] = [];
      for (const r of rows.rows) {
        const type = r.type_key ? await this.typeCached(trx, r.type_key) : null;
        const expires = r.expires_on
          ? {
              date: isoDate(r.expires_on) as string,
              precision: r.expires_precision as DateValue['precision'],
            }
          : null;
        items.push({
          document_id: r.document_id,
          title: r.title,
          type_key: r.type_key,
          category: r.category,
          owner_member_id: r.owner_member_id,
          issued_by: r.issued_by,
          issued: r.issued_on
            ? {
                date: isoDate(r.issued_on) as string,
                precision: r.issued_precision as DateValue['precision'],
              }
            : null,
          status: deriveStatus(
            {
              type: type
                ? {
                    key: type.key,
                    expiry_driver: type.expiry_driver,
                    reminder_leads: type.reminder_leads,
                  }
                : null,
              owner_member_id: r.owner_member_id,
              expires,
            },
            today(),
          ),
          snippet: r.snippet,
          matched_in: r.matched_in,
          rank: Number(r.rank),
        });
      }
      // How much of the caller's own text this pass could not look inside.
      // Counted by document, not by version: it is documents the person
      // thinks in, and it is what the second pass will search.
      const sealed = await trx
        .selectFrom('document_text_sealed')
        .innerJoin('document', 'document.id', 'document_text_sealed.document_id')
        .select(sql<number>`count(distinct document.id)::int`.as('n'))
        .where('document.owner_member_id', '=', p.memberId)
        .where('document.visibility', '=', 'private')
        .where('document.deleted_at', 'is', null)
        .executeTakeFirst();
      const count = sealed?.n ?? 0;
      if (count === 0 || !this.sealedKey) return { items, sealed_pending: { count } };
      return {
        items,
        sealed_pending: {
          count,
          token: await signSealedToken(this.sealedKey, {
            sid: p.sessionId,
            hid: p.householdId,
            mid: p.memberId,
            q: q.q,
            member_id: q.member_id,
            category: q.category,
            issued_by: q.issued_by?.trim(),
            limit,
          }),
        },
      };
    });
  }

  /**
   * Which fresh credential, if any, opening this version asks for (SEC-17):
   * anything marked "only me" asks to open a document only you can see,
   * and an Essential asks to open an Essential (0.4.12). One small query,
   * so the answer costs a download nothing it would not have paid anyway.
   */
  async stepUpFor(p: Principal, versionId: string): Promise<SensitiveAction | null> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .selectFrom('document_version')
        .innerJoin('document', 'document.id', 'document_version.document_id')
        .select(['document.visibility', 'document.is_essential', 'document.owner_member_id'])
        .where('document_version.id', '=', versionId)
        .executeTakeFirst();
      // A missing version, and one the caller may not see, are both a 404
      // further down. Asking for a credential first would answer "it is
      // there, and it is private" to somebody who must not know.
      if (!row || !canSee({ role: p.role, memberId: p.memberId }, row)) return null;
      return sensitiveAction(row);
    });
  }

  /** The same question for a whole document: before a link to it is made. */
  async stepUpForDocument(p: Principal, documentId: string): Promise<SensitiveAction | null> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .selectFrom('document')
        .select(['visibility', 'is_essential', 'owner_member_id'])
        .where('id', '=', documentId)
        .executeTakeFirst();
      if (!row || !canSee({ role: p.role, memberId: p.memberId }, row)) return null;
      return sensitiveAction(row);
    });
  }

  /**
   * The cached, encrypted thumbnail, decrypted on the way out. Null until
   * the worker has run. `sensitive`: an Essential's or an "only me"
   * document's, which no cache may keep (0.4.12).
   */
  async thumbnail(
    p: Principal,
    versionId: string,
  ): Promise<{ bytes: Buffer; sensitive: boolean } | null> {
    const ctx = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirst();
      if (!v) throw notFound();
      const doc = await this.fetch(trx, p, v.document_id, true);
      if (!v.thumbnail_key) return null;
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      return {
        sensitive: sensitiveAction(doc) !== null,
        key: v.thumbnail_key,
        fileKey: unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`),
        adapter: await this.vaults.adapterById(trx, v.vault_id),
      };
    });
    if (!ctx) return null;
    const dec = new DecryptStream(ctx.fileKey);
    const [, plain] = await Promise.all([
      pipeline(await ctx.adapter.get(ctx.key), dec),
      readAll(dec),
    ]);
    return { bytes: plain, sensitive: ctx.sensitive };
  }

  /**
   * One page of a version, as the vault drew it (0.4.12): a JPEG,
   * decrypted on the way out, and audited as `document.viewed`.
   *
   * Visibility comes first, and a version the caller may not see is the
   * same 404 as one that does not exist; the route has asked for a fresh
   * credential, where one is due, before this is reached. Pages not drawn
   * yet are queued once and answered `preview_pending`; a file the vault
   * cannot draw, or a page past what it drew, is `no_preview`.
   */
  async page(p: Principal, versionId: string, page: number, meta: RequestMeta): Promise<Buffer> {
    const outcome = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirst();
      if (!v) throw notFound();
      await this.fetch(trx, p, v.document_id, true); // applies the visibility rule
      if (v.preview_state === 'unsupported') return { kind: 'none', why: 'kind' } as const;
      if (v.preview_state === 'failed') return { kind: 'none', why: 'failed' } as const;
      const known = v.preview_state === 'ready' ? v.preview_pages : v.page_count;
      if (page > PREVIEW_MAX_PAGES || (known !== null && page > known)) {
        return { kind: 'none', why: 'page' } as const;
      }
      if (v.preview_state !== 'ready') {
        // Queued once; queued again only if that job seems to have been lost.
        const lost =
          v.preview_state === 'queued' &&
          (!v.preview_requested_at ||
            Date.now() - new Date(v.preview_requested_at).getTime() > PREVIEW_REQUEUE_MS);
        if (v.preview_state === 'none' || lost) {
          await trx
            .updateTable('document_version')
            .set({ preview_state: 'queued', preview_requested_at: new Date() })
            .where('id', '=', v.id)
            .execute();
          return { kind: 'pending', queue: true } as const;
        }
        return { kind: 'pending', queue: false } as const;
      }
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
      const adapter = await this.vaults.adapterById(trx, v.vault_id);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.viewed',
        objectType: 'document',
        objectId: v.document_id,
        detail: { version_id: v.id, page },
        ip: meta.ip,
      });
      return { kind: 'ready', key: `${v.storage_key}.p${page}.enc`, fileKey, adapter } as const;
    });
    if (outcome.kind === 'pending') {
      if (outcome.queue) {
        // Somebody is waiting for this one: ahead of drawing done in advance.
        await this.enqueue(
          PREVIEWS_JOB,
          { household_id: p.householdId, version_id: versionId },
          { singletonKey: previewJobKey(versionId), priority: 10 },
        ).catch(() => undefined);
      }
      throw new ApiError(
        404,
        'preview_pending',
        'The preview is being made. Try again in a moment.',
        { retriable: true, retryAfter: 3 },
      );
    }
    if (outcome.kind === 'none') {
      throw new ApiError(
        404,
        'no_preview',
        outcome.why === 'kind'
          ? "There's no preview for this kind of file. You can save a copy to open it."
          : outcome.why === 'failed'
            ? "The vault couldn't draw this file's pages. You can save a copy to open it."
            : "There's no preview of this page. You can save a copy to open it.",
      );
    }
    const dec = new DecryptStream(outcome.fileKey);
    const [, plain] = await Promise.all([
      pipeline(await outcome.adapter.get(outcome.key), dec),
      readAll(dec),
    ]);
    return plain;
  }

  /** Version metadata for a principal allowed to see its document; no audit, no bytes. */
  async versionMeta(p: Principal, versionId: string): Promise<VersionView> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirst();
      if (!v) throw notFound();
      await this.fetch(trx, p, v.document_id, true);
      return versionView(v);
    });
  }

  /**
   * Streams plaintext. With a range, only the covering chunks are fetched
   * and decrypted. Every call is audited (SEC-05).
   */
  async content(
    p: Principal,
    versionId: string,
    range: { start: number; end: number } | null,
    meta: RequestMeta,
  ): Promise<{
    stream: Readable;
    version: VersionView;
    total: number;
    range: { start: number; end: number } | null;
  }> {
    const { version, adapter, fileKey } = await withScope(
      this.db,
      { householdId: p.householdId },
      async (trx) => {
        const v = await trx
          .selectFrom('document_version')
          .selectAll()
          .where('id', '=', versionId)
          .executeTakeFirst();
        if (!v) throw notFound();
        await this.fetch(trx, p, v.document_id, true); // applies the visibility rule
        const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
        const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
        const adapter = await this.vaults.adapterById(trx, v.vault_id);
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'document.downloaded',
          objectType: 'document',
          objectId: v.document_id,
          detail: { version_no: v.version_no, range: range ? `${range.start}-${range.end}` : null },
          ip: meta.ip,
        });
        return { version: v, adapter, fileKey };
      },
    );

    const total = Number(version.byte_size);
    if (range) {
      const end = Math.min(range.end, total - 1);
      if (range.start > end || range.start < 0) {
        throw new ApiError(416, 'range_not_satisfiable', 'That part of the file does not exist.');
      }
      const plain = await decryptRange(fileKey, total, { start: range.start, end }, async (s, e) =>
        readAll(await adapter.get(version.storage_key, { start: s, end: e })),
      );
      return {
        stream: Readable.from([plain]),
        version: versionView(version),
        total,
        range: { start: range.start, end },
      };
    }
    const cipher = await adapter.get(version.storage_key);
    const dec = new DecryptStream(fileKey);
    cipher.on('error', (e) => dec.destroy(e));
    return { stream: cipher.pipe(dec), version: versionView(version), total, range: null };
  }

  // ---------------------------------------------------------------- helpers

  private async columns(trx: Db, p: Principal, input: DocumentInput, current: DocRow | null) {
    const out: Record<string, unknown> = {};
    if (input.type_key !== undefined) {
      if (input.type_key === null) {
        out.type_key = null;
      } else {
        const t = await this.typeOrThrow(input.type_key, trx);
        out.type_key = t.key;
        if (input.category === undefined && !current?.category) out.category = t.category;
        if (input.visibility === undefined && !current) out.visibility = t.default_visibility;
        if (input.is_essential === undefined && !current && t.usually_essential)
          out.is_essential = true;
      }
    }
    if (input.title !== undefined) out.title = input.title?.trim() || null;
    if (input.category !== undefined) out.category = input.category;
    if (input.owner_member_id !== undefined) {
      if (current && input.owner_member_id !== current.owner_member_id) {
        await this.mayHandOver(trx, p, current);
      }
      if (input.owner_member_id !== null) {
        const m = await trx
          .selectFrom('member')
          .select('id')
          .where('id', '=', input.owner_member_id)
          .executeTakeFirst();
        if (!m) throw new ApiError(422, 'validation_failed', 'That person is not in the family.');
      }
      out.owner_member_id = input.owner_member_id;
    }
    if (input.visibility !== undefined) {
      if (current !== null) {
        throw new ApiError(
          500,
          'internal_error',
          'Visibility changes must go through the visibility service.',
        );
      }
      const owner = (out.owner_member_id ?? null) as string | null;
      if (input.visibility === 'private' && owner !== p.memberId) {
        throw new ApiError(
          422,
          'validation_failed',
          'Only the person a document belongs to can make it private to them.',
        );
      }
      out.visibility = input.visibility;
    }
    if (input.issued !== undefined) {
      out.issued_on = input.issued?.date ?? null;
      out.issued_precision = input.issued?.precision ?? null;
    }
    if (input.expires !== undefined) {
      out.expires_on = input.expires?.date ?? null;
      out.expires_precision = input.expires?.precision ?? null;
    }
    if (input.identifier !== undefined) out.identifier = input.identifier?.trim() || null;
    // As typed, spaces tidied: "Barclays", not "barclays" — it is shown.
    if (input.issued_by !== undefined) {
      out.issued_by = input.issued_by?.trim().replace(/\s+/g, ' ') || null;
    }
    if (input.physical_location !== undefined)
      out.physical_location = input.physical_location?.trim() || null;
    if (input.is_essential !== undefined) out.is_essential = input.is_essential;
    if (input.tags !== undefined) {
      out.tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(
        0,
        50,
      );
    }
    if (input.notes !== undefined) out.notes = input.notes?.trim() || null;
    if (input.extra !== undefined) out.extra = JSON.stringify(input.extra);
    return out as Partial<Record<keyof DocRow, unknown>> as Record<string, never>;
  }
}

function scopeFor(doc: Pick<DocRow, 'visibility' | 'owner_member_id'>, householdId: string) {
  switch (doc.visibility) {
    case 'household':
      return { householdId, kind: 'household' as const };
    case 'adults':
      return { householdId, kind: 'adults' as const };
    case 'private':
      return { householdId, kind: 'member' as const, memberId: doc.owner_member_id };
  }
}

function versionView(v: {
  id: string;
  document_id: string;
  version_no: number;
  filename: string;
  mime: string;
  byte_size: string | number;
  sha256: Buffer;
  page_count: number | null;
  ocr_status: string;
  uploaded_at: Date;
  preview_state: string;
  preview_pages: number | null;
}): VersionView {
  return {
    id: v.id,
    document_id: v.document_id,
    version_no: v.version_no,
    filename: v.filename,
    mime: v.mime,
    byte_size: Number(v.byte_size),
    sha256: v.sha256.toString('hex'),
    page_count: v.page_count,
    ocr_status: v.ocr_status,
    uploaded_at: v.uploaded_at.toISOString(),
    // Known once drawn, or known that it never will be; null until then.
    preview_pages:
      v.preview_state === 'ready' ||
      v.preview_state === 'unsupported' ||
      v.preview_state === 'failed'
        ? (v.preview_pages ?? 0)
        : null,
  };
}

/** The step-up opening a document asks for: "only me" first, then Essentials. */
export type SensitiveAction = 'open_private_document' | 'open_essential';
function sensitiveAction(d: { visibility: string; is_essential: boolean }): SensitiveAction | null {
  if (d.visibility === 'private') return 'open_private_document';
  return d.is_essential ? 'open_essential' : null;
}

/** The worker's job for page previews (its JOBS.renderPreviews), one per version at a time. */
const PREVIEWS_JOB = 'version.previews';
const previewJobKey = (versionId: string) => `previews:${versionId}`;
/**
 * A page asked for this long after its job was queued queues it again, in
 * case the job was lost. The queue drops the new one while the first is
 * still waiting or being drawn, so asking again never draws twice.
 */
const PREVIEW_REQUEUE_MS = 2 * 60 * 1000;

const encodeCursor = (c: { k: string; id: string }) =>
  Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string): { k: string; id: string } {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as { k: string; id: string };
    if (typeof c.k !== 'string' || typeof c.id !== 'string') throw new Error();
    return c;
  } catch {
    throw new ApiError(422, 'validation_failed', 'That page cursor is not valid.');
  }
}

/** CAP-03: the formats the vault accepts. Detected from the bytes, not the name. */
const ACCEPTED: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * A pass-through that inspects the first bytes as they flow and resolves
 * `detected` once it has seen enough (or the stream ended). It never stops
 * the flow: breaking out of an async iterator would destroy the upload.
 */
function sniffStream(declaredMime: string, filename: string) {
  const SNIFF_BYTES = 4100;
  let head: Buffer = Buffer.alloc(0);
  let settled = false;
  let resolve!: (v: { mime: string; ext: string }) => void;
  let reject!: (e: Error) => void;
  const detected = new Promise<{ mime: string; ext: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  detected.catch(() => undefined); // observed again by the caller

  const settle = async () => {
    if (settled) return;
    settled = true;
    const { fileTypeFromBuffer } = await import('file-type');
    const found = await fileTypeFromBuffer(head);
    // docx/xlsx sniff as zip; fall back to the declared type for those.
    const mime =
      found && found.mime !== 'application/zip'
        ? found.mime
        : declaredMime.split(';')[0]?.trim() || '';
    const ext = ACCEPTED[mime];
    if (!ext) {
      reject(
        new ApiError(
          415,
          'unsupported_type',
          'That kind of file cannot be stored here. PDFs, photos and scans are fine.',
          {
            detail: `detected ${found?.mime ?? 'unknown'}, declared ${declaredMime}, name ${filename}`,
          },
        ),
      );
      return;
    }
    resolve({ mime, ext });
  };

  const stream = new PassThrough({
    transform(chunk: Buffer, _enc, cb) {
      if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
      if (head.length >= SNIFF_BYTES) void settle();
      cb(null, chunk);
    },
    flush(cb) {
      void settle().then(() => cb(), cb);
    },
  });
  return { stream, detected };
}

async function moveObject(
  adapter: {
    kind: string;
    get: (k: string) => Promise<Readable>;
    put: (k: string, s: Readable) => Promise<unknown>;
    delete: (k: string) => Promise<void>;
  },
  from: string,
  to: string,
): Promise<string> {
  // Both adapters re-put and delete; the local adapter's put is a verified
  // copy, and S3 copies server-side in a later iteration. Cheap enough at
  // household scale, and it keeps the key layout honest.
  await adapter.put(to, await adapter.get(from));
  await adapter.delete(from);
  return to;
}

/** Upload keys are UUIDs, written the usual way: 8-4-4-4-12 hex digits. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A pending claim younger than this is a try that is still running. */
const CLAIM_FRESH_MS = 15 * 60_000;

/** One try at a time per key, in one household. */
const lockKey = (trx: Db, householdId: string, key: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`${householdId}:${key.toLowerCase()}`}, 0))`.execute(
    trx,
  );

// None of these says what a key made: it may be somebody else's upload.
const keyReused = () =>
  new ApiError(
    409,
    'idempotency_key_reused',
    'That upload key was already used for something else.',
  );

const uploadInProgress = () =>
  new ApiError(
    409,
    'upload_in_progress',
    'This upload is already on its way. Trying again in a moment.',
    {
      retriable: true,
      retryAfter: 5,
    },
  );

const unknownUpload = () => new ApiError(404, 'not_found', 'That upload is not known here.');

const tooLarge = () => new ApiError(413, 'too_large', 'That file is too big for this vault.');

const storageUnreachable = (detail: string) =>
  new ApiError(
    503,
    'storage_unreachable',
    "We can't reach where your files are kept. Your file was not saved; try again.",
    { detail, retriable: true, retryAfter: 30 },
  );
