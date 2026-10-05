import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import { createHarness, type Harness } from './test-harness.js';

/**
 * What a restriction costs a restricted viewer's list (the 5.32 review,
 * P532-02). The database works the grant out once a statement; a list that
 * asked for each document's versions one statement at a time worked it out
 * once a row, and a grant found by judging every document of the household
 * cost as much as the household, not the grant. At about 2,000 documents a
 * restricted viewer's page of 50 is to cost no more than three times an
 * unrestricted viewer's.
 */
const N = 2000;

describe.skipIf(!testAdminUrl())("a restricted viewer's list, at 2,000 documents", () => {
  let h: Harness;
  let owner: Tokens;
  let ahmed: Tokens;
  let val: Tokens;
  let uma: Tokens;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-perf@example.test', role: 'adult' });
    val = await h.join(owner, { name: 'Val', email: 'val-perf@example.test', role: 'viewer' });
    uma = await h.join(owner, { name: 'Uma', email: 'uma-perf@example.test', role: 'viewer' });
    const hh = owner.household_id;
    const admin = createPool(h.adminUrl, 1);
    try {
      // The household's documents: a third each the owner's, Ahmed's and
      // nobody's, of five kinds, each with a version of its file.
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
      await admin.query(
        `insert into document (household_id, title, owner_member_id, type_key, visibility, updated_at)
         select $1, 'Perf ' || g, (array[$2, $3, null]::uuid[])[1 + g % 3],
                (array['tax_return', 'utility_bill', 'passport', 'insurance_policy', 'warranty'])[1 + g % 5],
                'household', now() - (g || ' minutes')::interval
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
      await admin.query('analyze document; analyze document_version');
    } finally {
      await admin.end();
    }
  }, 180_000);
  afterAll(() => h?.close());

  it('costs a restricted viewer no more than three times an unrestricted one', async () => {
    const page = async (who: Tokens) => {
      const t0 = performance.now();
      const r = await h.app.inject({ url: '/api/v1/documents?limit=50', headers: h.as(who) });
      const ms = performance.now() - t0;
      expect(r.statusCode, r.body).toBe(200);
      return { ms, n: r.json<{ items: unknown[] }>().items.length };
    };
    // Warmed up, then asked in turn, so that both meet the same load.
    await page(val);
    await page(uma);
    const vals: number[] = [];
    const umas: number[] = [];
    for (let i = 0; i < 9; i++) {
      const v = await page(val);
      const u = await page(uma);
      expect(v.n).toBe(50);
      expect(u.n).toBe(50);
      vals.push(v.ms);
      umas.push(u.ms);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const restricted = median(vals);
    const unrestricted = median(umas);
    console.log(
      `documents ${N}, list of 50: restricted ${restricted.toFixed(1)} ms, unrestricted ${unrestricted.toFixed(1)} ms`,
    );
    expect(restricted).toBeLessThanOrEqual(3 * unrestricted);
  }, 120_000);
});
