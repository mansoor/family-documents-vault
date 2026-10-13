import type { MultipartFile } from '@fastify/multipart';
import {
  DEVICE_NAME_MAX,
  DEVICE_PLATFORMS,
  DEVICE_RELATIVE_PATH_MAX,
  deviceName,
  relativePathProblem,
} from '@fdv/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { needs } from '../authz.js';
import { cutOff } from '../documents/routes.js';
import { ApiError } from '../errors.js';
import type { DeviceCaller, DeviceService } from './service.js';

/**
 * A computer that sends scans (0.8.0, D1): its routes.
 *
 * The two a computer's key is taken by — and nothing else takes it (the
 * hook in app.ts answers it 401 on every other route, a public one too):
 */
export const DEVICE_KEY_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/v1/device-uploads',
  'GET /api/v1/devices/me',
]);

/** Whether a request carries a computer's key, by its scheme alone. */
export function presentsDeviceKey(req: FastifyRequest): boolean {
  return /^device(\s|$)/i.test(req.headers.authorization ?? '');
}

const pairBody = z
  .object({
    code: z.string().max(32),
    device_name: z
      .string()
      .max(DEVICE_NAME_MAX * 4)
      .transform((v, ctx) => {
        const name = deviceName(v);
        if (!name) {
          ctx.addIssue({ code: 'custom', message: 'Give the computer a name.' });
          return z.NEVER;
        }
        return name;
      }),
    platform: z.enum(DEVICE_PLATFORMS),
  })
  .strict();

declare module 'fastify' {
  interface FastifyRequest {
    device: DeviceCaller | null;
  }
}

export function registerDevices(
  app: FastifyInstance,
  devices: DeviceService,
  stepUp: StepUpService,
  maxUploadBytes: number,
): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  app.decorateRequest('device', null);
  const deviceAuth = {
    preHandler: async (req: FastifyRequest) => {
      req.device = await devices.authenticate(req.headers.authorization);
    },
  };

  /**
   * A one-time code for pairing a computer: whoever may add documents,
   * after the step-up (their password again, or a passkey or a code). Its
   * code, shown once; any code they had before ends.
   */
  app.post(
    '/api/v1/device-pairings',
    { preHandler: [app.requireAuth, needs('document.add')] },
    async (req, reply) => {
      await stepUp.require(principal(req), 'change_sign_in');
      return reply.status(201).send(await devices.createPairing(principal(req)));
    },
  );

  /** The caller's own code, if one is waiting, ended: the dialog showing it was closed. */
  app.delete(
    '/api/v1/device-pairings',
    { preHandler: [app.requireAuth, needs('document.add')] },
    async (req, reply) => {
      await devices.endPairing(principal(req));
      return reply.status(204).send();
    },
  );

  /**
   * The code traded for a key: unauthenticated, and limited for each
   * address as signing in is. The key is answered once.
   */
  app.post(
    '/api/v1/devices/pair',
    // For each address — an IPv6 one by the /64 it is in, as the limiter
    // keys every address (the D1 review, F4).
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(pairBody, req.body ?? {});
      return reply.status(201).send(await devices.pair(body, metaOf(req)));
    },
  );

  /** What a computer may say about itself: its name, its person, and why it is paused if it is. */
  app.get('/api/v1/devices/me', deviceAuth, async (req) => devices.me(req.device as DeviceCaller));

  /**
   * One file from a computer, multipart: an optional `relative_path` field
   * (where the file was, under the folder it watches: checked, and handed
   * on as `relativePath`, which nothing keeps yet), then
   * the file as `file`, and nothing else. An Idempotency-Key (a UUID) is
   * required: a file sent again after its answer was lost is answered with
   * the item it made (`idempotent-replayed: true`).
   */
  app.post('/api/v1/device-uploads', deviceAuth, async (req, reply) => {
    const caller = req.device as DeviceCaller;
    const sentKey = req.headers['idempotency-key'];
    if (typeof sentKey !== 'string' || !z.string().uuid().safeParse(sentKey).success) {
      throw new ApiError(
        422,
        'validation_failed',
        'Send an Idempotency-Key, a UUID written like 123e4567-e89b-42d3-a456-426614174000.',
        { detail: 'idempotency-key' },
      );
    }
    const parts = req
      .parts({
        // Room for one more of each than is taken, so that what is past it
        // arrives as a part and is refused here, in words — a part past
        // the parser's own limits ends the file's stream before it is read
        // (the D1 review, F1).
        limits: {
          fileSize: maxUploadBytes,
          files: 2,
          fields: 2,
          parts: 4,
          fieldSize: DEVICE_RELATIVE_PATH_MAX * 4,
        },
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
      new ApiError(
        422,
        'validation_failed',
        'Send an optional relative_path, then one file named file, and nothing else.',
      );
    let file: MultipartFile;
    let relativePath: string | null = null;
    try {
      let next = await parts.next();
      if (!next.done && next.value.type === 'field') {
        if (next.value.fieldname !== 'relative_path') throw order();
        const path = String(next.value.value);
        const problem = next.value.valueTruncated
          ? relativePathProblem('x'.repeat(DEVICE_RELATIVE_PATH_MAX + 1))
          : relativePathProblem(path);
        if (problem) {
          throw new ApiError(422, 'validation_failed', problem, { detail: 'relative_path' });
        }
        relativePath = path || null;
        next = await parts.next();
      }
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
    const { answer, replayed } = await devices
      .upload(
        caller,
        {
          idempotencyKey: sentKey.toLowerCase(),
          relativePath,
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
    if (replayed) {
      theFile.file.resume();
      void drainRest();
      void reply.header('idempotent-replayed', 'true');
    }
    return reply.status(201).send(answer);
  });

  /** The caller's own computers; an owner's, every one in the household (names and people only). */
  app.get('/api/v1/paired-devices', auth, async (req) => ({
    items: await devices.list(principal(req)),
  }));

  /** A computer's key revoked: the caller's own, or for an owner, anybody's. */
  app.delete<{ Params: { id: string } }>(
    '/api/v1/paired-devices/:id',
    auth,
    async (req, reply: FastifyReply) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      await devices.revoke(principal(req), id, metaOf(req));
      return reply.status(204).send();
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
