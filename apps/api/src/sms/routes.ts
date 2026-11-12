import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SMS_CAP_MAX, SMS_CAP_MIN } from '@fdv/shared';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { ApiError } from '../errors.js';
import type { MemberPhoneService } from './phones.js';
import type { SmsService } from './service.js';

/** Text messages (0.9.0, SMS1): an owner's setting, and each person's mobile number. */
export function registerSms(
  app: FastifyInstance,
  sms: SmsService,
  phones: MemberPhoneService,
  stepUp?: StepUpService,
): void {
  const auth = { preHandler: app.requireAuth };
  // An owner's: anybody else is refused before their form is read.
  const owners = {
    preHandler: [
      app.requireAuth,
      async (req: FastifyRequest) => {
        if (req.principal && req.principal.role !== 'owner') {
          throw new ApiError(403, 'forbidden', 'Only an owner can set up text messages.');
        }
      },
    ],
  };
  // What texts a code, or takes one: as /shared/code is, a few a minute
  // from one address, on top of the limits a number has of its own.
  const tight = {
    preHandler: app.requireAuth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });
  const noStore = { 'cache-control': 'no-store' };

  // Whether to offer a mobile number at all: anybody signed in.
  app.get('/api/v1/sms/status', auth, async (req) => ({
    ready: await sms.ready(principal(req)),
  }));

  // The household's SMS Gate. Its password is sealed, never returned (`set`
  // or `not_set`), never logged, never in an export.
  app.get('/api/v1/sms/settings', owners, async (req, reply) => {
    void reply.headers(noStore);
    return sms.get(principal(req));
  });

  app.put('/api/v1/sms/settings', owners, async (req, reply) => {
    const body = parse(
      z
        .object({
          mode: z.enum(['local', 'cloud', 'private']),
          base_url: z.string().max(2048).nullable().optional(),
          username: z.string().min(1).max(200),
          password: z.string().min(1).max(1024).optional(),
          country: z.string().min(2).max(2),
          monthly_cap: z.number().int().min(SMS_CAP_MIN).max(SMS_CAP_MAX),
        })
        .strict(),
      req.body,
    );
    // Where the vault signs in, with which password, and so where the codes
    // that confirm the family's numbers go: confirmed it is them.
    await stepUp?.require(principal(req), 'change_sms');
    void reply.headers(noStore);
    return sms.put(principal(req), body, metaOf(req));
  });

  app.delete('/api/v1/sms/settings', owners, async (req, reply) => {
    void reply.headers(noStore);
    return sms.remove(principal(req), metaOf(req));
  });

  // A test text, to the number typed, through the settings saved: it must
  // pass before any other text is sent.
  app.post(
    '/api/v1/sms/settings/test',
    { ...owners, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(z.object({ number: z.string().min(1).max(40) }).strict(), req.body);
      void reply.headers(noStore);
      return sms.test(principal(req), body.number, metaOf(req));
    },
  );

  // Somebody's mobile number: their own, or an owner's for anybody.
  app.get('/api/v1/members/:id/phone', auth, async (req, reply) => {
    void reply.headers(noStore);
    return phones.get(principal(req), parse(idParam, req.params).id);
  });

  app.put('/api/v1/members/:id/phone', tight, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    const body = parse(z.object({ number: z.string().min(1).max(40) }).strict(), req.body);
    void reply.headers(noStore);
    return phones.put(principal(req), id, body.number, metaOf(req));
  });

  app.post('/api/v1/members/:id/phone/confirm', tight, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    const body = parse(z.object({ code: z.string().min(1).max(20) }).strict(), req.body);
    void reply.headers(noStore);
    return phones.confirm(principal(req), id, body.code, metaOf(req));
  });

  app.post('/api/v1/members/:id/phone/resend', tight, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    void reply.headers(noStore);
    return phones.resend(principal(req), id);
  });

  app.delete('/api/v1/members/:id/phone', auth, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    void reply.headers(noStore);
    return phones.remove(principal(req), id, metaOf(req));
  });
}
