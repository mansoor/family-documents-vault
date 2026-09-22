#!/usr/bin/env node
// Every bare import left in a bundled app must be a declared runtime
// dependency of that app, otherwise the Docker image (which installs only
// declared dependencies) fails at start with ERR_MODULE_NOT_FOUND.
// Usage: check-bundle-deps.mjs <app-dir>
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: check-bundle-deps.mjs <app-dir>');
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const missing = new Set();
for (const file of readdirSync(path.join(dir, 'dist')).filter((f) => f.endsWith('.mjs'))) {
  const src = readFileSync(path.join(dir, 'dist', file), 'utf8');
  for (const m of src.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || builtins.has(spec)) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!declared.has(name)) missing.add(name);
  }
}
if (missing.size) {
  console.error(
    `${pkg.name}: bundle imports packages not in "dependencies": ${[...missing].join(', ')}`,
  );
  process.exit(1);
}
console.log(`${pkg.name}: bundle dependencies OK`);
