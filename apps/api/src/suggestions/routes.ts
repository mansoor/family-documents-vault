import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { SuggestionService } from './service.js';

/**
 * A suggestion key is `rule_key` or `rule_key:member_uuid`; it is a path
 * segment, so it is checked here rather than trusted into a uuid column.
 */
const key = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9_]+(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
    'That is not a suggestion.',
  );

export function registerSuggestions(app: FastifyInstance, suggestions: SuggestionService): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get<{ Querystring: { dismissed?: string } }>('/api/v1/suggestions', auth, async (req) =>
    suggestions.list(principal(req), { includeDismissed: req.query.dismissed === 'true' }),
  );

  app.post<{ Params: { key: string } }>(
    '/api/v1/suggestions/:key/dismiss',
    auth,
    async (req, reply) => {
      await suggestions.dismiss(principal(req), parse(key, req.params.key), metaOf(req));
      return reply.status(204).send();
    },
  );

  app.delete<{ Params: { key: string } }>(
    '/api/v1/suggestions/:key/dismiss',
    auth,
    async (req, reply) => {
      await suggestions.restore(principal(req), parse(key, req.params.key), metaOf(req));
      return reply.status(204).send();
    },
  );
}
