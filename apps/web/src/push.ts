import { api } from './api.js';

/**
 * Turning notifications on, from the browser's side.
 *
 * Everything here degrades quietly: a browser without push, a refused
 * permission, or a vault with no VAPID keys all end in a plain sentence
 * rather than a broken screen.
 */

export type PushState =
  | { kind: 'unsupported'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'off' }
  | { kind: 'on' };

export function supported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** base64url → the Uint8Array the Push API wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export async function currentState(token: string): Promise<PushState> {
  if (!supported()) {
    return {
      kind: 'unsupported',
      message: 'This browser cannot show notifications. Try adding the vault to your home screen.',
    };
  }
  const key = await api.pushKey().catch(() => ({ enabled: false, public_key: null }));
  if (!key.enabled) {
    return {
      kind: 'unavailable',
      message: 'This vault has no notification keys yet. Regenerate .env, or ask whoever runs it.',
    };
  }
  if (Notification.permission === 'denied') {
    return {
      kind: 'blocked',
      message: 'Notifications are blocked for this site in your browser settings.',
    };
  }
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { kind: 'off' };
  // Make sure the server still knows about this subscription.
  const devices = await api.devices(token).catch(() => ({ items: [] }));
  const known = devices.items.some((d) => d.endpoint === sub.endpoint && d.working);
  return known ? { kind: 'on' } : { kind: 'off' };
}

/** Asks for permission, subscribes, and registers the device. */
export async function enable(token: string): Promise<PushState> {
  if (!supported())
    return { kind: 'unsupported', message: 'This browser cannot show notifications.' };
  const key = await api.pushKey();
  if (!key.enabled || !key.public_key) {
    return { kind: 'unavailable', message: 'This vault has no notification keys yet.' };
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      kind: 'blocked',
      message: 'You said no to notifications. You can change that in your browser settings.',
    };
  }
  const reg = await registration();
  if (!reg)
    return {
      kind: 'unsupported',
      message: 'This browser would not start the notification worker.',
    };
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key.public_key) as BufferSource,
    }));
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    return { kind: 'unsupported', message: 'This browser gave an incomplete subscription.' };
  }
  await api.registerDevice(token, {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    label: deviceLabel(),
  });
  return { kind: 'on' };
}

/**
 * Signed in again (0.4.14): a browser that already has notifications on
 * tells the vault once more, so its row follows the new sign-in — and ends
 * with it, not with the one before. Quietly: nothing here asks anything.
 */
export async function repost(token: string): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    const json = sub?.toJSON() as
      { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
    await api.registerDevice(token, {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      label: deviceLabel(),
    });
  } catch {
    // Turning them on again in Notifications does the same.
  }
}

export async function disable(token: string): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.removeDevice(token, sub.endpoint).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return { kind: 'off' };
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone or iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'This device';
}
