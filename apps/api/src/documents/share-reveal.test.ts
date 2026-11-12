import { randomUUID } from 'node:crypto';
import { deriveKey, openShareLinkCopy, SHARE_LINK_COPY_PURPOSE } from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { CollectionDetail, DocumentView, RevealedShare } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import type { CreatedShare, ShareView } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PUBLIC_URL = 'https://share.example.test';
const COPY_KEY = deriveKey(TEST_MASTER, SHARE_LINK_COPY_PURPOSE);

/**
 * A share link shown again, to whoever made it (0.9.0; the owner's decision
 * of 11 Nov 2026).
 *
 * The vault keeps a sealed copy of each link as it is made — the link, and
 * the PIN or the password it made up — and shows it to the account that
 * made it, after confirming it's them, while it still works or is only
 * paused. What matters is what none of it can be made to do: show anybody
 * else's link (an owner's included), show one without a credential seen
 * lately, show one that has ended, keep a copy in the clear, or open one
 * moved onto another link's row.
 */
describe.skipIf(!testAdminUrl())('a share link shown again to whoever made it (0.9.0)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let adult: Tokens;
  let ownerAccount: string;
  let adultAccount: string;
  let lease: string;
  let broker: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string; action?: string } }>(r).error;

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.84.${Math.floor(++nth / 200)}.${nth % 200}` });

  const accountOf = async (t: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(t) }))
      .account_id;

  /** Whether `account` confirmed it's them a moment ago, or ten minutes ago. */
  const confirmed = (account: string, yes: boolean) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)) })
        .where('account_id', '=', account)
        .execute(),
    );

  const make = async (title: string) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title, type_key: 'utility_bill', visibility: 'household' },
    });
    const id = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    return id;
  };

  const share = async (who: Tokens, body: Record<string, unknown> = {}) => {
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/share`,
      headers: h.as(who),
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  const shareCollection = async (body: Record<string, unknown>) => {
    await confirmed(ownerAccount, true);
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/shares`,
      headers: h.as(owner),
      payload: { document_ids: [lease], ...body },
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  const reveal = (who: Tokens, id: string) =>
    h.app.inject({ method: 'POST', url: `/api/v1/shares/${id}/reveal`, headers: h.as(who) });
  const listed = async (who: Tokens) =>
    json<{ items: ShareView[] }>(await h.app.inject({ url: '/api/v1/shares', headers: h.as(who) }))
      .items;
  const sealedOf = async (id: string) =>
    (
      await admin.query<{ c: Buffer | null }>(
        'select link_copy_sealed as c from share_link where id = $1',
        [id],
      )
    ).rows[0]?.c ?? null;

  beforeAll(async () => {
    h = await createHarness({ publicUrl: PUBLIC_URL });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    ownerAccount = await accountOf(owner);
    adultAccount = await accountOf(adult);
    lease = await make('Flat 3 tenancy agreement');
    const c = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'For the broker', audience: 'everyone' },
    });
    broker = json<CollectionDetail>(c).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/items`,
      headers: h.as(owner),
      payload: { document_ids: [lease] },
    });
  }, 90_000);
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  it('keeps a sealed copy of a document’s link and a collection’s, bound to its own row', async () => {
    const doc = await share(owner, { with_pin: true });
    const col = await shareCollection({ with_password: true });
    for (const [made, secret] of [
      [doc, { pin: doc.pin }],
      [col, { password: col.password }],
    ] as const) {
      const sealed = (await sealedOf(made.share.id)) as Buffer;
      expect(sealed).toBeInstanceOf(Buffer);
      // Never in the clear: not the link, nor its PIN or password.
      for (const plain of [made.link_token, made.pin, made.password]) {
        if (plain) expect(sealed.includes(Buffer.from(plain))).toBe(false);
      }
      expect(openShareLinkCopy(COPY_KEY, sealed, owner.household_id, made.share.id)).toEqual({
        token: made.link_token,
        ...secret,
      });
      // Moved onto another link's row, or under another key, it opens nothing.
      expect(() => openShareLinkCopy(COPY_KEY, sealed, owner.household_id, randomUUID())).toThrow();
      expect(() =>
        openShareLinkCopy(
          deriveKey(`${TEST_MASTER}-other`, SHARE_LINK_COPY_PURPOSE),
          sealed,
          owner.household_id,
          made.share.id,
        ),
      ).toThrow();
    }
    // A password the sharer typed is theirs: never kept.
    const typed = await share(owner, { password: 'one I typed myself' });
    expect(
      openShareLinkCopy(
        COPY_KEY,
        (await sealedOf(typed.share.id)) as Buffer,
        owner.household_id,
        typed.share.id,
      ),
    ).toEqual({ token: typed.link_token });
    // Nobody in the household puts a copy on a link afterwards, or changes one.
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ link_copy_sealed: Buffer.alloc(64) } as never)
          .where('id', '=', doc.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/keeps the copy it was made with/);
  });

  it('shows its maker the same link, which opens, and its PIN — only after confirming it’s them', async () => {
    const made = await share(owner, { with_pin: true });
    expect(made.share.revealable).toBe(true);

    await confirmed(ownerAccount, false);
    const asked = await reveal(owner, made.share.id);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'reveal_share' });
    expect(errorOf(asked).message).toContain('to see a link you made again');

    await confirmed(ownerAccount, true);
    const shown = await reveal(owner, made.share.id);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(json<RevealedShare>(shown)).toEqual({
      link_token: made.link_token,
      link_url: `${PUBLIC_URL}/s#${made.link_token}`,
      pin: made.pin,
    });
    expect(made.link_url).toBe(`${PUBLIC_URL}/s#${made.link_token}`);

    // What it shows opens the link, as the one handed over did.
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: json<RevealedShare>(shown).link_token, secret: made.pin },
      ...peer(),
    });
    expect(opened.statusCode, opened.body).toBe(200);

    // Written down, about the document, with the link's id and never the link.
    const lines = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['object_type', 'object_id', 'detail', 'actor_account_id'])
        .where('action', '=', 'share.revealed')
        .execute(),
    );
    const line = lines.find(
      (l) => (l.detail as { share_id?: string } | null)?.share_id === made.share.id,
    );
    expect(line).toMatchObject({
      object_type: 'document',
      object_id: lease,
      actor_account_id: ownerAccount,
      detail: { share_id: made.share.id },
    });
    expect(JSON.stringify(lines)).not.toContain(made.link_token);
    expect(JSON.stringify(lines)).not.toContain(`"${made.pin}"`);
  });

  it('shows a collection’s link and the password the vault made up', async () => {
    const made = await shareCollection({ with_password: true });
    await confirmed(ownerAccount, true);
    const shown = await reveal(owner, made.share.id);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(json<RevealedShare>(shown)).toEqual({
      link_token: made.link_token,
      link_url: made.link_url,
      password: made.password,
    });
  });

  it('never shows anybody else’s link, an owner’s included, nor says one is there', async () => {
    const hers = await share(adult, { with_pin: true });
    const his = await share(owner);
    await confirmed(ownerAccount, true);
    await confirmed(adultAccount, true);
    for (const [who, id] of [
      [owner, hers.share.id],
      [adult, his.share.id],
      [owner, randomUUID()],
    ] as const) {
      const r = await reveal(who, id);
      expect(r.statusCode, r.body).toBe(404);
      expect(errorOf(r).code).toBe('not_found');
    }
    // The list says which are the reader's to see again.
    const forOwner = await listed(owner);
    expect(forOwner.find((s) => s.id === hers.share.id)?.revealable).toBe(false);
    expect(forOwner.find((s) => s.id === his.share.id)?.revealable).toBe(true);
    const forHer = await listed(adult);
    expect(forHer.find((s) => s.id === hers.share.id)?.revealable).toBe(true);
    expect(forHer.find((s) => s.id === his.share.id)?.revealable).toBe(false);
    // Asked about one not theirs, nobody is asked to confirm it's them first.
    await confirmed(ownerAccount, false);
    expect(errorOf(await reveal(owner, hers.share.id)).code).toBe('not_found');
  });

  it('a link made before copies were kept stays shown once', async () => {
    const made = await share(owner, { with_pin: true });
    // As a link made before 0084 is: no copy.
    await admin.query('update share_link set link_copy_sealed = null where id = $1', [
      made.share.id,
    ]);
    expect((await listed(owner)).find((s) => s.id === made.share.id)?.revealable).toBe(false);
    await confirmed(ownerAccount, false);
    const r = await reveal(owner, made.share.id);
    expect(r.statusCode, r.body).toBe(409);
    expect(errorOf(r).code).toBe('share_not_revealable');
  });

  it('a paused link is still shown; one taken back, run out of time or locked is not, and forgets its copy when taken back', async () => {
    await confirmed(ownerAccount, true);
    const paused = await share(owner);
    await admin.query(
      `update share_link set paused_at = now(), paused_reason = 'restored' where id = $1`,
      [paused.share.id],
    );
    expect((await listed(owner)).find((s) => s.id === paused.share.id)).toMatchObject({
      state: 'paused',
      revealable: true,
    });
    expect((await reveal(owner, paused.share.id)).statusCode).toBe(200);

    const used = await share(owner, { max_opens: 1 });
    await admin.query('update share_link set open_count = 1 where id = $1', [used.share.id]);
    expect((await listed(owner)).find((s) => s.id === used.share.id)?.state).toBe('used_up');
    expect((await reveal(owner, used.share.id)).statusCode).toBe(200);

    const taken = await share(owner);
    const back = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${taken.share.id}`,
      headers: h.as(owner),
    });
    expect(back.statusCode).toBe(204);
    expect(await sealedOf(taken.share.id)).toBeNull();

    const ran = await share(owner);
    await admin.query(
      `update share_link set expires_at = now() - interval '1 minute' where id = $1`,
      [ran.share.id],
    );
    const locked = await share(owner, { with_pin: true });
    await admin.query('update share_link set attempts = 10 where id = $1', [locked.share.id]);

    for (const ended of [taken, ran, locked]) {
      expect((await listed(owner)).find((s) => s.id === ended.share.id)?.revealable).toBe(false);
      const r = await reveal(owner, ended.share.id);
      expect(r.statusCode, r.body).toBe(410);
      expect(errorOf(r).code).toBe('share_ended');
    }
  });

  it('says so in the capabilities', async () => {
    const caps = json<{ features: Record<string, boolean> }>(
      await h.app.inject({ url: '/api/v1/capabilities' }),
    );
    expect(caps.features.share_reveal).toBe(true);
  });
});
