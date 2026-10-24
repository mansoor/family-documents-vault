import type { FastifyInstance, FastifyRequest } from 'fastify';
import { READING_CHECK_N } from '@fdv/shared';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ownerOnly, type ReadingCheckService } from './service.js';

/** The Reading check (0.9.0, R0): an owner's, every route. */
export function registerReadingCheck(app: FastifyInstance, checks: ReadingCheckService): void {
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

  app.get('/api/v1/reading-checks', owners, async (req) => checks.list(principal(req)));

  app.post('/api/v1/reading-checks', owners, async (req, reply) => {
    const body = parse(
      z
        .object({
          n: z
            .number()
            .int('How many documents must be a whole number.')
            .min(READING_CHECK_N.min, `Read at least ${READING_CHECK_N.min} documents.`)
            .max(READING_CHECK_N.max, `Read at most ${READING_CHECK_N.max} documents.`)
            .optional(),
          include_edited: z.boolean().optional(),
        })
        .strict(),
      req.body ?? {},
    );
    return reply.status(202).send(await checks.start(principal(req), body));
  });

  app.get<{ Params: { id: string } }>('/api/v1/reading-checks/:id', owners, async (req) =>
    checks.get(principal(req), req.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/v1/reading-checks/:id/cancel', owners, async (req) =>
    checks.cancel(principal(req), req.params.id),
  );

  /**
   * The household's reading settings (0.9.0, R2): the vault's reading model
   * on or off. An owner's, both ways.
   */
  app.get('/api/v1/household/reading', owners, async (req) =>
    checks.readingSettings(principal(req)),
  );
  app.put('/api/v1/household/reading', owners, async (req) => {
    const body = parse(z.object({ reading_model: z.boolean() }).strict(), req.body ?? {});
    return checks.setReadingSettings(principal(req), body, metaOf(req));
  });

  app.delete<{ Params: { id: string } }>(
    '/api/v1/reading-checks/:id',
    owners,
    async (req, reply) => {
      await checks.remove(principal(req), req.params.id);
      return reply.status(204).send();
    },
  );
}
