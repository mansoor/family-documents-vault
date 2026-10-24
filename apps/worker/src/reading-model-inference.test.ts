import { readFileSync } from 'node:fs';
import {
  parseReadingModel,
  READING_MODEL_MAGIC,
  READING_MODEL_MAX_CHARS,
  READING_MODEL_MAX_FEATURES,
  READING_MODEL_MAX_WORDS,
  readingModelChances,
  readingModelFeatures,
  readingModelWords,
  type ReadingModel,
} from '@fdv/shared';
import { describe, expect, it } from 'vitest';
import { defaultReadingModelFile } from './reading-model.js';

/**
 * The vault's reading model (0.9.0, R2): its inference, bounded, linear and
 * deterministic, and its weights file read strictly. The weights are the
 * worker's (reading-model.bin, beside this), held there by their hash.
 */

const bytes = () => new Uint8Array(readFileSync(defaultReadingModelFile()));
const model = (): ReadingModel => parseReadingModel(bytes());

/** A file as the trainer writes one, from parts a test chooses. */
function fileOf(header: Record<string, unknown>, weights: Uint8Array): Uint8Array {
  const json = Buffer.from(JSON.stringify(header), 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  return new Uint8Array(
    Buffer.concat([Buffer.from(READING_MODEL_MAGIC, 'latin1'), length, json, weights]),
  );
}
const GOOD = {
  version: 1,
  dim: 256,
  classes: ['passport', 'none'],
  scales: [0.01, 0.01],
  bias: [0, 0],
  temperature: 1,
};

const PASSPORT = [
  'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND',
  'PASSPORT',
  'Surname/Nom  WHITLOCK',
  'Given names/Prénoms  JANE',
  'Nationality  BRITISH CITIZEN',
  'Date of birth  04 MAR 1986',
  'Place of birth  READING',
  'Date of expiry  11 JUN 2031',
].join('\n');

describe('the weights file', () => {
  it('reads: every built-in kind but "Something else", and none, from made-up papers', () => {
    const m = model();
    expect(m.dim).toBe(32768);
    expect(m.classes).toContain('none');
    expect(m.classes).not.toContain('other');
    expect(m.classes).not.toContain('note');
    expect(m.classes).toHaveLength(26);
    expect(m.weights).toHaveLength(m.dim * m.classes.length);
    // Small enough to commit: under a megabyte.
    expect(bytes().length).toBeLessThan(1024 * 1024);
    expect(m.trained).toMatchObject({ seed: 1, per: 300, papers: 8100 });
  });

  it('is refused unless it is whole and says what it should', () => {
    const w = new Uint8Array(256 * 2);
    expect(() => parseReadingModel(fileOf(GOOD, w))).not.toThrow();
    // Not a model at all; cut short; its header not whole, or not ASCII.
    expect(() => parseReadingModel(new Uint8Array(Buffer.from('%PDF-1.7 hello')))).toThrow(
      /not a reading model/,
    );
    expect(() => parseReadingModel(fileOf(GOOD, w).subarray(0, 10))).toThrow();
    expect(() => parseReadingModel(fileOf(GOOD, w).subarray(0, 40))).toThrow(/header/);
    const unicode = fileOf({ ...GOOD, trained: { note: 'é' } }, w);
    unicode.set(Buffer.from('é', 'utf8'), unicode.indexOf(0xe9));
    expect(() => parseReadingModel(unicode)).toThrow(/ASCII|header/);
    // Weights of the wrong length; a dimension that is no power of two;
    // classes, scales or a temperature that are not what they should be.
    expect(() => parseReadingModel(fileOf(GOOD, w.subarray(1)))).toThrow(/weights/);
    expect(() => parseReadingModel(fileOf({ ...GOOD, dim: 300 }, new Uint8Array(600)))).toThrow(
      /header/,
    );
    for (const bad of [
      { classes: ['passport'] },
      { classes: ['Passport!', 'none'] },
      { scales: [0.01] },
      { bias: [0, 'x'] },
      { temperature: 0 },
      { temperature: 'hot' },
    ]) {
      expect(() => parseReadingModel(fileOf({ ...GOOD, ...bad }, w)), JSON.stringify(bad)).toThrow(
        /header/,
      );
    }
  });
});

describe('reading a page', () => {
  it('says a passport is a passport, and a recipe is no kind', () => {
    const m = model();
    const [top] = readingModelChances(m, PASSPORT);
    expect(top?.kind).toBe('passport');
    expect(top?.p).toBeGreaterThan(0.9);
    const recipe = readingModelChances(
      m,
      'Lemon drizzle cake\n225g softened butter\n225g caster sugar\n4 eggs\nBake for 45 minutes at 180C',
    )[0];
    expect(recipe?.kind).toBe('none');
    // The chances are a distribution over every class.
    const all = readingModelChances(m, PASSPORT);
    expect(all).toHaveLength(m.classes.length);
    expect(all.reduce((s, c) => s + c.p, 0)).toBeCloseTo(1, 9);
  });

  it('gives the same answer every time: the same features, the same chances', () => {
    const m = model();
    const a = readingModelChances(m, PASSPORT);
    const b = readingModelChances(m, `${PASSPORT}`);
    expect(b).toEqual(a);
    const f1 = readingModelFeatures(PASSPORT, m.dim);
    const f2 = readingModelFeatures(PASSPORT, m.dim);
    expect([...f2.index]).toEqual([...f1.index]);
    expect([...f2.value]).toEqual([...f1.value]);
    // Scaled to length 1.
    expect(f1.value.reduce((s, v) => s + v * v, 0)).toBeCloseTo(1, 9);
  });

  it('reads at most its first characters, words and features', () => {
    const m = model();
    const long = `${PASSPORT}\n${'Lorem ipsum dolor sit amet consectetur '.repeat(20_000)}`;
    // Past READING_MODEL_MAX_CHARS, nothing more is read.
    expect(readingModelChances(m, long)).toEqual(
      readingModelChances(m, long.slice(0, READING_MODEL_MAX_CHARS)),
    );
    expect(readingModelWords(long).length).toBeLessThanOrEqual(READING_MODEL_MAX_WORDS);
    // Long words of letters all different, twenty-odd features each: under the cap (which
    // the characters read keep it under already: a second bound, in case they change).
    let seed = 7;
    const letter = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return String.fromCharCode(97 + (seed % 26));
    };
    const words = Array.from({ length: 3000 }, () => Array.from({ length: 22 }, letter).join(''));
    const f = readingModelFeatures(words.join(' '), m.dim);
    expect(f.index.length).toBeLessThanOrEqual(READING_MODEL_MAX_FEATURES);
  });

  it('is linear on hostile pages: a megabyte of anything is read in milliseconds', () => {
    const m = model();
    const hostile = [
      'a'.repeat(1_000_000),
      "'".repeat(1_000_000),
      "a'".repeat(500_000),
      '1'.repeat(1_000_000),
      ' \n\t'.repeat(400_000),
      'é漢字🙂'.repeat(200_000),
      Array.from({ length: 200_000 }, (_, i) => `x${i}`).join(' '),
    ];
    for (const text of hostile) {
      const started = performance.now();
      readingModelChances(m, text);
      const ms = performance.now() - started;
      // Bounded by READING_MODEL_MAX_CHARS whatever the page: generous for a busy machine.
      expect(ms, text.slice(0, 12)).toBeLessThan(500);
    }
    // And no slower for a megabyte than for its first READING_MODEL_MAX_CHARS characters.
    const time = (t: string) => {
      const s = performance.now();
      for (let i = 0; i < 5; i += 1) readingModelChances(m, t);
      return performance.now() - s;
    };
    const big = 'Statement of account sort code 12-34-56 balance '.repeat(25_000);
    expect(time(big)).toBeLessThan(time(big.slice(0, READING_MODEL_MAX_CHARS)) * 3 + 50);
  });
});
