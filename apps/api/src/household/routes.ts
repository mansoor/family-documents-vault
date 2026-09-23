import type { FastifyInstance, FastifyRequest } from 'fastify';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { memberBody, profileBody, type HouseholdService } from './service.js';
import type { StepUpService } from '../auth/step-up.js';

export function registerHousehold(
  app: FastifyInstance,
  household: HouseholdService,
  stepUp?: StepUpService,
): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/profile', auth, async (req) => household.profile(principal(req)));
  app.put('/api/v1/profile', auth, async (req) =>
    household.updateProfile(principal(req), parse(profileBody, req.body ?? {}), metaOf(req)),
  );

  app.get('/api/v1/members', auth, async (req) => ({
    items: await household.members(principal(req)),
  }));
  app.post('/api/v1/members', auth, async (req, reply) => {
    // Who is in the family decides who can see what, so it asks (SEC-17).
    await stepUp?.require(principal(req), 'change_people');
    const m = await household.addMember(principal(req), parse(memberBody, req.body), metaOf(req));
    return reply.status(201).send(m);
  });
}
