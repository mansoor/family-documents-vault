import multipart, { type MultipartFile } from '@fastify/multipart';
import type { CaptureMetadata } from '@fdv/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { SealedSearchService } from './sealed-search.js';
import type { StepUpService } from '../auth/step-up.js';
import type { DocumentService } from './service.js';
import type { VisibilityService } from './visibility.js';
import { openBody, shareBody, type ShareService } from './shares.js';

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
    issued_by: z.string().max(200).nullable(),
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

/**
 * A capture's details (the `metadata` field, 0.4.9): what the confirm card
 * asks, with the same messages POST /documents gives. The category and the
 * type's other defaults follow from the type, as they do there.
 */
const captureBody = documentBody
  .pick({
    type_key: true,
    title: true,
    owner_member_id: true,
    visibility: true,
    issued: true,
    expires: true,
    identifier: true,
    issued_by: true,
    physical_location: true,
    is_essential: true,
    tags: true,
    notes: true,
  })
  .strict();

/** A part's text, up to a limit: the rest is read to nowhere and refused. */
async function smallText(stream: NodeJS.ReadableStream, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > limit) {
      stream.resume();
      throw new ApiError(422, 'validation_failed', 'The details are too long.');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function captureMetadata(raw: unknown): CaptureMetadata {
  let json: unknown = raw;
  // A field sent as application/json arrives already parsed.
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ApiError(422, 'validation_failed', 'The details must be sent as JSON.');
    }
  }
  return parse(captureBody, json) as CaptureMetadata;
}

const listQuery = z.object({
  member_id: z.string().uuid().optional(),
  category: z.string().optional(),
  issued_by: z.string().trim().min(1).max(200).optional(),
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
  visibility: VisibilityService,
  maxUploadBytes: number,
  sealed: SealedSearchService,
  stepUp?: StepUpService,
  shares?: ShareService,
) {
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/document-types', auth, async () => ({ items: await docs.types() }));

  app.get<{ Querystring: { q?: string } }>('/api/v1/tags', auth, async (req) => ({
    items: await docs.tags(principal(req), req.query.q),
  }));

  app.get('/api/v1/documents/counts', auth, async (req) => docs.counts(principal(req)));

  /** Who issued the household's documents, as far as the caller can see (0.4.10). */
  const issuersQuery = z.object({
    q: z.string().trim().max(200).optional(),
    type_key: z.string().max(64).optional(),
    member_id: z.string().uuid().optional(),
    category: z.string().max(64).optional(),
  });
  app.get('/api/v1/issuers', auth, async (req) => ({
    items: await docs.issuers(principal(req), parse(issuersQuery, req.query)),
  }));

  /** Who probably issued it, from its pages: offered, never filled in (0.4.10). */
  app.get<{ Params: { id: string } }>(
    '/api/v1/documents/:id/issuer-suggestions',
    auth,
    async (req, reply) => {
      // Worked out from the page's words for this person, now: not for keeping.
      void reply.header('cache-control', 'no-store');
      return docs.issuerSuggestions(principal(req), req.params.id);
    },
  );

  const searchQuery = z.object({
    q: z.string().trim().min(1).max(200),
    member_id: z.string().uuid().optional(),
    category: z.string().optional(),
    issued_by: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
  app.get('/api/v1/search', auth, async (req) =>
    docs.search(principal(req), parse(searchQuery, req.query)),
  );

  // The second pass: the caller's own sealed documents, opened in their
  // session. The token from the first pass says what to search.
  app.get<{ Querystring: { token?: string } }>('/api/v1/search/sealed', auth, async (req) => {
    const token = parse(z.string().min(1).max(4096), req.query.token);
    return sealed.search(principal(req), token);
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/versions/:id/thumbnail',
    auth,
    async (req, reply) => {
      const bytes = await docs.thumbnail(principal(req), req.params.id);
      if (!bytes) {
        throw new ApiError(404, 'no_thumbnail', 'No preview yet.', { retriable: true });
      }
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, max-age=3600');
      return reply.send(bytes);
    },
  );

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
    const body = parse(documentBody, req.body ?? {});
    // A visibility change rewraps keys and moves text; it is never a plain
    // column update. It runs first so the ETag check below sees its effect.
    const { visibility: nextVisibility, ...rest } = body;
    if (nextVisibility !== undefined) {
      await visibility.change(principal(req), req.params.id, nextVisibility, metaOf(req));
    }
    const d = await docs.update(
      principal(req),
      req.params.id,
      rest,
      nextVisibility !== undefined ? undefined : req.headers['if-match'],
      metaOf(req),
    );
    reply.header('etag', d.etag);
    return d;
  });

  app.delete<{ Params: { id: string } }>('/api/v1/documents/:id', auth, async (req, reply) => {
    await docs.softDelete(principal(req), req.params.id, metaOf(req));
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/documents/:id/visibility',
    auth,
    async (req, reply) => {
      const body = parse(
        z.object({ visibility: z.enum(['household', 'adults', 'private']) }),
        req.body,
      );
      // Answering with the notice rather than 204: the moment somebody is
      // told "only you can open this" is part of the act, not a separate
      // thing the client has to know to go and ask about (SEC-19).
      return reply.send(
        await visibility.change(principal(req), req.params.id, body.visibility, metaOf(req)),
      );
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/documents/:id/restore', auth, async (req) =>
    docs.restore(principal(req), req.params.id, metaOf(req)),
  );

  app.get<{ Params: { id: string } }>('/api/v1/documents/:id/versions', auth, async (req) => ({
    items: await docs.versions(principal(req), req.params.id),
  }));

  const uploadKey = (req: FastifyRequest): string => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) {
      throw new ApiError(
        422,
        'validation_failed',
        'Uploads need an Idempotency-Key header (a UUID).',
      );
    }
    return key;
  };

  const fileOf = async (req: FastifyRequest) => {
    const file = await req.file();
    if (!file) throw new ApiError(422, 'validation_failed', 'Attach one file.');
    return file;
  };

  /**
   * A retried upload is answered with what the first try made, marked as
   * a replay. Its bytes are not needed, so they are drained, not stored.
   */
  const replayed = (reply: FastifyReply, file: { file: NodeJS.ReadableStream }, was: boolean) => {
    if (!was) return;
    file.file.resume();
    void reply.header('idempotent-replayed', 'true');
  };

  /**
   * A refusal before the bytes were read (the key is taken, the document is
   * not there) still reads them, to nowhere, so the connection is left able
   * to carry the answer and the next request.
   */
  const drained =
    (file: { file: NodeJS.ReadableStream }) =>
    (err: unknown): never => {
      file.file.resume();
      throw err;
    };

  app.post<{ Params: { id: string } }>(
    '/api/v1/documents/:id/versions',
    auth,
    async (req, reply) => {
      const key = uploadKey(req);
      const file = await fileOf(req);
      const { version, replayed: was } = await docs
        .accept(
          principal(req),
          { kind: 'version', documentId: req.params.id },
          {
            filename: file.filename,
            mime: file.mimetype,
            stream: file.file,
            idempotencyKey: key,
            truncated: () => file.file.truncated,
          },
          metaOf(req),
        )
        .catch(drained(file));
      replayed(reply, file, was);
      return reply.status(201).send(version);
    },
  );

  /**
   * POST /capture: one file in, one document out (CAP-05). The details from
   * the card may come with it, as a `metadata` field (JSON) sent **before**
   * the file, so the document is made complete and wrapped for the right
   * people from its first byte (0.4.9). A retry with the same key makes
   * nothing new (CAP-13).
   */
  app.post('/api/v1/capture', auth, async (req, reply) => {
    // Room for more files than a capture takes: at its limit the parser
    // destroys the stream it is reading, which, if that were the upload,
    // would fail it as if storage had. Details sent as a file, the file,
    // and one more that is refused (below) all fit.
    const parts = req.parts({ limits: { files: 3 } })[Symbol.asyncIterator]();
    /** A refusal before the upload: read the rest, to nowhere, and answer. */
    const drainRest = async () => {
      for (;;) {
        const next = await parts.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) return;
        if (next.value.type === 'file') next.value.file.resume();
      }
    };
    let key: string;
    let metadata: CaptureMetadata | undefined;
    let file: MultipartFile | undefined;
    try {
      key = uploadKey(req);
      for (;;) {
        const next = await parts.next();
        if (next.done) break;
        const part = next.value;
        if (part.type === 'file') {
          if (part.fieldname === 'file') {
            file = part;
            break;
          }
          // The details sent as a file (a Blob of JSON) are still the
          // details — read only as far as details could reach.
          if (part.fieldname === 'metadata' && metadata === undefined) {
            metadata = captureMetadata(await smallText(part.file, 64 * 1024));
            continue;
          }
          part.file.resume();
          throw new ApiError(
            422,
            'validation_failed',
            'Send one field, metadata, and then the file, named file.',
          );
        }
        if (part.fieldname !== 'metadata' || metadata !== undefined) {
          throw new ApiError(
            422,
            'validation_failed',
            'Send one field, metadata, and then the file.',
          );
        }
        metadata = captureMetadata(part.value);
      }
      if (!file) throw new ApiError(422, 'validation_failed', 'Attach one file.');
    } catch (err) {
      await drainRest();
      throw err;
    }
    const theFile = file;
    const done = await docs
      .capture(
        principal(req),
        {
          filename: theFile.filename,
          mime: theFile.mimetype,
          stream: theFile.file,
          idempotencyKey: key,
          truncated: () => theFile.file.truncated,
          // Nothing may follow the file: details sent after it would have
          // been too late to decide who the file is wrapped for.
          finished: async () => {
            const after = await parts.next().catch(() => {
              throw new ApiError(
                422,
                'validation_failed',
                'Send one file, with the details before it as JSON.',
              );
            });
            if (after.done) return;
            if (after.value.type === 'file') after.value.file.resume();
            await drainRest();
            throw new ApiError(422, 'validation_failed', 'Send the details before the file.');
          },
        },
        metaOf(req),
        metadata,
      )
      .catch(drained(theFile));
    replayed(reply, theFile, done.replayed);
    return reply.status(201).send({
      document_id: done.document_id,
      version_id: done.version_id,
      job_id: null,
      state: 'stored',
    });
  });

  /** What became of one of the caller's own uploads: done, in progress, or not known. */
  app.get<{ Params: { key: string } }>('/api/v1/uploads/:key', auth, async (req) =>
    docs.uploadStatus(principal(req), req.params.key),
  );

  app.get<{ Params: { id: string } }>('/api/v1/versions/:id/content', auth, async (req, reply) => {
    const p = principal(req);
    // An Essential or an "only me" document asks who is asking, once
    // every five minutes (SEC-17). Everything else opens straight away.
    if (stepUp && (await docs.isSensitive(p, req.params.id))) {
      await stepUp.require(p, 'open_private_document');
    }
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

  if (!shares) return;

  const idParam = z.object({ id: z.string().uuid() });
  const tokenParam = z.object({ token: z.string().min(16).max(256) });

  app.post<{ Params: { id: string } }>('/api/v1/documents/:id/share', auth, async (req, reply) => {
    // A link is a way to open the document without signing in, so making
    // one asks what opening it asks (SEC-17).
    const id = parse(idParam, req.params).id;
    if (stepUp && (await docs.isSensitiveDocument(principal(req), id))) {
      await stepUp.require(principal(req), 'open_private_document');
    }
    const created = await shares.create(
      principal(req),
      id,
      parse(shareBody, req.body ?? {}),
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  app.get('/api/v1/shares', auth, async (req) => ({ items: await shares.list(principal(req)) }));

  app.delete<{ Params: { id: string } }>('/api/v1/shares/:id', auth, async (req, reply) => {
    await shares.revoke(principal(req), parse(idParam, req.params).id, metaOf(req));
    return reply.status(204).send();
  });

  // The three the recipient calls. Nobody signs in for these, so they are
  // rate-limited like the front door.
  const tight = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get<{ Params: { token: string } }>('/api/v1/shared/:token', tight, async (req) =>
    shares.preview(parse(tokenParam, req.params).token),
  );

  app.post<{ Params: { token: string } }>('/api/v1/shared/:token/open', tight, async (req) =>
    shares.open(parse(tokenParam, req.params).token, parse(openBody, req.body ?? {}), metaOf(req)),
  );

  app.get<{ Params: { token: string }; Querystring: { pin?: string } }>(
    '/api/v1/shared/:token/content',
    tight,
    async (req, reply) => {
      // The PIN comes on the query string because this is a plain link a
      // browser follows; the whole URL is already the secret.
      const { stream, total, contentType, filename } = await shares.content(
        parse(tokenParam, req.params).token,
        parse(openBody, { ...(req.query.pin ? { pin: req.query.pin } : {}) }),
        metaOf(req),
      );
      reply.header('content-type', contentType);
      reply.header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      reply.header('content-length', String(total));
      reply.header('cache-control', 'private, no-store');
      // A shared document must never end up in somebody else's search
      // results or a proxy's cache.
      reply.header('x-robots-tag', 'noindex, nofollow');
      return reply.send(stream);
    },
  );
}
