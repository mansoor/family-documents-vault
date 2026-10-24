#!/usr/bin/env node
// Trains the vault's reading model (0.9.0, R2) and writes its weights file.
//
//   node scripts/train-reading-model.mjs [--seed 1] [--per 300] [--dim 32768] [--epochs 14]
//                                        [--out apps/worker/src/reading-model.bin]
//
// 1. Makes the training papers (scripts/reading-model-corpus.mjs, the seed's).
// 2. Reads each with the model's own features (@fdv/shared reading-model.ts,
//    run as it is by Node's type stripping, so training and the vault read
//    a page the same way).
// 3. Fits a softmax over the kinds and `none` by AdaGrad, its order each
//    epoch shuffled from the seed, with a little L2.
// 4. Keeps each weight as a signed byte (a scale a kind).
// 5. Fits the softmax's temperature, either way, on papers held aside:
//    the generator's own, from another seed (2), never trained on — not on
//    the tune split, which shaped the training papers (the R2 review). It
//    says how well calibrated the model is before and after (the expected
//    calibration error, 10 bins of its surest class), there and, for the
//    record, on the tune split. No held-out paper is read here.
//
// The same seed and options give the same bytes; it prints the file's
// SHA-256, which apps/worker/src/reading-model.ts holds the file to.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READING_MODEL_MAGIC, readingModelFeatures } from '../packages/shared/src/reading-model.ts';
import { READING_MODEL_KINDS, readingModelCorpus, seeded } from './reading-model-corpus.mjs';
import { smartCorpus } from './smart-corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A drawn page's words, a line at a time, as pdftotext -layout sets them. */
export function drawnText(pages) {
  const out = [];
  for (const page of pages) {
    const rows = new Map();
    for (const it of page.items) {
      const y = Math.round(it.y);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it);
    }
    for (const y of [...rows.keys()].sort((a, b) => a - b)) {
      const items = rows.get(y).sort((a, b) => a.x - b.x);
      let line = '';
      let end = 0;
      for (const it of items) {
        const gap = Math.max(1, Math.round((it.x - end) / 6));
        line += line ? ' '.repeat(Math.min(gap, 12)) : '';
        line += it.text;
        end = it.x + it.text.length * it.size * 0.5;
      }
      out.push(line);
    }
    out.push('');
  }
  return out.join('\n');
}

/** The tune split's papers: the first set's, as drawn, each with its kind (or `none`). */
export function tunePapers() {
  return smartCorpus({ seed: 1, corpus: 'first', withPages: true })
    .files.filter((f) => f.pages)
    .map((f) => ({ kind: f.entry.truth.kind ?? 'none', text: drawnText(f.pages) }));
}

export function train({
  seed = 1,
  per = 300,
  dim = 32768,
  epochs = 14,
  l2 = 1e-6,
  rate = 0.4,
} = {}) {
  const classes = READING_MODEL_KINDS;
  const C = classes.length;
  const papers = readingModelCorpus({ seed, per });
  const corpusHash = createHash('sha256');
  for (const p of papers) corpusHash.update(`${p.kind}\n${p.text}\n`);
  const X = papers.map((p) => readingModelFeatures(p.text, dim));
  const y = papers.map((p) => classes.indexOf(p.kind));
  const W = new Float64Array(dim * C);
  const G = new Float64Array(dim * C).fill(1e-8);
  const b = new Float64Array(C);
  const Gb = new Float64Array(C).fill(1e-8);
  const r = seeded(seed, 'train');
  const order = papers.map((_, i) => i);
  const logits = new Float64Array(C);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const shuffled = r.shuffle(order);
    let loss = 0;
    for (const i of shuffled) {
      const { index, value } = X[i];
      logits.set(b);
      for (let k = 0; k < index.length; k += 1) {
        const row = index[k] * C;
        const v = value[k];
        for (let c = 0; c < C; c += 1) logits[c] += v * W[row + c];
      }
      let top = -Infinity;
      for (let c = 0; c < C; c += 1) top = Math.max(top, logits[c]);
      let sum = 0;
      for (let c = 0; c < C; c += 1) {
        logits[c] = Math.exp(logits[c] - top);
        sum += logits[c];
      }
      loss -= Math.log(Math.max(1e-12, logits[y[i]] / sum));
      for (let c = 0; c < C; c += 1) {
        const g = logits[c] / sum - (c === y[i] ? 1 : 0);
        Gb[c] += g * g;
        b[c] -= (rate * g) / Math.sqrt(Gb[c]);
        for (let k = 0; k < index.length; k += 1) {
          const at = index[k] * C + c;
          const gw = g * value[k] + l2 * W[at];
          G[at] += gw * gw;
          W[at] -= (rate * gw) / Math.sqrt(G[at]);
        }
      }
    }
    process.stderr.write(`epoch ${epoch + 1}: loss ${(loss / papers.length).toFixed(4)}\n`);
  }
  // Signed bytes, a scale a kind.
  const scales = new Array(C).fill(0);
  for (let c = 0; c < C; c += 1) {
    let most = 0;
    for (let j = 0; j < dim; j += 1) most = Math.max(most, Math.abs(W[j * C + c]));
    scales[c] = most > 0 ? most / 127 : 1;
  }
  const q = new Int8Array(dim * C);
  for (let j = 0; j < dim; j += 1) {
    for (let c = 0; c < C; c += 1) q[j * C + c] = Math.round(W[j * C + c] / scales[c]);
  }
  const model = {
    dim,
    classes,
    weights: q,
    scales: Float64Array.from(scales),
    bias: b,
    temperature: 1,
  };
  // The temperature, either way, on papers held aside (seed 2, never trained on).
  const aside = readingModelCorpus({ seed: seed + 1, per: ASIDE_PER });
  const asideLogits = aside.map((p) => logitsOf(model, p.text));
  const asideY = aside.map((p) => classes.indexOf(p.kind));
  let best = { t: 1, nll: Infinity };
  for (let t = 0.2; t <= 10.0001; t += 0.05) {
    let nll = 0;
    asideLogits.forEach((l, i) => {
      const top = Math.max(...l);
      let sum = 0;
      for (const v of l) sum += Math.exp((v - top) / t);
      nll -= (l[asideY[i]] - top) / t - Math.log(sum);
    });
    if (nll < best.nll - 1e-9) best = { t: Math.round(t * 100) / 100, nll };
  }
  model.temperature = best.t;
  const tune = tunePapers();
  const tuneLogits = tune.map((p) => logitsOf(model, p.text));
  const tuneY = tune.map((p) => classes.indexOf(p.kind));
  const calibration = {
    held_aside: {
      papers: aside.length,
      ece_before: ece(asideLogits, asideY, 1),
      ece_after: ece(asideLogits, asideY, best.t),
    },
    tune: {
      papers: tune.length,
      ece_before: ece(tuneLogits, tuneY, 1),
      ece_after: ece(tuneLogits, tuneY, best.t),
    },
  };
  return {
    model,
    trained: {
      seed,
      per,
      papers: papers.length,
      epochs,
      l2,
      rate,
      corpus_sha256: corpusHash.digest('hex'),
      temperature_from: `the generator's own papers held aside (seed ${seed + 1}, ${ASIDE_PER} a kind)`,
      calibration,
    },
  };
}

/** Papers a kind held aside for the temperature. */
const ASIDE_PER = 40;

/**
 * The expected calibration error at a temperature: the surest class's
 * chance against how often it is right, in 10 bins, weighted by how many
 * papers fall in each. Rounded to 4 places.
 */
export function ece(logits, ys, t) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, right: 0 }));
  logits.forEach((l, i) => {
    const top = Math.max(...l);
    const e = l.map((v) => Math.exp((v - top) / t));
    const sum = e.reduce((a, b) => a + b, 0);
    let best = 0;
    for (let c = 1; c < e.length; c += 1) if (e[c] > e[best]) best = c;
    const p = e[best] / sum;
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n += 1;
    b.conf += p;
    b.right += best === ys[i] ? 1 : 0;
  });
  const n = logits.length;
  return (
    Math.round((bins.reduce((s, b) => s + (b.n ? Math.abs(b.conf - b.right) : 0), 0) / n) * 1e4) /
    1e4
  );
}

function logitsOf(model, text) {
  const { index, value } = readingModelFeatures(text, model.dim);
  const C = model.classes.length;
  const l = new Array(C).fill(0);
  for (let k = 0; k < index.length; k += 1) {
    for (let c = 0; c < C; c += 1) l[c] += value[k] * model.weights[index[k] * C + c];
  }
  return l.map((v, c) => v * model.scales[c] + model.bias[c]);
}

/** The file: magic, header length, header, weights. */
export function modelBytes({ model, trained }) {
  const header = Buffer.from(
    JSON.stringify({
      version: 1,
      dim: model.dim,
      classes: model.classes,
      scales: [...model.scales].map((s) => Number(s.toPrecision(9))),
      bias: [...model.bias].map((s) => Number(s.toPrecision(9))),
      temperature: model.temperature,
      trained,
    }).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
    'latin1',
  );
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  return Buffer.concat([
    Buffer.from(READING_MODEL_MAGIC, 'latin1'),
    length,
    header,
    Buffer.from(model.weights.buffer, model.weights.byteOffset, model.weights.length),
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
  };
  const out = option('out', path.join(ROOT, 'apps/worker/src/reading-model.bin'));
  const started = Date.now();
  const made = train({
    seed: Number(option('seed', '1')),
    per: Number(option('per', '300')),
    dim: Number(option('dim', '32768')),
    epochs: Number(option('epochs', '14')),
    l2: Number(option('l2', '1e-6')),
  });
  const bytes = modelBytes(made);
  writeFileSync(out, bytes);
  console.log(
    JSON.stringify({
      out,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      temperature: made.model.temperature,
      seconds: Math.round((Date.now() - started) / 1000),
      ...made.trained,
    }),
  );
}
