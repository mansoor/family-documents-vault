import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { BatchDetail, BatchItemView, DocumentTypeView, Tokens } from '@fdv/shared';
import { scoreItem, type SmartEntry, type SmartSeen } from '@fdv/shared/testdata';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * Scans, measured (0.9.0, R3): the scan set (scripts/scan-corpus.mjs) — the
 * Smart exit's papers drawn again as turned, crooked, blurred, crushed,
 * grainy, low-resolution, shadowed, photographed, two-column and two-page
 * scans — each added to a batch with no folder, read by the worker's own
 * job (its reader, Tesseract and the proposal thread) and its card, as GET
 * /batches/{id} gives it, scored against the truth by the Smart exit's own
 * scorer. Reported for each split and each cause: Ready, Check, needs
 * typing and wrong Ready; how much of each page's words OCR found; whether
 * the date that matters was read, read with a character confused, or not
 * found; and the time each page took. Wrong Ready must be 0, and the test
 * fails on any.
 *
 * Only with FDV_SCAN_SET=1, where the worker's tools are (node:22-alpine
 * with poppler, ImageMagick and Tesseract; docs/smart-exit.md says how).
 * FDV_SCAN_SET_SPLITS (default "tune,held-out"), FDV_SCAN_SET_PER (papers
 * of each cause, default 12), FDV_SCAN_SET_DIR (a set written before by
 * the script, read rather than drawn again), FDV_SCAN_SET_OUT (the JSON it
 * writes). Since 0.9.0 (R2), FDV_SMART_TEXT_CACHE (each file's words by its
 * bytes' hash, kept between runs: its seconds are then the cache's, not
 * OCR's) and FDV_READING_MODEL=off (the household's reading model off,
 * through the API, for the "before").
 */

const RUN = process.env.FDV_SCAN_SET === '1';
const SPLITS = (process.env.FDV_SCAN_SET_SPLITS ?? 'tune,held-out')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s === 'tune' || s === 'held-out');
const PER = Number(process.env.FDV_SCAN_SET_PER ?? '12');
const DIR = process.env.FDV_SCAN_SET_DIR ?? null;
const OUT = process.env.FDV_SCAN_SET_OUT ?? path.join(tmpdir(), 'fdv-scan-set.json');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CACHE = process.env.FDV_SMART_TEXT_CACHE ?? null;
/** The household's reading model (R2): on, as a vault is, unless said. */
const READING_MODEL = process.env.FDV_READING_MODEL !== 'off';

type ScanEntry = SmartEntry & {
  mime: string;
  cause: string;
  pages: number;
  date_text: string | null;
  page_words: string[];
};
interface ScanFile {
  path: string;
  bytes: Buffer;
  entry: ScanEntry;
}
interface Extracted {
  text: string;
  source: string;
  textPages: number;
  ocrPages: number;
}
type Extract = (source: string, mime: string, o: unknown) => Promise<Extracted | null>;

const load = async <T>(rel: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href)) as T;

/** The set: as written before (FDV_SCAN_SET_DIR), or drawn now. */
async function scanFiles(split: string): Promise<ScanFile[]> {
  const manifest = DIR ? path.join(DIR, split, 'manifest.json') : null;
  if (manifest && existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { files: ScanEntry[] };
    return m.files.map((entry) => ({
      path: entry.path,
      bytes: readFileSync(path.join(DIR as string, split, ...entry.path.split('/'))),
      entry,
    }));
  }
  const made = await load<{
    scanSet(o: { split: string; per: number }): { files: ScanFile[] };
  }>('scripts/scan-corpus.mjs');
  return made.scanSet({ split, per: PER }).files;
}

/** Letters and digits only, lower case: how a date or a word is looked for in OCR's text. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** The same, with the characters OCR confuses with digits made digits. */
const folded = (s: string) =>
  s
    .replace(/[Oo]/g, '0')
    .replace(/[lI|!]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Whether the date that matters is in what was read: as written, with a confusion, or not at all. */
function dateState(text: string, date: string | null): 'none' | 'read' | 'confused' | 'missing' {
  if (!date) return 'none';
  if (squash(text).includes(squash(date))) return 'read';
  if (folded(text).includes(folded(date))) return 'confused';
  return 'missing';
}

/** The share of the page's words that OCR found. */
const recall = (text: string, words: string[]) => {
  if (words.length === 0) return 1;
  const found = new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  return words.filter((w) => found.has(w)).length / words.length;
};

const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};

interface Tally {
  files: number;
  ready: number;
  check: number;
  unrecognised: number;
  problem: number;
  manual: number;
  wrong_ready: number;
  no_words: number;
  date_read: number;
  date_confused: number;
  date_missing: number;
  recall: number;
}
const tally = (): Tally => ({
  files: 0,
  ready: 0,
  check: 0,
  unrecognised: 0,
  problem: 0,
  manual: 0,
  wrong_ready: 0,
  no_words: 0,
  date_read: 0,
  date_confused: 0,
  date_missing: 0,
  recall: 0,
});

describe.runIf(RUN && testAdminUrl())('scans, measured (R3)', () => {
  let w: {
    readNextBatchItem(
      deps: unknown,
      hh: string,
      opts: { maxPages: number; proposer: unknown; extract: Extract },
    ): Promise<{ read: string | null }>;
    ProposalThread: new () => { close(): Promise<void> };
    detectTools(): Promise<Record<string, boolean>>;
    extractText: Extract;
  };
  let thread: { close(): Promise<void> };
  /** Each file's words, by its bytes' hash (FDV_SMART_TEXT_CACHE). */
  const texts = new Map<string, Extracted | null>();

  beforeAll(async () => {
    if (CACHE && existsSync(CACHE)) {
      for (const [k, v] of Object.entries(
        JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, Extracted | null>,
      )) {
        texts.set(k, v);
      }
    }
    w = {
      ...(await load<Pick<typeof w, 'readNextBatchItem'>>('apps/worker/src/jobs/read-item.ts')),
      ...(await load<Pick<typeof w, 'ProposalThread'>>('apps/worker/src/jobs/proposal-thread.ts')),
      ...(await load<Pick<typeof w, 'detectTools'>>('apps/worker/src/jobs/tools.ts')),
      ...(await load<Pick<typeof w, 'extractText'>>('apps/worker/src/jobs/extract-text.ts')),
    };
    const tools = await w.detectTools();
    if (!tools.pdftotext || !tools.pdftoppm || !tools.tesseract || !tools.magick) {
      throw new Error(`the worker's tools are not all here: ${JSON.stringify(tools)}`);
    }
    thread = new w.ProposalThread();
  }, 300_000);

  afterAll(async () => {
    await thread?.close();
  });

  const run = async (split: string) => {
    const files = await scanFiles(split);
    const h: Harness = await createHarness({ rateLimitPerMinute: 100_000 });
    const admin = createPool(h.adminUrl, 2);
    try {
      let owner = await h.setup({ display_name: 'Olivia', household_name: 'The Khan family' });
      const hh = owner.household_id;
      let as = h.as(owner);
      let signedAt = Date.now();
      const call = (method: string, url: string, payload?: unknown) =>
        h.app.inject({
          method: method as 'GET',
          url,
          headers: as,
          ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
        });
      const fresh = async () => {
        const res = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          payload: { refresh_token: owner.refresh_token },
        });
        expect(res.statusCode, res.body).toBe(200);
        owner = { ...owner, ...res.json<Tokens>() };
        as = h.as(owner);
        signedAt = Date.now();
      };
      expect(
        (await call('PUT', '/api/v1/profile', { country: 'GB', timezone: 'Europe/London' }))
          .statusCode,
      ).toBe(200);
      // The vault's reading model (R2), off for the "before".
      expect(
        (await call('PUT', '/api/v1/household/reading', { reading_model: READING_MODEL }))
          .statusCode,
      ).toBe(200);
      const people = [
        { key: 'olivia', name: 'Olivia', role: 'owner' },
        { key: 'ahmed', name: 'Ahmed', role: 'adult' },
        { key: 'tariq', name: 'Tariq', role: 'teen' },
        { key: 'maryam', name: 'Maryam', role: null },
        { key: 'farida', name: 'Granny Farida', role: null },
      ] as const;
      for (const p of people) {
        if (p.role === 'adult' || p.role === 'teen') {
          await h.join(owner, { name: p.name, email: `${p.key}@scan-set.test`, role: p.role });
        } else if (p.role === null) {
          expect(
            (await call('POST', '/api/v1/auth/step-up', { password: 'correct horse battery' }))
              .statusCode,
          ).toBe(200);
          expect((await call('POST', '/api/v1/members', { display_name: p.name })).statusCode).toBe(
            201,
          );
        }
      }
      const members = (await call('GET', '/api/v1/members')).json<{
        items: Array<{ id: string; display_name: string }>;
      }>().items;
      const keyOf = new Map<string, string>();
      for (const p of people) {
        const m = members.find((x) => x.display_name === p.name);
        if (!m) throw new Error(`${p.name} is not in the family`);
        keyOf.set(m.id, p.key);
      }
      const types = (await call('GET', '/api/v1/document-types')).json<{
        items: DocumentTypeView[];
      }>().items;
      const expiring = new Set(types.filter((t) => t.expiry_driver !== null).map((t) => t.key));
      const made = await call('POST', '/api/v1/batches', {});
      expect(made.statusCode, made.body).toBe(201);
      const batch = made.json<BatchDetail>();
      const deps = {
        admin,
        db: h.db,
        keys: new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
        credentialsKey: deriveKey(TEST_MASTER, 'vault-credentials'),
        localRoot: h.vaultDir,
        log: () => undefined,
      };
      let last: { text: string; seconds: number; pages: number } | null = null;
      const extract: Extract = async (source, mime, o) => {
        const started = process.hrtime.bigint();
        const sha = createHash('sha256').update(readFileSync(source)).digest('hex');
        const got = texts.has(sha)
          ? (texts.get(sha) ?? null)
          : await w.extractText(source, mime, o);
        texts.set(sha, got);
        last = {
          text: got?.text ?? '',
          seconds: Number(process.hrtime.bigint() - started) / 1e9,
          pages: Math.max(1, (got?.ocrPages ?? 0) + (got?.textPages ?? 0)),
        };
        return got;
      };
      const all = tally();
      const byCause = new Map<string, Tally>();
      const perPage: number[] = [];
      const perPageBy = new Map<string, number[]>();
      const rows: unknown[] = [];
      for (const f of files) {
        // The sign-in renewed every few minutes: on a busy machine 40 files outlast it.
        if (Date.now() - signedAt > 4 * 60_000) await fresh();
        const form = new FormData();
        form.append('file', f.bytes, {
          filename: path.posix.basename(f.path),
          contentType: f.entry.mime,
        });
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/v1/batches/${batch.id}/items`,
          headers: { ...as, ...form.getHeaders() },
          payload: form.getBuffer(),
        });
        expect(res.statusCode, `${f.path}: ${res.body}`).toBe(201);
        const id = res.json<BatchItemView>().id;
        // Read after its preview, which teaches nothing: none is drawn here.
        await admin.query(
          "update incoming_file set preview_state = 'ready', preview_pages = 1 where id = $1",
          [id],
        );
        last = null;
        const read = await w.readNextBatchItem(deps, hh, {
          maxPages: 20,
          proposer: thread,
          extract,
        });
        expect(read.read, f.path).toBe(id);
        const got = await call('GET', `/api/v1/batches/${batch.id}`);
        expect(got.statusCode, got.body).toBe(200);
        const item = got.json<BatchDetail>().items.find((i) => i.id === id) as BatchItemView;
        const p = item.proposals ?? null;
        const ownerId = p?.owner_member_id?.value;
        const seen: SmartSeen = {
          level: item.level ?? null,
          duplicate: item.duplicate !== null,
          failure: item.read_failure ?? null,
          kind: p?.type_key?.value ?? null,
          person: ownerId ? (keyOf.get(ownerId) ?? `unknown:${ownerId}`) : null,
          issued: p?.issued?.value.date ?? null,
          expires: p?.expires?.value.date ?? null,
          number: p?.identifier?.value ?? null,
          issuer: p?.issued_by?.value ?? null,
        };
        const score = scoreItem(f.entry, seen, (k) => expiring.has(k));
        const read2 = last as { text: string; seconds: number; pages: number } | null;
        const text = read2?.text ?? '';
        const date = dateState(text, f.entry.date_text);
        const found = recall(text, f.entry.page_words);
        const noWords = (text.match(/[\p{L}\p{N}]/gu) ?? []).length < 4;
        const cause = f.entry.cause;
        if (!byCause.has(cause)) byCause.set(cause, tally());
        for (const t of [all, byCause.get(cause) as Tally]) {
          t.files += 1;
          if (seen.level === 'ready') t.ready += 1;
          if (seen.level === 'check') t.check += 1;
          if (seen.level === 'unrecognised') t.unrecognised += 1;
          if (seen.level === 'problem') t.problem += 1;
          if (score.manual) t.manual += 1;
          if (score.wrongReady) t.wrong_ready += 1;
          if (noWords) t.no_words += 1;
          if (date === 'read') t.date_read += 1;
          if (date === 'confused') t.date_confused += 1;
          if (date === 'missing') t.date_missing += 1;
          t.recall += found;
        }
        if (read2) {
          const s = read2.seconds / read2.pages;
          perPage.push(s);
          if (!perPageBy.has(cause)) perPageBy.set(cause, []);
          perPageBy.get(cause)?.push(s);
        }
        rows.push({
          path: f.path,
          from: (f.entry as unknown as { from: string }).from,
          cause,
          kind: f.entry.truth.kind,
          level: seen.level,
          failure: seen.failure,
          misses: score.misses,
          wrong_ready: score.wrongReady,
          ready_detail_wrong: score.readyDetailWrong,
          truth: f.entry.truth,
          seen,
          date,
          recall: Math.round(found * 100) / 100,
          seconds: read2 ? Math.round(read2.seconds * 10) / 10 : null,
          pages: read2?.pages ?? null,
          text: process.env.FDV_SCAN_SET_TEXTS === '1' ? text : undefined,
        });
      }
      const finish = (t: Tally) => ({
        ...t,
        recall: Math.round((t.recall / Math.max(1, t.files)) * 100) / 100,
      });
      const time = (xs: number[]) => ({
        median: Math.round(quantile(xs, 0.5) * 10) / 10,
        p95: Math.round(quantile(xs, 0.95) * 10) / 10,
      });
      return {
        all: finish(all),
        causes: Object.fromEntries(
          [...byCause.entries()].map(([c, t]) => [
            c,
            { ...finish(t), seconds: time(perPageBy.get(c) ?? []) },
          ]),
        ),
        seconds_per_page: time(perPage),
        rows,
      };
    } finally {
      await admin.end();
      await h.close();
    }
  };

  it(
    'each split, cause by cause: no Ready one is wrong',
    async () => {
      const results: Record<string, unknown> = {};
      const wrong: number[] = [];
      for (const split of SPLITS) {
        const started = Date.now();
        const r = await run(split);
        results[split] = { ...r, seconds: Math.round((Date.now() - started) / 1000) };
        wrong.push(r.all.wrong_ready);
        results.reading_model = READING_MODEL ? 'on' : 'off';
        mkdirSync(path.dirname(OUT), { recursive: true });
        writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
        if (CACHE) writeFileSync(CACHE, JSON.stringify(Object.fromEntries(texts)));
        const line = (name: string, t: Record<string, unknown>) =>
          `${name.padEnd(18)} ${[
            'files',
            'ready',
            'check',
            'unrecognised',
            'problem',
            'manual',
            'wrong_ready',
            'no_words',
            'date_read',
            'date_confused',
            'date_missing',
            'recall',
          ]
            .map((k) => `${k}=${String(t[k])}`)
            .join(' ')} ${t.seconds ? `s/page=${JSON.stringify(t.seconds)}` : ''}`;
        console.log(
          [
            line(`${split} all`, { ...r.all, seconds: r.seconds_per_page }),
            ...Object.entries(r.causes).map(([c, t]) => line(`  ${c}`, t)),
          ].join('\n'),
        );
      }
      console.log(`written to ${OUT}`);
      expect(wrong.every((n) => n === 0)).toBe(true);
    },
    6 * 60 * 60_000,
  );
});
