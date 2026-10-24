import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  EncryptStream,
  EnvKeyProvider,
  newKey,
  openBytes,
  readingMissesBinding,
  readingWorkBinding,
  ScopeKeys,
  wrapKey,
} from '@fdv/crypto';
import { appendAudit, createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { numbersOnly, ONLY_ME_KIND, type ReadingCheckSummary, type ReadingMiss } from '@fdv/shared';
import { TUNED } from '@fdv/shared/testdata';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { extractText } from './extract-text.js';
import { createQueue } from '../queue.js';
import { ProposalThread, type ItemProposer } from './proposal-thread.js';
import {
  chooseDocuments,
  otherWorkWaiting,
  READING_CHECK_PRIORITY,
  readingCheckNow,
  sendReadingCheck,
  sweepReadingChecks,
  sweepReadingTemp,
  workReadingCheck,
  type Reader,
  type ReadingCheckDeps,
  type ReadingOptions,
  type ReadingRunAnswer,
} from './reading-check.js';
import { readingCheckCommand } from '../reading-check-cli.js';
import { atLowPriority, detectTools, lowPriorityCommand, runTool } from './tools.js';

/**
 * The Reading check in the worker (0.9.0, R0): the last documents filed
 * through review, re-read as the owner who asked — only those they can see,
 * never somebody else's Only me, nothing in the Trash — twice, without and
 * with the filers' rules, scored by the Smart exit's scorer; numbers kept,
 * misses sealed for that owner alone; nothing written to any document,
 * item, proposal or rule.
 */

const MASTER = 'reading-check-test-master-key-with-32-bytes-or-more';
const tools = await detectTools();
/** What must never come out of a check: an Only me document's words and number. */
const SECRET_WORDS = 'PLANTED-SECRET-WORDS-7Q4Z';
const SECRET_NUMBER = 'SECRETNO-99173';

const passport = TUNED.find((f) => f.name === 'uk-passport-sara');
if (!passport) throw new Error('the fixture is missing');

const DENTIST = [
  'Northgate Dental',
  '14 Mill Lane, Leeds LS1 4AB',
  'Dear patient,',
  'Thank you for your visit on 2 March 2026. Your next check-up is due in six months.',
  'Yours sincerely',
].join('\n');

describe.skipIf(!testAdminUrl())('the Reading check, in the worker (R0)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  let deps: ReadingCheckDeps;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  let vault: string;
  const m: Record<string, string> = {};
  const acct: Record<string, string> = {};
  let thread: ProposalThread;
  /** The words of each document, by id; and which were asked for. */
  const words = new Map<string, string | Error>();
  const extracted: string[] = [];
  /** Called as each document's words are taken: a test's way in mid-check. */
  let hook: ((n: number, signal: AbortSignal | undefined) => Promise<void>) | null = null;
  /** Whether each read's tools were to run niced, one thread (R-3). */
  const niced: boolean[] = [];
  const extract: typeof extractText = async (source, _mime, o) => {
    const bytes = await readFile(source, 'utf8');
    const id = /doc:([0-9a-f-]{36})/.exec(bytes)?.[1] ?? '';
    extracted.push(id);
    niced.push(lowPriorityCommand('tool', [], undefined).env?.OMP_THREAD_LIMIT === '1');
    await hook?.(extracted.length, o.signal);
    const w = words.get(id);
    if (w instanceof Error) throw w;
    return { text: w ?? '', source: 'pdf', textPages: 1, ocrPages: 0 };
  };
  const opts = (): ReadingOptions => ({ maxPages: 5, proposer: thread, tools, extract });
  const doc: Record<string, string> = {};
  let filedAt = Date.now() - 3_600_000;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-reading-'));
    hh = randomUUID();
    // The vault's reading model (0.9.0, R2) off: what is measured here is R0's scoring of the rules' reading (its own
    // tests are reading-model*.test.ts and read-item.test.ts).
    await admin.query(
      "insert into household (id, name, timezone, reading_model) values ($1, 'The Khan family', 'Europe/London', false)",
      [hh],
    );
    await admin.query("insert into household_profile (household_id, country) values ($1, 'GB')", [
      hh,
    ]);
    for (const [name, role] of [
      ['Olivia', 'owner'],
      ['Omar', 'owner'],
      ['Sara', 'adult'],
      ['Ahmed', 'adult'],
      ['Zain', 'teen'],
      ['Granny Ruth', null],
    ] as const) {
      m[name] = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, name],
        )
      ).rows[0]?.id as string;
      if (!role) continue;
      acct[name] = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          `${name.toLowerCase().replace(' ', '-')}-${stamp}@reading.test`,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [acct[name], hh, m[name], role],
      );
    }
    vault = await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const who of Object.keys(m)) await keys.mintMemberKey(trx, hh, m[who] as string, null);
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
      return v.id;
    });
    deps = {
      db,
      keys,
      credentialsKey: Buffer.alloc(32),
      localRoot: root,
      log: (level, msg, extra) => logged.push(JSON.stringify({ level, msg, ...extra })),
      rulesKey: Buffer.alloc(32, 7),
      serverVersion: '0.9.0-dev.1',
    };
    thread = new ProposalThread();

    // Filed through review, oldest first: each a version an accept made.
    doc.passport = await filed({
      words: passport.text,
      by: 'Olivia',
      type_key: 'passport',
      owner: 'Sara',
      expires: passport.truth.expires,
      issued: passport.truth.issued,
      identifier: passport.truth.identifier,
      issued_by: passport.truth.issued_by,
    });
    doc.dentist = await filed({
      words: DENTIST,
      by: 'Ahmed',
      type_key: 'medical_record',
      owner: 'Zain',
      issued_by: 'Northgate Dental',
    });
    // Sara's Only me: never Olivia's to see, so never read for her.
    doc.saras = await filed({
      words: `${SECRET_WORDS}\nPassport No. ${SECRET_NUMBER}`,
      by: 'Sara',
      type_key: 'passport',
      owner: 'Sara',
      visibility: 'private',
      identifier: SECRET_NUMBER,
    });
    // Olivia's own Only me: hers, counted by kind only as "(only me)".
    doc.olivias = await filed({
      words: DENTIST,
      by: 'Olivia',
      type_key: 'medical_record',
      owner: 'Olivia',
      visibility: 'private',
    });
    // In the Trash: never read.
    doc.trashed = await filed({ words: DENTIST, by: 'Olivia', type_key: 'warranty', trash: true });
    // Its pages give OCR trouble: not read, never a crash.
    doc.unreadable = await filed({
      words: new Error('tesseract: failed on page 1'),
      by: 'Olivia',
      type_key: 'utility_bill',
      owner: 'Olivia',
    });
    // Filed by hand, never through review: not a check's.
    doc.byHand = await filed({ words: DENTIST, by: 'Olivia', type_key: 'warranty', review: false });
    // Ahmed's rules for the dentist: the kind and whose (I4).
    await admin.query(
      `insert into intake_rule (household_id, member_id, issuer_key, type_key, person_id, confirmed, contradicted)
       values ($1, $2, 'northgate dental', 'medical_record', null, 5, 0),
              ($1, $2, 'northgate dental', null, $3, 5, 0)`,
      [hh, m.Ahmed, m.Zain],
    );
    // And Olivia's own for the same dentist: hers, on what she filed.
    await admin.query(
      `insert into intake_rule (household_id, member_id, issuer_key, type_key, person_id, confirmed, contradicted)
       values ($1, $2, 'northgate dental', 'medical_record', null, 5, 0),
              ($1, $2, 'northgate dental', null, $2, 5, 0)`,
      [hh, m.Olivia],
    );
  }, 120_000);

  const logged: string[] = [];

  afterAll(async () => {
    await thread?.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    extracted.length = 0;
    niced.length = 0;
    hook = null;
    await admin.query('delete from reading_check where household_id = $1', [hh]);
  });

  /** A document, its one version encrypted under its scope's key, filed through review by `by` (unless `review` is false). */
  async function filed(o: {
    words: string | Error;
    by: string;
    type_key: string;
    owner?: string;
    visibility?: 'household' | 'adults' | 'private';
    expires?: string | null;
    issued?: string | null;
    identifier?: string | null;
    issued_by?: string | null;
    trash?: boolean;
    review?: boolean;
    /** Done before it is filed: an accept's own line in the activity log, say. */
    beforeFiling?: (id: string) => Promise<void>;
    /** What the accept confirmed: a batch's every detail, unless a test says. */
    confirmed?: string[];
    source?: 'batch' | 'inbox';
  }): Promise<string> {
    const id = randomUUID();
    const visibility = o.visibility ?? 'household';
    const owner = o.owner ? (m[o.owner] as string) : null;
    await admin.query(
      `insert into document (id, household_id, title, type_key, owner_member_id, visibility, expires_on,
                             issued_on, identifier, issued_by, created_by, deleted_at,
                             expires_precision, issued_precision)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               case when $7::date is null then null else 'day'::date_precision end,
               case when $8::date is null then null else 'day'::date_precision end)`,
      [
        id,
        hh,
        `Document ${o.type_key}`,
        o.type_key,
        owner,
        visibility,
        o.expires ?? null,
        o.issued ?? null,
        o.identifier ?? null,
        o.issued_by ?? null,
        acct[o.by],
        o.trash ? new Date() : null,
      ],
    );
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(
        trx,
        visibility === 'private'
          ? { householdId: hh, kind: 'member', memberId: owner }
          : { householdId: hh, kind: visibility === 'adults' ? 'adults' : 'household' },
      ),
    );
    const fileKey = newKey();
    const bytes = Buffer.from(`%PDF-1.4\n% doc:${id}\n%%EOF\n`);
    const key = `${hh}/${id}/v1/${randomBytes(6).toString('hex')}.enc`;
    const enc = new EncryptStream(fileKey);
    await Promise.all([
      new LocalAdapter(root).put(key, enc),
      pipeline(Readable.from([bytes]), enc),
    ]);
    const version = (
      await admin.query<{ id: string }>(
        `insert into document_version (household_id, document_id, version_no, filename, mime, byte_size,
                                       sha256, cipher_bytes, cipher_sha256, storage_key, vault_id,
                                       file_key_wrapped, wrapped_by_scope, uploaded_by)
         values ($1, $2, 1, 'scan.pdf', 'application/pdf', $3, $4, 60, $5, $6, $7, $8, $9, $10)
         returning id`,
        [
          hh,
          id,
          bytes.length,
          createHash('sha256').update(bytes).digest(),
          randomBytes(32),
          key,
          vault,
          wrapKey(fileKey, scope.key, `version:${id}`),
          scope.id,
          acct[o.by],
        ],
      )
    ).rows[0]?.id as string;
    await o.beforeFiling?.(id);
    if (o.review !== false) {
      filedAt += 60_000;
      await admin.query(
        `insert into review_filing (version_id, household_id, document_id, filed_by, filed_at,
                                   source, confirmed, filed_audit_id)
         values ($1, $2, $3, $4, $5, $6, $7,
                 (select coalesce(max(id), 0) from audit_event where household_id = $2))`,
        [
          version,
          hh,
          id,
          acct[o.by],
          new Date(filedAt),
          o.source ?? 'batch',
          o.confirmed ?? ['kind', 'person', 'expiry', 'issued', 'number', 'issuer'],
        ],
      );
    }
    words.set(id, o.words);
    return id;
  }

  /** A check asked for by `who`, as the API makes one. */
  const ask = async (who: string, n = 50, includeEdited = true) =>
    (
      await admin.query<{ id: string }>(
        `insert into reading_check (household_id, requested_by, member_id, n, include_edited)
         values ($1, $2, $3, $4, $5) returning id`,
        [hh, acct[who], m[who], n, includeEdited],
      )
    ).rows[0]?.id as string;

  /** Runs the job until it says there is nothing more to do now. */
  const runAll = async (id: string, o: Partial<ReadingOptions> = {}) => {
    for (let i = 0; i < 50; i++) {
      const r = await workReadingCheck(
        deps,
        { household_id: hh, check_id: id },
        { ...opts(), ...o },
      );
      if (r.next === null) return;
    }
    throw new Error(`the check never finished: ${logged.slice(-3).join('; ')}`);
  };
  const checkRow = async (id: string) =>
    (
      await admin.query<{
        state: string;
        summary: ReadingCheckSummary | null;
        total: number;
        done: number;
        server_version: string | null;
        rules_hash: string | null;
        failure: string | null;
      }>('select * from reading_check where id = $1', [id])
    ).rows[0];
  const sealedRow = async (id: string) =>
    (
      await admin.query<{
        member_id: string;
        work_sealed: Buffer | null;
        misses_sealed: Buffer | null;
        expires_at: Date;
      }>('select * from reading_check_sealed where check_id = $1', [id])
    ).rows[0];
  const memberKey = (who: string) =>
    withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: m[who] as string }),
    );
  const missesOf = async (id: string, who: string): Promise<ReadingMiss[]> => {
    const row = await sealedRow(id);
    const k = await memberKey(who);
    return (
      JSON.parse(
        openBytes(k.key, row?.misses_sealed as Buffer, readingMissesBinding(id)).toString('utf8'),
      ) as { misses: ReadingMiss[] }
    ).misses;
  };

  it('reads the documents filed through review that the owner can see, both ways, and keeps numbers only', async () => {
    const id = await ask('Olivia');
    await runAll(id);
    const row = await checkRow(id);
    expect(row?.state).toBe('done');
    const s = row?.summary as ReadingCheckSummary;
    expect(numbersOnly(s)).toBe(true);
    // Passport, dentist, her own Only me, the unreadable one; not Sara's, not the Trash, not by hand.
    expect(s.chosen).toBe(4);
    expect(s.read).toBe(4);
    expect(row?.total).toBe(4);
    expect(row?.done).toBe(4);
    expect(new Set(extracted)).toEqual(
      new Set([doc.passport, doc.dentist, doc.olivias, doc.unreadable]),
    );
    expect(extracted).not.toContain(doc.saras);
    expect(extracted).not.toContain(doc.trashed);
    expect(extracted).not.toContain(doc.byHand);
    // The passport reads Ready and right; the OCR failure is not read. The
    // dentist's letter Ahmed filed needs its kind and person typed both ways:
    // with rules is Olivia's own learning, on what she filed, never Ahmed's.
    // Her own letter needs typing without her rules, and not with them.
    expect(s.without_rules.all).toMatchObject({
      documents: 4,
      not_read: 1,
      wrong_ready: 0,
    });
    expect(s.without_rules.by_kind.passport).toEqual({ documents: 1, kind_right: 1, no_typing: 1 });
    expect(s.without_rules.by_kind.medical_record).toEqual({
      documents: 1,
      kind_right: 0,
      no_typing: 0,
    });
    expect(s.with_rules.by_kind.medical_record).toEqual(s.without_rules.by_kind.medical_record);
    expect(s.with_rules.all.needs_typing).toBe(s.without_rules.all.needs_typing - 1);
    // Her own Only me is counted, never by its kind.
    expect(s.without_rules.by_kind[ONLY_ME_KIND]).toEqual({
      documents: 1,
      kind_right: 0,
      no_typing: 0,
    });
    expect(s.with_rules.by_kind[ONLY_ME_KIND]).toEqual({
      documents: 1,
      kind_right: 1,
      no_typing: 1,
    });
    expect(Object.keys(s.without_rules.by_kind)).not.toContain('(none)');
    expect(row?.server_version).toBe('0.9.0-dev.1');
    // Every read's tools niced, one thread (R-3).
    expect(niced.length).toBeGreaterThan(0);
    expect(niced.every(Boolean)).toBe(true);
    expect(row?.rules_hash).toMatch(/^[0-9a-f]{12}$/);
    // The misses: sealed under Olivia's key alone, the honest reading's, which field.
    const sealed = await sealedRow(id);
    expect(sealed?.member_id).toBe(m.Olivia);
    expect(sealed?.work_sealed).toBeNull();
    const plain = sealed?.misses_sealed?.toString('latin1') ?? '';
    expect(plain).not.toContain(doc.dentist);
    const misses = await missesOf(id, 'Olivia');
    expect(misses.find((x) => x.document_id === doc.dentist)?.fields).toEqual(['kind', 'person']);
    expect(misses.map((x) => x.document_id)).not.toContain(doc.passport);
    const omar = await memberKey('Omar');
    expect(() =>
      openBytes(omar.key, sealed?.misses_sealed as Buffer, readingMissesBinding(id)),
    ).toThrow();
    // Kept seven days.
    const days = ((sealed?.expires_at.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7.01);
  }, 120_000);

  it('never writes a document, an item, a proposal or a rule', async () => {
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const t of [
        'document',
        'document_version',
        'document_text',
        'document_text_sealed',
        'incoming_file',
        'intake_batch',
        'intake_rule',
        'intake_outcome',
        'reminder',
        'review_filing',
      ]) {
        out[t] = (
          await admin.query(`select * from ${t} where household_id = $1 order by 1::text`, [hh])
        ).rows;
      }
      out.audit = (
        await admin.query('select count(*)::int as n from audit_event where household_id = $1', [
          hh,
        ])
      ).rows;
      return JSON.stringify(out);
    };
    const before = await snapshot();
    await runAll(await ask('Olivia'));
    expect(await snapshot()).toBe(before);
  }, 120_000);

  it('another owner is read for as themselves: their own Only me, never Olivia’s', async () => {
    const id = await ask('Omar');
    await runAll(id);
    expect(extracted).not.toContain(doc.olivias);
    expect(extracted).not.toContain(doc.saras);
    expect((await checkRow(id))?.summary?.chosen).toBe(3);
  }, 120_000);

  it('the summary must be numbers only: the database refuses anything else', async () => {
    const id = await ask('Olivia');
    await runAll(id);
    for (const bad of [
      { chosen: 'Sara' },
      { chosen: 1, note: [1] },
      { 'Sara’s passport': 1 },
      { chosen: 1.5 },
      { chosen: -1 },
      { chosen: null },
    ]) {
      await expect(
        admin.query('update reading_check set summary = $2 where id = $1', [
          id,
          JSON.stringify(bad),
        ]),
      ).rejects.toThrow(/reading_check_numbers_only/);
    }
  }, 120_000);

  it('goes behind the household’s own batch items: none read while one waits to be read', async () => {
    const batch = (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, ends_at)
         values ($1, $2, $3, now() + interval '30 days') returning id`,
        [hh, acct.Ahmed, m.Ahmed],
      )
    ).rows[0]?.id as string;
    const scope = await memberKey('Ahmed');
    const item = randomUUID();
    await admin.query(
      `insert into incoming_file (id, household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  scan_state, read_state, preview_state, preview_pages,
                                  received_at, submitted_at)
       values ($1, $2, $3, 'me', $4, 'received', 'scan.pdf', 'application/pdf', 10, $5, 38, $6, 'x',
               $7, $8, $9, 'member', 'unscanned', 'waiting', 'ready', 1, now(), now())`,
      [
        item,
        hh,
        batch,
        m.Ahmed,
        randomBytes(32),
        randomBytes(32),
        vault,
        randomBytes(40),
        scope.id,
      ],
    );
    try {
      const id = await ask('Olivia');
      const r = await workReadingCheck(deps, { household_id: hh, check_id: id }, opts());
      expect(r.next).toBeInstanceOf(Date);
      expect(extracted).toEqual([]);
      expect((await checkRow(id))?.state).toBe('running');
      // Read: the check goes on.
      await admin.query("update incoming_file set read_state = 'read' where id = $1", [item]);
      await runAll(id);
      expect((await checkRow(id))?.state).toBe('done');
    } finally {
      await admin.query('delete from intake_batch where id = $1', [batch]);
    }
  }, 120_000);

  it('one check a household at a time', async () => {
    await ask('Olivia');
    await expect(ask('Omar')).rejects.toThrow(/reading_check_one_running/);
  });

  it('cancelled mid-check, it stops before the next document and lets go of what it did', async () => {
    const id = await ask('Olivia');
    // Cancelled by an owner while the second document is being read.
    let work: string | null = null;
    hook = async (n) => {
      if (n !== 2) return;
      const k = await memberKey('Olivia');
      // What it has done so far: sealed under Olivia's key, and no word of the pages.
      work = openBytes(
        k.key,
        (await sealedRow(id))?.work_sealed as Buffer,
        readingWorkBinding(id),
      ).toString('utf8');
      await admin.query(
        "update reading_check set state = 'cancelled', finished_at = now() where id = $1",
        [id],
      );
    };
    expect(
      (await workReadingCheck(deps, { household_id: hh, check_id: id }, opts())).next,
    ).toBeNull();
    expect(extracted).toHaveLength(2);
    expect(work).toContain(doc.unreadable);
    expect(work).not.toContain('Thank you for your visit');
    expect((await checkRow(id))?.done).toBe(1);
    // Its job, come again: nothing more read, what it did let go.
    expect(
      (await workReadingCheck(deps, { household_id: hh, check_id: id }, opts())).next,
    ).toBeNull();
    expect(extracted).toHaveLength(2);
    expect(await sealedRow(id)).toBeUndefined();
    expect((await checkRow(id))?.summary).toBeNull();
  }, 120_000);

  it('a document removed or moved to the Trash mid-check is skipped', async () => {
    const gone = await filed({ words: DENTIST, by: 'Olivia', type_key: 'warranty' });
    const id = await ask('Olivia');
    // Chosen, then removed before it is read: it is the newest, so read first.
    await workReadingCheck(deps, { household_id: hh, check_id: id }, { ...opts(), runMs: 0 });
    await admin.query('update document set deleted_at = now() where id = $1', [gone]);
    await runAll(id);
    const s = (await checkRow(id))?.summary as ReadingCheckSummary;
    expect(s.chosen).toBe(5);
    expect(s.skipped).toBe(1);
    expect(s.read).toBe(4);
    expect(extracted).not.toContain(gone);
    await admin.query('delete from document where id = $1', [gone]);
  }, 120_000);

  it('a document made somebody else’s Only me mid-check is never read for the owner', async () => {
    const turned = await filed({ words: DENTIST, by: 'Olivia', type_key: 'warranty' });
    const id = await ask('Olivia');
    // Chosen while everybody's: the newest, so read first.
    await workReadingCheck(deps, { household_id: hh, check_id: id }, { ...opts(), runMs: 0 });
    await admin.query(
      "update document set visibility = 'private', owner_member_id = $2 where id = $1",
      [turned, m.Sara],
    );
    try {
      await runAll(id);
      const s = (await checkRow(id))?.summary as ReadingCheckSummary;
      expect(s.chosen).toBe(5);
      expect(s.skipped).toBe(1);
      expect(extracted).not.toContain(turned);
    } finally {
      await admin.query('delete from document where id = $1', [turned]);
    }
  }, 120_000);

  it('an owner no longer an owner: the check stops, with nothing kept', async () => {
    const id = await ask('Omar');
    await admin.query(
      "update account_household set role = 'adult' where account_id = $1 and household_id = $2",
      [acct.Omar, hh],
    );
    try {
      expect(
        (await workReadingCheck(deps, { household_id: hh, check_id: id }, opts())).next,
      ).toBeNull();
      expect(await checkRow(id)).toMatchObject({ state: 'failed', failure: 'stopped' });
      expect(await sealedRow(id)).toBeUndefined();
      expect(extracted).toEqual([]);
    } finally {
      await admin.query(
        "update account_household set role = 'owner' where account_id = $1 and household_id = $2",
        [acct.Omar, hh],
      );
    }
  }, 60_000);

  it('misses past their seven days are swept', async () => {
    const id = await ask('Olivia');
    await runAll(id);
    expect(await sealedRow(id)).toBeDefined();
    await admin.query(
      "update reading_check_sealed set expires_at = now() - interval '1 minute' where check_id = $1",
      [id],
    );
    await sweepReadingChecks(admin);
    expect(await sealedRow(id)).toBeUndefined();
    // The numbers stay.
    expect((await checkRow(id))?.summary).not.toBeNull();
  }, 120_000);

  it('nothing logged but counts: no document, no word, no value', async () => {
    logged.length = 0;
    await runAll(await ask('Olivia'));
    const all = logged.join('\n');
    expect(all).toMatch(/a reading check finished/);
    for (const id of Object.values(doc)) expect(all).not.toContain(id);
    expect(all).not.toContain('Northgate');
    expect(all).not.toContain(SECRET_WORDS);
  }, 120_000);

  const olivia = (): Reader => ({
    accountId: acct.Olivia as string,
    memberId: m.Olivia as string,
    role: 'owner',
  });
  const job = (id: string) => ({ household_id: hh, check_id: id });
  const lineFor = (docId: string, fields: string[]) =>
    withSystem(db, hh, (trx) =>
      appendAudit(trx, {
        householdId: hh,
        actorAccountId: acct.Olivia,
        action: 'document.updated',
        objectType: 'document',
        objectId: docId,
        detail: { fields },
      }),
    );

  it('a check’s job is keyed by the check: one started after another was cancelled is never dropped (R-1)', async () => {
    // pg-boss's stately queue, as far as keys go: one waiting a key.
    const queued = new Map<string, { check_id: string }>();
    const priorities: number[] = [];
    const boss = {
      send: async (_name: string, data: object, o: { singletonKey: string; priority: number }) => {
        priorities.push(o.priority);
        if (queued.has(o.singletonKey)) return null;
        queued.set(o.singletonKey, data as { check_id: string });
        return 'queued';
      },
    };
    const a = await ask('Olivia');
    // A waits behind other work: its later run queued...
    await sendReadingCheck(boss, job(a), new Date(Date.now() + 30_000));
    // ...and is cancelled; B started.
    await admin.query(
      "update reading_check set state = 'cancelled', finished_at = now() where id = $1",
      [a],
    );
    const b = await ask('Omar');
    await sendReadingCheck(boss, job(b));
    // B yields too: its later run queued, never dropped behind A's.
    await sendReadingCheck(boss, job(b), new Date(Date.now() + 30_000));
    expect([...queued.values()].filter((d) => d.check_id === b)).toHaveLength(2);
    // At the lowest priority, every one.
    expect(priorities.every((p) => p === READING_CHECK_PRIORITY && p < 0)).toBe(true);
  });

  it('one run of a check at a time: a second, while the first holds it, reads nothing', async () => {
    const id = await ask('Olivia');
    let second: ReadingRunAnswer | undefined;
    hook = async (n) => {
      if (n === 1) second = await workReadingCheck(deps, job(id), opts());
    };
    await runAll(id);
    expect(second).toEqual({ next: null });
    expect(new Set(extracted).size).toBe(extracted.length);
    expect((await checkRow(id))?.state).toBe('done');
  }, 120_000);

  it('changed by hand since it was filed: a scored detail, after the filing’s line, alone (A-1, A-3)', async () => {
    // A title, tags and where the paper is: no detail the reader is scored on.
    const titled = await filed({
      words: DENTIST,
      by: 'Olivia',
      type_key: 'warranty',
      owner: 'Olivia',
    });
    await lineFor(titled, ['title', 'tags', 'physical_location']);
    // An accept's own change (a version's), its line before the filing's.
    const own = await filed({
      words: DENTIST,
      by: 'Olivia',
      type_key: 'warranty',
      owner: 'Olivia',
      beforeFiling: (docId) => lineFor(docId, ['expires']).then(() => undefined),
    });
    // The expiry changed by hand, after: newest of all.
    const changed = await filed({
      words: DENTIST,
      by: 'Olivia',
      type_key: 'warranty',
      owner: 'Olivia',
    });
    await lineFor(changed, ['expires']);
    try {
      const all = await withSystem(db, hh, (trx) => chooseDocuments(trx, olivia(), 50, true));
      const of = (docId: string) => all.find((c) => c.id === docId);
      expect(of(titled)?.edited).toBe(false);
      expect(of(own)?.edited).toBe(false);
      expect(of(changed)?.edited).toBe(true);
      const unchanged = await withSystem(db, hh, (trx) =>
        chooseDocuments(trx, olivia(), 50, false),
      );
      expect(unchanged.map((c) => c.id)).toEqual(expect.arrayContaining([titled, own]));
      expect(unchanged.map((c) => c.id)).not.toContain(changed);
      // Left out before the last N are taken (A-3): the newest is the changed one.
      const one = await withSystem(db, hh, (trx) => chooseDocuments(trx, olivia(), 1, false));
      expect(one.map((c) => c.id)).toEqual([own]);
    } finally {
      await admin.query('delete from document where id = any($1)', [[titled, own, changed]]);
    }
  }, 60_000);

  it('only what a person confirmed is scored: an Inbox file’s whose-it-is unset is no miss; nothing scored, not read (A-2)', async () => {
    const inbox = await filed({
      words: DENTIST,
      by: 'Olivia',
      type_key: 'medical_record',
      owner: 'Zain',
      confirmed: ['kind'],
      source: 'inbox',
    });
    const nothing = await filed({
      words: DENTIST,
      by: 'Olivia',
      type_key: 'medical_record',
      owner: 'Zain',
      confirmed: ['issuer'],
      source: 'inbox',
    });
    try {
      const id = await ask('Olivia');
      await runAll(id);
      expect(extracted).toContain(inbox);
      expect(extracted).not.toContain(nothing);
      const s = (await checkRow(id))?.summary as ReadingCheckSummary;
      expect(s.partly_confirmed).toBe(1);
      const misses = await missesOf(id, 'Olivia');
      // Its kind is a miss; whose it is, unconfirmed, is not.
      expect(misses.find((x) => x.document_id === inbox)?.fields).toEqual(['kind']);
    } finally {
      await admin.query('delete from document where id = any($1)', [[inbox, nothing]]);
    }
  }, 120_000);

  it('behind anything waiting to be read or drawn, in any household: a version to process, pages to draw (R-3)', async () => {
    const boss = createQueue({ connectionString: tdb.adminUrl, migrate: true });
    boss.on('error', () => undefined);
    await boss.start();
    try {
      await admin.query('grant usage on schema pgboss to fdv_app').catch(() => undefined);
      await admin
        .query('grant select on all tables in schema pgboss to fdv_app')
        .catch(() => undefined);
      expect(await otherWorkWaiting(deps, hh)).toBe(false);
      await boss.createQueue('version.process');
      await boss.send('version.process', { household_id: randomUUID(), version_id: randomUUID() });
      expect(await otherWorkWaiting(deps, hh)).toBe(true);
      const id = await ask('Olivia');
      const r = await workReadingCheck(deps, job(id), opts());
      expect(r.next).toBeInstanceOf(Date);
      expect(extracted).toEqual([]);
      await admin.query("delete from pgboss.job where name = 'version.process'");
      expect(await otherWorkWaiting(deps, hh)).toBe(false);
    } finally {
      await boss.stop({ graceful: false });
    }
  }, 120_000);

  it('its tools run niced, one thread (R-3)', async () => {
    expect(lowPriorityCommand('tesseract', ['a'], undefined, 'linux')).toEqual({
      bin: 'tesseract',
      args: ['a'],
      env: undefined,
    });
    await atLowPriority(async () => {
      expect(lowPriorityCommand('tesseract', ['a'], { X: '1' }, 'linux')).toEqual({
        bin: 'nice',
        args: ['-n', '19', 'tesseract', 'a'],
        env: { X: '1', OMP_THREAD_LIMIT: '1' },
      });
      expect(lowPriorityCommand('tesseract', ['a'], undefined, 'win32')).toEqual({
        bin: 'tesseract',
        args: ['a'],
        env: { OMP_THREAD_LIMIT: '1' },
      });
      const { stdout } = await runTool(process.execPath, [
        '-e',
        'console.log(process.env.OMP_THREAD_LIMIT + " " + require("os").getPriority())',
      ]);
      const [threads, priority] = stdout.trim().split(' ');
      expect(threads).toBe('1');
      if (process.platform !== 'win32') expect(Number(priority)).toBe(19);
    });
  });

  it('cancelled while a document is read: the read is let go at once, its tools killed (R-3)', async () => {
    const id = await ask('Olivia');
    let aborted = false;
    hook = async (n, signal) => {
      if (n !== 1) return;
      await admin.query(
        "update reading_check set state = 'cancelled', finished_at = now() where id = $1",
        [id],
      );
      // A long OCR, killed when the read is let go.
      await new Promise<void>((done) => {
        const t = setTimeout(done, 20_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          done();
        });
      });
      aborted = signal?.aborted ?? false;
    };
    const began = Date.now();
    const r = await workReadingCheck(deps, job(id), { ...opts(), cancelPollMs: 100 });
    expect(r.next).toBeNull();
    expect(aborted).toBe(true);
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(extracted).toHaveLength(1);
    expect((await checkRow(id))?.done).toBe(0);
  }, 60_000);

  it('trouble counted: a document in trouble three times is skipped; too much, and the check stops (R-2)', async () => {
    const away: ItemProposer = { propose: async () => ({ state: 'unavailable' }) };
    const id = await ask('Olivia');
    await runAll(id, { proposer: away });
    const row = (
      await admin.query<{ state: string; errors: number; summary: ReadingCheckSummary }>(
        'select state, errors, summary from reading_check where id = $1',
        [id],
      )
    ).rows[0];
    // Three documents reach the thread, three times each, and are skipped.
    expect(row).toMatchObject({ state: 'done', errors: 9 });
    expect(row?.summary.skipped).toBe(3);
    // A check that has had nine: one more, and it stops.
    const again = await ask('Olivia');
    await admin.query('update reading_check set errors = 9 where id = $1', [again]);
    await runAll(again, { proposer: away });
    expect(await checkRow(again)).toMatchObject({ state: 'failed', failure: 'stopped' });
    expect(await sealedRow(again)).toBeUndefined();
  }, 120_000);

  it('an owner locked or paused: the check stops, with nothing kept (P-3)', async () => {
    const id = await ask('Omar');
    await admin.query(
      "update account_household set suspended_at = now(), suspend_reason = 'locked' where account_id = $1 and household_id = $2",
      [acct.Omar, hh],
    );
    try {
      expect((await workReadingCheck(deps, job(id), opts())).next).toBeNull();
      expect(await checkRow(id)).toMatchObject({ state: 'failed', failure: 'stopped' });
      expect(extracted).toEqual([]);
    } finally {
      await admin.query(
        'update account_household set suspended_at = null, suspend_reason = null where account_id = $1 and household_id = $2',
        [acct.Omar, hh],
      );
    }
  }, 60_000);

  it('what it has done so far is kept another seven days as it is saved (R-5)', async () => {
    const id = await ask('Olivia');
    // Started, nothing read yet.
    await workReadingCheck(deps, job(id), { ...opts(), runMs: 0 });
    await admin.query(
      "update reading_check_sealed set expires_at = now() + interval '1 day' where check_id = $1",
      [id],
    );
    // One document read and saved, then a batch item to read: it yields.
    const batch = (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, ends_at)
         values ($1, $2, $3, now() + interval '30 days') returning id`,
        [hh, acct.Ahmed, m.Ahmed],
      )
    ).rows[0]?.id as string;
    const scope = await memberKey('Ahmed');
    hook = async (n) => {
      if (n !== 1) return;
      await admin.query(
        `insert into incoming_file (household_id, batch_id, review_by, requester_member_id, state,
                                    original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                    storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                    scan_state, read_state, preview_state, preview_pages,
                                    received_at, submitted_at)
         values ($1, $2, 'me', $3, 'received', 'scan.pdf', 'application/pdf', 10, $4, 38, $5, 'x',
                 $6, $7, $8, 'member', 'unscanned', 'waiting', 'ready', 1, now(), now())`,
        [hh, batch, m.Ahmed, randomBytes(32), randomBytes(32), vault, randomBytes(40), scope.id],
      );
    };
    try {
      const r = await workReadingCheck(deps, job(id), opts());
      expect(r.next).toBeInstanceOf(Date);
      expect((await checkRow(id))?.done).toBe(1);
      const days = (((await sealedRow(id))?.expires_at.getTime() ?? 0) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
    } finally {
      await admin.query('delete from intake_batch where id = $1', [batch]);
    }
  }, 120_000);

  it('the folders a stopped worker read into are removed as the worker starts (P-5)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-sweep-'));
    try {
      await mkdtemp(path.join(dir, 'fdv-check-'));
      await mkdtemp(path.join(dir, 'fdv-check-'));
      await mkdtemp(path.join(dir, 'fdv-other-'));
      expect(await sweepReadingTemp(dir)).toBe(2);
      const left = await readdir(dir);
      expect(left.map((n) => n.slice(0, 10))).toEqual(['fdv-other-']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a check whose owner is gone or no longer an owner is pruned each night (M-2)', async () => {
    const id = await ask('Omar');
    await admin.query(
      "update account_household set role = 'adult' where account_id = $1 and household_id = $2",
      [acct.Omar, hh],
    );
    try {
      await sweepReadingChecks(admin);
      expect(await checkRow(id)).toBeUndefined();
      // An owner's own stays.
      const mine = await ask('Olivia');
      await sweepReadingChecks(admin);
      expect(await checkRow(mine)).toBeDefined();
    } finally {
      await admin.query(
        "update account_household set role = 'owner' where account_id = $1 and household_id = $2",
        [acct.Omar, hh],
      );
    }
  });

  it('the CLI prints numbers only, as the vault itself, without any Only me document or learned rule', async () => {
    // A letter Olivia filed for everybody, which her rules would read: not here.
    const hers = await filed({
      words: DENTIST,
      by: 'Olivia',
      type_key: 'medical_record',
      owner: 'Olivia',
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await readingCheckCommand(
      ['--household', hh, '--n', '10'],
      (household, n) => readingCheckNow(deps, household, n, opts()),
      { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    );
    expect(code).toBe(0);
    // Said beside the numbers: what is left out.
    expect(err).toEqual([
      'Only me documents are not included, and no learned rules are used: the general reader alone.',
    ]);
    // As the vault: every document filed through review out of the Trash
    // but the Only me ones, anybody's.
    expect(extracted).not.toContain(doc.saras);
    expect(extracted).not.toContain(doc.olivias);
    const printed = out.join('\n');
    const parsed = JSON.parse(printed) as ReadingCheckSummary;
    expect(numbersOnly(parsed)).toBe(true);
    await admin.query('delete from document where id = $1', [hers]);
    expect(extracted).toContain(hers);
    expect(parsed.chosen).toBe(4);
    expect(parsed.without_rules.by_kind[ONLY_ME_KIND]).toBeUndefined();
    // The general reader alone: no learned rules, anybody's.
    expect(parsed.with_rules).toEqual(parsed.without_rules);
    for (const id of Object.values(doc)) expect(printed).not.toContain(id);
    expect(printed).not.toContain(SECRET_WORDS);
    expect(printed).not.toContain(SECRET_NUMBER);
    expect(printed).not.toContain('Sara');
    // Wrong words: refused, nothing printed.
    const bad: string[] = [];
    expect(
      await readingCheckCommand(['--household', 'nope'], async () => parsed, {
        stdout: (l) => bad.push(l),
        stderr: () => undefined,
      }),
    ).toBe(2);
    // A summary that is not numbers only is never printed.
    expect(
      await readingCheckCommand(
        ['--household', hh],
        async () => ({ ...parsed, chosen: SECRET_WORDS }) as unknown as ReadingCheckSummary,
        { stdout: (l) => bad.push(l), stderr: () => undefined },
      ),
    ).toBe(1);
    // A failure is said in words of its own, never the error's.
    const said: string[] = [];
    expect(
      await readingCheckCommand(
        ['--household', hh],
        async () => {
          throw new Error(`could not read ${SECRET_NUMBER}`);
        },
        { stdout: (l) => bad.push(l), stderr: (l) => said.push(l) },
      ),
    ).toBe(1);
    expect(said.join('\n')).not.toContain(SECRET_NUMBER);
    expect(bad).toEqual([]);
  }, 120_000);
});
