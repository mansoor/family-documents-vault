import { refusalFor, shareEndWords, type Role, type Tokens } from '@fdv/shared';
import { describe, expect, it, vi } from 'vitest';
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
    // Somebody else with a sign-in (5.28): in the family, and able to sign in.
    addSignIn: async (_token, who) => {
      const id = `member-${vault.state.members.length + 1}`;
      vault.state.members.push({ id, display_name: who.name, role: who.role, is_me: false });
      vault.state.signIns.push({ member_id: id, email: who.email, password: who.password });
      return id;
    },
    // The fake's owners have two-step sign-in, and have just used it.
    ownerTwoStep: async () => {
      vault.state.ownerTwoStep = true;
    },
    // A guest's sign-in ended a minute ago (5.34).
    endGuestAccess: async (memberId) => {
      const m = vault.state.members.find((x) => x.id === memberId);
      if (m) m.access_expires_at = new Date(Date.now() - 60_000).toISOString();
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
describe('the fake vault, people outside the family (5.34)', () => {
  it('refuses as the vault does: an adult re-inviting somebody limited is asked nothing more, but never keeps an owner’s Adults only grant; a guest who never signed in is removed', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    // Somebody of the family with no sign-in yet, limited by an owner.
    vault.state.members.push({ id: 'lena', display_name: 'Lena', role: null, is_me: false });
    const limited = {
      people: ['fake-member'],
      types: [],
      collections: [],
      include_adults_only: false,
      include_no_person_docs: false,
      expires_at: null,
      limits_people: true,
      limits_types: false,
      reconfirm_since: null,
      private_confirmed: false,
      updated_at: new Date().toISOString(),
    };
    vault.state.restrictions.set('lena', limited);
    // An adult (no two-step sign-in): an adult's limits never replace an
    // owner's, so nothing more is asked (the vault's S533-02 is an owner's).
    vault.state.role = 'adult';
    const asked = {
      member_id: 'lena',
      email: 'lena@example.test',
      role: 'viewer' as const,
      restriction: { people: ['fake-member'] },
    };
    const lenaInvite = await api.invite(token, asked);
    expect(lenaInvite.invitation.member_id).toBe('lena');
    // Given Adults only by an owner: an adult's invitation is refused.
    vault.state.restrictions.set('lena', { ...limited, include_adults_only: true });
    expect(
      await refusal(api.invite(token, { ...asked, email: 'lena2@example.test' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });
    // And the adult's made before it, accepted now: refused, and nothing of
    // it kept — she has no sign-in, and an owner may invite her (N534W-02).
    expect(
      await refusal(
        api.acceptInvitationLink(lenaInvite.link_token, {
          code: lenaInvite.code,
          password: 'lena’s own password',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'owner_needed' });
    expect(vault.state.members.find((m) => m.id === 'lena')?.role).toBeNull();
    expect(vault.state.signIns.some((s) => s.member_id === 'lena')).toBe(false);
    // A guest who never signed in: an owner removes them; an adult may not.
    vault.state.role = 'owner';
    vault.state.ownerTwoStep = true;
    const made = await api.invite(token, {
      display_name: 'Rex',
      email: 'rex@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: ['fake-member'] },
      access_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    });
    const rex = made.invitation.member_id;
    vault.state.role = 'adult';
    expect(await refusal(api.removeGuest(token, rex))).toMatchObject({ status: 403 });
    vault.state.role = 'owner';
    await api.removeGuest(token, rex);
    expect((await api.guests(token)).items.map((m) => m.id)).not.toContain(rex);
    expect(await refusal(api.removeGuest(token, 'fake-member'))).toMatchObject({
      status: 409,
      code: 'not_a_guest',
    });
    // A guest who has had a sign-in, since taken away: never invited again
    // as themselves, nor removed (S534-01).
    const gilInvite = {
      display_name: 'Gil',
      email: 'gil@example.test',
      role: 'viewer' as const,
      kind: 'guest' as const,
      restriction: { people: ['fake-member'] },
      access_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    };
    const gilMade = await api.invite(token, gilInvite);
    await api.acceptInvitationLink(gilMade.link_token, {
      code: gilMade.code,
      password: 'gil’s own password',
    });
    const gil = gilMade.invitation.member_id;
    const held = vault.state.members.find((m) => m.id === gil);
    if (held) held.role = null;
    expect(
      await refusal(
        api.invite(token, {
          member_id: gil,
          email: 'gil2@example.test',
          role: 'viewer',
          kind: 'guest',
          restriction: gilInvite.restriction,
          access_expires_at: gilInvite.access_expires_at,
        }),
      ),
    ).toMatchObject({ status: 409, code: 'had_sign_in' });
    expect(await refusal(api.removeGuest(token, gil))).toMatchObject({
      status: 409,
      code: 'had_sign_in',
    });
    // Lena, refused above, is somebody an owner may still invite.
    expect(
      (await api.invite(token, { ...asked, email: 'lena3@example.test' })).invitation.member_id,
    ).toBe('lena');
  });
});

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

/**
 * Locking a sign-in, and sign-ins paused after a restore (5.28), as the
 * real vault does them: what the phone's paused screens are tested against.
 */
describe('the fake vault, locked and paused sign-ins (5.28)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string; message?: string; reason?: string }) => err,
    );
  /** A fake vault, its owner signed in with two-step sign-in, and a way to add people who sign in. */
  const start = async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const owner = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    const add = (id: string, name: string, role: Role) => {
      vault.state.members.push({ id, display_name: name, role, is_me: false });
      vault.state.signIns.push({
        member_id: id,
        email: `${id}@example.test`,
        password: `${id}'s own password`,
      });
    };
    const signInAs = async (id: string): Promise<Tokens> => {
      const t = await api.signIn(`${id}@example.test`, `${id}'s own password`);
      if (!('access_token' in t)) throw new Error('no second step in the fake');
      return t;
    };
    return { vault, api, owner, add, signInAs };
  };

  it("ends a locked person's sessions with the reason suspended, and refuses their right password — only once it is right — with 403 membership_suspended; an unlock lets them in again", async () => {
    const { vault, api, owner, add, signInAs } = await start();
    add('sara', 'Sara', 'adult');
    vault.state.memberAccounts.set('sara', {
      member_id: 'sara',
      role: 'adult',
      email: 'sara@example.test',
      two_step: false,
      passkeys: 0,
      last_signed_in_at: null,
      devices: [],
    });
    expect(await api.memberAccount(owner.access_token, 'sara')).toMatchObject({
      suspension: null,
      max_offline_days: 90,
    });
    const hers = await signInAs('sara');
    expect(hers).toMatchObject({ member_id: 'sara', role: 'adult' });
    expect(await api.me(hers.access_token)).toMatchObject({ member_id: 'sara', role: 'adult' });
    // Her session is hers: no owner's view of a sign-in for an adult.
    expect(await refusal(api.memberAccount(hers.access_token, 'sara'))).toMatchObject({
      status: 404,
    });

    // Locked with no end, and a note that is only spaces: none.
    const locked = await api.lockMember(owner.access_token, 'sara', { note: '   ' });
    expect(locked).toEqual({
      member_id: 'sara',
      suspension: {
        reason: 'locked',
        since: expect.any(String) as unknown,
        until: null,
        note: null,
        by: 'Fake Owner',
      },
    });
    expect((await api.memberAccount(owner.access_token, 'sara')).suspension).toEqual(
      locked.suspension,
    );
    // Her session, to its access token and its refresh token alike.
    expect(await refusal(api.me(hers.access_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
    expect(await refusal(api.refresh(hers.refresh_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
    // A wrong password says nothing of the lock.
    const wrong = await refusal(api.signIn('sara@example.test', 'not her password'));
    expect(wrong).toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(wrong?.reason).toBeUndefined();
    expect(await refusal(api.signIn('sara@example.test', "sara's own password"))).toMatchObject({
      status: 403,
      code: 'membership_suspended',
      reason: 'locked',
      message: 'An owner has locked your sign-in. Ask one of them if you need to get in.',
    });
    // Nobody else's session is touched.
    expect(await api.me(owner.access_token)).toMatchObject({ member_id: 'fake-member' });

    await api.unlockMember(owner.access_token, 'sara');
    expect((await api.memberAccount(owner.access_token, 'sara')).suspension).toBeNull();
    expect(await api.me((await signInAs('sara')).access_token)).toMatchObject({
      member_id: 'sara',
    });
    // The session the lock ended stays ended.
    expect(await refusal(api.refresh(hers.refresh_token))).toMatchObject({ reason: 'suspended' });
  });

  it("shows a phone its paused screens: the fake's own person, locked by a test, has their session answer suspended while it lasts, and their sign-in says until when on the household's clock", async () => {
    const { vault, api, owner } = await start();
    vault.state.role = 'adult';
    vault.state.timezone = 'Europe/London';
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    vault.state.suspensions.set('fake-member', {
      reason: 'locked',
      since: new Date().toISOString(),
      until,
      note: null,
      by: 'Mum',
    });
    expect(await refusal(api.me(owner.access_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
    expect(await refusal(api.refresh(owner.refresh_token))).toMatchObject({
      code: 'session_ended',
      reason: 'suspended',
    });
    expect(await refusal(api.signIn('owner@example.test', 'not the password'))).toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    expect(await refusal(api.signIn('owner@example.test', 'a long enough password'))).toMatchObject(
      {
        status: 403,
        code: 'membership_suspended',
        reason: 'locked',
        message: `An owner has locked your sign-in until ${shareEndWords(new Date(until), 'Europe/London')} (Europe/London). Ask one of them if you need to get in sooner.`,
      },
    );
    // No lock ended that session: once the suspension goes, it answers again, as the vault's would.
    vault.state.suspensions.delete('fake-member');
    expect(await api.me(owner.access_token)).toMatchObject({ member_id: 'fake-member' });
  });

  it('takes a lock past its end as over, by the clock: the card says nothing, they sign in, it is not there to unlock, and it may be locked again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.parse('2026-10-05T09:00:00Z');
      vi.setSystemTime(now);
      const { api, owner, add, signInAs } = await start();
      add('sara', 'Sara', 'adult');
      const until = new Date(now + 3_600_000).toISOString();
      await api.lockMember(owner.access_token, 'sara', { until });
      expect((await api.memberAccount(owner.access_token, 'sara')).suspension?.until).toBe(until);
      expect(await refusal(signInAs('sara'))).toMatchObject({ code: 'membership_suspended' });
      // A widening waits while she is locked.
      expect(await refusal(api.setIdentityAudience(owner.access_token, 'adults'))).toMatchObject({
        status: 409,
        code: 'member_cannot_be_told',
      });

      vi.setSystemTime(now + 2 * 3_600_000);
      expect((await api.memberAccount(owner.access_token, 'sara')).suspension).toBeNull();
      expect((await signInAs('sara')).member_id).toBe('sara');
      expect(await refusal(api.unlockMember(owner.access_token, 'sara'))).toMatchObject({
        status: 409,
        code: 'not_locked',
        message: "Sara's sign-in is not locked.",
      });
      // Once she can sign in, a widening is asked for; locking her again withdraws it.
      expect((await api.setIdentityAudience(owner.access_token, 'adults')).pending?.to).toBe(
        'adults',
      );
      const again = await api.lockMember(owner.access_token, 'sara');
      expect(again.suspension).toMatchObject({ reason: 'locked', until: null });
      expect((await api.identityAudience(owner.access_token)).pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses in the real vault's order: who may, what was sent, the owner power, then the person", async () => {
    const { vault, api, owner, add } = await start();
    add('sara', 'Sara', 'adult');
    add('mum', 'Mum', 'owner');
    const token = owner.access_token;

    // Not an owner: refused, whatever was sent.
    vault.state.role = 'adult';
    for (const asked of [
      () => api.lockMember(token, 'sara', { bogus: 1 } as never),
      () => api.unlockMember(token, 'sara'),
    ]) {
      expect(await refusal(asked())).toMatchObject({
        status: 403,
        code: 'forbidden',
        message: refusalFor('member.suspend'),
      });
    }
    expect(await refusal(api.resumeMember(token, 'sara'))).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: refusalFor('restore.review'),
    });

    // An owner without two-step sign-in: what was sent is read first.
    vault.state.role = 'owner';
    vault.state.ownerTwoStep = false;
    for (const body of [
      { bogus: 1 },
      { until: '2026-10-05T07:00' },
      // Without its seconds, as the real vault refuses it (the 5.28 review, R528-5).
      { until: '2026-10-05T23:58Z' },
      { until: '2026-10-05T07:00+09:00' },
      { note: 'x'.repeat(501) },
      { end_links: 'yes' },
    ]) {
      expect(await refusal(api.lockMember(token, 'sara', body as never))).toMatchObject({
        status: 422,
        code: 'validation_failed',
      });
    }
    expect(await refusal(api.lockMember(token, 'sara', { note: 'x'.repeat(501) }))).toMatchObject({
      message: 'A note can be 500 characters at most.',
    });
    for (const asked of [
      () => api.lockMember(token, 'sara'),
      () => api.unlockMember(token, 'sara'),
      () => api.resumeMember(token, 'sara'),
    ]) {
      expect(await refusal(asked())).toMatchObject({
        status: 403,
        code: 'totp_required_for_owner',
        message: "Turn on two-step sign-in to manage other people's sign-ins.",
      });
    }

    // Then the person: nobody; oneself; another owner; locked already.
    vault.state.ownerTwoStep = true;
    for (const asked of [
      () => api.lockMember(token, 'nobody'),
      () => api.unlockMember(token, 'nobody'),
      () => api.resumeMember(token, 'nobody'),
    ]) {
      expect(await refusal(asked())).toMatchObject({
        status: 404,
        code: 'not_found',
        message: 'They have no sign-in to lock.',
      });
    }
    expect(await refusal(api.lockMember(token, 'fake-member'))).toMatchObject({
      status: 422,
      message: 'You cannot lock your own sign-in.',
    });
    expect(await refusal(api.lockMember(token, 'mum'))).toMatchObject({
      status: 409,
      code: 'owner_notice_required',
      message:
        "Mum is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.",
    });
    // An end with its offset, kept as the moment it names.
    const until = new Date(Math.ceil((Date.now() + 10 * 86_400_000) / 60_000) * 60_000);
    const sent = new Date(until.getTime() + 3_600_000).toISOString().replace('Z', '+01:00');
    const locked = await api.lockMember(token, 'sara', { until: sent, end_links: true });
    expect(locked.suspension.until).toBe(until.toISOString());
    expect(await refusal(api.lockMember(token, 'sara', { until: 'nonsense' }))).toMatchObject({
      status: 422,
    });
    expect(await refusal(api.lockMember(token, 'sara'))).toMatchObject({
      status: 409,
      code: 'already_locked',
    });
  });

  it('pauses every sign-in but the owners’ as a restore does, keeps a lock as a lock, and an owner turns each back on', async () => {
    const { vault, api, add, signInAs } = await start();
    add('sara', 'Sara', 'adult');
    add('tariq', 'Tariq', 'teen');
    add('kim', 'Kim', 'viewer');
    add('mum', 'Mum', 'owner');
    const first = await api.signIn('owner@example.test', 'a long enough password');
    if (!('access_token' in first)) throw new Error('no second step in the fake');
    await api.lockMember(first.access_token, 'sara', {
      until: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const teen = await signInAs('tariq');

    vault.pauseSignIns();
    // Every session ends, as a restore ends them.
    for (const t of [first, teen]) {
      expect(await refusal(api.me(t.access_token))).toMatchObject({
        status: 401,
        code: 'session_ended',
        reason: 'revoked',
      });
    }
    const owner = await api.signIn('owner@example.test', 'a long enough password');
    if (!('access_token' in owner)) throw new Error('no second step in the fake');
    const token = owner.access_token;
    // The lock stays a lock, with no end of its own; the others wait for an owner.
    expect((await api.memberAccount(token, 'sara')).suspension).toMatchObject({
      reason: 'locked',
      until: null,
    });
    expect((await api.memberAccount(token, 'tariq')).suspension).toMatchObject({
      reason: 'restored',
      until: null,
      by: null,
    });
    const paused = (await api.afterRestore(token)).sign_ins;
    expect(paused?.map((p) => [p.member_id, p.display_name, p.role])).toEqual([
      ['kim', 'Kim', 'viewer'],
      ['tariq', 'Tariq', 'teen'],
    ]);
    expect(await refusal(signInAs('tariq'))).toMatchObject({
      status: 403,
      code: 'membership_suspended',
      reason: 'restored',
      message:
        'The vault was restored from a backup, and your sign-in waits for an owner to turn it back on. Ask one of them.',
    });
    expect((await signInAs('mum')).role).toBe('owner');
    // Nobody who cannot sign in could be told of a widening.
    expect(await refusal(api.setIdentityAudience(token, 'adults'))).toMatchObject({
      status: 409,
      code: 'member_cannot_be_told',
      message: expect.stringMatching(/^Kim, Sara, Tariq cannot sign in just now/) as unknown,
    });

    // A pause is turned back on, not unlocked; a lock is unlocked, not turned back on.
    expect(await refusal(api.unlockMember(token, 'kim'))).toMatchObject({
      status: 409,
      code: 'not_locked',
    });
    expect(await refusal(api.resumeMember(token, 'sara'))).toMatchObject({
      status: 409,
      code: 'not_paused',
    });
    await api.resumeMember(token, 'kim');
    const viewer = await signInAs('kim');
    // Only an owner is shown them, or turns them back on.
    expect((await api.afterRestore(viewer.access_token)).sign_ins).toEqual([]);
    expect(await refusal(api.resumeMember(viewer.access_token, 'tariq'))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    // Somebody paused may be locked: the lock takes the pause's place.
    expect((await api.lockMember(token, 'tariq')).suspension.reason).toBe('locked');
    expect((await api.afterRestore(token)).sign_ins).toEqual([]);

    // Requests to send documents the restore paused are listed beside them;
    // one paused only by its maker's lock is not the restore's.
    for (const title of ['Paused', 'Locked']) {
      await api.createUploadRequest(token, {
        title,
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      });
    }
    for (const r of vault.state.uploadRequests) {
      Object.assign(r, {
        state: 'paused',
        paused_reason: r.title === 'Paused' ? 'restored' : 'locked',
      });
    }
    expect((await api.afterRestore(token)).upload_requests?.map((r) => r.title)).toEqual([
      'Paused',
    ]);
    expect((await api.afterRestore(viewer.access_token)).upload_requests).toEqual([]);
  });

  it('gives a suspended person no new token, not even for the refresh just replaced (the grace)', async () => {
    const vault = createFakeVault();
    const api = createApi(
      createHttp({
        baseUrl: 'https://fake.example',
        fetch: vault.fetch,
        installationId: '0f5a1c2e-9b7d-4e61-8a33-5c2d7e9f1a40',
      }),
    );
    const first = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    // Rotated, its answer lost on the way: the replay would be let through...
    await api.refresh(first.refresh_token);
    vault.state.role = 'teen';
    vault.state.suspensions.set('fake-member', {
      reason: 'restored',
      since: new Date().toISOString(),
      until: null,
      note: null,
      by: null,
    });
    // ...but not while the sign-in is paused.
    expect(await refusal(api.refresh(first.refresh_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
  });

  it("pauses the fake's own person too, when not an owner: the phone's session ends, and its sign-in waits for an owner", async () => {
    const { vault, api, owner } = await start();
    vault.state.role = 'adult';
    vault.pauseSignIns();
    expect(await refusal(api.me(owner.access_token))).toMatchObject({ reason: 'revoked' });
    expect(await refusal(api.signIn('owner@example.test', 'a long enough password'))).toMatchObject(
      { status: 403, code: 'membership_suspended', reason: 'restored' },
    );
    // An owner turned it back on.
    vault.state.suspensions.delete('fake-member');
    const back = await api.signIn('owner@example.test', 'a long enough password');
    expect(back).toMatchObject({ member_id: 'fake-member', role: 'adult' });
  });
});

describe('the fake vault, a password reset an owner starts (5.29)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string; message?: string; reason?: string }) => err,
    );
  const start = async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const owner = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    for (const [id, name, role] of [
      ['sara', 'Sara', 'adult'],
      ['tariq', 'Tariq', 'teen'],
    ] as const) {
      vault.state.members.push({ id, display_name: name, role, is_me: false });
      vault.state.signIns.push({ member_id: id, email: `${id}@example.test`, password: `${id}!` });
    }
    const signInAs = async (id: string): Promise<Tokens> => {
      const t = await api.signIn(`${id}@example.test`, `${id}!`);
      if (!('access_token' in t)) throw new Error('no second step in the fake');
      return t;
    };
    return { vault, api, owner, signInAs };
  };

  it('with no operator mail: a link to hand over for somebody with nothing private, none for anybody else; the card says which beforehand', async () => {
    const { vault, api, owner } = await start();
    vault.state.operatorMail = false;
    vault.state.keepsPrivate = ['tariq'];
    const token = owner.access_token;
    expect((await api.memberAccount(token, 'sara')).reset_path).toBe('handover');
    expect((await api.memberAccount(token, 'tariq')).reset_path).toBe('operator');
    const handed = await api.startPasswordReset(token, 'sara');
    expect(handed).toMatchObject({ member_id: 'sara', path: 'handover', stop_now: false });
    expect(handed.link).toMatch(/\/reset#[A-Za-z0-9_-]{43}$/);
    expect(handed.expires_at).toEqual(expect.any(String));
    const left = await api.startPasswordReset(token, 'tariq');
    expect(left).toEqual({
      member_id: 'tariq',
      path: 'operator',
      stop_now: false,
      command:
        "docker compose exec api node apps/api/dist/cli.mjs reset-password 'tariq@example.test'",
    });
    // No stopping a password where no link can reach them (the 5.29 review).
    const refused = await api.startPasswordReset(token, 'tariq', { stop_now: true }).then(
      () => null,
      (e: { status?: number; code?: string }) => e,
    );
    expect(refused).toMatchObject({ status: 409, code: 'stop_now_unavailable' });
    expect(vault.state.resetsStarted).toEqual([
      { member_id: 'sara', path: 'handover', stop_now: false },
      { member_id: 'tariq', path: 'operator', stop_now: false },
    ]);
  });

  it('the person is told at their next sign-in until they say they saw it; nobody else is', async () => {
    const { vault, api, owner, signInAs } = await start();
    vault.state.operatorMail = false;
    await api.startPasswordReset(owner.access_token, 'sara');
    const sara = await signInAs('sara');
    expect((await api.me(sara.access_token)).reset_notice).toEqual({
      by: 'Fake Owner',
      at: expect.any(String) as unknown,
    });
    expect((await api.me(owner.access_token)).reset_notice).toBeNull();
    await api.dismissResetNotice(sara.access_token);
    expect((await api.me(sara.access_token)).reset_notice).toBeNull();
    // A link by the operator's mail tells nobody at sign-in: the mail is the telling.
    vault.state.operatorMail = true;
    await api.startPasswordReset(owner.access_token, 'sara');
    expect((await api.me(sara.access_token)).reset_notice).toBeNull();
  });

  it("refuses in the real vault's order: who may, what was sent, the owner power, then the person", async () => {
    const { vault, api, owner, signInAs } = await start();
    const sara = await signInAs('sara');
    expect(await refusal(api.startPasswordReset(sara.access_token, 'tariq'))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(
      await refusal(
        api.startPasswordReset(owner.access_token, 'sara', { stop_now: 'yes' } as never),
      ),
    ).toMatchObject({ status: 422, code: 'validation_failed' });
    vault.state.ownerTwoStep = false;
    expect(await refusal(api.startPasswordReset(owner.access_token, 'sara'))).toMatchObject({
      status: 403,
      code: 'totp_required_for_owner',
    });
    vault.state.ownerTwoStep = true;
    expect(await refusal(api.startPasswordReset(owner.access_token, 'nobody'))).toMatchObject({
      status: 404,
    });
    expect(await refusal(api.startPasswordReset(owner.access_token, 'fake-member'))).toMatchObject({
      status: 422,
    });
    vault.state.suspensions.set('sara', {
      reason: 'restored',
      since: new Date().toISOString(),
      until: null,
      note: null,
      by: null,
    });
    expect(await refusal(api.startPasswordReset(owner.access_token, 'sara'))).toMatchObject({
      status: 409,
      code: 'locked',
      message:
        "Sara's sign-in is waiting after a restore. Turn it back on first, then reset their password.",
    });
    expect((await api.memberAccount(owner.access_token, 'sara')).reset_path).toBeNull();
  });
});
