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
});
