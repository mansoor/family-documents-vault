import type { MultipartFile } from '@fastify/multipart';
import { NOT_SCANNED, type BatchAcceptInput, type BatchInput } from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { captureBody, cutOff } from '../documents/routes.js';
import { ApiError } from '../errors.js';
import { presentedDeviceCookies } from '../public/device-cookie.js';
import { batchBody, type BatchService } from './batches.js';
import { acceptBody, type IncomingService } from './incoming.js';
import {
  createBody,
  DROP_COOKIE_PATH,
  DROP_COOKIE_PREFIX,
  DROP_DEVICE_COOKIE,
  DROP_REQUEST_HEADER,
  dropCookieName,
  dropFinishBody,
  dropTokenBody,
  dropUnlockBody,
  type DropCookie,
  type UploadRequestService,
} from './requests.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session cookie's request id, from its name (`fdv_drop_s_<id without dashes>`). */
const named = (cookieName: string): string | null => {
  const hex = cookieName.slice(DROP_COOKIE_PREFIX.length);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The session cookie a sender's call is for, and the request it is about.
 * Each request's cookie has its own name (a browser may have two open); the
 * page says which with `X-FDV-Drop-Request` (the `request_id` Open
 * answered), and with one session open it need not say: then its cookie's
 * name says. Either way the session is answered only for that request
 * (N522S-2).
 */
export function dropSessionCookie(req: FastifyRequest): DropCookie {
  const wanted = req.headers[DROP_REQUEST_HEADER];
  if (typeof wanted === 'string') {
    return UUID.test(wanted)
      ? { value: req.cookies[dropCookieName(wanted)], requestId: wanted.toLowerCase() }
      : { value: undefined, requestId: null };
  }
  const open = Object.entries(req.cookies).filter(
    ([name, value]) => name.startsWith(DROP_COOKIE_PREFIX) && value,
  );
  const [only] = open;
  return open.length === 1 && only
    ? { value: only[1], requestId: named(only[0]) }
    : { value: undefined, requestId: null };
}

/**
 * Asking somebody to send documents (5.21): the family's routes, and the
 * public ones a sender's page calls (`/api/v1/drop/*`, on the public-only
 * site). The token travels in a body, never a path; Open gives a cookie for
 * this path alone, whose hash is all the vault keeps. Nothing a sender sends
 * — the token, a password, a code, a file's name — is in a path, so none of
 * it reaches a log line (log-redaction.ts).
 */
export function registerUploads(app: FastifyInstance, uploads: UploadRequestService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });

  // ------------------------------------------------------------ the family
  // A teen or a viewer is answered as if none of this existed (404).

  app.post('/api/v1/upload-requests', auth, async (req, reply) => {
    const created = await uploads.create(
      principal(req),
      parse(createBody, req.body ?? {}),
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  app.get('/api/v1/upload-requests', auth, async (req) => ({
    items: await uploads.list(principal(req)),
    // Whether an emailed code can be offered: only with operator mail (A21).
    email_code_available: uploads.emailCodeAvailable,
  }));

  app.delete<{ Params: { id: string } }>(
    '/api/v1/upload-requests/:id',
    auth,
    async (req, reply) => {
      await uploads.revoke(principal(req), parse(idParam, req.params).id, metaOf(req));
      return reply.status(204).send();
    },
  );

  /** After a restore (A55): an owner turns a paused request back on. */
  app.post<{ Params: { id: string } }>('/api/v1/upload-requests/:id/resume', auth, async (req) =>
    uploads.resume(principal(req), parse(idParam, req.params).id, metaOf(req)),
  );

  // ------------------------------------------------------------ the sender
  // Nobody signs in for these. Opening one is 20 tries a minute from an
  // address (the preview, a code, Open), as a share link's, and so is
  // sending a file (a request takes 10 at most); inside an opened one,
  // anything else is 120 requests a minute. FDV_RATE_LIMIT_PER_MINUTE is the
  // ceiling above both.
  const tight = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const inSession = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.post('/api/v1/drop/preview', tight, async (req) =>
    uploads.preview(
      parse(dropTokenBody, req.body ?? {}).token,
      presentedDeviceCookies(req.cookies, DROP_DEVICE_COOKIE),
      (requestId) => req.cookies[dropCookieName(requestId)],
    ),
  );

  app.post('/api/v1/drop/code', tight, async (req) =>
    uploads.sendCode(
      parse(dropTokenBody, req.body ?? {}).token,
      presentedDeviceCookies(req.cookies, DROP_DEVICE_COOKIE),
      metaOf(req),
    ),
  );

  const cookieOptions = (maxAge: number) => ({
    path: DROP_COOKIE_PATH,
    httpOnly: true,
    // Always: browsers keep a Secure cookie from http://localhost, and a
    // vault outsiders reach is reached over https (the public-only site).
    secure: true,
    sameSite: 'strict' as const,
    maxAge,
  });

  app.post('/api/v1/drop/unlock', tight, async (req, reply) => {
    const opened = await uploads.unlock(
      parse(dropUnlockBody, req.body ?? {}),
      presentedDeviceCookies(req.cookies, DROP_DEVICE_COOKIE),
      metaOf(req),
    );
    void reply.setCookie(opened.cookieName, opened.cookie, cookieOptions(opened.maxAge));
    // One device cookie serves every request a browser opens, so a second
    // never unbinds the first: made once, and its life renewed by every
    // Open that uses it, so it outlives each request bound to it.
    if (opened.device) {
      void reply.setCookie(
        opened.device.name,
        opened.device.value,
        cookieOptions(opened.device.maxAge),
      );
    }
    return opened.session;
  });

  app.get('/api/v1/drop/session', inSession, async (req) =>
    uploads.session(dropSessionCookie(req)),
  );

  /**
   * One file, multipart: an optional `item_id` field (which of the things
   * asked for it is), then the file as `file`, and nothing else. The session
   * is checked before a byte is read, and the file's room is reserved by
   * the upload's own length.
   */
  app.post('/api/v1/drop/files', tight, async (req, reply) => {
    const cookie = dropSessionCookie(req);
    const length = Number(req.headers['content-length']);
    const parts = req
      .parts({
        limits: { fileSize: uploads.maxFileBytes, files: 1, fields: 1, fieldSize: 64 },
      })
      [Symbol.asyncIterator]();
    const drainRest = async () => {
      for (;;) {
        const next = await parts.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) return;
        if (next.value.type === 'file') next.value.file.resume();
      }
    };
    const order = () =>
      new ApiError(422, 'validation_failed', 'Send one file, named file, and nothing after it.');
    let file: MultipartFile;
    let itemId: string | null = null;
    try {
      await uploads.mayAdd(cookie);
      let next = await parts.next();
      if (!next.done && next.value.type === 'field') {
        if (next.value.fieldname !== 'item_id') throw order();
        itemId = parse(z.string().uuid(), next.value.value);
        next = await parts.next();
      }
      if (next.done) throw new ApiError(422, 'validation_failed', 'Choose a file to send.');
      if (next.value.type !== 'file' || next.value.fieldname !== 'file') {
        if (next.value.type === 'file') next.value.file.resume();
        throw order();
      }
      file = next.value;
    } catch (err) {
      // Answered now, the rest read to nowhere as it comes: a refusal does
      // not wait for a body a sender is still sending, or holding open.
      void drainRest();
      throw limitRefusal(err, order);
    }
    const theFile = file;
    const sent = await uploads
      .addFile(cookie, {
        filename: theFile.filename,
        stream: theFile.file,
        itemId,
        declaredBytes: Number.isSafeInteger(length) && length > 0 ? length : null,
        truncated: () => theFile.file.truncated,
        finished: async () => {
          const after = await parts.next().catch((err: unknown) => {
            throw limitRefusal(err, order);
          });
          if (after.done) return;
          if (after.value.type === 'file') after.value.file.resume();
          await drainRest();
          throw order();
        },
      })
      .catch((err: unknown) => {
        theFile.file.resume();
        void drainRest();
        throw limitRefusal(err, order);
      });
    return reply.status(201).send(sent);
  });

  app.delete<{ Params: { id: string } }>(
    '/api/v1/drop/files/:id',
    inSession,
    async (req, reply) => {
      await uploads.removeFile(dropSessionCookie(req), parse(idParam, req.params).id);
      return reply.status(204).send();
    },
  );

  app.post('/api/v1/drop/finish', inSession, async (req) =>
    uploads.finish(dropSessionCookie(req), parse(dropFinishBody, req.body ?? {}), metaOf(req)),
  );
}

/**
 * Incoming (5.23): what came in through a request, looked at before it is
 * filed. Owners and adults who review it; anybody else is answered as if
 * there were nothing here (404).
 */
export function registerIncoming(app: FastifyInstance, incoming: IncomingService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });
  const pageParams = z.object({
    id: z.string().uuid(),
    n: z.coerce.number().int().min(1).max(9999),
  });

  app.get('/api/v1/incoming', auth, async (req) => ({
    items: await incoming.list(principal(req)),
  }));

  /** A page the worker drew for review: a JPEG, never kept by the browser. */
  app.get<{ Params: { id: string; n: string } }>(
    '/api/v1/incoming/:id/pages/:n',
    auth,
    async (req, reply) => {
      const { id, n } = parse(pageParams, req.params);
      const bytes = await incoming.page(principal(req), id, n);
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(bytes);
    },
  );

  /**
   * A copy of the file: an attachment, never shown in the page; the type its
   * bytes are, and no sniffing; under a name whose ending its bytes chose;
   * and, when it has not been scanned for viruses (A42: never, here), a
   * warning saying so.
   */
  app.get<{ Params: { id: string } }>('/api/v1/incoming/:id/content', auth, async (req, reply) => {
    const file = await incoming.content(principal(req), parse(idParam, req.params).id, metaOf(req));
    reply.header('content-type', file.contentType);
    reply.header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    reply.header('content-length', String(file.total));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    reply.header('cache-control', 'private, no-store');
    if (!file.scanned) {
      reply.header('x-fdv-scan', 'unscanned');
      reply.header('warning', `199 - "${NOT_SCANNED}"`);
    }
    return reply.send(file.stream);
  });

  app.post<{ Params: { id: string } }>('/api/v1/incoming/:id/accept', auth, async (req, reply) => {
    const done = await incoming.accept(
      principal(req),
      parse(idParam, req.params).id,
      parse(acceptBody, req.body ?? {}),
      metaOf(req),
    );
    return reply.status(201).send(done);
  });

  app.post<{ Params: { id: string } }>('/api/v1/incoming/:id/reject', auth, async (req, reply) => {
    await incoming.reject(principal(req), parse(idParam, req.params).id, metaOf(req));
    return reply.status(204).send();
  });
}

/**
 * Many documents at once (Phase 6, I1): a batch of the caller's own, and its
 * items, one file a request. Whoever may add documents; a viewer or a guest
 * is refused (403). Nobody else's batch is ever answered: 404.
 */
export function registerBatches(app: FastifyInstance, batches: BatchService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });
  const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
  const pageParams = itemParams.extend({ n: z.coerce.number().int().min(1).max(9999) });
  const acceptItemBody = captureBody
    .extend({ collection_id: z.string().uuid().nullable().optional() })
    .strict();

  app.post('/api/v1/batches', auth, async (req, reply) => {
    const made = await batches.create(
      principal(req),
      parse(batchBody, req.body ?? {}) as BatchInput,
      metaOf(req),
    );
    return reply.status(201).send(made);
  });

  app.get('/api/v1/batches', auth, async (req) => ({ items: await batches.list(principal(req)) }));

  app.get<{ Params: { id: string } }>('/api/v1/batches/:id', auth, async (req) =>
    batches.get(principal(req), parse(idParam, req.params).id),
  );

  app.patch<{ Params: { id: string } }>('/api/v1/batches/:id', auth, async (req) =>
    batches.update(
      principal(req),
      parse(idParam, req.params).id,
      parse(batchBody, req.body ?? {}) as BatchInput,
      metaOf(req),
    ),
  );

  app.delete<{ Params: { id: string } }>('/api/v1/batches/:id', auth, async (req, reply) => {
    await batches.remove(principal(req), parse(idParam, req.params).id, metaOf(req));
    return reply.status(204).send();
  });

  /**
   * One file, multipart, as `file`, and nothing else: the size limit is a
   * single add's (413), and so are the kinds it takes (415). Refused before
   * a byte is stored when the batch is not the caller's, has ended, or is
   * full.
   */
  app.post<{ Params: { id: string } }>('/api/v1/batches/:id/items', auth, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    // Room for one file more than is taken, as a capture's (documents/
    // routes.ts): at its limit the parser destroys the stream it is
    // reading, which, were it the file, would fail it as if storage had. A
    // second file is refused once the first has arrived.
    const parts = req
      .parts({ limits: { fileSize: batches.fileLimit, files: 2, fields: 0 } })
      [Symbol.asyncIterator]();
    const drainRest = async () => {
      for (;;) {
        const next = await parts.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) return;
        if (next.value.type === 'file') next.value.file.resume();
      }
    };
    const order = () =>
      new ApiError(422, 'validation_failed', 'Send one file, named file, and nothing else.');
    let file: MultipartFile;
    try {
      const next = await parts.next();
      if (next.done) throw new ApiError(422, 'validation_failed', 'Choose a file to send.');
      if (next.value.type !== 'file' || next.value.fieldname !== 'file') {
        if (next.value.type === 'file') next.value.file.resume();
        throw order();
      }
      file = next.value;
    } catch (err) {
      void drainRest();
      throw limitRefusal(err, order);
    }
    const theFile = file;
    const item = await batches
      .addItem(
        principal(req),
        id,
        {
          filename: theFile.filename,
          mime: theFile.mimetype,
          stream: theFile.file,
          truncated: () => theFile.file.truncated,
          finished: async () => {
            const after = await parts.next().catch((err: unknown) => {
              throw limitRefusal(err, order);
            });
            if (after.done) return;
            if (after.value.type === 'file') after.value.file.resume();
            await drainRest();
            throw order();
          },
        },
        metaOf(req),
      )
      .catch((err: unknown) => {
        theFile.file.resume();
        void drainRest();
        const refusal = limitRefusal(err, order);
        if (refusal instanceof ApiError && refusal.status === 413) cutOff(req, reply);
        throw refusal;
      });
    return reply.status(201).send(item);
  });

  app.delete<{ Params: { id: string; itemId: string } }>(
    '/api/v1/batches/:id/items/:itemId',
    auth,
    async (req, reply) => {
      const { id, itemId } = parse(itemParams, req.params);
      await batches.removeItem(principal(req), id, itemId, metaOf(req));
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/v1/batches/:id/items/:itemId/accept',
    auth,
    async (req, reply) => {
      const { id, itemId } = parse(itemParams, req.params);
      const done = await batches.accept(
        principal(req),
        id,
        itemId,
        parse(acceptItemBody, req.body ?? {}) as BatchAcceptInput,
        metaOf(req),
      );
      return reply.status(201).send(done);
    },
  );

  /** A page the worker drew: a JPEG, never kept by the browser. */
  app.get<{ Params: { id: string; itemId: string; n: string } }>(
    '/api/v1/batches/:id/items/:itemId/pages/:n',
    auth,
    async (req, reply) => {
      const { id, itemId, n } = parse(pageParams, req.params);
      const bytes = await batches.page(principal(req), id, itemId, n);
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(bytes);
    },
  );
}

/** The parser's own limits (a second file, a second field) are the order's refusal. */
function limitRefusal(err: unknown, order: () => ApiError): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT'
    ? order()
    : err;
}
