import { randomUUID } from 'node:crypto';
import { createPool, withPrincipal, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { CollectionDetail, DocumentView, ShareEmailed } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import type { MailRequest } from '../mail-job.js';
import { createHarness, mailSent, type Harness } from '../test-harness.js';
import type { CreatedShare, ShareView } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PUBLIC_URL = 'https://share.example.test';
const TITLE = 'Flat 3 tenancy agreement';
const COLLECTION = 'For the broker';

/**
 * A share link emailed to its recipient by the vault (0.9.0; the owner's
 * decision of 13 Nov 2026), through the operator's mail server alone (A21).
 *
 * What matters is what the email never carries — what the link is to, its
 * PIN, its password, a code — that a code still goes in an email of its own
 * when the link is opened, that only the link's maker sends it, that the
 * vault keeps and shows the address masked alone, and that there is none
 * without the operator's mail server.
 */
describe.skipIf(!testAdminUrl())('a share link emailed to its recipient (0.9.0)', () => {
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
  const peer = () => ({ remoteAddress: `10.94.${Math.floor(++nth / 200)}.${nth % 200}` });
  /** An address of its own for each test, so the counts and mails of one are not another's. */
  const address = () => `jane.${randomUUID().slice(0, 8)}@example.com`;

  const accountOf = async (t: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(t) }))
      .account_id;

  const confirmed = (account: string, yes: boolean) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)) })
        .where('account_id', '=', account)
        .execute(),
    );

  const make = async (who: Tokens, title: string) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(who),
      payload: { title, type_key: 'utility_bill', visibility: 'household' },
    });
    const id = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
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
  const email = (who: Tokens, id: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/shares/${id}/email`,
      headers: h.as(who),
      payload,
      ...peer(),
    });
  const listed = async (who: Tokens) =>
    json<{ items: ShareView[] }>(await h.app.inject({ url: '/api/v1/shares', headers: h.as(who) }))
      .items;
  /** Made `minutes` ago, as far as the vault can tell. */
  const madeAgo = (id: string, minutes: number) =>
    admin.query(
      `update share_link set created_at = now() - make_interval(mins => $2) where id = $1`,
      [id, minutes],
    );
  const mailsTo = (to: string): MailRequest[] => mailSent(h).filter((m) => m.to === to);
  /** Everything an email says, subject and words, with the link's own id-like parts kept. */
  const whole = (m: MailRequest | undefined) => `${m?.subject ?? ''}\n${m?.text ?? ''}`;

  beforeAll(async () => {
    h = await createHarness({ publicUrl: PUBLIC_URL });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    ownerAccount = await accountOf(owner);
    adultAccount = await accountOf(adult);
    lease = await make(owner, TITLE);
    const c = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: COLLECTION, audience: 'everyone' },
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

  it('is offered when the operator’s mail server is set, on the maker’s own links', async () => {
    const caps = json<{ features: { share_link_email?: boolean } }>(
      await h.app.inject({ url: '/api/v1/capabilities' }),
    );
    expect(caps.features.share_link_email).toBe(true);
    const made = await share(owner, { with_pin: true });
    expect(made.share.emailable).toBe(true);
    expect(made.share.emailed_to).toBeNull();
    // Somebody else's link is not theirs to email.
    const theirs = (await listed(adult)).find((s) => s.id === made.share.id);
    expect(theirs?.emailable).toBe(false);
  });

  it('emails the link alone: never the title, the PIN, the password or a code, and the code goes on its own', async () => {
    const to = address();
    const codeTo = address();
    const made = await share(owner, { with_pin: true, code_email: codeTo });
    const r = await email(owner, made.share.id, { to, message: '  The lease,\nas promised.  ' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const sent = json<ShareEmailed>(r);
    expect(sent.sent_to).toBe('j•••@e•••.com');
    expect(sent.sends_left).toBe(2);
    expect(Date.now() - Date.parse(sent.sent_at)).toBeLessThan(60_000);

    const mails = mailsTo(to);
    expect(mails).toHaveLength(1);
    const words = whole(mails[0]);
    const link = `${PUBLIC_URL}/s#${made.link_token}`;
    expect(words).toContain(link);
    expect(words).toContain('The Test family');
    expect(words).toContain('Owner');
    expect(words).toContain('a document');
    expect(words).toContain(
      'If it asks for a PIN or password, the person who sent it will give it to you separately.',
    );
    expect(words).toContain('  The lease,\n  as promised.');
    expect(words).toMatch(/The link stops working on \w+day \d+ \w+ at \d\d:\d\d\./);
    expect(words).toContain('You are getting this because');
    // Its code, said plainly: to the address its sender chose, on its own.
    expect(words).toContain(
      'If it asks for a code, one is emailed on its own to the address the person who sent it chose, when the link is opened.',
    );
    // Never what it is to, nor its PIN, nor the other address.
    expect(words).not.toContain(TITLE);
    expect(words).not.toContain('tenancy');
    expect(words).not.toContain(codeTo);
    // Only the one link: the vault's own, and nothing else that is one.
    expect(words.match(/https?:\/\//g)).toHaveLength(1);
    // Its PIN is four digits; with the link and the dates taken out, none
    // are left in it (a UUID-free, link-free copy is what is searched).
    const bare = words.replace(link, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '');
    expect(bare).not.toContain(made.pin as string);
    expect(bare).not.toMatch(/\b\d{3} ?\d{3}\b/);

    // Opened, its code goes in an email of its own, to its own address.
    const before = mailSent(h).length;
    const code = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/code',
      payload: { token: made.link_token },
      ...peer(),
    });
    expect(code.statusCode, code.body).toBe(200);
    const after = mailSent(h).slice(before);
    expect(after.map((m) => m.to)).toEqual([codeTo]);
    expect(after[0]?.text).toMatch(/Your code is \d{3} \d{3}/);
    expect(after[0]?.text).not.toContain(made.link_token);
    // And the link's email went to its address alone, once.
    expect(mailsTo(to)).toHaveLength(1);
  });

  it('a collection’s link says “a collection”, never its name, nor the password the vault made up', async () => {
    const to = address();
    const made = await shareCollection({ with_password: true });
    const r = await email(owner, made.share.id, { to });
    expect(r.statusCode, r.body).toBe(200);
    const words = whole(mailsTo(to)[0]);
    expect(words).toContain(`${PUBLIC_URL}/s#${made.link_token}`);
    expect(words).toContain('a collection of documents');
    expect(words).not.toContain(COLLECTION);
    expect(words).not.toContain('broker');
    expect(words).not.toContain(TITLE);
    expect(words).not.toContain(made.password as string);
    expect(words.toLowerCase()).not.toContain((made.password as string).replace(/-/g, ''));
  });

  it('refuses an address that is not one, and a message with a web address, sending nothing', async () => {
    const made = await share(owner);
    const before = mailSent(h).length;
    for (const to of ['not an address', 'jane@', '@example.com', 'jane@example', '']) {
      const r = await email(owner, made.share.id, { to });
      expect(r.statusCode, to).toBe(422);
    }
    expect((await email(owner, made.share.id, {})).statusCode).toBe(422);
    const spam = await email(owner, made.share.id, {
      to: address(),
      message: 'Log in at https://evil.example to see it',
    });
    expect(spam.statusCode, spam.body).toBe(422);
    expect(errorOf(spam).message).toMatch(/web addresses/);
    const long = await email(owner, made.share.id, { to: address(), message: 'x'.repeat(301) });
    expect(long.statusCode).toBe(422);
    expect(mailSent(h).length).toBe(before);
  });

  it('only the link’s maker emails it: not another adult, not an owner, as made or later', async () => {
    const mine = await share(owner);
    const theirs = await share(adult);
    const before = mailSent(h).length;
    for (const [who, id] of [
      [adult, mine.share.id],
      [owner, theirs.share.id],
    ] as const) {
      const r = await email(who, id, { to: address() });
      expect(r.statusCode, r.body).toBe(404);
      // Later, after confirming it's them, still not theirs.
      await madeAgo(id, 30);
      await confirmed(who === adult ? adultAccount : ownerAccount, true);
      const later = await email(who, id, { to: address() });
      expect(later.statusCode, later.body).toBe(404);
    }
    expect((await email(owner, randomUUID(), { to: address() })).statusCode).toBe(404);
    expect(mailSent(h).length).toBe(before);
    // Sharing lists the maker's own as theirs to email, and nobody else's.
    expect((await listed(owner)).find((s) => s.id === theirs.share.id)?.emailable).toBe(false);
    expect((await listed(adult)).find((s) => s.id === theirs.share.id)?.emailable).toBe(true);

    // The database holds it too, as the vault's limited role: nobody writes
    // a line for a link they did not make, and nobody reads another's.
    const as = (who: Tokens, account: string, role: string) => ({
      accountId: account,
      householdId: who.household_id,
      memberId: who.member_id,
      role,
    });
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
    const line = (by: string, shareId: string) => ({
      household_id: owner.household_id,
      share_id: shareId,
      sent_by: by,
      to_masked: 'j•••@e•••.com',
    });
    expect(
      await refusal(
        withPrincipal(h.db, as(adult, adultAccount, 'adult') as never, (trx) =>
          trx.insertInto('share_link_email').values(line(adultAccount, mine.share.id)).execute(),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await refusal(
        withPrincipal(h.db, as(owner, ownerAccount, 'owner') as never, (trx) =>
          trx.insertInto('share_link_email').values(line(adultAccount, theirs.share.id)).execute(),
        ),
      ),
    ).toMatch(/row-level security/);
    // Their own, as themselves: allowed; then the owner reads none of it,
    // and nobody changes it.
    expect(
      await refusal(
        withPrincipal(h.db, as(adult, adultAccount, 'adult') as never, (trx) =>
          trx.insertInto('share_link_email').values(line(adultAccount, theirs.share.id)).execute(),
        ),
      ),
    ).toBeNull();
    const seenByOwner = await withPrincipal(
      h.db,
      as(owner, ownerAccount, 'owner') as never,
      (trx) =>
        trx
          .selectFrom('share_link_email')
          .select('id')
          .where('share_id', '=', theirs.share.id)
          .execute(),
    );
    expect(seenByOwner).toEqual([]);
    const changed = await withPrincipal(h.db, as(adult, adultAccount, 'adult') as never, (trx) =>
      trx
        .updateTable('share_link_email')
        .set({ to_masked: 'x•••@y•••.com' })
        .where('share_id', '=', theirs.share.id)
        .executeTakeFirst(),
    );
    expect(Number(changed.numUpdatedRows)).toBe(0);
  });

  it('within 15 minutes asks what making it asked; later, that it’s them (email_share)', async () => {
    const made = await share(owner);
    await confirmed(ownerAccount, false);
    expect((await email(owner, made.share.id, { to: address() })).statusCode).toBe(200);
    await madeAgo(made.share.id, 20);
    const asked = await email(owner, made.share.id, { to: address() });
    expect(asked.statusCode, asked.body).toBe(403);
    expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'email_share' });
    expect(errorOf(asked).message).toContain('to email a link you made');
    await confirmed(ownerAccount, true);
    expect((await email(owner, made.share.id, { to: address() })).statusCode).toBe(200);
    // A collection's, as made: what making it asked, always (5.19).
    const col = await shareCollection({});
    await confirmed(ownerAccount, false);
    const colAsked = await email(owner, col.share.id, { to: address() });
    expect(colAsked.statusCode, colAsked.body).toBe(403);
    expect(errorOf(colAsked)).toMatchObject({ action: 'share_collection' });
  });

  it('sends a link 3 times a day, and an account 20 links a day, then says when to try again', async () => {
    const made = await share(owner);
    for (const left of [2, 1, 0]) {
      const r = await email(owner, made.share.id, { to: address() });
      expect(r.statusCode, r.body).toBe(200);
      expect(json<ShareEmailed>(r).sends_left).toBe(left);
    }
    const before = mailSent(h).length;
    const fourth = await email(owner, made.share.id, { to: address() });
    expect(fourth.statusCode, fourth.body).toBe(429);
    expect(errorOf(fourth).code).toBe('email_link_limit');
    const wait = Number(fourth.headers['retry-after']);
    expect(wait).toBeGreaterThan(23 * 3600);
    expect(wait).toBeLessThanOrEqual(24 * 3600);
    expect(mailSent(h).length).toBe(before);
    // A day on, it may be sent again.
    await admin.query(
      `update share_link_email set sent_at = sent_at - interval '25 hours' where share_id = $1`,
      [made.share.id],
    );
    expect((await email(owner, made.share.id, { to: address() })).statusCode).toBe(200);

    // The account's: 20 in a day across its links, whichever.
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from share_link_email
        where sent_by = $1 and sent_at > now() - interval '1 day'`,
      [ownerAccount],
    );
    const other = await share(owner);
    const fill = 20 - (rows[0]?.n ?? 0);
    for (let i = 0; i < fill; i++) {
      await admin.query(
        `insert into share_link_email (household_id, share_id, sent_by, to_masked, sent_at)
         values ($1, $2, $3, 'j•••@e•••.com', now() - interval '1 hour')`,
        [owner.household_id, (await share(owner)).share.id, ownerAccount],
      );
    }
    const past = await email(owner, other.share.id, { to: address() });
    expect(past.statusCode, past.body).toBe(429);
    expect(errorOf(past).message).toMatch(/20 links today/);
    await admin.query(`delete from share_link_email where sent_by = $1`, [ownerAccount]);
  });

  it('keeps and shows the address masked alone: in Sharing, the activity log and the database', async () => {
    const to = address();
    const made = await share(owner);
    expect((await email(owner, made.share.id, { to, message: 'Hello' })).statusCode).toBe(200);
    const view = (await listed(owner)).find((s) => s.id === made.share.id);
    expect(view?.emailed_to).toBe('j•••@e•••.com');
    // Another adult who sees the link sees nothing of where it went.
    expect((await listed(adult)).find((s) => s.id === made.share.id)?.emailed_to).toBeNull();
    const line = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'object_type', 'object_id', 'detail'])
        .where('action', '=', 'share_link.emailed')
        .where(sql<boolean>`detail->>'share_id' = ${made.share.id}`)
        .executeTakeFirstOrThrow(),
    );
    expect(line).toMatchObject({
      object_type: 'document',
      object_id: lease,
      detail: { share_id: made.share.id, to: 'j•••@e•••.com', with_message: true },
    });
    const kept = await admin.query(`select * from share_link_email where share_id = $1`, [
      made.share.id,
    ]);
    expect(kept.rows).toHaveLength(1);
    const everything = JSON.stringify([kept.rows, line]);
    expect(everything).not.toContain(to);
    expect(everything).not.toContain(to.split('@')[0] as string);
    expect(everything).not.toContain('Hello');
    // Nothing of the address but its mask: no hash of it, no column for one.
    expect(Object.keys(kept.rows[0] as object).sort()).toEqual([
      'flow',
      'household_id',
      'id',
      'sent_at',
      'sent_by',
      'share_id',
      'to_masked',
      'with_message',
    ]);
    // And the activity log gives it to the family, masked.
    const activity = await h.app.inject({ url: '/api/v1/audit', headers: h.as(adult) });
    expect(activity.statusCode).toBe(200);
    const said = json<{ items: { text: string; kind: string }[] }>(activity).items.find((i) =>
      i.text.includes('emailed the link'),
    );
    expect(said).toMatchObject({
      text: `Owner emailed the link to “${TITLE}” to j•••@e•••.com`,
      kind: 'shared',
    });
    expect(activity.body).not.toContain(to);
  });

  it('checks the address and the message before asking who it is (the review)', async () => {
    const made = await share(owner);
    await madeAgo(made.share.id, 30);
    await confirmed(ownerAccount, false);
    const bad = await email(owner, made.share.id, { to: address(), message: 'see bit.ly/3xYz' });
    expect(bad.statusCode, bad.body).toBe(422);
    expect((await email(owner, made.share.id, { to: 'jane@' })).statusCode).toBe(422);
    // A good one, then, asks.
    expect((await email(owner, made.share.id, { to: address() })).statusCode).toBe(403);
  });

  it('an address with a long ending is masked short enough to keep (the review)', async () => {
    const made = await share(owner);
    const to = `jane@example.${'a'.repeat(40)}`;
    const r = await email(owner, made.share.id, { to });
    expect(r.statusCode, r.body).toBe(200);
    expect(json<ShareEmailed>(r).sent_to).toBe(`j•••@e•••.${'a'.repeat(10)}…`);
    expect(mailsTo(to)).toHaveLength(1);
  });

  it('a paused link is not emailed: it would not open for them (the review)', async () => {
    const made = await share(owner);
    await admin.query(
      `update share_link set paused_at = now(), paused_reason = 'restored' where id = $1`,
      [made.share.id],
    );
    expect((await listed(owner)).find((s) => s.id === made.share.id)?.emailable).toBe(false);
    const r = await email(owner, made.share.id, { to: address() });
    expect(r.statusCode, r.body).toBe(409);
    expect(errorOf(r).code).toBe('share_paused');
    expect(errorOf(r).message).toMatch(/paused/);
  });

  it('a link removed for good leaves its emails counted for the day (the review)', async () => {
    const made = await share(owner);
    expect((await email(owner, made.share.id, { to: address() })).statusCode).toBe(200);
    // As a purge removes a link: its row goes; its email stays, with no link.
    await admin.query('delete from share_link where id = $1', [made.share.id]);
    const left = await admin.query<{ share_id: string | null; sent_by: string }>(
      `select share_id, sent_by from share_link_email where sent_by = $1 and share_id is null`,
      [ownerAccount],
    );
    expect(left.rows).toEqual([{ share_id: null, sent_by: ownerAccount }]);
    // Nobody signed in writes a row with no link.
    const asOwner = {
      accountId: ownerAccount,
      householdId: owner.household_id,
      memberId: owner.member_id,
      role: 'owner',
    };
    await expect(
      withPrincipal(h.db, asOwner as never, (trx) =>
        trx
          .insertInto('share_link_email')
          .values({
            household_id: owner.household_id,
            share_id: null,
            sent_by: ownerAccount,
            to_masked: 'j•••@e•••.com',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // The account's count holds it: 19 more fill the day.
    const other = await share(owner);
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from share_link_email
        where sent_by = $1 and sent_at > now() - interval '1 day'`,
      [ownerAccount],
    );
    for (let i = rows[0]?.n ?? 0; i < 20; i++) {
      await admin.query(
        `insert into share_link_email (household_id, share_id, sent_by, to_masked, sent_at)
         values ($1, null, $2, 'j•••@e•••.com', now() - interval '1 hour')`,
        [owner.household_id, ownerAccount],
      );
    }
    expect((await email(owner, other.share.id, { to: address() })).statusCode).toBe(429);
    await admin.query(`delete from share_link_email where sent_by = $1`, [ownerAccount]);
  });

  it('names its sharer and household plainly: no web address or turned-round text (the review)', async () => {
    await admin.query(`update member set display_name = $1 where id = $2`, [
      `Mum ${String.fromCodePoint(0x202e)}moc.live`,
      owner.member_id,
    ]);
    await admin.query(`update household set name = $1 where id = $2`, [
      'evil.com',
      owner.household_id,
    ]);
    try {
      const to = address();
      const made = await share(owner);
      expect((await email(owner, made.share.id, { to })).statusCode).toBe(200);
      const words = whole(mailsTo(to)[0]);
      expect(words).toContain('Mum has shared a document with you');
      expect(words).not.toMatch(/moc\.live|evil\.com/);
      expect(words).not.toContain(String.fromCodePoint(0x202e));
      expect(words.match(/https?:\/\//g)).toHaveLength(1);
    } finally {
      await admin.query(`update member set display_name = 'Owner' where id = $1`, [
        owner.member_id,
      ]);
      await admin.query(`update household set name = 'The Test family' where id = $1`, [
        owner.household_id,
      ]);
    }
  });

  it('a link that no longer opens, or was made before copies were kept, is not emailed', async () => {
    const taken = await share(owner);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${taken.share.id}`,
      headers: h.as(owner),
    });
    expect((await email(owner, taken.share.id, { to: address() })).statusCode).toBe(410);
    const older = await share(owner);
    await admin.query(
      `alter table share_link disable trigger user;
       update share_link set link_copy_sealed = null where id = '${older.share.id}';
       alter table share_link enable trigger user;`,
    );
    const r = await email(owner, older.share.id, { to: address() });
    expect(r.statusCode, r.body).toBe(409);
    expect(errorOf(r).code).toBe('share_not_revealable');
  });
});

describe.skipIf(!testAdminUrl())('a share link emailed, without the operator’s mail server', () => {
  let h: Harness;
  let owner: Tokens;

  beforeAll(async () => {
    h = await createHarness({ operatorMail: false });
    owner = await h.setup();
  }, 90_000);
  afterAll(() => h.close());

  it('is not offered, and is refused (503) before anything else is asked', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<{
      features: { share_link_email?: boolean };
    }>();
    expect(caps.features.share_link_email).toBe(false);
    const doc = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: { title: TITLE, type_key: 'utility_bill', visibility: 'household' },
      })
    ).json<DocumentView>();
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    const made = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc.id}/share`,
        headers: h.as(owner),
        payload: {},
      })
    ).json<CreatedShare>();
    expect(made.share.emailable).toBe(false);
    for (const payload of [{ to: 'jane@example.com' }, { to: 'not an address' }]) {
      const r = await h.app.inject({
        method: 'POST',
        url: `/api/v1/shares/${made.share.id}/email`,
        headers: h.as(owner),
        payload,
      });
      expect(r.statusCode, r.body).toBe(503);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('email_link_unavailable');
    }
    expect(mailSent(h)).toEqual([]);
  });
});
