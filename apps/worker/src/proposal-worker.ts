/**
 * The worker's proposal thread (Phase 6, I2): `proposeDetails` run off the
 * worker's event loop, an item's words at a time, for `ProposalThread`
 * (jobs/proposal-thread.ts), as the API's own thread runs it (5.37). It
 * says it is ready once loaded; then each item's words in — with the
 * uploader's own rules (I4) — get their proposal back — or `failed`, should the rules throw. It keeps nothing
 * between items, and logs nothing.
 *
 * Bundled beside the worker as dist/proposal-worker.mjs; from source under
 * tsx and vitest.
 */
import { parentPort } from 'node:worker_threads';
import {
  proposeOnThread,
  type DetailProposal,
  type LearnedClash,
  type LearnedContext,
  type PaperReading,
  type ProposalContext,
  type ThreadProposal,
} from '@fdv/shared';

export interface ProposalJob {
  id: number;
  text: string;
  ctx: ProposalContext;
  /** The uploader's own rules, learned from their corrections (I4); none, or null. */
  learned?: LearnedContext | null;
}

export type ProposalReply =
  | { ready: true }
  | {
      id: number;
      proposal: DetailProposal;
      clash?: LearnedClash;
      paper?: PaperReading;
      /** Where a shape matched, and the page's number at its label (N5). */
      account?: ThreadProposal['account'];
    }
  | { id: number; failed: true };

const port = parentPort;
if (port) {
  port.on('message', (job: ProposalJob) => {
    let reply: ProposalReply;
    try {
      // The pages' proposal, with the uploader's own rules for the issuer
      // they name (I4) and their senders' layouts (R1): on this thread too,
      // beside the words; and the page's shape, for its accept to learn from.
      // No account's hash comes here, nor a key to make one (N5): whose
      // account it is the worker settles, by the number this read.
      const got = proposeOnThread(job.text, job.ctx, job.learned ?? null);
      reply = {
        id: job.id,
        proposal: got.proposal,
        clash: got.clash,
        ...(got.paper ? { paper: got.paper } : {}),
        ...(got.account ? { account: got.account } : {}),
      };
    } catch {
      reply = { id: job.id, failed: true };
    }
    port.postMessage(reply);
  });
  port.postMessage({ ready: true } satisfies ProposalReply);
}
