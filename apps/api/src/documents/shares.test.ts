import { randomUUID } from 'node:crypto';
import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedShare, SharePreview, ShareView } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * Share links (SHR-05). What matters is what a link cannot do: outlive
 * its expiry, survive being taken back, carry a document it was not made
 * for, or reach anything else in the vault.
 */
describe.skipIf(!testAdminUrl())('share links', () => {
  let h: Harness;
  let owner: Tokens;
  let lease: string;
  let privateDoc: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.7.${Math.floor(++nth / 200)}.${nth % 200}` });

  const make = async (title: string, visibility: 'household' | 'private') => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: {
        title,
        type_key: 'utility_bill',
        visibility,
        ...(visibility === 'private' ? { owner_member_id: owner.member_id } : {}),
      },
    });
    const id = created.json<DocumentView>().id;
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

  const share = (documentId: string, body: Record<string, unknown> = {}, as: Tokens = owner) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/share`,
      headers: h.as(as),
      payload: body,
    });

  const preview = (token: string) => h.app.inject({ url: `/api/v1/shared/${token}`, ...peer() });

  const open = (token: string, pin?: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/shared/${token}/open`,
      payload: pin ? { pin } : {},
      ...peer(),
    });

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    lease = await make('Flat 3 tenancy agreement', 'household');
    privateDoc = await make('Therapy notes', 'private');
  }, 90_000);
  afterAll(() => h.close());

  it('makes a link that opens the document and nothing else', async () => {
    const created = json<CreatedShare>(
      await share(lease, { recipient_label: 'the letting agent' }),
    );
    expect(created.link_token.length).toBeGreaterThan(32);
    expect(created.pin).toBeUndefined();
    expect(created.share).toMatchObject({
      document_title: 'Flat 3 tenancy agreement',
      recipient_label: 'the letting agent',
      has_pin: false,
      open_count: 0,
      state: 'active',
    });
    expect(created.share.summary).toMatch(/Shared with the letting agent, not opened yet/);

    const shown = json<SharePreview>(await preview(created.link_token));
    expect(shown).toMatchObject({
      household_name: 'The Test family',
      needs_pin: false,
      document_title: 'Flat 3 tenancy agreement',
      shared_by: 'Owner',
    });

    const opened = await open(created.link_token);
    expect(opened.statusCode).toBe(200);
    expect(json<{ document_title: string }>(opened).document_title).toBe(
      'Flat 3 tenancy agreement',
    );

    const file = await h.app.inject({
      url: `/api/v1/shared/${created.link_token}/content`,
      ...peer(),
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect(file.headers['content-disposition']).toContain('scan.pdf');
    // Never cached anywhere, never indexed.
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.headers['x-robots-tag']).toContain('noindex');
  });

  it('the family sees that it was opened, and how often', async () => {
    const shares = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items;
    const link = shares.find((s) => s.recipient_label === 'the letting agent') as ShareView;
    expect(link.open_count).toBe(1);
    expect(link.last_opened_at).not.toBeNull();
    expect(link.summary).toMatch(/opened once/);
  });

  it('a PIN withholds even the title until it is right', async () => {
    const created = json<CreatedShare>(await share(lease, { with_pin: true }));
    expect(created.pin).toMatch(/^\d{4}$/);

    const shown = json<SharePreview>(await preview(created.link_token));
    expect(shown.needs_pin).toBe(true);
    // A title can say a great deal, and the PIN is there because somebody
    // wanted a second lock on exactly this.
    expect(shown.document_title).toBeNull();

    const wrong = await open(created.link_token, '0000' === created.pin ? '1111' : '0000');
    expect(wrong.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(wrong).error.code).toBe('pin_wrong');

    const right = await open(created.link_token, created.pin);
    expect(right.statusCode).toBe(200);
    expect(json<{ document_title: string }>(right).document_title).toBe('Flat 3 tenancy agreement');
  });

  it('downloading after opening is one visit, not two', async () => {
    const created = json<CreatedShare>(await share(lease, { recipient_label: 'counter' }));
    await open(created.link_token);
    await h.app.inject({ url: `/api/v1/shared/${created.link_token}/content`, ...peer() });

    const link = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items.find((s) => s.recipient_label === 'counter') as ShareView;
    expect(link.open_count).toBe(1);
  });

  it('taking it back stops it at once', async () => {
    const created = json<CreatedShare>(await share(lease, { recipient_label: 'gone' }));
    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `/api/v1/shares/${created.share.id}`,
          headers: h.as(owner),
        })
      ).statusCode,
    ).toBe(204);

    expect((await preview(created.link_token)).statusCode).toBe(404);
    expect((await open(created.link_token)).statusCode).toBe(404);
    expect(
      (await h.app.inject({ url: `/api/v1/shared/${created.link_token}/content`, ...peer() }))
        .statusCode,
    ).toBe(404);
  });

  it('an expired link is refused, in the same words as every other dead one', async () => {
    const created = json<CreatedShare>(await share(lease, { expires_in_days: 1 }));
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('share_link')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', created.share.id)
        .execute(),
    );
    const res = await preview(created.link_token);
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('link_not_valid');
  });

  it('a link to a document that goes in the bin stops working', async () => {
    const doomed = await make('Old bill', 'household');
    const created = json<CreatedShare>(await share(doomed));
    expect((await preview(created.link_token)).statusCode).toBe(200);

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${doomed}`,
      headers: h.as(owner),
    });
    expect((await preview(created.link_token)).statusCode).toBe(404);
  });

  it('ten wrong PINs and the link is dead, right code or not', async () => {
    const created = json<CreatedShare>(await share(lease, { with_pin: true }));
    const wrongPin = created.pin === '9999' ? '1111' : '9999';
    for (let i = 0; i < 10; i++) {
      expect((await open(created.link_token, wrongPin)).statusCode).toBe(401);
    }
    expect((await open(created.link_token, created.pin)).statusCode).toBe(404);
  });

  it('a link nobody made is refused, and a token is not a document id', async () => {
    expect((await preview('a'.repeat(43))).statusCode).toBe(404);
    // The document's own id, offered as a link secret, is not one.
    expect((await preview(lease)).statusCode).toBe(404);
  });

  it('a viewer cannot share, and a teen cannot either', async () => {
    const viewer = await h.join(owner, {
      name: 'Accountant',
      email: 'acc@example.test',
      role: 'viewer',
    });
    const teen = await h.join(owner, { name: 'Kid', email: 'kid@example.test', role: 'teen' });
    for (const who of [viewer, teen]) {
      const res = await share(lease, {}, who);
      expect(res.statusCode).toBe(403);
      expect(json<{ error: { code: string } }>(res).error.code).toBe('forbidden');
    }
  });

  it("another adult cannot share somebody else's private document, or even see the link", async () => {
    // The owner may share their own private document: it is theirs.
    const mine = json<CreatedShare>(await share(privateDoc));
    expect(mine.share.document_title).toBe('Therapy notes');

    const sam = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
    const res = await share(privateDoc, {}, sam);
    expect(res.statusCode).toBe(404);

    // And the existing link is not in Sam's list: naming it would name a
    // document Sam cannot see.
    const theirs = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(sam) }),
    ).items;
    expect(theirs.map((s) => s.document_title)).not.toContain('Therapy notes');
    expect(
      json<{ items: ShareView[] }>(
        await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
      ).items.map((s) => s.document_title),
    ).toContain('Therapy notes');
  });

  it('a document with no file on it cannot be shared', async () => {
    const empty = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Nothing here yet' },
    });
    const res = await share(empty.json<DocumentView>().id);
    expect(res.statusCode).toBe(422);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('nothing_to_share');
  });

  it('every open is in the audit chain, under a label and not a person', async () => {
    const rows = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'actor_account_id', 'actor_label'])
        .where('action', 'like', 'share.%')
        .orderBy('id')
        .execute(),
    );
    const opens = rows.filter((r) => r.action === 'share.opened');
    expect(opens.length).toBeGreaterThan(0);
    for (const o of opens) {
      expect(o.actor_account_id).toBeNull();
      expect(o.actor_label).toMatch(/^shared link/);
    }
    expect(rows.map((r) => r.action)).toContain('share.created');
    expect(rows.map((r) => r.action)).toContain('share.revoked');
    expect(rows.map((r) => r.action)).toContain('share.downloaded');
  });
});
