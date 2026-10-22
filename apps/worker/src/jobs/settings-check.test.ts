import { randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveKey, MAILBOX_PASSWORD_PURPOSE, sealMailboxPassword } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import {
  mailInTestResult,
  type MailInTestFound,
  type WatchBrowseResult,
  type WatchVerifyFound,
} from '@fdv/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { childEnv } from './child-env.js';
import { startTestImap, TEST_CERT, type TestImap } from './imap-test-server.js';
import { ImapMailbox, MailboxError, problemOf, type ImapSettings } from './mailbox.js';
import { FakeMailbox, mail } from './mail-test-helper.js';
import { MailThread, type MailReader } from './mail-thread.js';
import {
  browseWatchFolder,
  runSettingsCheck,
  verifyWatchFolder,
  type SettingsCheckDeps,
} from './settings-check.js';

/**
 * What an owner asks the worker from Settings (0.9.0, O1), in the worker:
 *
 *  - Verify: each check of a folder in order, each failure said, and
 *    nothing written in a folder that is not one the vault may use; the
 *    probe made, moved and deleted, a hidden file, and gone afterwards;
 *  - the folders inside one, never a file, a link or the vault's own;
 *  - Test the mailbox: on the wire, a sign-in, EXAMINE and one FETCH of
 *    BODY.PEEK[HEADER.FIELDS (AUTHENTICATION-RESULTS)] — nothing that marks,
 *    moves, copies, expunges or fetches a mail — and what it found: the
 *    count, MOVE and UIDPLUS, the newest message's authserv-id (read on the
 *    mail thread); the mailbox set up in Settings over FDV_MAIL_IN_*, its
 *    password handed to the IMAP client alone.
 */

const WINDOWS = process.platform === 'win32';
const linkDir = (target: string, at: string) =>
  fsp.symlink(target, at, WINDOWS ? 'junction' : 'dir');
const there = (p: string) =>
  fsp.lstat(p).then(
    () => true,
    () => false,
  );
const AR = (v: string) => `Authentication-Results: ${v}`;

describe('Verify and browse, in the worker', () => {
  const dirs: string[] = [];
  const folder = async (prefix = 'fdv-verify-') => {
    const d = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), prefix)));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await fsp.chmod(d, 0o700).catch(() => undefined);
      await fsp.rm(d, { recursive: true, force: true });
    }
  });
  const steps = (f: WatchVerifyFound) => Object.fromEntries(f.steps.map((s) => [s.check, s.ok]));

  it('a folder the vault may use: every check passed, and the probe gone afterwards', async () => {
    const root = await folder();
    const scans = path.join(root, 'scans');
    await fsp.mkdir(scans);
    const found = await verifyWatchFolder(scans, { roots: [root], ownDirs: [] });
    expect(found.path).toBe(scans);
    expect(steps(found)).toEqual({
      exists: true,
      folder: true,
      inside: true,
      not_vault: true,
      read: true,
      create: true,
      move: true,
      delete: true,
      space: true,
    });
    expect(found.free_bytes).toBeGreaterThan(0);
    expect(await fsp.readdir(scans)).toEqual([]);
  });

  it('says each failure, and writes nothing in a folder it may not use', async () => {
    const root = await folder();
    const outside = await folder('fdv-verify-outside-');
    const rules = { roots: [root], ownDirs: [path.join(root, 'vault')] };
    // Not there; a file.
    expect(steps(await verifyWatchFolder(path.join(root, 'none'), rules))).toMatchObject({
      exists: false,
      folder: null,
      create: null,
    });
    await fsp.writeFile(path.join(root, 'a-file'), 'x');
    expect(steps(await verifyWatchFolder(path.join(root, 'a-file'), rules))).toMatchObject({
      exists: true,
      folder: false,
      inside: null,
    });
    // Outside the roots; inside them by name, but a link that leads out of them.
    expect(steps(await verifyWatchFolder(outside, rules))).toMatchObject({
      inside: false,
      not_vault: null,
      create: null,
    });
    await linkDir(outside, path.join(root, 'via'));
    expect(steps(await verifyWatchFolder(path.join(root, 'via'), rules))).toMatchObject({
      exists: true,
      folder: true,
      inside: false,
      read: null,
      create: null,
    });
    // The vault's own folder, inside it, and above it.
    await fsp.mkdir(path.join(root, 'vault', 'inner'), { recursive: true });
    for (const p of [path.join(root, 'vault'), path.join(root, 'vault', 'inner'), root]) {
      expect(steps(await verifyWatchFolder(p, rules)), p).toMatchObject({
        inside: true,
        not_vault: false,
        read: null,
        create: null,
        space: null,
      });
    }
    // Nothing was written anywhere it may not be.
    expect(await fsp.readdir(outside)).toEqual([]);
    expect(await fsp.readdir(path.join(root, 'vault'))).toEqual(['inner']);
    expect((await fsp.readdir(root)).sort()).toEqual(['a-file', 'vault', 'via']);
  });

  it.skipIf(WINDOWS || process.getuid?.() === 0)(
    'a folder the vault can see into but not write in: create fails, and the rest is not tried',
    async () => {
      const root = await folder();
      const ro = path.join(root, 'ro');
      await fsp.mkdir(ro);
      await fsp.chmod(ro, 0o500);
      try {
        expect(steps(await verifyWatchFolder(ro, { roots: [root], ownDirs: [] }))).toMatchObject({
          read: true,
          create: false,
          move: null,
          delete: null,
        });
        await fsp.chmod(ro, 0o300);
        expect(steps(await verifyWatchFolder(ro, { roots: [root], ownDirs: [] }))).toMatchObject({
          read: false,
          create: null,
        });
      } finally {
        await fsp.chmod(ro, 0o700);
      }
    },
  );

  it('a probe that cannot be moved, or deleted, is said so — and removed all the same', async () => {
    const root = await folder();
    const fsx = (over: Record<string, unknown>) =>
      ({ ...fsp, ...over }) as unknown as Parameters<typeof verifyWatchFolder>[2];
    const noMove = await verifyWatchFolder(
      root,
      { roots: [root], ownDirs: [] },
      fsx({ rename: () => Promise.reject(Object.assign(new Error('no'), { code: 'EPERM' })) }),
    );
    expect(steps(noMove)).toMatchObject({ create: true, move: false, delete: null });
    expect(await fsp.readdir(root)).toEqual([]);
    let unlinks = 0;
    const noDelete = await verifyWatchFolder(
      root,
      { roots: [root], ownDirs: [] },
      fsx({
        unlink: (p: string) =>
          ++unlinks === 1
            ? Promise.reject(Object.assign(new Error('no'), { code: 'EPERM' }))
            : fsp.unlink(p),
      }),
    );
    expect(steps(noDelete)).toMatchObject({ move: true, delete: false });
    expect(await fsp.readdir(root)).toEqual([]);
    // Little room: said, the rest passing.
    const tight = await verifyWatchFolder(
      root,
      { roots: [root], ownDirs: [] },
      fsx({ statfs: async () => ({ bavail: 10, bsize: 4096 }) }),
    );
    expect(steps(tight)).toMatchObject({ delete: true, space: false });
    expect(tight.free_bytes).toBe(40960);
  });

  it('a folder swapped for a link once checked: nothing is written through it (the O1 review, M1)', async () => {
    const root = await folder();
    const outside = await folder('fdv-verify-outside-');
    const scans = path.join(root, 'scans');
    await fsp.mkdir(scans);
    // Every file the probe is written at, by the folder it really landed in.
    const wrote: string[] = [];
    const fsx = {
      ...fsp,
      writeFile: async (...a: Parameters<typeof fsp.writeFile>) => {
        await fsp.writeFile(...a);
        wrote.push(await fsp.realpath(path.dirname(a[0] as string)));
      },
    } as unknown as Parameters<typeof verifyWatchFolder>[2];
    // The reviewer's PoC: checked, then swapped for a link out of the roots
    // before the probe is written.
    const found = await verifyWatchFolder(
      scans,
      { roots: [root], ownDirs: [] },
      fsx,
      undefined,
      async () => {
        await fsp.rename(scans, `${scans}-was`);
        await linkDir(outside, scans);
      },
    );
    expect(steps(found)).toMatchObject({ inside: true, read: true, create: false, move: null });
    expect(wrote).toEqual([]);
    expect(await fsp.readdir(outside)).toEqual([]);
  });

  it('browses folders alone: no file, no link, nothing hidden, not the vault’s own; and refuses what may not be chosen', async () => {
    const root = await folder();
    const outside = await folder('fdv-verify-outside-');
    for (const d of ['Office', 'upstairs', 'upstairs/vault', 'upstairs/scans', '.hidden']) {
      await fsp.mkdir(path.join(root, ...d.split('/')));
    }
    for (const d of ['rejected', 'processed']) await fsp.mkdir(path.join(root, d));
    await fsp.writeFile(path.join(root, 'scan.pdf'), 'x');
    await linkDir(outside, path.join(root, 'elsewhere'));
    const rules = { roots: [root], ownDirs: [path.join(root, 'upstairs', 'vault')] };
    const listed: WatchBrowseResult = await browseWatchFolder(root, rules);
    expect(listed).toEqual({
      path: root,
      folders: ['Office', 'upstairs'],
      truncated: false,
      problem: null,
    });
    expect((await browseWatchFolder(outside, rules)).problem).toMatch(
      /isn’t one the vault may use/,
    );
    expect((await browseWatchFolder(path.join(root, 'elsewhere'), rules)).problem).toMatch(
      /isn’t one the vault may use/,
    );
    // Above the vault's own folder: browsed through (never chosen), the vault's own not offered.
    expect((await browseWatchFolder(path.join(root, 'upstairs'), rules)).folders).toEqual([
      'scans',
    ]);
    // The vault's own, or inside it: not even browsed.
    expect((await browseWatchFolder(path.join(root, 'upstairs', 'vault'), rules)).problem).toMatch(
      /one of the vault’s own folders/,
    );
    expect((await browseWatchFolder(path.join(root, 'gone'), rules)).problem).toMatch(
      /nothing at that path/,
    );
    expect((await browseWatchFolder('relative/path', rules)).problem).toMatch(/whole path/);
  });
});

describe('Test the mailbox, on the wire', () => {
  let imap: TestImap | null = null;
  afterEach(async () => {
    await imap?.close();
    imap = null;
  });
  const header = [
    AR('mx.google.com; dkim=pass header.d=example.test; dmarc=pass header.from=example.test'),
    AR('mx.other.test; dmarc=fail'),
    'From: Ann <ann@example.test>',
    'Subject: The secret subject',
    'Message-ID: <m3@example.test>',
  ].join('\r\n');
  const settings = (over: Partial<ImapSettings> = {}): ImapSettings => ({
    host: 'localhost',
    port: imap?.port ?? 1,
    user: 'home@vault.test',
    password: 'pw-on-the-wire',
    ca: TEST_CERT,
    ...over,
  });

  it('signs in, EXAMINEs the folder and asks for the newest messages’ Authentication-Results with BODY.PEEK, and nothing else', async () => {
    imap = await startTestImap({
      user: 'home@vault.test',
      password: 'pw-on-the-wire',
      mails: ['From: a@example.test\r\nSubject: one', 'From: b@example.test', header],
      caps: ['MOVE', 'UIDPLUS'],
    });
    const seen = await new ImapMailbox(settings()).inspect('INBOX');
    expect(imap.signedIn).toBe(true);
    expect(seen).toMatchObject({ exists: 3, move: true, uidplus: true });
    // The newest three, newest first (the O1 review, L3).
    expect(seen.newestHeaders).toHaveLength(3);
    const h = seen.newestHeaders[0]?.toString('latin1') ?? '';
    // That header's Authentication-Results alone: never its subject or sender.
    expect(h).toContain('mx.google.com');
    expect(seen.newestHeaders.map((b) => b.toString('latin1')).join('')).not.toMatch(/one|b@/);
    expect(h).not.toContain('secret subject');
    expect(h).not.toContain('ann@example.test');
    // On the wire: read-only, and no command that marks, moves, copies,
    // expunges, deletes or fetches a mail's body.
    const sent = imap.commands;
    expect(sent.some((c) => /^EXAMINE /.test(c))).toBe(true);
    const fetches = sent.filter((c) => /FETCH/.test(c));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(/BODY\.PEEK\[HEADER\.FIELDS \(AUTHENTICATION-RESULTS\)\]/i);
    for (const c of sent) {
      expect(c).not.toMatch(
        /^(SELECT|STORE|UID STORE|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|APPEND|DELETE|CREATE|RENAME|IDLE)\b/,
      );
      expect(c).not.toMatch(/BODY\[|RFC822|BODYSTRUCTURE|ENVELOPE|\\Seen|\+FLAGS/i);
    }
    expect(sent).toContain('LOGIN');
    expect(sent.at(-1)).toMatch(/^LOGOUT/);
  }, 30_000);

  it('an empty folder: no FETCH at all; MOVE and UIDPLUS as the server says', async () => {
    imap = await startTestImap({
      user: 'home@vault.test',
      password: 'pw-on-the-wire',
      mails: [],
      caps: ['UIDPLUS'],
    });
    const seen = await new ImapMailbox(settings()).inspect('INBOX');
    expect(seen).toEqual({ exists: 0, move: false, uidplus: true, newestHeaders: [] });
    expect(imap.commands.filter((c) => /FETCH/.test(c))).toEqual([]);
  }, 30_000);

  it('a refused sign-in, a folder not there, and a certificate not trusted are each said as a word', async () => {
    imap = await startTestImap({
      user: 'home@vault.test',
      password: 'pw-on-the-wire',
      mails: [],
      caps: [],
    });
    const problem = (p: Promise<unknown>) =>
      p.then(
        () => 'none',
        (e: unknown) => (e instanceof MailboxError ? e.problem : String(e)),
      );
    expect(await problem(new ImapMailbox(settings({ password: 'wrong' })).inspect('INBOX'))).toBe(
      'login_failed',
    );
    expect(await problem(new ImapMailbox(settings()).inspect('Nowhere'))).toBe('no_folder');
    const untrusted: ImapSettings = settings();
    delete untrusted.ca;
    expect(await problem(new ImapMailbox(untrusted).inspect('INBOX'))).toBe('certificate');
    // The certificate's name is checked too: 127.0.0.1 is in it, a name that is not is refused.
    expect(
      await problem(new ImapMailbox(settings({ host: '127.0.0.2' })).inspect('INBOX')),
    ).not.toBe('none');
  }, 30_000);

  it('connects to the address it checked, never looking the name up again, and checks the certificate for the name (the O1 review, M3)', async () => {
    imap = await startTestImap({
      user: 'home@vault.test',
      password: 'pw-on-the-wire',
      mails: [],
      caps: [],
    });
    const problem = (s: ImapSettings) =>
      new ImapMailbox(s).inspect('INBOX').then(
        () => 'none',
        (e: unknown) => (e instanceof MailboxError ? e.problem : String(e)),
      );
    // A name nothing resolves, at the address checked: reached, and its
    // certificate (for localhost and 127.0.0.1) refused for that name.
    expect(await problem(settings({ host: 'imap.vault.invalid', address: '127.0.0.1' }))).toBe(
      'certificate',
    );
    expect(imap.signedIn).toBe(false);
    // The name the certificate carries, at that address: signed in.
    expect(await problem(settings({ host: 'localhost', address: '127.0.0.1' }))).toBe('none');
    expect(imap.signedIn).toBe(true);
  }, 30_000);

  it('anything but a certificate not verified is unreachable: a port that speaks no TLS tells nothing of what listens there (the O1 review, M3)', async () => {
    // A plain service, as on an address inside the network: a stray reply, no TLS.
    const plain = createServer((c) => {
      c.on('error', () => undefined);
      c.end('HTTP/1.1 400 Bad Request\r\nServer: internal-admin\r\n\r\n');
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    try {
      const port = (plain.address() as AddressInfo).port;
      const p = await new ImapMailbox(settings({ host: '127.0.0.1', port, quick: true }))
        .inspect('INBOX')
        .then(
          () => 'none',
          (e: unknown) => (e instanceof MailboxError ? e.problem : String(e)),
        );
      expect(p).toBe('unreachable');
    } finally {
      // Not waited for: a connection the client left half-open would hold it.
      plain.close();
    }
    for (const code of [
      'EPROTO',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'ECONNRESET',
      'ERR_SSL_PACKET_LENGTH_TOO_LONG',
      'ETIMEDOUT',
    ]) {
      expect(problemOf(Object.assign(new Error('x'), { code })), code).toBe('unreachable');
    }
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
    ]) {
      expect(problemOf(Object.assign(new Error('x'), { code })), code).toBe('certificate');
    }
  }, 30_000);
});

describe.skipIf(!testAdminUrl())('Test the mailbox and Verify, asked from Settings', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let hh: string;
  let imap: TestImap | null = null;
  const reader = new MailThread();
  const mailKey = deriveKey('settings-check-test-master-with-32-bytes!!', MAILBOX_PASSWORD_PURPOSE);
  const PASSWORD = `pw-${randomBytes(8).toString('hex')}`;
  const dirs: string[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    hh = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Home')", [hh]);
  }, 60_000);
  afterEach(async () => {
    await imap?.close();
    imap = null;
    await admin.query('delete from settings_check');
    await admin.query('delete from mail_in_mailbox');
    for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
  });
  afterAll(async () => {
    await reader.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  const ask = async (kind: 'folder' | 'browse' | 'mailbox', p: string | null) =>
    (
      await admin.query<{ id: string }>(
        'insert into settings_check (household_id, kind, path) values ($1, $2, $3) returning id',
        [hh, kind, p],
      )
    ).rows[0]?.id as string;
  const result = async (id: string) =>
    (
      await admin.query<{ result: Record<string, unknown> | null; done_at: Date | null }>(
        'select result, done_at from settings_check where id = $1',
        [id],
      )
    ).rows[0];
  /** What the mail thread was handed, to say the password never was. */
  const handed: Buffer[] = [];
  const watching: MailReader = {
    head: (b, a) => {
      handed.push(Buffer.from(b));
      return reader.head(b, a);
    },
    message: (b, a, m) => {
      handed.push(Buffer.from(b));
      return reader.message(b, a, m);
    },
    close: () => reader.close(),
  };
  const deps = (over: Partial<SettingsCheckDeps['mail']> = {}, roots: string[] = []) => {
    const given: ImapSettings[] = [];
    const d: SettingsCheckDeps = {
      db,
      log: () => undefined,
      watch: { roots, ownDirs: [] },
      mail: {
        env: null,
        mailKey,
        reader: watching,
        connect: (s) => {
          given.push(s);
          return new ImapMailbox({ ...s, ca: TEST_CERT });
        },
        // The test server is on this machine, on a port of its own: allowed, as an operator would.
        hosts: { allowedPorts: [imap?.port ?? 993], allowPrivate: true },
        ...over,
      },
    };
    return { d, given };
  };

  const sealFor = (host: string, port: number, username = 'family@vault.test') =>
    sealMailboxPassword(mailKey, PASSWORD, hh, { host, port, username });

  it('the mailbox set up in Settings: tested over FDV_MAIL_IN_*, read-only, its password to the IMAP client alone', async () => {
    imap = await startTestImap({
      user: 'family@vault.test',
      password: PASSWORD,
      mails: ['ann', 'bob', 'cat'].map((who) =>
        mail({
          above: [AR('mx.google.com; dmarc=pass header.from=example.test')],
          from: `${who}@example.test`,
          subject: 'Private subject',
        }),
      ),
      caps: ['MOVE', 'UIDPLUS'],
    });
    await admin.query(
      `insert into mail_in_mailbox (household_id, host, port, username, password_encrypted, folder, authserv_id)
       values ($1, '127.0.0.1', $2, 'family@vault.test', $3, 'INBOX', 'mx.google.com')`,
      [hh, imap.port, sealFor('127.0.0.1', imap.port)],
    );
    const env = new FakeMailbox();
    env.deliver(mail({ from: 'x@example.test' }));
    const { d, given } = deps({ env: { connector: env, folder: 'INBOX', authservId: null } });
    const before = JSON.stringify(process.env);
    const id = await ask('mailbox', null);
    await runSettingsCheck(d, { household_id: hh, check_id: id });
    const r = await result(id);
    expect(r?.done_at).not.toBeNull();
    expect(r?.result as unknown as MailInTestFound).toEqual({
      source: 'settings',
      problem: null,
      messages: 3,
      move: true,
      uidplus: true,
      authserv_id_seen: 'mx.google.com',
      headers_read: 3,
      authserv_id_set: 'mx.google.com',
    });
    // The server's own mailbox was not asked at all; the household's was, read-only.
    expect(env.opens + env.inspections.length).toBe(0);
    expect(imap.signedIn).toBe(true);
    for (const c of imap.commands) {
      expect(c).not.toMatch(
        /^(SELECT|STORE|UID STORE|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|APPEND)\b/,
      );
    }
    // The password: opened for the IMAP client, and nowhere else — not the
    // result, the mail thread, the environment or a tool's.
    expect(given.map((s) => s.password)).toEqual([PASSWORD]);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(handed.some((b) => b.includes(PASSWORD))).toBe(false);
    expect(JSON.stringify(process.env)).toBe(before);
    expect(JSON.stringify(childEnv())).not.toContain(PASSWORD);
    // Asked again: answered once, left as it was.
    await runSettingsCheck(d, { household_id: hh, check_id: id });
    expect(given).toHaveLength(1);
  }, 60_000);

  it('the server’s own mailbox when none is set up here: tested without touching a mail', async () => {
    const env = new FakeMailbox();
    env.caps = { move: false, uidplus: true };
    env.deliver(mail({ from: 'ann@example.test', above: [AR('mx.fastmail.test; spf=pass')] }));
    env.deliver(
      mail({
        from: 'bob@example.test',
        above: [AR('messagingengine.com; dkim=pass header.d=example.test')],
      }),
    );
    const { d } = deps({ env: { connector: env, folder: 'INBOX', authservId: null } });
    const id = await ask('mailbox', null);
    await runSettingsCheck(d, { household_id: hh, check_id: id });
    expect((await result(id))?.result).toMatchObject({
      source: 'server',
      problem: null,
      messages: 2,
      move: false,
      uidplus: true,
      // Two messages are not enough to suggest one (L3).
      authserv_id_seen: null,
      headers_read: 2,
      authserv_id_set: null,
    });
    expect(env.inspections).toEqual(['INBOX']);
    expect(env.opens).toBe(0);
    expect(env.filings).toEqual([]);
    expect(env.seen).toEqual([]);
    expect(env.sources).toEqual([]);
    expect(env.heads).toEqual([]);
    expect(env.inbox()).toHaveLength(2);
    // A refused sign-in, a missing folder: said as a word.
    env.failing = 'login_failed';
    const again = await ask('mailbox', null);
    await runSettingsCheck(d, { household_id: hh, check_id: again });
    expect((await result(again))?.result).toMatchObject({
      problem: 'login_failed',
      messages: null,
    });
  }, 60_000);

  it('an authserv-id is suggested only when the newest three all name it at their top (the O1 review, L3)', async () => {
    const env = new FakeMailbox();
    const { d } = deps({ env: { connector: env, folder: 'INBOX', authservId: null } });
    const seen = async () => {
      const id = await ask('mailbox', null);
      await runSettingsCheck(d, { household_id: hh, check_id: id });
      return ((await result(id))?.result as unknown as MailInTestFound).authserv_id_seen;
    };
    // The reviewer's PoC: one email, which anybody can send, naming a server of its own.
    env.deliver(mail({ from: 'eve@example.test', above: [AR('mx.forged.test; dmarc=pass')] }));
    expect(await seen()).toBeNull();
    env.deliver(mail({ from: 'ann@example.test', above: [AR('mx.google.com; dmarc=pass')] }));
    env.deliver(mail({ from: 'bob@example.test', above: [AR('mx.google.com; dmarc=pass')] }));
    // The newest three disagree: none.
    expect(await seen()).toBeNull();
    env.deliver(mail({ from: 'cat@example.test', above: [AR('mx.google.com; spf=pass')] }));
    // The newest three agree: suggested.
    expect(await seen()).toBe('mx.google.com');
  }, 60_000);

  it('a password kept for one server is never sent to another (the O1 review, H1): the server changed under it, Test never signs in', async () => {
    imap = await startTestImap({
      user: 'family@vault.test',
      password: PASSWORD,
      mails: [],
      caps: ['MOVE', 'UIDPLUS'],
    });
    await admin.query(
      `insert into mail_in_mailbox (household_id, host, port, username, password_encrypted, folder)
       values ($1, '127.0.0.1', $2, 'family@vault.test', $3, 'INBOX')`,
      [hh, imap.port, sealFor('127.0.0.1', imap.port)],
    );
    // The reviewer's PoC: the host changed, no password typed, then Test.
    const port = imap.port;
    for (const change of [
      "host = 'localhost'",
      'port = port + 1',
      "username = 'another@vault.test'",
    ]) {
      await admin.query(`update mail_in_mailbox set ${change} where household_id = $1`, [hh]);
      const { d, given } = deps({ hosts: { allowedPorts: [port, port + 1], allowPrivate: true } });
      const id = await ask('mailbox', null);
      await runSettingsCheck(d, { household_id: hh, check_id: id });
      expect((await result(id))?.result, change).toMatchObject({ problem: 'password_sealed' });
      expect(given, change).toEqual([]);
      await admin.query(
        `update mail_in_mailbox set host = '127.0.0.1', port = $2, username = 'family@vault.test'
          where household_id = $1`,
        [hh, port],
      );
    }
    expect(imap.signedIn).toBe(false);
    expect(imap.commands).toEqual([]);
  }, 60_000);

  it('a server set up in Settings: only on an allowed port, never inside the network, unless the operator says (the O1 review, M3)', async () => {
    imap = await startTestImap({
      user: 'family@vault.test',
      password: PASSWORD,
      mails: [],
      caps: [],
    });
    const at = (host: string, port: number) =>
      admin.query(
        `insert into mail_in_mailbox (household_id, host, port, username, password_encrypted, folder)
         values ($1, $2, $3, 'family@vault.test', $4, 'INBOX')
         on conflict (household_id) do update set host = $2, port = $3, password_encrypted = $4`,
        [hh, host, port, sealFor(host, port)],
      );
    const test = async (hosts: NonNullable<SettingsCheckDeps['mail']['hosts']>) => {
      const { d, given } = deps({ hosts });
      const id = await ask('mailbox', null);
      await runSettingsCheck(d, { household_id: hh, check_id: id });
      return { r: (await result(id))?.result as unknown as MailInTestFound, given };
    };
    const strict = { allowedPorts: [993], allowPrivate: false };
    // This machine, by name and by address, on 993: refused, never connected to.
    for (const host of ['localhost', '127.0.0.1', '169.254.169.254', '10.1.2.3']) {
      await at(host, 993);
      const { r, given } = await test(strict);
      expect(r.problem, host).toBe('address_refused');
      expect(given, host).toEqual([]);
    }
    // A name resolving inside the network: refused all the same.
    await at('imap.inside.test', 993);
    const named = await test({ ...strict, resolve: async () => ['192.168.0.9'] });
    expect(named.r.problem).toBe('address_refused');
    // Said with the ports the operator allows (the O1 re-check, 6).
    expect(named.r.allowed_ports).toEqual([993]);
    const wider = await test({
      allowedPorts: [993, 1993],
      allowPrivate: false,
      resolve: async () => ['192.168.0.9'],
    });
    expect(wider.r.allowed_ports).toEqual([993, 1993]);
    const words = mailInTestResult(wider.r, 'INBOX').lines.join(' ');
    expect(words).toMatch(/its port isn’t one of 993, 1993/);
    expect(words).toMatch(/on port 993 or 1993/);
    // A public address on another port: refused.
    await at('imap.public.test', 25);
    const porty = await test({ ...strict, resolve: async () => ['203.0.113.7'] });
    expect(porty.r.problem).toBe('address_refused');
    expect(porty.given).toEqual([]);
    expect(imap.commands).toEqual([]);
    // Allowed by the operator: tested, at the address checked.
    await at('127.0.0.1', imap.port);
    const allowed = await test({ allowedPorts: [imap.port], allowPrivate: true });
    expect(allowed.r.problem).toBeNull();
    expect(allowed.given.map((g) => g.address)).toEqual(['127.0.0.1']);
  }, 60_000);

  it('Test the mailbox gives up after its time: an owner is never left waiting (the O1 review, L6)', async () => {
    const env = new FakeMailbox();
    env.inspect = () => new Promise(() => undefined);
    const { d } = deps({ env: { connector: env, folder: 'INBOX', authservId: null }, testMs: 200 });
    const id = await ask('mailbox', null);
    const t0 = Date.now();
    await runSettingsCheck(d, { household_id: hh, check_id: id });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await result(id))?.result).toMatchObject({ problem: 'unreachable' });
  }, 60_000);

  it('given up on, the connection is closed at once, not left to time out (the O1 re-check, 4)', async () => {
    // A server that takes the connection and never answers.
    const held: Socket[] = [];
    let closed = 0;
    const silent = createServer((c) => {
      held.push(c);
      // Read, so that its end is seen.
      c.resume();
      c.on('error', () => undefined);
      c.on('close', () => {
        closed += 1;
      });
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const port = (silent.address() as AddressInfo).port;
      const connector = new ImapMailbox({
        host: '127.0.0.1',
        port,
        user: 'x',
        password: 'y',
        ca: TEST_CERT,
      });
      const { d } = deps({ env: { connector, folder: 'INBOX', authservId: null }, testMs: 300 });
      const id = await ask('mailbox', null);
      await runSettingsCheck(d, { household_id: hh, check_id: id });
      expect((await result(id))?.result).toMatchObject({ problem: 'unreachable' });
      await expect.poll(() => closed, { timeout: 5_000 }).toBe(1);
    } finally {
      for (const c of held) c.destroy();
      silent.close();
    }
    // The fake's look is told so too.
    const env = new FakeMailbox();
    env.inspect = (folder, signal) => {
      signal?.addEventListener('abort', () => {
        env.aborted += 1;
      });
      return new Promise(() => void folder);
    };
    const { d } = deps({ env: { connector: env, folder: 'INBOX', authservId: null }, testMs: 100 });
    await runSettingsCheck(d, { household_id: hh, check_id: await ask('mailbox', null) });
    expect(env.aborted).toBe(1);
  }, 60_000);

  it('one Test of a household’s mailbox at a time, whichever worker asks: the other is told it is busy (the O1 re-check, 4)', async () => {
    const env = new FakeMailbox();
    let looks = 0;
    env.inspect = () => {
      looks += 1;
      return new Promise(() => undefined);
    };
    const { d } = deps({
      env: { connector: env, folder: 'INBOX', authservId: null },
      testMs: 1_500,
    });
    const one = await ask('mailbox', null);
    const two = await ask('mailbox', null);
    await Promise.all([
      runSettingsCheck(d, { household_id: hh, check_id: one }),
      new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
        runSettingsCheck(d, { household_id: hh, check_id: two }),
      ),
    ]);
    expect(looks).toBe(1);
    const problems = [
      ((await result(one))?.result as unknown as MailInTestFound).problem,
      ((await result(two))?.result as unknown as MailInTestFound).problem,
    ];
    expect(problems).toEqual(['unreachable', 'busy']);
  }, 60_000);

  it('nothing set up: said; set up here without a password: said too, the server’s never used instead', async () => {
    const { d } = deps();
    const id = await ask('mailbox', null);
    await runSettingsCheck(d, { household_id: hh, check_id: id });
    expect((await result(id))?.result).toMatchObject({ source: 'none', problem: 'not_set_up' });
    await admin.query(
      `insert into mail_in_mailbox (household_id, host, username) values ($1, 'imap.example.test', 'x@example.test')`,
      [hh],
    );
    const env = new FakeMailbox();
    const withEnv = deps({ env: { connector: env, folder: 'INBOX', authservId: null } });
    const next = await ask('mailbox', null);
    await runSettingsCheck(withEnv.d, { household_id: hh, check_id: next });
    expect((await result(next))?.result).toMatchObject({
      source: 'settings',
      problem: 'not_set_up',
    });
    expect(env.inspections).toEqual([]);
  }, 60_000);

  it('a path is refused again in the worker, whatever the API let through, and the answer written once', async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), 'fdv-check-root-')));
    const outside = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), 'fdv-check-out-')));
    dirs.push(root, outside);
    const { d } = deps({}, [root]);
    const id = await ask('folder', outside);
    await runSettingsCheck(d, { household_id: hh, check_id: id });
    const r = (await result(id))?.result as unknown as WatchVerifyFound;
    expect(r.steps.find((s) => s.check === 'inside')?.ok).toBe(false);
    expect(r.steps.find((s) => s.check === 'create')?.ok).toBeNull();
    expect(await fsp.readdir(outside)).toEqual([]);
    const b = await ask('browse', outside);
    await runSettingsCheck(d, { household_id: hh, check_id: b });
    expect(((await result(b))?.result as unknown as WatchBrowseResult).problem).toMatch(
      /isn’t one the vault may use/,
    );
    // Inside: answered, and the folder left as it was.
    const ok = await ask('folder', root);
    await runSettingsCheck(d, { household_id: hh, check_id: ok });
    expect(
      ((await result(ok))?.result as unknown as WatchVerifyFound).steps.every((s) => s.ok),
    ).toBe(true);
    expect(await fsp.readdir(root)).toEqual([]);
    expect(await there(root)).toBe(true);
    // Answers a day old are cleared away as the next is written.
    await admin.query(
      "update settings_check set requested_at = now() - interval '2 days' where id = $1",
      [id],
    );
    const last = await ask('browse', root);
    await runSettingsCheck(d, { household_id: hh, check_id: last });
    expect(await result(id)).toBeUndefined();
    // The worker writes it as the vault: the household's alone.
    const seen = await withSystem(db, hh, (trx) =>
      trx.selectFrom('settings_check').select('id').execute(),
    );
    expect(seen.map((s) => s.id)).toContain(last);
  }, 60_000);
});
