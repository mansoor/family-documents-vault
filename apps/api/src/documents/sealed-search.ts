import { openPrivate, type PrivateValues, type ScopeKeys } from '@fdv/crypto';
import { openSealedText } from './sealed-text.js';
import { withPrincipal, type Db } from '@fdv/db';
import { matchText, parseQuery, type DateValue } from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { HAS_PRIVATE_WORDS, sealedOf, statusOf, type SearchHit } from './service.js';
import { verifySealedToken } from './sealed-token.js';

/**
 * The second pass of search (FND-08, decision 2).
 *
 * A private document's text is sealed under its owner's member key and
 * never enters the search index — that is what makes "Only me" more than
 * a flag. Since 0.5.8 its notes and its type's details are sealed the same
 * way. So the only way to search them is to open them, one document at a
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
  notes_sealed: Buffer | null;
  extra_sealed: Buffer | null;
  sealed_details: string[];
  /** Its newest pages' text, sealed; null when there is none. */
  content_cipher: Buffer | null;
  wrapped_by_scope: string | null;
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
        select d.id as document_id, d.title, d.type_key, d.category, d.owner_member_id,
               d.expires_on, d.expires_precision, d.updated_at,
               d.issued_by, d.issued_on, d.issued_precision,
               d.identifier, d.physical_location, d.tags, d.notes, d.extra,
               d.notes_sealed, d.extra_sealed, d.sealed_details,
               t.content_cipher, t.wrapped_by_scope
          from document d
          left join lateral (
                 select s.content_cipher, v.wrapped_by_scope
                   from document_text_sealed s
                   join document_version v on v.id = s.version_id
                  where s.document_id = d.id
                  order by s.created_at desc
                  limit 1) t on true
         where d.deleted_at is null
           and d.visibility = 'private'
           and d.owner_member_id = ${p.memberId}::uuid
           and (${sql.raw(HAS_PRIVATE_WORDS)})
           ${claims.member_id ? sql`and d.owner_member_id = ${claims.member_id}::uuid` : sql``}
           ${claims.category ? sql`and d.category = ${claims.category}` : sql``}
           ${claims.issued_by ? sql`and lower(d.issued_by) = lower(${claims.issued_by})` : sql``}
           -- Anything the first pass already returned on its title, number,
           -- tags or issuer is not repeated here.
           and not (d.search_tsv @@ websearch_to_tsquery('simple', ${claims.q}))
         order by d.id
         limit ${MAX_DOCUMENTS}`.execute(trx);

      const scopeKeys = new Map<string, Buffer>();
      const scopeKey = async (id: string) => {
        let key = scopeKeys.get(id);
        if (!key) {
          key = await this.keys.unwrapById(trx, id);
          scopeKeys.set(id, key);
        }
        return key;
      };
      // The notes and details are sealed under the owner's own key: only
      // this caller's documents are here, so it is theirs.
      let memberKey: Buffer | null = null;
      const types = new Map<string, Parameters<typeof statusOf>[0] & object>();
      const scored: Array<{ hit: SearchHit; hits: number; updated: number }> = [];

      for (const row of rows.rows) {
        let values: PrivateValues = { notes: row.notes, extra: row.extra ?? {} };
        if (row.notes_sealed || row.extra_sealed) {
          memberKey ??= (
            await this.keys.unwrap(trx, {
              householdId: p.householdId,
              kind: 'member',
              memberId: p.memberId,
            })
          ).key;
          try {
            const sealed = openPrivate(memberKey, row.document_id, row);
            values = {
              notes: values.notes ?? sealed.notes,
              extra: { ...sealed.extra, ...values.extra },
            };
          } catch {
            // What cannot be opened is not a match, as with the pages.
          }
        }
        const content =
          row.content_cipher && row.wrapped_by_scope
            ? openSealedText(await scopeKey(row.wrapped_by_scope), row.content_cipher)
            : null;
        // The document's own words, as the index would have had them, then
        // its pages': a search may name one of each ("car JM1BK32F").
        const own = ownWords(row, values);
        const m = matchText([own, content ?? ''].join('\n'), query);
        if (!m) continue;
        const inOwn = matchText(own, query);
        const inContent = content ? matchText(content, query) : null;

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
            status: statusOf(type, { ...row, issued, expires }, sealedOf(row)),
            snippet: (inOwn ?? inContent ?? m).snippet,
            // Its notes or details, as the first pass says of a document's
            // own words; else its pages.
            matched_in: inOwn ? 'title' : 'content',
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

/**
 * A document's own words, in the order the first pass shows them: title,
 * issuer, number, details, notes, tags, where the original is kept. The
 * details as fdv_details_text (0032) indexes a visible document's: each
 * text, choice and number, and a date's date — not its precision.
 */
function ownWords(row: SealedRow, values: PrivateValues): string {
  const details = Object.values(values.extra).flatMap((v) => {
    if (typeof v === 'string' || typeof v === 'number') return [String(v)];
    const date = v && typeof v === 'object' ? (v as { date?: unknown }).date : undefined;
    return typeof date === 'string' ? [date] : [];
  });
  return [
    row.title,
    row.issued_by,
    row.identifier,
    details.join(' '),
    values.notes,
    row.tags.join(' '),
    row.physical_location,
  ]
    .filter((s) => s)
    .join('\n');
}
