import {
  ACTIVITY_ANYBODY_ELSE,
  ACTIVITY_KINDS,
  attachmentDisposition,
  FILTER_VALUES_MAX,
} from '@fdv/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { needs } from '../authz.js';
import { errorForLog } from '../log-redaction.js';
import { activityCsv } from './csv.js';
import type { AuditService } from './service.js';

const query = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

/** A day on the calendar, YYYY-MM-DD, that is one, from 1900 to 9999: the database's too. */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A day is written YYYY-MM-DD.')
  .refine((d) => {
    const at = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === d;
  }, 'That is not a day on the calendar.')
  .refine((d) => d >= '1900-01-01', 'Choose a day from 1900 on.');

/**
 * A filter of several (0.9.0-dev.92, `features.multi_filters`): each value
 * given once, or several comma-separated, or both, as GET /documents takes
 * its filters of keys; each checked; none given, or only empty, is any
 * (`who=` alone, as `collection_id=` on the list). At most
 * `FILTER_VALUES_MAX` (422).
 */
const several = <T extends z.ZodTypeAny>(one: T) =>
  z.preprocess((raw) => {
    if (raw === undefined) return undefined;
    const all = (Array.isArray(raw) ? (raw as unknown[]) : [raw]).flatMap((v): unknown[] =>
      typeof v === 'string' ? v.split(',').map((x) => x.trim()) : [v],
    );
    const kept = [...new Set(all.filter((v) => v !== ''))];
    return kept.length > 0 ? kept : undefined;
  }, z.array(one).max(FILTER_VALUES_MAX).optional());

/** The Activity page's filters, as its address has them (each left out for any). */
const exportQuery = z
  .object({
    // Members' ids, or anybody else: any of them.
    who: several(z.union([z.literal(ACTIVITY_ANYBODY_ELSE), z.string().uuid()])),
    // Sorts of thing: any of them.
    kind: several(z.enum(ACTIVITY_KINDS.map((k) => k.value) as [string, ...string[]])),
    from: day.optional(),
    to: day.optional(),
    document: z.string().uuid().optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'From is after To: choose days in order.');

export function registerAudit(app: FastifyInstance, audit: AuditService): void {
  app.get('/api/v1/audit', { preHandler: [app.requireAuth, needs('audit.read')] }, async (req) =>
    audit.activity(req.principal as Principal, parse(query, req.query ?? {})),
  );
  /**
   * The activity log as CSV (0.9.0-dev.82; `features.activity_export`):
   * the lines the Activity page's filters keep — who, what sort of thing
   * (each any of several since 0.9.0-dev.92),
   * From and To days on the household's calendar, one document's lines —
   * as the log shows them to the caller, and nothing it does not; whoever
   * reads the log (`audit.read`). Streamed, at most
   * `ACTIVITY_CSV_MAX_LINES` lines, and a last row that says so past them.
   * Its own line in the log (`audit.exported`) is written as it ends. As
   * tight as the other routes that read a great deal at once.
   */
  app.get(
    '/api/v1/audit/export',
    {
      preHandler: [app.requireAuth, needs('audit.read')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      // A download that is a line in the log: never made to be thrown away.
      exposeHeadRoute: false,
    },
    async (req, reply) => {
      const ask = parse(exportQuery, req.query ?? {});
      const { filename, body } = await activityCsv(
        audit,
        req.principal as Principal,
        ask,
        metaOf(req),
        (err) => req.log.error({ error: errorForLog(err) }, 'an export’s line was not written'),
      );
      body.on('error', (err) =>
        req.log.error({ error: errorForLog(err) }, 'an activity export was not finished'),
      );
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', attachmentDisposition(filename));
      reply.header('cache-control', 'private, no-store');
      return reply.send(body);
    },
  );
  /**
   * One document's activity (0.9.0, DA): the log's lines about it, and
   * about the links that gave it — its own, and collections' links it was
   * ticked in or followed, removed ones too — each shown to exactly whom
   * the whole log shows it, paged as it is. Whoever reads the log
   * (`audit.read`); 404 for a document the caller cannot see.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/documents/:id/activity',
    { preHandler: [app.requireAuth, needs('audit.read')] },
    async (req) =>
      audit.activity(req.principal as Principal, {
        ...parse(query, req.query ?? {}),
        documentId: parse(idParam, req.params).id,
      }),
  );
}
