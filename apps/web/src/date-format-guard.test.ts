// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/**
 * The guard that keeps every time on the family's clock (0.9.0, TZ):
 * eslint.config.js refuses the platform's date formatting anywhere in the
 * web app but family-time.tsx, so a new screen cannot say a moment on the
 * browser's clock. This checks that block catches what it should and lets
 * a number's formatting by, and that no file the gate lints has one.
 */

const root = ['eslint.config.js', '../../eslint.config.js']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p)) as string;
const repo = resolve(root, '..');

interface Block {
  files?: string[];
  ignores?: string[];
  rules?: Record<string, unknown>;
}

const loaded = async (): Promise<Block> => {
  const config = ((await import(pathToFileURL(root).href)) as { default: Block[] }).default;
  const block = config.find(
    (b) => b.files?.includes('apps/web/src/**/*.tsx') && b.rules?.['no-restricted-syntax'],
  );
  if (!block) throw new Error('eslint.config.js has no date guard for apps/web');
  return block;
};

const lint = (block: Block, code: string, filename = 'Screen.tsx') =>
  new Linter({ configType: 'flat' }).verify(
    code,
    [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          'no-restricted-syntax': block.rules?.['no-restricted-syntax'] as Linter.RuleEntry,
          'no-restricted-imports': block.rules?.['no-restricted-imports'] as Linter.RuleEntry,
        },
      },
    ],
    { filename },
  );

describe('the guard against saying a moment on the browser’s clock (TZ)', () => {
  it('refuses the platform’s date formatting, and lets a number’s by', async () => {
    const block = await loaded();
    for (const code of [
      'const a = new Date(iso).toLocaleString();',
      "const b = at.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit' });",
      "const c = at.toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });",
      'const d = at.toLocaleDateString();',
      "const e = at.toLocaleTimeString([], { timeStyle: 'short' });",
      "const f = new Intl.DateTimeFormat('en-GB', { hour: 'numeric' }).format(at);",
      'const g = Intl.DateTimeFormat().resolvedOptions().timeZone;',
      'const h = () => <p>{new Date(x.at).toLocaleDateString()}</p>;',
      // Any receiver, with nothing or a locale alone (the TZ review).
      'const i = when.toLocaleString();',
      "const j = row.at.toLocaleString('en-GB');",
      // The shared helpers that fall back to the browser's zone.
      "import { whenExactly } from '@fdv/shared';",
      "import { localToday, whenWords } from '@fdv/shared';",
    ]) {
      const found = lint(block, code);
      expect(found.length, code).toBeGreaterThan(0);
      expect(found[0]?.message, code).toMatch(/family-time\.tsx/);
    }
    for (const code of [
      "const n = new Intl.NumberFormat('en-GB').format(count);",
      "const m = value.toLocaleString('en-GB', { minimumFractionDigits: 2 });",
      'const w = exactWords(iso, zone);',
      'const u = name.toLocaleUpperCase();',
      "import { localToday, shareEndWords } from '@fdv/shared';",
    ]) {
      expect(lint(block, code), code).toEqual([]);
    }
  });

  it('no file of the web app says a moment but through family-time.tsx', async () => {
    const block = await loaded();
    const web = join(repo, 'apps', 'web', 'src');
    const ignored = (rel: string) =>
      (block.ignores ?? []).some((p) =>
        p.includes('**/*.') ? rel.endsWith(p.slice(p.indexOf('**/*.') + 4)) : rel === p,
      );
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, e.name);
        if (e.isDirectory()) walk(at);
        else if (/\.tsx?$/.test(e.name)) files.push(at);
      }
    };
    walk(web);
    const checked = files
      .map((f) => relative(repo, f).split(sep).join('/'))
      .filter((rel) => !ignored(rel));
    expect(checked.length).toBeGreaterThan(60);
    expect(checked).not.toContain('apps/web/src/family-time.tsx');
    const found = checked.flatMap((rel) =>
      lint(block, readFileSync(join(repo, rel), 'utf8'), rel)
        // This block's rule alone: the file's own eslint-disable comments
        // name rules this lint does not load.
        .filter(
          (m) =>
            m.ruleId === 'no-restricted-syntax' || m.ruleId === 'no-restricted-imports' || m.fatal,
        )
        .map((m) => `${rel}:${m.line}:${m.column}`),
    );
    expect(found).toEqual([]);
  });
});
