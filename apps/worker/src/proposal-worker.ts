/**
 * The worker's proposal thread (Phase 6, I2): `proposeDetails` run off the
 * worker's event loop, an item's words at a time, for `ProposalThread`
 * (jobs/proposal-thread.ts), as the API's own thread runs it (5.37). It
 * says it is ready once loaded; then each item's words in get their
 * proposal back — or `failed`, should the rules throw. It keeps nothing
 * between items, and logs nothing.
 *
 * Bundled beside the worker as dist/proposal-worker.mjs; from source under
 * tsx and vitest.
 */
import { parentPort } from 'node:worker_threads';
import { proposeDetails, type DetailProposal, type ProposalContext } from '@fdv/shared';

export interface ProposalJob {
  id: number;
  text: string;
  ctx: ProposalContext;
}

export type ProposalReply =
  { ready: true } | { id: number; proposal: DetailProposal } | { id: number; failed: true };

const port = parentPort;
if (port) {
  port.on('message', (job: ProposalJob) => {
    let reply: ProposalReply;
    try {
      reply = { id: job.id, proposal: proposeDetails(job.text, job.ctx) };
    } catch {
      reply = { id: job.id, failed: true };
    }
    port.postMessage(reply);
  });
  port.postMessage({ ready: true } satisfies ProposalReply);
}
