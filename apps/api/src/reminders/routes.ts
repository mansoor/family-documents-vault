import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import type { ReminderService } from './service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerReminders(app: FastifyInstance, reminders: ReminderService): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;

  app.get<{ Querystring: { state?: string } }>('/api/v1/reminders', auth, async (req) => {
    const state = parse(z.enum(['due', 'upcoming', 'all']).default('all'), req.query.state);
    return { items: await reminders.list(principal(req), state) };
  });

  app.post('/api/v1/reminders', auth, async (req, reply) => {
    const body = parse(
      z.object({
        document_id: z.string().uuid(),
        fire_at: isoDate,
        note: z.string().max(500).nullable().optional(),
        recurrence: z.string().max(20).nullable().optional(),
      }),
      req.body,
    );
    return reply.status(201).send(await reminders.createManual(principal(req), body, metaOf(req)));
  });

  app.post<{ Params: { id: string } }>('/api/v1/reminders/:id/snooze', auth, async (req) => {
    const body = parse(z.object({ until: z.union([isoDate, z.literal('expiry')]) }), req.body);
    return reminders.snooze(principal(req), req.params.id, body.until, metaOf(req));
  });

  app.post<{ Params: { id: string } }>('/api/v1/reminders/:id/acknowledge', auth, async (req) =>
    reminders.acknowledge(principal(req), req.params.id, metaOf(req)),
  );

  app.delete<{ Params: { id: string } }>('/api/v1/reminders/:id', auth, async (req, reply) => {
    await reminders.remove(principal(req), req.params.id, metaOf(req));
    return reply.status(204).send();
  });
}
