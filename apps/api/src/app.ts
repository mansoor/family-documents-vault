import Fastify, { type FastifyInstance } from 'fastify';
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
  logger?: boolean | object;
}

export function buildApp(config: ApiConfig, deps: AppDeps): FastifyInstance {
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

  const capabilities = buildCapabilities({
    serverVersion: deps.serverVersion,
    edition: config.FDV_EDITION,
    displayName: config.FDV_DISPLAY_NAME,
    maxUploadBytes: config.FDV_MAX_UPLOAD_BYTES,
  });

  // API-01: the first call any client makes. Unauthenticated, cacheable.
  app.get('/api/v1/capabilities', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return capabilities;
  });

  return app;
}
