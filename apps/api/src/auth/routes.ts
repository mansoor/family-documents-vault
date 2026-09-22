import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { AuthService, Principal, RequestMeta } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Use at least 10 characters.').max(1024);

const setupBody = z.object({
  household_name: z.string().trim().min(1).max(120),
  display_name: z.string().trim().min(1).max(120),
  email,
  password,
});
const passwordBody = z.object({ email, password: z.string().min(1).max(1024) });
const refreshBody = z.object({ refresh_token: z.string().min(1).max(512) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ApiError(422, 'validation_failed', first?.message ?? 'Please check the form.', {
      detail: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  return r.data;
}

export function metaOf(req: FastifyRequest): RequestMeta {
  return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
}

/**
 * Registers the auth decorator and routes. `app.requireAuth` is a preHandler
 * any route can use; it populates `request.principal` or fails with the
 * envelope.
 */
export function registerAuth(app: FastifyInstance, auth: AuthService): void {
  app.decorateRequest('principal', null);

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new ApiError(401, 'unauthenticated', 'Please sign in.');
    }
    req.principal = await auth.authenticate(token);
  });

  const tight = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/v1/setup', tight, async (req, reply) => {
    const body = parse(setupBody, req.body);
    const tokens = await auth.setup(
      {
        householdName: body.household_name,
        displayName: body.display_name,
        email: body.email,
        password: body.password,
      },
      metaOf(req),
    );
    return reply.status(201).send(tokens);
  });

  app.post('/api/v1/auth/password', tight, async (req) => {
    const body = parse(passwordBody, req.body);
    return auth.signInWithPassword(body.email, body.password, metaOf(req));
  });

  app.post('/api/v1/auth/refresh', tight, async (req) => {
    const body = parse(refreshBody, req.body);
    return auth.refresh(body.refresh_token, metaOf(req));
  });

  app.post('/api/v1/auth/logout', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = req.principal as Principal;
    await auth.revokeSession(p, p.sessionId, metaOf(req), 'logout');
    return reply.status(204).send();
  });

  app.get('/api/v1/auth/sessions', { preHandler: app.requireAuth }, async (req) => {
    return { items: await auth.listSessions(req.principal as Principal) };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/v1/auth/sessions/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      await auth.revokeSession(req.principal as Principal, req.params.id, metaOf(req), 'revoked');
      return reply.status(204).send();
    },
  );

  app.get('/api/v1/me', { preHandler: app.requireAuth }, async (req) => {
    const p = req.principal as Principal;
    return {
      account_id: p.accountId,
      household_id: p.householdId,
      member_id: p.memberId,
      role: p.role,
    };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<void>;
  }
}
