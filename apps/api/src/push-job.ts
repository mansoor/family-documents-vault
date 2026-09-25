import type { Db } from '@fdv/db';
import type { PushMessage } from '@fdv/shared';

/**
 * What the API asks the worker to push (`push.send`, 4.13): a device's
 * test, and "you were signed out" to the phones of a session that ended.
 * The worker's `PushJob` in apps/worker/src/jobs/push.ts is the other half
 * of this shape; like alerts (see alert-job.ts), one mapping serves the
 * server and the test harness alike.
 */
export interface PushTarget {
  /** Null once the device is removed (a session that ended): nothing to update after. */
  id: string | null;
  kind: 'web_push' | 'unified_push';
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRequest {
  householdId: string;
  message: PushMessage;
  targets: PushTarget[];
}

export function pushJob(r: PushRequest): Record<string, unknown> {
  return { household_id: r.householdId, message: r.message, targets: r.targets };
}

/**
 * The devices of sessions that are ending, removed in the same transaction
 * (4.13): nothing more is pushed to them. Returned are the phones among
 * them — UnifiedPush — which are told `session_ended` once it commits, so
 * the app can forget what it holds; a browser is not told, it simply stops
 * hearing.
 *
 * `sessionIds` narrows it to those sessions; `exceptSessionId` keeps one
 * (the one changing its password); neither, and it is every device of the
 * account in this household — those from before 0.4.2, which name no
 * session, included.
 */
export async function endDevices(
  trx: Db,
  opts: { accountId: string; sessionIds?: string[]; exceptSessionId?: string },
): Promise<PushTarget[]> {
  if (opts.sessionIds && opts.sessionIds.length === 0) return [];
  let q = trx
    .deleteFrom('device')
    .where('account_id', '=', opts.accountId)
    .returning(['kind', 'endpoint', 'p256dh', 'auth']);
  if (opts.sessionIds) q = q.where('session_id', 'in', opts.sessionIds);
  if (opts.exceptSessionId) {
    const keep = opts.exceptSessionId;
    q = q.where((eb) => eb.or([eb('session_id', 'is', null), eb('session_id', '!=', keep)]));
  }
  const gone = await q.execute();
  return gone.flatMap((d) =>
    d.kind === 'unified_push' && d.p256dh && d.auth
      ? [
          {
            id: null,
            kind: 'unified_push' as const,
            endpoint: d.endpoint,
            p256dh: d.p256dh,
            auth: d.auth,
          },
        ]
      : [],
  );
}

/** Tells the phones of an ended session, once it has committed. */
export const SESSION_ENDED: PushMessage = { v: 1, type: 'session_ended' };
