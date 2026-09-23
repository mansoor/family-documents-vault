import type { Tokens } from '@fdv/shared';
import { describe, expect, it } from 'vitest';
import { createApi } from './api.js';
import { createHttp } from './http.js';
import { SessionCore, type StoredSession, type TokenStore } from './session.js';
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
    const session = new SessionCore(api, store, null, () => clock);
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
    const session = new SessionCore(api, mem.store, null, () => clock);
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
    const session = new SessionCore(api, mem.store, null, () => clock);
    await session.accept(tokens);
    // Somebody else spent this refresh token first.
    vault.state.sessions.forEach((s) => (s.revoked = true));
    clock = 20 * 60 * 1000;

    const r = await session.token();
    expect(r.kind).toBe('ended');
    expect(r.kind === 'ended' && r.reason).toBe('session_ended');
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
    const session = new SessionCore(api, mem.store, null, () => clock);
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
    const session = new SessionCore(slow, mem.store, null, () => clock);
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
});
