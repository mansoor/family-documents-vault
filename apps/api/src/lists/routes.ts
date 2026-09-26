import { LIST_AUDIENCES, LIST_ITEMS_PAGE_MAX } from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { needs } from '../authz.js';
import type { ListService } from './service.js';

/**
 * Lists of documents (5.14). Everybody signed in reads them — a viewer is
 * given none (A17) — and the changes ask `list.manage` before they read
 * the body, so somebody who may not is told that first. Only a list's
 * maker changes it (A18): the service says so, once it has found the list.
 * A delete has no body, and its maker may delete their list whatever their
 * role now, so the service asks `list.manage` of anybody else.
 */

// Tidied and measured by the service, which says what is wrong in words.
const listBody = z
  .object({
    name: z.string().max(1000),
    description: z.string().max(5000).nullable(),
    audience: z.enum(LIST_AUDIENCES),
  })
  .partial()
  .strict();

const itemsBody = z.object({ document_ids: z.array(z.string().uuid()).min(1).max(200) }).strict();

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });

/** A page of a list's documents, as GET /documents pages its own. */
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_ITEMS_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
});

export function registerLists(app: FastifyInstance, lists: ListService): void {
  const auth = { preHandler: app.requireAuth };
  const manage = { preHandler: [app.requireAuth, needs('list.manage')] };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idOf = (req: FastifyRequest) => parse(idParam, req.params).id;

  app.get('/api/v1/lists', auth, async (req) => ({ items: await lists.lists(principal(req)) }));

  app.post('/api/v1/lists', manage, async (req, reply) => {
    const made = await lists.create(principal(req), parse(listBody, req.body ?? {}), metaOf(req));
    reply.header('etag', made.etag);
    return reply.status(201).send(made);
  });

  app.get('/api/v1/lists/:id', auth, async (req, reply) => {
    const list = await lists.get(principal(req), idOf(req), parse(pageQuery, req.query ?? {}));
    reply.header('etag', list.etag);
    return list;
  });

  /**
   * Its name, words or audience, made to the list as the caller saw it: a
   * stale If-Match is `409 conflict`, with the list as it now is in `detail`.
   */
  app.patch('/api/v1/lists/:id', manage, async (req, reply) => {
    const ifMatch = req.headers['if-match'];
    const changed = await lists.update(
      principal(req),
      idOf(req),
      parse(listBody, req.body ?? {}),
      typeof ifMatch === 'string' ? ifMatch : undefined,
      metaOf(req),
    );
    reply.header('etag', changed.etag);
    return changed;
  });

  app.delete('/api/v1/lists/:id', auth, async (req, reply) => {
    await lists.remove(principal(req), idOf(req), metaOf(req));
    return reply.status(204).send();
  });

  app.post('/api/v1/lists/:id/items', manage, async (req, reply) => {
    const list = await lists.addItems(
      principal(req),
      idOf(req),
      parse(itemsBody, req.body ?? {}).document_ids,
      metaOf(req),
    );
    reply.header('etag', list.etag);
    return list;
  });

  app.delete('/api/v1/lists/:id/items/:documentId', manage, async (req, reply) => {
    const { id, documentId } = parse(itemParam, req.params);
    await lists.removeItem(principal(req), id, documentId, metaOf(req));
    return reply.status(204).send();
  });

  app.get('/api/v1/documents/:id/lists', auth, async (req) => ({
    items: await lists.ofDocument(principal(req), idOf(req)),
  }));
}
