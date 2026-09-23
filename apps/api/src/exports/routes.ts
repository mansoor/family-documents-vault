import type { FastifyInstance, FastifyRequest } from 'fastify';
import { metaOf } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { ExportService } from './service.js';
import type { StepUpService } from '../auth/step-up.js';
import type { Capability } from '@fdv/shared';
import { needs } from '../authz.js';

export function registerExports(
  app: FastifyInstance,
  exports: ExportService,
  stepUp?: StepUpService,
): void {
  const auth = { preHandler: app.requireAuth };
  const guard = (c: Capability) => ({ preHandler: [app.requireAuth, needs(c)] });
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.post('/api/v1/exports', guard('export.request'), async (req, reply) => {
    // Everything you can see, in one file: worth asking who is asking.
    await stepUp?.require(principal(req), 'export_everything');
    return reply.status(202).send(await exports.request(principal(req), metaOf(req)));
  });
  app.get('/api/v1/exports', auth, async (req) => ({ items: await exports.list(principal(req)) }));
  app.get<{ Params: { id: string } }>('/api/v1/exports/:id', auth, async (req) =>
    exports.get(principal(req), req.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/v1/exports/:id/content', auth, async (req, reply) => {
    // It is everything its requester can see, "Only me" included, in one
    // file: a session picked up off a desk must not be able to take it.
    await stepUp?.require(principal(req), 'export_everything');
    const { stream, bytes } = await exports.content(principal(req), req.params.id, metaOf(req));
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', 'attachment; filename="family-document-vault-export.zip"');
    reply.header('cache-control', 'private, no-store');
    if (bytes) reply.header('content-length', String(bytes));
    return reply.send(stream);
  });
}
