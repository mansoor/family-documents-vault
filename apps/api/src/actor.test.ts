import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The API acts as the vault itself only where it must (5.6).
 *
 * `withSystem` answers to no member's limits. An API path quietly converted
 * to it would lift them — a restricted viewer's, once 5.32 has them — and
 * nothing else would notice. So every call the API makes is named here, by
 * the function that makes it, and one more fails this test until somebody
 * decides it belongs on the list.
 *
 * Signing in, a reset and an invitation's page ask as `anonymous`; a link,
 * once its share is found, asks as the link. What is left is two lookups
 * made before anybody is known.
 */
const ALLOWED = [
  // Which share a link's token names, found by its hash. Until it is found
  // there is no link to ask as; after, the link asks as itself.
  'documents/shares.ts ShareService.linkScope',
  // Accepting an invitation. The person is not anybody yet, and the check
  // that the member has never signed in reads the household's documents.
  'household/invitations.ts InvitationService.accept',
];

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** The API's own code: not its tests, and not the harness they share. */
async function sources(): Promise<string[]> {
  return (await readdir(SRC, { recursive: true }))
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-harness.ts')
    .sort();
}

/**
 * Every use of `withSystem` in one file, as "file Function" — a call named
 * by the function that makes it, or anything else (a rename, a namespace
 * import, the function handed on) named for what it is.
 */
function usesIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const names = node.importClause?.namedBindings;
      const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (names && ts.isNamespaceImport(names) && from === '@fdv/db') {
        found.push(`${file} import * as ${names.name.text}`);
      }
      if (names && ts.isNamedImports(names)) {
        for (const el of names.elements) {
          if (el.propertyName?.getText() === 'withSystem') {
            found.push(`${file} withSystem as ${el.name.text}`);
          }
        }
      }
      return; // a plain import of it is not a use
    }
    // The other ways of asking as the vault: loading @fdv/db as the code
    // runs (where a name can be put together), a scope that names the system
    // as its actor, and the setting said by hand.
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === '@fdv/db')
    ) {
      found.push(`${file} ${enclosing(node)} (loads @fdv/db as it runs)`);
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === 'kind' &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text === 'system'
    ) {
      found.push(`${file} ${enclosing(node)} (kind: 'system')`);
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
      node.text.includes('app.actor')
    ) {
      found.push(`${file} ${enclosing(node)} (says app.actor)`);
    }
    if (ts.isIdentifier(node) && node.text === 'withSystem') {
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
      found.push(`${file} ${enclosing(node)}${called ? '' : ' (not a plain call)'}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The named function a node is in: "Class.method", "function", or "(top level)". */
function enclosing(node: ts.Node): string {
  // A source file has no parent, whatever the typings say.
  const parentOf = (n: ts.Node): ts.Node | undefined => n.parent;
  const classOf = (member: ts.Node) => {
    const c = parentOf(member);
    return c && ts.isClassLike(c) && c.name ? `${c.name.text}.` : '';
  };
  for (let n = parentOf(node); n !== undefined; n = parentOf(n)) {
    if (ts.isConstructorDeclaration(n)) return `${classOf(n)}constructor`;
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) {
      return `${classOf(n)}${n.name.getText()}`;
    }
    const holder = parentOf(n);
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      holder &&
      (ts.isVariableDeclaration(holder) ||
        ts.isPropertyDeclaration(holder) ||
        ts.isPropertyAssignment(holder))
    ) {
      return `${classOf(holder)}${holder.name.getText()}`;
    }
  }
  return '(top level)';
}

describe('withSystem in the API', () => {
  it('withSystem is called only from the allow-list', async () => {
    const found: string[] = [];
    for (const file of await sources()) {
      found.push(...usesIn(file, await readFile(path.join(SRC, file), 'utf8')));
    }
    // Exact, call by call: one more anywhere, or one gone from the list's
    // own places, and the list is out of date.
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });

  it('the check sees a call wherever it is, however it is reached', () => {
    const code = `
      import { withSystem, withSystem as asVault } from '@fdv/db';
      import * as db from '@fdv/db';
      export class Things {
        private readonly helper = () => withSystem(this.db, 'h', f);
        async list() { return [1].map(() => withSystem(this.db, 'h', f)); }
      }
      export function run() { return db.withSystem(x, 'h', f); }
      const handedOn = { go: withSystem };
      export async function loaded() { const m = await import('@fdv/db'); return m['with' + 'System']; }
      export function cast() { return withScope(d, { householdId: 'h', actor: { kind: 'system' } as never }, f); }
      export function byHand(trx) { return sql.raw("select set_config('app.actor', 'system', true)").execute(trx); }
    `;
    expect(usesIn('x.ts', code).sort()).toEqual(
      [
        'x.ts withSystem as asVault',
        'x.ts import * as db',
        'x.ts Things.helper',
        'x.ts Things.list',
        'x.ts run (not a plain call)',
        'x.ts (top level) (not a plain call)',
        'x.ts loaded (loads @fdv/db as it runs)',
        "x.ts cast (kind: 'system')",
        'x.ts byHand (says app.actor)',
      ].sort(),
    );
  });

  it('no package asks as the vault, but @fdv/db where it says how', async () => {
    const packages = path.join(SRC, '..', '..', '..', 'packages');
    const found: string[] = [];
    for (const pkg of await readdir(packages)) {
      const src = path.join(packages, pkg, 'src');
      const files = await readdir(src, { recursive: true }).catch(() => [] as string[]);
      for (const f of files.map((f) => f.split(path.sep).join('/')).sort()) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        const name = `packages/${pkg}/src/${f}`;
        found.push(...usesIn(name, await readFile(path.join(src, f), 'utf8')));
      }
    }
    // client.ts makes withSystem and the scopes, and so says app.actor and
    // 'system' itself; nothing else in the packages may.
    expect(found.filter((f) => !f.startsWith('packages/db/src/client.ts '))).toEqual([]);
  });
});
