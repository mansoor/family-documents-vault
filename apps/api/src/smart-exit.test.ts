import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  itemFolder,
  type BatchDetail,
  type BatchItemView,
  type DocumentTypeView,
  type Tokens,
} from '@fdv/shared';
import {
  scoreItem,
  summarise,
  type SmartEntry,
  type SmartScore,
  type SmartSeen,
  type SmartSummary,
} from '@fdv/shared/testdata';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * The Smart exit, measured (0.8.0, S5; 04-build-plan §3, Phase 6 "Smart"):
 * a folder of two hundred mixed PDFs (scripts/smart-corpus.mjs) added with
 * Add → Many documents through the API, each with where it was under the
 * folder (`relative_path`, as the web sends it); the worker draws and reads
 * each — the PDF's own text, Tesseract for a scan — and proposes; and each
 * item's card, as GET /batches/{id} gives it, is scored against what a
 * person would fill in (@fdv/shared/testdata, smart-exit.ts). Then the same
 * again with no folders, to show what the folders add. Both corpora: the
 * first 200, which the rules were adjusted on, and a second set written
 * after and held out (FDV_SMART_EXIT_CORPORA, default "first,second").
 *
 * Only with FDV_SMART_EXIT=1: OCR on the scans takes minutes. Run it where
 * the worker's tools are — node:22-alpine with poppler, ImageMagick and
 * Tesseract, as the restore tests run (docs/smart-exit.md says how). It
 * writes what it found to FDV_SMART_EXIT_OUT (a JSON file), and fails on
 * any Ready item wrong; how many need typing it records.
 */

const RUN = process.env.FDV_SMART_EXIT === '1';
/**
 * The corpora measured: `first`, the 200 the rules were adjusted on (seed
 * 1), and `second`, the held-out set written after them and frozen before
 * the vault read any of it (seed 2; 0.8.0 S5, the owner's decision).
 */
const CORPORA = (process.env.FDV_SMART_EXIT_CORPORA ?? 'first,second')
  .split(',')
  .map((c) => c.trim())
  .filter((c): c is 'first' | 'second' => c === 'first' || c === 'second');
const SEED_OF = { first: 1, second: 2 } as const;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = process.env.FDV_SMART_EXIT_OUT ?? path.join(tmpdir(), 'fdv-smart-exit.json');
/** The folder chosen on Add → Many documents: a container, so the web drops it (folderOfChosen). */
const TOP = 'Family papers';

interface CorpusFile {
  path: string;
  bytes: Buffer;
  entry: SmartEntry;
}
interface CorpusModule {
  smartCorpus(o: { seed: number; corpus: 'first' | 'second' }): {
    household: { name: string; people: Array<{ key: string; name: string; role: string | null }> };
    files: CorpusFile[];
  };
}
interface Answer {
  more: boolean;
}
interface WorkerModules {
  drawNextBatchItem(
    deps: unknown,
    job: { household_id: string },
  ): Promise<Answer & { drawn: string | null }>;
  readNextBatchItem(
    deps: unknown,
    hh: string,
    opts: { maxPages: number; proposer: unknown },
  ): Promise<Answer & { read: string | null }>;
  ProposalThread: new () => { close(): Promise<void> };
  detectTools(): Promise<Record<string, boolean>>;
}

/** A module of the repository by its path, loaded as vitest loads any other. */
const load = async <T>(rel: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href)) as T;

describe.runIf(RUN && testAdminUrl())('the Smart exit, measured (S5)', () => {
  let h: Harness;
  let owner: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let w: WorkerModules;
  let thread: { close(): Promise<void> };
  let corpora: Record<string, ReturnType<CorpusModule['smartCorpus']>>;
  /** A member's id → their key in the corpus ("ahmed"). */
  const keyOf = new Map<string, string>();
  let expiring: Set<string>;

  beforeAll(async () => {
    const made = await load<CorpusModule>('scripts/smart-corpus.mjs');
    corpora = Object.fromEntries(
      CORPORA.map((c) => [c, made.smartCorpus({ seed: SEED_OF[c], corpus: c })]),
    );
    const corpus = corpora[CORPORA[0] as string] as ReturnType<CorpusModule['smartCorpus']>;
    w = {
      ...(await load<Pick<WorkerModules, 'drawNextBatchItem'>>('apps/worker/src/jobs/batches.ts')),
      ...(await load<Pick<WorkerModules, 'readNextBatchItem'>>(
        'apps/worker/src/jobs/read-item.ts',
      )),
      ...(await load<Pick<WorkerModules, 'ProposalThread'>>(
        'apps/worker/src/jobs/proposal-thread.ts',
      )),
      ...(await load<Pick<WorkerModules, 'detectTools'>>('apps/worker/src/jobs/tools.ts')),
    };
    const tools = await w.detectTools();
    if (!tools.pdftotext || !tools.pdftoppm || !tools.tesseract) {
      throw new Error(`the worker's tools are not all here: ${JSON.stringify(tools)}`);
    }
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    const people = corpus.household.people;
    const ownerName = people.find((p) => p.role === 'owner')?.name ?? 'Olivia';
    owner = await h.setup({ display_name: ownerName, household_name: corpus.household.name });
    hh = owner.household_id;
    admin = createPool(h.adminUrl, 2);
    const as = h.as(owner);
    const profile = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: as,
      payload: { country: 'GB', timezone: 'Europe/London' },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    for (const p of people) {
      if (p.role === 'adult' || p.role === 'teen') {
        await h.join(owner, { name: p.name, email: `${p.key}@smart-exit.test`, role: p.role });
      } else if (p.role === null) {
        const up = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/step-up',
          headers: as,
          payload: { password: 'correct horse battery' },
        });
        expect(up.statusCode, up.body).toBe(200);
        const made = await h.app.inject({
          method: 'POST',
          url: '/api/v1/members',
          headers: as,
          payload: { display_name: p.name },
        });
        expect(made.statusCode, made.body).toBe(201);
      }
    }
    const members = (await h.app.inject({ url: '/api/v1/members', headers: as })).json<{
      items: Array<{ id: string; display_name: string }>;
    }>().items;
    for (const p of people) {
      const m = members.find((x) => x.display_name === p.name);
      if (!m) throw new Error(`${p.name} is not in the family`);
      keyOf.set(m.id, p.key);
    }
    const types = (await h.app.inject({ url: '/api/v1/document-types', headers: as })).json<{
      items: DocumentTypeView[];
    }>().items;
    expiring = new Set(types.filter((t) => t.expiry_driver !== null).map((t) => t.key));
    thread = new w.ProposalThread();
  }, 300_000);

  afterAll(async () => {
    await thread?.close();
    await admin?.end();
    await h?.close();
  });

  /** The worker's own: drawing and reading, as its batch.previews job does, one item a turn. */
  const work = async () => {
    const deps = {
      admin,
      db: h.db,
      keys: new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
      credentialsKey: deriveKey(TEST_MASTER, 'vault-credentials'),
      localRoot: h.vaultDir,
      log: () => undefined,
    };
    for (;;) {
      const drawn = await w.drawNextBatchItem(deps, { household_id: hh });
      const read = await w.readNextBatchItem(deps, hh, { maxPages: 20, proposer: thread });
      if (!drawn.drawn && !read.read) return;
    }
  };

  /** The owner's sign-in renewed: a run outlasts an access token. */
  const fresh = async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: owner.refresh_token },
    });
    expect(res.statusCode, res.body).toBe(200);
    owner = { ...owner, ...res.json<Tokens>() };
    return h.as(owner);
  };

  /** One run: every file added to a batch of its own (with its folder, or none), read, and scored. */
  const run = async (name: string, withFolders: boolean) => {
    const corpus = corpora[name] as ReturnType<CorpusModule['smartCorpus']>;
    const started = Date.now();
    let as = await fresh();
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/batches',
      headers: as,
      payload: {},
    });
    expect(made.statusCode, made.body).toBe(201);
    const batch = made.json<BatchDetail>();
    const idOf = new Map<string, CorpusFile>();
    for (const [n, f] of corpus.files.entries()) {
      if (n > 0 && n % 50 === 0) as = await fresh();
      const form = new FormData();
      const folder = withFolders
        ? itemFolder(`${TOP}/${f.path}`, { withFileName: true, dropGenericTop: true })
        : null;
      if (folder) form.append('relative_path', folder);
      form.append('file', f.bytes, {
        filename: path.posix.basename(f.path),
        contentType: 'application/pdf',
      });
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/batches/${batch.id}/items`,
        headers: { ...as, ...form.getHeaders() },
        payload: form.getBuffer(),
      });
      expect(res.statusCode, `${f.path}: ${res.body}`).toBe(201);
      idOf.set(res.json<BatchItemView>().id, f);
    }
    const uploaded = Date.now();
    await work();
    const readAt = Date.now();
    as = await fresh();
    const got = await h.app.inject({ url: `/api/v1/batches/${batch.id}`, headers: as });
    expect(got.statusCode, got.body).toBe(200);
    const detail = got.json<BatchDetail>();
    const rows: Array<{ entry: SmartEntry; seen: SmartSeen; score: SmartScore }> = [];
    for (const item of detail.items) {
      const f = idOf.get(item.id);
      if (!f) continue;
      const p = item.proposals ?? null;
      const owner = p?.owner_member_id?.value;
      const seen: SmartSeen = {
        level: item.level ?? null,
        duplicate: item.duplicate !== null,
        failure: item.read_failure ?? null,
        kind: p?.type_key?.value ?? null,
        person: owner ? (keyOf.get(owner) ?? `unknown:${owner}`) : null,
        issued: p?.issued?.value.date ?? null,
        expires: p?.expires?.value.date ?? null,
        number: p?.identifier?.value ?? null,
        issuer: p?.issued_by?.value ?? null,
      };
      rows.push({ entry: f.entry, seen, score: scoreItem(f.entry, seen, (k) => expiring.has(k)) });
    }
    expect(rows).toHaveLength(corpus.files.length);
    const summary = summarise(rows);
    // Out of the way of the next run: its copies would be duplicates of these.
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/batches/${batch.id}`,
      headers: as,
    });
    expect(gone.statusCode, gone.body).toBe(204);
    return {
      summary,
      rows: rows.map(({ entry, seen, score }) => ({
        path: entry.path,
        set: entry.set,
        mode: entry.mode,
        truth: entry.truth,
        seen,
        misses: score.misses,
        ready_detail_wrong: score.readyDetailWrong,
      })),
      seconds: {
        upload: Math.round((uploaded - started) / 1000),
        read: Math.round((readAt - uploaded) / 1000),
      },
    };
  };

  it(
    'each corpus, with folders and without: no Ready one is wrong, and how many need typing',
    async () => {
      const results: Record<string, unknown> = {};
      const lines: string[] = [];
      const line = (name: string, s: SmartSummary) =>
        `${name.padEnd(24)} ${[
          'files',
          'ready',
          'check',
          'unrecognised',
          'problem',
          'unread',
          'manual',
          'wrong_ready',
          'ready_detail_wrong',
          'expiry_not_on_paper',
        ]
          .map((k) => `${k}=${s.all[k as keyof SmartSummary['all']]}`)
          .join(' ')}`;
      const wrong: number[] = [];
      for (const name of CORPORA) {
        const withFolders = await run(name, true);
        const without = await run(name, false);
        results[name] = {
          seed: SEED_OF[name],
          target_met: withFolders.summary.all.manual < 10,
          with_folders: withFolders,
          without_folders: without,
        };
        lines.push(
          line(`${name}, with folders`, withFolders.summary),
          line(`${name}, without folders`, without.summary),
          `${name} seconds: with ${JSON.stringify(withFolders.seconds)}, without ${JSON.stringify(without.seconds)}`,
        );
        wrong.push(withFolders.summary.all.wrong_ready, without.summary.all.wrong_ready);
      }
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
      console.log([...lines, `written to ${OUT}`].join('\n'));
      // The rule that matters most. How many need typing is recorded, not
      // asserted: the release records whatever it reaches (docs/smart-exit.md).
      expect(wrong.every((n) => n === 0)).toBe(true);
    },
    3 * 60 * 60_000,
  );
});
