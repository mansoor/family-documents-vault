import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { deriveKey, EncryptStream, EnvKeyProvider, newKey, ScopeKeys, wrapKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewKey } from './previews.js';
import { decryptToBuffer } from './process-version.js';
import { drawSharePages, pruneSharePages, sharePageKey, watermarkText } from './share-pages.js';
import { detectTools, magickText } from './tools.js';

const run = promisify(execFile);
const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/** A PDF of `pages` US-letter pages, each saying which it is, built by hand. */
function pagesPdf(pages: number): Buffer {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + pages * 2;
  for (let i = 0; i < pages; i += 1) {
    const stream = `BT /F1 36 Tf 72 700 Td (PAGE ${i + 1}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
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

/** A JPEG's width and height, from its first start-of-frame marker. */
function jpegSize(b: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1] as number;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no frame');
}

const tools = await detectTools();
const drawing = Boolean(testAdminUrl()) && tools.pdftoppm && tools.magick;

/**
 * A view-only link's pages (5.18, A22): the vault's drawn pages, drawn
 * again for the link with whom it is for and the day it was made across
 * each, and removed when the link ends.
 */
describe.skipIf(!testAdminUrl())("a view-only link's pages", () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let vaultDir: string;
  const hh = randomUUID();
  let memberId: string;
  let accountId: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const adapter = () => new LocalAdapter(vaultDir);
  const credentialsKey = deriveKey(MASTER, 'vault-credentials');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-sp-vault-'));
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'P', 'Europe/London')",
      [hh],
    );
    memberId = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'M') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    accountId = (
      await admin.query<{ id: string }>(
        `insert into account (email) values ('sp-${hh}@example.test') returning id`,
      )
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [accountId, hh, memberId],
    );
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      await keys.mintMemberKey(trx, hh, memberId, null);
      const v = await trx
        .insertInto('vault')
        .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('household')
        .set({ active_vault_id: v.id })
        .where('id', '=', hh)
        .execute();
    });
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  /** A document with one version of `plain`, stored as the vault stores it. */
  async function store(plain: Buffer, mime: string, documentId?: string, versionNo = 1) {
    return withSystem(db, hh, async (trx) => {
      const doc =
        documentId ??
        (
          await trx
            .insertInto('document')
            .values({ household_id: hh, title: 't', visibility: 'household' })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const scope = await keys.unwrap(trx, { householdId: hh, kind: 'household' });
      const fileKey = newKey();
      const key = `${hh}/${doc}/${versionNo}/${randomUUID()}.enc`;
      const enc = new EncryptStream(fileKey);
      const [put] = await Promise.all([
        adapter().put(key, enc),
        pipeline(Readable.from([plain]), enc),
      ]);
      const vault = await trx.selectFrom('vault').select('id').executeTakeFirstOrThrow();
      const version = await trx
        .insertInto('document_version')
        .values({
          household_id: hh,
          document_id: doc,
          version_no: versionNo,
          filename: 'f',
          mime,
          byte_size: plain.length,
          sha256: Buffer.alloc(32),
          cipher_bytes: put.bytes,
          cipher_sha256: Buffer.from(put.sha256, 'hex'),
          storage_key: key,
          vault_id: vault.id,
          file_key_wrapped: wrapKey(fileKey, scope.key, `version:${doc}`),
          wrapped_by_scope: scope.id,
        })
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      return { documentId: doc, versionId: version.id, storageKey: version.storage_key, fileKey };
    });
  }

  /** A link to a document, made as 5.18 makes them, with whatever it has been through. */
  async function link(
    documentId: string,
    opts: { permission?: 'view' | 'download'; label?: string; ended?: string } = {},
  ) {
    const { rows } = await admin.query<{ id: string }>(
      `insert into share_link (household_id, document_id, token_hash, created_by, expires_at,
                               permission, recipient_label, created_at)
       values ($1, $2, $3, $4, now() + interval '7 days', $5, $6, '2026-09-27T10:00:00Z')
       returning id`,
      [hh, documentId, randomBytes(32), accountId, opts.permission ?? 'view', opts.label ?? null],
    );
    const id = rows[0]?.id as string;
    if (opts.ended) await admin.query(`update share_link set ${opts.ended} where id = $1`, [id]);
    return id;
  }

  const deps = () => ({
    db,
    keys,
    credentialsKey,
    localRoot: vaultDir,
    maxOcrPages: 1,
    log: () => undefined,
  });
  const pagesOf = async (shareId: string) =>
    (
      await admin.query<{ n: number; storage_key: string; version_id: string }>(
        'select n, storage_key, version_id from share_page where share_id = $1 order by n',
        [shareId],
      )
    ).rows;
  const exists = (key: string) =>
    adapter()
      .get(key)
      .then(
        (s) => {
          s.destroy();
          return true;
        },
        () => false,
      );

  it("what is written across is whom it is for and the day it was made, and ImageMagick's escapes are plain", () => {
    const made = new Date('2026-09-27T23:30:00Z');
    // Half past midnight in London: the household's day, not the server's.
    expect(
      watermarkText({ recipient_label: 'the letting agent', created_at: made }, 'Europe/London'),
    ).toBe('Shared with the letting agent · 28 September 2026');
    expect(watermarkText({ recipient_label: null, created_at: made }, 'UTC')).toBe(
      'Shared by link · 27 September 2026',
    );
    expect(magickText('100% %[fx:1] \\n and\u0007 more\nlines')).toBe(
      '100%% %%[fx:1] \\\\n and more lines',
    );
    expect(magickText('@/etc/passwd')).toBe(' @/etc/passwd');
    expect(magickText('x'.repeat(500))).toHaveLength(120);
  });

  it.skipIf(!drawing)(
    'every page of a view-only link carries the watermark',
    async () => {
      const v = await store(pagesPdf(3), 'application/pdf');
      const id = await link(v.documentId, { label: 'the letting agent' });
      // The version's own pages are drawn first, then the link's.
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 3,
      });
      const rows = await pagesOf(id);
      expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-ocr-'));
      try {
        for (const r of rows) {
          expect(r.storage_key).toBe(sharePageKey(v.storageKey, id, r.n));
          expect(r.version_id).toBe(v.versionId);
          const own = await decryptToBuffer(adapter(), previewKey(v.storageKey, r.n), v.fileKey);
          const marked = await decryptToBuffer(adapter(), r.storage_key, v.fileKey);
          // A picture, and not the vault's own page: the same width, and
          // taller by the band along its foot.
          expect(marked.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
          expect(marked.equals(own)).toBe(false);
          const [a, b] = [jpegSize(own), jpegSize(marked)];
          expect(b.width, `page ${r.n}`).toBe(a.width);
          expect(b.height, `page ${r.n}`).toBeGreaterThan(a.height);
          expect(marked.includes(Buffer.from('Exif'))).toBe(false);
          // And it says whom it is for, where a reader — or a machine — can see.
          if (tools.tesseract) {
            const file = path.join(scratch, `p${r.n}.jpg`);
            await writeFile(file, marked);
            const { stdout } = await run('tesseract', [file, '-', '--psm', '3'], {
              timeout: 120_000,
            });
            expect(stdout, `page ${r.n}`).toMatch(/letting\s+agent/i);
            expect(stdout, `page ${r.n}`).toMatch(/2026/);
          }
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      // Asked again, it has them: nothing is drawn twice.
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 3,
      });

      // A newer version: drawn again, and the older version's pages go.
      const newer = await store(pagesPdf(1), 'application/pdf', v.documentId, 2);
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 1,
      });
      expect((await pagesOf(id)).map((r) => r.version_id)).toEqual([newer.versionId]);
      for (const n of [1, 2, 3]) {
        expect(await exists(sharePageKey(v.storageKey, id, n)), `old page ${n}`).toBe(false);
      }
      // A label with ImageMagick's own escapes in it is drawn as it is written.
      const odd = await link(newer.documentId, { label: '100% %[fx:1] @/etc/hostname' });
      expect(await drawSharePages(deps(), { household_id: hh, share_id: odd })).toEqual({
        drawn: 1,
      });
    },
    180_000,
  );

  it('a link to download, or one that has ended, has nothing drawn', async () => {
    const v = await store(pagesPdf(1), 'application/pdf');
    const cases = [
      await link(v.documentId, { permission: 'download' }),
      await link(v.documentId, { ended: 'revoked_at = now(), revoked_by = created_by' }),
      await link(v.documentId, { ended: "expires_at = now() - interval '1 minute'" }),
      await link(v.documentId, { ended: "paused_at = now(), paused_reason = 'restored'" }),
      await link(v.documentId, { ended: 'attempts = 10' }),
    ];
    for (const id of cases) {
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 0,
      });
      expect(await pagesOf(id)).toEqual([]);
    }
    // Nor a link to a file the vault cannot draw.
    const word = await store(
      Buffer.from('PK not really a document'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const id = await link(word.documentId);
    expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
      drawn: 0,
    });
  });

  it("a link's pages go with it", async () => {
    const v = await store(pagesPdf(1), 'application/pdf');
    /** Pages as the worker leaves them: a file each, and a row. */
    const drawn = async (id: string, versionId = v.versionId, storageKey = v.storageKey) => {
      const key = sharePageKey(storageKey, id, 1);
      const enc = new EncryptStream(v.fileKey);
      await Promise.all([
        adapter().put(key, enc),
        pipeline(Readable.from([Buffer.from('a page')]), enc),
      ]);
      await admin.query(
        `insert into share_page (household_id, share_id, document_id, version_id, n, storage_key)
         values ($1, $2, $3, $4, 1, $5)`,
        [hh, id, v.documentId, versionId, key],
      );
      return key;
    };
    const live = await link(v.documentId);
    const taken = await link(v.documentId);
    const lapsed = await link(v.documentId);
    const usedUpOpen = await link(v.documentId);
    const usedUpShut = await link(v.documentId);
    const keysOf = {
      live: await drawn(live),
      taken: await drawn(taken),
      lapsed: await drawn(lapsed),
      usedUpOpen: await drawn(usedUpOpen),
      usedUpShut: await drawn(usedUpShut),
    };
    await admin.query(
      'update share_link set revoked_at = now(), revoked_by = created_by where id = $1',
      [taken],
    );
    await admin.query(
      "update share_link set expires_at = now() - interval '1 minute' where id = $1",
      [lapsed],
    );
    await admin.query('update share_link set max_opens = 2, open_count = 2 where id = any($1)', [
      [usedUpOpen, usedUpShut],
    ]);
    // Opened as often as it allows, but a page opened with it is still open.
    await admin.query(
      `insert into share_session (household_id, share_id, cookie_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [hh, usedUpOpen, randomBytes(32)],
    );

    // Taken back: the API asks for that one link's at once.
    expect(
      await pruneSharePages(
        { admin, app: db, credentialsKey, localRoot: vaultDir },
        { household_id: hh, share_id: taken },
      ),
    ).toEqual({ removed: 1 });
    expect(await pagesOf(taken)).toEqual([]);
    expect(await exists(keysOf.taken)).toBe(false);
    expect(await exists(keysOf.lapsed)).toBe(true);

    // And each night, the rest that have ended.
    expect(await pruneSharePages({ admin, app: db, credentialsKey, localRoot: vaultDir })).toEqual({
      removed: 2,
    });
    for (const [name, id, kept] of [
      ['live', live, true],
      ['lapsed', lapsed, false],
      ['used up, a page still open', usedUpOpen, true],
      ['used up, nothing open', usedUpShut, false],
    ] as const) {
      expect((await pagesOf(id)).length, name).toBe(kept ? 1 : 0);
    }
    expect(await exists(keysOf.live)).toBe(true);
    expect(await exists(keysOf.usedUpShut)).toBe(false);

    // A newer version replaces the one the live link's pages were drawn from.
    await store(pagesPdf(1), 'application/pdf', v.documentId, 2);
    expect(await pruneSharePages({ admin, app: db, credentialsKey, localRoot: vaultDir })).toEqual({
      removed: 2,
    });
    expect(await pagesOf(live)).toEqual([]);
    expect(await exists(keysOf.live)).toBe(false);
  });
});
