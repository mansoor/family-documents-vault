import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  itemFolder,
  learnedIssuerKey,
  untouchedAccept,
  type BatchDetail,
  type BatchItemView,
  type DocumentTypeView,
  type Tokens,
} from '@fdv/shared';
import { scoreItem, type SmartEntry, type SmartSeen } from '@fdv/shared/testdata';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * The vault learns each sender's papers from your corrections (0.9.0, R1),
 * measured: a learning simulation over the Smart exit's corpora
 * (scripts/smart-corpus.mjs, the first set and the held-out second).
 *
 * The papers arrive one at a time, in date order (so in date order for each
 * sender), into one batch, as a family's post does. Each is read by the
 * worker's own job — the PDF's text, Tesseract for a scan, the
 * proposal thread, the uploader's rules (I4) and shapes (R1) — and its card,
 * as GET /batches/{id} gives it at that moment, is scored against the truth
 * (@fdv/shared/testdata, smart-exit.ts). Only then is it accepted as a person
 * would accept it: with whatever the card got wrong corrected (the truth
 * sent for every field the kind keeps), which teaches the vault. A paper of
 * no kind, a blank page and a copy the card calls a duplicate are removed.
 * So each paper is scored on what only the papers before it taught.
 *
 * Each corpus, with folders and without, three ways:
 *   - `none`: nothing learned (Forget all before each paper) — the reading alone;
 *   - `rules`: I4's issuer rules alone (the shapes removed before each paper);
 *   - `shapes`: I4's rules and R1's shapes: 0.9.0 as it is.
 * Reported for the first paper from each sender, papers 2–3, and paper 4 and
 * later (a paper naming no sender is a first). Wrong Ready must be 0
 * throughout, and the test fails on any.
 *
 * Only with FDV_SMART_LEARNING=1, where the worker's tools are (node:22-alpine
 * with poppler, ImageMagick and Tesseract; docs/smart-exit.md says how). Each
 * file's words are read with the real tools once, and kept for the other
 * runs of the same bytes (and in FDV_SMART_TEXT_CACHE, if given). It writes
 * what it found to FDV_SMART_LEARNING_OUT.
 */

const RUN = process.env.FDV_SMART_LEARNING === '1';
const CORPORA = (process.env.FDV_SMART_EXIT_CORPORA ?? 'first,second,third')
  .split(',')
  .map((c) => c.trim())
  .filter(
    (c): c is 'first' | 'second' | 'third' => c === 'first' || c === 'second' || c === 'third',
  );
const MODES = (process.env.FDV_SMART_LEARNING_MODES ?? 'none,rules,shapes,careless,ready-all')
  .split(',')
  .map((m) => m.trim())
  .filter((m): m is Mode => ['none', 'rules', 'shapes', 'careless', 'ready-all'].includes(m));
const SEED_OF = { first: 1, second: 2, third: 3 } as const;
/** In a careless run, this share of cards are accepted as shown, right or wrong (the R1 review, W2). */
const CARELESS = 0.2;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = process.env.FDV_SMART_LEARNING_OUT ?? path.join(tmpdir(), 'fdv-smart-learning.json');
const CACHE = process.env.FDV_SMART_TEXT_CACHE ?? null;
/** The household's reading model (0.9.0, R2): on, as a vault is, unless FDV_READING_MODEL=off. */
const READING_MODEL = process.env.FDV_READING_MODEL !== 'off';
const TOP = 'Family papers';

/**
 * - `careless`: as `shapes`, but a share of the cards (CARELESS, chosen by
 *   each file's path) are accepted as shown, whatever they got wrong;
 * - `ready-all`: as `shapes`, but a card at Ready is filed by Accept all
 *   Ready (which teaches no shape), the rest as a person would.
 * Both run with folders only.
 */
type Mode = 'none' | 'rules' | 'shapes' | 'careless' | 'ready-all';

/** A file's own number from 0 to 1, the same every run (FNV-1a of its path). */
const shareOf = (p: string) => {
  let h = 2166136261;
  for (const c of p) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h / 4294967296;
};
type Bucket = 'first' | 'second_third' | 'fourth_on';

interface CorpusFile {
  path: string;
  bytes: Buffer;
  entry: SmartEntry;
}
interface Corpus {
  household: { name: string; people: Array<{ key: string; name: string; role: string | null }> };
  files: CorpusFile[];
}
interface Extracted {
  text: string;
  source: string;
  textPages: number;
  ocrPages: number;
}
type Extract = (source: string, mime: string, o: unknown) => Promise<Extracted | null>;
interface WorkerModules {
  readNextBatchItem(
    deps: unknown,
    hh: string,
    opts: { maxPages: number; proposer: unknown; extract: Extract },
  ): Promise<{ read: string | null }>;
  ProposalThread: new () => { close(): Promise<void> };
  detectTools(): Promise<Record<string, boolean>>;
  extractText: Extract;
}

const load = async <T>(rel: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href)) as T;

/** The counts of one bucket. */
interface Counts {
  files: number;
  ready: number;
  manual: number;
  wrong_ready: number;
  /** Cards where a sender's layout suggested something (R1). */
  shaped: number;
}
const empty = (): Counts => ({ files: 0, ready: 0, manual: 0, wrong_ready: 0, shaped: 0 });

describe.runIf(RUN && testAdminUrl())('learning each sender’s papers, measured (R1)', () => {
  let w: WorkerModules;
  let thread: { close(): Promise<void> };
  let corpora: Record<string, Corpus>;
  /** Each file's words, read once with the real tools, by its bytes' hash. */
  const texts = new Map<string, Extracted | null>();

  beforeAll(async () => {
    const made = await load<{ smartCorpus(o: { seed: number; corpus: string }): Corpus }>(
      'scripts/smart-corpus.mjs',
    );
    corpora = Object.fromEntries(
      CORPORA.map((c) => [c, made.smartCorpus({ seed: SEED_OF[c], corpus: c })]),
    );
    w = {
      ...(await load<Pick<WorkerModules, 'readNextBatchItem'>>(
        'apps/worker/src/jobs/read-item.ts',
      )),
      ...(await load<Pick<WorkerModules, 'ProposalThread'>>(
        'apps/worker/src/jobs/proposal-thread.ts',
      )),
      ...(await load<Pick<WorkerModules, 'detectTools'>>('apps/worker/src/jobs/tools.ts')),
      ...(await load<Pick<WorkerModules, 'extractText'>>('apps/worker/src/jobs/extract-text.ts')),
    };
    const tools = await w.detectTools();
    if (!tools.pdftotext || !tools.pdftoppm || !tools.tesseract) {
      throw new Error(`the worker's tools are not all here: ${JSON.stringify(tools)}`);
    }
    if (CACHE && existsSync(CACHE)) {
      for (const [k, v] of Object.entries(
        JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, Extracted | null>,
      )) {
        texts.set(k, v);
      }
    }
    thread = new w.ProposalThread();
  }, 300_000);

  afterAll(async () => {
    await thread?.close();
  });

  /** The worker's own reading, each file's words read with the real tools once. */
  const extract: Extract = async (source, mime, o) => {
    const sha = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    if (!texts.has(sha)) texts.set(sha, await w.extractText(source, mime, o));
    return texts.get(sha) ?? null;
  };

  /** One run: a vault of its own, the papers in date order, each read, scored, and accepted. */
  const run = async (name: string, withFolders: boolean, mode: Mode) => {
    const corpus = corpora[name] as Corpus;
    const h: Harness = await createHarness({ rateLimitPerMinute: 100_000 });
    const admin = createPool(h.adminUrl, 2);
    try {
      const people = corpus.household.people;
      let owner = await h.setup({
        display_name: people.find((p) => p.role === 'owner')?.name ?? 'Olivia',
        household_name: corpus.household.name,
      });
      const hh = owner.household_id;
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
      let as = h.as(owner);
      const call = async (method: string, url: string, payload?: unknown) =>
        h.app.inject({
          method: method as 'GET',
          url,
          headers: as,
          ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
        });
      expect(
        (await call('PUT', '/api/v1/profile', { country: 'GB', timezone: 'Europe/London' }))
          .statusCode,
      ).toBe(200);
      // The vault's reading model (R2), off for the "before".
      expect(
        (await call('PUT', '/api/v1/household/reading', { reading_model: READING_MODEL }))
          .statusCode,
      ).toBe(200);
      for (const p of people) {
        if (p.role === 'adult' || p.role === 'teen') {
          await h.join(owner, {
            name: p.name,
            email: `${p.key}@smart-learning.test`,
            role: p.role,
          });
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
      const idOfKey = new Map<string, string>();
      const keyOf = new Map<string, string>();
      for (const p of people) {
        const m = members.find((x) => x.display_name === p.name);
        if (!m) throw new Error(`${p.name} is not in the family`);
        idOfKey.set(p.key, m.id);
        keyOf.set(m.id, p.key);
      }
      const types = (await call('GET', '/api/v1/document-types')).json<{
        items: DocumentTypeView[];
      }>().items;
      const expiring = new Set(types.filter((t) => t.expiry_driver !== null).map((t) => t.key));

      // The papers in the order they came: by their date, then where they are.
      const dated = (e: SmartEntry) => e.truth.issued ?? e.truth.expires ?? '2026-10-01';
      const files = [...corpus.files].sort(
        (a, b) => dated(a.entry).localeCompare(dated(b.entry)) || a.path.localeCompare(b.path),
      );
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
      /** One paper arriving: added to the batch, with its folder or none. */
      const arrive = async (f: CorpusFile) => {
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
        const id = res.json<BatchItemView>().id;
        // Its pages are read after its preview is drawn; a preview teaches
        // nothing, so none is drawn here (the reading draws its own pages
        // for OCR, with the real tools, as the worker does).
        await admin.query(
          "update incoming_file set preview_state = 'ready', preview_pages = 1 where id = $1",
          [id],
        );
        return id;
      };

      const seenFrom = new Map<string, number>();
      const buckets: Record<Bucket, Counts> = {
        first: empty(),
        second_third: empty(),
        fourth_on: empty(),
      };
      const all = empty();
      const rows: unknown[] = [];
      const failed: string[] = [];
      for (const [n, f] of files.entries()) {
        if (n > 0 && n % 40 === 0) as = await fresh();
        const id = await arrive(f);
        if (mode === 'none') {
          expect((await call('DELETE', '/api/v1/batches/learned')).statusCode).toBe(204);
          // (A careless or ready-all run learns as `shapes` does: from what it is given.)
        } else if (mode === 'rules') {
          await admin.query('delete from intake_shape where household_id = $1', [hh]);
        }
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
        const sender = learnedIssuerKey(f.entry.truth.issuer);
        const nth = sender ? (seenFrom.get(sender) ?? 0) + 1 : 1;
        if (sender) seenFrom.set(sender, nth);
        const bucket: Bucket = nth === 1 ? 'first' : nth <= 3 ? 'second_third' : 'fourth_on';
        const shaped = Object.values(p ?? {}).some(
          (s) => !!s && typeof s === 'object' && (s as { shape?: boolean }).shape === true,
        );
        for (const c of [buckets[bucket], all]) {
          c.files += 1;
          if (seen.level === 'ready') c.ready += 1;
          if (score.manual) c.manual += 1;
          if (score.wrongReady) c.wrong_ready += 1;
          if (shaped) c.shaped += 1;
        }
        rows.push({
          path: f.path,
          sender,
          nth,
          level: seen.level,
          tags: (item.tags ?? []).map((t) => t.code),
          misses: score.misses,
          wrong_ready: score.wrongReady,
          shaped,
          // A wrong Ready, explained: its card, and what was learned of its sender.
          ...(score.wrongReady
            ? {
                proposals: p,
                learned: await (async () => {
                  const l = (await call('GET', '/api/v1/batches/learned')).json<{
                    rules: Array<{ issuer: string }>;
                    shapes?: Array<{ issuer: string }>;
                  }>();
                  return {
                    rules: l.rules.filter((r) => r.issuer === sender),
                    shapes: (l.shapes ?? []).filter((s) => s.issuer === sender),
                  };
                })(),
              }
            : {}),
        });

        // Then as a person would: removed, or filed with what the card got wrong put right.
        const t = f.entry.truth;
        const remove =
          f.entry.blank || t.kind === null || (seen.level === 'problem' && seen.duplicate);
        let filed = false;
        if (!remove && mode === 'ready-all' && seen.level === 'ready') {
          const res = await call('POST', `/api/v1/batches/${batch.id}/accept-ready`, {
            item_ids: [id],
          });
          filed =
            res.statusCode === 200 &&
            res.json<{ accepted: Array<{ item_id: string }> }>().accepted.length === 1;
          if (!filed) failed.push(`${f.path}: accept-ready ${res.statusCode}`);
        } else if (!remove && mode === 'careless' && p && shareOf(f.path) < CARELESS) {
          // Accepted as shown, right or wrong.
          const shown = untouchedAccept({
            proposals: p,
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
            people: members,
            role: 'owner',
            me: owner.member_id,
          });
          const res = await call('POST', `/api/v1/batches/${batch.id}/items/${id}/accept`, {
            ...shown,
            title: null,
          });
          // A card that cannot be filed as shown (no kind, say) is put right below.
          filed = res.statusCode === 201;
        }
        if (!remove && !filed) {
          const kind = types.find((k) => k.key === t.kind);
          const shows = (field: 'issued' | 'identifier' | 'issued_by') =>
            kind?.core?.[field]?.shown !== false;
          const base = p
            ? untouchedAccept({
                proposals: p,
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
                people: members,
                role: 'owner',
                me: owner.member_id,
              })
            : {};
          const day = (d: string | null) => (d ? { date: d, precision: 'day' as const } : null);
          const body: Record<string, unknown> = {
            ...base,
            title: null,
            type_key: t.kind,
            owner_member_id: t.person ? (idOfKey.get(t.person) ?? null) : null,
          };
          delete body.issued;
          delete body.expires;
          delete body.identifier;
          delete body.issued_by;
          if (shows('issued_by')) body.issued_by = t.issuer;
          if (shows('identifier')) body.identifier = t.number;
          if (shows('issued')) body.issued = day(t.issued);
          if (kind?.expiry_driver) body.expires = day(t.expires);
          const res = await call('POST', `/api/v1/batches/${batch.id}/items/${id}/accept`, body);
          filed = res.statusCode === 201;
          if (!filed) failed.push(`${f.path}: ${res.statusCode} ${res.body.slice(0, 160)}`);
        }
        if (!filed) {
          const gone = await call('DELETE', `/api/v1/batches/${batch.id}/items/${id}`);
          expect(gone.statusCode, gone.body).toBe(204);
        }
      }
      return { buckets, all, rows, failed };
    } finally {
      await admin.end();
      await h.close();
    }
  };

  it(
    'each corpus, with folders and without, learning nothing, rules, shapes, carelessly and by Accept all Ready: no Ready one is wrong',
    async () => {
      const results: Record<string, unknown> = {};
      const lines: string[] = [];
      const wrong: number[] = [];
      for (const name of CORPORA) {
        for (const withFolders of [true, false]) {
          for (const mode of MODES) {
            if (!withFolders && (mode === 'careless' || mode === 'ready-all')) continue;
            const started = Date.now();
            const r = await run(name, withFolders, mode);
            const key = `${name}/${withFolders ? 'folders' : 'no-folders'}/${mode}`;
            results[key] = { ...r, seconds: Math.round((Date.now() - started) / 1000) };
            const cell = (c: Counts) =>
              `${c.manual}/${c.files} typing, ${c.wrong_ready} wrong Ready, ${c.ready} Ready, ${c.shaped} shaped`;
            lines.push(
              `${key.padEnd(30)} first ${cell(r.buckets.first)} | 2-3 ${cell(r.buckets.second_third)} | 4+ ${cell(r.buckets.fourth_on)} | all ${cell(r.all)}${r.failed.length ? ` | ${r.failed.length} not accepted` : ''}`,
            );
            wrong.push(r.all.wrong_ready);
            mkdirSync(path.dirname(OUT), { recursive: true });
            writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
            if (CACHE) writeFileSync(CACHE, JSON.stringify(Object.fromEntries(texts)));
            console.log(lines.at(-1));
          }
        }
      }
      results.reading_model = READING_MODEL ? 'on' : 'off';
      writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
      console.log(
        [...lines, `reading model ${READING_MODEL ? 'on' : 'off'}`, `written to ${OUT}`].join('\n'),
      );
      expect(wrong.every((n) => n === 0)).toBe(true);
    },
    6 * 60 * 60_000,
  );
});
