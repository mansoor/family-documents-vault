import { describe, expect, it } from 'vitest';
import { createApi } from '../api.js';
import { createHttp } from '../http.js';
import { contractScenarios, type ContractContext } from './contract.js';
import { createFakeVault } from './fake.js';

/** The contract, against the fake. `apps/api` runs the same against the real API. */
describe('the fake vault keeps the contract', () => {
  const vault = createFakeVault();
  const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
  const ctx: ContractContext = {
    email: 'owner@example.test',
    password: 'a long enough password',
    // The fake is one household: its type, marked.
    hideType: async (_householdId, key) => {
      const type = vault.state.types.find((t) => t.key === key);
      if (!type) throw new Error(`the fake has no type ${key}`);
      type.hidden = true;
    },
    // Files sent in (0.5.23), as a sender would send them and the worker
    // would get them ready: kept as sent, with one page drawn.
    sendFiles: async (made, files) => {
      for (const f of files) {
        const now = new Date();
        vault.state.incoming.push({
          id: `incoming-${vault.state.incoming.length + 1}`,
          request_id: made.request.id,
          request_title: made.request.title,
          recipient_label: made.request.recipient_label,
          item_label: null,
          name: f.name,
          content_type: f.contentType,
          byte_size: f.bytes.length,
          sender_note: null,
          sent_at: now.toISOString(),
          removed_at: new Date(now.getTime() + 30 * 864e5).toISOString(),
          scan_state: 'unscanned',
          preview_state: 'ready',
          preview_pages: 1,
          suggested_member_id: made.request.suggested_member_id,
          suggested_type_key: made.request.suggested_type_key,
          review_by: made.request.review_by,
          moved_to_owners: false,
          bytes: f.bytes,
        });
      }
    },
  };
  for (const s of contractScenarios) it(s.name, () => s.run(api, ctx));
});

/**
 * What the contract cannot hold the real vault to with its one owner: a
 * viewer's view of a document's history (0.5.11), as `documents.test.ts`
 * holds the real vault to it.
 */
describe('the fake vault, for somebody who is not an owner', () => {
  const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

  it('a viewer is not told who added each version; everybody else is', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const made = await api.capture(
      tokens.access_token,
      {
        file: { kind: 'bytes', filename: 'lease.pdf', contentType: 'application/pdf', bytes: PDF },
      },
      '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b',
    );
    const who = async () =>
      (await api.versions(tokens.access_token, made.document_id)).items.map(
        (v) => v.uploaded_by_name,
      );
    expect(await who()).toEqual(['Fake Owner']);
    for (const role of ['adult', 'teen'] as const) {
      vault.state.role = role;
      expect(await who()).toEqual(['Fake Owner']);
    }
    vault.state.role = 'viewer';
    expect(await who()).toEqual([null]);
    // A document that is not there has no history to give.
    const refused = await api
      .versions(tokens.access_token, 'no-such-document')
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('collections as the real vault keeps them for each role (0.5.12): a viewer sees none', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    const everyday = await api.createDocument(token, { title: 'Bill' });
    const adults = await api.createDocument(token, { title: 'Will', visibility: 'adults' });
    const family = await api.createCollection(token, { name: 'Family', audience: 'everyone' });
    await api.addToCollection(token, family.id, [everyday.id, adults.id]);
    const grown = await api.createCollection(token, { name: 'Grown-ups', audience: 'adults' });
    // Made by somebody else, an adult: the fake signs in as one member only.
    vault.state.members.push({ id: 'sam', display_name: 'Sam', role: 'adult', is_me: false });
    for (const l of vault.state.collections) l.owner_member_id = 'sam';

    // A teen is given the collection for everyone, and in it only what a teen may see.
    vault.state.role = 'teen';
    expect((await api.collections(token)).items.map((l) => l.name)).toEqual(['Family']);
    const seen = await api.getCollection(token, family.id);
    expect(seen.items.map((i) => i.document.id)).toEqual([everyday.id]);
    expect(seen.item_count).toBe(1);
    expect(await refusal(api.getCollection(token, grown.id))).toMatchObject({ status: 404 });
    expect(
      await refusal(api.createCollection(token, { name: 'For the adults', audience: 'adults' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });

    // A viewer, none at all, and makes none.
    vault.state.role = 'viewer';
    expect((await api.collections(token)).items).toEqual([]);
    expect(await refusal(api.getCollection(token, family.id))).toMatchObject({ status: 404 });
    expect((await api.documentCollections(token, everyday.id)).items).toEqual([]);
    expect(
      await refusal(api.createCollection(token, { name: 'Mine', audience: 'everyone' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('a maker made a teen keeps their collection to see and delete, not change; an owner deletes one nobody can change (the 5.14 review)', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    const everyday = await api.createDocument(token, { title: 'Bill' });
    const adults = await api.createDocument(token, { title: 'Will', visibility: 'adults' });
    const grown = await api.createCollection(token, { name: 'Grown-ups', audience: 'adults' });
    await api.addToCollection(token, grown.id, [everyday.id, adults.id]);
    const family = await api.createCollection(token, { name: 'Family', audience: 'everyone' });

    // Its maker, made a teen: sees it, with what a teen may see in it.
    vault.state.role = 'teen';
    const seen = await api.getCollection(token, grown.id);
    expect(seen).toMatchObject({ mine: true, item_count: 1 });
    expect(seen.items.map((i) => i.document.id)).toEqual([everyday.id]);
    expect((await api.collections(token)).items.map((l) => l.name)).toEqual([
      'Family',
      'Grown-ups',
    ]);
    // Changes it no more, while the one for everyone is still theirs to change.
    for (const change of [
      api.updateCollection(token, grown.id, { name: 'Taken back' }),
      api.addToCollection(token, grown.id, [everyday.id]),
      api.removeFromCollection(token, grown.id, everyday.id),
    ]) {
      expect(await refusal(change)).toMatchObject({ status: 403, code: 'forbidden' });
    }
    expect(await api.updateCollection(token, family.id, { name: 'Our family' })).toMatchObject({
      name: 'Our family',
    });
    // Made a viewer, deletes it all the same.
    vault.state.role = 'viewer';
    await api.deleteCollection(token, grown.id);
    expect(await refusal(api.getCollection(token, grown.id))).toMatchObject({ status: 404 });

    // An owner deletes a collection whose maker has no sign-in, or is outside its
    // audience; never one whose maker can still change it.
    vault.state.role = 'owner';
    vault.state.members.push({ id: 'kim', display_name: 'Kim', role: 'teen', is_me: false });
    const theirs = async (name: string, maker: string, audience: 'adults' | 'everyone') => {
      const l = await api.createCollection(token, { name, audience });
      const kept = vault.state.collections.find((x) => x.id === l.id);
      if (kept) kept.owner_member_id = maker;
      return l.id;
    };
    const gone = await theirs('Gone', 'nobody-now', 'everyone');
    const outside = await theirs('Outside', 'kim', 'adults');
    const inside = await theirs('Inside', 'kim', 'everyone');
    await api.deleteCollection(token, gone);
    await api.deleteCollection(token, outside);
    expect(await refusal(api.deleteCollection(token, inside))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(await refusal(api.updateCollection(token, outside, { name: 'Mine' }))).toMatchObject({
      status: 404,
    });
  });

  it('removing for good as the real vault does (5.24): somebody else’s is asked about first, a day ahead', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    // Filed by somebody else, though it is the owner's own now: asked about
    // first all the same (the 5.24 review, M524-1).
    const made = await api.createDocument(token, {
      title: 'Their letter',
      owner_member_id: 'fake-member',
    });
    const kept = vault.state.documents.find((d) => d.id === made.id);
    if (kept) kept.filedBySomeoneElse = true;
    await api.deleteDocument(token, made.id);
    const offered = (await api.documents(token, { deleted: 'true' })).items;
    expect(offered.map((d) => [d.id, d.purge_at_once])).toEqual([[made.id, false]]);

    // Asked about, not removed: and from when it may be.
    const asked = await api.purgeDocument(token, made.id);
    expect(asked.removed).toBe(false);
    const document = asked.removed ? null : asked.document;
    expect(document?.filed_by_me).toBe(false);
    expect(Date.parse(document?.purge_allowed_from ?? '')).toBe(
      Date.parse(document?.purge_requested_at ?? '') + 24 * 3_600_000,
    );
    expect(
      (await api.documents(token, { deleted: 'true', purge_requested: 'true' })).items.map(
        (d) => d.id,
      ),
    ).toEqual([made.id]);
    // Again before the day is out: refused, saying from when.
    expect(await refusal(api.purgeDocument(token, made.id))).toMatchObject({
      status: 409,
      code: 'purge_not_yet',
      detail: document?.purge_allowed_from,
    });
    // Brought back, the request goes with it.
    expect((await api.restoreDocument(token, made.id)).purge_requested_at).toBeNull();
    await api.deleteDocument(token, made.id);
    const binned = (await api.documents(token, { deleted: 'true' })).items;
    expect(binned.map((d) => [d.id, d.purge_requested_at])).toEqual([[made.id, null]]);

    // Asked again, and the day over: removed. Never by anybody but an owner.
    await api.purgeDocument(token, made.id);
    if (kept) kept.purge_requested_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
    vault.state.role = 'adult';
    expect(await refusal(api.purgeDocument(token, made.id))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    vault.state.role = 'owner';
    expect(await api.purgeDocument(token, made.id)).toEqual({ removed: true });
    expect((await api.documents(token, { deleted: 'true' })).items).toEqual([]);
  });

  it("pages a collection's documents as the real vault does", async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      ids.push((await api.createDocument(token, { title })).id);
    }
    const collection = await api.createCollection(token, { name: 'Three', audience: 'everyone' });
    await api.addToCollection(token, collection.id, ids);
    const first = await api.getCollection(token, collection.id, { limit: 2 });
    expect(first).toMatchObject({ item_count: 3, has_more: true });
    expect(first.items.map((i) => i.document.id)).toEqual(ids.slice(0, 2));
    const rest = await api.getCollection(token, collection.id, {
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(rest).toMatchObject({ item_count: 3, has_more: false, next_cursor: null });
    expect(rest.items.map((i) => i.document.id)).toEqual(ids.slice(2));
    const bad = await api
      .getCollection(token, collection.id, { cursor: 'nonsense' })
      .catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 422, code: 'validation_failed' });
  });
});

/** Asking to be sent documents (0.5.21), as the real vault answers it. */
describe('the fake vault, asking to be sent documents', () => {
  it('an owner asks; a teen is told there is nothing here', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const made = await api.createUploadRequest(tokens.access_token, {
      title: 'Tax papers',
      items: ['W-2'],
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      with_password: true,
    });
    expect(made.password).toBeTruthy();
    expect(made.request).toMatchObject({ state: 'active', protection: ['password'] });
    const listed = await api.uploadRequests(tokens.access_token);
    expect(listed.items.map((r) => r.id)).toEqual([made.request.id]);
    await expect(
      api.createUploadRequest(tokens.access_token, {
        title: 'For ever',
        expires_at: new Date(Date.now() + 91 * 864e5).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 422 });
    await api.revokeUploadRequest(tokens.access_token, made.request.id);
    expect((await api.uploadRequests(tokens.access_token)).items[0]?.state).toBe('revoked');

    vault.state.role = 'teen';
    const teen = await api.signIn('owner@example.test', 'a long enough password');
    if (!('access_token' in teen)) throw new Error('no second step in the fake');
    await expect(api.uploadRequests(teen.access_token)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the fake vault, identity details (5.26)', () => {
  it('a widening whose 72 hours are up reads from then, whichever request asks first (the 5.26 review)', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Teen',
      email: 'teen@example.test',
      password: 'a long enough password',
    });
    vault.state.role = 'teen';
    vault.state.members.push({ id: 'sara', display_name: 'Sara', role: 'adult', is_me: false });
    vault.state.identities.set('sara', {
      shared: {
        fields: { given_name: 'Sara', ids: [{ id: 'p1', kind: 'passport', number: 'P-1' }] },
        version: 1,
        updated_at: new Date().toISOString(),
      },
    });
    // The whole family, from an hour ago; nothing has asked for the audience since.
    vault.state.identityPending = {
      to: 'family',
      requested_at: new Date(Date.now() - 73 * 3_600_000).toISOString(),
      notice_until: new Date(Date.now() - 3_600_000).toISOString(),
    };
    const hers = await api.identity(tokens.access_token, 'sara');
    expect(hers).toMatchObject({
      audience: 'family',
      only_me: null,
      shared: { masked: ['ids.p1'] },
    });
    expect(hers.shared.fields.ids?.[0]).not.toHaveProperty('number');
    // Another person's numbers: a passkey or a code, which this teen has not.
    const refused = await api
      .revealIdentity(tokens.access_token, 'sara', { keys: ['ids.p1'] })
      .then(
        () => null,
        (err: { status?: number; code?: string; message?: string }) => err,
      );
    expect(refused).toMatchObject({
      status: 403,
      code: 'two_step_required',
      message: "Turn on two-step sign-in to see another person's identity numbers.",
    });
  });

  it('a widening is refused while anybody with a sign-in, a teen included, cannot sign in to be told', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    vault.state.members.push({ id: 'tariq', display_name: 'Tariq', role: 'teen', is_me: false });
    vault.state.signInsOff = ['tariq'];
    const refused = await api.setIdentityAudience(tokens.access_token, 'adults').then(
      () => null,
      (err: { status?: number; code?: string; message?: string }) => err,
    );
    expect(refused).toMatchObject({ status: 409, code: 'member_cannot_be_told' });
    expect(refused?.message).toMatch(/^Tariq cannot sign in just now/);
    vault.state.signInsOff = [];
    expect((await api.setIdentityAudience(tokens.access_token, 'adults')).pending?.to).toBe(
      'adults',
    );
  });
});
