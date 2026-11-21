import { Readable } from 'node:stream';
import {
  ACTIVITY_CSV_MAX_LINES,
  activityCsvCappedRow,
  activityCsvFileName,
  activityCsvHeader,
  activityCsvRow,
  activityCsvWhen,
} from '@fdv/shared';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { AuditService, ExportAsk, ExportLimits, ExportOutcome } from './service.js';

/** How much of the file is gathered before it is written on (bytes, about). */
const CHUNK = 32 * 1024;

/** What making the file asks of the log. */
export type ExportSource = Pick<AuditService, 'exportStart' | 'exportLines' | 'recordExport'>;

/**
 * The activity log as CSV (0.9.0-dev.82): everything it may refuse asked
 * first (`exportStart`), then the file, streamed as its lines are read —
 * the byte-order mark and the columns' names, a row a line, and, when it
 * stopped short (`max` lines, or as much of the log as one file reads), a
 * last row that says so. Its own line in the log is written once, as it
 * ends: taken to the end, or not (the download left, the reader's rights
 * changed, the database failed).
 */
export async function activityCsv(
  audit: ExportSource,
  p: Principal,
  ask: ExportAsk,
  meta: RequestMeta,
  onError: (err: unknown) => void,
  opts: { max?: number; limits?: ExportLimits } = {},
): Promise<{ filename: string; body: Readable }> {
  const max = opts.max ?? ACTIVITY_CSV_MAX_LINES;
  const start = await audit.exportStart(p, ask);
  async function* file(): AsyncGenerator<Buffer> {
    let lines = 0;
    let capped: 'lines' | 'rows' | 'time' | null = null;
    let finished = false;
    const outcome: ExportOutcome = { stopped: null };
    try {
      yield Buffer.from(activityCsvHeader(), 'utf8');
      let buffered = '';
      for await (const r of audit.exportLines(p, ask, start, opts.limits, outcome)) {
        if (lines === max) {
          capped = 'lines';
          break;
        }
        buffered += activityCsvRow(r, start.zone);
        lines += 1;
        if (buffered.length >= CHUNK) {
          yield Buffer.from(buffered, 'utf8');
          buffered = '';
        }
      }
      if (capped) buffered += activityCsvCappedRow({ lines: max });
      else if (outcome.stopped) {
        capped = outcome.stopped.by;
        buffered += activityCsvCappedRow({
          readTo: activityCsvWhen(outcome.stopped.readTo, start.zone),
        });
      }
      if (buffered) yield Buffer.from(buffered, 'utf8');
      finished = true;
    } finally {
      try {
        await audit.recordExport(p, ask, { lines, capped, finished }, meta.ip);
      } catch (err) {
        onError(err);
      }
    }
  }
  return { filename: activityCsvFileName(start.today), body: Readable.from(file()) };
}
