import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { memberBody, profileBody, type HouseholdService } from './service.js';
import {
  acceptBody,
  inviteBody,
  inviteExistingBody,
  type InvitationService,
} from './invitations.js';
import type { StepUpService } from '../auth/step-up.js';
import type { Capability } from '@fdv/shared';
import { needs } from '../authz.js';

export function registerHousehold(
  app: FastifyInstance,
  household: HouseholdService,
  stepUp?: StepUpService,
  invitations?: InvitationService,
): void {
  const auth = { preHandler: app.requireAuth };
  const guard = (c: Capability) => ({ preHandler: [app.requireAuth, needs(c)] });
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/profile', auth, async (req) => household.profile(principal(req)));
  app.put('/api/v1/profile', guard('profile.edit'), async (req) =>
    household.updateProfile(principal(req), parse(profileBody, req.body ?? {}), metaOf(req)),
  );

  app.get('/api/v1/members', auth, async (req) => ({
    items: await household.members(principal(req)),
  }));
  app.post('/api/v1/members', guard('member.add'), async (req, reply) => {
    // Who is in the family decides who can see what, so it asks (SEC-17).
    await stepUp?.require(principal(req), 'change_people');
    const m = await household.addMember(principal(req), parse(memberBody, req.body), metaOf(req));
    return reply.status(201).send(m);
  });

  if (!invitations) return;

  const params = <T>(schema: z.ZodType<T>, req: FastifyRequest) => parse(schema, req.params);
  const idParam = z.object({ id: z.string().uuid() });
  // A link secret, not a uuid: base64url of 32 bytes.
  const tokenParam = z.object({ token: z.string().min(16).max(256) });

  app.get('/api/v1/invitations', guard('member.invite'), async (req) => ({
    items: await invitations.list(principal(req)),
  }));

  app.post('/api/v1/invitations', auth, async (req, reply) => {
    await stepUp?.require(principal(req), 'change_people');
    const created = await invitations.create(
      principal(req),
      parse(inviteBody, req.body),
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  // The spelling the API specification uses, for an existing person.
  app.post('/api/v1/members/:id/invite', auth, async (req, reply) => {
    await stepUp?.require(principal(req), 'change_people');
    const body = parse(inviteExistingBody, req.body);
    const created = await invitations.create(
      principal(req),
      { ...body, member_id: params(idParam, req).id },
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  app.delete('/api/v1/invitations/:id', guard('member.invite'), async (req, reply) => {
    await invitations.revoke(principal(req), params(idParam, req).id, metaOf(req));
    return reply.status(204).send();
  });

  // The two unauthenticated ones: the invitee has no account yet, by
  // definition. Both are rate-limited like sign-in, because the link
  // secret and the code are the only things standing in front of them.
  const tight = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/v1/invitations/:token', tight, async (req) =>
    invitations.preview(params(tokenParam, req).token),
  );

  app.post('/api/v1/invitations/:token/accept', tight, async (req, reply) => {
    const tokens = await invitations.accept(
      params(tokenParam, req).token,
      parse(acceptBody, req.body),
      metaOf(req),
    );
    return reply.status(201).send(tokens);
  });
}
