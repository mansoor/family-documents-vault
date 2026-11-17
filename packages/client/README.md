# @fdv/client

The API client for [Family Document Vault](https://github.com/mansoor/family-documents-vault):
the one the vault's own web and phone apps use, the signer a **connected app** needs, and a
fake vault to test against. MIT, written in TypeScript, and platform-neutral: no DOM and
no Node APIs, so it runs in a browser, in React Native and in Node 22 or later (it needs
the global `crypto`, with Web Crypto's Ed25519 for signing).

| Import                         | What it is                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `@fdv/client`                  | The API client (`createHttp`, `createApi`), its errors, retries and helpers.     |
| `@fdv/client/apps`             | A connected app's client (`createAppClient`) and signer (`signRequest`).         |
| `@fdv/client/testing`          | `createFakeVault()`, an in-memory vault that answers as the real one does.       |
| `@fdv/client/testing/contract` | `contractScenarios`: what the fake and the real vault are both held to (vitest). |

## Installing

It is not on npmjs.com. Each vault release attaches the client of that release to its
[GitHub release](https://github.com/mansoor/family-documents-vault/releases), as
`fdv-client-<version>.tgz`; install it by that URL, pinned to the version:

```json
{
  "dependencies": {
    "@fdv/client": "https://github.com/mansoor/family-documents-vault/releases/download/v0.9.0-dev.59/fdv-client-0.9.0-dev.59.tgz"
  }
}
```

or `npm install <url>` / `pnpm add <url>`. No token is needed, from CI too. The client's
version is the vault release it came with. It needs one package from npm, `libphonenumber-js`
(MIT), for the fake vault; the rest of what it uses is inside it.

It is **ESM only**, with TypeScript declarations behind `exports`: TypeScript needs
`"moduleResolution"` set to `node16`, `nodenext` or `bundler` to find `@fdv/client/apps` and
the other entries (`node`/`node10` does not read `exports`). It says `sideEffects: false`, so
a bundler keeps only what an app uses.

## Signing requests as a connected app

The vault's owner connects the app in _Settings → Connected apps_, pasting the app's public
key, and gets a connection string (`fdvapp1.…`) to paste into the app. Every request the app
makes is signed with its Ed25519 private key (HTTP Message Signatures, RFC 9421, with a
`Content-Digest`), through Web Crypto: Node 22, and browsers that have Ed25519.

```ts
import { createAppClient, parseConnectionString } from '@fdv/client/apps';

const c = parseConnectionString(process.env.VAULT_CONNECTION!);
const vault = createAppClient({
  baseUrl: c.url,
  appId: c.app_id,
  keyId: c.key_id,
  privateKey: process.env.VAULT_PRIVATE_KEY!, // a PEM "PRIVATE KEY" (PKCS#8) block
  fetch: (url, init) => fetch(url, init),
});

const me = await vault.me(); // what this app may do
await vault.send({
  externalId: 'invoice-2026-11',
  hints: { kind: 'utility_bill' },
  file: { bytes, filename: 'invoice.pdf', contentType: 'application/pdf' },
});
const state = await vault.status('invoice-2026-11'); // waiting, filed, refused or removed
```

`signRequest({ method, target, body, keyid, privateKey })` gives the three headers
(`content-digest`, `signature-input`, `signature`) for a request made any other way.

## Testing against the fake vault

```ts
import { createApi, createHttp } from '@fdv/client';
import { createAppClient } from '@fdv/client/apps';
import { createFakeVault } from '@fdv/client/testing';

const fake = createFakeVault();
const api = createApi(createHttp({ baseUrl: 'https://vault.test', fetch: fake.fetch }));
const owner = await api.setup({
  household_name: 'Test family',
  display_name: 'Owner',
  email: 'owner@example.test',
  password: 'a long enough password',
});
fake.state.ownerTwoStep = true; // connecting an app asks for a second step
const made = await api.connectedApps.create(owner.access_token, {
  name: 'My app',
  member_id: owner.member_id,
  public_key: 'ed25519:…', // the app's public key
  allowed_kinds: ['utility_bill'],
  scopes: ['documents.send'],
});
const app = createAppClient({
  baseUrl: 'https://vault.test',
  appId: made.id,
  keyId: made.keys[0]!.key_id,
  privateKey,
  fetch: fake.fetch,
});
```

The fake checks every signature as the vault does. The scenarios both the fake and the real
vault are held to, `contractScenarios`, are their own entry, `@fdv/client/testing/contract`:
they use vitest's `expect`, so that entry needs `vitest` installed (an optional peer
dependency, 5 or 6). Nothing else in the package does.

## Licence

MIT: see `LICENSE`. The vault itself is AGPL-3.0; nothing of it is in this package.
