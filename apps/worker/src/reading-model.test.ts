import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { proposeOnThread, type ProposalContext } from '@fdv/shared';
import { FIXTURE_KINDS, FIXTURE_PEOPLE } from '@fdv/shared/testdata';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ProposalThread } from './jobs/proposal-thread.js';
import {
  defaultReadingModelFile,
  keepRecordingReadingModel,
  loadReadingModel,
  READING_MODEL_SHA256,
  recordReadingModel,
} from './reading-model.js';

/**
 * The reading model's weights in the worker (0.9.0, R2): held to their
 * hash; a file missing, cut short or changed is not used — the rules read
 * alone, and the worker says so — and the household's switch reaches the
 * thread. And what it costs a page.
 */

const CTX: ProposalContext = {
  types: FIXTURE_KINDS,
  people: FIXTURE_PEOPLE,
  household: 'The Khan family',
  dateOrder: 'dmy',
};
/** A page the rules find no kind on, and the model reads as a pet's record. */
const VET = [
  'Larkfield Animal Clinic',
  'Mabel has been seen today',
  'Annual booster given today',
  'Booster due: 14/03/2027',
  'Owner: Sara Khan',
  'Consultation £68.00',
].join('\n');

const dir = mkdtempSync(path.join(tmpdir(), 'fdv-reading-model-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const real = () => readFileSync(defaultReadingModelFile());
const spoilt = (name: string, bytes: Buffer) => {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
};

describe('the weights, held to their hash', () => {
  it('the file beside the worker is the one this release holds, and loads', () => {
    expect(createHash('sha256').update(real()).digest('hex')).toBe(READING_MODEL_SHA256);
    const got = loadReadingModel();
    expect(got.state).toBe('loaded');
    expect(got.model?.classes).toContain('passport');
  });

  it('missing, changed by a byte, cut short or something else: not used, and why', () => {
    expect(loadReadingModel(path.join(dir, 'not-there.bin'))).toMatchObject({
      model: null,
      state: 'missing',
    });
    const one = Buffer.from(real());
    one[one.length - 1] = (one[one.length - 1] as number) ^ 1;
    expect(loadReadingModel(spoilt('changed.bin', one))).toMatchObject({
      model: null,
      state: 'corrupt',
      detail: 'not the file this release was built with',
    });
    expect(loadReadingModel(spoilt('short.bin', real().subarray(0, 4096)))).toMatchObject({
      model: null,
      state: 'corrupt',
    });
    expect(loadReadingModel(spoilt('empty.bin', Buffer.alloc(0)))).toMatchObject({
      model: null,
      state: 'corrupt',
    });
    // The right bytes held to another hash: refused, as a file swapped would be.
    expect(loadReadingModel(defaultReadingModelFile(), '0'.repeat(64)).state).toBe('corrupt');
    // A spoilt file that is somehow its own hash is still read strictly.
    const junk = Buffer.from('FDVRM001 not really');
    expect(
      loadReadingModel(spoilt('junk.bin', junk), createHash('sha256').update(junk).digest('hex'))
        .state,
    ).toBe('corrupt');
  });
});

describe('on the thread', () => {
  it('with the weights, a kind the rules found none for is suggested; switched off, it is not', async () => {
    const thread = new ProposalThread();
    try {
      const on = await thread.propose(VET, CTX);
      expect(thread.model).toBe('loaded');
      expect(on).toMatchObject({
        state: 'done',
        proposal: { type_key: { value: 'pet_record', model: 'alone' } },
      });
      const off = await thread.propose(VET, { ...CTX, readingModel: false });
      expect(off.state).toBe('done');
      expect(off.state === 'done' && off.proposal.type_key).toBeFalsy();
    } finally {
      await thread.close();
    }
  });

  it('a file missing or spoilt: the rules read alone, and the worker says so', async () => {
    const warnings: string[] = [];
    const listen = (w: Error) => warnings.push(w.message);
    process.on('warning', listen);
    try {
      for (const [file, state] of [
        [path.join(dir, 'gone.bin'), 'missing'],
        [spoilt('half.bin', real().subarray(0, 100_000)), 'corrupt'],
      ] as const) {
        const thread = new ProposalThread({ modelFile: file });
        try {
          const got = await thread.propose(VET, CTX);
          expect(thread.model).toBe(state);
          expect(got).toEqual({
            state: 'done',
            proposal: proposeOnThread(VET, CTX, null, null).proposal,
          });
        } finally {
          await thread.close();
        }
      }
      await new Promise((r) => setImmediate(r));
      expect(warnings.filter((w) => w.includes('reading model is not used'))).toHaveLength(2);
      expect(warnings.join('|')).toMatch(/\(missing: ENOENT\): the rules read alone/);
    } finally {
      process.off('warning', listen);
    }
  });
});

describe('a file far bigger than the weights (the R2 review and its re-check)', () => {
  /** A file system that says the file is `size` long and gives `gives` bytes, a chunk at a time. */
  const fake = (size: number, gives: number) => {
    const seen = { read: 0, closed: 0 };
    let left = gives;
    const io = {
      openSync: () => 7,
      fstatSync: () => ({ isFile: () => true, size }),
      readSync: (_fd: number, buf: Buffer, offset: number, length: number) => {
        const n = Math.min(length, left, 1024 * 1024);
        seen.read += n;
        left -= n;
        buf.fill(1, offset, offset + n);
        return n;
      },
      closeSync: () => {
        seen.closed += 1;
      },
    };
    return { io, seen };
  };

  it('is never read: the size of what was opened is asked first', () => {
    const { io, seen } = fake(3 * 1024 ** 3, 3 * 1024 ** 3);
    const got = loadReadingModel('huge.bin', READING_MODEL_SHA256, io);
    expect(got).toMatchObject({ model: null, state: 'corrupt', detail: 'too big' });
    expect(seen.read).toBe(0);
    expect(seen.closed).toBe(1);
  });

  it('nor one that grows after its size was asked: a byte past the most, and no more', () => {
    const { io, seen } = fake(1000, 3 * 1024 ** 3);
    const got = loadReadingModel('growing.bin', READING_MODEL_SHA256, io);
    expect(got).toMatchObject({ model: null, state: 'corrupt', detail: 'too big' });
    expect(seen.read).toBe(8 * 1024 * 1024 + 1);
    expect(seen.closed).toBe(1);
  });

  it('each worker records what it found, by its own name, for the API (reading_model_state)', async () => {
    const said: unknown[][] = [];
    const admin = {
      query: (sql: string, params?: unknown[]) => {
        said.push([sql.replace(/\s+/g, ' ').slice(0, 40), params]);
        return Promise.resolve();
      },
    };
    await recordReadingModel(admin, 'host-a:12', 'loaded');
    await recordReadingModel(admin, 'host-b:7', null);
    expect(said).toEqual([
      ['insert into reading_model_state (worker,', ['host-a:12', 'loaded']],
      ['delete from reading_model_state where ch', undefined],
      ['insert into reading_model_state (worker,', ['host-b:7', 'missing']],
      ['delete from reading_model_state where ch', undefined],
    ]);
    // And a thread says what it found, as it starts.
    const seen: string[] = [];
    const thread = new ProposalThread({ onModel: (s) => seen.push(s) });
    try {
      expect(await thread.warm()).toBe('loaded');
      expect(seen).toEqual(['loaded']);
    } finally {
      await thread.close();
    }
  });

  it('and says it again while it runs, so its word never goes stale (the R2 re-check)', async () => {
    vi.useFakeTimers();
    try {
      const said: Array<string | null> = [];
      let state: 'loaded' | null = 'loaded';
      const stop = keepRecordingReadingModel(
        { warm: () => Promise.resolve(state) },
        (s) => said.push(s),
        1000,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(said).toEqual(['loaded']);
      await vi.advanceTimersByTimeAsync(3000);
      expect(said).toEqual(['loaded', 'loaded', 'loaded', 'loaded']);
      // Its thread gone: said as not loaded, not left as it was.
      state = null;
      await vi.advanceTimersByTimeAsync(1000);
      expect(said.at(-1)).toBe(null);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(said).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what it costs a page', () => {
  it('well under 100 ms a page more than the rules alone', () => {
    const loaded = loadReadingModel().model;
    const pages = Array.from({ length: 60 }, (_, i) =>
      [VET, `Reference ${i}`, 'Thank you for your custom. '.repeat(40 + i)].join('\n'),
    );
    const time = (withModel: boolean) => {
      const each: number[] = [];
      for (const p of pages) {
        const s = performance.now();
        proposeOnThread(p, CTX, null, withModel ? loaded : null);
        each.push(performance.now() - s);
      }
      return each.sort((a, b) => a - b);
    };
    time(true); // warm
    const rules = time(false);
    const both = time(true);
    const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] as number;
    const p95 = (xs: number[]) => xs[Math.floor(xs.length * 0.95)] as number;
    const added = median(both) - median(rules);
    console.log(
      `per page: rules ${median(rules).toFixed(1)} ms, with the model ${median(both).toFixed(1)} ms (95th ${p95(both).toFixed(1)} ms)`,
    );
    expect(added).toBeLessThan(100);
  });
});
