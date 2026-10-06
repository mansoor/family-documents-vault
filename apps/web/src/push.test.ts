import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api.js';
import { enable, repost } from './push.js';

/**
 * A shared browser whose address the vault keeps for somebody else, still
 * signed in (`409 device_taken`, the Phase 5 exit): the browser gives that
 * address up and makes a new one for whoever turns notifications on now
 * (the second round, C-01).
 */

interface FakeSub {
  endpoint: string;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
}

describe('notifications in a shared browser (C-01)', () => {
  let current: FakeSub | null;
  let made = 0;
  const sub = (name: string): FakeSub => {
    const s: FakeSub = {
      endpoint: `https://push.example.test/${name}`,
      toJSON: () => ({
        endpoint: `https://push.example.test/${name}`,
        keys: { p256dh: `${name}-p256dh`, auth: `${name}-auth` },
      }),
      unsubscribe: vi.fn(() => {
        if (current === s) current = null;
        return Promise.resolve(true);
      }),
    };
    return s;
  };
  const reg = {
    pushManager: {
      getSubscription: vi.fn(() => Promise.resolve(current)),
      subscribe: vi.fn(() => {
        made += 1;
        current = sub(`made-${made}`);
        return Promise.resolve(current);
      }),
    },
  };
  const taken = () =>
    new ApiRequestError(
      409,
      'device_taken',
      'This device already gets somebody else’s notifications from this vault.',
    );

  beforeEach(() => {
    made = 0;
    current = sub('before');
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      serviceWorker: {
        register: vi.fn(() => Promise.resolve(reg)),
        getRegistration: vi.fn(() => Promise.resolve(reg)),
      },
    });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', {
      permission: 'granted',
      requestPermission: vi.fn(() => Promise.resolve('granted')),
    });
    vi.spyOn(api, 'pushKey').mockResolvedValue({ enabled: true, public_key: 'AQAB' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    reg.pushManager.subscribe.mockClear();
  });

  for (const [name, run] of [
    ['turning them on', (t: string) => enable(t)],
    ['signing in again', (t: string) => repost(t)],
  ] as const) {
    it(`${name}: somebody else's address is given up for a new one, and that one is posted`, async () => {
      const before = current as FakeSub;
      const posted: string[] = [];
      vi.spyOn(api, 'registerDevice').mockImplementation((_t, body) => {
        posted.push(body.endpoint);
        return posted.length === 1 ? Promise.reject(taken()) : Promise.resolve({ id: 'd1' });
      });
      const result = await run('token');
      if (name === 'turning them on') expect(result).toEqual({ kind: 'on' });
      expect(before.unsubscribe).toHaveBeenCalledTimes(1);
      expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([
        'https://push.example.test/before',
        'https://push.example.test/made-1',
      ]);
    });

    it(`${name}: an address of one's own is posted once, and kept`, async () => {
      const before = current as FakeSub;
      const register = vi.spyOn(api, 'registerDevice').mockResolvedValue({ id: 'd1' });
      await run('token');
      expect(register).toHaveBeenCalledTimes(1);
      expect(before.unsubscribe).not.toHaveBeenCalled();
      expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    });
  }

  it('any other refusal is not a reason to give the address up', async () => {
    const before = current as FakeSub;
    vi.spyOn(api, 'registerDevice').mockRejectedValue(
      new ApiRequestError(
        503,
        'push_unavailable',
        'This vault is not set up for notifications yet.',
      ),
    );
    await expect(enable('token')).rejects.toMatchObject({ code: 'push_unavailable' });
    expect(before.unsubscribe).not.toHaveBeenCalled();
  });
});
