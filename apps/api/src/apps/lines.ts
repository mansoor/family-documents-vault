import type { AppCaller } from './service.js';

/**
 * What a connected app's line in the activity log says of the app: its id
 * and its name as it is now — and, for an app acting as itself (APP8),
 * `as_itself`, so the line names the app alone ("Acme Money sent a file to
 * Sara’s Inbox"), never a person as the doer. `more` is the line's own.
 */
export function appLine(
  c: Pick<AppCaller, 'appId' | 'name' | 'actsAs'>,
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    app_id: c.appId,
    app: c.name,
    ...(c.actsAs === 'app' ? { as_itself: true } : {}),
    ...more,
  };
}
