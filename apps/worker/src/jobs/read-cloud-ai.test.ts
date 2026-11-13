import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  EncryptStream,
  EnvKeyProvider,
  itemProposalsBinding,
  newKey,
  openBytes,
  ScopeKeys,
  wrapKey,
} from '@fdv/crypto';
import { aiReaderMonthCount, createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { storedLocalAi } from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocalAiAnswer } from '../ai-reader.js';
import type { OwnersAlert } from '../ai-send.js';
import type { extractText } from './extract-text.js';
import type { IncomingDeps } from './incoming.js';
import { ProposalThread } from './proposal-thread.js';
import { readNextBatchItem, type LocalAiReader } from './read-item.js';

/**
 * A batch's item read with a cloud reader (0.9.0, AIR3), in the worker,
 * against a reader of the test's own that keeps every word it is sent: what
 * the sending rule (`mayReadWith`) holds back — a sensitive paper, an Only
 * me one, a paper of a kind nobody can say — never reaches it, and the
 * proposal says "Read here only"; a kind's default changed is asked fresh
 * at the next read; the month's cap holds back paper N+1, and the owners
 * are emailed at 80%, once.
 */

const MASTER = 'read-cloud-ai-test-master-key-with-32-bytes-or-more';

const says =
  (text: string): typeof extractText =>
  async () => ({ text, source: 'pdf', textPages: 1, ocrPages: 0 });

const PASSPORT = [
  'HM Passport Office',
  'PASSPORT',
  'Surname: KHAN',
  'Given names: SARA',
  'Passport No. 533401872',
  'Date of issue 14 MAR 2021',
  'Date of expiry 14 MAR 2031',
].join('\n');

/** A bill: its kind is not sensitive unless the household says. */
const BILL = [
  'Northern Water',
  'Your water bill',
  'Account number 7734 2210',
  'Amount due £48.20',
  'Please pay by 14 March 2026',
].join('\n');

/** Words nobody can say the kind of. */
const MYSTERY = 'Reference QX-77 regarding the matter discussed, kindly see attached remarks';

describe.skipIf(!testAdminUrl())('an item read with a cloud reader, in the worker (AIR3)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  let deps: IncomingDeps;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  let vault: string;
  let member: string;
  let owner: string;
  let thread: ProposalThread;
  /** Every paper's words the cloud reader was sent. */
  const sent: string[] = [];
  const told: OwnersAlert[] = [];
  /** What happens as the reader's turn comes, before it asks the rule again: a test's way in. */
  let atTurn: (() => Promise<void>) | null = null;
  /** What the reader answers: a test may say. */
  let answer: () => LocalAiAnswer = () => ({ state: 'without', why: 'timeout', ms: 3 });
  /** The reader as AnthropicReader is to the gate: asks the rule again once its turn comes. */
  const IDENT = 'settings:anthropic:https://api.anthropic.com';
  const cloud: LocalAiReader = {
    kind: 'anthropic',
    runsAt: 'cloud',
    identity: IDENT,
    read: async (text, _offer, o) => {
      await atTurn?.();
      if (o.stillMay && !(await o.stillMay())) return { state: 'without', why: 'held', ms: 1 };
      sent.push(text);
      return answer();
    },
  };
  /** "Also send sensitive papers", on for the reader the test reads with (S3). */
  const switchOn = (forWhom = IDENT) =>
    admin.query(
      'update household set ai_send_sensitive = true, ai_send_sensitive_for = $2 where id = $1',
      [hh, forWhom],
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-read-cloud-'));
    hh = randomUUID();
    await admin.query(
      "insert into household (id, name, timezone, local_ai) values ($1, 'The Khan family', 'Europe/London', true)",
      [hh],
    );
    await admin.query("insert into household_profile (household_id, country) values ($1, 'GB')", [
      hh,
    ]);
    member = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Sara Khan') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    owner = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        `sara-${stamp}@cloud-ai.test`,
      ])
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [owner, hh, member],
    );
    vault = await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      await keys.mintMemberKey(trx, hh, member, null);
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

  beforeEach(() => {
    sent.length = 0;
    told.length = 0;
    atTurn = null;
    answer = () => ({ state: 'without', why: 'timeout', ms: 3 });
  });
  afterEach(async () => {
    await admin.query(
      "update incoming_file set read_state = 'failed', read_failure = 'unreadable' where household_id = $1 and state = 'received' and read_state in ('waiting', 'reading')",
      [hh],
    );
    await admin.query('delete from ai_reader_send where household_id = $1', [hh]);
    await admin.query('delete from ai_reader_cap_warning where household_id = $1', [hh]);
    await admin.query('delete from ai_reader where household_id = $1', [hh]);
    await admin.query('delete from document_type_setting where household_id = $1', [hh]);
    await admin.query(
      'update household set ai_send_sensitive = false, ai_send_sensitive_for = null where id = $1',
      [hh],
    );
  });

  /** An item in a batch of its own, with the batch's defaults said. */
  const item = async (
    d: { sensitive?: boolean | null; visibility?: string | null; typeKey?: string | null } = {},
  ) => {
    const batchId = (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, ends_at,
                                   default_sensitive, default_visibility, default_type_key)
         values ($1, $2, $3, now() + interval '30 days', $4, $5, $6) returning id`,
        [hh, owner, member, d.sensitive ?? null, d.visibility ?? null, d.typeKey ?? null],
      )
    ).rows[0]?.id as string;
    const id = randomUUID();
    const key = `${hh}/batches/${batchId}/${randomBytes(8).toString('hex')}.enc`;
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: member }),
    );
    const fileKey = newKey();
    const enc = new EncryptStream(fileKey);
    await Promise.all([
      new LocalAdapter(root).put(key, enc),
      pipeline(Readable.from([Buffer.from('%PDF-1.4 stand-in')]), enc),
    ]);
    await admin.query(
      `insert into incoming_file (id, household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  scan_state, read_state, preview_state, preview_pages,
                                  received_at, submitted_at)
       values ($1, $2, $3, 'me', $4, 'received', 'scan.pdf', 'application/pdf', 17, $5, 38, $6, $7, $8,
               $9, $10, 'member', 'unscanned', 'waiting', 'ready', 1, now(), now())`,
      [
        id,
        hh,
        batchId,
        member,
        randomBytes(32),
        randomBytes(32),
        key,
        vault,
        wrapKey(fileKey, scope.key, `incoming:${id}`),
        scope.id,
      ],
    );
    return { id, fileKey, batchId };
  };

  /** The owners' alerts as the queue would take them; a test may make the queue refuse. */
  let queueDown = false;
  const read = (text: string, o: { extract?: typeof extractText } = {}) =>
    readNextBatchItem(deps, hh, {
      maxPages: 5,
      proposer: thread,
      extract: o.extract ?? says(text),
      tools: { pdftotext: true, pdftoppm: true, tesseract: true } as never,
      localAi: cloud,
      tell: async (a, q) => {
        // Queued in the gate's own transaction (M3): a row read through it.
        await q.executeSql('select 1');
        if (queueDown) throw new Error('the queue would not take it');
        told.push(a);
      },
    });

  /** What was sealed of the AI beside the item's proposal. */
  const sealedAi = async (i: { id: string; fileKey: Buffer }) => {
    const row = (
      await admin.query<{ proposals_sealed: Buffer | null; read_state: string }>(
        'select proposals_sealed, read_state from incoming_file where id = $1',
        [i.id],
      )
    ).rows[0];
    expect(row?.read_state).toBe('read');
    return storedLocalAi(
      JSON.parse(
        openBytes(i.fileKey, row?.proposals_sealed as Buffer, itemProposalsBinding(i.id)).toString(
          'utf8',
        ),
      ) as unknown,
    );
  };

  /** This month's papers, as the cap counts them. */
  const counted = async () => (await withSystem(db, hh, (trx) => aiReaderMonthCount(trx))).sent;

  it('a batch that names no kind: its paper counts as sensitive — never the kind the rules guess (D1)', async () => {
    // The rules would read it as a passport; it is held as sensitive all the same.
    const i = await item();
    expect((await read(PASSPORT)).read).toBe(i.id);
    expect(sent).toEqual([]);
    expect(await sealedAi(i)).toEqual({ state: 'without', held: 'sensitive' });
    // A bill the rules can read, not sensitive by its kind: held too, its batch naming no kind.
    const bill = await item({ visibility: 'household', sensitive: false });
    await read(BILL);
    expect(sent).toEqual([]);
    expect(await sealedAi(bill)).toEqual({ state: 'without', held: 'sensitive' });
  });

  it('switch on, a batch naming neither kind nor visibility: held as Only me — nobody can say who may open it (D1)', async () => {
    await switchOn();
    const i = await item();
    await read(MYSTERY);
    expect(sent).toEqual([]);
    expect(await sealedAi(i)).toEqual({ state: 'without', held: 'only_me' });
    // Its visibility named, it goes: the switch lets the sensitive go.
    await item({ visibility: 'household' });
    await read(MYSTERY);
    expect(sent).toHaveLength(1);
  });

  it('a batch that names its kind: that kind’s default says — a bill goes, a passport does not; Only me never', async () => {
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Northern Water');
    sent.length = 0;
    const passport = await item({ typeKey: 'passport' });
    await read(PASSPORT);
    expect(sent).toEqual([]);
    expect(await sealedAi(passport)).toEqual({ state: 'without', held: 'sensitive' });
    // Said not sensitive by its batch: sent.
    await item({ typeKey: 'passport', sensitive: false });
    await read(PASSPORT);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('533401872');
    sent.length = 0;
    // Only me: never, the switch on or not.
    await switchOn();
    const mine = await item({ typeKey: 'utility_bill', sensitive: false, visibility: 'private' });
    await read(BILL);
    expect(sent).toEqual([]);
    expect(await sealedAi(mine)).toEqual({ state: 'without', held: 'only_me' });
  });

  it('"Also send sensitive papers" lets a passport go — for the reader it was turned on for alone (S3); a local reader is sent everything', async () => {
    // On for another reader (.env's, say, before this one): off for this one.
    await switchOn('env:ollama:ollama:11434');
    const other = await item({ typeKey: 'passport' });
    await read(PASSPORT);
    expect(sent).toEqual([]);
    expect(await sealedAi(other)).toEqual({ state: 'without', held: 'sensitive' });
    await switchOn();
    await item({ typeKey: 'passport' });
    await read(PASSPORT);
    expect(sent).toHaveLength(1);
    await admin.query(
      'update household set ai_send_sensitive = false, ai_send_sensitive_for = null where id = $1',
      [hh],
    );
    sent.length = 0;
    const local: LocalAiReader = { ...cloud, kind: 'ollama', runsAt: 'own_network' };
    await item();
    await readNextBatchItem(deps, hh, {
      maxPages: 5,
      proposer: thread,
      extract: says(PASSPORT),
      tools: { pdftotext: true, pdftoppm: true, tesseract: true } as never,
      localAi: local,
    });
    expect(sent).toHaveLength(1);
  });

  it('made Only me while its pages were read: not sent (S2)', async () => {
    const i = await item({ typeKey: 'utility_bill' });
    await read(BILL, {
      // Its pages take their time; meanwhile its batch is made Only me.
      extract: async () => {
        await admin.query("update intake_batch set default_visibility = 'private' where id = $1", [
          i.batchId,
        ]);
        return { text: BILL, source: 'pdf', textPages: 1, ocrPages: 0 };
      },
    });
    expect(sent).toEqual([]);
    expect(await sealedAi(i)).toEqual({ state: 'without', held: 'only_me' });
  });

  it('made sensitive while it waited for the reader’s turn: asked again right before it goes, and not sent (S2)', async () => {
    const i = await item({ typeKey: 'utility_bill' });
    atTurn = async () => {
      await admin.query('update intake_batch set default_sensitive = true where id = $1', [
        i.batchId,
      ]);
    };
    await read(BILL);
    expect(sent).toEqual([]);
    expect(await sealedAi(i)).toEqual({ state: 'without', held: 'sensitive' });
    // Written down as never sent: not counted against the month.
    expect(await counted()).toBe(0);
  });

  it('a kind’s default changed holds back the next read of every paper left as its kind says', async () => {
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(sent).toHaveLength(1);
    sent.length = 0;
    await admin.query(
      `insert into document_type_setting (household_id, type_key, sensitive_default)
       values ($1, 'utility_bill', true)`,
      [hh],
    );
    const after = await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(sent).toEqual([]);
    expect(await sealedAi(after)).toEqual({ state: 'without', held: 'sensitive' });
  });

  it('the month’s cap holds back paper N+1; the owners are emailed at 80%, once; last month’s are not counted', async () => {
    await admin.query(
      `insert into ai_reader (household_id, kind, base_url, model, runs_at, monthly_cap, status)
       values ($1, 'anthropic', null, 'claude-haiku-4-5', 'cloud', 4, 'ok')`,
      [hh],
    );
    // Two this month already; one well before this month began, and one never sent.
    await admin.query(
      `insert into ai_reader_send (household_id, kind, runs_at, purpose, sent_at, outcome)
       values ($1, 'anthropic', 'cloud', 'item', now() - interval '1 minute', 'read'),
              ($1, 'anthropic', 'cloud', 'item', now() - interval '1 minute', 'without'),
              ($1, 'anthropic', 'cloud', 'item', now() - interval '1 minute', 'not_sent'),
              ($1, 'anthropic', 'cloud', 'item', date_trunc('month', now()) - interval '40 days', 'read')`,
      [hh],
    );
    expect(await counted()).toBe(2);
    // The third: 3 of 4, under 80%; nobody told.
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(sent).toHaveLength(1);
    expect(told).toEqual([]);
    // The fourth: 4 of 4 reaches 80% — the owners told, once.
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(sent).toHaveLength(2);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ household_id: hh, account_ids: [owner], email_only: true });
    expect(told[0]?.subject).toMatch(/most of this month’s papers/);
    // And no word of a paper in it.
    expect(JSON.stringify(told[0])).not.toMatch(/Northern Water|7734/);
    // The fifth: past the cap, read without it, and nobody told again.
    const fifth = await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(sent).toHaveLength(2);
    expect(told).toHaveLength(1);
    expect(await sealedAi(fifth)).toEqual({ state: 'without', held: 'cap' });
    const month = await withSystem(db, hh, (trx) => aiReaderMonthCount(trx));
    expect(month).toMatchObject({ sent: 4, warned: true });
    // What was sent written down: the reader, the item, how long — never a word.
    const rows = await admin.query<{ purpose: string; ms: number | null; outcome: string }>(
      `select purpose, ms, outcome from ai_reader_send
        where household_id = $1 and incoming_file_id is not null and outcome <> 'not_sent'`,
      [hh],
    );
    expect(rows.rows).toHaveLength(2);
    expect(
      rows.rows.every((r) => r.purpose === 'item' && r.ms === 3 && r.outcome === 'without'),
    ).toBe(true);
  });

  it('the 80% email: sent after a cap lowered below the count; a queue that would not take it leaves the next paper to try (M3)', async () => {
    await admin.query(
      `insert into ai_reader (household_id, kind, base_url, model, runs_at, monthly_cap, status)
       values ($1, 'anthropic', null, 'claude-haiku-4-5', 'cloud', 2, 'ok')`,
      [hh],
    );
    await admin.query(
      `insert into ai_reader_send (household_id, kind, runs_at, purpose, sent_at, outcome)
       select $1, 'anthropic', 'cloud', 'item', now() - interval '1 minute', 'read'
         from generate_series(1, 5)`,
      [hh],
    );
    // The queue down: no email, and no mark that one went.
    queueDown = true;
    try {
      const first = await item({ typeKey: 'utility_bill' });
      await read(BILL);
      expect(await sealedAi(first)).toEqual({ state: 'without', held: 'cap' });
      expect(told).toEqual([]);
      expect((await withSystem(db, hh, (trx) => aiReaderMonthCount(trx))).warned).toBe(false);
    } finally {
      queueDown = false;
    }
    // The next paper, past the lowered cap, tells them — once.
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(sent).toEqual([]);
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toMatch(/5 of this month’s 2 papers/);
  });

  it('a call that never left the reader’s line is not counted (M3)', async () => {
    answer = () => ({ state: 'without', why: 'timeout', ms: 3, queued: true });
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(await counted()).toBe(0);
    answer = () => ({ state: 'without', why: 'timeout', ms: 3 });
    await item({ typeKey: 'utility_bill' });
    await read(BILL);
    expect(await counted()).toBe(1);
  });

  it('the same words sent again (an OpenAI-compatible retry) count as a second paper (M2)', async () => {
    const again: LocalAiReader = {
      ...cloud,
      read: async (text, _offer, o) => {
        sent.push(text);
        if (o.again && (await o.again())) sent.push(text);
        return { state: 'without', why: 'timeout', ms: 3 };
      },
    };
    await item({ typeKey: 'utility_bill' });
    await readNextBatchItem(deps, hh, {
      maxPages: 5,
      proposer: thread,
      extract: says(BILL),
      tools: { pdftotext: true, pdftoppm: true, tesseract: true } as never,
      localAi: again,
    });
    expect(sent).toHaveLength(2);
    expect(await counted()).toBe(2);
  });
});
