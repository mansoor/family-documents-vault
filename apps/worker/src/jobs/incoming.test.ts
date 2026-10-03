import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DecryptStream,
  EncryptStream,
  EnvKeyProvider,
  newKey,
  ScopeKeys,
  unwrapKey,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { incomingWords } from '@fdv/shared';
import { LocalAdapter, readAll, StorageError, type StorageAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  incomingEmail,
  moveIncoming,
  removeObjects,
  scanIncoming,
  sweepIncoming,
  tellReviewers,
  tellWaiting,
  type IncomingDeps,
} from './incoming.js';
import type { deliver } from './push.js';
import { detectTools } from './tools.js';

/**
 * What the worker does with what came in through a request (5.23): gets it
 * ready to be looked at (the scan — none here, A42 — and the pages), tells
 * its reviewers how many and nothing else, moves what a requester can no
 * longer review to the owners, and sweeps: 30 days, then gone.
 */

const MASTER = 'incoming-test-master-key-with-32-bytes-or-more';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const SMTP_HOST = process.env.MAILPIT_SMTP_HOST ?? 'localhost';

async function mailpitUp(): Promise<boolean> {
  try {
    return (
      await fetch(`${MAILPIT}/api/v1/messages?limit=1`, { signal: AbortSignal.timeout(1500) })
    ).ok;
  } catch {
    return false;
  }
}
const withMailpit = await mailpitUp();
const tools = await detectTools();
const drawing = tools.magick && tools.pdftoppm;

/** A one-page PDF, built by hand, saying what it is. */
function onePagePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe.skipIf(!testAdminUrl())('incoming files, in the worker', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  let vault: string;
  const hh = randomUUID();
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  /**
   * Who is in the household: three who review, and three who never do — a
   * teen, a viewer, and an adult whose sign-in was taken away — each with
   * a browser and a phone (W523-04).
   */
  type Who = 'owner' | 'adult' | 'other' | 'teen' | 'viewer' | 'disabled';
  const people: Record<Who, { account: string; member: string; email: string }> = {} as never;
  const NEVER_TOLD = ['teen', 'viewer', 'disabled'] as const;
  /** Every push the worker sent, as it left. */
  const pushes: Array<{ device: string; payload: string; type: string }> = [];
  const capture: typeof deliver = async (_deps, device, payload, type) => {
    pushes.push({ device: device.id ?? '', payload, type });
    return 'sent';
  };
  let deps: IncomingDeps;
  const adapter = () => new LocalAdapter(root);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    // A connection the server ends as the database is dropped is said on
    // the pool, not an unhandled error (the 5.23 review).
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-incoming-'));
    await admin.query("insert into household (id, name, timezone) values ($1, 'Incoming', 'UTC')", [
      hh,
    ]);
    for (const [who, role] of [
      ['owner', 'owner'],
      ['adult', 'adult'],
      ['other', 'adult'],
      ['teen', 'teen'],
      ['viewer', 'viewer'],
      ['disabled', 'adult'],
    ] as const) {
      const member = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, who],
        )
      ).rows[0]?.id as string;
      const email = `${who}-${stamp}@incoming.test`;
      const account = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          email,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [account, hh, member, role],
      );
      // A live sign-in, so their devices are pushed to.
      await admin.query(
        `insert into session (account_id, household_id, refresh_hash, expires_at)
         values ($1, $2, $3, now() + interval '30 days')`,
        [account, hh, randomBytes(32)],
      );
      people[who] = { account, member, email };
    }
    await admin.query('update account set disabled_at = now() where id = $1', [
      people.disabled.account,
    ]);
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const p of Object.values(people)) await keys.mintMemberKey(trx, hh, p.member, null);
      const v = await trx
        .insertInto('vault')
        .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
        .returning('id')
        .executeTakeFirstOrThrow();
      vault = v.id;
      await trx
        .updateTable('household')
        .set({ active_vault_id: v.id })
        .where('id', '=', hh)
        .execute();
    });
    // Each reviewer's browser and phone.
    for (const p of Object.values(people)) {
      for (const kind of ['web_push', 'unified_push']) {
        await admin.query(
          `insert into device (household_id, account_id, kind, endpoint, p256dh, auth)
           values ($1, $2, $3, $4, 'p256dh', 'auth')`,
          [hh, p.account, kind, `https://push.example.test/${kind}/${p.account}`],
        );
      }
    }
    // The household's mail server: Mailpit, from an address of this run's.
    if (withMailpit) {
      await admin.query(
        `insert into smtp_settings (household_id, host, port, secure, from_email, status)
         values ($1, $2, 1025, false, $3, 'ok')`,
        [hh, SMTP_HOST, `vault-${stamp}@incoming.test`],
      );
    }
    deps = {
      admin,
      db,
      keys,
      credentialsKey: Buffer.alloc(32),
      localRoot: root,
      log: () => undefined,
      tell: {
        vapid: {
          publicKey: 'public',
          privateKey: 'private',
          subject: 'mailto:vault@incoming.test',
        },
        smtpKey: Buffer.alloc(32),
        baseUrl: 'https://vault.incoming.test',
        deliver: capture,
      },
    };
  }, 90_000);
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const days = (n: number) => new Date(Date.now() - n * 864e5);

  /** A request, as 5.21 makes one. */
  const request = async (
    opts: {
      reviewBy?: 'me' | 'adults';
      requester?: 'owner' | 'adult' | 'other';
      label?: string | null;
      expires?: Date;
    } = {},
  ) => {
    const requester = people[opts.requester ?? 'adult'];
    const expires = opts.expires ?? new Date(Date.now() + 7 * 864e5);
    const { rows } = await admin.query<{ id: string }>(
      `insert into upload_request
         (household_id, created_by, requester_member_id, title, recipient_label, token_hash,
          expires_at, created_at, review_by)
       values ($1, $2, $3, 'Your tax papers', $4, $5, $6, least(now(), $6::timestamptz - interval '1 day'), $7)
       returning id`,
      [
        hh,
        requester.account,
        requester.member,
        opts.label === undefined ? 'Jane, accountant' : opts.label,
        randomBytes(32),
        expires,
        opts.reviewBy ?? 'me',
      ],
    );
    return rows[0]?.id as string;
  };

  /** A file sent through it, encrypted under its reviewer's key, as 5.21 keeps one. */
  const file = async (
    requestId: string,
    opts: {
      bytes?: Buffer;
      mime?: string;
      receivedAt?: Date;
      pages?: number;
      scan?: 'pending' | 'unscanned';
    } = {},
  ) => {
    const bytes = opts.bytes ?? onePagePdf('W-2 2025');
    const id = randomUUID();
    const fileKey = newKey();
    const storageKey = `${hh}/incoming/${requestId}/${randomBytes(8).toString('hex')}.enc`;
    const put = async (key: string, plain: Buffer) => {
      const enc = new EncryptStream(fileKey);
      const [stored] = await Promise.all([
        adapter().put(key, enc),
        pipeline(Readable.from([plain]), enc),
      ]);
      return stored;
    };
    const stored = await put(storageKey, bytes);
    for (let n = 1; n <= (opts.pages ?? 0); n++) {
      await put(`${storageKey}.p${n}.enc`, Buffer.from(`page ${n}`));
    }
    const [r] = (
      await admin.query<{ review_by: 'me' | 'adults'; requester_member_id: string }>(
        'select review_by, requester_member_id from upload_request where id = $1',
        [requestId],
      )
    ).rows;
    const scopeKey = await withSystem(db, hh, (trx) =>
      keys.unwrap(
        trx,
        r?.review_by === 'me'
          ? { householdId: hh, kind: 'member', memberId: r.requester_member_id }
          : { householdId: hh, kind: 'adults' },
      ),
    );
    const received = opts.receivedAt ?? new Date();
    await admin.query(
      `insert into incoming_file
         (id, household_id, request_id, review_by, requester_member_id, state, original_name,
          mime, byte_size, sha256, cipher_bytes, cipher_sha256, storage_key, vault_id,
          file_key_wrapped, wrapped_by_scope, scope, scan_state, preview_state, preview_pages,
          created_at, received_at, submitted_at)
       values ($1, $2, $3, $4, $5, 'received', 'W-2 2025.pdf', $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19, $19, $19)`,
      [
        id,
        hh,
        requestId,
        r?.review_by,
        r?.requester_member_id,
        opts.mime ?? 'application/pdf',
        bytes.length,
        randomBytes(32),
        stored.bytes,
        Buffer.from(stored.sha256, 'hex'),
        storageKey,
        vault,
        wrapKey(fileKey, scopeKey.key, `incoming:${id}`),
        scopeKey.id,
        r?.review_by === 'me' ? 'member' : 'adults',
        opts.scan ?? 'unscanned',
        opts.pages ? 'ready' : 'none',
        opts.pages ?? null,
        received,
      ],
    );
    return { id, storageKey, bytes };
  };

  const there = (key: string) =>
    stat(path.join(root, key)).then(
      () => true,
      () => false,
    );
  const row = async (id: string) =>
    (await admin.query<Record<string, unknown>>('select * from incoming_file where id = $1', [id]))
      .rows[0];
  /** What somebody signed in is given, as the database decides (0044, 0047). */
  const seenBy = async (
    who: 'owner' | 'adult' | 'other',
    role: 'owner' | 'adult' | 'teen',
    table: 'incoming_file' | 'upload_request',
    ids: string[],
  ) => {
    const app = new pg.Client({ connectionString: tdb.appUrl });
    await app.connect();
    try {
      await app.query('begin');
      await app.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', $4, true)`,
        [hh, people[who].account, people[who].member, role],
      );
      const { rows } = await app.query<{ id: string }>(
        `select id from ${table} where id = any($1::uuid[]) order by id`,
        [ids],
      );
      await app.query('commit');
      return rows.map((r) => r.id);
    } finally {
      await app.end();
    }
  };
  /** A document and a version to file something as, made as the vault would. */
  const filedAs = async () => {
    const doc = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'Filed') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const scope = (
      await admin.query<{ id: string }>(
        "select id from scope_key where household_id = $1 and kind = 'household'",
        [hh],
      )
    ).rows[0]?.id as string;
    const version = (
      await admin.query<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         values ($1, $2, 1, 'a.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5)
         returning id`,
        [hh, doc, `${hh}/${doc}/1/${randomUUID()}.enc`, vault, scope],
      )
    ).rows[0]?.id as string;
    return { doc, version };
  };
  /** Somebody signed in, on a connection of their own, holding a file as a decision does. */
  const holding = async (who: 'owner' | 'adult' | 'other', role: string, fileId: string) => {
    const app = new pg.Client({ connectionString: tdb.appUrl });
    app.on('error', () => undefined);
    await app.connect();
    try {
      await app.query('begin');
      await app.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', $4, true)`,
        [hh, people[who].account, people[who].member, role],
      );
      const { rows } = await app.query('select id from incoming_file where id = $1 for update', [
        fileId,
      ]);
      expect(rows).toHaveLength(1);
    } catch (err) {
      await app.end();
      throw err;
    }
    return {
      /**
       * Filed, as the API files it — a document and its version made by
       * them in this transaction, and the file pointed at it — then
       * committed.
       */
      file: async () => {
        try {
          const scope = (
            await admin.query<{ id: string }>(
              "select id from scope_key where household_id = $1 and kind = 'household'",
              [hh],
            )
          ).rows[0]?.id as string;
          const doc = (
            await app.query<{ id: string }>(
              `insert into document (household_id, title, created_by) values ($1, 'Filed', $2)
               returning id`,
              [hh, people[who].account],
            )
          ).rows[0]?.id as string;
          const version = (
            await app.query<{ id: string }>(
              `insert into document_version
                 (household_id, document_id, version_no, filename, mime, byte_size, sha256,
                  cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped,
                  wrapped_by_scope, uploaded_by)
               values ($1, $2, 1, 'a.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4,
                       '\\x00', $5, $6)
               returning id`,
              [hh, doc, `${hh}/${doc}/1/${randomUUID()}.enc`, vault, scope, people[who].account],
            )
          ).rows[0]?.id as string;
          await app.query(
            `update incoming_file set state = 'accepted', decided_by = $2, decided_at = now(),
                    document_id = $3, version_id = $4
              where id = $1`,
            [fileId, people[who].account, doc, version],
          );
          await app.query('commit');
        } finally {
          await app.end();
        }
      },
    };
  };
  const devicesOf = async (...who: Who[]) =>
    (
      await admin.query<{ id: string }>(
        'select id from device where account_id = any($1::uuid[])',
        [who.map((w) => people[w].account)],
      )
    ).rows
      .map((d) => d.id)
      .sort();
  const pushedTo = () => [...new Set(pushes.map((p) => p.device))].sort();
  /** An answer within two seconds, or 'held'. */
  const soon = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<'held'>((r) => setTimeout(() => r('held'), 2000))]);
  const lines = async (action: string) =>
    (
      await admin.query<{ object_id: string; detail: Record<string, unknown> }>(
        'select object_id, detail from audit_event where household_id = $1 and action = $2 order by id',
        [hh, action],
      )
    ).rows;

  it('getting ready: nothing scans here, so each file says it was not scanned; its pages are drawn, and its reviewers told', async () => {
    const r = await request({ reviewBy: 'me' });
    const pdf = await file(r, { scan: 'pending', bytes: onePagePdf('PAGE ONE') });
    const word = await file(r, { scan: 'pending', mime: WORD, bytes: Buffer.from('PK\x03\x04') });
    pushes.length = 0;
    const ready = await scanIncoming(deps, { household_id: hh, request_id: r });
    expect(ready).toBe(2);
    expect(await row(pdf.id)).toMatchObject({ scan_state: 'unscanned' });
    // A kind the vault does not draw says so.
    expect(await row(word.id)).toMatchObject({
      scan_state: 'unscanned',
      preview_state: 'unsupported',
      preview_pages: 0,
    });
    const drawn = await row(pdf.id);
    if (drawing) {
      expect(drawn).toMatchObject({ preview_state: 'ready', preview_pages: 1 });
      // Its page, encrypted under its own key, beside it: a JPEG.
      const page = await withSystem(db, hh, async (trx) => {
        const f = await trx
          .selectFrom('incoming_file')
          .select(['file_key_wrapped', 'wrapped_by_scope'])
          .where('id', '=', pdf.id)
          .executeTakeFirstOrThrow();
        const fileKey = unwrapKey(
          f.file_key_wrapped,
          await keys.unwrapById(trx, f.wrapped_by_scope),
          `incoming:${pdf.id}`,
        );
        const dec = new DecryptStream(fileKey);
        const [, plain] = await Promise.all([
          pipeline(await adapter().get(`${pdf.storageKey}.p1.enc`), dec),
          readAll(dec),
        ]);
        return plain;
      });
      expect([...page.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    } else {
      // Without the tools, it says it could not, and never that it did.
      expect(drawn).toMatchObject({ preview_state: 'failed', preview_pages: 0 });
    }
    // The requester, who alone reviews it, is told — on each of their
    // devices, once, and nobody else on any: two files.
    expect(pushes.map((p) => p.device).sort()).toEqual(await devicesOf('adult'));
    expect(
      pushes.every((p) => p.payload.includes('"count":2') || p.payload.includes('2 files')),
    ).toBe(true);
    for (const id of [pdf.id, word.id]) expect((await row(id))?.told_at).not.toBeNull();
    // Ready already: asked again, nothing is done twice and nobody told twice.
    pushes.length = 0;
    expect(await scanIncoming(deps, { household_id: hh, request_id: r })).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it('the push is a count and nothing else', async () => {
    const r = await request({ reviewBy: 'adults', requester: 'owner', label: 'Jane, accountant' });
    const sent = [await file(r, { scan: 'pending' }), await file(r, { scan: 'pending' })];
    // Only the files that are ready count: one still pending elsewhere does not.
    const still = await request({ reviewBy: 'adults', requester: 'owner' });
    await file(still, { scan: 'pending' });
    // And one waiting for another adult alone counts for them, and for
    // nobody else — whichever test ran before.
    const theirs = await request({ reviewBy: 'me', requester: 'other' });
    await file(theirs);
    pushes.length = 0;
    await admin.query(
      "update incoming_file set scan_state = 'unscanned' where id = any($1::uuid[])",
      [sent.map((f) => f.id)],
    );
    const told = await tellReviewers(
      deps,
      hh,
      sent.map((f) => f.id),
    );
    // Every reviewer — the owner and both adults — on both devices, once;
    // never a teen, a viewer, or an adult whose sign-in was taken away.
    const reviewers = await devicesOf('owner', 'adult', 'other');
    expect(pushes.map((p) => p.device).sort()).toEqual(reviewers);
    expect(told.pushed).toBe(reviewers.length);
    for (const d of await devicesOf(...NEVER_TOLD)) expect(pushedTo()).not.toContain(d);
    // Each reviewer's own count: every file waiting for them, the earlier
    // test's review-by-me files included for the adult who asked for them.
    const waitingFor = async (who: 'owner' | 'adult' | 'other') =>
      (
        await seenBy(
          who,
          who === 'owner' ? 'owner' : 'adult',
          'incoming_file',
          (
            await admin.query<{ id: string }>(
              "select id from incoming_file where household_id = $1 and state = 'received' and scan_state = 'unscanned'",
              [hh],
            )
          ).rows.map((x) => x.id),
        )
      ).length;
    for (const who of ['owner', 'adult', 'other'] as const) {
      const count = await waitingFor(who);
      const mine = (
        await admin.query<{ id: string; kind: string }>(
          'select id, kind from device where account_id = $1',
          [people[who].account],
        )
      ).rows;
      for (const d of mine) {
        const p = pushes.find((x) => x.device === d.id);
        expect(p?.type).toBe('incoming');
        if (d.kind === 'unified_push') {
          // A phone is told the word and the number, and nothing else.
          expect(JSON.parse(p?.payload ?? '{}')).toStrictEqual({ v: 1, type: 'incoming', count });
        } else {
          // A browser, a sentence with the number; a tap opens the files
          // waiting, where the email's link goes (W523-01).
          expect(JSON.parse(p?.payload ?? '{}')).toStrictEqual({
            title: 'Family Document Vault',
            body: incomingWords(count),
            tag: 'fdv-incoming',
            url: '/incoming',
          });
        }
      }
    }
    // Never a name, a label, a title or a file.
    for (const p of pushes) {
      for (const secret of ['Jane', 'accountant', 'W-2', 'tax papers', '.pdf']) {
        expect(p.payload).not.toContain(secret);
      }
    }
    // The email says the count and where to look, and nothing else.
    const email = incomingEmail(2, 'https://vault.incoming.test');
    expect(email.text).toBe(
      '2 files sent to your vault are waiting for you to look at.\n\nLook at them: https://vault.incoming.test/incoming\n',
    );
    for (const secret of ['Jane', 'accountant', 'W-2', 'tax papers', '.pdf']) {
      expect(`${email.subject} ${email.text} ${email.html}`).not.toContain(secret);
    }
    if (withMailpit) {
      expect(told.emailed).toBe(3);
      const to = people.other.email;
      type Mail = { Text?: string; Subject?: string };
      const lookFor = async (): Promise<Mail | null> => {
        for (let i = 0; i < 20; i++) {
          const list = (await (
            await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=1`)
          ).json()) as { messages?: Array<{ ID: string }> };
          const id = list.messages?.[0]?.ID;
          if (id) return (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as Mail;
          await new Promise((res) => setTimeout(res, 250));
        }
        return null;
      };
      const found = await lookFor();
      const count = await waitingFor('other');
      expect(found?.Subject).toBe(
        count === 1 ? 'A file is waiting for you' : 'Files are waiting for you',
      );
      // As sent, its lines ended the way mail ends them.
      expect(found?.Text?.replace(/\r\n/g, '\n').trim()).toBe(
        incomingEmail(count, 'https://vault.incoming.test').text.trim(),
      );
      // Nobody who does not review is written to.
      for (const who of NEVER_TOLD) {
        const list = (await (
          await fetch(
            `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${people[who].email}`)}&limit=1`,
          )
        ).json()) as { messages?: unknown[] };
        expect(list.messages ?? []).toEqual([]);
      }
    }
  });

  it('demoting the requester moves pending files to the owners', async () => {
    const r = await request({ reviewBy: 'me', requester: 'adult', label: 'Jane, accountant' });
    const waiting = [await file(r), await file(r, { pages: 1 })];
    const decided = await file(r);
    const as = await filedAs();
    await admin.query(
      `update incoming_file set state = 'accepted', decided_by = $2, decided_at = now(),
              document_id = $3, version_id = $4, object_removed_at = now() where id = $1`,
      [decided.id, people.adult.account, as.doc, as.version],
    );
    // A review-by-me request whose requester can still review is left alone.
    const kept = await request({ reviewBy: 'me', requester: 'other' });
    const keptFile = await file(kept);
    const ids = [...waiting.map((f) => f.id), decided.id];
    // Before: the requester's alone (A43).
    expect(await seenBy('adult', 'adult', 'incoming_file', ids)).toHaveLength(3);
    expect(await seenBy('owner', 'owner', 'incoming_file', ids)).toHaveLength(0);

    // Made a teen.
    await admin.query(
      "update account_household set role = 'teen' where account_id = $1 and household_id = $2",
      [people.adult.account, hh],
    );
    pushes.length = 0;
    // These two, and any other of theirs still waiting (an earlier test's).
    expect(await moveIncoming(deps, { household_id: hh })).toBeGreaterThanOrEqual(2);

    // Each waiting file: rewrapped for the adults key, the owners' alone.
    const adults = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'adults' }),
    );
    for (const f of waiting) {
      const moved = await row(f.id);
      expect(moved).toMatchObject({
        state: 'received',
        review_by: 'adults',
        scope: 'adults',
        owners_only: true,
        wrapped_by_scope: adults.id,
      });
      // The round trip: the adults key opens it, and it is what was sent.
      const fileKey = unwrapKey(moved?.file_key_wrapped as Buffer, adults.key, `incoming:${f.id}`);
      const dec = new DecryptStream(fileKey);
      const [, plain] = await Promise.all([
        pipeline(await adapter().get(f.storageKey), dec),
        readAll(dec),
      ]);
      expect(plain.equals(f.bytes)).toBe(true);
    }
    // The decided one stays decided, the owners' too.
    expect(await row(decided.id)).toMatchObject({ state: 'accepted', owners_only: true });
    const [req] = (
      await admin.query<Record<string, unknown>>(
        'select review_by, moved_to_owners_at, closed_reason from upload_request where id = $1',
        [r],
      )
    ).rows;
    expect(req).toMatchObject({ review_by: 'adults', closed_reason: 'requester_lost_right' });
    expect(req?.moved_to_owners_at).not.toBeNull();

    // An owner is given them; another adult, and the requester, not.
    expect(await seenBy('owner', 'owner', 'incoming_file', ids)).toHaveLength(3);
    expect(await seenBy('owner', 'owner', 'upload_request', [r])).toEqual([r]);
    expect(await seenBy('other', 'adult', 'incoming_file', ids)).toHaveLength(0);
    expect(await seenBy('other', 'adult', 'upload_request', [r])).toEqual([]);
    expect(await seenBy('adult', 'teen', 'incoming_file', ids)).toHaveLength(0);

    // Written down, with how many and whom from; never a file's name.
    const [line] = (await lines('incoming.moved')).filter((l) => l.object_id === r);
    expect(line?.detail).toEqual({ files: 2, from: 'Jane, accountant' });
    // And the owners are told; nobody else.
    const owners = (
      await admin.query<{ id: string }>('select id from device where account_id = $1', [
        people.owner.account,
      ])
    ).rows.map((d) => d.id);
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((p) => owners.includes(p.device))).toBe(true);

    // The other request is untouched; asked again, there is nothing to move.
    expect(await row(keptFile.id)).toMatchObject({ review_by: 'me', owners_only: false });
    expect(await moveIncoming(deps, { household_id: hh })).toBe(0);
    await admin.query(
      "update account_household set role = 'adult' where account_id = $1 and household_id = $2",
      [people.adult.account, hh],
    );
  });

  it('not accepted in 30 days: purged, object and row', async () => {
    const r = await request({ reviewBy: 'adults', requester: 'owner', label: 'Jane, accountant' });
    const old = await file(r, { receivedAt: days(31), pages: 2 });
    const young = await file(r, { receivedAt: days(29) });
    const report = await sweepIncoming(deps);
    expect(report.purged).toBeGreaterThanOrEqual(1);
    // Gone: its bytes, its pages, its row.
    expect(await there(old.storageKey)).toBe(false);
    expect(await there(`${old.storageKey}.p1.enc`)).toBe(false);
    expect(await there(`${old.storageKey}.p2.enc`)).toBe(false);
    expect(await row(old.id)).toBeUndefined();
    // A day younger stays, bytes and all.
    expect(await row(young.id)).toMatchObject({ state: 'received' });
    expect(await there(young.storageKey)).toBe(true);
    // Written down for the request: how many, and whom from.
    const [line] = (await lines('incoming.purged')).filter((l) => l.object_id === r);
    expect(line?.detail).toEqual({ files: 1, from: 'Jane, accountant' });
  });

  it('a file being filed as the sweep comes: the sweep waits, and leaves it filed', async () => {
    const r = await request({ reviewBy: 'adults', requester: 'owner' });
    const old = await file(r, { receivedAt: days(40) });
    const filing = await holding('other', 'adult', old.id);
    const sweeping = sweepIncoming(deps);
    expect(await soon(sweeping)).toBe('held');
    await filing.file();
    await sweeping;
    // Filed, not purged: its row, and its bytes for the API to remove.
    expect(await row(old.id)).toMatchObject({ state: 'accepted' });
    expect(await there(old.storageKey)).toBe(true);
  });

  it('a file being filed as its requester can no longer review: the move waits, and moves only what is still waiting', async () => {
    const r = await request({ reviewBy: 'me', requester: 'other' });
    const first = await file(r);
    const second = await file(r);
    await admin.query(
      "update account_household set role = 'viewer' where account_id = $1 and household_id = $2",
      [people.other.account, hh],
    );
    // Filing began while they could still review: held as the API holds it.
    const filing = await holding('other', 'adult', first.id);
    const moving = moveIncoming(deps, { household_id: hh });
    expect(await soon(moving)).toBe('held');
    await filing.file();
    await moving;
    expect(await row(first.id)).toMatchObject({ state: 'accepted', owners_only: true });
    expect(await row(second.id)).toMatchObject({
      state: 'received',
      review_by: 'adults',
      owners_only: true,
    });
    await admin.query(
      "update account_household set role = 'adult' where account_id = $1 and household_id = $2",
      [people.other.account, hh],
    );
  });

  it("a decided file's bytes left behind are removed by the sweep", async () => {
    const r = await request({ reviewBy: 'adults', requester: 'owner' });
    const left = await file(r, { pages: 1 });
    await admin.query(
      `update incoming_file set state = 'rejected', decided_by = $2,
              decided_at = now() - interval '1 hour' where id = $1`,
      [left.id, people.owner.account],
    );
    expect(await there(left.storageKey)).toBe(true);
    const report = await sweepIncoming(deps);
    expect(report.objectsRemoved).toBeGreaterThanOrEqual(1);
    expect(await there(left.storageKey)).toBe(false);
    expect(await there(`${left.storageKey}.p1.enc`)).toBe(false);
    expect((await row(left.id))?.object_removed_at).not.toBeNull();
  });

  it('a request past its end with nothing waiting and nothing filed is removed; one with something filed stays', async () => {
    const ended = days(2);
    const refused = await request({ reviewBy: 'adults', requester: 'owner', expires: ended });
    const refusedFile = await file(refused);
    await admin.query(
      `update incoming_file set state = 'rejected', decided_by = $2, decided_at = now(),
              object_removed_at = now() where id = $1`,
      [refusedFile.id, people.owner.account],
    );
    const filed = await request({ reviewBy: 'adults', requester: 'owner', expires: ended });
    const filedFile = await file(filed);
    const as = await filedAs();
    await admin.query(
      `update incoming_file set state = 'accepted', decided_by = $2, decided_at = now(),
              document_id = $3, version_id = $4, object_removed_at = now() where id = $1`,
      [filedFile.id, people.owner.account, as.doc, as.version],
    );
    const stillWaiting = await request({ reviewBy: 'adults', requester: 'owner', expires: ended });
    await file(stillWaiting);
    const live = await request({ reviewBy: 'adults', requester: 'owner' });
    await sweepIncoming(deps);
    const left = (
      await admin.query<{ id: string }>(
        'select id from upload_request where id = any($1::uuid[])',
        [[refused, filed, stillWaiting, live]],
      )
    ).rows.map((x) => x.id);
    expect(left.sort()).toEqual([filed, stillWaiting, live].sort());
    expect(await row(refusedFile.id)).toBeUndefined();
    // A document's history still says where its version came from.
    expect(await row(filedFile.id)).toMatchObject({ state: 'accepted', version_id: as.version });
  });

  it('a scan that stopped after getting files ready and before telling: the next scan, or the sweep, tells — once (W523-02)', async () => {
    const r = await request({ reviewBy: 'me', requester: 'adult' });
    // Marked not scanned and its pages drawn, then the job stopped: nobody told.
    const first = await file(r, { pages: 1 });
    expect((await row(first.id))?.told_at).toBeNull();
    pushes.length = 0;
    // The job again: nothing left to get ready, but somebody to tell.
    expect(await scanIncoming(deps, { household_id: hh, request_id: r })).toBe(0);
    expect(pushes.map((p) => p.device).sort()).toEqual(await devicesOf('adult'));
    expect((await row(first.id))?.told_at).not.toBeNull();

    // Another stopped the same way, and its job was lost: the sweep tells.
    const second = await file(r, { pages: 1 });
    pushes.length = 0;
    await sweepIncoming(deps);
    const adults = await devicesOf('adult');
    expect(pushes.filter((p) => adults.includes(p.device))).toHaveLength(adults.length);
    expect((await row(second.id))?.told_at).not.toBeNull();
    // Told once: nobody is told of them again.
    pushes.length = 0;
    expect((await sweepIncoming(deps)).told).toBe(0);
    expect(await scanIncoming(deps, { household_id: hh, request_id: r })).toBe(0);
    expect(pushes).toHaveLength(0);

    // Told only once its pages are there (N523A-03): one still being drawn,
    // by a job begun a moment ago and still at it, is nobody's news yet.
    const drawing = await file(r, { pages: 1 });
    await admin.query(
      `update incoming_file set preview_state = 'drawing', preview_pages = null,
              preview_requested_at = now() where id = $1`,
      [drawing.id],
    );
    expect(await tellWaiting(deps, hh, r)).toBe(0);
    expect((await sweepIncoming(deps)).told).toBe(0);
    expect(pushes).toHaveLength(0);
    expect((await row(drawing.id))?.told_at).toBeNull();
    // Drawn: told, once.
    await admin.query(
      "update incoming_file set preview_state = 'ready', preview_pages = 1 where id = $1",
      [drawing.id],
    );
    expect(await tellWaiting(deps, hh, r)).toBe(1);
    expect(pushes.map((p) => p.device).sort()).toEqual(adults);
    expect((await row(drawing.id))?.told_at).not.toBeNull();
    pushes.length = 0;
    expect(await tellWaiting(deps, hh, r)).toBe(0);
    expect((await sweepIncoming(deps)).told).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it('every page of a decided or purged file is removed, whatever its row says was drawn (F523-3)', async () => {
    const r = await request({ reviewBy: 'adults', requester: 'owner' });
    const refused = await file(r, { pages: 3 });
    const old = await file(r, { pages: 3, receivedAt: days(31) });
    // Drawn part-way when the drawing stopped: three pages stored, the row
    // still saying they are being drawn, and counting none.
    await admin.query(
      "update incoming_file set preview_state = 'drawing', preview_pages = null where id = any($1::uuid[])",
      [[refused.id, old.id]],
    );
    await admin.query(
      `update incoming_file set state = 'rejected', decided_by = $2,
              decided_at = now() - interval '1 hour', original_name = null, sha256 = null
        where id = $1`,
      [refused.id, people.owner.account],
    );
    await sweepIncoming(deps);
    for (const f of [refused, old]) {
      for (const n of [1, 2, 3]) expect(await there(`${f.storageKey}.p${n}.enc`)).toBe(false);
      expect(await there(f.storageKey)).toBe(false);
    }
    expect((await row(refused.id))?.object_removed_at).not.toBeNull();
    expect(await row(old.id)).toBeUndefined();
  });

  it('a filed version whose own copy is missing is made again from the file sent in before that goes (F523-2)', async () => {
    const r = await request({ reviewBy: 'adults', requester: 'owner' });
    const sent = await file(r, { pages: 1 });
    // Filed, its copy taken back by a request that never heard the filing
    // commit: the version's object is not there; the file sent in still is.
    const [f] = (
      await admin.query<{ cipher_bytes: string; cipher_sha256: Buffer; file_key_wrapped: Buffer }>(
        'select cipher_bytes, cipher_sha256, file_key_wrapped from incoming_file where id = $1',
        [sent.id],
      )
    ).rows;
    const scope = (
      await admin.query<{ id: string }>(
        "select id from scope_key where household_id = $1 and kind = 'household'",
        [hh],
      )
    ).rows[0]?.id as string;
    const doc = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'Filed, no copy') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const versionKey = `${hh}/${doc}/1/${randomUUID()}.enc`;
    const version = (
      await admin.query<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         values ($1, $2, 1, 'a.pdf', 'application/pdf', $3, '\\x00', $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          hh,
          doc,
          sent.bytes.length,
          f?.cipher_bytes,
          f?.cipher_sha256,
          versionKey,
          vault,
          f?.file_key_wrapped,
          scope,
        ],
      )
    ).rows[0]?.id as string;
    await admin.query(
      `update incoming_file set state = 'accepted', decided_by = $2,
              decided_at = now() - interval '1 hour', document_id = $3, version_id = $4
        where id = $1`,
      [sent.id, people.owner.account, doc, version],
    );
    expect(await there(versionKey)).toBe(false);

    const report = await sweepIncoming(deps);
    expect(report.versionsRepaired).toBeGreaterThanOrEqual(1);
    // The version's bytes are there, the very bytes that came in...
    const copied = await readAll(await adapter().get(versionKey));
    expect(
      createHash('sha256')
        .update(copied)
        .digest()
        .equals(f?.cipher_sha256 as Buffer),
    ).toBe(true);
    // ...and only then the file sent in, and its pages, went.
    expect(await there(sent.storageKey)).toBe(false);
    expect(await there(`${sent.storageKey}.p1.enc`)).toBe(false);
    expect((await row(sent.id))?.object_removed_at).not.toBeNull();
  });
});

/**
 * A file's objects removed by the worker (the 5.23 review, N523A-02): its
 * pages all at once, not thirty round trips in a row inside purgeOld's
 * lock; its object once they are gone; and a page that cannot be removed
 * fails the whole, so the row stays for the next sweep.
 */
describe('removing a file sent in', () => {
  /** A bucket whose deletes each take a moment, counting how many are under way at once. */
  const slow = (failing: string[] = []) => {
    const state = { inFlight: 0, most: 0, done: [] as string[] };
    const adapter = {
      delete: async (key: string) => {
        state.inFlight += 1;
        state.most = Math.max(state.most, state.inFlight);
        try {
          await new Promise((r) => setTimeout(r, 15));
          if (failing.includes(key))
            throw new StorageError('unreachable', `could not delete ${key}`);
          state.done.push(key);
        } finally {
          state.inFlight -= 1;
        }
      },
    } as unknown as StorageAdapter;
    return { adapter, state };
  };

  it('deletes its pages together, then its object', async () => {
    const { adapter, state } = slow();
    await removeObjects(adapter, { storage_key: 'hh/incoming/r/f.enc' });
    expect(state.most).toBe(30);
    expect(state.done).toHaveLength(31);
    expect(state.done.at(-1)).toBe('hh/incoming/r/f.enc');
  });

  it('a page that cannot be deleted fails it, and its object is kept for the next try', async () => {
    const { adapter, state } = slow(['hh/incoming/r/f.enc.p2.enc']);
    await expect(removeObjects(adapter, { storage_key: 'hh/incoming/r/f.enc' })).rejects.toThrow(
      'could not delete hh/incoming/r/f.enc.p2.enc',
    );
    // Every other page was tried and went; the object was not touched.
    expect(state.done).toHaveLength(29);
    expect(state.done).not.toContain('hh/incoming/r/f.enc');
  });
});
