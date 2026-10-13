import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ownerOnly, type WatchFolderService } from './service.js';

/** The scanner folder (0.8.0, S3): an owner's setting, and the notes it leaves its person. */
export function registerWatchFolder(app: FastifyInstance, watch: WatchFolderService): void {
  const auth = { preHandler: app.requireAuth };
  // An owner's: anybody else is refused before their form is read.
  const owners = {
    preHandler: [
      app.requireAuth,
      async (req: FastifyRequest) => {
        if (req.principal) ownerOnly(req.principal);
      },
    ],
  };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/watch-folder', owners, async (req) => watch.get(principal(req)));

  app.put('/api/v1/watch-folder', owners, async (req) => {
    const p = principal(req);
    const body = parse(
      z
        .object({
          enabled: z.boolean(),
          member_id: z.string().uuid().nullable().optional(),
        })
        .strict(),
      req.body,
    );
    return watch.put(p, body, metaOf(req));
  });

  app.get('/api/v1/watch-folder/notices', auth, async (req) => ({
    items: await watch.notices(principal(req)),
  }));

  app.post<{ Params: { id: string } }>(
    '/api/v1/watch-folder/notices/:id/dismiss',
    auth,
    async (req, reply) => {
      await watch.dismiss(principal(req), req.params.id);
      return reply.status(204).send();
    },
  );
}
