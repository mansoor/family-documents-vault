import { lookup as dnsLookup, type LookupAllOptions } from 'node:dns';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { appendAudit, withHousehold, type Db } from '@fdv/db';
import {
  isPrivateAddress,
  PUSH_TTL_SECONDS,
  pushTopic,
  type PushMessage,
  type PushType,
} from '@fdv/shared';
import webpush from 'web-push';
import type { VapidKeys } from './notify.js';

/**
 * Sending one push (4.13), to a browser (Web Push) or a phone (UnifiedPush)
 * — the same protocol, the same VAPID keys, the same encryption (RFC 8291).
 *
 * Where it may go: only https, and never to an address inside the vault's
 * own network — loopback, private, link-local (cloud metadata) and the
 * like — unless the operator allows it (FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS,
 * for a distributor on the LAN). The check is made when the connection is
 * made, on the address DNS gives then, so a name that changes after the
 * device registered is still caught (a blind-SSRF guard).
 *
 * What an answer means for the device:
 *  - 404 or 410: the subscription is gone — the row is deleted and audited.
 *  - 400, 401, 403 or 413: it will never work as it is — marked failed.
 *  - 429, 5xx, no answer: maybe later — counted; the tenth in a row marks it
 *    failed, and one success resets the count.
 */

export class PrivateAddressError extends Error {
  readonly code = 'EPRIVATE';
}

/** How many transient failures in a row mark a device failed. */
export const FAILURES_BEFORE_FAILED = 10;

/** DNS as usual, but no address inside the vault's own network (unless allowed). */
export function safeLookup(
  allowPrivate: boolean,
  base: typeof dnsLookup = dnsLookup,
): LookupFunction {
  return ((
    hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    base(hostname, { ...(options as object), all: true } as LookupAllOptions, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses;
      const [first] = list;
      if (!first) return callback(new Error(`${hostname} has no address`), '', 0);
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(
          new PrivateAddressError(`${hostname} is inside the vault's own network`),
          '',
          0,
        );
      }
      if (options.all) return callback(null, list);
      return callback(null, first.address, first.family);
    });
  }) as LookupFunction;
}

/** The only way a push leaves the worker. */
export function createPushAgent(opts: {
  allowPrivate: boolean;
  /** Tests: a lookup of their own, and the fake distributor's certificate. */
  lookup?: typeof dnsLookup;
  ca?: string | Buffer;
}): https.Agent {
  return new https.Agent({
    lookup: safeLookup(opts.allowPrivate, opts.lookup),
    ...(opts.ca ? { ca: opts.ca } : {}),
    keepAlive: false,
  });
}

/** Push as the rest of the worker sends it: the safe agent unless told otherwise. */
let defaultAgent: https.Agent | null = null;
export function pushDepsOf(deps: {
  app: Db;
  vapid: VapidKeys | null;
  agent?: https.Agent;
  allowPrivate?: boolean;
  log: PushDeps['log'];
}): PushDeps {
  const allowPrivate = deps.allowPrivate ?? false;
  defaultAgent ??= createPushAgent({ allowPrivate: false });
  return {
    app: deps.app,
    vapid: deps.vapid,
    log: deps.log,
    allowPrivate,
    agent: deps.agent ?? (allowPrivate ? createPushAgent({ allowPrivate }) : defaultAgent),
  };
}

export interface PushDeps {
  app: Db;
  vapid: VapidKeys | null;
  agent: https.Agent;
  allowPrivate: boolean;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export interface PushDevice {
  /** Null for a device already removed (its session ended): nothing to update. */
  id: string | null;
  household_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type Delivery = 'sent' | 'gone' | 'failed' | 'counted' | 'refused';

/** What a UnifiedPush message says: never a title, a name or a kind of document. */
export const unifiedPayload = (m: PushMessage): string => JSON.stringify(m);

/**
 * One push to one device. `type` sets how long it may wait and its Topic
 * (a newer message of the same type replaces an older one still waiting).
 */
export async function deliver(
  deps: PushDeps,
  device: PushDevice,
  payload: string,
  type: PushType,
  opts: { urgency?: 'normal' | 'high'; topic?: boolean } = {},
): Promise<Delivery> {
  if (!deps.vapid) return 'refused';
  let url: URL;
  try {
    url = new URL(device.endpoint);
  } catch {
    await mark(deps, device, 'failed', 'not a URL');
    return 'refused';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Node makes no DNS lookup for an address written out: checked here.
  if (url.protocol !== 'https:' || (!deps.allowPrivate && isIP(host) && isPrivateAddress(host))) {
    await mark(deps, device, 'failed', url.protocol !== 'https:' ? 'not https' : 'private address');
    deps.log('warn', 'push refused', { device_id: device.id, reason: 'address' });
    return 'refused';
  }
  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      payload,
      {
        TTL: PUSH_TTL_SECONDS[type],
        urgency: opts.urgency ?? 'normal',
        // One Topic per type, so a newer one replaces an older still waiting;
        // never for alerts, where one must not replace another.
        ...(opts.topic === false ? {} : { topic: pushTopic(type) }),
        vapidDetails: deps.vapid,
        agent: deps.agent,
      },
    );
    await mark(deps, device, 'sent');
    return 'sent';
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    const refused =
      err instanceof PrivateAddressError || (err as { code?: string }).code === 'EPRIVATE';
    if (refused) {
      await mark(deps, device, 'failed', 'private address');
      deps.log('warn', 'push refused', { device_id: device.id, reason: 'private address' });
      return 'refused';
    }
    if (status === 404 || status === 410) {
      await mark(deps, device, 'gone');
      deps.log('info', 'push subscription gone', { device_id: device.id, status });
      return 'gone';
    }
    if (status === 400 || status === 401 || status === 403 || status === 413) {
      await mark(deps, device, 'failed', `${status}`);
      deps.log('warn', 'push refused by the push service', { device_id: device.id, status });
      return 'failed';
    }
    await mark(deps, device, 'counted', `${status ?? 'no answer'}`);
    deps.log('warn', 'push failed, will try again next time', { device_id: device.id, status });
    return 'counted';
  }
}

/** What an answer does to the device's row. */
async function mark(
  deps: PushDeps,
  device: PushDevice,
  outcome: 'sent' | 'gone' | 'failed' | 'counted',
  reason?: string,
): Promise<void> {
  const id = device.id;
  if (!id) return;
  await withHousehold(deps.app, device.household_id, async (trx) => {
    if (outcome === 'sent') {
      await trx
        .updateTable('device')
        .set({
          last_used_at: new Date(),
          consecutive_failures: 0,
          failed_at: null,
          fail_reason: null,
        })
        .where('id', '=', id)
        .execute();
    } else if (outcome === 'gone') {
      const gone = await trx
        .deleteFrom('device')
        .where('id', '=', id)
        .returning(['account_id'])
        .executeTakeFirst();
      if (gone) {
        await appendAudit(trx, {
          householdId: device.household_id,
          actorAccountId: gone.account_id,
          action: 'notifications.device_gone',
          objectType: 'device',
          objectId: id,
        });
      }
    } else if (outcome === 'failed') {
      await trx
        .updateTable('device')
        .set({ failed_at: new Date(), fail_reason: (reason ?? 'failed').slice(0, 200) })
        .where('id', '=', id)
        .execute();
    } else {
      const row = await trx
        .updateTable('device')
        .set((eb) => ({ consecutive_failures: eb('consecutive_failures', '+', 1) }))
        .where('id', '=', id)
        .returning(['consecutive_failures'])
        .executeTakeFirst();
      if (row && row.consecutive_failures >= FAILURES_BEFORE_FAILED) {
        await trx
          .updateTable('device')
          .set({
            failed_at: new Date(),
            fail_reason: `${reason ?? 'failed'} (${row.consecutive_failures} in a row)`.slice(
              0,
              200,
            ),
          })
          .where('id', '=', id)
          .execute();
      }
    }
  });
}

/**
 * The `push.send` job (4.13): pushes the API asks for — a device's test, a
 * session that ended (to devices already removed with it). The targets
 * carry what sending needs, since the rows may be gone.
 */
export interface PushJob {
  household_id: string;
  message: PushMessage;
  targets: {
    id: string | null;
    kind: 'web_push' | 'unified_push';
    endpoint: string;
    p256dh: string;
    auth: string;
  }[];
}

export function isPushJob(v: unknown): v is PushJob {
  const j = v as PushJob | null;
  return (
    !!j &&
    typeof j.household_id === 'string' &&
    !!j.message &&
    typeof j.message.type === 'string' &&
    Array.isArray(j.targets) &&
    j.targets.every(
      (t) =>
        typeof t.endpoint === 'string' &&
        typeof t.p256dh === 'string' &&
        typeof t.auth === 'string',
    )
  );
}

/** A web browser gets a notification it can show; a phone, only the word. */
export function payloadFor(kind: 'web_push' | 'unified_push', m: PushMessage): string {
  if (kind === 'unified_push') return unifiedPayload(m);
  const words: Record<PushMessage['type'], string> = {
    digest: 'You have reminders today.',
    new_device: 'Your account was used on a new device.',
    owner_change: 'Something changed about who owns your family vault.',
    session_ended: 'You were signed out.',
    test: 'Notifications work on this device.',
  };
  return JSON.stringify({
    title: 'Family Document Vault',
    body: words[m.type],
    tag: pushTopic(m.type),
  });
}

export async function sendPushJob(deps: PushDeps, job: PushJob): Promise<Record<Delivery, number>> {
  const counts: Record<Delivery, number> = { sent: 0, gone: 0, failed: 0, counted: 0, refused: 0 };
  for (const t of job.targets) {
    const outcome = await deliver(
      deps,
      {
        id: t.id,
        household_id: job.household_id,
        endpoint: t.endpoint,
        p256dh: t.p256dh,
        auth: t.auth,
      },
      payloadFor(t.kind, job.message),
      job.message.type,
    );
    counts[outcome] += 1;
  }
  return counts;
}
