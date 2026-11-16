import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { needs } from '../authz.js';
import type { AuditService } from './service.js';

const query = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

export function registerAudit(app: FastifyInstance, audit: AuditService): void {
  app.get('/api/v1/audit', { preHandler: [app.requireAuth, needs('audit.read')] }, async (req) =>
    audit.activity(req.principal as Principal, parse(query, req.query ?? {})),
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
