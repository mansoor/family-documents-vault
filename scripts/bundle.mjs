#!/usr/bin/env node
// Bundles one app entry point into a single ESM file.
// Workspace packages (@fdv/*) are inlined; everything else stays an external
// import resolved from node_modules at runtime.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: bundle.mjs <entry.ts> <outfile.mjs>');
  process.exit(2);
}

// The release this build is: the root package.json, which CI holds equal to
// the tag. Stamped in so the image reports it without reading a file.
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: [entry],
  define: { __FDV_VERSION__: JSON.stringify(version) },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'external-except-workspace',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@fdv/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
