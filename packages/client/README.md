# @fdv/client

The API client for [Family Document Vault](https://github.com/mansoor/family-documents-vault):
the one the vault's own web and phone apps use, the client a **connected app** needs, and a
fake vault to test against. MIT, written in TypeScript, and platform-neutral: no DOM and
no Node APIs, so it runs in a browser, in React Native and in Node 22 or later (it needs
the global `fetch` and `crypto`).

| Import                         | What it is                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `@fdv/client`                  | The API client (`createHttp`, `createApi`), its errors, retries and helpers.            |
| `@fdv/client/apps`             | A connected app's client (`createAppClient`), with its API key.                         |
| `@fdv/client/testing`          | `createFakeVault()`, an in-memory vault that answers as the real one does.              |
| `@fdv/client/testing/contract` | `contractScenarios`: what the fake and the real vault are both held to (vitest, yours). |

## Installing

It is not on npmjs.com. Each vault release attaches the client of that release to its
[GitHub release](https://github.com/mansoor/family-documents-vault/releases), as
`fdv-client-<version>.tgz`; install it by that URL, pinned to the version:

```json
{
  "dependencies": {
    "@fdv/client": "https://github.com/mansoor/family-documents-vault/releases/download/v0.9.0-dev.63/fdv-client-0.9.0-dev.63.tgz"
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

## A connected app's API key

An owner connects the app in _Settings → Connected apps_ and **generates an API key** for it
there: a client ID (`fdvc_…`) and a secret (`fdvs_…`). Each key has its own permissions (some
of what the app may do) and lasts 30, 90 or 365 days, a number of days the owner chooses
(1 to 3650), or never expires. The vault shows the secret **once** and keeps only a hash of
it, with a connection string (`fdvapp2.…`) to paste into the app; the owner may include the
secret in it. The app sends the key on every request as `Authorization: Basic
base64(client_id:secret)`; keep the secret as you would a password.

```ts
import { createAppClient, parseConnectionString } from '@fdv/client/apps';

const c = parseConnectionString(process.env.VAULT_CONNECTION!);
const vault = createAppClient({
  url: c.url,
  clientId: c.client_id,
  secret: c.secret ?? process.env.VAULT_SECRET!,
});

const me = await vault.me(); // what this app may do, and the key it used
await vault.send({
  externalId: 'invoice-2026-11',
  hints: { kind: 'utility_bill' },
  file: { bytes, filename: 'invoice.pdf', contentType: 'application/pdf' },
});
const state = await vault.status('invoice-2026-11'); // waiting, filed, refused or removed
```

`fetch` is the platform's own unless you pass one. `parseConnectionString` and
`createAppClient` both take an `https` address, and plain `http` only to this machine
(`localhost`, `127.0.0.1`, `[::1]`), on purpose: for a vault run locally while developing.
`createAppClient` throws for any other address, so the secret is never sent in the clear. A connection string made before API keys
(`fdvapp1.…`, from 0.9.0 development builds before dev.63, which signed requests) is refused
with what to do: generate an API key and paste its new connection string.

A request with no answer at all throws a `NetworkError` (`kind` `offline` or `timeout`),
never an `ApiRequestError`; what the platform's `fetch` threw is its standard `cause`, and
`detail` says it in a few words (`ECONNREFUSED`, or the error's message; never a message
with an address in it) for a log. The `cause` is passed through from `fetch` unchanged, and
may name the address asked, its query included: be careful logging it in full.

### Keys expire, and are replaced by an owner

An app never makes, renews or retires its own keys: only an owner generates and revokes them,
in Settings. `me().key` describes the key making the call (its client ID, name, permissions,
`created_at`, `expires_at`, or `null` when it never expires, and `last_used_at`), never the
app's other keys, so an app can **warn its own users before the key expires**; the vault
reminds its owners 14 days before, and again once it has. An app has two live keys at most,
so an owner can generate the next one and the app can move to it before the old one ends.
A request is refused `401 app_key_invalid` for a wrong secret or a client ID the vault does
not know (the same answer for both), `401 app_key_expired`, `401 app_key_revoked` (from the
very next request after an owner revokes it) or `401 app_revoked` (the app was removed); and
`403 scope_not_granted` for something the key's permissions, or the app's, do not allow. Ten
guesses a minute from one address — a client ID the vault does not know, or a wrong secret —
and the next waits (`429 rate_limited`); a revoked or expired key is refused without counting.
Basic authentication whose user is not a client ID (`fdvc_…`) is not an app's key — a proxy's
password in front of the vault, say — and the vault lets it pass on its own routes.

When an owner generates a new key that may do no more than a live one already may (moving to
a new key), an app acting as somebody else keeps working; a key that may do more waits for
that person to turn the app on again. Revoking a key ends the links it made for its user's
browser, opened or not, at their next request.

### What it sent, and the versions after

A document the app's send made stays the app's to read (`own: true`, with the `external_id`
of that send) while it is in the vault, out of the Trash and not Only me — even after the
family, or another app, adds newer versions: the feed says it `changed`, and `document(id)`
and `download(id)` (`GET /api/v1/apps/documents/{id}` and `…/content`) give it as it is now,
its newest file. The exact file the app sent is `sentFile(externalId)` (`GET
/api/v1/apps/intake/{external_id}/content`), whatever came after it. `delete(id)` (`DELETE
/api/v1/apps/documents/{id}`) is only for a document whose newest file is one the app sent:
never the family's newer file, nor another app's.

### API versioning

Every route is under `/api/v1/`. `GET /api/v1/apps/me` gives the vault's version
(`vault.server_version`), and `GET /api/v1/capabilities` its capability flags (`features`).
Every change is listed in the vault's `docs/api-changelog.md`. During the 0.9.0 development
builds a breaking change may still land inside v1, and the changelog marks it **breaking**.
From the 0.9.0 release on, a breaking change goes to a new path version (`/api/v2/…`), while
v1 keeps working for a stated deprecation period of at least 6 months.

`basicAuthorization(clientId, secret)` gives the `Authorization` header for a request made
any other way; `request()` on the client sends one of the app's own.

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
  name: 'Acme Money',
  member_id: owner.member_id,
  allowed_kinds: ['utility_bill'],
  scopes: ['documents.send'],
});
const key = await api.connectedApps.generateKey(owner.access_token, made.id, {
  permissions: ['documents.send'],
  expires_in_days: 90, // or null: never expires
});
const app = createAppClient({
  url: 'https://vault.test',
  clientId: key.client_id,
  secret: key.secret,
  fetch: fake.fetch,
});
fake.expireAppKey(key.client_id); // as time would: its next request is 401 app_key_expired
```

The fake checks every API key as the vault does, and keeps an app's keys by the vault's
rules: an owner's alone, two live at most, each with its permissions and expiry, revoked at
once. Generating or revoking a key asks for a passkey or a code: the fake's owner has none
until `fake.state.ownerTwoStep = true`. It keeps a file's bytes exactly as they were sent —
bytes, a stream, a Blob or a platform FormData — and gives back those bytes from every
download (an app's, its re-download of a send, and the family's `api.content`), so a hash
taken before and after agrees. The scenarios both the fake
and the real vault are held to, `contractScenarios`, are their own entry,
`@fdv/client/testing/contract`: they use vitest's `expect`, so to use that entry, keep
vitest in your app's own devDependencies, `npm install -D vitest@">=5 <7"` (or `pnpm add -D
vitest@">=5 <7"`). The package declares no dependency on vitest, not even an optional peer,
so it never reaches a production install; nothing else in it needs vitest.

## Licence

MIT: see `LICENSE`. The vault itself is AGPL-3.0; nothing of it is in this package.
