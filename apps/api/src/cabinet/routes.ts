import { ARRANGE_BY, CABINET_LIMITS, CABINET_NODE_ID } from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { CabinetService } from './service.js';

/**
 * A layout's shape as it is sent. Each name is checked again, in words, by
 * `layoutProblem` (@fdv/shared); each folder's question by the list's own
 * parser (the service's `checkLayout`).
 */
const id = z.string().regex(CABINET_NODE_ID, 'Each part of a cabinet needs its own id.');
const name = z.string().max(CABINET_LIMITS.name * 4);
const folder = z
  .object({
    id,
    name,
    hidden: z.boolean(),
    filter: z.record(z.string(), z.unknown()),
  })
  .strict();
const drawer = z
  .object({ id, name, hidden: z.boolean(), folders: z.array(folder).max(CABINET_LIMITS.folders) })
  .strict();
const cabinet = z
  .object({ id, name, hidden: z.boolean(), drawers: z.array(drawer).max(CABINET_LIMITS.drawers) })
  .strict();
const layoutBody = z
  .object({
    arranged_by: z.enum(ARRANGE_BY).nullable(),
    cabinets: z.array(cabinet).max(CABINET_LIMITS.cabinets),
  })
  .strict();
const saveBody = z
  .object({ layout: layoutBody, version: z.number().int().min(0).max(2_147_483_647) })
  .strict();
const previewBody = z.object({ arrange_by: z.enum(ARRANGE_BY) }).strict();

/**
 * My cabinet (0.9.0, C1, `features.cabinets`): the caller's own, whoever
 * is signed in — a viewer and a guest too, whose folders only ever narrow
 * what they are given. Nothing here is anybody else's.
 */
export function registerCabinet(app: FastifyInstance, cabinet: CabinetService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/cabinet', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.get(principal(req));
  });

  app.put('/api/v1/cabinet', auth, async (req) => {
    const body = parse(saveBody, req.body ?? {});
    return cabinet.save(principal(req), body.layout, body.version);
  });

  app.post('/api/v1/cabinet/preview', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const body = parse(previewBody, req.body ?? {});
    return cabinet.preview(principal(req), body.arrange_by);
  });

  app.get('/api/v1/cabinet/counts', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.counts(principal(req));
  });

  app.get<{ Params: { id: string } }>('/api/v1/documents/:id/also-in', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.alsoIn(principal(req), req.params.id);
  });
}
