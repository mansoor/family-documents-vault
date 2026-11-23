import {
  ARRANGE_BY,
  ARRANGE_BY_LEVELS,
  CABINET_LEVELS,
  CABINET_LIMITS,
  CABINET_NODE_ID,
  CABINET_TOO_BIG,
  DIVIDER_LIMITS,
  DOCUMENT_PAGE_MAX,
  ISSUER_KEY_MAX,
  layoutSize,
  LEVEL_LIMITS,
  PIN_LIMITS,
  type CabinetLayout,
  type CabinetLevel,
} from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { CabinetService } from './service.js';

/**
 * A layout's shape as it is sent. Each name is checked again, in words, by
 * `layoutProblem` (@fdv/shared); each folder's question by the list's own
 * parser (the service's `checkLayout`).
 */
const id = z.string().regex(CABINET_NODE_ID, 'Each part of a cabinet needs its own id.');
const name = z.string().max(CABINET_LIMITS.name * 4);
/**
 * A level a cabinet is arranged by (0.9.0-dev.90). How many, and each once,
 * are checked again, in words, by `layoutProblemOf` (code `cabinet_levels`).
 */
const level = z.enum(CABINET_LEVELS);
const levels = z.array(level).max(LEVEL_LIMITS.most);
/** A divider's day, or open: checked as a real day, in words, by `dividersProblemOf`. */
const dividerDay = z.string().max(10).nullable();
/**
 * A folder's dividers (0.9.0, C2). Each range's name and days, how many,
 * and two that overlap, are checked again by `layoutProblemOf`, each with
 * its own code.
 */
const dividers = z
  .object({
    // Up to two levels inside the folder (0.9.0-dev.90).
    levels: z.array(level).max(DIVIDER_LIMITS.levels),
    ranges: z
      .array(
        z
          .object({
            name: z.string().max(DIVIDER_LIMITS.name * 4),
            from: dividerDay,
            to: dividerDay,
          })
          .strict(),
      )
      .max(DIVIDER_LIMITS.ranges * 5),
  })
  .strict();
const folder = z
  .object({
    id,
    name,
    hidden: z.boolean(),
    filter: z.record(z.string(), z.unknown()),
    dividers: dividers.optional(),
  })
  .strict();
const drawer = z
  .object({ id, name, hidden: z.boolean(), folders: z.array(folder).max(CABINET_LIMITS.folders) })
  .strict();
/** How a cabinet was drawn (0.9.0-dev.90): its value, and its own levels below it. */
const drawn = z
  .object({ value: z.string().max(200).nullable(), levels: levels.optional() })
  .strict();
const cabinet = z
  .object({
    id,
    name,
    hidden: z.boolean(),
    drawers: z.array(drawer).max(CABINET_LIMITS.drawers),
    drawn: drawn.optional(),
  })
  .strict();
const layoutBody = z
  .object({
    // Absent or null: arranged by hand (0.9.0-dev.90).
    levels: levels.nullable().optional(),
    // What older apps still send (deprecated): ignored.
    arranged_by: z.string().max(40).nullable().optional(),
    cabinets: z.array(cabinet).max(CABINET_LIMITS.cabinets),
  })
  .strict();
/** A layout as it is sent, as the service takes it: its levels null where none were sent. */
const layoutOf = (l: z.infer<typeof layoutBody>): CabinetLayout =>
  ({ ...l, levels: l.levels ?? null }) as CabinetLayout;
const saveBody = z
  .object({
    layout: layoutBody,
    version: z.number().int().min(0).max(2_147_483_647),
    // Folders merged into others, their pins moved with them (C2).
    pins_moved: z
      .array(z.object({ from: id, to: id }).strict())
      .max(CABINET_LIMITS.folders_total)
      .optional(),
  })
  .strict();
const pinsBody = z
  .object({ document_ids: z.array(z.string().max(64)).min(1).max(PIN_LIMITS.folder) })
  .strict();
const dividerQuery = z
  .object({
    // A step for each divider level (0.9.0-dev.90): `person:<id>/kind:<key>/year:2025`.
    divider: z.string().min(1).max(400),
    cursor: z.string().max(8192).optional(),
    limit: z.coerce.number().int().min(1).max(DOCUMENT_PAGE_MAX).optional(),
  })
  .strict();
/** POST /issuers/same and /issuers/separate (0.9.0-dev.91): two issuer keys, checked again as keys. */
const issuerChange = z
  .object({
    from: z
      .string()
      .min(1)
      .max(ISSUER_KEY_MAX * 4),
    to: z
      .string()
      .min(1)
      .max(ISSUER_KEY_MAX * 4),
  })
  .strict();
const pageQuery = z
  .object({
    cursor: z.string().max(8192).optional(),
    limit: z.coerce.number().int().min(1).max(DOCUMENT_PAGE_MAX).optional(),
  })
  .strict();
/**
 * POST /cabinet/preview (0.9.0-dev.90): the default levels; and one
 * cabinet's own (null: the default again); drawn over `layout`, else the
 * arrangement saved. `arrange_by`, one of an older vault's three ways, is
 * still taken (deprecated) for its levels.
 */
const previewBody = z
  .object({
    levels: levels.optional(),
    arrange_by: z.enum(ARRANGE_BY).optional(),
    cabinet: z.object({ id, levels: levels.nullable() }).strict().optional(),
    layout: layoutBody.optional(),
  })
  .strict();

/**
 * My cabinet (0.9.0, C1, `features.cabinets`): the caller's own, whoever
 * is signed in — a viewer and a guest too, whose folders only ever narrow
 * what they are given. Nothing here is anybody else's.
 */
export function registerCabinet(app: FastifyInstance, cabinet: CabinetService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get('/api/v1/cabinet', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.get(principal(req));
  });

  app.put('/api/v1/cabinet', auth, async (req) => {
    const body = parse(saveBody, req.body ?? {});
    return cabinet.save(principal(req), layoutOf(body.layout), body.version, body.pins_moved ?? []);
  });

  app.post('/api/v1/cabinet/preview', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const body = parse(previewBody, req.body ?? {});
    const chosen =
      body.levels ?? (body.arrange_by ? ARRANGE_BY_LEVELS[body.arrange_by] : undefined);
    if (!chosen) {
      throw new ApiError(
        422,
        'validation_failed',
        'Choose the levels to arrange your cabinet by.',
        {
          detail: 'levels',
        },
      );
    }
    // The arrangement drawn over: never more than a cabinet may hold, as
    // PUT /cabinet would keep it — what the person has is within it already.
    const over = body.layout ? layoutOf(body.layout) : undefined;
    if (over) {
      const size = layoutSize(over);
      if (
        Buffer.byteLength(JSON.stringify(over)) > CABINET_LIMITS.layout_bytes ||
        size.cabinets > CABINET_LIMITS.cabinets ||
        size.folders > CABINET_LIMITS.folders_total ||
        size.nodes > CABINET_LIMITS.nodes
      ) {
        throw new ApiError(422, 'cabinet_too_big', CABINET_TOO_BIG, { detail: 'layout' });
      }
    }
    return cabinet.preview(principal(req), {
      levels: [...chosen] as CabinetLevel[],
      ...(body.cabinet ? { cabinet: body.cabinet } : {}),
      ...(over ? { layout: over } : {}),
    });
  });

  // Bring your tree (0.9.0, C4, `features.source_folders`): drawn, not saved.
  app.get('/api/v1/cabinet/from-folders', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.fromFolders(principal(req));
  });

  app.get('/api/v1/cabinet/counts', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.counts(principal(req));
  });

  // The papers no shown folder holds (19 Nov 2026): what "N aren't in any folder" lists.
  app.get('/api/v1/cabinet/unfiled', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const q = parse(pageQuery, req.query ?? {});
    return cabinet.unfiled(principal(req), q);
  });

  app.get<{ Params: { id: string } }>('/api/v1/documents/:id/also-in', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.alsoIn(principal(req), req.params.id);
  });

  // Dividers and pins (0.9.0, C2, `features.cabinet_dividers`, `cabinet_pins`):
  // a folder of the caller's own, by its id in their layout.
  app.get<{ Params: { id: string } }>('/api/v1/cabinet/folders/:id', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.folder(principal(req), req.params.id);
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/cabinet/folders/:id/documents',
    auth,
    async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const q = parse(dividerQuery, req.query ?? {});
      return cabinet.folderDocuments(principal(req), req.params.id, q);
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/cabinet/folders/:id/pins', auth, async (req) => {
    const body = parse(pinsBody, req.body ?? {});
    return cabinet.pin(principal(req), req.params.id, body.document_ids);
  });

  app.delete<{ Params: { id: string; documentId: string } }>(
    '/api/v1/cabinet/folders/:id/pins/:documentId',
    auth,
    async (req, reply) => {
      await cabinet.unpin(principal(req), req.params.id, req.params.documentId);
      return reply.status(204).send();
    },
  );

  // Who issued it, as the household names it (0.9.0-dev.91,
  // `features.cabinet_issuer`): its issuers as the caller can read them,
  // and the "Same as" list, which owners and adults keep.
  app.get('/api/v1/issuers/groups', auth, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return cabinet.issuerGroups(principal(req));
  });

  app.post('/api/v1/issuers/same', auth, async (req) =>
    cabinet.sameIssuer(principal(req), parse(issuerChange, req.body ?? {}), metaOf(req)),
  );

  app.post('/api/v1/issuers/separate', auth, async (req) =>
    cabinet.separateIssuer(principal(req), parse(issuerChange, req.body ?? {}), metaOf(req)),
  );
}
