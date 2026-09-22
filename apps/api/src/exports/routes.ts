import type { FastifyInstance, FastifyRequest } from 'fastify';
import { metaOf } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { ExportService } from './service.js';

export function registerExports(app: FastifyInstance, exports: ExportService): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.post('/api/v1/exports', auth, async (req, reply) =>
    reply.status(202).send(await exports.request(principal(req), metaOf(req))),
  );
  app.get('/api/v1/exports', auth, async (req) => ({ items: await exports.list(principal(req)) }));
  app.get<{ Params: { id: string } }>('/api/v1/exports/:id', auth, async (req) =>
    exports.get(principal(req), req.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/v1/exports/:id/content', auth, async (req, reply) => {
    const { stream, bytes } = await exports.content(principal(req), req.params.id, metaOf(req));
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', 'attachment; filename="family-document-vault-export.zip"');
    reply.header('cache-control', 'private, no-store');
    if (bytes) reply.header('content-length', String(bytes));
    return reply.send(stream);
  });
}
