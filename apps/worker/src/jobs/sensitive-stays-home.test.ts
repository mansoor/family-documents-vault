import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
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
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { storedLocalAi } from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicReader } from '../cloud-readers.js';
import { OllamaReader } from '../ollama-reader.js';
import type { extractText } from './extract-text.js';
import type { IncomingDeps } from './incoming.js';
import { ProposalThread } from './proposal-thread.js';
import { readNextBatchItem, type LocalAiReader } from './read-item.js';

/**
 * Reading stays on the server (0.9.0, H1a of plan-health): a sensitive
 * paper is read by the vault's own rules, and by an AI reader only on the
 * household's own network — the sending rule (`mayReadWith`, AIR3) is the
 * line, and this holds it at the network: every connection the worker opens
 * while it reads one is recorded, and the only ones are to the vault's own
 * database, and, for a reader on the household's own network, to that
 * reader. A cloud reader — a real AnthropicReader, pointed at a server of
 * the test's own that would answer — is never connected to at all.
 */

const MASTER = 'sensitive-stays-home-test-master-key-with-32-bytes-or-more';

const says =
  (text: string): typeof extractText =>
  async () => ({ text, source: 'pdf', textPages: 1, ocrPages: 0 });

const RECORD = [
  'St Mary’s Hospital',
  'Patient: Sara Khan',
  'Blood test results',
  'Date of service 14 March 2026',
].join('\n');

/** Where a connection went: a host and a port, or a socket's path. */
interface Dialled {
  host: string | null;
  port: number | null;
  path: string | null;
}

describe.skipIf(!testAdminUrl())('a sensitive paper is read on the server (H1a)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  let deps: IncomingDeps;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  let hh: string;
  let vault: string;
  let member: string;
  let owner: string;
  let thread: ProposalThread;
  /** The database's port: the one place the worker may always connect to. */
  let dbPort: number;
  /** A reader's server of the test's own: every request it was sent. */
  let server: http.Server;
  let serverPort: number;
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  /** Every connection opened while recording. */
  const dialled: Dialled[] = [];
  let recording = false;
  // Kept to put back, and called with each socket as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = net.Socket.prototype.connect;

  beforeAll(async () => {
    // Every connection a socket makes — a database's, fetch's, http's —
    // goes through Socket.prototype.connect.
    const recorder = function (this: Socket, ...args: unknown[]) {
      if (recording) {
        // net.connect hands over its arguments already normalised, as one array.
        const given: unknown[] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
        const [a, b] = given;
        if (typeof a === 'object' && a !== null) {
          const o = a as { host?: string; port?: number | string; path?: string };
          dialled.push({
            host: o.host ?? null,
            port: o.port === undefined ? null : Number(o.port),
            path: o.path ?? null,
          });
        } else if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
          dialled.push({ host: typeof b === 'string' ? b : null, port: Number(a), path: null });
        } else if (typeof a === 'string') {
          dialled.push({ host: null, port: null, path: a });
        }
      }
      return (original as (...a: unknown[]) => Socket).apply(this, args);
    };
    net.Socket.prototype.connect = recorder;

    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    serverPort = (server.address() as AddressInfo).port;

    tdb = await createTestDatabase();
    dbPort = Number(new URL(tdb.appUrl).port || 5432);
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-stays-home-'));
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
        `sara-${randomBytes(4).toString('hex')}@stays-home.test`,
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
    net.Socket.prototype.connect = original;
    await thread?.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await rm(root, { recursive: true, force: true });
    for (const s of sockets) s.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });

  afterEach(async () => {
    recording = false;
    dialled.length = 0;
    seen.length = 0;
    await admin.query(
      "update incoming_file set read_state = 'failed', read_failure = 'unreadable' where household_id = $1 and state = 'received' and read_state in ('waiting', 'reading')",
      [hh],
    );
  });

  /** A paper waiting to be read, in a batch of its own that names its kind and visibility. */
  const item = async (d: { typeKey: string; visibility: string; sensitive?: boolean | null }) => {
    const batchId = (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, ends_at,
                                   default_sensitive, default_visibility, default_type_key)
         values ($1, $2, $3, now() + interval '30 days', $4, $5, $6) returning id`,
        [hh, owner, member, d.sensitive ?? null, d.visibility, d.typeKey],
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
    return { id, fileKey };
  };

  /** Read the next paper with this reader, every connection recorded. */
  const read = async (reader: LocalAiReader) => {
    recording = true;
    try {
      return await readNextBatchItem(deps, hh, {
        maxPages: 5,
        proposer: thread,
        extract: says(RECORD),
        tools: { pdftotext: true, pdftoppm: true, tesseract: true } as never,
        localAi: reader,
      });
    } finally {
      recording = false;
    }
  };

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

  /** Where the worker connected that is not its own database. */
  const elsewhere = () =>
    dialled.filter((d) => d.path === null && d.port !== dbPort).map((d) => `${d.host}:${d.port}`);

  const cloud = () =>
    new AnthropicReader(
      {
        url: new URL(`http://127.0.0.1:${serverPort}`),
        model: 'claude-haiku-4-5',
        timeoutMs: 3_000,
      },
      { apiKey: 'sk-test-not-a-key', testMs: 3_000, probeMs: 3_000 },
    );
  const ownNetwork = () =>
    new OllamaReader({
      url: new URL(`http://127.0.0.1:${serverPort}`),
      model: 'llama3.2',
      timeoutMs: 3_000,
    });

  it('a sensitive paper, a cloud reader set up: read, and no connection anywhere but the database', async () => {
    const reader = cloud();
    expect(reader.runsAt).toBe('cloud');
    const i = await item({ typeKey: 'medical_record', visibility: 'adults' });
    expect((await read(reader)).read).toBe(i.id);
    expect(await sealedAi(i)).toEqual({ state: 'without', held: 'sensitive' });
    expect(seen).toEqual([]);
    expect(elsewhere()).toEqual([]);
    expect(reader.sent).toBe(0);
  });

  it('marked sensitive itself, of a kind that is not: the same', async () => {
    const reader = cloud();
    const i = await item({ typeKey: 'utility_bill', visibility: 'household', sensitive: true });
    expect((await read(reader)).read).toBe(i.id);
    expect(await sealedAi(i)).toEqual({ state: 'without', held: 'sensitive' });
    expect(seen).toEqual([]);
    expect(elsewhere()).toEqual([]);
  });

  it('a reader on the household’s own network: asked, and the only other place connected to', async () => {
    const reader = ownNetwork();
    expect(reader.runsAt).toBe('own_network');
    const i = await item({ typeKey: 'medical_record', visibility: 'adults' });
    expect((await read(reader)).read).toBe(i.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(elsewhere())).toEqual(new Set([`127.0.0.1:${serverPort}`]));
  });

  it('the recorder sees a cloud reader’s call where the rule lets one go: a paper that is not sensitive', async () => {
    // The check that the recorder would have seen one: a bill goes.
    const reader = cloud();
    await item({ typeKey: 'utility_bill', visibility: 'household' });
    await read(reader);
    expect(seen.length).toBeGreaterThan(0);
    expect(elsewhere()).toContain(`127.0.0.1:${serverPort}`);
  });
});
