import type { FastifyInstance } from 'fastify';
import { PROVIDER_PRESETS } from '@fdv/storage';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { VaultService } from './service.js';
import type { StepUpService } from '../auth/step-up.js';

const newVault = z.object({
  provider: z.string().min(1).max(32),
  label: z.string().trim().min(1).max(80).optional(),
  endpoint: z.string().trim().url().max(512).nullable().optional(),
  region: z.string().trim().max(64).nullable().optional(),
  bucket: z.string().trim().min(1).max(255),
  prefix: z.string().trim().max(255).nullable().optional(),
  path_style: z.boolean().optional(),
  access_key_id: z.string().min(1).max(512),
  secret_access_key: z.string().min(1).max(1024),
});

export function registerVaults(
  app: FastifyInstance,
  vaults: VaultService,
  stepUp?: StepUpService,
): void {
  const auth = { preHandler: app.requireAuth };

  /** The provider list the Storage screen offers, with presets. Public shape, no secrets. */
  app.get('/api/v1/vaults/providers', auth, async () =>
    Object.entries(PROVIDER_PRESETS).map(([key, p]) => ({ key, ...p })),
  );

  app.get('/api/v1/vaults', auth, async (req) => ({
    items: await vaults.list(req.principal as Principal),
  }));

  app.post('/api/v1/vaults', auth, async (req, reply) => {
    // Where the family's files live is as consequential as the files
    // themselves (SEC-17).
    await stepUp?.require(req.principal as Principal, 'change_storage');
    const b = parse(newVault, req.body);
    const created = await vaults.create(
      req.principal as Principal,
      {
        provider: b.provider,
        label: b.label,
        endpoint: b.endpoint,
        region: b.region,
        bucket: b.bucket,
        prefix: b.prefix,
        pathStyle: b.path_style,
        accessKeyId: b.access_key_id,
        secretAccessKey: b.secret_access_key,
      },
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  app.post<{ Params: { id: string } }>('/api/v1/vaults/:id/test', auth, async (req) =>
    vaults.test(req.principal as Principal, req.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/v1/vaults/:id/activate', auth, async (req, reply) => {
    await stepUp?.require(req.principal as Principal, 'change_storage');
    await vaults.activate(req.principal as Principal, req.params.id, metaOf(req));
    return reply.status(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/v1/vaults/:id', auth, async (req, reply) => {
    await stepUp?.require(req.principal as Principal, 'change_storage');
    await vaults.remove(req.principal as Principal, req.params.id, metaOf(req));
    return reply.status(204).send();
  });
}
