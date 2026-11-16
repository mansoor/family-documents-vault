import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { emergencyShareBody, type ShareService } from '../documents/shares.js';
import {
  emergencyAudienceBody,
  emergencyEtag,
  emergencyWriteBody,
  type EmergencyService,
} from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const linkParam = z.object({ id: z.string().uuid(), linkId: z.string().uuid() });

/**
 * A person's emergency information (0.9.0, H4, `features.emergency_info`):
 * their page, who sees it, and a clinician's link to it that lasts hours.
 * Whoever is signed in asks; the service and the database say what each
 * may see and do. Never cached, never indexed: it is Health.
 */
export function registerEmergency(
  app: FastifyInstance,
  emergency: EmergencyService,
  shares: ShareService,
  stepUp?: StepUpService,
) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const private_ = (reply: FastifyReply) => {
    void reply.header('cache-control', 'no-store');
    void reply.header('x-robots-tag', 'noindex, nofollow');
  };

  app.get('/api/v1/members/:id/emergency', auth, async (req, reply) => {
    const view = await emergency.get(principal(req), parse(idParam, req.params).id);
    private_(reply);
    void reply.header('etag', emergencyEtag(view.version));
    return view;
  });

  /** The whole page, If-Match its version (a stale one is `409 conflict`). */
  app.put('/api/v1/members/:id/emergency', auth, async (req, reply) => {
    const ifMatch = req.headers['if-match'];
    const view = await emergency.put(
      principal(req),
      parse(idParam, req.params).id,
      parse(emergencyWriteBody, req.body ?? {}),
      typeof ifMatch === 'string' ? ifMatch : undefined,
      metaOf(req),
    );
    private_(reply);
    void reply.header('etag', emergencyEtag(view.version));
    return view;
  });

  app.put('/api/v1/members/:id/emergency/audience', auth, async (req, reply) => {
    const view = await emergency.setAudience(
      principal(req),
      parse(idParam, req.params).id,
      parse(emergencyAudienceBody, req.body ?? {}),
      metaOf(req),
    );
    private_(reply);
    void reply.header('etag', emergencyEtag(view.version));
    return view;
  });

  /** The person's clinician's links, each with who opened it and when: theirs and the owners'. */
  app.get('/api/v1/members/:id/emergency/links', auth, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    await emergency.mayListLinks(principal(req), id);
    private_(reply);
    return { items: await shares.emergencyLinks(principal(req), id) };
  });

  /**
   * A clinician's link: who may first, then the body, then a credential
   * (`share_emergency`) — nobody is asked to confirm it's them about a page
   * that is not theirs to share.
   */
  app.post(
    '/api/v1/members/:id/emergency/links',
    { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const id = parse(idParam, req.params).id;
      await shares.emergencyShareable(principal(req), id);
      const body = parse(emergencyShareBody, req.body ?? {});
      if (stepUp) await stepUp.require(principal(req), 'share_emergency');
      const made = await shares.createForEmergency(principal(req), id, body, metaOf(req));
      private_(reply);
      return reply.status(201).send(made);
    },
  );

  app.delete('/api/v1/members/:id/emergency/links/:linkId', auth, async (req, reply) => {
    const { id, linkId } = parse(linkParam, req.params);
    await emergency.mayListLinks(principal(req), id);
    await shares.revokeEmergency(principal(req), id, linkId, metaOf(req));
    return reply.status(204).send();
  });
}
