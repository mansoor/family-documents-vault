import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  expiryLabelKinds,
  levelItem,
  localAiOffer,
  proposeOnThread,
  readLocalAiReply,
  scoreItem,
  summarise,
  type BatchDefaults,
  type DocumentTypeView,
  type ItemLevel,
  type LevelKind,
  type LocalAiOffer,
  type LocalAiReading,
  type ProposalContext,
  type ReadingModel,
  type SmartEntry,
  type SmartScore,
  type SmartSeen,
  type SmartSummary,
  type StoredLocalAi,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './test-harness.js';

/**
 * The local AI reader, measured (0.9.0, R4) — before and after, with the
 * switch on, on the synthetic sets: the Smart exit's tune and held-out sets,
 * R1's third set, and the R3 scan set's two splits.
 *
 * Each paper's words are the worker's own reading of it, recorded by R3's
 * runs (FDV_SMART_TEXT_CACHE, by the file's SHA-256; FDV_SCAN_SET_ROWS, the
 * scan set's rows): OCR is not run again. Each is proposed for as the
 * proposal thread does (`proposeOnThread`, with the vault's reading model,
 * R2, and no learned rules), the real local
 * AI asked as the worker asks it (its client, its prompt, its timeout) and
 * its reply read as the thread reads it (`readLocalAiReply`), and the card
 * levelled for the household's owner with no folder and no defaults, as the
 * Reading check levels it — once without the local AI and once with it — and
 * scored by the Smart exit's own scorer. A copy of another file is left out
 * (the batch would call it a Problem, a duplicate).
 *
 * Only with FDV_LOCAL_AI_MEASURE=1, FDV_LOCAL_AI_URL and FDV_LOCAL_AI_MODEL
 * (a real model: `docker run --rm -p 11434:11434 ollama/ollama`, a model
 * pulled into it). FDV_LOCAL_AI_SETS chooses the sets, FDV_LOCAL_AI_LIMIT the
 * most papers of each, FDV_LOCAL_AI_REPLIES keeps each reply (a JSON line by
 * the request's hash) so a run can be taken up again, and FDV_LOCAL_AI_OUT is
 * where it writes what it found. It fails on any wrong Ready with the switch on.
 */

const RUN = process.env.FDV_LOCAL_AI_MEASURE === '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = process.env.FDV_LOCAL_AI_OUT ?? path.join(tmpdir(), 'fdv-local-ai.json');
const SETS = (process.env.FDV_LOCAL_AI_SETS ?? 'second,third,scan-held-out,first,scan-tune')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LIMIT = Number(process.env.FDV_LOCAL_AI_LIMIT ?? '100000');
const REPLIES = process.env.FDV_LOCAL_AI_REPLIES ?? null;
const SEED_OF: Record<string, number> = { first: 1, second: 2, third: 3 };

interface CorpusFile {
  path: string;
  bytes: Buffer;
  entry: SmartEntry;
}
interface Corpus {
  household: { name: string; people: Array<{ key: string; name: string; role: string | null }> };
  files: CorpusFile[];
}
interface ScanRow {
  path: string;
  from: string;
  cause: string;
  truth: SmartEntry['truth'];
  text: string | null;
}
interface Paper {
  set: string;
  entry: SmartEntry;
  text: string | null;
  cause?: string;
}
type Answer =
  { state: 'replied'; body: string; ms: number } | { state: 'without'; why: string; ms: number };
interface Client {
  read(
    text: string,
    offer: LocalAiOffer,
    o: { priority: 'interactive' | 'check' },
  ): Promise<Answer>;
}

const load = async <T>(rel: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href)) as T;

const NO_DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: null,
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

describe.runIf(RUN && testAdminUrl())('the local AI reader, measured (R4)', () => {
  let h: Harness;
  let ctx: ProposalContext;
  let kinds: LevelKind[];
  let me: string;
  let expiring: Set<string>;
  let client: Client;
  /** The vault's reading model (R2), loaded as the worker loads it. */
  let readingModel: ReadingModel | null = null;
  const keyOf = new Map<string, string>();
  const papers: Paper[] = [];
  const replies = new Map<string, { body: string; ms: number }>();

  beforeAll(async () => {
    const corpusOf = await load<{ smartCorpus(o: { seed: number; corpus: string }): Corpus }>(
      'scripts/smart-corpus.mjs',
    );
    const cachePath = process.env.FDV_SMART_TEXT_CACHE;
    const cache = cachePath
      ? (JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { text: string } | null>)
      : {};
    const first = corpusOf.smartCorpus({ seed: 1, corpus: 'first' });
    for (const set of SETS) {
      let n = 0;
      if (SEED_OF[set]) {
        const c =
          set === 'first' ? first : corpusOf.smartCorpus({ seed: SEED_OF[set], corpus: set });
        for (const f of c.files) {
          if (n >= LIMIT) break;
          // A copy is the batch's Problem (a duplicate): left out here.
          if (f.entry.duplicate_of) continue;
          const sha = createHash('sha256').update(f.bytes).digest('hex');
          if (!(sha in cache)) continue;
          papers.push({ set, entry: f.entry, text: cache[sha]?.text ?? null });
          n += 1;
        }
      } else if (set.startsWith('scan-')) {
        const split = set.slice(5) as 'tune' | 'held-out';
        const rowsPath = process.env.FDV_SCAN_SET_ROWS;
        if (!rowsPath) throw new Error('FDV_SCAN_SET_ROWS is not set');
        const scan = JSON.parse(readFileSync(rowsPath, 'utf8')) as Record<
          string,
          { rows: ScanRow[] }
        >;
        for (const r of scan[split]?.rows ?? []) {
          if (n >= LIMIT) break;
          papers.push({
            set,
            cause: r.cause,
            text: r.text,
            entry: {
              path: r.path,
              paper: r.from,
              set: split,
              mode: 'scan',
              blank: false,
              duplicate_of: null,
              rescan_of: null,
              misfiled: false,
              folder: null,
              truth: r.truth,
            },
          });
          n += 1;
        }
      }
    }
    if (REPLIES && existsSync(REPLIES)) {
      for (const line of readFileSync(REPLIES, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as { key: string; body: string; ms: number };
        replies.set(r.key, { body: r.body, ms: r.ms });
      }
    }

    h = await createHarness({ rateLimitPerMinute: 100_000 });
    const people = first.household.people;
    const owner = await h.setup({
      display_name: people.find((p) => p.role === 'owner')?.name ?? 'Olivia',
      household_name: first.household.name,
    });
    const as = h.as(owner);
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: as,
      payload: { country: 'GB', timezone: 'Europe/London' },
    });
    for (const p of people) {
      if (p.role === 'adult' || p.role === 'teen') {
        await h.join(owner, { name: p.name, email: `${p.key}@local-ai.test`, role: p.role });
      } else if (p.role === null) {
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/step-up',
          headers: as,
          payload: { password: 'correct horse battery' },
        });
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/members',
          headers: as,
          payload: { display_name: p.name },
        });
      }
    }
    const members = (await h.app.inject({ url: '/api/v1/members', headers: as })).json<{
      items: Array<{ id: string; display_name: string }>;
    }>().items;
    for (const p of people) {
      const m = members.find((x) => x.display_name === p.name);
      if (m) keyOf.set(m.id, p.key);
    }
    me = owner.member_id;
    const types = (await h.app.inject({ url: '/api/v1/document-types', headers: as })).json<{
      items: DocumentTypeView[];
    }>().items;
    kinds = types.filter((t) => t.key !== 'note');
    expiring = new Set(types.filter((t) => t.expiry_driver !== null).map((t) => t.key));
    const w = await load<{
      proposalContext(trx: unknown, hh: string, memberId: string): Promise<ProposalContext>;
    }>('apps/worker/src/jobs/read-item.ts');
    ctx = await withSystem(h.db, owner.household_id, (trx) =>
      w.proposalContext(trx, owner.household_id, me),
    );
    readingModel = (
      await load<{ loadReadingModel(): { model: ReadingModel | null } }>(
        'apps/worker/src/reading-model.ts',
      )
    ).loadReadingModel().model;
    if (!readingModel) throw new Error('the reading model would not load');
    const ai = await load<{
      LocalAiClient: new (s: { url: URL; model: string; timeoutMs: number }) => Client;
    }>('apps/worker/src/local-ai.ts');
    client = new ai.LocalAiClient({
      url: new URL(process.env.FDV_LOCAL_AI_URL ?? 'http://127.0.0.1:11434'),
      model: process.env.FDV_LOCAL_AI_MODEL ?? 'qwen2.5:3b-instruct',
      timeoutMs: Number(process.env.FDV_LOCAL_AI_TIMEOUT_SECONDS ?? '300') * 1000,
    });
  }, 600_000);

  afterAll(async () => {
    await h?.close();
  });

  const seenOf = (lv: ItemLevel): SmartSeen => {
    const owner = lv.proposals?.owner_member_id?.value;
    return {
      level: lv.level,
      duplicate: false,
      failure: null,
      kind: lv.proposals?.type_key?.value ?? null,
      person: owner ? (keyOf.get(owner) ?? `unknown:${owner}`) : null,
      issued: lv.proposals?.issued?.value.date ?? null,
      expires: lv.proposals?.expires?.value.date ?? null,
      number: lv.proposals?.identifier?.value ?? null,
      issuer: lv.proposals?.issued_by?.value ?? null,
    };
  };

  it(
    'every set, before and after: no Ready one wrong with the switch on, and what it changes',
    async () => {
      const offer = localAiOffer(ctx, { role: 'owner', me });
      const model = process.env.FDV_LOCAL_AI_MODEL ?? 'qwen2.5:3b-instruct';
      type Row = {
        set: string;
        path: string;
        mode: string;
        cause?: string;
        before: SmartSeen;
        after: SmartSeen;
        score_before: SmartScore;
        score_after: SmartScore;
        ai: 'read' | 'without' | 'refused' | 'blank';
        ai_fields: string[];
        ai_tags: string[];
        ai_reading: LocalAiReading | null;
        ai_words: string[];
        ms: number | null;
      };
      const rows: Row[] = [];
      const started = Date.now();
      for (const [i, p] of papers.entries()) {
        const text = p.text ?? '';
        const blank = (text.match(/[\p{L}\p{N}]/gu) ?? []).length < 4;
        let before: ItemLevel;
        let after: ItemLevel;
        let aiState: Row['ai'] = 'blank';
        let fields: LocalAiReading | null = null;
        let ms: number | null = null;
        if (blank) {
          const failed = {
            state: 'waiting' as const,
            reading: 'failed' as const,
            failure: 'blank' as const,
            proposal: null,
            duplicate: null,
            defaults: NO_DEFAULTS,
            types: kinds,
            people: ctx.people,
            role: 'owner' as const,
            me,
          };
          before = levelItem(failed);
          after = before;
        } else {
          // The rules and the vault's reading model (R2, on unless an owner
          // turns it off), as the proposal thread reads a page.
          const got = proposeOnThread(text, ctx, null, readingModel);
          const base = {
            state: 'waiting' as const,
            reading: 'read' as const,
            failure: null,
            proposal: got.proposal,
            learnedClash: got.clash,
            expiryLabels: expiryLabelKinds(text, ctx),
            duplicate: null,
            defaults: NO_DEFAULTS,
            types: kinds,
            people: ctx.people,
            role: 'owner' as const,
            me,
          };
          before = levelItem(base);
          // By the model and the paper's words: the household — its kinds and
          // its family — is the same in every run.
          const key = createHash('sha256').update(`${model}\n${text}`).digest('hex');
          let answer: Answer;
          const kept = replies.get(key);
          if (kept) {
            answer = { state: 'replied', ...kept };
          } else {
            answer = await client.read(text, offer, { priority: 'interactive' });
            if (answer.state === 'replied' && REPLIES) {
              appendFileSync(
                REPLIES,
                `${JSON.stringify({ key, body: answer.body, ms: answer.ms })}\n`,
              );
              replies.set(key, { body: answer.body, ms: answer.ms });
            }
          }
          ms = answer.ms;
          let stored: StoredLocalAi = { state: 'without' };
          if (answer.state === 'replied') {
            const r = readLocalAiReply(answer.body, offer, text, ctx.dateOrder);
            if ('reading' in r) {
              fields = r.reading;
              stored = { state: 'read', fields };
              aiState = 'read';
            } else aiState = 'refused';
          } else aiState = 'without';
          after = levelItem({ ...base, localAi: stored });
        }
        const b = seenOf(before);
        const a = seenOf(after);
        const isExpiring = (k: string) => expiring.has(k);
        rows.push({
          set: p.set,
          path: p.entry.path,
          mode: p.entry.mode,
          ...(p.cause ? { cause: p.cause } : {}),
          before: b,
          after: a,
          score_before: scoreItem(p.entry, b, isExpiring),
          score_after: scoreItem(p.entry, a, isExpiring),
          ai: aiState,
          ai_fields: fields ? Object.keys(fields) : [],
          ai_tags: after.tags.filter((t) => t.code.includes('local_ai')).map((t) => t.code),
          // Made-up papers: what it read, and what the card said of it, kept to look at.
          ai_reading: fields,
          ai_words: after.tags.filter((t) => t.code.includes('local_ai')).map((t) => t.words),
          ms,
        });
        if ((i + 1) % 10 === 0) {
          console.log(
            `${i + 1}/${papers.length} papers, ${Math.round((Date.now() - started) / 1000)} s`,
          );
          writeFileSync(`${OUT}.partial`, JSON.stringify(rows));
        }
      }

      const results: Record<string, unknown> = {};
      const lines: string[] = [];
      const line = (name: string, s: SmartSummary) =>
        `${name.padEnd(28)} ${[
          'files',
          'ready',
          'check',
          'unrecognised',
          'problem',
          'manual',
          'wrong_ready',
          'ready_detail_wrong',
        ]
          .map((k) => `${k}=${s.all[k as keyof SmartSummary['all']]}`)
          .join(' ')}`;
      let wrongAfter = 0;
      for (const set of SETS) {
        const mine = rows.filter((r) => r.set === set);
        if (mine.length === 0) continue;
        const entryOf = (r: Row) =>
          papers.find((p) => p.set === r.set && p.entry.path === r.path)?.entry as SmartEntry;
        const before = summarise(
          mine.map((r) => ({ entry: entryOf(r), seen: r.before, score: r.score_before })),
        );
        const after = summarise(
          mine.map((r) => ({ entry: entryOf(r), seen: r.after, score: r.score_after })),
        );
        const times = mine
          .map((r) => r.ms)
          .filter((m): m is number => m !== null)
          .sort((x, y) => x - y);
        const at = (q: number) =>
          times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? null;
        const counts = {
          read: mine.filter((r) => r.ai === 'read').length,
          refused: mine.filter((r) => r.ai === 'refused').length,
          without: mine.filter((r) => r.ai === 'without').length,
          filled: mine.filter((r) => r.ai_tags.includes('local_ai')).length,
          clashed: mine.filter((r) => r.ai_tags.includes('clash_local_ai')).length,
          over_60s: times.filter((t) => t > 60_000).length,
          median_ms: at(0.5),
          p95_ms: at(0.95),
        };
        wrongAfter += after.all.wrong_ready;
        results[set] = { before: before.all, after: after.all, local_ai: counts };
        lines.push(
          line(`${set}, rules alone`, before),
          line(`${set}, with the local AI`, after),
          `${set} local AI: ${JSON.stringify(counts)}`,
        );
      }
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, `${JSON.stringify({ model, results, rows }, null, 1)}\n`);
      console.log([...lines, `written to ${OUT}`].join('\n'));
      // The rule that matters most: with the switch on, no Ready card wrong.
      expect(wrongAfter).toBe(0);
      // And never a Ready card that was not Ready by the rules alone.
      for (const r of rows) {
        if (r.after.level === 'ready') expect(r.before.level).toBe('ready');
      }
    },
    24 * 60 * 60_000,
  );
});
