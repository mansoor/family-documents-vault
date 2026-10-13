import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { MailInService } from './service.js';

/** Email in (0.8.0, S4): an owner's setting, and each person's own address and code. */
export function registerMailIn(app: FastifyInstance, mail: MailInService): void {
  const auth = { preHandler: app.requireAuth };
  // An owner's: anybody else is refused before their form is read.
  const owners = {
    preHandler: [
      app.requireAuth,
      async (req: FastifyRequest) => {
        if (req.principal && req.principal.role !== 'owner') {
          throw new ApiError(403, 'forbidden', 'Only an owner can set up email in.');
        }
      },
    ],
  };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/mail-in', owners, async (req) => mail.get(principal(req)));

  app.put('/api/v1/mail-in', owners, async (req) => {
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    return mail.put(principal(req), body, metaOf(req));
  });

  app.get('/api/v1/mail-in/me', auth, async (req) => mail.mine(principal(req)));

  app.post('/api/v1/mail-in/me/code', auth, async (req, reply) => {
    const made = await mail.code(principal(req));
    // Shown once: never kept by anything in between.
    void reply.header('cache-control', 'no-store');
    return made;
  });

  // A code emailed to the caller's own address, and that code typed in (F1).
  app.post('/api/v1/mail-in/me/email-code', auth, async (req) => mail.emailCode(principal(req)));

  app.post('/api/v1/mail-in/me/confirm', auth, async (req, reply) => {
    const body = parse(z.object({ code: z.string().min(1).max(20) }).strict(), req.body);
    await mail.confirm(principal(req), body.code);
    return reply.status(204).send();
  });
}
