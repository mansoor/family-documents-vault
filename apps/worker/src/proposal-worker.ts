/**
 * The worker's proposal thread (Phase 6, I2): `proposeDetails` run off the
 * worker's event loop, an item's words at a time, for `ProposalThread`
 * (jobs/proposal-thread.ts), as the API's own thread runs it (5.37). It
 * says it is ready once loaded — and whether the vault's reading model
 * (0.9.0, R2) was, which it reads once, here, beside the words it reads;
 * then each item's words in — with the uploader's own rules (I4) — get
 * their proposal back — or `failed`, should the rules throw. It keeps
 * nothing between items, and logs nothing.
 *
 * Bundled beside the worker as dist/proposal-worker.mjs; from source under
 * tsx and vitest.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  expiryLabelKinds,
  proposeOnThread,
  readLocalAiReply,
  type DetailProposal,
  type LearnedClash,
  type LearnedContext,
  type LocalAiOffer,
  type LocalAiReading,
  type PaperReading,
  type ProposalContext,
  type ThreadProposal,
} from '@fdv/shared';
import { loadReadingModel, type ReadingModelState } from './reading-model.js';

export interface ProposalJob {
  id: number;
  text: string;
  ctx: ProposalContext;
  /** The uploader's own rules, learned from their corrections (I4); none, or null. */
  learned?: LearnedContext | null;
  /**
   * The local AI's reply to these words (0.9.0, R4), as the endpoint sent it,
   * and what it was offered: read here, strictly — never on the worker's
   * event loop.
   */
  ai?: { reply: string; offer: LocalAiOffer };
}

export type ProposalReply =
  /** Loaded; and whether the vault's reading model is (R2), and if not, why. */
  | { ready: true; model?: ReadingModelState; detail?: string }
  | {
      id: number;
      proposal: DetailProposal;
      clash?: LearnedClash;
      paper?: PaperReading;
      /** Where a shape matched, and the page's number at its label (N5). */
      account?: ThreadProposal['account'];
      /** The kinds complete without an expiry whose expiry label the page has (R3, the re-check). */
      expiryLabels?: string[];
      /** What the local AI read, checked (R4); null where its reply was not one to use. */
      localAi?: LocalAiReading | null;
    }
  | { id: number; failed: true };

const withLabels = (labels: string[]) => (labels.length > 0 ? { expiryLabels: labels } : {});

/** The local AI's reply read (R4): what it read, borne out by the page; null if not one to use. */
const localAiOf = (job: ProposalJob): LocalAiReading | null => {
  if (!job.ai) return null;
  const got = readLocalAiReply(job.ai.reply, job.ai.offer, job.text, job.ctx.dateOrder);
  return 'reading' in got ? got.reading : null;
};

const port = parentPort;
if (port) {
  // The vault's reading model (0.9.0, R2): read once, held to its hash; none,
  // and the rules read alone, if it is missing or not the file it should be.
  const fromParent = (workerData as { modelFile?: unknown } | null)?.modelFile;
  const loaded = loadReadingModel(typeof fromParent === 'string' ? fromParent : undefined);
  port.on('message', (job: ProposalJob) => {
    let reply: ProposalReply;
    try {
      // The pages' proposal, with the uploader's own rules for the issuer
      // they name (I4) and their senders' layouts (R1): on this thread too,
      // beside the words; and the page's shape, for its accept to learn from.
      // No account's hash comes here, nor a key to make one (N5): whose
      // account it is the worker settles, by the number this read.
      const got = proposeOnThread(job.text, job.ctx, job.learned ?? null, loaded.model);
      reply = {
        id: job.id,
        proposal: got.proposal,
        clash: got.clash,
        ...(got.paper ? { paper: got.paper } : {}),
        ...(got.account ? { account: got.account } : {}),
        // Which kinds complete without an expiry the page labels one of (R3,
        // the re-check): such a card with none waits for a look.
        ...withLabels(expiryLabelKinds(job.text, job.ctx)),
        // The local AI's reply (R4): held to its schema and to the page, or nothing.
        ...(job.ai ? { localAi: localAiOf(job) } : {}),
      };
    } catch {
      reply = { id: job.id, failed: true };
    }
    port.postMessage(reply);
  });
  port.postMessage({
    ready: true,
    model: loaded.state,
    ...(loaded.detail ? { detail: loaded.detail } : {}),
  } satisfies ProposalReply);
}
