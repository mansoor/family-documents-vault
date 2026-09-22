import { createHash } from 'node:crypto';
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
import { objectKey, readAll } from '@fdv/storage';
import { sql, type Expression, type SqlBool } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import type { ReminderService } from '../reminders/service.js';
import { signSealedToken } from './sealed-token.js';

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
  physical_location?: string | null | undefined;
  is_essential?: boolean | undefined;
  tags?: string[] | undefined;
  notes?: string | null | undefined;
  extra?: Record<string, unknown> | undefined;
}

export interface ListQuery {
  member_id?: string | undefined;
  category?: string | undefined;
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

export function etagOf(id: string, updatedAt: Date): string {
  return `"${createHash('sha256').update(`${id}:${updatedAt.toISOString()}`).digest('hex').slice(0, 16)}"`;
}

/** How the API hands work to the worker. The server wires pg-boss; tests collect. */
export type Enqueue = (name: string, data: Record<string, unknown>) => Promise<void>;

export interface SearchQuery {
  q: string;
  member_id?: string | undefined;
  category?: string | undefined;
  limit?: number | undefined;
}

export interface SearchHit {
  document_id: string;
  title: string | null;
  type_key: string | null;
  category: string | null;
  owner_member_id: string | null;
  status: DocumentView['status'];
  snippet: string;
  matched_in: 'title' | 'content';
  rank: number;
}

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
    }));
  }

  private async typeOrThrow(key: string) {
    const t = await this.db
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
      if (p.role === 'owner' || p.role === 'adult') {
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

  private canWrite(p: Principal): void {
    if (p.role === 'viewer') {
      throw new ApiError(403, 'forbidden', 'Viewers can look at documents but not change them.');
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
      const values = await this.columns(trx, p, input, null);
      const row = await trx
        .insertInto('document')
        .values({
          household_id: p.householdId,
          created_by: p.accountId,
          updated_by: p.accountId,
          ...values,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.reminders?.regenerateDerived(trx, p.householdId, row.id);
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
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
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
      if (p.role === 'teen' && current.owner_member_id !== p.memberId) {
        throw new ApiError(403, 'forbidden', 'You can only change your own documents.');
      }
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
      return this.view(trx, row);
    });
  }

  /** ORG-08: soft delete, recoverable for 30 days. */
  async softDelete(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    this.canWrite(p);
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      await this.fetch(trx, p, id);
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
          ${q ? sql`and t ilike ${`${q}%`}` : sql``}
        group by t order by count desc, t limit 50`.execute(trx);
      return r.rows;
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
   * Adds a version: sniffs the type, encrypts under a fresh file key
   * wrapped by the document's scope key, stores, records. Idempotent on
   * the key: a retried upload returns the version it already created.
   */
  async upload(
    p: Principal,
    documentId: string,
    input: UploadInput,
    meta: RequestMeta,
  ): Promise<VersionView> {
    this.canWrite(p);
    if (!/^[0-9a-f-]{36}$/i.test(input.idempotencyKey)) {
      throw new ApiError(422, 'validation_failed', 'Idempotency-Key must be a UUID.');
    }

    // Fast path: already done.
    const existing = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .selectFrom('upload_idempotency')
        .select('version_id')
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst(),
    );
    if (existing?.version_id) {
      const v = await withScope(this.db, { householdId: p.householdId }, (trx) =>
        trx
          .selectFrom('document_version')
          .selectAll()
          .where('id', '=', existing.version_id as string)
          .executeTakeFirstOrThrow(),
      );
      return versionView(v);
    }

    // The real type is detected from the bytes as they flow (CAP-03).
    const sniffer = sniffStream(input.mime, input.filename);

    // Encrypt while streaming into the vault. The plaintext hash is computed
    // on the way in; the adapter verifies the ciphertext on the way out.
    const doc = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      this.fetch(trx, p, documentId),
    );
    const scopeRef = scopeFor(doc, p.householdId);
    const { vaultId, adapter, scopeKeyId, fileKeyWrapped, fileKey } = await withScope(
      this.db,
      { householdId: p.householdId },
      async (trx) => {
        const active = await this.vaults.activeAdapter(trx, p.householdId);
        const scope = await this.keys.unwrap(trx, scopeRef);
        const fileKey = newKey();
        return {
          ...active,
          scopeKeyId: scope.id,
          fileKey,
          fileKeyWrapped: wrapKey(fileKey, scope.key, `version:${documentId}`),
        };
      },
    );

    const plainHash = createHash('sha256');
    let plainBytes = 0;
    const counted = new PassThrough();
    counted.on('data', (c: Buffer) => {
      plainHash.update(c);
      plainBytes += c.length;
      if (plainBytes > this.maxUploadBytes)
        counted.destroy(new ApiError(413, 'too_large', 'That file is too big for this vault.'));
    });
    const enc = new EncryptStream(fileKey);
    const tmpKey = `${p.householdId}/${documentId}/incoming/${input.idempotencyKey}.enc`;

    let put;
    let mime: string;
    let ext: string;
    try {
      const [p1, , d] = await Promise.all([
        adapter.put(tmpKey, enc),
        pipeline(input.stream, sniffer.stream, counted, enc),
        sniffer.detected,
      ]);
      put = p1;
      ({ mime, ext } = d);
    } catch (err) {
      await adapter.delete(tmpKey).catch(() => undefined);
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        503,
        'storage_unreachable',
        "We can't reach where your files are kept. Your file was not saved; try again.",
        {
          detail: (err as Error).message,
          retriable: true,
        },
      );
    }
    const sha256 = plainHash.digest();

    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const last = await trx
        .selectFrom('document_version')
        .select(sql<number>`coalesce(max(version_no), 0)`.as('n'))
        .where('document_id', '=', documentId)
        .executeTakeFirstOrThrow();
      const versionNo = Number(last.n) + 1;
      const finalKey = objectKey({
        householdId: p.householdId,
        documentId,
        versionNo,
        sha256: sha256.toString('hex'),
        ext,
      });
      // Move into the boring layout. Local: rename is cheap; S3: copy would
      // be needed — put wrote under the temp key, so re-put is avoided by
      // keeping the temp key as the storage key when a move is unsupported.
      const storageKey = await moveObject(adapter, tmpKey, finalKey);

      const version = await trx
        .insertInto('document_version')
        .values({
          household_id: p.householdId,
          document_id: documentId,
          version_no: versionNo,
          filename: input.filename,
          mime,
          byte_size: plainBytes,
          sha256,
          cipher_bytes: put.bytes,
          cipher_sha256: Buffer.from(put.sha256, 'hex'),
          storage_key: storageKey,
          vault_id: vaultId,
          file_key_wrapped: fileKeyWrapped,
          wrapped_by_scope: scopeKeyId,
          uploaded_by: p.accountId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('upload_idempotency')
        .values({
          idempotency_key: input.idempotencyKey,
          household_id: p.householdId,
          document_id: documentId,
          version_id: version.id,
        })
        .execute();
      await trx
        .updateTable('document')
        .set({ updated_at: new Date(), updated_by: p.accountId })
        .where('id', '=', documentId)
        .execute();
      // REM-08: the user renewed and scanned it; do not also ask them to
      // dismiss a notification.
      if (versionNo > 1)
        await this.reminders?.resolveOpen(trx, p.householdId, documentId, p.accountId);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.version_added',
        objectType: 'document',
        objectId: documentId,
        detail: { version_no: versionNo, mime, bytes: plainBytes },
        ip: meta.ip,
      });
      return versionView(version);
    }).then(async (v) => {
      // Enrichment runs after the version is committed and visible. A queue
      // hiccup must not fail an upload that is already safely stored.
      await this.enqueue('version.process', {
        household_id: p.householdId,
        version_id: v.id,
      }).catch(() => undefined);
      return v;
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
    const adultsOk = p.role === 'owner' || p.role === 'adult';
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const rows = await sql<{
        document_id: string;
        title: string | null;
        type_key: string | null;
        category: string | null;
        owner_member_id: string | null;
        expires_on: string | null;
        expires_precision: DateValue['precision'] | null;
        rank: number;
        snippet: string;
        matched_in: 'title' | 'content';
      }>`
        with query as (select websearch_to_tsquery('simple', ${q.q}) as tsq),
        doc_hits as (
          select d.id, ts_rank(d.search_tsv, query.tsq) * 2 as rank,
                 ts_headline('simple',
                   coalesce(d.title, '') || ' ' || coalesce(d.identifier, '') || ' ' || coalesce(d.notes, ''),
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
               d.expires_on, d.expires_precision, h.rank, h.snippet, h.matched_in
        from hits h join document d on d.id = h.id
        where d.deleted_at is null
          and (d.visibility = 'household'
               or (d.visibility = 'adults' and ${adultsOk})
               or (d.visibility = 'private' and d.owner_member_id = ${p.memberId}::uuid))
          ${q.member_id ? sql`and d.owner_member_id = ${q.member_id}::uuid` : sql``}
          ${q.category ? sql`and d.category = ${q.category}` : sql``}
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
            limit,
          }),
        },
      };
    });
  }

  /** The cached, encrypted thumbnail, decrypted on the way out. Null until the worker has run. */
  async thumbnail(p: Principal, versionId: string): Promise<Buffer | null> {
    const ctx = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirst();
      if (!v) throw notFound();
      await this.fetch(trx, p, v.document_id, true);
      if (!v.thumbnail_key) return null;
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      return {
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
        const t = await this.typeOrThrow(input.type_key);
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

function scopeFor(doc: DocRow, householdId: string) {
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
  };
}

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
