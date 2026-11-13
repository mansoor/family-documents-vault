import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import {
  deviceBody,
  myWordingBody,
  neutralWordingBody,
  preferenceBody,
  smtpBody,
  SMTP_PRESETS,
  type NotificationService,
} from './service.js';
import type { Capability } from '@fdv/shared';
import { needs } from '../authz.js';

export function registerNotifications(
  app: FastifyInstance,
  notifications: NotificationService,
  stepUp: StepUpService,
): void {
  const auth = { preHandler: app.requireAuth };
  const guard = (c: Capability) => ({ preHandler: [app.requireAuth, needs(c)] });
  const principal = (req: FastifyRequest) => req.principal as Principal;

  // Public: the browser needs this before it can ask for permission.
  app.get('/api/v1/notifications/push-key', async () => notifications.pushKey());

  app.get('/api/v1/devices', auth, async (req) => ({
    items: await notifications.devices(principal(req)),
  }));

  app.post('/api/v1/devices', auth, async (req, reply) =>
    reply
      .status(201)
      .send(
        await notifications.registerDevice(
          principal(req),
          parse(deviceBody, req.body),
          metaOf(req),
        ),
      ),
  );

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/test', auth, async (req, reply) => {
    await notifications.testDevice(principal(req), parse(z.string().uuid(), req.params.id));
    return reply.status(202).send({ queued: true });
  });

  app.delete('/api/v1/devices', auth, async (req, reply) => {
    const body = parse(z.object({ endpoint: z.string().url().max(2048) }), req.body);
    await notifications.removeDevice(principal(req), body.endpoint);
    return reply.status(204).send();
  });

  app.get('/api/v1/notifications/preferences', auth, async (req) =>
    notifications.preferences(principal(req)),
  );
  app.put('/api/v1/notifications/preferences', auth, async (req) =>
    notifications.updatePreferences(principal(req), parse(preferenceBody, req.body ?? {})),
  );

  // Neutral wording in notifications and email (0.9.0, H2): the household's,
  // an owner's — naming more documents asks them to confirm it's them, in
  // the same transaction that decides it does; and each person's own, beside
  // the household's (a line is neutral when either says so) — naming more in
  // what is sent to them asks the same.
  app.get('/api/v1/household/neutral-wording', auth, async (req) =>
    notifications.neutralWording(principal(req)),
  );
  app.put('/api/v1/household/neutral-wording', auth, async (req) => {
    const body = parse(neutralWordingBody, req.body ?? {});
    const p = principal(req);
    return notifications.setNeutralWording(p, body.neutral_wording, metaOf(req), async (trx) =>
      stepUp.require(p, 'neutral_wording', trx),
    );
  });
  app.get('/api/v1/notifications/wording', auth, async (req) =>
    notifications.myWording(principal(req)),
  );
  app.put('/api/v1/notifications/wording', auth, async (req) => {
    const body = parse(myWordingBody, req.body ?? {});
    const p = principal(req);
    return notifications.setMyWording(p, body.neutral_wording, async (trx) =>
      stepUp.require(p, 'neutral_wording', trx),
    );
  });

  app.get('/api/v1/notifications/smtp/providers', auth, async () =>
    Object.entries(SMTP_PRESETS).map(([key, p]) => ({ key, ...p })),
  );
  app.get('/api/v1/notifications/smtp', auth, async (req) => notifications.smtp(principal(req)));
  app.put('/api/v1/notifications/smtp', guard('notifications.manage'), async (req) =>
    notifications.saveSmtp(principal(req), parse(smtpBody, req.body), metaOf(req)),
  );
  app.post('/api/v1/notifications/smtp/test', guard('notifications.manage'), async (req) =>
    notifications.testSmtp(principal(req), metaOf(req)),
  );
}
