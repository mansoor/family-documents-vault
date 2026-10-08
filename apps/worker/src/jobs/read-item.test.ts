import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  EncryptStream,
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  newKey,
  openBytes,
  ScopeKeys,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import {
  levelItem,
  missingFields,
  proposeDetails,
  storedProposal,
  type BatchLevel,
  type LevelKind,
  type ProposalContext,
  type TypeField,
} from '@fdv/shared';
import { FIXTURE_ISSUERS, HELD_OUT, TUNED, type ProposalFixture } from '@fdv/shared/testdata';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resumeBatchItems, sweepBatches } from './batches.js';
import type { extractText } from './extract-text.js';
import type { IncomingDeps } from './incoming.js';
import { processVersion } from './process-version.js';
import { ProposalThread, type ItemProposer, type ThreadAnswer } from './proposal-thread.js';
import {
  BLANK_LETTERS,
  proposalContext,
  READ_STALE_MS,
  readNextBatchItem,
  type ReadOptions,
} from './read-item.js';
import { detectTools } from './tools.js';

const run = promisify(execFile);

/**
 * The vault reads each item and suggests (Phase 6, I2), in the worker: an
 * item's words taken once its pages are drawn, proposed for on a thread of
 * its own against what its uploader may see, and both sealed under the
 * item's own key — never plain, never in search; pages that cannot be read
 * make it `failed` with why; a worker that stops mid-read leaves it to be
 * read again; and what was read goes with the item.
 */

const MASTER = 'read-item-test-master-key-with-32-bytes-or-more';
const tools = await detectTools();
const hasPdfinfo = await run('pdfinfo', ['-v']).then(
  () => true,
  () => false,
);

/** 5.37's own: Sara's passport, its words as the page gives them. */
const PASSPORT = (TUNED.find((f) => f.name === 'uk-passport-sara') as ProposalFixture).text;

/** Stands in for the words' extraction: these words, read from the pages' own text. */
const says =
  (text: string): typeof extractText =>
  async () => ({ text, source: 'pdf', textPages: 1, ocrPages: 0 });

/** A one-page PDF of the lines given, built by hand; none for a blank page. */
function pdf(lines: string[], extra: { encrypt?: boolean } = {}): Buffer {
  const content = lines.map((l, i) => `BT /F1 14 Tf 40 ${740 - i * 20} Td (${l}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // A user password nobody here knows: the standard handler's checks never
  // match an empty one, so it opens for nobody without it.
  const hex = () => randomBytes(32).toString('hex');
  if (extra.encrypt) {
    objs.push(`<< /Filter /Standard /V 1 /R 2 /O <${hex()}> /U <${hex()}> /P -4 >>`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  const enc = extra.encrypt
    ? ` /Encrypt ${objs.length} 0 R /ID [<${randomBytes(16).toString('hex')}><${randomBytes(16).toString('hex')}>]`
    : '';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${enc} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A proposer that answers as told, and writes down what it was asked. */
function standIn(answer: (text: string) => ThreadAnswer) {
  const asked: Array<{ text: string; ctx: ProposalContext }> = [];
  const proposer: ItemProposer = {
    propose: async (text, ctx) => {
      asked.push({ text, ctx });
      return answer(text);
    },
  };
  return { proposer, asked };
}

describe.skipIf(!testAdminUrl())('an item read, in the worker (I2)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  let deps: IncomingDeps;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  let vault: string;
  /** The family, by first name; who signs in, and as what. */
  const m: Record<string, string> = {};
  const acct: Record<string, string> = {};
  let thread: ProposalThread;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-read-'));
    hh = randomUUID();
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'The Khan family', 'Europe/London')",
      [hh],
    );
    await admin.query("insert into household_profile (household_id, country) values ($1, 'GB')", [
      hh,
    ]);
    for (const [name, role] of [
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
          `${name.toLowerCase().replace(' ', '-')}-${stamp}@read.test`,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [acct[name], hh, m[name], role],
      );
    }
    // Somebody outside the family (5.34): never whose a document is.
    m.Gail = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name, kind) values ($1, 'Gail Guest', 'guest') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    vault = await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const who of ['Sara', 'Ahmed', 'Zain', 'Granny Ruth']) {
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

  /** A batch of `who`'s, ending when said. */
  const batch = async (who = 'Ahmed', endsInDays = 30) =>
    (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, created_at, ends_at)
         values ($1, $2, $3, now() - interval '1 day' * (30 - $4::int), now() + interval '1 day' * $4::int)
         returning id`,
        [hh, acct[who], m[who], endsInDays],
      )
    ).rows[0]?.id as string;

  /**
   * An item of `who`'s that has arrived, its bytes encrypted under its own
   * key as the API stores them, its pages drawn (unless said).
   */
  const item = async (
    batchId: string,
    bytes: Buffer,
    opts: { who?: string; mime?: string; drawn?: string; arrived?: Date } = {},
  ) => {
    const who = opts.who ?? 'Ahmed';
    const id = randomUUID();
    const key = `${hh}/batches/${batchId}/${randomBytes(8).toString('hex')}.enc`;
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: m[who] as string }),
    );
    const fileKey = newKey();
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
       values ($1, $2, $3, 'me', $4, 'received', 'scan.pdf', $5, $6, $7, 38, $8, $9, $10, $11, $12,
               'member', 'unscanned', 'waiting', $13, 1, $14, $14)`,
      [
        id,
        hh,
        batchId,
        m[who],
        opts.mime ?? 'application/pdf',
        bytes.length,
        randomBytes(32),
        randomBytes(32),
        key,
        vault,
        wrapKey(fileKey, scope.key, `incoming:${id}`),
        scope.id,
        opts.drawn ?? 'ready',
        opts.arrived ?? new Date(),
      ],
    );
    return { id, key, fileKey };
  };

  const rowOf = async (id: string) =>
    (
      await admin.query<{
        read_state: string;
        read_failure: string | null;
        text_sealed: Buffer | null;
        proposals_sealed: Buffer | null;
        read_started_at: Date | null;
      }>(
        'select read_state, read_failure, text_sealed, proposals_sealed, read_started_at from incoming_file where id = $1',
        [id],
      )
    ).rows[0];

  const opened = async (i: { id: string; fileKey: Buffer }) => {
    const row = await rowOf(i.id);
    return {
      text: openBytes(i.fileKey, row?.text_sealed as Buffer, itemTextBinding(i.id)).toString(
        'utf8',
      ),
      proposal: storedProposal(
        JSON.parse(
          openBytes(
            i.fileKey,
            row?.proposals_sealed as Buffer,
            itemProposalsBinding(i.id),
          ).toString('utf8'),
        ),
      ),
    };
  };

  const ctxOf = (who: string) =>
    withSystem(db, hh, (trx) => proposalContext(trx, hh, m[who] as string));

  /** Reads what is next, with these stand-ins (or the real thread). */
  const readNext = (opts: Partial<ReadOptions> = {}) =>
    readNextBatchItem(deps, hh, { maxPages: 5, proposer: thread, tools, ...opts });

  /** Every item of the household waiting to be read, put out of the way of the next test. */
  const clear = () =>
    admin.query(
      "update incoming_file set read_state = 'failed', read_failure = 'unreadable' where household_id = $1 and state = 'received' and read_state in ('waiting', 'reading')",
      [hh],
    );

  it('an item is read and proposed for under its own key, as its uploader would be: never plain, never in search', async () => {
    await clear();
    const b = await batch();
    const it1 = await item(b, pdf(['PASSPORT']));
    const r = await readNext({ extract: says(PASSPORT) });
    expect(r).toEqual({ read: it1.id, more: false });
    const row = await rowOf(it1.id);
    expect(row).toMatchObject({ read_state: 'read', read_failure: null });
    // Sealed: nothing of the page, or of what it proposes, is there to read.
    for (const blob of [row?.text_sealed, row?.proposals_sealed]) {
      expect(blob).toBeInstanceOf(Buffer);
      for (const secret of ['533401872', 'SARA', 'passport', m.Sara as string]) {
        expect((blob as Buffer).includes(Buffer.from(secret))).toBe(false);
      }
    }
    // Opened under the item's own key: its words, and what proposeDetails
    // proposes from them against what its uploader may see.
    const got = await opened(it1);
    expect(got.text).toBe(PASSPORT);
    expect(got.proposal).toEqual(proposeDetails(PASSPORT, await ctxOf('Ahmed')));
    expect(got.proposal).toMatchObject({
      type_key: { value: 'passport' },
      owner_member_id: { value: m.Sara },
      expires: { value: { date: '2031-03-14' } },
      identifier: { value: '533401872' },
    });
    // Bound to the item and to what it is: neither opens as the other.
    expect(() =>
      openBytes(it1.fileKey, row?.proposals_sealed as Buffer, itemTextBinding(it1.id)),
    ).toThrow();
    expect(() =>
      openBytes(it1.fileKey, row?.text_sealed as Buffer, itemTextBinding(randomUUID())),
    ).toThrow();
    // Not a document, so nothing searches it: no words anywhere search reads.
    const searched = await admin.query<{ n: string }>(
      `select (select count(*) from document_text where household_id = $1)
            + (select count(*) from document_text_sealed where household_id = $1)
            + (select count(*) from document where household_id = $1 and title ilike '%passport%') as n`,
      [hh],
    );
    expect(Number(searched.rows[0]?.n)).toBe(0);
  }, 60_000);

  it('the proposal reads only what its uploader may see: no issuer, number or kind of another’s Only me document, and never a guest', async () => {
    // Sara's Only me letter, from her own clinic, under a kind the household
    // deleted that only it still uses (0035); an Adults only statement; and
    // one for everybody.
    await admin.query(
      `insert into document_type (key, household_id, label, category)
       values ('h_falconryzz', $1, 'Falconry licence', 'other')`,
      [hh],
    );
    const doc = (
      vis: string,
      owner: string | null,
      issuer: string,
      extra: Record<string, string> = {},
    ) =>
      admin.query(
        `insert into document (household_id, title, visibility, owner_member_id, issued_by, identifier, type_key)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [hh, `${issuer} doc`, vis, owner, issuer, extra.identifier ?? null, extra.type ?? null],
      );
    await doc('private', m.Sara as string, 'Quietwater Clinic', {
      identifier: 'SECRET-NO-77',
      type: 'h_falconryzz',
    });
    await doc('adults', m.Sara as string, 'Grownups Bank');
    await doc('household', m.Ahmed as string, 'Aviva');
    await admin.query("update document_type set deleted_at = now() where key = 'h_falconryzz'");

    const ahmed = await ctxOf('Ahmed');
    const issuers = (c: ProposalContext) => (c.issuers ?? []).map((i) => i.value).sort();
    expect(issuers(ahmed)).toEqual(['Aviva', 'Grownups Bank']);
    expect(ahmed.types.some((t) => t.key === 'h_falconryzz')).toBe(false);
    expect(ahmed.types.some((t) => t.key === 'passport')).toBe(true);
    expect(ahmed.people.map((p) => p.name).sort()).toEqual([
      'Ahmed',
      'Granny Ruth',
      'Sara',
      'Zain',
    ]);
    const said = JSON.stringify(ahmed);
    for (const secret of ['Quietwater', 'SECRET-NO-77', 'Falconry', 'Gail']) {
      expect(said).not.toContain(secret);
    }
    expect(ahmed).toMatchObject({ household: 'The Khan family', dateOrder: 'dmy' });
    // A teen sees no Adults only documents: nor their issuers.
    expect(issuers(await ctxOf('Zain'))).toEqual(['Aviva']);
    // Sara sees her own.
    expect(issuers(await ctxOf('Sara'))).toEqual(['Aviva', 'Grownups Bank', 'Quietwater Clinic']);

    // End to end: a letter that names the clinic in passing. For Ahmed it is
    // nobody he knows of — never "one of your issuers" — and for Sara it is.
    const letter = [
      'Appointment letter',
      'Further to your visit, the notes were sent to Quietwater Clinic.',
      'Yours sincerely',
    ].join('\n');
    const proposed = async (who: string) => {
      await clear();
      const b = await batch(who);
      const i = await item(b, pdf(['letter']), { who });
      await readNext({ extract: says(letter) });
      return (await opened(i)).proposal;
    };
    const forAhmed = await proposed('Ahmed');
    expect(forAhmed.issued_by?.cue).not.toBe('known_issuer');
    const forSara = await proposed('Sara');
    expect(forSara.issued_by).toMatchObject({ value: 'Quietwater Clinic', cue: 'known_issuer' });
  }, 60_000);

  it('pages that cannot be read make the item failed, with why — never a crash', async () => {
    const cases: Array<{
      why: string;
      opts: Partial<ReadOptions>;
      failure: string;
    }> = [
      { why: 'a kind not read', opts: { extract: async () => null }, failure: 'not_read' },
      { why: 'blank', opts: { extract: says(' \n\n  - ') }, failure: 'blank' },
      {
        why: 'a password',
        opts: {
          extract: async () => {
            throw new Error('Command failed: pdftoppm\nCommand Line Error: Incorrect password');
          },
        },
        failure: 'password',
      },
      {
        why: 'a tool that failed',
        opts: {
          extract: async () => {
            throw new Error('Syntax Error: Couldn’t read xref table');
          },
        },
        failure: 'unreadable',
      },
      {
        why: 'too slow to propose from',
        opts: {
          extract: says(PASSPORT),
          proposer: standIn(() => ({ state: 'too_slow' })).proposer,
        },
        failure: 'too_slow',
      },
      {
        why: 'rules that failed on it',
        opts: { extract: says(PASSPORT), proposer: standIn(() => ({ state: 'failed' })).proposer },
        failure: 'unreadable',
      },
    ];
    expect(BLANK_LETTERS).toBeGreaterThan(1);
    for (const c of cases) {
      await clear();
      const i = await item(await batch(), pdf(['x']));
      await readNext(c.opts);
      expect({ why: c.why, ...(await rowOf(i.id)) }).toMatchObject({
        why: c.why,
        read_state: 'failed',
        read_failure: c.failure,
        text_sealed: null,
        proposals_sealed: null,
      });
    }
    // No thread to be had: left to be read again, and the job told so.
    await clear();
    const later = await item(await batch(), pdf(['x']));
    await expect(
      readNext({
        extract: says(PASSPORT),
        proposer: standIn(() => ({ state: 'unavailable' })).proposer,
      }),
    ).rejects.toThrow(/read again later/);
    expect(await rowOf(later.id)).toMatchObject({ read_state: 'waiting', read_started_at: null });
    // Its bytes not to be had just now: the same.
    await admin.query('update incoming_file set storage_key = $2 where id = $1', [
      later.id,
      `${hh}/batches/gone.enc`,
    ]);
    await expect(readNext({ extract: says(PASSPORT) })).rejects.toThrow();
    expect(await rowOf(later.id)).toMatchObject({ read_state: 'waiting' });
  }, 60_000);

  it.skipIf(!tools.pdftotext)(
    'a blank page, read for real, is blank',
    async () => {
      await clear();
      const i = await item(await batch(), pdf([]));
      await readNext();
      expect(await rowOf(i.id)).toMatchObject({ read_state: 'failed', read_failure: 'blank' });
    },
    60_000,
  );

  it.skipIf(!hasPdfinfo)(
    'a PDF with a password, read for real, says so',
    async () => {
      await clear();
      const i = await item(
        await batch(),
        pdf(['PASSPORT', 'Passport No. 533401872'], { encrypt: true }),
      );
      await readNext();
      expect(await rowOf(i.id)).toMatchObject({ read_state: 'failed', read_failure: 'password' });
    },
    60_000,
  );

  it('the deadline ends a crafted page’s thread, and the next item is read as if nothing happened', async () => {
    await clear();
    const STAND_IN = new URL(
      `data:text/javascript,${encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (job) => {
  if (job.text.includes('SPIN')) for (;;) {}
  parentPort.postMessage({ id: job.id, proposal: { type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' } } });
});
parentPort.postMessage({ ready: true });
`)}`,
    );
    const slow = new ProposalThread({ entry: STAND_IN, deadlineMs: 400 });
    try {
      const b = await batch();
      const crafted = await item(b, pdf(['x']), { arrived: new Date(Date.now() - 2000) });
      const next = await item(b, pdf(['y']), { arrived: new Date(Date.now() - 1000) });
      const words = new Map([
        [crafted.id, 'SPIN'],
        [next.id, PASSPORT],
      ]);
      const started = Date.now();
      // The words each item says, by the file the worker decrypted: told apart by the order read.
      let n = 0;
      const extract: typeof extractText = async () => ({
        text: n++ === 0 ? (words.get(crafted.id) as string) : (words.get(next.id) as string),
        source: 'pdf',
        textPages: 1,
        ocrPages: 0,
      });
      expect(await readNext({ extract, proposer: slow })).toMatchObject({
        read: crafted.id,
        more: true,
      });
      expect(await rowOf(crafted.id)).toMatchObject({
        read_state: 'failed',
        read_failure: 'too_slow',
      });
      expect(slow.ended).toBe(1);
      expect(await readNext({ extract, proposer: slow })).toMatchObject({
        read: next.id,
        more: false,
      });
      expect(await rowOf(next.id)).toMatchObject({ read_state: 'read' });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await slow.close();
    }
  }, 60_000);

  it('a worker that stops mid-read leaves the item to be read again, never stuck in reading', async () => {
    await clear();
    const b = await batch();
    const i = await item(b, pdf(['x']));
    // Taken by a worker that then stopped: fresh, it is not taken again by the queue…
    await admin.query(
      "update incoming_file set read_state = 'reading', read_started_at = now() where id = $1",
      [i.id],
    );
    expect(await readNext({ extract: says(PASSPORT) })).toEqual({ read: null, more: false });
    // …but the worker's start puts it back, and sends the household's job.
    const sent: string[] = [];
    expect(await resumeBatchItems(deps, async (h) => void sent.push(h))).toBeGreaterThanOrEqual(1);
    expect(sent).toContain(hh);
    expect(await rowOf(i.id)).toMatchObject({ read_state: 'waiting', read_started_at: null });
    expect(await readNext({ extract: says(PASSPORT) })).toMatchObject({ read: i.id });
    expect(await rowOf(i.id)).toMatchObject({ read_state: 'read' });

    // One taken long ago is taken again by the queue itself.
    const old = await item(b, pdf(['z']));
    await admin.query(
      "update incoming_file set read_state = 'reading', read_started_at = $2 where id = $1",
      [old.id, new Date(Date.now() - READ_STALE_MS - 60_000)],
    );
    expect(await readNext({ extract: says(PASSPORT) })).toMatchObject({ read: old.id });
    expect(await rowOf(old.id)).toMatchObject({ read_state: 'read' });

    // A read taken again meanwhile: the one that took it first writes nothing.
    await clear();
    const raced = await item(b, pdf(['r']));
    const proposer: ItemProposer = {
      propose: async (text, ctx) => {
        // Another worker takes it while this one proposes.
        await admin.query(
          "update incoming_file set read_state = 'reading', read_started_at = now() + interval '1 minute' where id = $1",
          [raced.id],
        );
        return { state: 'done', proposal: proposeDetails(text, ctx) };
      },
    };
    await readNext({ extract: says(PASSPORT), proposer });
    expect(await rowOf(raced.id)).toMatchObject({
      read_state: 'reading',
      text_sealed: null,
      proposals_sealed: null,
    });
  }, 60_000);

  it('what was read goes with the item: the database keeps none for a decided one, and the sweep takes it with its row', async () => {
    await clear();
    const ended = await batch('Ahmed', -1);
    const i = await item(ended, pdf(['x']));
    await readNext({ extract: says(PASSPORT) });
    expect((await rowOf(i.id))?.text_sealed).toBeInstanceOf(Buffer);
    // Decided with what was read still on it: refused by the database itself.
    await expect(
      admin.query("update incoming_file set state = 'rejected', decided_at = now() where id = $1", [
        i.id,
      ]),
    ).rejects.toThrow(/incoming_file_read_waiting/);
    // Swept with its batch: its row, and so its words and proposals, gone.
    await sweepBatches(deps, hh, new Date());
    expect(await rowOf(i.id)).toBeUndefined();
  }, 60_000);

  it.skipIf(!tools.pdftotext)(
    'accepted Only me, its pages are read again as a single add’s are: sealed under its owner’s key, never plain',
    async () => {
      await clear();
      const b = await batch();
      const bytes = pdf(['PASSPORT', 'Passport No. 533401872', 'Surname KHAN']);
      const i = await item(b, bytes);
      await readNext({ extract: says(PASSPORT) });
      // Accepted as the API accepts it (DocumentService.fileIncoming): an Only
      // me document of the uploader's, its version's key wrapped for it, the
      // item decided — what was read let go of with it.
      const docId = randomUUID();
      await withSystem(db, hh, async (trx) => {
        const scope = await keys.unwrap(trx, {
          householdId: hh,
          kind: 'member',
          memberId: m.Ahmed as string,
        });
        await trx
          .insertInto('document')
          .values({
            id: docId,
            household_id: hh,
            title: 'Accepted',
            visibility: 'private',
            owner_member_id: m.Ahmed as string,
          })
          .execute();
        const v = await trx
          .insertInto('document_version')
          .values({
            household_id: hh,
            document_id: docId,
            version_no: 1,
            filename: 'scan.pdf',
            storage_key: i.key,
            vault_id: vault,
            mime: 'application/pdf',
            byte_size: bytes.length,
            sha256: randomBytes(32),
            cipher_bytes: bytes.length + 38,
            cipher_sha256: randomBytes(32),
            file_key_wrapped: wrapKey(i.fileKey, scope.key, `version:${docId}`),
            wrapped_by_scope: scope.id,
            uploaded_by: acct.Ahmed as string,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('incoming_file')
          .set({
            state: 'accepted',
            decided_at: new Date(),
            document_id: docId,
            version_id: v.id,
            text_sealed: null,
            proposals_sealed: null,
          })
          .where('id', '=', i.id)
          .execute();
        return v.id;
      }).then((versionId) =>
        processVersion(
          {
            db,
            keys,
            credentialsKey: Buffer.alloc(32),
            localRoot: root,
            maxOcrPages: 5,
            log: () => undefined,
          },
          { household_id: hh, version_id: versionId },
        ),
      );
      const plain = await admin.query('select 1 from document_text where document_id = $1', [
        docId,
      ]);
      expect(plain.rows).toEqual([]);
      const sealed = await admin.query<{ content_cipher: Buffer }>(
        'select content_cipher from document_text_sealed where document_id = $1',
        [docId],
      );
      expect(sealed.rows).toHaveLength(1);
      expect(sealed.rows[0]?.content_cipher.includes(Buffer.from('533401872'))).toBe(false);
    },
    60_000,
  );

  /**
   * 5.37's fixtures through the item path: read by the worker (their words
   * standing in for the pages'), proposed for against this household — the
   * vault's own kinds as a household that changed none keeps them, the
   * family by name, its issuers on documents everybody sees — and levelled
   * as the API levels them, with no defaults. A Ready item must be right.
   */
  it('5.37’s fixtures, through the item path: how many are Ready, Check and Not recognised', async () => {
    await clear();
    // The fixtures' issuers, on documents everybody sees; and their people by these names.
    for (const iss of FIXTURE_ISSUERS) {
      for (let n = 0; n < iss.count; n++) {
        await admin.query(
          'insert into document (household_id, title, issued_by, type_key) values ($1, $2, $3, $4)',
          [hh, `${iss.value} ${n}`, iss.value, iss.typeKeys?.[0] ?? null],
        );
      }
    }
    const byFixtureId: Record<string, string> = {
      'm-sara': m.Sara as string,
      'm-ahmed': m.Ahmed as string,
      'm-zain': m.Zain as string,
      'm-ruth': m['Granny Ruth'] as string,
    };
    const kinds = await withSystem(db, hh, (trx) =>
      trx
        .selectFrom('effective_document_type')
        .selectAll()
        .where('deleted_at', 'is', null)
        .execute(),
    );
    // As the API's typeView gives them: the date its kind reminds from is required.
    const types: LevelKind[] = kinds.map((t) => ({
      key: t.key,
      label: t.label,
      default_visibility: t.default_visibility,
      expiry_driver: t.expiry_driver,
      core: t.core as NonNullable<LevelKind['core']>,
      fields: ((t.fields ?? []) as TypeField[]).map((f) => ({
        ...f,
        required: f.required === true || f.key === t.remind_from,
      })),
    }));
    const people = ['Sara', 'Ahmed', 'Zain', 'Granny Ruth'].map((n) => ({
      id: m[n] as string,
      name: n,
    }));
    const b = await batch();
    const tally: Record<string, Record<BatchLevel, number>> = {};
    const wrongReady: string[] = [];
    for (const [set, fixtures] of [
      ['tuned', TUNED],
      ['held out', HELD_OUT],
    ] as Array<[string, ProposalFixture[]]>) {
      const t = (tally[set] = { ready: 0, check: 0, unrecognised: 0, problem: 0 });
      for (const f of fixtures) {
        const i = await item(b, pdf([f.name]));
        await readNext({ extract: says(f.text) });
        const { proposal } = await opened(i);
        const l = levelItem({
          state: 'waiting',
          reading: 'read',
          failure: null,
          proposal,
          duplicate: null,
          defaults: {
            owner_member_id: null,
            type_key: null,
            visibility: null,
            physical_location: null,
            collection_id: null,
            tags: [],
            is_essential: false,
          },
          types,
          people,
          role: 'adult',
          me: m.Ahmed as string,
        });
        t[l.level as BatchLevel] += 1;
        if (l.level === 'ready') {
          const kind = l.proposals?.type_key?.value;
          const owner = l.proposals?.owner_member_id?.value;
          if (kind !== f.truth.type_key || owner !== byFixtureId[f.truth.owner ?? '']) {
            wrongReady.push(f.name);
          }
          expect(
            missingFields(
              types.find((k) => k.key === kind),
              {},
            ),
          ).toBeDefined();
        }
      }
    }
    // What the run found (reported with I2): no Ready item is wrong.
    expect(wrongReady).toEqual([]);
    expect(tally).toEqual({
      tuned: { ready: 13, check: 7, unrecognised: 2, problem: 0 },
      'held out': { ready: 9, check: 3, unrecognised: 2, problem: 0 },
    });
  }, 120_000);
});
