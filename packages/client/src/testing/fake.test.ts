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

  it('lists as the real vault keeps them for each role (0.5.12): a viewer sees none', async () => {
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
    const family = await api.createList(token, { name: 'Family', audience: 'everyone' });
    await api.addToList(token, family.id, [everyday.id, adults.id]);
    const grown = await api.createList(token, { name: 'Grown-ups', audience: 'adults' });
    // Made by somebody else, an adult: the fake signs in as one member only.
    vault.state.members.push({ id: 'sam', display_name: 'Sam', role: 'adult', is_me: false });
    for (const l of vault.state.lists) l.owner_member_id = 'sam';

    // A teen is given the list for everyone, and on it only what a teen may see.
    vault.state.role = 'teen';
    expect((await api.lists(token)).items.map((l) => l.name)).toEqual(['Family']);
    const seen = await api.getList(token, family.id);
    expect(seen.items.map((i) => i.document.id)).toEqual([everyday.id]);
    expect(seen.item_count).toBe(1);
    expect(await refusal(api.getList(token, grown.id))).toMatchObject({ status: 404 });
    expect(
      await refusal(api.createList(token, { name: 'For the adults', audience: 'adults' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });

    // A viewer, none at all, and makes none.
    vault.state.role = 'viewer';
    expect((await api.lists(token)).items).toEqual([]);
    expect(await refusal(api.getList(token, family.id))).toMatchObject({ status: 404 });
    expect((await api.documentLists(token, everyday.id)).items).toEqual([]);
    expect(
      await refusal(api.createList(token, { name: 'Mine', audience: 'everyone' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('a maker made a teen keeps their list to see and delete, not change; an owner deletes one nobody can change (the 5.14 review)', async () => {
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
    const grown = await api.createList(token, { name: 'Grown-ups', audience: 'adults' });
    await api.addToList(token, grown.id, [everyday.id, adults.id]);
    const family = await api.createList(token, { name: 'Family', audience: 'everyone' });

    // Its maker, made a teen: sees it, with what a teen may see on it.
    vault.state.role = 'teen';
    const seen = await api.getList(token, grown.id);
    expect(seen).toMatchObject({ mine: true, item_count: 1 });
    expect(seen.items.map((i) => i.document.id)).toEqual([everyday.id]);
    expect((await api.lists(token)).items.map((l) => l.name)).toEqual(['Family', 'Grown-ups']);
    // Changes it no more, while the one for everyone is still theirs to change.
    for (const change of [
      api.updateList(token, grown.id, { name: 'Taken back' }),
      api.addToList(token, grown.id, [everyday.id]),
      api.removeFromList(token, grown.id, everyday.id),
    ]) {
      expect(await refusal(change)).toMatchObject({ status: 403, code: 'forbidden' });
    }
    expect(await api.updateList(token, family.id, { name: 'Our family' })).toMatchObject({
      name: 'Our family',
    });
    // Made a viewer, deletes it all the same.
    vault.state.role = 'viewer';
    await api.deleteList(token, grown.id);
    expect(await refusal(api.getList(token, grown.id))).toMatchObject({ status: 404 });

    // An owner deletes a list whose maker has no sign-in, or is outside its
    // audience; never one whose maker can still change it.
    vault.state.role = 'owner';
    vault.state.members.push({ id: 'kim', display_name: 'Kim', role: 'teen', is_me: false });
    const theirs = async (name: string, maker: string, audience: 'adults' | 'everyone') => {
      const l = await api.createList(token, { name, audience });
      const kept = vault.state.lists.find((x) => x.id === l.id);
      if (kept) kept.owner_member_id = maker;
      return l.id;
    };
    const gone = await theirs('Gone', 'nobody-now', 'everyone');
    const outside = await theirs('Outside', 'kim', 'adults');
    const inside = await theirs('Inside', 'kim', 'everyone');
    await api.deleteList(token, gone);
    await api.deleteList(token, outside);
    expect(await refusal(api.deleteList(token, inside))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(await refusal(api.updateList(token, outside, { name: 'Mine' }))).toMatchObject({
      status: 404,
    });
  });

  it("pages a list's documents as the real vault does", async () => {
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
    const list = await api.createList(token, { name: 'Three', audience: 'everyone' });
    await api.addToList(token, list.id, ids);
    const first = await api.getList(token, list.id, { limit: 2 });
    expect(first).toMatchObject({ item_count: 3, has_more: true });
    expect(first.items.map((i) => i.document.id)).toEqual(ids.slice(0, 2));
    const rest = await api.getList(token, list.id, { limit: 2, cursor: first.next_cursor });
    expect(rest).toMatchObject({ item_count: 3, has_more: false, next_cursor: null });
    expect(rest.items.map((i) => i.document.id)).toEqual(ids.slice(2));
    const bad = await api.getList(token, list.id, { cursor: 'nonsense' }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 422, code: 'validation_failed' });
  });
});
