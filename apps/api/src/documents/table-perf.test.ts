import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentPage } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * What the Documents table (R2) costs at about 2,000 documents: an owner's
 * page of 50, and a restricted viewer's, for each way of sorting, a page
 * further on, and the sorts and filters that work every row's status out.
 * The database sorts the household's documents by the indexes it has on
 * the household; a page is one statement for its rows, one for the count,
 * and the list's usual few for what a page shows.
 *
 * FDV_TABLE_PERF_N asks it of more (5,000 for the R2 report).
 */
const N = Number(process.env.FDV_TABLE_PERF_N ?? 2000);

/** Generous: a page that took this long has gone badly wrong, not slow. */
const CEILING_MS = 1500;

describe.skipIf(!testAdminUrl())(`the Documents table at ${N} documents`, () => {
  let h: Harness;
  let owner: Tokens;
  let ahmed: Tokens;
  let val: Tokens;
  let wes: Tokens;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    ahmed = await h.join(owner, {
      name: 'Ahmed',
      email: 'ahmed-tperf@example.test',
      role: 'adult',
    });
    val = await h.join(owner, { name: 'Val', email: 'val-tperf@example.test', role: 'viewer' });
    wes = await h.join(owner, { name: 'Wes', email: 'wes-tperf@example.test', role: 'viewer' });
    const hh = owner.household_id;
    const admin = createPool(h.adminUrl, 1);
    try {
      const scope = await withSystem(h.db, hh, (trx) =>
        trx
          .selectFrom('scope_key')
          .select('id')
          .where('kind', '=', 'household')
          .executeTakeFirstOrThrow(),
      );
      const vault = await withSystem(h.db, hh, (trx) =>
        trx.selectFrom('vault').select('id').executeTakeFirstOrThrow(),
      );
      // A third each the owner's, Ahmed's and nobody's, of five kinds, with
      // dates spread over years, some to expire soon, some places, some tags.
      await admin.query(
        `insert into document (household_id, title, owner_member_id, type_key, visibility,
                               issued_on, issued_precision, expires_on, expires_precision,
                               physical_location, tags, notes, updated_at)
         select $1, 'Perf ' || g, (array[$2, $3, null]::uuid[])[1 + g % 3],
                (array['tax_return', 'utility_bill', 'passport', 'insurance_policy', 'warranty'])[1 + g % 5],
                'household',
                date '2010-01-01' + (g * 3), 'day'::date_precision,
                case when g % 4 = 0 then null else current_date + ((g % 900) - 100) end,
                case when g % 4 = 0 then null else 'day'::date_precision end,
                case when g % 6 = 0 then null else (array['Fire safe', 'Loft', 'Desk'])[1 + g % 3] end,
                array[(array['tax', 'house', 'car'])[1 + g % 3]],
                -- A note of about 4 KB on each: what a status pass must not read.
                repeat('A note about this document, written at some length. ', 75),
                now() - (g || ' minutes')::interval
           from generate_series(1, $4) g`,
        [hh, owner.member_id, ahmed.member_id, N],
      );
      await admin.query(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         select household_id, id, 1, 'scan.pdf', 'application/pdf', 10, '\\x00'::bytea,
                10, '\\x00'::bytea, 'perf/' || id, $2, '\\x00'::bytea, $3
           from document where household_id = $1`,
        [hh, vault.id, scope.id],
      );
      // Ten collections for Everyone, each with a tenth of the documents.
      await admin.query(
        `insert into doc_collection (household_id, name, audience, owner_member_id)
         select $1, 'Collection ' || c, 'everyone', $2 from generate_series(1, 10) c`,
        [hh, owner.member_id],
      );
      await admin.query(
        `insert into doc_collection_item (household_id, collection_id, document_id, position)
         select d.household_id, l.id, d.id, d.n::int
           from (select id, household_id, row_number() over (order by id) as n
                   from document where household_id = $1) d
           join (select id, row_number() over (order by name) as n
                   from doc_collection where household_id = $1) l on l.n = 1 + d.n % 10
          where d.n % 2 = 0`,
        [hh],
      );
      // Val: Ahmed's tax returns.
      await admin.query(
        `insert into access_restriction (member_id, household_id, limits_people, limits_types)
         values ($1, $2, true, true)`,
        [val.member_id, hh],
      );
      await admin.query(
        `insert into access_restriction_member (restricted_member_id, household_id, member_id)
         values ($1, $2, $3)`,
        [val.member_id, hh, ahmed.member_id],
      );
      await admin.query(
        `insert into access_restriction_type (restricted_member_id, household_id, type_key)
         values ($1, $2, 'tax_return')`,
        [val.member_id, hh],
      );
      // Wes: the owner's and Ahmed's documents, of every kind — two thirds
      // of the household, judged by the restriction's rules row by row.
      await admin.query(
        `insert into access_restriction (member_id, household_id, limits_people, limits_types)
         values ($1, $2, true, false)`,
        [wes.member_id, hh],
      );
      for (const person of [owner.member_id, ahmed.member_id]) {
        await admin.query(
          `insert into access_restriction_member (restricted_member_id, household_id, member_id)
           values ($1, $2, $3)`,
          [wes.member_id, hh, person],
        );
      }
      await admin.query(
        'analyze document; analyze document_version; analyze doc_collection; analyze doc_collection_item',
      );
    } finally {
      await admin.end();
    }
  }, 300_000);
  afterAll(() => h?.close());

  it('answers an owner and a restricted viewer a page of 50, however it is sorted', async () => {
    const ask = async (who: Tokens, query: string) => {
      const t0 = performance.now();
      const r = await h.app.inject({ url: `/api/v1/documents?${query}`, headers: h.as(who) });
      const ms = performance.now() - t0;
      expect(r.statusCode, r.body).toBe(200);
      return { ms, page: r.json<DocumentPage>() };
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const timed = async (who: Tokens, query: string) => {
      await ask(who, query);
      const times: number[] = [];
      let page: DocumentPage | null = null;
      for (let i = 0; i < 7; i++) {
        const r = await ask(who, query);
        times.push(r.ms);
        page = r.page;
      }
      return { ms: median(times), page: page as DocumentPage };
    };
    const queries = [
      // The list as older clients ask it, for comparison: no count, no collections.
      'sort=recent&limit=50',
      'sort=title&limit=50',
      'sort=title&direction=desc&limit=50',
      'sort=kind&limit=50',
      'sort=person&limit=50',
      'sort=issued&limit=50',
      'sort=expires&limit=50',
      'sort=visibility&limit=50',
      'sort=collections&limit=50',
      'sort=status&limit=50',
      'sort=title&status=expiring_soon&limit=50',
      'sort=title&tag=car&collection_id=none&limit=50',
    ];
    const lines: string[] = [];
    for (const query of queries) {
      const o = await timed(owner, query);
      const v = await timed(val, query);
      const w = await timed(wes, query);
      expect(o.page.items.length).toBeGreaterThan(0);
      // Wes is given the owner's and Ahmed's.
      for (const d of w.page.items) expect(d.owner_member_id).not.toBeNull();
      // Val is given Ahmed's tax returns: a fifth of his third.
      for (const d of v.page.items) {
        expect(d.owner_member_id).toBe(ahmed.member_id);
        expect(d.type_key).toBe('tax_return');
      }
      // A page further on costs what the first does.
      const further = o.page.next_cursor
        ? await timed(owner, `${query}&cursor=${encodeURIComponent(o.page.next_cursor)}`)
        : null;
      lines.push(
        `${query.padEnd(48)} owner ${o.ms.toFixed(1).padStart(6)} ms (total ${o.page.total ?? '-'}), ` +
          `next page ${further ? further.ms.toFixed(1).padStart(6) : '     -'} ms; ` +
          `restricted narrowly ${v.ms.toFixed(1).padStart(6)} ms (total ${v.page.total ?? '-'}); ` +
          `broadly ${w.ms.toFixed(1).padStart(6)} ms (total ${w.page.total ?? '-'})`,
      );
      expect(o.ms).toBeLessThan(CEILING_MS);
      expect(v.ms).toBeLessThan(CEILING_MS);
      expect(w.ms).toBeLessThan(CEILING_MS);
      if (further) expect(further.ms).toBeLessThan(CEILING_MS);
    }
    console.log(`documents ${N}, a page of 50:\n${lines.join('\n')}`);
  }, 300_000);
});
