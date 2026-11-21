// The tests a change can reach, not the whole suite: the local check
// before a commit. CI still runs everything on the pull request.
//
//   node scripts/test-focused.mjs [base]       changes since base (default origin/develop),
//                                              committed or not
//   node scripts/test-focused.mjs --list       say what would run and why, run nothing
//   node scripts/test-focused.mjs --full       the whole suite and every client step
//   node scripts/test-focused.mjs --with-slow  include the tests kept for CI (SLOW below)
//
// What it runs: lint on the changed files, typecheck everywhere (the net for
// a change that reaches further than the tests picked), then vitest on
//   - test files changed;
//   - tests named after a changed file (x.ts -> x.test.ts, x-*.test.ts);
//   - tests that import a changed file, or import a file that does, up to
//     DEPTH relative imports away. A file most tests import (the API's app,
//     a test harness) is a hub: of its importers, only the tests that
//     mention a word from the changed lines;
//   - for a changed file in a package (@fdv/db, @fdv/shared, ...): tests
//     that use one of the exports whose code changed, and the tests of
//     source files elsewhere that do;
//   - for a dependency added, removed or moved in a project's package.json:
//     the tests reaching the files that import it;
//   - for a changed file that is not code (SQL, nginx.conf, index.html,
//     ...): tests that name it, and for a migration, the migration tests;
// and the client steps only when the client, shared or the API changed.
// The root package.json's dependencies, the lockfile with no package.json
// moved, or a test or TypeScript config: everything.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const base = args.find((a) => !a.startsWith('--')) ?? 'origin/develop';
const DEPTH = 2;
const HUB = 25; // a file with more importers than this is a hub
const RARE = 8; // a word in more tests than this says nothing about them

// Kept for CI: too slow on a developer's machine to be worth the wait.
const SLOW = ['apps/worker/src/jobs/restore.test.ts'];
// Always run when a migration changes.
const MIGRATION_TESTS = [
  'packages/db/src/migrate.test.ts',
  'packages/db/src/row-security.test.ts',
  'packages/db/src/definer-and-walls.test.ts',
  'packages/db/src/privileges.test.ts',
];

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const lines = (s) =>
  s
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim());
const read = (f) => readFileSync(join(root, f), 'utf8');

const mergeBase = git('merge-base', base, 'HEAD');
const changed = [
  ...new Set([
    ...lines(git('diff', '--name-only', mergeBase)), // committed and uncommitted
    ...lines(git('ls-files', '--others', '--exclude-standard')),
  ]),
].filter((f) => existsSync(join(root, f)));

const isTest = (f) => /\.test\.(ts|tsx)$/.test(f);
const isCode = (f) => /\.(ts|tsx|mts|mjs|js)$/.test(f) && !f.endsWith('.d.ts');
const inProject = (f) => /^(apps|packages)\/[^/]+\//.test(f);

const tracked = lines(git('ls-files', 'apps', 'packages'));
const tests = tracked.filter((f) => isTest(f) && inProject(f));
const sources = tracked.filter((f) => isCode(f) && !isTest(f) && inProject(f));
const known = new Set([...tests, ...sources]);

const texts = new Map();
const textOf = (f) => {
  if (!texts.has(f)) texts.set(f, existsSync(join(root, f)) ? read(f) : '');
  return texts.get(f);
};
const diffOf = (f) => git('diff', '-U0', mergeBase, '--', f);

// Why each test was picked, for --list.
const picked = new Map();
const pick = (t, why) => {
  if (!picked.has(t)) picked.set(t, why);
};

let full = flag('--full');
let fullWhy = full ? '--full' : '';
for (const f of changed) {
  if (full) break;
  const lockOnly = f === 'pnpm-lock.yaml' && !changed.some((g) => g.endsWith('package.json'));
  if (lockOnly || /(^|\/)vitest\.config\.\w+$/.test(f) || /^tsconfig.*\.json$/.test(f)) {
    full = true;
    fullWhy = f;
  } else if (f === 'package.json') {
    const moved = lines(diffOf(f)).filter((l) => /^[+-]\s/.test(l) && !/"version"\s*:/.test(l));
    if (moved.length) {
      full = true;
      fullWhy = 'package.json (more than its version)';
    }
  }
}

// Imports, both ways.
const SPEC = /(?:from\s*|import\s*\(\s*|import\s+|vi\.mock\(\s*|require\(\s*)['"]([^'"]+)['"]/g;
const specsOf = (f) => [...textOf(f).matchAll(SPEC)].map((m) => m[1]);
const resolveRel = (from, spec) => {
  const p = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.(js|jsx|mjs)$/, '');
  for (const c of [
    p,
    `${p}.ts`,
    `${p}.tsx`,
    `${p}.mts`,
    `${p}.mjs`,
    `${p}/index.ts`,
    `${p}/index.tsx`,
  ])
    if (known.has(c)) return c;
  return null;
};
const importers = new Map();
for (const f of known) {
  for (const spec of specsOf(f)) {
    if (!spec.startsWith('.')) continue;
    const to = resolveRel(f, spec);
    if (!to) continue;
    if (!importers.has(to)) importers.set(to, new Set());
    importers.get(to).add(f);
  }
}
const testImporters = (f) => [...(importers.get(f) ?? [])].filter(isTest);

const stemOf = (f) => basename(f).replace(/\.(test\.)?(ts|tsx|mts|mjs|js)$/, '');
const siblingsOf = (f) => {
  const dir = posix.dirname(f);
  const stem = stemOf(f);
  return tests.filter(
    (t) =>
      posix.dirname(t) === dir &&
      (stemOf(t) === stem || stemOf(t).startsWith(`${stem}-`) || stemOf(t).startsWith(`${stem}.`)),
  );
};

// Words on a file's changed lines: identifiers and string contents worth
// searching for (route paths, error codes, function names).
const COMMON = new Set(
  'const await return async function export import from string number boolean undefined false true null value error result request reply status assert expect'.split(
    ' ',
  ),
);
const wordsOf = (f) => {
  const out = new Set();
  for (const l of lines(diffOf(f))) {
    if (!/^[+-][^+-]/.test(l) || /^\s*[+-]\s*(\/\/|\*)/.test(l)) continue;
    for (const m of l.slice(1).matchAll(/[A-Za-z_$/][\w$/-]{4,}/g)) {
      const w = m[0].replace(/^\/+|\/+$/g, '');
      if (w.length >= 5 && !COMMON.has(w)) out.add(w);
    }
  }
  return [...out];
};

// From a changed source file: its sibling tests, then up the importers.
const walk = (start, why) => {
  let frontier = [start];
  const seen = new Set(frontier);
  for (let d = 0; d <= DEPTH && frontier.length; d++) {
    const next = [];
    for (const f of frontier) {
      if (isTest(f)) pick(f, why);
      for (const t of siblingsOf(f)) pick(t, why);
      if (d === DEPTH) continue;
      const ups = [...(importers.get(f) ?? [])];
      if ((importers.get(f)?.size ?? 0) > HUB) {
        // A hub: its tests that mention what changed, and no further up.
        if (f !== start) continue;
        // Only words few tests use: "detail" or "server" would pick them all.
        const words = wordsOf(f).filter(
          (w) => tests.filter((t) => textOf(t).includes(w)).length <= RARE,
        );
        for (const t of ups.filter(isTest)) {
          const hit = words.find((w) => textOf(t).includes(w));
          if (hit) pick(t, `${why}, mentions ${hit}`);
        }
        continue;
      }
      for (const i of ups) {
        if (!seen.has(i)) {
          seen.add(i);
          next.push(i);
        }
      }
    }
    frontier = next;
  }
};

const packageOf = (f) => {
  const m = /^packages\/([^/]+)\//.exec(f);
  if (!m) return null;
  const pj = join(root, 'packages', m[1], 'package.json');
  return existsSync(pj) ? JSON.parse(readFileSync(pj, 'utf8')).name : null;
};
const EXPORT =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
// The exported names whose part of the file changed: an export owns the
// lines from its own to the next export's.
const changedExports = (f) => {
  const text = textOf(f);
  const at = [...text.matchAll(EXPORT)].map((m) => ({
    name: m[1],
    line: text.slice(0, m.index).split('\n').length,
  }));
  const diff = diffOf(f);
  if (!diff) return [...new Set(at.map((e) => e.name))]; // a new file
  const touched = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => {
    const start = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    return [start, start + Math.max(n, 1) - 1];
  });
  const names = new Set();
  at.forEach((e, i) => {
    const end = i + 1 < at.length ? at[i + 1].line - 1 : Infinity;
    if (touched.some(([a, b]) => a <= end && b >= e.line)) names.add(e.name);
  });
  return [...names];
};

if (!full) {
  for (const f of changed) {
    if (isTest(f) && inProject(f)) {
      pick(f, 'changed');
      continue;
    }
    if (isCode(f) && inProject(f)) {
      walk(f, `reaches ${f}`);
      // A package's file is used by name from elsewhere.
      const pkg = packageOf(f);
      const names = pkg ? changedExports(f).filter((n) => n.length > 3) : [];
      if (names.length) {
        const word = new RegExp(`\\b(${names.join('|')})\\b`);
        const own = `packages/${f.split('/')[1]}/`;
        for (const s of known) {
          if (s.startsWith(own)) continue;
          const text = textOf(s);
          if (!text.includes(pkg)) continue;
          const hit = word.exec(text);
          if (!hit) continue;
          if (isTest(s)) pick(s, `uses ${hit[1]} (${f})`);
          else
            for (const t of [...siblingsOf(s), ...testImporters(s)])
              pick(t, `uses ${hit[1]} via ${s}`);
        }
      }
      continue;
    }
    const m = /^((?:apps|packages)\/[^/]+\/)package\.json$/.exec(f);
    if (m) {
      // The dependencies added, removed or moved: whatever imports them.
      for (const l of lines(diffOf(f))) {
        const d = /^[+-]\s*"([^"]+)"\s*:\s*"[\^~]?(?:\d|\*|workspace)/.exec(l);
        if (!d || d[1] === 'version') continue;
        for (const s of known)
          if (s.startsWith(m[1]) && specsOf(s).some((x) => x === d[1] || x.startsWith(`${d[1]}/`)))
            walk(s, `imports ${d[1]}`);
      }
      continue;
    }
    // Not code: tests that name the file.
    const name = basename(f);
    if (f.startsWith('packages/db/migrations/'))
      for (const t of MIGRATION_TESTS) if (tests.includes(t)) pick(t, `migration ${name}`);
    if (name.length > 4 && !['package.json', 'README.md', 'CHANGELOG.md'].includes(name)) {
      const stem = name.replace(extname(name), '');
      // In the file's own project (if it has one); a name many tests use
      // (index.html) only where a test reads a file.
      const project = /^(apps|packages)\/[^/]+\//.exec(f)?.[0] ?? '';
      let hits = tests.filter(
        (t) => t.startsWith(project) && (textOf(t).includes(name) || textOf(t).includes(stem)),
      );
      if (hits.length > RARE) hits = hits.filter((t) => /readFile/.test(textOf(t)));
      for (const t of hits) pick(t, `names ${name}`);
    }
  }
}

let skipped = [];
if (!full && !flag('--with-slow')) {
  skipped = [...picked.keys()].filter((t) => SLOW.includes(t));
  for (const t of skipped) picked.delete(t);
}

const touches = (re) => changed.some((f) => re.test(f) && !isTest(f));
const olderClient = full || touches(/^(packages\/(client|shared)|apps\/api)\//);
const packClient = full || touches(/^packages\/(client|shared)\//);

console.log(`Changed since ${base} (${mergeBase.slice(0, 7)}): ${changed.length} files`);
if (full) console.log(`Running everything: ${fullWhy}`);
else {
  console.log(`Tests picked: ${picked.size} of ${tests.length}`);
  for (const [t, why] of [...picked].sort()) console.log(`  ${t}  <- ${why}`);
  for (const t of skipped) console.log(`  (left to CI: ${t}; --with-slow runs it)`);
}
console.log(
  `Client steps: older client ${olderClient ? 'yes' : 'no'}, pack and smoke ${packClient ? 'yes' : 'no'}`,
);
if (flag('--list')) process.exit(0);

const run = (cmd, env = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
};
const quote = (fs) => fs.map((f) => `"${f}"`).join(' ');

// Lint: the changed files (everything for --full); the MIT boundary always.
if (full) run('pnpm lint');
else {
  const lintable = changed.filter((f) => /\.(ts|tsx|mts|mjs|js|cjs)$/.test(f));
  if (lintable.length) run(`pnpm exec eslint ${quote(lintable)}`);
  run(`pnpm exec prettier --check --ignore-unknown ${quote(changed)}`);
  run('node scripts/check-mit-boundary.mjs');
}
run('pnpm typecheck');

if (full) run('pnpm exec vitest run --maxWorkers=3');
else if (picked.size) {
  const list = [...picked.keys()];
  // Windows keeps a command line under 32k characters.
  for (let i = 0; i < list.length; i += 120)
    run(`pnpm exec vitest run --maxWorkers=3 ${quote(list.slice(i, i + 120))}`);
} else console.log('\nNo tests reach this change.');

if (olderClient) {
  run('pnpm test:older-client');
  run('pnpm test:older-client', { OLDER_CLIENT_REF: 'v0.5.11' });
}
if (packClient) {
  run('pnpm client:pack');
  run('pnpm client:smoke npm pnpm');
}
console.log('\nFOCUSED-GATE-PASSED');
