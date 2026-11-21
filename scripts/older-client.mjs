// The client contract, run with the client a phone already released carries (5.2).
//
// The phone app is released rarely and lives in people's pockets for
// months, pinned to the @fdv/client of one vault tag. Each phone release's
// row in apps/api/src/phone-apps.json says which: app version -> vault tag.
// This takes packages/client/src as it was at that tag and runs
// apps/api/src/client-contract.test.ts with it against the server of this
// commit, sending that app's User-Agent: a server change that would break
// a phone fails here, before any vault is upgraded.
//
//   node scripts/older-client.mjs --all-supported   every app at or above the
//                                                   table's min_client_version,
//                                                   each tag once (CI)
//   node scripts/older-client.mjs                   one tag: OLDER_CLIENT_REF, or
//                                                   the oldest supported app's
//   OLDER_CLIENT_REF=v0.9.0-dev.61 node scripts/older-client.mjs
//
// A server change that breaks a supported app fails --all-supported until it
// is fixed, or until min_client_version in phone-apps.json is raised — on
// purpose, since every phone below it is then told to update (426
// app_update_required) on its next call. Every phone release adds its row
// to phone-apps.json, with the exact tag its vendor/fdv submodule points at
// (not the release it was meant for: the commit the app was built with).
// Apps that share a tag share a run, which sends the oldest one's User-Agent.
//
// An older client's run leaves out only the scenarios a later release
// changed on purpose — a connected app's (which the phone never is), and
// the first negotiation's made-up app version — each listed, with its release
// and why, in CHANGED_ON_PURPOSE in client-contract.test.ts. Never add one
// there to make a phone's scenario pass: fix the server, or raise the minimum.
//
// Every tag's client is extracted side by side, and one vitest run takes
// them all as projects of one install, in parallel.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const into = join(root, '.older-client');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
// Git by its arguments, not through a shell: cmd.exe eats the ^ in ref^{commit}.
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();

const table = JSON.parse(readFileSync(join(root, 'apps/api/src/phone-apps.json'), 'utf8'));
const core = (v) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
const atLeast = (a, b) => {
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
};
const supported = table.apps.filter((a) => atLeast(a.app, table.min_client_version));
if (!supported.length) throw new Error('phone-apps.json: no app at or above min_client_version');

/** The apps whose client is at a tag, oldest first. */
const appsAt = (ref, apps) =>
  apps
    .filter((a) => a.vault_tag === ref)
    .map((a) => a.app)
    .sort((a, b) => (atLeast(a, b) ? (atLeast(b, a) ? 0 : 1) : -1));

let refs;
if (process.argv.includes('--all-supported')) {
  refs = [...new Set(supported.map((a) => a.vault_tag))].map((ref) => ({
    ref,
    apps: appsAt(ref, supported),
  }));
} else {
  const ref = process.env.OLDER_CLIENT_REF ?? supported.at(-1).vault_tag;
  // The apps whose client this is, when the table knows the tag: the oldest's User-Agent is sent.
  refs = [{ ref, apps: appsAt(ref, table.apps) }];
}

rmSync(into, { recursive: true, force: true });
const manifest = [];
for (const { ref, apps } of refs) {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    // A shallow CI checkout has no tags: fetch just this one.
    git('fetch', '--quiet', '--depth=1', 'origin', 'tag', ref);
  }
  const dir = join(into, ref);
  mkdirSync(dir, { recursive: true });
  // git archive and tar ship with git on every platform CI and developers use.
  // Extracted from inside the folder, so no path with a drive letter reaches
  // tar: GNU tar (Git Bash's) reads "C:" as a remote host.
  execSync(`git -C "${root}" archive --format=tar ${ref} packages/client/src | tar -x`, {
    cwd: dir,
    stdio: 'inherit',
  });
  console.log(
    `client contract with @fdv/client as at ${ref} (${git('rev-parse', '--short', `${ref}^{commit}`)})` +
      (apps.length ? `, the client of phone app ${apps.join(' and ')}` : ''),
  );
  manifest.push({ ref, apps, app: apps[0] ?? null });
}
writeFileSync(join(into, 'runs.json'), JSON.stringify(manifest, null, 2));

run('pnpm exec vitest run --config apps/api/vitest.older-client.config.ts');
