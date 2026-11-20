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
 * made before anybody is known — and the proposal thread, which loads its
 * own entry as it starts.
 */
const ALLOWED = [
  // The proposal thread (5.37, N537P-01): started from its own entry,
  // proposal-worker (which imports @fdv/shared alone), with tsx's loader
  // registered first when it runs from source. It runs proposeDetails on
  // what it is sent, and nothing else: no database, and no scope.
  'documents/proposal-pool.ts ProposalPool.start (loads a module as it runs)',
  // Which share a link's token names, found by its hash. Until it is found
  // there is no link to ask as; after, the link asks as itself.
  'documents/shares.ts ShareService.linkScope',
  // An Only me note's words, read on its link's page (0.9.0, N1): its
  // owner's key unwrapped as the vault, once the link was found, as itself,
  // to give that note — a link is given the keys of its files alone (0042),
  // and a note has none. The key, and nothing else, is read so.
  // Since DL, its own method (noteWords), which a note's download and a
  // link's ZIP ask too: the key, and nothing else.
  'documents/shares.ts ShareService.noteWords',
  // A person's emergency information, read on a clinician's link's page
  // (0.9.0, H4): the household's identity key unwrapped as the vault, once
  // the link was found, as itself, to give that page — read as the link,
  // which the database gives that one person's row alone (0102) — and only
  // once the link's own transaction is over, so no request holds two
  // connections. The key, and nothing else, is read so.
  'documents/shares.ts ShareService.withEmergency',
  // Accepting an invitation. The person is not anybody yet, and the check
  // that the member has never signed in reads the household's documents.
  'household/invitations.ts InvitationService.accept',
  // A computer that sends scans (0.8.0, D1): a pairing code traded for a
  // key, before anybody is known — the code found by its first half's HMAC
  // (device_pairing_find), its tries counted, its person read and held, the
  // key made; and a key, found by its id and hash (upload_device_find), read
  // for its person and their role, and its last use noted. Everything the
  // key then does, it does as its person (BatchService), never as the vault.
  'devices/service.ts DeviceService.pair',
  // And a first half that names no code does the same work, in a household
  // that is nobody's, so that it takes as long (the D1 review, F4).
  'devices/service.ts DeviceService.pair',
  'devices/service.ts DeviceService.authenticate',
  // A connected app (0.9.0, APP1): a request is nobody's until its API key
  // (APP6) is checked, so the key's last use and the app's are noted, and a
  // refusal counted, by the vault — a refusal only once the key is right.
  // GET /apps/me reads the app's own rows and the key it came with
  // (connected_app is the owners' to read); what it files and reads it does
  // as its person.
  // (`admitted` is its second half, once a key or a token is known, since
  // 0.9.0-dev.72, which also notes there the network and the day's
  // requests for the owners' alerts on unusual use.)
  'apps/service.ts AppService.admitted',
  'apps/service.ts AppService.noteRefusal',
  // An access token for a key (0.9.0-dev.72): its hash written by the
  // vault (connected_app_token is the vault's alone), once the key is known.
  'apps/service.ts AppService.mintToken',
  'apps/service.ts AppService.me',
  // An app acting as itself (0.9.0, APP8) has no person, and no account
  // standing in for one: its own rows — what became of its sends, its caps
  // as a send is claimed, its polling line, the owners told it needs a
  // reviewer, and the family and the kinds its sends are routed by — are
  // written and read by the vault on its behalf, in this one place. An app
  // acting as a person does all of that as its person, as before.
  'apps/service.ts AppService.ownRows',
  // What a connected app reads (0.9.0, APP2): the documents themselves are
  // read narrowed to the app (readAsApp, inside this transaction: the
  // database gives it what its rule allows and nothing of any other table),
  // never as the vault. The vault's own part is around that: the app's
  // grants, kinds and own sends looked up, its feed written
  // (connected_app_seen and connected_app_change are the vault's alone), a
  // download's bytes counted on the app and its file's key opened, and the
  // activity log's lines. A list, one document, the feed, a download, and
  // whether what it sent is still readable (its intake's status).
  'apps/reads.ts AppReads.stillReadable',
  'apps/reads.ts AppReads.list',
  'apps/reads.ts AppReads.document',
  'apps/reads.ts AppReads.changes',
  'apps/reads.ts AppReads.content',
  // The exact file a send of its became, again (0.9.0, APP5): the send's
  // version read narrowed to the app (readAsApp: the database gives it the
  // versions it sent, while their documents are out of the Trash and not
  // Only me), its own send and the document looked up by the vault, and the
  // download counted, opened and written down as above; and whether each
  // send's file can be (its intake's status).
  'apps/reads.ts AppReads.sentAvailable',
  'apps/reads.ts AppReads.sentContent',
  // A connected app's links and deletes (0.9.0, APP3). Minting: the app's
  // read rule asked as above (readAsApp), the link's row written and its
  // hour counted on the app (connected_app_link is the vault's to write).
  // Opening, and each request in the session: nobody is known but by the
  // token or the cookie (found by its hash, connected_app_link_find), so the
  // link is read and its session written by the vault — and the app's read
  // rule asked again, narrowed to the app, every time; the pages and the
  // file's key opened as the app's download opens them. A delete: its own
  // document, by the same rule, let go of on its intake, or moved to the
  // Trash as its person would, with the activity log's line.
  'apps/links.ts AppLinks.mint',
  'apps/links.ts AppLinks.open',
  'apps/links.ts AppLinks.inSession',
  'apps/links.ts AppLinks.remove',
  // Every owner sees how many of what an app sent wait, and were filed
  // (0.9.0-dev.68): the rows are each person's alone (0109), so the vault
  // counts them for an owner — after the owner's own transaction, two
  // numbers an app, and nothing of any document or send.
  'apps/service.ts AppService.withTotals',
  // An app's item filed automatically (0.9.0, APP4): the worker's job names
  // only an item, so which app sent it, whom it acts as and whether it still
  // files automatically are found by the vault; the filing itself is done
  // as that person, everything asked again in their own transaction.
  'apps/auto-file.ts AppAutoFile.fileReady',
  // Text messages (0.9.0, SMS1): a text is sent by the vault, whoever asked
  // for it — the household's SMS Gate and its sealed password read, the
  // month's texts counted and one written (sms_message is the vault's to
  // write, 0084), what became of it noted (`sendSms` and `markSms` in
  // @fdv/db since SMS2, which the worker's texts go through too, each handed
  // this scope), and a test's result said on the setting (only the vault
  // says a test passed). Who may ask is checked first, as themselves.
  'sms/service.ts SmsService.vault',
  'sms/service.ts SmsService.test',
  // The off-site backup copy's test (0.9.0-dev.76): only the vault says a
  // test passed (backup_offsite_account_writes), so its result is written as
  // the vault, once an owner asked, as themselves.
  'backups/offsite.ts BackupOffsiteService.test',
  // A code that confirms a number: made, counted and ended, and tried, by
  // the vault alone (phone_code is nobody's to read, 0084), once the person
  // asking has been found to be its person or an owner, as themselves. A
  // number is confirmed by the vault, once its code is right.
  'sms/phones.ts MemberPhoneService.issue',
  'sms/phones.ts MemberPhoneService.issue',
  'sms/phones.ts MemberPhoneService.confirm',
  // A link's or a request's text that was not sent (0.9.0-dev.69, the dev.69
  // review): its reservation undone, or kept as not sent, and the log told
  // why — as the vault, since a sent row is nobody's to change, once its
  // sender, as themselves, reserved it.
  'link-texts.ts sendReserved',
  // Codes by text to one's own number (0.9.0, SMS3): whose a code would be —
  // the person's number in their newest household, and whether its texts go
  // — read before anybody is signed in (a reset, a sign-in's second step);
  // a code made, counted and ended, and tried, by the vault alone (sms_code
  // is nobody's to read, 0088); and a reset that went on without its code
  // told to the person's owners, who are found as the vault — and a sign-in
  // that did (the owner's decision of 12 Nov 2026), written in the log as
  // the person, before anybody is signed in.
  'sms/codes.ts TextCodeService.target',
  'sms/codes.ts TextCodeService.skipped',
  'sms/codes.ts TextCodeService.send',
  'sms/codes.ts TextCodeService.send',
  'sms/codes.ts TextCodeService.verify',
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
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@fdv/db'
    ) {
      found.push(`${file} re-exports @fdv/db`);
    }
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
        (ts.isIdentifier(node.expression) &&
          (node.expression.text === 'require' || node.expression.text === 'createRequire')))
    ) {
      // A module loaded as the code runs: @fdv/db by name, or any module
      // whose name is put together (and so could be it).
      const named = node.arguments[0];
      if (!named || !ts.isStringLiteralLike(named) || named.text === '@fdv/db') {
        found.push(`${file} ${enclosing(node)} (loads a module as it runs)`);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'kind' &&
      literal(node.initializer) === 'system'
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

/** A property's name, quoted or not. */
function propertyName(name: ts.PropertyName): string {
  return ts.isStringLiteralLike(name) ? name.text : name.getText();
}

/** The string a value is, seen through `as`, `satisfies`, `<T>` and brackets. */
function literal(node: ts.Expression): string | null {
  let n: ts.Expression = node;
  while (
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isParenthesizedExpression(n)
  ) {
    n = n.expression;
  }
  return ts.isStringLiteralLike(n) ? n.text : null;
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

// Parsing every source file takes about a second alone; under the whole
// suite's load it has taken over 5 s (5.14), so these have room of their own.
describe('withSystem in the API', { timeout: 30_000 }, () => {
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
      export async function putTogether() { return (await import('@fdv/' + 'db')).withScope; }
      export function castInside() { return withScope(d, { householdId: 'h', actor: { kind: ('system' as never) } }, f); }
      export function quoted() { return withScope(d, { householdId: 'h', actor: { 'kind': 'system' } as never }, f); }
      export * from '@fdv/db';
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
        'x.ts loaded (loads a module as it runs)',
        'x.ts putTogether (loads a module as it runs)',
        "x.ts castInside (kind: 'system')",
        "x.ts quoted (kind: 'system')",
        'x.ts re-exports @fdv/db',
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

/**
 * Acting as another person inside somebody's own transaction (0.9.0, APP5):
 * `actAs` writes as the person a connected app acts as, inside the
 * transaction of the person its file went to. Each use is named here, as
 * `withSystem`'s are; one more anywhere fails this test until somebody
 * decides it belongs on the list.
 */
const ACT_AS_ALLOWED = [
  // A send to the Inbox of the person it is about, and a withdraw of one:
  // the app's row held, its caps counted, its send's row and its activity
  // line written as its own person, in the recipient's transaction — or,
  // for an app acting as itself (APP8), as the vault on its behalf
  // (`actAsVault`), in the transaction of whoever's Inbox it goes to (the
  // person it is about, or its reviewer). One place makes both.
  'apps/service.ts AppService.asAppIn',
  'apps/service.ts AppService.asAppIn (actAsVault)',
  // Filing such a send automatically: the app's row held and its person
  // read as its person — or as the vault, for an app acting as itself — in
  // the recipient's filing transaction.
  'apps/auto-file.ts AppAutoFile.fileReady',
  'apps/auto-file.ts AppAutoFile.fileReady (actAsVault)',
];

/** Every use of `actAs` in one file: a call, a rename, a namespace import, or the name handed on. */
function actAsIn(file: string, text: string): string[] {
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
          const was = el.propertyName?.getText();
          if (was === 'actAs' || was === 'actAsVault') {
            found.push(`${file} ${was} as ${el.name.text}`);
          }
        }
      }
      return;
    }
    // And acting as the vault inside somebody's transaction (APP8).
    if (ts.isIdentifier(node) && (node.text === 'actAs' || node.text === 'actAsVault')) {
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
      const which = node.text === 'actAsVault' ? ' (actAsVault)' : '';
      found.push(`${file} ${enclosing(node)}${which}${called ? '' : ' (not a plain call)'}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Where an app's own rows are written inside somebody else's transaction
 * (0.9.0, APP8): `AppService.asAppIn` hands out `actAs` (as the app's
 * person) or `actAsVault` (for an app acting as itself). Each place that
 * asks it for one is named here too.
 */
const AS_APP_IN_ALLOWED = [
  // A send, into the Inbox it goes to.
  'apps/service.ts AppService.send',
  // A withdraw of a send, from the Inbox it is in.
  'apps/service.ts AppService.withdraw',
];

/** Every use of `asAppIn` in one file: a call, or the name handed on. */
function asAppInIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'asAppIn' && !ts.isMethodDeclaration(node.parent)) {
      const called =
        ts.isPropertyAccessExpression(node.parent) &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent;
      found.push(`${file} ${enclosing(node)}${called ? '' : ' (not a plain call)'}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('actAs in the API', { timeout: 30_000 }, () => {
  it('asAppIn is asked only from the allow-list', async () => {
    const found: string[] = [];
    for (const file of await sources()) {
      found.push(...asAppInIn(file, await readFile(path.join(SRC, file), 'utf8')));
    }
    expect(found.sort()).toEqual([...AS_APP_IN_ALLOWED].sort());
  });

  it('actAs is called only from the allow-list', async () => {
    const found: string[] = [];
    for (const file of await sources()) {
      found.push(...actAsIn(file, await readFile(path.join(SRC, file), 'utf8')));
    }
    expect(found.sort()).toEqual([...ACT_AS_ALLOWED].sort());
  });

  it('the check sees a call wherever it is, however it is reached', () => {
    const code = `
      import { actAs, actAs as asSomebody } from '@fdv/db';
      import * as db from '@fdv/db';
      export class Things {
        async one() { return actAs(trx, who, f); }
      }
      export function viaNamespace() { return db.actAs(trx, who, f); }
      const handedOn = { go: actAs };
    `;
    expect(actAsIn('x.ts', code).sort()).toEqual(
      [
        'x.ts actAs as asSomebody',
        'x.ts import * as db',
        'x.ts Things.one',
        'x.ts viaNamespace (not a plain call)',
        'x.ts (top level) (not a plain call)',
      ].sort(),
    );
  });
});
