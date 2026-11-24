import { appendAudit, createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { randomUUID } from 'node:crypto';
import {
  HEALTH_EVENTS,
  securityHealthLines,
  type SecurityHealthView,
  type Tokens,
} from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import { SecurityHealthService } from './health.js';

/**
 * Settings → System health (0.9.0-dev.78): an owner's card, read from
 * the activity log and the off-site copy's setting. Each line fine, late,
 * failed or due as the vault's own lines say; the day's failed sign-ins and
 * sign-ins used from two places counted from what dev.75 already writes.
 */
describe.skipIf(!testAdminUrl())('security and health (0.9.0-dev.78)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let adult: Tokens;
  let viewer: Tokens;
  /** The card's clock, moved by a test. */
  let offset = 0;
  const DAY = 24 * 3600_000;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.78.${Math.floor(++nth / 200)}.${nth % 200}` });

  const health = (who: Tokens) =>
    h.app.inject({ url: '/api/v1/household/health', headers: h.as(who), ...peer() });
  const view = async () => {
    const res = await health(owner);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SecurityHealthView>();
  };
  /**
   * A line of the vault's own, as the worker writes it. The log is
   * append-only, even to the owning role, its time set as it is written:
   * "days later" is the card's clock moved instead. A moment apart, so two
   * lines never share a millisecond.
   */
  const note = async (action: string, detail: Record<string, unknown> = {}) => {
    await new Promise((r) => setTimeout(r, 5));
    await withSystem(h.db, owner.household_id, (trx) =>
      appendAudit(trx, {
        householdId: owner.household_id,
        action,
        objectType: 'household',
        objectId: owner.household_id,
        detail,
      }),
    );
  };

  beforeAll(async () => {
    h = await createHarness({
      healthNow: () => new Date(Date.now() + offset),
      signInGuard: true,
      rateLimitPerMinute: 10_000,
    });
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
    viewer = await h.join(owner, { name: 'Vee', email: 'vee@example.test', role: 'viewer' });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });
  beforeEach(() => {
    offset = 0;
  });

  it('is the owners’ alone: an adult and a viewer are refused, and told nothing', async () => {
    for (const who of [adult, viewer]) {
      const res = await health(who);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('backup');
    }
    expect((await h.app.inject({ url: '/api/v1/household/health', ...peer() })).statusCode).toBe(
      401,
    );
  });

  it('a new vault waits calmly: no backup or check due yet, a drill only a note, nothing off-site', async () => {
    const v = await view();
    expect(v).toEqual({
      hosted: false,
      backup: { state: 'not_yet', last_at: null },
      offsite: null,
      restore_drill: { state: 'never', last_at: null },
      audit_chain: { state: 'not_yet', last_at: null },
      failed_sign_ins: { state: 'fine', count: 0 },
      token_reuse: { state: 'fine', count: 0 },
    });
    // Nothing on the card is a problem: the drill not yet run is a note.
    const tones = securityHealthLines(v, (iso) => iso).map((l) => [l.key, l.tone]);
    expect(tones.filter(([, t]) => t === 'problem')).toEqual([]);
    expect(tones).toContainEqual(['restore_drill', 'note']);
    // Three days on, with none made: the backup is late. A log never
    // checked says nothing wrong: it is checked each night.
    offset = 3 * DAY;
    const later = await view();
    expect(later.backup).toEqual({ state: 'late', last_at: null });
    expect(later.audit_chain).toEqual({ state: 'not_yet', last_at: null });
  });

  it('the worker’s lines make each fine; days later, late or due', async () => {
    await note(HEALTH_EVENTS.backupMade, { bytes: 1234 });
    await note(HEALTH_EVENTS.auditChecked, { ok: true });
    await note(HEALTH_EVENTS.restoreDrilled, { ok: true });
    const v = await view();
    expect(v.backup?.state).toBe('fine');
    expect(v.audit_chain.state).toBe('fine');
    expect(v.restore_drill?.state).toBe('fine');
    expect(v.backup?.last_at).not.toBeNull();
    offset = 3 * DAY;
    const later = await view();
    expect(later.backup?.state).toBe('late');
    expect(later.audit_chain.state).toBe('late');
    expect(later.restore_drill?.state).toBe('fine');
    offset = 32 * DAY;
    expect((await view()).restore_drill?.state).toBe('due');
  });

  it('a backup that failed after the last one made, a check that failed, a drill that failed', async () => {
    await note(HEALTH_EVENTS.backupMade, { bytes: 1 });
    await note(HEALTH_EVENTS.backupFailed);
    await note(HEALTH_EVENTS.auditChecked, { ok: false, broken_at: 3 });
    await note(HEALTH_EVENTS.restoreDrilled, { ok: false });
    const v = await view();
    expect(v.backup?.state).toBe('failed');
    expect(v.audit_chain.state).toBe('broken');
    expect(v.restore_drill?.state).toBe('failed');
    // Cleared by the next one that goes.
    await note(HEALTH_EVENTS.backupMade, { bytes: 2 });
    await note(HEALTH_EVENTS.auditChecked, { ok: true });
    await note(HEALTH_EVENTS.restoreDrilled, { ok: true });
    const fixed = await view();
    expect(fixed.backup?.state).toBe('fine');
    expect(fixed.audit_chain.state).toBe('fine');
    expect(fixed.restore_drill?.state).toBe('fine');
  });

  it('counts the day’s failed sign-ins, as the sign-in guard writes them', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'sam@example.test', password: `wrong ${i}` },
        ...peer(),
      });
      expect(res.statusCode).toBe(401);
    }
    await h.guard.settled();
    expect((await view()).failed_sign_ins).toEqual({ state: 'many', count: 5 });
  });

  it('counts a sign-in used from two places, which the vault signed out', async () => {
    const signIn = async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'owner@example.test', password: 'correct horse battery' },
        ...peer(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Tokens>();
    };
    const refresh = (token: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: token },
        ...peer(),
      });
    const t0 = await signIn();
    expect((await refresh(t0.refresh_token)).statusCode).toBe(200);
    // The spent token again, from elsewhere: the session ends.
    const replay = await refresh(t0.refresh_token);
    expect(replay.statusCode).toBe(401);
    expect((await view()).token_reuse).toEqual({ state: 'seen', count: 1 });
  });

  it('the off-site copy, once set up, as Settings → Backups says it', async () => {
    await withSystem(h.db, owner.household_id, async (trx) => {
      await trx
        .insertInto('backup_offsite')
        .values({
          household_id: owner.household_id,
          endpoint: 'https://s3.example.test',
          region: 'us-east-1',
          bucket: 'family',
          access_key_id: 'AKID',
          secret_encrypted: Buffer.alloc(40),
          enabled: true,
          enabled_at: new Date(),
          status: 'ok',
          last_tested_at: new Date(),
        })
        .execute();
    });
    expect((await view()).offsite).toEqual({ state: 'fine', last_at: null, problem: null });
    offset = 3 * DAY;
    expect((await view()).offsite?.state).toBe('late');
    offset = 0;
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('backup_offsite')
        .set({
          last_attempt_at: new Date(),
          last_result: 'failed',
          last_problem: 'credentials_rejected',
        })
        .execute(),
    );
    expect((await view()).offsite).toEqual({
      state: 'failed',
      last_at: null,
      problem: 'credentials_rejected',
    });
    await withSystem(h.db, owner.household_id, (trx) =>
      trx.updateTable('backup_offsite').set({ enabled: false }).execute(),
    );
    expect((await view()).offsite?.state).toBe('off');
  });

  it('another household on the same server sees no line of the server’s; its own log check is its own', async () => {
    // The Khans' are the installation's: they set it up first.
    await note(HEALTH_EVENTS.backupMade, { bytes: 9 });
    const other = randomUUID();
    await admin.query(`insert into household (id, name) values ($1, 'The neighbours')`, [other]);
    const m = (
      await admin.query<{ id: string }>(
        `insert into member (household_id, display_name) values ($1, 'Nadia') returning id`,
        [other],
      )
    ).rows[0]?.id as string;
    const a = (
      await admin.query<{ id: string }>(
        `insert into account (email) values ('nadia-health@example.test') returning id`,
      )
    ).rows[0]?.id as string;
    await admin.query(
      `insert into account_household (account_id, household_id, member_id, role)
       values ($1, $2, $3, 'owner')`,
      [a, other, m],
    );
    // Her own card, as the service answers her (signed in, an owner).
    const health = new SecurityHealthService(h.db, { edition: 'self_hosted' });
    const theirs = await health.get({
      accountId: a,
      sessionId: randomUUID(),
      householdId: other,
      memberId: m,
      role: 'owner',
      seesAdults: true,
    });
    expect([theirs.backup, theirs.offsite, theirs.restore_drill]).toEqual([null, null, null]);
    expect(theirs.audit_chain.state).toBe('not_yet');
    // And the Khans' card still has them.
    const ours = await view();
    expect(ours.backup?.state).toBe('fine');
    expect(ours.restore_drill).not.toBeNull();
  });

  it('the day’s counts and the newest lines are found by the log’s index (0125)', async () => {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query('set local enable_seqscan = off');
      for (const q of [
        `select count(*) from audit_event where household_id = $1 and action = 'auth.sign_in_failed'
           and id > 0 and at > now() - interval '24 hours'`,
        `select at from audit_event where household_id = $1 and action = 'vault.backup_made'
          order by id desc limit 1`,
      ]) {
        const plan = (
          await c.query<{ 'QUERY PLAN': string }>(`explain ${q}`, [owner.household_id])
        ).rows
          .map((r) => r['QUERY PLAN'])
          .join('\n');
        expect(plan).toContain('audit_event_action_idx');
      }
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('on the hosted edition, the backups are its operator’s: no backup, copy or drill line', async () => {
    const hosted = await createHarness({ edition: 'hosted' });
    try {
      const o = await hosted.setup();
      const res = await hosted.app.inject({
        url: '/api/v1/household/health',
        headers: hosted.as(o),
      });
      expect(res.statusCode).toBe(200);
      const v = res.json<SecurityHealthView>();
      expect(v.hosted).toBe(true);
      expect([v.backup, v.offsite, v.restore_drill]).toEqual([null, null, null]);
      expect(v.audit_chain.state).toBe('not_yet');
      // A failed check says to contact whoever runs it: never a backup or a command.
      for (const state of ['broken', 'late'] as const) {
        const words = securityHealthLines(
          { ...v, audit_chain: { state, last_at: new Date().toISOString() } },
          (iso) => iso,
        )
          .map((l) => `${l.words} ${l.fix ?? ''}`)
          .join(' ');
        expect(words).toContain('Contact whoever runs your vault.');
        expect(words).not.toMatch(/docker|restore a backup/i);
      }
    } finally {
      await hosted.close();
    }
  });
});
