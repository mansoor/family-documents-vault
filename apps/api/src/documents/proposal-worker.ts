/**
 * The proposal thread (5.37, N537P-01): `proposeDetails` run off the API's
 * event loop, a page at a time, for `ProposalPool`. It says it is ready
 * once loaded; then each page in gets its proposal back — or null, should
 * the rules throw. It keeps nothing between pages, and logs nothing.
 *
 * Bundled beside the server as dist/proposal-worker.mjs; from source under
 * tsx and vitest.
 */
import { parentPort } from 'node:worker_threads';
import { proposeDetails, type DetailProposal, type ProposalContext } from '@fdv/shared';

export interface ProposalJob {
  id: number;
  text: string;
  ctx: ProposalContext;
}

export type ProposalReply = { ready: true } | { id: number; proposal: DetailProposal | null };

const port = parentPort;
if (port) {
  port.on('message', (job: ProposalJob) => {
    let proposal: DetailProposal | null;
    try {
      proposal = proposeDetails(job.text, job.ctx);
    } catch {
      proposal = null;
    }
    port.postMessage({ id: job.id, proposal } satisfies ProposalReply);
  });
  port.postMessage({ ready: true } satisfies ProposalReply);
}
