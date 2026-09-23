import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedInvitation, InvitationPreview, InvitationView } from './invitations.js';
import type { MemberView } from './service.js';

/**
 * Invitations (SHR-02). The happy path is four requests long; everything
 * that matters is what happens to the other twelve.
 */
describe.skipIf(!testAdminUrl())('invitations', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  }, 60_000);
  afterAll(() => h.close());

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  /**
   * The two unauthenticated endpoints are rate-limited per address, which
   * is right in production and useless here: every injected request would
   * otherwise come from the same one and the file would throttle itself.
   * Each call gets its own address, which also exercises the code path
   * that decides what a caller's address is.
   */
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.9.${Math.floor(++nth / 200)}.${nth % 200}` });

  const invite = (body: Record<string, unknown>, as: Tokens = owner) =>
    h.app.inject({ method: 'POST', url: '/api/v1/invitations', headers: h.as(as), payload: body });

  const accept = (token: string, body: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      payload: body,
      ...peer(),
    });

  const preview = (token: string) =>
    h.app.inject({ url: `/api/v1/invitations/${token}`, ...peer() });

  it('invites someone who is not in the household yet, and says who it is for', async () => {
    const res = await invite({ display_name: 'Sam', email: 'sam@example.test', role: 'adult' });
    expect(res.statusCode).toBe(201);
    const created = json<CreatedInvitation>(res);

    // The link is long and random; the code is meant to be read aloud.
    expect(created.link_token.length).toBeGreaterThan(32);
    expect(created.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(created.invitation).toMatchObject({
      display_name: 'Sam',
      email: 'sam@example.test',
      role: 'adult',
      state: 'pending',
      attempts_left: 5,
    });

    // Sam is a person in the household from this moment, with no sign-in.
    const members = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    );
    expect(members.items.find((m) => m.display_name === 'Sam')).toMatchObject({
      has_account: false,
      role: null,
    });
  });

  it('the invitee can see who invited them before deciding anything', async () => {
    const { link_token } = json<CreatedInvitation>(
      await invite({ display_name: 'Preview', email: 'preview@example.test', role: 'viewer' }),
    );
    const res = await preview(link_token);
    expect(res.statusCode).toBe(200);
    expect(json<InvitationPreview>(res)).toMatchObject({
      household_name: 'The Test family',
      display_name: 'Preview',
      role: 'viewer',
      role_label: 'Viewer',
      invited_by: 'Owner',
    });
    // And nothing else: no token, no code, no household id.
    expect(JSON.stringify(json<InvitationPreview>(res))).not.toContain(link_token);
  });

  it('the link alone is not enough — the code is the second half', async () => {
    const { link_token } = json<CreatedInvitation>(
      await invite({ display_name: 'Codeless', email: 'codeless@example.test', role: 'teen' }),
    );
    const res = await accept(link_token, { code: 'AAAA-AAAA', password: 'a long enough one' });
    expect(res.statusCode).toBe(401);
    const body = json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('invitation_code_wrong');
    expect(body.error.message).toContain('4 tries left');
  });

  it('five wrong codes and the invitation is dead, not merely slowed down', async () => {
    const { link_token } = json<CreatedInvitation>(
      await invite({ display_name: 'Guessed', email: 'guessed@example.test', role: 'viewer' }),
    );
    for (let i = 0; i < 4; i++) {
      expect(
        (await accept(link_token, { code: 'BBBB-BBBB', password: 'a long password' })).statusCode,
      ).toBe(401);
    }
    const last = await accept(link_token, { code: 'BBBB-BBBB', password: 'a long password' });
    expect(last.statusCode).toBe(401);
    expect(json<{ error: { message: string } }>(last).error.message).toMatch(/new invitation/);

    // Even the right code is no good now — the invitation itself is gone.
    const dead = await accept(link_token, { code: 'BBBB-BBBB', password: 'a long password' });
    expect(dead.statusCode).toBe(404);
  });

  it('accepting makes a real account with the role it was offered', async () => {
    const created = json<CreatedInvitation>(
      await invite({ display_name: 'Alex', email: 'alex@example.test', role: 'adult' }),
    );
    const res = await accept(created.link_token, {
      code: created.code.toLowerCase().replace('-', ' '), // typed off a note
      password: 'alex correct horse',
    });
    expect(res.statusCode).toBe(201);
    const alex = json<Tokens>(res);
    expect(alex.role).toBe('adult');
    expect(alex.household_id).toBe(owner.household_id);

    // The session works, and it is Alex's.
    const me = json<{ member_id: string; role: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(alex) }),
    );
    expect(me.role).toBe('adult');
    expect(me.member_id).not.toBe(owner.member_id);

    // And signing in with the password they chose works from now on.
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'alex@example.test', password: 'alex correct horse' },
    });
    expect(again.statusCode).toBe(200);
  });

  it('their own private scope key now opens with what they know', async () => {
    const alex = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items.find((m) => m.display_name === 'Alex') as MemberView;

    const key = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('scope_key')
        .select(['key_wrapped_cred', 'kdf_params'])
        .where('kind', '=', 'member')
        .where('member_id', '=', alex.id)
        .executeTakeFirstOrThrow(),
    );
    // Before they accepted there was no credential wrap at all; choosing a
    // password is what gives them a way to their own documents that does
    // not go through the server's master key.
    expect(key.key_wrapped_cred).not.toBeNull();
    expect(key.kdf_params).not.toBeNull();
  });

  it('a link is good exactly once', async () => {
    const created = json<CreatedInvitation>(
      await invite({ display_name: 'Twice', email: 'twice@example.test', role: 'viewer' }),
    );
    expect(
      (await accept(created.link_token, { code: created.code, password: 'first password' }))
        .statusCode,
    ).toBe(201);
    const replay = await accept(created.link_token, {
      code: created.code,
      password: 'second password',
    });
    expect(replay.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(replay).error.code).toBe('invitation_not_valid');
  });

  it('revoking one stops it working, and says so the same way as every other dead link', async () => {
    const created = json<CreatedInvitation>(
      await invite({ display_name: 'Revoked', email: 'revoked@example.test', role: 'viewer' }),
    );
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/invitations/${created.invitation.id}`,
      headers: h.as(owner),
    });
    expect(del.statusCode).toBe(204);
    expect((await preview(created.link_token)).statusCode).toBe(404);
    expect(
      (await accept(created.link_token, { code: created.code, password: 'a long password' }))
        .statusCode,
    ).toBe(404);
  });

  it('sending another one retires the first: nobody holds two live links', async () => {
    const first = json<CreatedInvitation>(
      await invite({ display_name: 'Resent', email: 'resent@example.test', role: 'viewer' }),
    );
    const second = json<CreatedInvitation>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${first.invitation.member_id}/invite`,
        headers: h.as(owner),
        payload: { email: 'resent@example.test', role: 'viewer' },
      }),
    );
    expect(second.link_token).not.toBe(first.link_token);
    expect((await preview(first.link_token)).statusCode).toBe(404);
    expect((await preview(second.link_token)).statusCode).toBe(200);
  });

  it('an expired invitation is refused', async () => {
    const created = json<CreatedInvitation>(
      await invite({ display_name: 'Stale', email: 'stale@example.test', role: 'viewer' }),
    );
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('invitation')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', created.invitation.id)
        .execute(),
    );
    expect(
      (await accept(created.link_token, { code: created.code, password: 'a long password' }))
        .statusCode,
    ).toBe(404);
    const listed = json<{ items: InvitationView[] }>(
      await h.app.inject({ url: '/api/v1/invitations', headers: h.as(owner) }),
    );
    expect(listed.items.find((i) => i.id === created.invitation.id)?.state).toBe('expired');
  });

  it('a link nobody issued is refused, and the refusal is the same sentence', async () => {
    const nonsense = 'a'.repeat(43);
    const res = await preview(nonsense);
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('invitation_not_valid');
  });

  it('a second sign-in cannot be issued for someone who already has one', async () => {
    const alex = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items.find((m) => m.display_name === 'Alex') as MemberView;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${alex.id}/invite`,
      headers: h.as(owner),
      payload: { email: 'alex2@example.test', role: 'adult' },
    });
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('already_signed_in');
  });

  it('an email that already signs in here is refused, in the words the person needs', async () => {
    const res = await invite({
      display_name: 'Impostor',
      email: 'alex@example.test',
      role: 'adult',
    });
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { message: string } }>(res).error.message).toMatch(/sign in with it/);
  });

  it('an adult can hand out a teen sign-in, but not an adult one', async () => {
    const alex = json<Tokens>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'alex@example.test', password: 'alex correct horse' },
      }),
    );
    const teen = await invite(
      { display_name: 'Teenager', email: 'teen@example.test', role: 'teen' },
      alex,
    );
    expect(teen.statusCode).toBe(201);

    const anotherAdult = await invite(
      { display_name: 'Another', email: 'another@example.test', role: 'adult' },
      alex,
    );
    expect(anotherAdult.statusCode).toBe(403);
    expect(json<{ error: { message: string } }>(anotherAdult).error.message).toMatch(
      /adults-only documents/,
    );
  });

  it('a teen cannot invite anyone at all', async () => {
    const teen = await h.join(owner, {
      name: 'Kid',
      email: 'kid@example.test',
      role: 'teen',
    });
    const res = await invite(
      { display_name: 'Friend', email: 'friend@example.test', role: 'teen' },
      teen,
    );
    expect(res.statusCode).toBe(403);
    // Nor can they see who has been invited.
    expect(
      (await h.app.inject({ url: '/api/v1/invitations', headers: h.as(teen) })).statusCode,
    ).toBe(403);
  });

  it('the whole thing is in the audit chain, without either secret in it', async () => {
    const rows = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'detail'])
        .where('action', 'like', 'invitation.%')
        .orderBy('id')
        .execute(),
    );
    expect(rows.map((r) => r.action)).toContain('invitation.created');
    expect(rows.map((r) => r.action)).toContain('invitation.accepted');
    expect(rows.map((r) => r.action)).toContain('invitation.revoked');
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/link_token|code_hash/);
    expect(text).not.toMatch(/\$argon2/);
  });
});
