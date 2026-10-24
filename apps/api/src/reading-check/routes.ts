import type { FastifyInstance, FastifyRequest } from 'fastify';
import { READING_CHECK_N } from '@fdv/shared';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { LocalAiService } from '../household/local-ai.js';
import { ownerOnly, type ReadingCheckService } from './service.js';

/** The Reading check (0.9.0, R0): an owner's, every route. */
export function registerReadingCheck(
  app: FastifyInstance,
  checks: ReadingCheckService,
  /** The local AI's switch (0.9.0, R4), answered beside the reading model's. */
  localAi?: LocalAiService,
): void {
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
   * The household's reading settings (0.9.0): the vault's reading model (R2)
   * and the local AI (R4), each on or off. An owner's, both ways. A PUT
   * takes either switch or both, and nothing else: where the local AI is,
   * the operator's .env alone says (R4).
   */
  app.get('/api/v1/household/reading', owners, async (req) => ({
    ...(await checks.readingSettings(principal(req))),
    ...(localAi ? await localAi.get(principal(req)) : {}),
  }));
  app.put('/api/v1/household/reading', owners, async (req) => {
    const body = parse(
      z
        .object({ reading_model: z.boolean().optional(), local_ai: z.boolean().optional() })
        .strict()
        .refine((b) => b.reading_model !== undefined || b.local_ai !== undefined, {
          message: 'Send reading_model, local_ai or both.',
        }),
      req.body ?? {},
    );
    const p = principal(req);
    if (!localAi) {
      return checks.setReadingSettings(
        p,
        { reading_model: body.reading_model ?? true },
        metaOf(req),
      );
    }
    // Both switches in one transaction (the R4 review): both, or neither.
    const loaded = await checks.modelLoaded();
    return { ...(await localAi.setSwitches(p, body, metaOf(req))), loaded };
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
