import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { CaregiverService } from './service.js';

const nameBody = z.object({ caregiver_member_id: z.string().max(64) }).strict();
const answerBody = z.object({ answer: z.enum(['keep', 'only_me']) }).strict();

/**
 * Caregivers for somebody's medical papers, and turning 18 (0.9.0, H1b,
 * `features.caregivers`). Whoever is signed in asks; the service and the
 * database say what each may see and do.
 */
export function registerCaregivers(app: FastifyInstance, caregivers: CaregiverService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/caregivers', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return caregivers.mine(principal(req));
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/members/:id/caregivers',
    auth,
    async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      return caregivers.ofPerson(principal(req), req.params.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/members/:id/caregivers',
    auth,
    async (req, reply) => {
      const body = parse(nameBody, req.body ?? {});
      const made = await caregivers.name(
        principal(req),
        req.params.id,
        body.caregiver_member_id,
        metaOf(req),
      );
      return reply.status(201).send(made);
    },
  );

  app.post<{ Params: { id: string; caregiverId: string } }>(
    '/api/v1/members/:id/caregivers/:caregiverId/keep',
    auth,
    async (req) =>
      caregivers.keep(principal(req), req.params.id, req.params.caregiverId, metaOf(req)),
  );

  app.post<{ Params: { id: string; caregiverId: string } }>(
    '/api/v1/members/:id/caregivers/:caregiverId/revoke',
    auth,
    async (req, reply) => {
      await caregivers.revoke(principal(req), req.params.id, req.params.caregiverId, metaOf(req));
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/members/:id/caregiver-views',
    auth,
    async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      return caregivers.looks(principal(req), req.params.id);
    },
  );

  app.get('/api/v1/grown-up/questions', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return caregivers.questions(principal(req));
  });

  app.post<{ Params: { id: string } }>('/api/v1/members/:id/grown-up-answer', auth, async (req) => {
    const body = parse(answerBody, req.body ?? {});
    return caregivers.answer(principal(req), req.params.id, body.answer, metaOf(req));
  });
}
