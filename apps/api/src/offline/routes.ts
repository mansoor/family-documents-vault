import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { OfflineService } from './service.js';

const grantBody = z.object({
  password: z.string().min(1).max(1024),
  include_private: z.boolean().optional(),
});

const pageParams = z.object({
  version: z.string().uuid(),
  n: z.coerce.number().int().min(1).max(9999),
});

const opensBody = z.object({
  events: z
    .array(
      z.object({
        id: z.string().uuid(),
        version_id: z.string().uuid(),
        opened_at: z.string().datetime({ offset: true }),
        mode: z.enum(['view', 'show']),
        online: z.boolean(),
      }),
    )
    .max(200),
});

/** Essentials a phone may keep (0.4.13): the grant, the set, its pages, and what was opened. */
export function registerOffline(app: FastifyInstance, offline: OfflineService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  // The password, tried: as tight as signing in.
  app.post(
    '/api/v1/offline/grant',
    { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => offline.grant(principal(req), parse(grantBody, req.body ?? {}), metaOf(req)),
  );

  app.delete('/api/v1/offline/grant', auth, async (req, reply) => {
    await offline.endGrant(principal(req), metaOf(req));
    return reply.status(204).send();
  });

  app.get('/api/v1/offline/essentials', auth, async (req, reply) => {
    // Titles, people and dates: for this person, now.
    void reply.header('cache-control', 'private, no-store');
    return offline.set(principal(req));
  });

  app.get<{ Params: { version: string; n: string } }>(
    '/api/v1/offline/pages/:version/:n',
    auth,
    async (req, reply) => {
      const { version, n } = parse(pageParams, req.params);
      const bytes = await offline.page(principal(req), version, n, metaOf(req));
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, no-store');
      return reply.send(bytes);
    },
  );

  app.post('/api/v1/offline/opens', auth, async (req) =>
    offline.opens(principal(req), parse(opensBody, req.body ?? {}).events, metaOf(req)),
  );
}
