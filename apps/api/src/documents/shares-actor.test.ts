import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import argon2 from 'argon2';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedShare } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * A share link asks as itself (5.5, 5.6).
 *
 * The one step taken as the vault is finding which share a token names.
 * Everything after it — the preview, a wrong PIN counted, the right one, the
 * file — asks as that link and no other, so 0030's rule for a link is what
 * stands between a share route and every other document in the household.
 * Each step is listened to as the database is told it, the way the worker's
 * actor.test.ts listens to its jobs.
 */
describe.skipIf(!testAdminUrl())('a share link asks as itself', () => {
  let h: Harness;
  let owner: Tokens;
  let lease: string;

  /** Every scope the API opens: its household, its actor and its share. */
  const said: Array<{ household: unknown; actor: unknown; share: unknown }> = [];

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.9.${Math.floor(++nth / 200)}.${nth % 200}` });

  beforeAll(async () => {
    h = await createHarness({
      log(event) {
        if (event.level !== 'query' || !event.query.sql.includes("set_config('app.actor'")) return;
        // In the order withScope says them: household, actor, account,
        // member, role, share, upload request.
        const [household, actor, , , , share] = event.query.parameters;
        said.push({ household, actor, share });
      },
    });
    owner = await h.setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Flat 3 tenancy agreement', type_key: 'utility_bill' },
    });
    lease = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
  }, 90_000);
  afterAll(() => h.close());

  type Step = [string, () => Promise<LightMyRequestResponse>, number];

  /**
   * Runs each step, listening to what the database is told: `lookups` scopes
   * as the vault first (finding the share by its token's hash), then the
   * link, and only this link, in this household.
   */
  const run = async (steps: Step[], shareId: string, lookups: (name: string) => number) => {
    for (const [name, step, status] of steps) {
      said.length = 0;
      const res = await step();
      expect(res.statusCode, name).toBe(status);
      if (/file/.test(name)) expect(res.rawPayload.equals(PDF), name).toBe(true);

      const vault = said.slice(0, lookups(name));
      const after = said.slice(lookups(name));
      for (const lookup of vault) {
        expect(lookup, name).toEqual({ household: owner.household_id, actor: 'system', share: '' });
      }
      expect(after.length, name).toBeGreaterThan(0);
      expect(
        after.filter(
          (s) => s.actor !== 'link' || s.share !== shareId || s.household !== owner.household_id,
        ),
        name,
      ).toEqual([]);
    }
  };

  const counts = (id: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('share_link')
        .select(['attempts', 'open_count'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );

  it('one lookup as the vault, then only the link, at every step', async () => {
    const made = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${lease}/share`,
        headers: h.as(owner),
        payload: { with_pin: true },
      })
    ).json<CreatedShare>();
    const token = made.link_token;
    const pin = made.pin as string;
    const wrong = pin === '0000' ? '1111' : '0000';
    let cookie = '';
    const unlock = (secret: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/unlock',
        payload: { token, secret },
        ...peer(),
      });

    await run(
      [
        [
          'the preview',
          () =>
            h.app.inject({
              method: 'POST',
              url: '/api/v1/shared/preview',
              payload: { token },
              ...peer(),
            }),
          200,
        ],
        ['a wrong PIN', () => unlock(wrong), 401],
        [
          'the right PIN',
          async () => {
            const res = await unlock(pin);
            cookie = res.cookies.find((c) => c.name === 'fdv_share')?.value ?? '';
            return res;
          },
          200,
        ],
        [
          'what is open',
          () =>
            h.app.inject({
              url: '/api/v1/shared/items',
              cookies: { fdv_share: cookie },
              ...peer(),
            }),
          200,
        ],
        [
          'the file',
          () =>
            h.app.inject({
              url: `/api/v1/shared/items/${lease}/content`,
              cookies: { fdv_share: cookie },
              ...peer(),
            }),
          200,
        ],
      ],
      made.share.id,
      // Inside a session there is no lookup as the vault at all: the
      // cookie's own lookup is a function with the owner's rights (0037).
      (name) => (name === 'what is open' || name === 'the file' ? 0 : 1),
    );

    // Asking as the link, the wrong PIN was still counted on its own row,
    // and the right one counted as one open.
    expect(await counts(made.share.id)).toEqual({ attempts: 1, open_count: 1 });
  });

  it('a link made before 5.16 asks as itself on the old routes too', async () => {
    const token = randomBytes(32).toString('base64url');
    const me = (await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) })).json<{
      account_id: string;
    }>();
    const pinHash = await argon2.hash('2468', { type: argon2.argon2id });
    const { id } = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('share_link')
        .values({
          household_id: owner.household_id,
          document_id: lease,
          token_hash: createHash('sha256').update(token, 'utf8').digest(),
          pin_hash: pinHash,
          created_by: me.account_id,
          expires_at: new Date(Date.now() + 864e5),
          flow: 'legacy',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const open = (pin: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/shared/${token}/open`,
        payload: { pin },
        ...peer(),
      });

    await run(
      [
        ['the preview', () => h.app.inject({ url: `/api/v1/shared/${token}`, ...peer() }), 200],
        ['a wrong PIN', () => open('1357'), 401],
        ['the right PIN', () => open('2468'), 200],
        [
          'the file',
          () => h.app.inject({ url: `/api/v1/shared/${token}/content?pin=2468`, ...peer() }),
          200,
        ],
      ],
      id,
      () => 1,
    );
    expect(await counts(id)).toEqual({ attempts: 1, open_count: 1 });
  });
});
