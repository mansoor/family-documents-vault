#!/usr/bin/env node
// The client's release tarball, installed as an app installs it (CL1): by
// URL — served here on 127.0.0.1 at the path a GitHub release gives it —
// into an empty folder outside the workspace, by each package manager named
// (npm unless told: `client-smoke.mjs npm pnpm`), with nothing of the
// workspace to lean on. Then, from plain Node ESM, it imports `.`, `./apps`
// and `./testing` (without vitest; `./testing/contract`, which needs it, fails
// alone), builds an API key's header, and sends a file with a key an owner
// generated to the fake vault, which checks the key as the vault does; and tsc
// reads the declarations as an app's TypeScript would, without skipLibCheck.
// The package declares no peers (CL2), and nothing installs vitest; with
// vitest beside it, as an app keeps it in its devDependencies (the
// workspace's own, linked in: nothing downloaded), `./testing/contract`
// loads and its first scenarios run against the fake vault. Folders an
// earlier run left (killed before its clean-up) go first, links unfollowed.
//
// Run `pnpm client:pack` first. Usage: client-smoke.mjs [npm] [pnpm]
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const tarball = path.join(root, 'packages/client/dist', `fdv-client-${version}.tgz`);
if (!existsSync(tarball)) {
  console.error(`client-smoke: no ${tarball}; run pnpm client:pack first`);
  process.exit(1);
}
const managers = process.argv.slice(2).length ? process.argv.slice(2) : ['npm'];
const require = createRequire(import.meta.url);
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
/** The workspace's own vitest (the root's devDependency), its real folder. */
const vitest = realpathSync(path.join(root, 'node_modules', 'vitest'));

const SMOKE = `
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ApiRequestError, createApi, createHttp } from '@fdv/client';
import { basicAuthorization, createAppClient } from '@fdv/client/apps';
import * as testing from '@fdv/client/testing';
const { createFakeVault } = testing;
assert.ok(!('contractScenarios' in testing), 'the fake vault entry carries no contract');

const pkg = JSON.parse(readFileSync(new URL('./node_modules/@fdv/client/package.json', import.meta.url), 'utf8'));
assert.equal(pkg.version, ${JSON.stringify(version)});
// No peers, not even an optional one: nothing is linked or installed beside it.
for (const field of ['peerDependencies', 'peerDependenciesMeta', 'optionalDependencies']) {
  assert.equal(pkg[field], undefined, 'the package declares ' + field);
}
assert.ok(!existsSync(new URL('./node_modules/vitest', import.meta.url)), 'vitest was installed');

// An API key's header: Basic, base64 of the client ID and the secret.
const header = basicAuthorization('fdvc_AAECAwQFBgcICQoLDA0ODw', 'fdvs_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8');
assert.equal(Buffer.from(header.slice(6), 'base64').toString(), 'fdvc_AAECAwQFBgcICQoLDA0ODw:fdvs_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8');
assert.throws(() => basicAuthorization('fdvc_short', 'fdvs_short'));
console.log('header:', header.slice(0, 20) + '…');

// The fake vault: an owner connects an app and generates its API key; the
// app sends a file with it.
const fake = createFakeVault();
const api = createApi(createHttp({ baseUrl: 'https://vault.test', fetch: fake.fetch }));
const owner = await api.setup({
  household_name: 'Smoke test family',
  display_name: 'Owner',
  email: 'owner@example.test',
  password: 'a long enough password',
});
fake.state.ownerTwoStep = true;
const made = await api.connectedApps.create(owner.access_token, {
  name: 'Smoke test app',
  member_id: owner.member_id,
  allowed_kinds: ['utility_bill'],
  scopes: ['documents.send'],
});
const key = await api.connectedApps.generateKey(owner.access_token, made.id, {
  permissions: ['documents.send'],
  expires_in_days: 30,
});
assert.match(key.secret, /^fdvs_[A-Za-z0-9_-]{43}$/);
const app = createAppClient({
  url: 'https://vault.test',
  clientId: key.client_id,
  secret: key.secret,
  fetch: fake.fetch,
});
assert.equal((await app.me()).key.client_id, key.client_id);
const pdf = new TextEncoder().encode('%PDF-1.4\\n% smoke\\n%%EOF\\n');
const sent = await app.send({
  externalId: 'smoke-1',
  hints: { kind: 'utility_bill' },
  file: { bytes: pdf, filename: 'bill.pdf', contentType: 'application/pdf' },
});
assert.equal(sent.status, 201);
assert.equal((await app.status('smoke-1')).state, 'waiting');
console.log('fake vault: sent', sent.status, sent.state.state);

// A wrong secret: refused, as an ApiRequestError of the main entry (one
// copy of each module across the three entries).
const stranger = createAppClient({
  url: 'https://vault.test',
  clientId: key.client_id,
  secret: 'fdvs_' + 'A'.repeat(43),
  fetch: fake.fetch,
});
await assert.rejects(
  stranger.me(),
  (e) => e instanceof ApiRequestError && e.status === 401 && e.code === 'app_key_invalid',
);
console.log('fake vault: a wrong secret refused (401)');

// The contract scenarios are their own entry, the only one that needs vitest:
// here, without it, that entry alone fails to load.
await assert.rejects(import('@fdv/client/testing/contract'), (e) => e.code === 'ERR_MODULE_NOT_FOUND' && /vitest/.test(e.message));
console.log('testing/contract: needs vitest, and nothing else does');
console.log('smoke test passed');
`;

/** With vitest beside it, as an app has it: the contract entry loads, and its first scenarios run on the fake. */
const CONTRACT = `
import assert from 'node:assert/strict';
import { createApi, createHttp } from '@fdv/client';
import { createFakeVault } from '@fdv/client/testing';
import { contractScenarios } from '@fdv/client/testing/contract';

assert.ok(Array.isArray(contractScenarios) && contractScenarios.length > 10);
const fake = createFakeVault();
const api = createApi(createHttp({ baseUrl: 'https://vault.test', fetch: fake.fetch }));
const ctx = { email: 'owner@example.test', password: 'a long enough password', fetch: fake.fetch };
// From a new vault to a stolen refresh token: they ask nothing of ctx but these.
for (const s of contractScenarios.slice(0, 5)) {
  await s.run(api, ctx);
  console.log('contract on the fake:', s.name);
}
console.log('testing/contract: loads and runs with vitest beside it');
`;

const CHECK_TS = `
import { ApiRequestError, createApi, createHttp, type FetchLike } from '@fdv/client';
import { basicAuthorization, createAppClient, type AppClient } from '@fdv/client/apps';
import { createFakeVault } from '@fdv/client/testing';
import { contractScenarios, type Scenario } from '@fdv/client/testing/contract';

declare const fetchLike: FetchLike;
const api = createApi(createHttp({ baseUrl: 'https://vault.test', fetch: fetchLike }));
const app: AppClient = createAppClient({
  url: 'https://vault.test',
  clientId: 'fdvc_AAAAAAAAAAAAAAAAAAAAAA',
  secret: 'fdvs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  fetch: fetchLike,
});
export const h: string = basicAuthorization('', '');
export const v = createFakeVault().state;
export const n: Scenario[] = contractScenarios;
export const e: ApiRequestError | null = null;
export { api, app };
`;

/**
 * A command, waited for without blocking: the server below answers the
 * install meanwhile. npm.cmd and pnpm.cmd on Windows need a shell (nothing
 * passed has a space in it).
 */
const run = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32' && cmd !== process.execPath,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')}: exit ${code}`)),
    );
  });

// The tarball at the path its GitHub release serves it from.
const bytes = readFileSync(tarball);
const asset = `/mansoor/family-documents-vault/releases/download/v${version}/fdv-client-${version}.tgz`;
const server = createServer((req, res) => {
  if (req.url !== asset) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${asset}`;
console.log(`client-smoke: installing ${url}`);

/**
 * A smoke test's folder removed: the link to the workspace's vitest first,
 * alone and never followed (not recursive: a junction or a symlink goes,
 * what it points at stays), then the folder.
 */
function removeSmokeFolder(dir) {
  const link = path.join(dir, 'node_modules', 'vitest');
  try {
    if (lstatSync(link).isSymbolicLink()) rmSync(link, { force: true });
  } catch {
    // Never linked.
  }
  rmSync(dir, { recursive: true, force: true });
}

// What an earlier run left, killed before its own clean-up: never a link
// into the workspace's vitest left lying about.
for (const name of readdirSync(os.tmpdir())) {
  if (name.startsWith('fdv-client-smoke-')) removeSmokeFolder(path.join(os.tmpdir(), name));
}

try {
  for (const pm of managers) await smoke(pm);
} finally {
  server.close();
}
console.log(`\nclient-smoke: fdv-client-${version}.tgz works with ${managers.join(' and ')}`);

async function smoke(pm) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fdv-client-smoke-${pm}-`));
  console.log(`\n== ${pm}: ${dir}`);
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fdv-client-smoke', private: true, type: 'module' }, null, 2),
    );
    if (pm === 'npm') await run('npm', ['install', '--no-audit', '--no-fund', url], dir);
    else if (pm === 'pnpm') await run('pnpm', ['add', url], dir);
    else throw new Error(`no such package manager here: ${pm}`);
    const deps = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies;
    if (deps?.['@fdv/client'] !== url) {
      throw new Error(`${pm} wrote @fdv/client as ${deps?.['@fdv/client']}, not its URL`);
    }

    writeFileSync(path.join(dir, 'smoke.mjs'), SMOKE);
    await run(process.execPath, ['smoke.mjs'], dir);

    writeFileSync(path.join(dir, 'check.ts'), CHECK_TS);
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['check.ts'],
      }),
    );
    await run(process.execPath, [tsc, '-p', 'tsconfig.json'], dir);
    console.log(`${pm}: the declarations typecheck`);

    // vitest beside it, as an app keeps it in its own devDependencies: the
    // workspace's, linked in (a junction on Windows needs no privilege).
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    symlinkSync(vitest, path.join(dir, 'node_modules', 'vitest'), 'junction');
    writeFileSync(path.join(dir, 'contract.mjs'), CONTRACT);
    await run(process.execPath, ['contract.mjs'], dir);
  } finally {
    removeSmokeFolder(dir);
  }
  if (!existsSync(path.join(vitest, 'package.json'))) {
    throw new Error('the workspace’s vitest went with the smoke test’s folder');
  }
}
