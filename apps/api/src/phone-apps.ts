import { APP_UPDATE_REQUIRED_CODE, APP_UPDATE_REQUIRED_MESSAGE, meetsMinimum } from '@fdv/shared';
import type { FastifyRequest } from 'fastify';
import { presentsAppToken, presentsBasic } from './apps/keys.js';
import { presentsDeviceKey } from './devices/routes.js';
import { ApiError } from './errors.js';
import table from './phone-apps.json' with { type: 'json' };

/**
 * The phone apps released, each with the vault tag its `@fdv/client` came
 * from (the phone pins this repository at a tag), newest first; and the
 * oldest this vault still works with. `phone-apps.json` is the one place
 * either is written: every phone release adds its row there, and
 * `scripts/older-client.mjs --all-supported` runs the client contract with
 * the client of every app at or above the minimum.
 *
 * Raising `min_client_version` is a decision, made on purpose: every phone
 * below it is told to update (426 app_update_required) on its next call.
 */
export interface PhoneApp {
  /** The app's version, as its User-Agent says it. */
  app: string;
  /** The vault tag whose packages/client the app carries. */
  vault_tag: string;
}

export const PHONE_APPS: readonly PhoneApp[] = table.apps;

/** The oldest phone app this vault works with: sent as `min_client_version`. */
export const MIN_CLIENT_VERSION: string = table.min_client_version;

/** The phone apps this vault still works with, newest first. */
export const SUPPORTED_PHONE_APPS: readonly PhoneApp[] = PHONE_APPS.filter((a) =>
  meetsMinimum(a.app, MIN_CLIENT_VERSION),
);

/**
 * The app version a phone's User-Agent says: `FamilyDocumentVault/x.y.z
 * (Android 15; Pixel 8a)`. Null for anything else — a browser, a script,
 * no User-Agent at all, one whose version cannot be read, or 0.0.0 (the
 * phone's own "I cannot tell").
 */
export function phoneAppVersion(userAgent: string | string[] | undefined): string | null {
  if (typeof userAgent !== 'string') return null;
  const m = /^FamilyDocumentVault\/(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]*)?(?:\s|$)/.exec(
    userAgent.trim(),
  );
  // 0.0.0 is what the phone says when it cannot read its own version: unknown.
  return m && m[1] !== '0.0.0' ? (m[1] as string) : null;
}

/** Whether a User-Agent is the phone app, older than this vault works with. */
export function phoneAppTooOld(userAgent: string | string[] | undefined): boolean {
  const version = phoneAppVersion(userAgent);
  return version !== null && !meetsMinimum(version, MIN_CLIENT_VERSION);
}

/**
 * What an app too old may still ask: the capability document (which says
 * the minimum, so the app can tell its person why), the health checks,
 * renewing its session, and signing out. Each as `METHOD path`.
 *
 * The renewal is answered because every released client ends its session
 * on a refusal of it, and a phone wipes what it keeps offline when it is
 * signed out that way: a phone that keeps only its refresh token renews
 * first thing, and would be signed out before it could say "update". And
 * signing out needs an access token, which only a renewal gives.
 */
const STILL_ANSWERED: ReadonlySet<string> = new Set([
  'GET /api/v1/capabilities',
  'HEAD /api/v1/capabilities',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
]);

/**
 * The onRequest check (0.9.0-dev.79): a phone app below the minimum is
 * answered 426 app_update_required. Only the API is checked — never the web
 * app's files, the health checks, or a page somebody's browser opens; only
 * the phone app's User-Agent — never a browser, another client, or a
 * request with none; and never a connected app or a paired computer, whose
 * keys are other programs', whatever they call themselves.
 */
export function refuseOldPhoneApp(req: FastifyRequest): void {
  const path = req.url.split('?', 1)[0] as string;
  if (!path.startsWith('/api/')) return;
  if (STILL_ANSWERED.has(`${req.method} ${path}`)) return;
  if (!phoneAppTooOld(req.headers['user-agent'])) return;
  if (presentsBasic(req.headers) || presentsAppToken(req.headers) || presentsDeviceKey(req)) return;
  // 426 without an Upgrade header: a known deviation from RFC 9110 (there is
  // no protocol to upgrade to); every released client reads the envelope.
  throw new ApiError(426, APP_UPDATE_REQUIRED_CODE, APP_UPDATE_REQUIRED_MESSAGE, {
    minClientVersion: MIN_CLIENT_VERSION,
  });
}
