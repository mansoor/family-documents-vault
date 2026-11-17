#!/usr/bin/env node
// Packs @fdv/client (MIT) as a tarball for a GitHub release (CL1):
// packages/client/dist/fdv-client-<version>.tgz, its version the vault's.
// An app installs it by the release's URL, with npm or pnpm and no token.
//
// The workspace keeps using the TypeScript source (packages/client's own
// package.json is untouched); this builds a separate package in
// packages/client/dist/package and packs that:
//
//  - dist/{index,apps,testing,testing/contract}.js: ESM for `.`, `./apps`,
//    `./testing` (the fake vault) and `./testing/contract` (the contract
//    scenarios, the only entry that imports vitest), bundled by esbuild,
//    with what they use of @fdv/shared (MIT, never published) inside, and
//    shared chunks so the entries share one copy of each module (an
//    ApiRequestError from one is an ApiRequestError of the other);
//  - dist/types: tsc's declarations, @fdv/shared's beside them in
//    dist/types/_shared, every `@fdv/shared` pointed there;
//  - README.md, and LICENSE (MIT, which @fdv/shared shares).
//
// It fails if anything but the two MIT packages' sources went in, if what
// is left to install is anything but their allowed packages
// (mit-packages.mjs) — nothing from apps/* or another package ever ships —
// if vitest is imported from anywhere but ./testing/contract, or if a
// module does anything as it loads (the package says `sideEffects: false`).
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { MIT, TEST_ONLY } from './mit-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'packages/client');
const shared = path.join(root, 'packages/shared');
const out = path.join(client, 'dist');
const stage = path.join(out, 'package');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const rootPkg = readJson(path.join(root, 'package.json'));
const clientPkg = readJson(path.join(client, 'package.json'));
const sharedPkg = readJson(path.join(shared, 'package.json'));
const version = rootPkg.version;
const vitestMajor = Number(/\d+/.exec(rootPkg.devDependencies.vitest)[0]);
const posix = (p) => p.split(path.sep).join('/');

function fail(message) {
  console.error(`client-pack: ${message}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// ------------------------------------------------------------ JavaScript

/**
 * `./testing` is the fake vault: src/testing/index.ts less the contract
 * scenarios, which use vitest's `expect` and are their own entry,
 * `./testing/contract`, the only one that needs vitest. Made from the
 * source's own list, so whatever it exports next is exported here too.
 */
const CONTRACT_LINE = /^export \* from '\.\/contract\.js';\r?\n/m;
function withoutContract(text, where) {
  if (!CONTRACT_LINE.test(text)) fail(`${where} no longer re-exports ./contract.js as expected`);
  return text.replace(CONTRACT_LINE, '');
}
const testingIndex = path.join(client, 'src/testing/index.ts');
const TESTING = withoutContract(readFileSync(testingIndex, 'utf8'), 'src/testing/index.ts');
if (/contract/.test(TESTING)) fail('src/testing/index.ts reaches the contract another way');

const ENTRIES = {
  index: 'src/index.ts',
  apps: 'src/apps.ts',
  testing: 'src/testing/index.ts',
  'testing/contract': 'src/testing/contract.ts',
};
const sharedSrc = posix(path.join(shared, 'src')) + '/';

const built = await build({
  absWorkingDir: root,
  entryPoints: {
    index: path.join(client, ENTRIES.index),
    apps: path.join(client, ENTRIES.apps),
    testing: 'fdv:testing',
    'testing/contract': path.join(client, ENTRIES['testing/contract']),
  },
  outdir: path.join(stage, 'dist'),
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  // No DOM and no Node: a browser, React Native and Node alike.
  platform: 'neutral',
  target: 'es2022',
  metafile: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'workspace-inside-rest-outside',
      setup(b) {
        b.onResolve({ filter: /^fdv:testing$/ }, () => ({ path: 'testing', namespace: 'fdv' }));
        b.onLoad({ filter: /.*/, namespace: 'fdv' }, () => ({
          contents: TESTING,
          loader: 'ts',
          resolveDir: path.dirname(testingIndex),
        }));
        // @fdv/shared's modules do nothing as they load (top-level
        // declarations alone), so one nothing uses is left out.
        b.onResolve({ filter: /.*/ }, async (args) => {
          if (args.pluginData?.inner) return undefined;
          const fromShared =
            posix(args.importer).startsWith(sharedSrc) && args.path.startsWith('.');
          if (args.path !== '@fdv/shared' && !fromShared) return undefined;
          const r = await b.resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
            pluginData: { inner: true },
          });
          if (r.errors.length) return { errors: r.errors };
          return { path: r.path, sideEffects: false };
        });
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          // A Windows path (C:\…) is no package.
          if (args.kind === 'entry-point' || path.isAbsolute(args.path)) return undefined;
          if (args.path.startsWith('@fdv/')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

// Only the two MIT packages' own sources went in, and no test.
const sources = [posix(path.join(client, 'src')) + '/', sharedSrc];
for (const input of Object.keys(built.metafile.inputs)) {
  if (input === 'fdv:testing') continue;
  const full = posix(path.resolve(root, input));
  if (!sources.some((s) => full.startsWith(s)) || /\.test\.[cm]?[jt]sx?$/.test(full)) {
    fail(`the bundle took in ${input}: only packages/client/src and packages/shared/src may go in`);
  }
}

// `sideEffects: false` (in the bundle for @fdv/shared, and in package.json)
// holds while every module's top level only imports, exports and declares:
// a statement there that does anything else (a call, a loop, an
// assignment) fails here. What a declaration's value computes stays its own.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const DECLARATIONS = new Set(
  [
    'ImportDeclaration',
    'ImportEqualsDeclaration',
    'ExportDeclaration',
    'VariableStatement',
    'FunctionDeclaration',
    'ClassDeclaration',
    'InterfaceDeclaration',
    'TypeAliasDeclaration',
    'EnumDeclaration',
    'ModuleDeclaration',
    'EmptyStatement',
  ].map((k) => ts.SyntaxKind[k]),
);
for (const input of Object.keys(built.metafile.inputs)) {
  if (input === 'fdv:testing') continue;
  const file = path.resolve(root, input);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022);
  for (const s of source.statements) {
    if (!DECLARATIONS.has(s.kind)) {
      const { line } = source.getLineAndCharacterOfPosition(s.getStart(source));
      fail(`${input}:${line + 1} does something as it loads (${ts.SyntaxKind[s.kind]})`);
    }
  }
}

// What is left to install: only the MIT packages' allowed packages, at the
// versions their package.json files ask for; vitest from the contract
// scenarios' own entry alone.
const allowed = new Set([...MIT['packages/client'], ...MIT['packages/shared']]);
const declared = { ...sharedPkg.dependencies, ...clientPkg.dependencies };
const dependencies = {};
let usesVitest = false;
const contractEntry = posix(path.relative(root, path.join(client, ENTRIES['testing/contract'])));
for (const output of Object.values(built.metafile.outputs)) {
  for (const imp of output.imports) {
    if (!imp.external) continue;
    const name = imp.path.startsWith('@')
      ? imp.path.split('/').slice(0, 2).join('/')
      : imp.path.split('/')[0];
    if (TEST_ONLY.has(name)) {
      if (output.entryPoint !== contractEntry) {
        fail(
          `'${imp.path}' is imported outside ./testing/contract (${output.entryPoint ?? 'a chunk'})`,
        );
      }
      usesVitest = true;
      continue;
    }
    if (name.startsWith('@fdv/') || !allowed.has(name)) {
      fail(`the bundle still imports '${imp.path}', which the MIT packages may not use`);
    }
    const range = declared[name];
    if (!range || range.startsWith('workspace:')) fail(`no version to ask for '${name}'`);
    dependencies[name] = range;
  }
}

// ---------------------------------------------------------- declarations

const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
const raw = path.join(out, 'types-raw');
const tsconfig = path.join(out, 'tsconfig.types.json');
writeFileSync(
  tsconfig,
  JSON.stringify(
    {
      extends: posix(path.relative(out, path.join(root, 'tsconfig.base.json'))),
      compilerOptions: {
        rootDir: posix(path.relative(out, path.join(root, 'packages'))),
        outDir: posix(path.relative(out, raw)),
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationMap: false,
        sourceMap: false,
        lib: ['ES2022'],
        types: [],
        // Its source, not node_modules' link to it: tsc makes no
        // declarations for what it finds through node_modules.
        paths: {
          '@fdv/shared': [posix(path.relative(out, path.join(shared, 'src', 'index.ts')))],
        },
      },
      files: [...Object.values(ENTRIES), 'src/globals.d.ts'].map((f) =>
        posix(path.relative(out, path.join(client, f))),
      ),
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, [tsc, '-p', tsconfig], { stdio: 'inherit' });

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

for (const dir of readdirSync(raw)) {
  if (dir !== 'client' && dir !== 'shared') fail(`declarations were made for packages/${dir}`);
  for (const sub of readdirSync(path.join(raw, dir))) {
    if (sub !== 'src') fail(`declarations were made for packages/${dir}/${sub}`);
  }
}
const types = path.join(stage, 'dist', 'types');
renameSync(path.join(raw, 'client', 'src'), types);
renameSync(path.join(raw, 'shared', 'src'), path.join(types, '_shared'));
rmSync(raw, { recursive: true, force: true });
rmSync(tsconfig);

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g;
for (const file of files(types)) {
  const inShared = posix(file).includes('/dist/types/_shared/');
  let text = readFileSync(file, 'utf8');
  text = text.replace(SPECIFIER, (whole, lead, quote, spec) => {
    if (spec.startsWith('.')) return whole;
    if (spec === '@fdv/shared' && !inShared) {
      let rel = posix(path.relative(path.dirname(file), path.join(types, '_shared', 'index.js')));
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return `${lead}${quote}${rel}${quote}`;
    }
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (name in dependencies || TEST_ONLY.has(name)) return whole;
    fail(`${posix(path.relative(stage, file))} refers to '${spec}'`);
    return whole;
  });
  writeFileSync(file, text);
}
// `./testing`'s declarations, as its JavaScript: without the contract.
const testingTypes = path.join(types, 'testing', 'index.d.ts');
writeFileSync(
  testingTypes,
  withoutContract(readFileSync(testingTypes, 'utf8'), 'dist/types/testing/index.d.ts'),
);

// --------------------------------------------------------------- package

const licence = readFileSync(path.join(client, 'LICENSE'), 'utf8');
if (!licence.startsWith('MIT License')) fail('packages/client/LICENSE is not the MIT licence');
if (readFileSync(path.join(shared, 'LICENSE'), 'utf8') !== licence) {
  fail('packages/shared/LICENSE differs from the client’s: ship both');
}
copyFileSync(path.join(client, 'LICENSE'), path.join(stage, 'LICENSE'));
copyFileSync(path.join(client, 'README.md'), path.join(stage, 'README.md'));

const entry = (name, dts) => ({ types: `./dist/types/${dts}`, default: `./dist/${name}.js` });
const pkg = {
  name: clientPkg.name,
  version,
  description:
    'The Family Document Vault API client: the connected-apps signer (Ed25519, RFC 9421) and a fake vault to test against. Platform-neutral: no DOM, no Node.',
  license: 'MIT',
  type: 'module',
  repository: { ...rootPkg.repository, directory: 'packages/client' },
  homepage: 'https://github.com/mansoor/family-documents-vault#connected-apps',
  main: './dist/index.js',
  types: './dist/types/index.d.ts',
  exports: {
    '.': entry('index', 'index.d.ts'),
    './apps': entry('apps', 'apps.d.ts'),
    './testing': entry('testing', 'testing/index.d.ts'),
    './testing/contract': entry('testing/contract', 'testing/contract.d.ts'),
    './package.json': './package.json',
  },
  files: ['dist', 'README.md', 'LICENSE'],
  // The global crypto, with Web Crypto's Ed25519, for signing.
  engines: { node: '>=22' },
  // Every module only declares as it loads (checked above).
  sideEffects: false,
  dependencies,
  ...(usesVitest && {
    // The major the repository tests with, and the next.
    peerDependencies: { vitest: `>=${vitestMajor} <${vitestMajor + 2}` },
    peerDependenciesMeta: { vitest: { optional: true } },
  }),
};
const manifest = JSON.stringify(pkg, null, 2) + '\n';
if (manifest.includes('workspace:')) fail('a workspace: version is left in package.json');
writeFileSync(path.join(stage, 'package.json'), manifest);

// npm pack, as npm and pnpm both install a tarball: npm.cmd on Windows
// needs a shell, so nothing with a space in it is passed (`..` is `out`).
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', '..'], {
    cwd: stage,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
)[0];
const tarball = path.join(out, packed.filename);
const want = `fdv-client-${version}.tgz`;
if (packed.filename !== want) fail(`packed ${packed.filename}, expected ${want}`);
console.log(
  `client-pack: ${posix(path.relative(root, tarball))} (${packed.entryCount} files, ${packed.size} bytes)`,
);
console.log(`  dependencies: ${JSON.stringify(dependencies)}`);
