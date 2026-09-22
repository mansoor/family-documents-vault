import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/routes.js';
import type { AuthService } from './auth/service.js';
import { buildCapabilities } from './capabilities.js';
import type { ApiConfig } from './config.js';
import { ApiError, notFound, notReady } from './errors.js';

/**
 * What the HTTP layer needs from the outside world. Kept as an interface so
 * tests can hand in fakes and the server wires in the real database.
 */
export interface AppDeps {
  serverVersion: string;
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
  auth: AuthService;
  logger?: boolean | object;
}

export async function buildApp(config: ApiConfig, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? { level: config.LOG_LEVEL },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setNotFoundHandler((req, reply) => {
    const err = notFound();
    void reply.status(err.status).send(err.toBody(req.id));
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      void reply.status(err.status).send(err.toBody(req.id));
      return;
    }
    const status =
      typeof (err as { statusCode?: number }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    const wrapped = new ApiError(
      status,
      status >= 500 ? 'internal_error' : 'bad_request',
      status >= 500
        ? 'Something went wrong on the server. It has been logged.'
        : ((err as Error).message ?? 'The request could not be understood.'),
      { retriable: status >= 500 },
    );
    void reply.status(status).send(wrapped.toBody(req.id));
  });

  // Liveness: the process is up. No dependencies consulted.
  app.get('/healthz', async () => ({ ok: true }));

  // Readiness: the process can do useful work.
  app.get('/readyz', async () => {
    try {
      await deps.pingDatabase();
    } catch (err) {
      throw notReady((err as Error).message);
    }
    return { ok: true };
  });

  // Auth endpoints get a tight per-route limit (see routes); this is the
  // ceiling for everything else.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  // API-01: the first call any client makes. Unauthenticated, cacheable.
  app.get('/api/v1/capabilities', async (_req, reply) => {
    const setupRequired = !(await deps.auth.setupComplete());
    const householdName = setupRequired ? null : await deps.auth.displayName();
    // The document is cacheable — except while setup is pending, because a
    // cached "setup_required: true" would show the wizard again after setup.
    reply.header('cache-control', setupRequired ? 'no-store' : 'public, max-age=300');
    return buildCapabilities({
      serverVersion: deps.serverVersion,
      edition: config.FDV_EDITION,
      displayName: householdName ?? config.FDV_DISPLAY_NAME,
      maxUploadBytes: config.FDV_MAX_UPLOAD_BYTES,
      setupRequired,
    });
  });

  registerAuth(app, deps.auth);

  return app;
}
