/**
 * The proposal thread (5.37, N537P-01): `proposeDetails` run off the API's
 * event loop, a page at a time, for `ProposalPool`. It says it is ready
 * once loaded; then each page in gets its proposal back — or null, should
 * the rules throw. It keeps nothing between pages, and logs nothing. A
 * collection's checklist is read here too (0.9.0, C1, `job: 'checklist'`):
 * what a family types is read off the event loop, as a page's words are.
 *
 * Bundled beside the server as dist/proposal-worker.mjs; from source under
 * tsx and vitest.
 */
import { parentPort } from 'node:worker_threads';
import {
  proposeDetails,
  readChecklist,
  type ChecklistContext,
  type ChecklistReading,
  type DetailProposal,
  type ProposalContext,
} from '@fdv/shared';

export interface ProposalJob {
  id: number;
  text: string;
  ctx: ProposalContext | ChecklistContext;
  /** A checklist to read (0.9.0, C1), rather than a page to propose for. */
  job?: 'checklist';
}

export type ProposalReply =
  { ready: true } | { id: number; proposal: DetailProposal | ChecklistReading | null };

const port = parentPort;
if (port) {
  port.on('message', (job: ProposalJob) => {
    let proposal: DetailProposal | ChecklistReading | null;
    try {
      proposal =
        job.job === 'checklist'
          ? readChecklist(job.text, job.ctx as ChecklistContext)
          : proposeDetails(job.text, job.ctx as ProposalContext);
    } catch {
      proposal = null;
    }
    port.postMessage({ id: job.id, proposal } satisfies ProposalReply);
  });
  port.postMessage({ ready: true } satisfies ProposalReply);
}
