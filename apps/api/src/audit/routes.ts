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

export function registerAudit(app: FastifyInstance, audit: AuditService): void {
  app.get('/api/v1/audit', { preHandler: [app.requireAuth, needs('audit.read')] }, async (req) =>
    audit.activity(req.principal as Principal, parse(query, req.query ?? {})),
  );
}
