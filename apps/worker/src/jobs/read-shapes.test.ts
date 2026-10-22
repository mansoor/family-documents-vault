import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  EncryptStream,
  EnvKeyProvider,
  intakeShapeBinding,
  itemProposalsBinding,
  newKey,
  openBytes,
  ScopeKeys,
  sealBytes,
  shapeNumberHash,
  shapeNumberKey,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import {
  shapeSealed,
  SHAPE_CONFIDENCE,
  SHAPE_SURE_CONFIDENCE,
  SHAPE_WORDS,
  storedLearnedClash,
  storedPaper,
  storedProposal,
  type ShapeLesson,
} from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { extractText } from './extract-text.js';
import type { IncomingDeps } from './incoming.js';
import { ProposalThread, type ItemProposer } from './proposal-thread.js';
import { learnedContext, proposalContext, readNextBatchItem } from './read-item.js';
import { detectTools } from './tools.js';

/**
 * The vault learns each sender's papers (0.9.0, R1), in the worker: an item
 * is read with its uploader's own shapes — read as them, opened under their
 * own key, so nobody else's is ever used — and the page's shape and its
 * labelled dates and numbers are sealed beside its proposal, for its accept
 * to learn from. Never a name, a number or an address in what is sealed for
 * the shape: those stay in the proposal, as they always have.
 */

const MASTER = 'read-shapes-test-master-key-with-32-bytes-or-more';
const tools = await detectTools();
const says =
  (text: string): typeof extractText =>
  async () => ({ text, source: 'pdf', textPages: 1, ocrPages: 0 });

/** A water bill whose due date is its "Payment date", for somebody at 14 Elm Street. */
const BILL = [
  'NORTHGATE WATER',
  'Your water bill',
  '',
  'Account number        NW 4417 3391          Bill date        3 June 2026',
  'Customer              The occupier',
  '                      14 Elm Street',
  '                      Ashby Vale',
  '                      AV4 7QT',
  '',
  'Standing charge                     £12.40',
  'Water supply                        £30.11',
  'Total to pay                        £42.51',
  '',
  'Payment date          20 June 2026',
  'We will collect this by Direct Debit from your account.',
].join('\n');

describe.skipIf(!testAdminUrl())('an item read with its uploader’s own shapes (R1)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  let deps: IncomingDeps;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  let vault: string;
  const m: Record<string, string> = {};
  const acct: Record<string, string> = {};
  let thread: ProposalThread;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-shapes-'));
    hh = randomUUID();
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'The Khan family', 'Europe/London')",
      [hh],
    );
    await admin.query("insert into household_profile (household_id, country) values ($1, 'GB')", [
      hh,
    ]);
    for (const [name, role] of [
      ['Olivia', 'owner'],
      ['Sara', 'adult'],
      ['Ahmed', 'adult'],
      ['Zain', 'teen'],
    ] as const) {
      m[name] = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, name],
        )
      ).rows[0]?.id as string;
      acct[name] = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          `${name.toLowerCase()}-${stamp}@shapes.test`,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [acct[name], hh, m[name], role],
      );
    }
    vault = await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const who of ['Olivia', 'Sara', 'Ahmed', 'Zain']) {
        await keys.mintMemberKey(trx, hh, m[who] as string, null);
      }
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
    // Northgate, on a bill everybody sees: one of the household's issuers.
    await admin.query(
      "insert into document (household_id, title, issued_by, type_key, visibility) values ($1, 'Water', 'Northgate Water', 'utility_bill', 'household')",
      [hh],
    );
    deps = {
      admin,
      db,
      keys,
      credentialsKey: Buffer.alloc(32),
      localRoot: root,
      log: () => undefined,
    };
    thread = new ProposalThread();
  }, 60_000);

  afterAll(async () => {
    await thread?.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await rm(root, { recursive: true, force: true });
  });

  const item = async (who: string) => {
    const batchId = (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, ends_at)
         values ($1, $2, $3, now() + interval '30 days') returning id`,
        [hh, acct[who], m[who]],
      )
    ).rows[0]?.id as string;
    const id = randomUUID();
    const key = `${hh}/batches/${batchId}/${randomBytes(8).toString('hex')}.enc`;
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: m[who] as string }),
    );
    const fileKey = newKey();
    const bytes = Buffer.from(`%PDF-1.4\n% ${id}\n%%EOF\n`);
    const enc = new EncryptStream(fileKey);
    await Promise.all([
      new LocalAdapter(root).put(key, enc),
      pipeline(Readable.from([bytes]), enc),
    ]);
    await admin.query(
      `insert into incoming_file (id, household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  scan_state, read_state, preview_state, preview_pages,
                                  received_at, submitted_at)
       values ($1, $2, $3, 'me', $4, 'received', 'scan.pdf', 'application/pdf', $5, $6, 38, $7, $8,
               $9, $10, $11, 'member', 'unscanned', 'waiting', 'ready', 1, now(), now())`,
      [
        id,
        hh,
        batchId,
        m[who],
        bytes.length,
        randomBytes(32),
        randomBytes(32),
        key,
        vault,
        wrapKey(fileKey, scope.key, `incoming:${id}`),
        scope.id,
      ],
    );
    return { id, fileKey };
  };

  const readFor = async (who: string, text: string, proposer: ItemProposer = thread) => {
    await admin.query(
      "update incoming_file set read_state = 'failed', read_failure = 'unreadable' where household_id = $1 and state = 'received' and read_state in ('waiting', 'reading')",
      [hh],
    );
    const i = await item(who);
    const r = await readNextBatchItem(deps, hh, {
      maxPages: 5,
      proposer,
      tools,
      extract: says(text),
    });
    expect(r.read).toBe(i.id);
    const row = await admin.query<{ proposals_sealed: Buffer }>(
      'select proposals_sealed from incoming_file where id = $1',
      [i.id],
    );
    const raw: unknown = JSON.parse(
      openBytes(
        i.fileKey,
        row.rows[0]?.proposals_sealed as Buffer,
        itemProposalsBinding(i.id),
      ).toString('utf8'),
    );
    return {
      proposal: storedProposal(raw),
      clash: storedLearnedClash(raw),
      paper: storedPaper(raw),
      raw,
    };
  };

  /** A shape of `whose`, sealed as the API seals one — under `under`'s key, bound to `bound`'s row. */
  const plant = async (
    whose: string,
    lessons: ShapeLesson[],
    o: {
      under?: string;
      bound?: string;
      words?: string[];
      account?: string;
      /** Each person's account, filed for them on three papers. */
      accounts?: Record<string, string>;
    } = {},
  ) => {
    const id = randomUUID();
    const words = o.words ?? (await readFor(whose, BILL)).paper?.words ?? [];
    const key = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, {
        householdId: hh,
        kind: 'member',
        memberId: m[o.under ?? whose] as string,
      }),
    );
    // A person's lesson keeps the hashes of the accounts it was taught with (W1),
    // under the key the vault derives from the member key.
    const hashed = (plain: string) => shapeNumberHash(shapeNumberKey(key.key), plain);
    const numbered = o.accounts
      ? lessons.map((l) => {
          const account = l.field === 'owner_member_id' ? o.accounts?.[l.value] : undefined;
          return account ? { ...l, numbers: [1, 2, 3].map(() => hashed(account)) } : l;
        })
      : o.account
        ? lessons.map((l) =>
            l.field === 'owner_member_id' ? { ...l, numbers: [hashed(o.account as string)] } : l,
          )
        : lessons;
    await admin.query(
      'insert into intake_shape (id, household_id, member_id, shape_sealed) values ($1, $2, $3, $4)',
      [
        id,
        hh,
        m[whose],
        sealBytes(
          key.key,
          Buffer.from(
            JSON.stringify(shapeSealed({ issuer: 'northgate water', words, lessons: numbered })),
            'utf8',
          ),
          intakeShapeBinding(hh, m[o.bound ?? whose] as string, id),
        ),
      ],
    );
    return { id, words };
  };
  const forget = () => admin.query('delete from intake_shape where household_id = $1', [hh]);
  const lessons = (person: string, confirmed: number): ShapeLesson[] => [
    {
      field: 'type_key',
      value: 'utility_bill',
      band: null,
      confirmed,
      contradicted: 0,
      vouched: 1,
    },
    { field: 'owner_member_id', value: person, band: null, confirmed, contradicted: 0, vouched: 1 },
    { field: 'expires', value: 'payment date', band: 4, confirmed, contradicted: 0, vouched: 1 },
    {
      field: 'identifier',
      value: 'account number',
      band: 0,
      confirmed,
      contradicted: 0,
      vouched: 1,
    },
  ];

  it('the thread hashes a number as the vault does: a learned person is sure only on the account taught (W1)', async () => {
    await forget();
    await plant('Sara', lessons(m.Sara as string, 5), { account: 'NW44173391' });
    const own = await readFor('Sara', BILL);
    expect(own.proposal.owner_member_id).toMatchObject({
      value: m.Sara,
      cue: 'learned',
      confidence: SHAPE_SURE_CONFIDENCE,
    });
    const other = await readFor('Sara', BILL.replace('NW 4417 3391', 'NW 9999 0001'));
    expect(other.proposal.owner_member_id).toMatchObject({
      value: m.Sara,
      confidence: SHAPE_CONFIDENCE,
    });
  }, 60_000);

  it('a shape the family’s accounts taught proposes, sure, whose account the page is — the uploader’s own shapes alone', async () => {
    await forget();
    // Olivia files Sara's statements and Ahmed's, each on their own account.
    const both = [
      ...lessons(m.Sara as string, 3).filter((l) => l.field !== 'owner_member_id'),
      {
        field: 'owner_member_id' as const,
        value: m.Sara as string,
        band: null,
        confirmed: 3,
        contradicted: 0,
        vouched: 1,
      },
      {
        field: 'owner_member_id' as const,
        value: m.Ahmed as string,
        band: null,
        confirmed: 3,
        contradicted: 0,
        vouched: 1,
      },
    ];
    await plant('Olivia', both, {
      accounts: { [m.Sara as string]: 'NW44173391', [m.Ahmed as string]: 'NW55201180' },
    });
    const ahmeds = BILL.replace('NW 4417 3391', 'NW 5520 1180');
    expect((await readFor('Olivia', ahmeds)).proposal.owner_member_id).toMatchObject({
      value: m.Ahmed,
      cue: 'learned',
      confidence: SHAPE_SURE_CONFIDENCE,
    });
    expect((await readFor('Olivia', BILL)).proposal.owner_member_id).toMatchObject({
      value: m.Sara,
      confidence: SHAPE_SURE_CONFIDENCE,
    });
    // Sara's own upload of Ahmed's statement: Olivia's shapes are not hers.
    expect((await readFor('Sara', ahmeds)).proposal.owner_member_id?.cue).not.toBe('learned');
  }, 60_000);

  it('the proposal thread is given no account’s hash and no key to make one; the worker settles whose it is (the R1 re-check, N5)', async () => {
    await forget();
    await plant('Sara', lessons(m.Sara as string, 5), { account: 'NW44173391' });
    const seen: unknown[] = [];
    const spy: ItemProposer = {
      propose: (text, ctx, learned) => {
        seen.push(learned);
        return thread.propose(text, ctx, learned);
      },
    };
    const got = await readFor('Sara', BILL, spy);
    expect(seen).toHaveLength(1);
    const said = JSON.stringify(seen[0]);
    expect(said).toContain('"lessons"');
    expect(said).not.toContain('numberKey');
    expect(said).not.toContain('"numbers"');
    // And yet sure on her own account, settled where the hashes are.
    expect(got.proposal.owner_member_id).toMatchObject({
      value: m.Sara,
      cue: 'learned',
      confidence: SHAPE_SURE_CONFIDENCE,
    });
  }, 60_000);

  it('seals the page’s shape beside its proposal: the list’s words and labels, and never a name, a number or the address', async () => {
    await forget();
    const got = await readFor('Ahmed', BILL);
    expect(got.paper?.words).toEqual(
      expect.arrayContaining(['account', 'date', 'number', 'payment', 'water']),
    );
    const said = JSON.stringify({
      words: got.paper?.words,
      labels: got.paper?.dates.map((d) => d.label),
    });
    for (const secret of ['elm', 'ashby', 'vale', 'av4', '4417', '42.51', 'ahmed']) {
      expect(said.toLowerCase(), secret).not.toContain(secret);
    }
    expect(got.paper?.words.every((w) => SHAPE_WORDS.has(w))).toBe(true);
    expect(got.paper?.dates).toEqual(
      expect.arrayContaining([
        { label: 'payment date', band: 4, value: { date: '2026-06-20', precision: 'day' } },
      ]),
    );
    // With nothing learned, the pages' proposal alone: no expiry they can read.
    expect(got.proposal.type_key).toMatchObject({ value: 'utility_bill' });
    expect(got.proposal.expires).toBeUndefined();
  }, 60_000);

  it('a guest’s name is no part of the sealed shape, and the thread is never told of a guest (the R1 review, P2)', async () => {
    await forget();
    // A guest whose name is two of the bill's words.
    const guest = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name, kind) values ($1, 'Payment Water', 'guest') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    try {
      const got = await readFor('Ahmed', BILL);
      expect(got.paper?.words).toEqual(expect.arrayContaining(['account', 'number']));
      expect(got.paper?.words).not.toContain('payment');
      expect(got.paper?.words).not.toContain('water');
      expect(got.paper?.dates.map((d) => d.label)).not.toContain('payment date');
      const ctx = await withSystem(db, hh, (trx) => proposalContext(trx, hh, m.Ahmed as string));
      expect(JSON.stringify(ctx)).not.toContain('Payment Water');
    } finally {
      await admin.query('delete from member where id = $1', [guest]);
    }
  }, 60_000);

  it('a sure shape of the uploader’s own reads the date at its label; another’s is never used', async () => {
    await forget();
    await plant('Sara', lessons(m.Sara as string, 5));
    // Ahmed's bill from the same sender: nothing of Sara's.
    const ahmed = await readFor('Ahmed', BILL);
    expect(ahmed.proposal.expires).toBeUndefined();
    expect(JSON.stringify(ahmed.proposal)).not.toContain(m.Sara as string);
    // Sara's own: sure, at the label, said as learned from her papers.
    const sara = await readFor('Sara', BILL);
    expect(sara.proposal).toMatchObject({
      expires: {
        value: { date: '2026-06-20' },
        cue: 'learned',
        shape: true,
        confidence: SHAPE_SURE_CONFIDENCE,
      },
      owner_member_id: { value: m.Sara, cue: 'learned', shape: true },
    });
    // Two confirmations: unsure.
    await forget();
    await plant('Sara', lessons(m.Sara as string, 2));
    expect((await readFor('Sara', BILL)).proposal.expires).toMatchObject({
      confidence: SHAPE_CONFIDENCE,
    });
  }, 60_000);

  it('the worker reads shapes as the uploader, and opens only those sealed for them', async () => {
    await forget();
    const own = await plant('Ahmed', lessons(m.Ahmed as string, 3));
    await plant('Sara', lessons(m.Sara as string, 9));
    // Planted in Ahmed's name but sealed under Sara's key, or bound to her
    // row: neither opens, so neither is used.
    await plant('Ahmed', lessons(m.Sara as string, 9), { under: 'Sara' });
    await plant('Ahmed', lessons(m.Sara as string, 9), { bound: 'Sara' });
    // And Sara's row, though it were sealed so as to open for Ahmed: the
    // database gives the worker, reading as him, none of hers.
    await plant('Sara', lessons(m.Sara as string, 7), { under: 'Ahmed', bound: 'Ahmed' });
    const got = await withSystem(db, hh, (trx) => learnedContext(trx, hh, m.Ahmed as string, keys));
    expect(got?.shapes).toEqual([
      { issuer: 'northgate water', words: own.words, lessons: lessons(m.Ahmed as string, 3) },
    ]);
    // Without the keys, the rules alone, as before 0.9.0.
    const before = await withSystem(db, hh, (trx) => learnedContext(trx, hh, m.Ahmed as string));
    expect(before && 'shapes' in before).toBe(false);
  }, 60_000);

  it('a teen’s shapes are their own, and never propose another person', async () => {
    await forget();
    await plant('Zain', lessons(m.Sara as string, 9));
    const zain = await readFor('Zain', BILL);
    expect(zain.proposal.expires).toMatchObject({ cue: 'learned', shape: true });
    expect(zain.proposal.owner_member_id).toBeUndefined();
    // And theirs reach nobody else.
    expect((await readFor('Olivia', BILL)).proposal.expires).toBeUndefined();
  }, 60_000);
});
