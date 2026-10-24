/**
 * The vault's reading model (0.9.0, R2): a small, fully local text
 * classifier that says which of the vault's built-in kinds a page looks
 * like — one more cue beside the rules (proposals.ts), never the decider
 * (`applyReadingModel`, reading-model-rules.ts).
 *
 * A linear model over hashed features: the page's words, its pairs of words
 * and the letters inside its words (four at a time, which OCR's misreadings
 * leave mostly whole), each hashed into `dim` buckets with a sign, the lot
 * scaled to length 1; then a weight for each bucket and kind, and a softmax
 * over the kinds and `none` (a paper of no kind the vault keeps), its
 * temperature fitted on papers of its generator held aside. Trained by
 * scripts/train-reading-model.mjs on made-up papers alone
 * (scripts/reading-model-corpus.mjs), its weights kept as 8-bit integers in
 * a file of their own, which the worker checks by its SHA-256 before use.
 *
 * Bounded and linear: the first `MAX_CHARS` characters, at most `MAX_WORDS`
 * words and `MAX_FEATURES` features; each step a single pass, no pattern
 * that can backtrack. Pure and deterministic — the same page, the same
 * answer — with no import, so the training script runs it as it is
 * (Node's own type stripping) and the model is learned with the very
 * features the vault reads.
 */

/** The most of a page read: the kind is said on its first pages. */
export const READING_MODEL_MAX_CHARS = 12_000;
/** The most words read. */
export const READING_MODEL_MAX_WORDS = 2_000;
/** The most features made of one page (a word gives at most two dozen). */
export const READING_MODEL_MAX_FEATURES = 20_000;
/** The longest word whose letters are read; a longer run of letters is nonsense. */
const MAX_WORD = 24;

/** What the file holds, once read: the model. */
export interface ReadingModel {
  /** The format's version. */
  version: number;
  /** Buckets, a power of two. */
  dim: number;
  /** The classes, in the weights' order: built-in kinds' keys, and `none`. */
  classes: string[];
  /** dim × classes, by bucket: class c of bucket i at i * classes + c. */
  weights: Int8Array;
  /** Each class's weight is its integer times its scale. */
  scales: Float64Array;
  bias: Float64Array;
  /** The softmax's temperature (fitted on papers held aside from training). */
  temperature: number;
  /** What it was trained on, said in the file: seed, papers, the corpus's hash. */
  trained: Record<string, unknown>;
}

/** One class's probability. */
export interface KindChance {
  kind: string;
  p: number;
}

/** FNV-1a, 32 bits: a feature's bucket (its low bits) and its sign (its top bit). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The page's words as the model reads them: lower case, runs of letters
 * (an apostrophe inside one kept) and runs of digits, a run of digits by its
 * length alone ("#4"), at most READING_MODEL_MAX_WORDS of them. One pass.
 */
export function readingModelWords(text: string): string[] {
  const s = text.slice(0, READING_MODEL_MAX_CHARS).toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < s.length && out.length < READING_MODEL_MAX_WORDS) {
    const c = s.charCodeAt(i);
    const letter = c >= 97 && c <= 122;
    const digit = c >= 48 && c <= 57;
    if (!letter && !digit) {
      i += 1;
      continue;
    }
    let j = i + 1;
    if (letter) {
      while (j < s.length) {
        const d = s.charCodeAt(j);
        if (d >= 97 && d <= 122) j += 1;
        else if (
          d === 39 &&
          j + 1 < s.length &&
          s.charCodeAt(j + 1) >= 97 &&
          s.charCodeAt(j + 1) <= 122
        )
          j += 1;
        else break;
      }
      out.push(s.slice(i, Math.min(j, i + MAX_WORD * 2)));
    } else {
      while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j += 1;
      out.push(`#${Math.min(j - i, 9)}`);
    }
    i = j;
  }
  return out;
}

/**
 * The page's features, hashed into `dim` buckets (a power of two), signed,
 * scaled to length 1: each word of two letters or more, each pair of
 * neighbouring words, and the four-letter runs inside each word (with its
 * ends marked). Returned as parallel lists of buckets and values.
 */
export function readingModelFeatures(
  text: string,
  dim: number,
): { index: Int32Array; value: Float64Array } {
  const words = readingModelWords(text);
  const sums = new Map<number, number>();
  let made = 0;
  const add = (f: string) => {
    if (made >= READING_MODEL_MAX_FEATURES) return;
    made += 1;
    const h = hash(f);
    const at = h & (dim - 1);
    sums.set(at, (sums.get(at) ?? 0) + (h & 0x80000000 ? -1 : 1));
  };
  let last: string | null = null;
  for (const w of words) {
    const isWord = w.charCodeAt(0) !== 35 && w.length >= 2;
    if (isWord) {
      add(`w ${w}`);
      if (last) add(`b ${last} ${w}`);
      if (w.length <= MAX_WORD) {
        const padded = `<${w}>`;
        for (let k = 0; k + 4 <= padded.length; k += 1) add(`c ${padded.slice(k, k + 4)}`);
      }
      last = w;
    } else {
      last = w.charCodeAt(0) === 35 ? w : null;
    }
  }
  const index = new Int32Array(sums.size);
  const value = new Float64Array(sums.size);
  let norm = 0;
  let k = 0;
  for (const [at, v] of [...sums.entries()].sort((a, b) => a[0] - b[0])) {
    index[k] = at;
    value[k] = v;
    norm += v * v;
    k += 1;
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm);
    for (let i = 0; i < value.length; i += 1) value[i] = (value[i] as number) * scale;
  }
  return { index, value };
}

/** Each class's probability for the page, surest first. Linear in the page. */
export function readingModelChances(model: ReadingModel, text: string): KindChance[] {
  const { index, value } = readingModelFeatures(text, model.dim);
  const n = model.classes.length;
  const logits = new Float64Array(n);
  for (let i = 0; i < index.length; i += 1) {
    const row = (index[i] as number) * n;
    const v = value[i] as number;
    for (let c = 0; c < n; c += 1)
      logits[c] = (logits[c] as number) + v * (model.weights[row + c] as number);
  }
  let top = -Infinity;
  for (let c = 0; c < n; c += 1) {
    const l =
      ((logits[c] as number) * (model.scales[c] as number) + (model.bias[c] as number)) /
      model.temperature;
    logits[c] = l;
    if (l > top) top = l;
  }
  let sum = 0;
  for (let c = 0; c < n; c += 1) {
    const e = Math.exp((logits[c] as number) - top);
    logits[c] = e;
    sum += e;
  }
  return model.classes
    .map((kind, c) => ({ kind, p: (logits[c] as number) / sum }))
    .sort((a, b) => b.p - a.p || (a.kind < b.kind ? -1 : 1));
}

/** The file's first eight bytes. */
export const READING_MODEL_MAGIC = 'FDVRM001';

/**
 * The model from its file's bytes: the magic, a header's length (4 bytes,
 * little-endian) and the header as JSON in ASCII (dim, classes, scales, bias,
 * temperature, what it was trained on), then dim × classes signed bytes.
 * Throws on anything else — a file cut short, a header that does not say
 * what it should, weights of the wrong length.
 */
export function parseReadingModel(bytes: Uint8Array): ReadingModel {
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== READING_MODEL_MAGIC) throw new Error('not a reading model');
  if (bytes.length < 12) throw new Error('the reading model is cut short');
  const length =
    (bytes[8] as number) |
    ((bytes[9] as number) << 8) |
    ((bytes[10] as number) << 16) |
    ((bytes[11] as number) << 24);
  if (length <= 0 || length > 1_000_000 || 12 + length > bytes.length) {
    throw new Error('the reading model’s header is not whole');
  }
  // The header is ASCII (the trainer writes it so): anything else is refused.
  let json = '';
  for (let i = 12; i < 12 + length; i += 1) {
    const b = bytes[i] as number;
    if (b > 127) throw new Error('the reading model’s header is not ASCII');
    json += String.fromCharCode(b);
  }
  const header = JSON.parse(json) as Record<string, unknown>;
  const dim = header.dim;
  const classes = header.classes;
  const scales = header.scales;
  const bias = header.bias;
  const temperature = header.temperature;
  const ok =
    typeof dim === 'number' &&
    Number.isInteger(dim) &&
    dim >= 256 &&
    dim <= 1 << 22 &&
    (dim & (dim - 1)) === 0 &&
    Array.isArray(classes) &&
    classes.length >= 2 &&
    classes.length <= 64 &&
    classes.every((c) => typeof c === 'string' && /^[a-z_]{1,64}$/.test(c)) &&
    Array.isArray(scales) &&
    scales.length === classes.length &&
    scales.every((s) => typeof s === 'number' && Number.isFinite(s)) &&
    Array.isArray(bias) &&
    bias.length === classes.length &&
    bias.every((s) => typeof s === 'number' && Number.isFinite(s)) &&
    typeof temperature === 'number' &&
    temperature > 0 &&
    Number.isFinite(temperature);
  if (!ok) throw new Error('the reading model’s header is not what it should be');
  const body = bytes.subarray(12 + length);
  if (body.length !== dim * classes.length)
    throw new Error('the reading model’s weights are not whole');
  return {
    version: typeof header.version === 'number' ? header.version : 1,
    dim,
    classes: classes as string[],
    weights: new Int8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length)),
    scales: Float64Array.from(scales as number[]),
    bias: Float64Array.from(bias as number[]),
    temperature,
    trained:
      header.trained && typeof header.trained === 'object'
        ? (header.trained as Record<string, unknown>)
        : {},
  };
}

/**
 * How often each worker says again whether it has the model's weights
 * loaded (reading_model_state, 0079; the R2 re-check), and how long the API
 * believes it: a worker stopped, or a row a restore brought back, is soon
 * not believed.
 */
export const READING_MODEL_RECORD_MS = 5 * 60_000;
export const READING_MODEL_STALE_MS = 15 * 60_000;
