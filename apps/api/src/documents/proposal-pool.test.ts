import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { proposeDetails, type DetailSuggestions, type ProposalContext } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { ProposalPool } from './proposal-pool.js';

/**
 * Proposals off the API's event loop (5.37, N537P-01): `proposeDetails` on
 * a thread of its own, ended at its deadline. A page that takes too long
 * is answered with no proposal — `unavailable`, never a 500 — the API
 * answers everybody else meanwhile, and the next page gets a new thread.
 */

const API_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = path.join(API_DIR, '..', '..', 'scripts', 'bundle.mjs');

const PASSPORT = [
  'PASSPORT',
  'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND',
  'Passport No.',
  '533401872',
  'Surname',
  'KHAN',
  'Given names',
  'SARAH',
  'Nationality',
  'BRITISH CITIZEN',
  'Place of birth',
  'LEEDS',
  'Date of issue',
  '14 MAR 2021',
  'Date of expiry',
  '14 MAR 2031',
].join('\n');

const CTX: ProposalContext = {
  types: [
    {
      key: 'passport',
      label: 'Passport',
      fields: [],
      expiry_driver: 'expires_on',
      issued_by_label: 'Issuing country',
    },
  ],
  people: [{ id: 'm-sarah', name: 'Sarah' }],
  household: 'The Khan family',
  dateOrder: 'dmy',
};

/**
 * A thread that stands in for the rules: it answers at once — unless the
 * page says SPIN, when it never answers at all, as a page made to be slow
 * would not.
 */
const CANNED = { type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' } };
const STAND_IN = new URL(
  `data:text/javascript,${encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (job) => {
  if (job.text.includes('SPIN')) for (;;) {}
  parentPort.postMessage({ id: job.id, proposal: ${JSON.stringify(CANNED)} });
});
parentPort.postMessage({ ready: true });
`)}`,
);

describe('the proposal thread (5.37, N537P-01)', () => {
  it('proposes on its own thread what proposeDetails proposes', async () => {
    const pool = new ProposalPool();
    try {
      const got = await pool.propose(PASSPORT, CTX);
      expect(got).toEqual(proposeDetails(PASSPORT, CTX));
      expect(got?.expires?.value.date).toBe('2031-03-14');
      // Again, on the same thread.
      expect(await pool.propose(PASSPORT, CTX)).toEqual(got);
      expect(pool.ended).toBe(0);
    } finally {
      await pool.close();
    }
  }, 60_000);

  it('a page that takes too long is ended at its deadline: nothing, the event loop free meanwhile, and a new thread for the next', async () => {
    const pool = new ProposalPool({ entry: STAND_IN, deadlineMs: 400 });
    try {
      expect(await pool.propose('a page', CTX)).toEqual(CANNED);
      const started = Date.now();
      let answered = false;
      const slow = pool.propose('SPIN', CTX).then((p) => {
        answered = true;
        return p;
      });
      // A timer on this thread fires on time while the page spins on its own.
      const ticked = await new Promise<number>((r) =>
        setTimeout(() => r(Date.now() - started), 50),
      );
      expect(ticked).toBeLessThan(300);
      expect(answered).toBe(false);
      expect(await slow).toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(380);
      expect(pool.ended).toBe(1);
      // The next page is answered, by a new thread.
      expect(await pool.propose('a page', CTX)).toEqual(CANNED);
    } finally {
      await pool.close();
    }
  }, 30_000);

  it('a full queue is answered with nothing at once, and what waited is answered after', async () => {
    const pool = new ProposalPool({ entry: STAND_IN, deadlineMs: 400, queue: 1 });
    try {
      expect(await pool.propose('a page', CTX)).toEqual(CANNED);
      const slow = pool.propose('SPIN', CTX);
      const waiting = pool.propose('a page', CTX);
      expect(await pool.propose('one too many', CTX)).toBeNull();
      expect(await slow).toBeNull();
      expect(await waiting).toEqual(CANNED);
    } finally {
      await pool.close();
    }
  }, 30_000);

  it('a thread that will not start is answered with nothing, never an error', async () => {
    const pool = new ProposalPool({
      entry: pathToFileURL(path.join(API_DIR, 'no-such-entry.mjs')),
    });
    try {
      await expect(pool.propose('a page', CTX)).resolves.toBeNull();
      // Resting: answered at once, no thread tried.
      await expect(pool.propose('a page', CTX)).resolves.toBeNull();
    } finally {
      await pool.close();
    }
  }, 30_000);

  it('bundled, as the image runs it: the thread is dist/proposal-worker.mjs beside the server', async () => {
    const dir = path.join(API_DIR, 'dist', `test-proposals-${randomUUID().slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    try {
      const pool = path.relative(dir, path.join(API_DIR, 'src', 'documents', 'proposal-pool.js'));
      await writeFile(
        path.join(dir, 'entry.ts'),
        [
          `import { readFileSync } from 'node:fs';`,
          `import { ProposalPool } from '${pool.split(path.sep).join('/')}';`,
          `const { text, ctx } = JSON.parse(readFileSync(new URL('./input.json', import.meta.url), 'utf8'));`,
          `const awake = setInterval(() => undefined, 1000);`,
          `const pool = new ProposalPool();`,
          `console.log(JSON.stringify(await pool.propose(text, ctx)));`,
          `await pool.close();`,
          `clearInterval(awake);`,
        ].join('\n'),
      );
      await writeFile(path.join(dir, 'input.json'), JSON.stringify({ text: PASSPORT, ctx: CTX }));
      // Entries relative to the app, as its build names them.
      const here = path.relative(API_DIR, dir).split(path.sep).join('/');
      for (const [entry, out] of [
        [`${here}/entry.ts`, 'server.mjs'],
        ['src/documents/proposal-worker.ts', 'proposal-worker.mjs'],
      ] as const) {
        execFileSync(process.execPath, [BUNDLE, entry, path.join(dir, out)], {
          cwd: API_DIR,
          stdio: 'ignore',
        });
      }
      const out = execFileSync(process.execPath, [path.join(dir, 'server.mjs')], {
        cwd: API_DIR,
        encoding: 'utf8',
      });
      expect(JSON.parse(out.trim())).toEqual(proposeDetails(PASSPORT, CTX));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-proposal-pool-boundary';

describe.skipIf(!testAdminUrl())('the API while a page is proposed for (5.37, N537P-01)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  const pool = new ProposalPool({ entry: STAND_IN, deadlineMs: 1_000 });

  /** A document whose newest version's pages were read as `words`. */
  const filed = async (words: string) => {
    const field = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify({ title: 'Scan' })}\r\n`,
    );
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(owner),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([field, head, PDF, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]),
    });
    expect(r.statusCode, r.body).toBe(201);
    const made = r.json<{ document_id: string; version_id: string }>();
    await admin.query(
      'insert into document_text (version_id, household_id, document_id, content) values ($1, $2, $3, $4)',
      [made.version_id, owner.household_id, made.document_id, words],
    );
    await admin.query("update document_version set ocr_status = 'done' where id = $1", [
      made.version_id,
    ]);
    return made;
  };
  const get = (url: string) => h.app.inject({ url, headers: h.as(owner) });

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000, proposals: pool });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup({ household_name: 'The Khan family' });
  }, 120_000);
  afterAll(async () => {
    await pool.close();
    await admin?.end();
    await h?.close();
  });

  it('answers everybody else while a page takes too long, then says unavailable — never a 500', async () => {
    const slow = await filed('SPIN: a page made to be slow');
    const plain = await filed(PASSPORT);
    // The thread is started, and answers.
    const first = await get(`/api/v1/documents/${plain.document_id}/suggestions`);
    expect(first.json<DetailSuggestions>()).toEqual({
      state: 'ready',
      version_id: plain.version_id,
      proposal: CANNED,
    });

    const started = Date.now();
    let answered = false;
    const asked = get(`/api/v1/documents/${slow.document_id}/suggestions`).then((r) => {
      answered = true;
      return r;
    });
    // Another request, while that page spins: answered at once.
    const other = await get(`/api/v1/documents/${plain.document_id}`);
    expect(other.statusCode, other.body).toBe(200);
    expect(answered).toBe(false);
    expect(Date.now() - started).toBeLessThan(900);

    const r = await asked;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<DetailSuggestions>()).toEqual({
      state: 'unavailable',
      version_id: null,
      proposal: {},
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(pool.ended).toBe(1);

    // The next page is answered by a new thread.
    const next = await get(`/api/v1/documents/${plain.document_id}/suggestions`);
    expect(next.json<DetailSuggestions>().state).toBe('ready');
  }, 60_000);
});
