import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { DocumentService } from './service.js';

const dateValue = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    precision: z.enum(['day', 'month', 'year']),
  })
  .nullable();

const documentBody = z
  .object({
    type_key: z.string().min(1).max(64).nullable(),
    title: z.string().max(200).nullable(),
    owner_member_id: z.string().uuid().nullable(),
    category: z.string().min(1).max(64).nullable(),
    visibility: z.enum(['household', 'adults', 'private']),
    issued: dateValue,
    expires: dateValue,
    identifier: z.string().max(200).nullable(),
    physical_location: z.string().max(500).nullable(),
    is_essential: z.boolean(),
    tags: z.array(z.string().max(40)).max(50),
    notes: z.string().max(10_000).nullable(),
    extra: z.record(z.string(), z.unknown()),
    // API spec §9: a client-set status is refused.
    status: z.never().optional(),
  })
  .partial()
  .strict();

const listQuery = z.object({
  member_id: z.string().uuid().optional(),
  category: z.string().optional(),
  type_key: z.string().optional(),
  tag: z.string().optional(),
  visibility: z.enum(['household', 'adults', 'private']).optional(),
  essential: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  status: z.string().optional(),
  deleted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  updated_since: z.string().datetime().optional(),
  sort: z.enum(['recent', 'expiring', 'alpha']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

function parseRange(
  header: string | undefined,
  total: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) throw new ApiError(416, 'range_not_satisfiable', 'That part of the file does not exist.');
  const [, a, b] = m;
  if (a === '' && b === '')
    throw new ApiError(416, 'range_not_satisfiable', 'That part of the file does not exist.');
  if (a === '') return { start: Math.max(0, total - Number(b)), end: total - 1 };
  return { start: Number(a), end: b === '' ? total - 1 : Number(b) };
}

export async function registerDocuments(
  app: FastifyInstance,
  docs: DocumentService,
  maxUploadBytes: number,
) {
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/document-types', auth, async () => ({ items: await docs.types() }));

  app.get<{ Querystring: { q?: string } }>('/api/v1/tags', auth, async (req) => ({
    items: await docs.tags(principal(req), req.query.q),
  }));

  app.get('/api/v1/documents/counts', auth, async (req) => docs.counts(principal(req)));

  app.get('/api/v1/documents', auth, async (req) =>
    docs.list(principal(req), parse(listQuery, req.query)),
  );

  app.post('/api/v1/documents', auth, async (req, reply) => {
    const created = await docs.create(
      principal(req),
      parse(documentBody, req.body ?? {}),
      metaOf(req),
    );
    reply.header('etag', created.etag);
    return reply.status(201).send(created);
  });

  app.get<{ Params: { id: string } }>('/api/v1/documents/:id', auth, async (req, reply) => {
    const d = await docs.get(principal(req), req.params.id);
    reply.header('etag', d.etag);
    return d;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/documents/:id', auth, async (req, reply) => {
    const d = await docs.update(
      principal(req),
      req.params.id,
      parse(documentBody, req.body ?? {}),
      req.headers['if-match'],
      metaOf(req),
    );
    reply.header('etag', d.etag);
    return d;
  });

  app.delete<{ Params: { id: string } }>('/api/v1/documents/:id', auth, async (req, reply) => {
    await docs.softDelete(principal(req), req.params.id, metaOf(req));
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/v1/documents/:id/restore', auth, async (req) =>
    docs.restore(principal(req), req.params.id, metaOf(req)),
  );

  app.get<{ Params: { id: string } }>('/api/v1/documents/:id/versions', auth, async (req) => ({
    items: await docs.versions(principal(req), req.params.id),
  }));

  const uploadHandler =
    (documentId: (req: FastifyRequest) => string) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !key) {
        throw new ApiError(
          422,
          'validation_failed',
          'Uploads need an Idempotency-Key header (a UUID).',
        );
      }
      const file = await req.file();
      if (!file) throw new ApiError(422, 'validation_failed', 'Attach one file.');
      const version = await docs.upload(
        principal(req),
        documentId(req),
        { filename: file.filename, mime: file.mimetype, stream: file.file, idempotencyKey: key },
        metaOf(req),
      );
      if (file.file.truncated) {
        throw new ApiError(413, 'too_large', 'That file is too big for this vault.');
      }
      return reply.status(201).send(version);
    };

  app.post<{ Params: { id: string } }>(
    '/api/v1/documents/:id/versions',
    auth,
    uploadHandler((req) => (req.params as { id: string }).id),
  );

  /**
   * POST /capture: one file in, one Needs-info document out (CAP-05). The
   * document exists and is downloadable before any enrichment runs.
   */
  app.post('/api/v1/capture', auth, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) {
      throw new ApiError(
        422,
        'validation_failed',
        'Uploads need an Idempotency-Key header (a UUID).',
      );
    }
    const file = await req.file();
    if (!file) throw new ApiError(422, 'validation_failed', 'Attach one file.');
    const p = principal(req);
    const doc = await docs.create(p, { title: null }, metaOf(req));
    const version = await docs.upload(
      p,
      doc.id,
      { filename: file.filename, mime: file.mimetype, stream: file.file, idempotencyKey: key },
      metaOf(req),
    );
    return reply
      .status(201)
      .send({ document_id: doc.id, version_id: version.id, job_id: null, state: 'stored' });
  });

  app.get<{ Params: { id: string } }>('/api/v1/versions/:id/content', auth, async (req, reply) => {
    const p = principal(req);
    const meta = await docs.versionMeta(p, req.params.id);
    const total = meta.byte_size;
    const range = parseRange(req.headers.range, total);
    const { stream, range: served } = await docs.content(p, req.params.id, range, metaOf(req));
    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', meta.mime);
    reply.header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
    );
    reply.header('cache-control', 'private, no-store');
    if (!served) {
      reply.header('content-length', String(total));
      return reply.send(stream);
    }
    reply.status(206);
    reply.header('content-range', `bytes ${served.start}-${served.end}/${total}`);
    reply.header('content-length', String(served.end - served.start + 1));
    return reply.send(stream);
  });
}
