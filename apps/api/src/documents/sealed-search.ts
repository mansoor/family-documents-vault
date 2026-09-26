import type { ScopeKeys } from '@fdv/crypto';
import { openSealedText } from './sealed-text.js';
import { withPrincipal, type Db } from '@fdv/db';
import { matchText, parseQuery, type DateValue } from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { statusOf, type SearchHit } from './service.js';
import { verifySealedToken } from './sealed-token.js';

/**
 * The second pass of search (FND-08, decision 2).
 *
 * A private document's text is sealed under its owner's member key and
 * never enters the search index — that is what makes "Only me" more than
 * a flag. So the only way to search it is to open it, one document at a
 * time, inside the owner's own session, and that is what this does.
 *
 * It is deliberately the slow path: it decrypts, it does not rank well,
 * and it is capped. It runs only when the caller asks for it with the
 * token the first pass handed out, so a client that ignores the token
 * still works — it just searches less.
 */

/** Enough for any household; a bound is what keeps this from being a lever. */
const MAX_DOCUMENTS = 500;

interface SealedRow {
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
  identifier: string | null;
  physical_location: string | null;
  tags: string[];
  notes: string | null;
  extra: Record<string, unknown> | null;
  content_cipher: Buffer;
  wrapped_by_scope: string;
  updated_at: Date;
}

export class SealedSearchService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly tokenKey: Uint8Array,
  ) {}

  async search(p: Principal, token: string): Promise<{ items: SearchHit[]; searched: number }> {
    const claims = await verifySealedToken(this.tokenKey, token);
    if (claims.sid !== p.sessionId || claims.hid !== p.householdId || claims.mid !== p.memberId) {
      // Someone else's search, or this session's own from before it signed
      // out. Either way there is nothing here for this caller.
      throw new ApiError(403, 'not_your_search', 'That search belongs to a different sign-in.');
    }
    const query = parseQuery(claims.q);
    if (query.groups.length === 0) return { items: [], searched: 0 };

    return withPrincipal(this.db, p, async (trx) => {
      const rows = await sql<SealedRow>`
        select distinct on (d.id)
               d.id as document_id, d.title, d.type_key, d.category, d.owner_member_id,
               d.expires_on, d.expires_precision, d.updated_at,
               d.issued_by, d.issued_on, d.issued_precision,
               d.identifier, d.physical_location, d.tags, d.notes, d.extra,
               s.content_cipher, v.wrapped_by_scope
          from document_text_sealed s
          join document d on d.id = s.document_id
          join document_version v on v.id = s.version_id
         where d.deleted_at is null
           and d.visibility = 'private'
           and d.owner_member_id = ${p.memberId}::uuid
           ${claims.member_id ? sql`and d.owner_member_id = ${claims.member_id}::uuid` : sql``}
           ${claims.category ? sql`and d.category = ${claims.category}` : sql``}
           ${claims.issued_by ? sql`and lower(d.issued_by) = lower(${claims.issued_by})` : sql``}
           -- Anything the first pass already returned on its title, number,
           -- tags or notes is not repeated here.
           and not (d.search_tsv @@ websearch_to_tsquery('simple', ${claims.q}))
         order by d.id, s.created_at desc
         limit ${MAX_DOCUMENTS}`.execute(trx);

      const scopeKeys = new Map<string, Buffer>();
      const types = new Map<string, Parameters<typeof statusOf>[0] & object>();
      const scored: Array<{ hit: SearchHit; hits: number; updated: number }> = [];

      for (const row of rows.rows) {
        let key = scopeKeys.get(row.wrapped_by_scope);
        if (!key) {
          key = await this.keys.unwrapById(trx, row.wrapped_by_scope);
          scopeKeys.set(row.wrapped_by_scope, key);
        }
        const content = openSealedText(key, row.content_cipher);
        if (content === null) continue; // a blob we cannot open is not a match
        const m = matchText(content, query);
        if (!m) continue;

        if (row.type_key && !types.has(row.type_key)) {
          const t = await trx
            .selectFrom('effective_document_type')
            .select(['key', 'expiry_driver', 'reminder_leads', 'core', 'fields'])
            .where('key', '=', row.type_key)
            .executeTakeFirst();
          if (t) types.set(row.type_key, t);
        }
        const type = row.type_key ? types.get(row.type_key) : undefined;
        const expires = row.expires_on
          ? { date: row.expires_on, precision: row.expires_precision ?? 'day' }
          : null;
        const issued = row.issued_on
          ? { date: String(row.issued_on).slice(0, 10), precision: row.issued_precision ?? 'day' }
          : null;
        scored.push({
          hits: m.hits,
          updated: new Date(row.updated_at).getTime(),
          hit: {
            document_id: row.document_id,
            title: row.title,
            type_key: row.type_key,
            category: row.category,
            owner_member_id: row.owner_member_id,
            issued_by: row.issued_by,
            issued,
            status: statusOf(type, { ...row, issued, expires }),
            snippet: m.snippet,
            matched_in: 'content',
            // Ranks here are not comparable with PostgreSQL's, and saying
            // so beats pretending: the client keeps these in their own
            // group, below the indexed results.
            rank: 0,
          },
        });
      }

      // Most mentions first, then most recently touched — the same shape
      // of order as the indexed pass, so the two halves read alike.
      scored.sort((a, b) => b.hits - a.hits || b.updated - a.updated);
      return {
        items: scored.slice(0, claims.limit).map((s) => s.hit),
        searched: rows.rows.length,
      };
    });
  }
}
