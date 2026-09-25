#!/usr/bin/env node
// packages/shared and packages/client are MIT (each has its own LICENSE), so
// that any app, the official phone app included, can use them under any
// licence. That holds only while they take nothing from the AGPL code around
// them. This fails if either one:
//
//  - says any licence but MIT, or has lost its LICENSE file;
//  - depends on anything but what is allowed below;
//  - imports anything from outside its own folder, except those packages
//    (and vitest, in tests and the fake vault's contract only), or imports
//    from a path worked out at run time, which cannot be checked.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each MIT package, and the only packages it may use at run time. */
const MIT = {
  'packages/shared': [],
  'packages/client': ['@fdv/shared'],
};
/** Used by tests, and by the client's `testing` entry that tests import. */
const TEST_ONLY = new Set(['vitest']);

/**
 * The source with comments blanked out, strings and template text kept as
 * they are: a `//` inside a string is not a comment, and an import inside a
 * comment is not an import.
 */
function withoutComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
}

// Static imports and re-exports (across lines), side-effect imports, and
// import()/require() with a plain string.
const STATIC =
  /(?:^|[\s;{}])(?:import|export)\s(?:[^'"`;]|\n)*?\bfrom\s*(['"])([^'"]+)\1|(?:^|[\s;{}])import\s*(['"])([^'"]+)\3/g;
const CALLED = /\b(import|require)\s*\(\s*([^)]*)\)/g;
const REFERENCE = /^\s*\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1/gm;

const problems = [];

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) yield full;
  }
}

const packageName = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

for (const [rel, allowed] of Object.entries(MIT)) {
  const dir = path.join(root, rel);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.license !== 'MIT') problems.push(`${rel}/package.json says "${pkg.license}", not "MIT"`);
  const licence = path.join(dir, 'LICENSE');
  if (!existsSync(licence) || !readFileSync(licence, 'utf8').startsWith('MIT License')) {
    problems.push(`${rel}/LICENSE is missing or is not the MIT licence`);
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (!allowed.includes(dep)) problems.push(`${rel} has ${field} "${dep}"`);
    }
  }
  for (const file of sources(path.join(dir, 'src'))) {
    const raw = readFileSync(file, 'utf8');
    const code = withoutComments(raw);
    const where = path.relative(root, file).split(path.sep).join('/');
    const testOnly = /\.test\.[cm]?[jt]sx?$/.test(file) || where.includes('/src/testing/');

    const check = (spec) => {
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (target !== dir && !target.startsWith(dir + path.sep)) {
          problems.push(`${where} reaches outside ${rel}: '${spec}'`);
        }
        return;
      }
      const name = packageName(spec);
      if (allowed.includes(name)) return;
      if (testOnly && TEST_ONLY.has(name)) return;
      problems.push(`${where} imports '${spec}', which ${rel} may not use`);
    };

    for (const m of code.matchAll(STATIC)) check(m[2] ?? m[4]);
    for (const m of code.matchAll(CALLED)) {
      const arg = m[2].trim();
      const literal = /^(['"])([^'"]+)\1$/.exec(arg) ?? /^`([^`$]+)`$/.exec(arg);
      if (literal) check(literal[2] ?? literal[1]);
      else problems.push(`${where} calls ${m[1]}(${arg}): a path worked out at run time`);
    }
    for (const m of raw.matchAll(REFERENCE)) check(m[2]);
  }
}

if (problems.length) {
  console.error('The MIT packages must stay free of everything else in the repository:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`MIT boundary holds: ${Object.keys(MIT).join(', ')}`);
