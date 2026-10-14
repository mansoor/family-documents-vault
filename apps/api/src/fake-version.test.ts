import { readFile } from 'node:fs/promises';
import { createApi, createHttp } from '@fdv/client';
import { createFakeVault, FAKE_SERVER_VERSION } from '@fdv/client/testing';
import { describe, expect, it } from 'vitest';

/**
 * `@fdv/client`'s fake vault says it is the release this repository is
 * (the D1 review): an app that checks the vault's version, as the desktop
 * uploader does, works against it. A release that moves the version moves
 * this, or this fails.
 */
describe("the fake vault's version", () => {
  it('is the release the repository is, without its pre-release part', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(FAKE_SERVER_VERSION).toBe(pkg.version.replace(/-.*$/, ''));
    const { fetch } = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'http://fake.test', fetch }));
    expect((await api.capabilities()).server_version).toBe(FAKE_SERVER_VERSION);
  });
});
