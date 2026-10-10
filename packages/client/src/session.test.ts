import type { Tokens } from '@fdv/shared';
import { describe, expect, it } from 'vitest';
import { createApi } from './api.js';
import { createHttp } from './http.js';
import { ApiRequestError } from './errors.js';
import {
  SessionCore,
  type CrossContextLock,
  type StoredSession,
  type TokenStore,
} from './session.js';
import { createFakeVault } from './testing/fake.js';

/** A TokenStore that records what was saved, and can be slow about it. */
function memoryStore(initial: StoredSession | null = null) {
  const saved: Array<StoredSession | null> = [];
  let current = initial;
  const store: TokenStore = {
    load: async () => current,
    save: async (s) => {
      current = s;
      saved.push(s);
    },
  };
  return { store, saved, current: () => current };
}

async function signedInVault() {
  const vault = createFakeVault();
  const api = createApi(createHttp({ baseUrl: 'https://vault.example', fetch: vault.fetch }));
  const t = await api.setup({
    household_name: 'Test',
    display_name: 'Owner',
    email: 'owner@example.test',
    password: 'a long enough password',
  });
  return { vault, api, tokens: t };
}

describe('the session core', () => {
  it('five calls that find the access token expired make exactly one refresh', async () => {
    const { vault, api, tokens } = await signedInVault();
    const { store } = memoryStore();
    let clock = 0;
    const session = new SessionCore(api, store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000; // past the 15-minute access token

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => session.token()));
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    expect(new Set(results.map((r) => (r.kind === 'ok' ? r.token : '')))).toHaveProperty('size', 1);
    expect(vault.state.calls.filter((c) => c.path === '/api/v1/auth/refresh')).toHaveLength(1);
    // And the session is alive: the fake would have revoked it on a replay.
    expect(vault.state.sessions.every((s) => !s.revoked)).toBe(true);
  });

  it('without the guard the same five would have signed the person out', async () => {
    // The race this package exists to stop, reproduced by hand against the
    // same fake: two refreshes with one token.
    const { vault, api, tokens } = await signedInVault();
    await Promise.allSettled([
      api.refresh(tokens.refresh_token),
      api.refresh(tokens.refresh_token),
    ]);
    await api.refresh(tokens.refresh_token).catch(() => undefined);
    expect(vault.state.sessions.some((s) => s.revoked)).toBe(true);
  });

  it('a refresh lost to the network reports offline and keeps the stored session', async () => {
    const { vault, api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const session = new SessionCore(api, mem.store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    vault.state.offline = true;

    expect(await session.token()).toEqual({ kind: 'offline' });
    expect(session.signedIn).toBe(true);
    expect(mem.current()?.refresh_token).toBe(tokens.refresh_token);

    // Back online, the same refresh token still works.
    vault.state.offline = false;
    expect((await session.token()).kind).toBe('ok');
  });

  it('session_ended and unauthenticated end the session; a wrong password never does', async () => {
    const { vault, api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const session = new SessionCore(api, mem.store, { now: () => clock });
    await session.accept(tokens);
    // Somebody else spent this refresh token first.
    vault.state.sessions.forEach((s) => (s.revoked = true));
    clock = 20 * 60 * 1000;

    const r = await session.token();
    expect(r.kind).toBe('ended');
    // The vault says why (0.4.11): this one was revoked.
    expect(r.kind === 'ended' && r.reason).toBe('revoked');
    expect(session.signedIn).toBe(false);
    expect(mem.current()).toBeNull();

    // A wrong password is a refusal the caller shows, not an ending.
    const wrong = await api.signIn('owner@example.test', 'nope nope nope').catch((e: unknown) => e);
    expect((wrong as { code: string }).code).toBe('invalid_credentials');
  });

  it('the store is written before anybody is handed the new token', async () => {
    const { api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const session = new SessionCore(api, mem.store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    const r = await session.token();
    expect(r.kind).toBe('ok');
    const latest = mem.saved[mem.saved.length - 1] as StoredSession;
    expect(latest.refresh_token).not.toBe(tokens.refresh_token);
  });

  it('a phone that reads its store later hydrates, and a signed-out one says so', async () => {
    const { api, tokens } = await signedInVault();
    const stored: StoredSession = {
      refresh_token: tokens.refresh_token,
      household_id: tokens.household_id,
      member_id: tokens.member_id,
      role: tokens.role,
    };
    const session = new SessionCore(api, memoryStore(stored).store);
    expect(session.signedIn).toBe(false);
    await session.hydrate();
    expect(session.signedIn).toBe(true);
    expect((await session.token()).kind).toBe('ok');

    const empty = new SessionCore(api, memoryStore().store);
    await empty.hydrate();
    expect(await empty.token()).toEqual({ kind: 'signed_out' });
  });

  it('a sign-in that lands while an old refresh is failing keeps the new session', async () => {
    const { vault, api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const slow = {
      refresh: async (rt: string): Promise<Tokens> => {
        await new Promise<void>((r) => setTimeout(() => r(), 20));
        return api.refresh(rt);
      },
    };
    const session = new SessionCore(slow, mem.store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    vault.state.sessions.forEach((s) => (s.revoked = true));
    const pending = session.token();
    const fresh = await api.signIn('owner@example.test', 'a long enough password');
    await session.accept(fresh as Tokens);
    const r = await pending;
    expect(r.kind).toBe('ok');
    expect(session.signedIn).toBe(true);
  });

  /** A lock like Web Locks: callers queue and run one at a time. */
  const queueLock = (): CrossContextLock => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>) => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    };
  };

  it('a second tab uses the refresh token the first one saved, not its own stale copy', async () => {
    const { vault, api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const tabA = new SessionCore(api, mem.store, { now: () => clock });
    await tabA.accept(tokens);
    // Tab B opened a moment later, from what the store held then.
    const tabB = new SessionCore(api, mem.store, { initial: mem.current(), now: () => clock });
    clock = 20 * 60 * 1000;
    expect((await tabA.token()).kind).toBe('ok'); // rotates R1 -> R2
    expect((await tabB.token()).kind).toBe('ok'); // must present R2, not R1
    expect(vault.state.sessions.every((s) => !s.revoked)).toBe(true);
  });

  it('two tabs refreshing at the same moment take turns under the lock', async () => {
    const { vault, api, tokens } = await signedInVault();
    const mem = memoryStore();
    const lock = queueLock();
    let clock = 0;
    const tabA = new SessionCore(api, mem.store, { now: () => clock, lock });
    await tabA.accept(tokens);
    const tabB = new SessionCore(api, mem.store, {
      initial: mem.current(),
      now: () => clock,
      lock,
    });
    clock = 20 * 60 * 1000;
    const [a, b] = await Promise.all([tabA.token(), tabB.token()]);
    expect([a.kind, b.kind]).toEqual(['ok', 'ok']);
    expect(vault.state.sessions.every((s) => !s.revoked)).toBe(true);
  });

  it('a refresh that succeeds after somebody else signed in does not overwrite them', async () => {
    const { api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    let release: () => void = () => undefined;
    const held = {
      refresh: async (rt: string): Promise<Tokens> => {
        await new Promise<void>((r) => (release = r));
        return api.refresh(rt);
      },
    };
    const session = new SessionCore(held, mem.store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    const pending = session.token();
    await new Promise<void>((r) => setTimeout(() => r(), 0));
    const fresh = (await api.signIn('owner@example.test', 'a long enough password')) as Tokens;
    await session.accept({ ...fresh, member_id: 'the-new-person' });
    release();
    await pending;
    expect(session.info?.member_id).toBe('the-new-person');
    expect(mem.current()?.refresh_token).toBe(fresh.refresh_token);
  });

  it('a refresh that succeeds after signing out does not sign anybody back in', async () => {
    const { api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    let release: () => void = () => undefined;
    const held = {
      refresh: async (rt: string): Promise<Tokens> => {
        await new Promise<void>((r) => (release = r));
        return api.refresh(rt);
      },
    };
    const session = new SessionCore(held, mem.store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    const pending = session.token();
    await new Promise<void>((r) => setTimeout(() => r(), 0));
    await session.clear();
    release();
    expect(await pending).toEqual({ kind: 'signed_out' });
    expect(session.signedIn).toBe(false);
    expect(mem.current()).toBeNull();
  });

  it('a 401 from something in front of the vault is not the vault ending the session', async () => {
    const { tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const proxy = {
      refresh: async (): Promise<Tokens> => {
        // A login page from an auth proxy: a 401, but not the vault's envelope.
        throw new ApiRequestError(401, 'http_error', 'The server answered 401.');
      },
    };
    const session = new SessionCore(proxy, mem.store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    expect(await session.token()).toEqual({ kind: 'offline' });
    expect(mem.current()?.refresh_token).toBe(tokens.refresh_token);
  });

  it('the vault refusing a malformed refresh token ends the session rather than stranding it', async () => {
    const { tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const refuses = {
      refresh: async (): Promise<Tokens> => {
        throw new ApiRequestError(422, 'validation_failed', 'That is not a refresh token.');
      },
    };
    const session = new SessionCore(refuses, mem.store, { now: () => clock });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    expect((await session.token()).kind).toBe('ended');
    expect(mem.current()).toBeNull();
  });

  it('a tab whose sibling signed out finds itself signed out too', async () => {
    const { api, tokens } = await signedInVault();
    const mem = memoryStore();
    let clock = 0;
    const tabA = new SessionCore(api, mem.store, { now: () => clock });
    await tabA.accept(tokens);
    const tabB = new SessionCore(api, mem.store, { initial: mem.current(), now: () => clock });
    await tabA.clear();
    clock = 20 * 60 * 1000;
    expect(await tabB.token()).toEqual({ kind: 'signed_out' });
    expect(tabB.signedIn).toBe(false);
  });
});

/**
 * A renewal turned away for too many tries (429; the PR #100
 * investigation): a short Retry-After is waited out and the renewal asked
 * again — twice at most, and only for a minute or less — and it is never
 * "signed out".
 */
describe('a renewal turned away for too many tries', () => {
  /** A vault that answers 429 to the first `refusals` renewals, asking for `after` seconds. */
  async function busyVault(refusals: number, after: number | undefined) {
    const { api, tokens } = await signedInVault();
    let asked = 0;
    const refresher = {
      refresh: async (rt: string): Promise<Tokens> => {
        asked++;
        if (asked <= refusals) {
          throw new ApiRequestError(429, 'rate_limited', 'Too many requests.', undefined, {
            ...(after !== undefined ? { retryAfterSeconds: after } : {}),
          });
        }
        return api.refresh(rt);
      },
    };
    const mem = memoryStore();
    let clock = 0;
    const slept: number[] = [];
    const told: Array<number | null> = [];
    const session = new SessionCore(refresher, mem.store, {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
      },
      onWait: (s) => told.push(s),
    });
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    return { session, mem, slept, told, tokens, asked: () => asked };
  }

  it('a short Retry-After is waited out, said, and the renewal asked again', async () => {
    const v = await busyVault(1, 5);
    const r = await v.session.token();
    expect(r.kind).toBe('ok');
    expect(v.asked()).toBe(2);
    expect(v.slept).toEqual([5000]);
    // Said as it starts, and put away once it is over.
    expect(v.told).toEqual([5, null]);
  });

  it('five callers share the one wait and the one renewal after it', async () => {
    const v = await busyVault(1, 3);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => v.session.token()));
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    expect(v.asked()).toBe(2);
    expect(v.slept).toEqual([3000]);
  });

  it('asked again at most twice: then offline, too many tries, and still signed in', async () => {
    const v = await busyVault(10, 20);
    const r = await v.session.token();
    expect(r).toEqual({ kind: 'offline', tooMany: { retryAfterSeconds: 20 } });
    expect(v.asked()).toBe(3);
    expect(v.slept).toEqual([20000, 20000]);
    expect(v.session.signedIn).toBe(true);
    expect(v.mem.current()?.refresh_token).toBe(v.tokens.refresh_token);
  });

  it('a wait longer than a minute, or none said, is not waited out', async () => {
    for (const after of [61, 300, undefined]) {
      const v = await busyVault(1, after);
      expect(await v.session.token()).toEqual({
        kind: 'offline',
        tooMany: { retryAfterSeconds: after ?? null },
      });
      expect(v.asked()).toBe(1);
      expect(v.slept).toEqual([]);
      expect(v.told).toEqual([]);
      expect(v.session.signedIn).toBe(true);
    }
  });

  it('a minute exactly is waited out', async () => {
    const v = await busyVault(1, 60);
    expect((await v.session.token()).kind).toBe('ok');
    expect(v.slept).toEqual([60000]);
  });

  it('signed out while it waits: nothing more is asked, and nobody is signed back in', async () => {
    const { api, tokens } = await signedInVault();
    let asked = 0;
    const refresher = {
      refresh: async (rt: string): Promise<Tokens> => {
        asked++;
        if (asked === 1) {
          throw new ApiRequestError(429, 'rate_limited', 'Too many requests.', undefined, {
            retryAfterSeconds: 2,
          });
        }
        return api.refresh(rt);
      },
    };
    const mem = memoryStore();
    let clock = 0;
    const holder: { session: SessionCore | null } = { session: null };
    const session = new SessionCore(refresher, mem.store, {
      now: () => clock,
      sleep: async () => {
        await holder.session?.clear();
      },
    });
    holder.session = session;
    await session.accept(tokens);
    clock = 20 * 60 * 1000;
    expect(await session.token()).toEqual({ kind: 'signed_out' });
    expect(asked).toBe(1);
    expect(mem.current()).toBeNull();
  });
});

/**
 * The review round: a sign-in or a sign-out ends a wait at once, and the
 * wait is neither under the lock nor repeated by another context — it is
 * kept in the store, and said at once to whoever asks meanwhile.
 */
describe('a renewal’s wait, and everybody else meanwhile', () => {
  /** A vault that turns every renewal away for `after` seconds; a wait that never ends by itself. */
  async function waiting(after = 30) {
    const { api, tokens } = await signedInVault();
    let asked = 0;
    let refuse = true;
    const refresher = {
      refresh: async (rt: string): Promise<Tokens> => {
        asked++;
        if (refuse) {
          throw new ApiRequestError(429, 'rate_limited', 'Too many requests.', undefined, {
            retryAfterSeconds: after,
          });
        }
        return api.refresh(rt);
      },
    };
    const mem = memoryStore();
    let clock = 0;
    // One holder at a time, as Web Locks are for the tabs of a browser.
    let held: Promise<unknown> = Promise.resolve();
    const lock: CrossContextLock = (fn) => {
      const run = held.then(fn, fn);
      held = run.catch(() => undefined);
      return run;
    };
    const slept: number[] = [];
    const tab = (initial: StoredSession | null) =>
      new SessionCore(refresher, mem.store, {
        initial,
        now: () => clock,
        lock,
        sleep: (ms) => {
          slept.push(ms);
          return new Promise<void>(() => undefined);
        },
      });
    const a = tab(null);
    await a.accept(tokens);
    clock = 20 * 60 * 1000;
    const tick = () => new Promise<void>((r) => setTimeout(r, 10));
    return {
      a,
      tab,
      mem,
      slept,
      tokens,
      tick,
      asked: () => asked,
      answer: () => {
        refuse = false;
      },
      later: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('signing out during the wait ends it at once, and nothing more is asked', async () => {
    const v = await waiting();
    const first = v.a.token();
    await v.tick();
    expect(v.slept).toEqual([30000]);
    // Signing out asks without waiting: not behind the renewal under way.
    expect(await v.a.token({ wait: false })).toEqual({ kind: 'offline' });
    await v.a.clear();
    expect(await first).toEqual({ kind: 'signed_out' });
    await v.tick();
    expect(v.asked()).toBe(1);
    expect(v.mem.current()).toBeNull();
  });

  it('a sign-in during the wait ends it too: the new session stands', async () => {
    const v = await waiting();
    const first = v.a.token();
    await v.tick();
    await v.a.accept({ ...v.tokens, access_token: 'new-access' });
    expect(await first).toEqual({ kind: 'ok', token: 'new-access' });
    expect(v.asked()).toBe(1);
  });

  it('another tab asking during the wait is told at once, is not held by the lock, and asks nothing', async () => {
    const v = await waiting();
    void v.a.token();
    await v.tick();
    expect(v.mem.current()?.retry_not_before).toBe(20 * 60 * 1000 + 30000);
    const b = v.tab(v.mem.current());
    expect(await b.token()).toEqual({ kind: 'offline', tooMany: { retryAfterSeconds: 30 } });
    // And asked again later in the window: still nothing sent.
    v.later(12_000);
    expect(await b.token()).toEqual({ kind: 'offline', tooMany: { retryAfterSeconds: 18 } });
    expect(v.asked()).toBe(1);
    expect(b.signedIn).toBe(true);
  });

  it('this tab, asked again in a window a refusal of more than a minute left, asks nothing until it is over', async () => {
    const v = await waiting(120);
    expect(await v.a.token()).toEqual({ kind: 'offline', tooMany: { retryAfterSeconds: 120 } });
    expect(await v.a.token()).toEqual({ kind: 'offline', tooMany: { retryAfterSeconds: 120 } });
    expect(v.asked()).toBe(1);
    v.later(121_000);
    v.answer();
    expect((await v.a.token()).kind).toBe('ok');
    expect(v.asked()).toBe(2);
    // A session saved afresh has no window.
    expect(v.mem.current()?.retry_not_before).toBeUndefined();
  });
});
