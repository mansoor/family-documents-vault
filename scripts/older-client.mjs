// The client contract, run with the client an older phone carries (5.2).
//
// The phone app is released rarely and lives in people's pockets for
// months, pinned to the @fdv/client of one vault release (app 0.2.0: the
// client as tagged v0.5.0-rc.1). This takes packages/client/src as it was
// at that tag and runs apps/api/src/client-contract.test.ts with it against
// the server of this commit: a server change that would break that phone
// fails here, before any vault is upgraded.
//
//   node scripts/older-client.mjs            the phone's client (OLDER_CLIENT_REF)
//   OLDER_CLIENT_REF=v0.5.0 node scripts/older-client.mjs
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.env.OLDER_CLIENT_REF ?? 'v0.5.0-rc.1';
const into = join(root, '.older-client');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
// Git by its arguments, not through a shell: cmd.exe eats the ^ in ref^{commit}.
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();

try {
  git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
} catch {
  // A shallow CI checkout has no tags: fetch just this one.
  git('fetch', '--quiet', '--depth=1', 'origin', 'tag', ref);
}

rmSync(into, { recursive: true, force: true });
mkdirSync(into, { recursive: true });
// git archive and tar ship with git on every platform CI and developers use.
// Extracted from inside the folder, so no path with a drive letter reaches
// tar: GNU tar (Git Bash's) reads "C:" as a remote host.
execSync(`git -C "${root}" archive --format=tar ${ref} packages/client/src | tar -x`, {
  cwd: into,
  stdio: 'inherit',
});
console.log(
  `client contract with @fdv/client as at ${ref} (${git('rev-parse', '--short', `${ref}^{commit}`)})`,
);

run('pnpm exec vitest run --config apps/api/vitest.older-client.config.ts');
