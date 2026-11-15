import {
  ARRANGE_BY,
  CABINET_LIMITS,
  CABINET_NODE_ID,
  DIVIDER_LIMITS,
  DOCUMENT_PAGE_MAX,
  PIN_LIMITS,
} from '@fdv/shared';
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
/** A divider's day, or open: checked as a real day, in words, by `dividersProblemOf`. */
const dividerDay = z.string().max(10).nullable();
/**
 * A folder's dividers (0.9.0, C2). Each range's name and days, how many,
 * and two that overlap, are checked again by `layoutProblemOf`, each with
 * its own code.
 */
const dividers = z
  .object({
    years: z.boolean(),
    ranges: z
      .array(
        z
          .object({
            name: z.string().max(DIVIDER_LIMITS.name * 4),
            from: dividerDay,
            to: dividerDay,
          })
          .strict(),
      )
      .max(DIVIDER_LIMITS.ranges * 5),
  })
  .strict();
const folder = z
  .object({
    id,
    name,
    hidden: z.boolean(),
    filter: z.record(z.string(), z.unknown()),
    dividers: dividers.optional(),
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
  .object({
    layout: layoutBody,
    version: z.number().int().min(0).max(2_147_483_647),
    // Folders merged into others, their pins moved with them (C2).
    pins_moved: z
      .array(z.object({ from: id, to: id }).strict())
      .max(CABINET_LIMITS.folders_total)
      .optional(),
  })
  .strict();
const pinsBody = z
  .object({ document_ids: z.array(z.string().max(64)).min(1).max(PIN_LIMITS.folder) })
  .strict();
const dividerQuery = z
  .object({
    divider: z.string().min(1).max(40),
    cursor: z.string().max(8192).optional(),
    limit: z.coerce.number().int().min(1).max(DOCUMENT_PAGE_MAX).optional(),
  })
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
    return cabinet.save(principal(req), body.layout, body.version, body.pins_moved ?? []);
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

  // Dividers and pins (0.9.0, C2, `features.cabinet_dividers`, `cabinet_pins`):
  // a folder of the caller's own, by its id in their layout.
  app.get<{ Params: { id: string } }>('/api/v1/cabinet/folders/:id', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.folder(principal(req), req.params.id);
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/cabinet/folders/:id/documents',
    auth,
    async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const q = parse(dividerQuery, req.query ?? {});
      return cabinet.folderDocuments(principal(req), req.params.id, q);
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/cabinet/folders/:id/pins', auth, async (req) => {
    const body = parse(pinsBody, req.body ?? {});
    return cabinet.pin(principal(req), req.params.id, body.document_ids);
  });

  app.delete<{ Params: { id: string; documentId: string } }>(
    '/api/v1/cabinet/folders/:id/pins/:documentId',
    auth,
    async (req, reply) => {
      await cabinet.unpin(principal(req), req.params.id, req.params.documentId);
      return reply.status(204).send();
    },
  );
}
