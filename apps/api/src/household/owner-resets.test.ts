import { randomUUID } from 'node:crypto';
import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  refusalFor,
  type ActivityLine,
  type CreatedUploadRequest,
  type DocumentView,
  type Me,
  type MemberAccount,
  type OwnerResetResult,
} from '@fdv/shared';
import FormData from 'form-data';
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SoftwareAuthenticator } from '../auth/passkey-test-authenticator.js';
import type { AlertRequest } from '../alert-job.js';
import { PasswordService } from '../auth/passwords.js';
import { OwnerResetService } from './owner-resets.js';
import type { Tokens } from '../auth/service.js';
import { codeFor } from '../auth/totp.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * A password reset an owner starts (5.29, D5, A48–A50, A54).
 *
 * With no mail server of the operator's, an owner is handed a one-time link
 * only for somebody who keeps nothing private — asked as it is made and
 * again as it is spent — and anybody else is left to whoever runs the
 * server. With one, the link goes to the person's own address by that
 * server alone. No owner ever holds a working credential for somebody who
 * keeps anything private.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = LightMyRequestResponse;
const error = (r: Res) =>
  json<{ error: { code: string; message: string; action?: string; reason?: string } }>(r).error;

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PASSWORD = 'another correct horse';
const NEW_PASSWORD = 'a password the owner chose';

type Person = Tokens & { email: string; name: string };

/** What every file below needs: a harness, its owner with two-step sign-in, and people. */
function family(operatorMail: boolean) {
  const t = {
    h: undefined as unknown as Harness,
    owner: undefined as unknown as Tokens,
    nth: 0,
  };
  const peer = () => ({ remoteAddress: `10.29.${Math.floor(++t.nth / 200)}.${t.nth % 200}` });
  const accountOf = async (who: Tokens) =>
    (
      await withSystem(t.h.db, who.household_id, (trx) =>
        trx
          .selectFrom('account_household')
          .select('account_id')
          .where('member_id', '=', who.member_id)
          .executeTakeFirstOrThrow(),
      )
    ).account_id;
  /** Their sessions just saw a passkey or a code: the owner powers ask no more for five minutes. */
  const fresh = async (who: Tokens) => {
    const account = await accountOf(who);
    await withSystem(t.h.db, who.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(), factor_verified_at: new Date() })
        .where('account_id', '=', account)
        .execute(),
    );
  };
  const stale = async (who: Tokens) => {
    const account = await accountOf(who);
    const then = new Date(Date.now() - 10 * 60 * 1000);
    await withSystem(t.h.db, who.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: then, factor_verified_at: then })
        .where('account_id', '=', account)
        .execute(),
    );
  };
  const person = async (role: 'adult' | 'teen' | 'viewer', name = `P${++t.nth}`) => {
    await fresh(t.owner);
    const email = `${name.toLowerCase().replace(/\W/g, '')}-${randomUUID().slice(0, 8)}@example.test`;
    const who = await t.h.join(t.owner, { name, email, role });
    return { ...who, email, name } as Person;
  };
  const enrolTotp = async (who: Tokens) => {
    await fresh(who);
    const enrol = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: t.h.as(who),
    });
    const s = json<{ secret: string }>(enrol).secret;
    const confirm = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: t.h.as(who),
      payload: { code: codeFor(s) },
    });
    expect(confirm.statusCode, confirm.body).toBe(204);
    return s;
  };
  const reset = async (who: Tokens, target: { member_id: string }, body = {}) => {
    return t.h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${target.member_id}/password-reset`,
      headers: t.h.as(who),
      payload: body,
    });
  };
  /** As an owner just asked with a code: the reset's answer, which must be a 200. */
  const started = async (target: { member_id: string }, body = {}) => {
    await fresh(t.owner);
    const r = await reset(t.owner, target, body);
    expect(r.statusCode, r.body).toBe(200);
    return json<OwnerResetResult>(r);
  };
  const card = async (target: { member_id: string }) => {
    await fresh(t.owner);
    const r = await t.h.app.inject({
      url: `/api/v1/members/${target.member_id}/account`,
      headers: t.h.as(t.owner),
    });
    expect(r.statusCode, r.body).toBe(200);
    return json<MemberAccount>(r);
  };
  const signIn = (email: string, password = PASSWORD) =>
    t.h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email, password },
      ...peer(),
    });
  const tokenOf = (link: string) => link.slice(link.lastIndexOf('#') + 1);
  const spend = (link: string, password = NEW_PASSWORD) =>
    t.h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/complete',
      payload: { token: tokenOf(link), password },
      ...peer(),
    });
  const lookup = (link: string) =>
    t.h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/lookup',
      payload: { token: tokenOf(link) },
      ...peer(),
    });
  const me = async (who: Tokens) =>
    json<Me>(await t.h.app.inject({ url: '/api/v1/me', headers: t.h.as(who) }));
  const activity = async (who: Tokens) =>
    json<{ items: ActivityLine[] }>(
      await t.h.app.inject({ url: '/api/v1/audit?limit=100', headers: t.h.as(who) }),
    ).items;
  const admin = async <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => {
    const pool = createPool(t.h.adminUrl, 1);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  };
  const jobsNamed = (name: string) => t.h.jobs.filter((j) => j.name === name).map((j) => j.data);
  const inAWeek = () => new Date(Date.now() + 7 * 864e5).toISOString();

  /** A document of theirs, made as they would make it. */
  const document = async (who: Tokens, body: Record<string, unknown>) => {
    const r = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: t.h.as(who),
      payload: { type_key: 'utility_bill', owner_member_id: who.member_id, ...body },
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r).id;
  };
  const askFor = async (who: Tokens, more: Record<string, unknown> = {}) => {
    const r = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: t.h.as(who),
      payload: { title: 'Your payslips', expires_at: inAWeek(), review_by: 'me', ...more },
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedUploadRequest>(r);
  };
  /** A file sent in through their request, as its sender sends it: the sender's cookie and the file. */
  const sendFile = async (made: CreatedUploadRequest) => {
    const open = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/unlock',
      payload: { token: made.link_token },
      ...peer(),
    });
    expect(open.statusCode, open.body).toBe(200);
    const set = open.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
    const form = new FormData();
    form.append('file', PDF, { filename: 'payslip.pdf', contentType: 'application/pdf' });
    const cookies = { [set?.name as string]: set?.value as string };
    const sent = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/files',
      headers: form.getHeaders(),
      cookies,
      payload: form.getBuffer(),
      ...peer(),
    });
    expect(sent.statusCode, sent.body).toBe(201);
    return { cookies, file: json<{ id: string }>(sent).id };
  };
  /** A passkey of their own, added from their session (a code or the password just given). */
  const addPasskey = async (who: Tokens, label: string) => {
    await fresh(who);
    const device = new SoftwareAuthenticator();
    const options = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: t.h.as(who),
    });
    expect(options.statusCode, options.body).toBe(200);
    const made = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys',
      headers: t.h.as(who),
      payload: { response: device.register(options.json()), label },
    });
    expect(made.statusCode, made.body).toBe(201);
    return device;
  };
  /** Signing in with a passkey, as a browser does: a challenge for the address, then the answer. */
  const passkeySignIn = async (device: SoftwareAuthenticator, email: string) => {
    const challenge = await t.h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/challenge',
      payload: { email },
      ...peer(),
    });
    return t.h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/verify',
      payload: { response: device.authenticate(challenge.json()) },
      ...peer(),
    });
  };

  /**
   * Each thing that is somebody's alone (D5), made as they make it. A file
   * waiting is one sent through a request they then took back: the request
   * still open is a case of its own.
   */
  const gains: Array<[string, (who: Person) => Promise<void>]> = [
    [
      'an Only me document',
      async (who) => {
        await document(who, { title: 'Counselling notes', visibility: 'private' });
      },
    ],
    [
      'an Only me note',
      async (who) => {
        await document(who, {
          title: 'Bank letter',
          visibility: 'private',
          notes: 'The PIN is in the blue book',
        });
      },
    ],
    [
      'an Only me detail',
      async (who) => {
        await document(who, {
          title: 'My car',
          type_key: 'vehicle_registration',
          visibility: 'private',
          extra: { plate: 'AB12 CDE' },
        });
      },
    ],
    [
      'an Only me identity field',
      async (who) => {
        const r = await t.h.app.inject({
          method: 'PUT',
          url: `/api/v1/members/${who.member_id}/identity`,
          headers: t.h.as(who),
          payload: { part: 'only_me', version: 0, fields: { notes: 'mine alone' } },
        });
        expect(r.statusCode, r.body).toBe(200);
      },
    ],
    [
      'a file waiting in a request they alone review',
      async (who) => {
        const made = await askFor(who);
        await sendFile(made);
        const taken = await t.h.app.inject({
          method: 'DELETE',
          url: `/api/v1/upload-requests/${made.request.id}`,
          headers: t.h.as(who),
        });
        expect(taken.statusCode, taken.body).toBe(204);
      },
    ],
    [
      'a request they alone review, still open',
      async (who) => {
        await askFor(who);
      },
    ],
    [
      'an export that has not run out',
      async (who) => {
        await fresh(who);
        const r = await t.h.app.inject({
          method: 'POST',
          url: '/api/v1/exports',
          headers: t.h.as(who),
        });
        expect(r.statusCode, r.body).toBe(202);
      },
    ],
    [
      'an Only me collection',
      async (who) => {
        const r = await t.h.app.inject({
          method: 'POST',
          url: '/api/v1/collections',
          headers: t.h.as(who),
          payload: { name: 'Divorce', audience: 'only_me' },
        });
        expect(r.statusCode, r.body).toBe(201);
      },
    ],
  ];

  beforeAll(async () => {
    t.h = await createHarness({ operatorMail, rateLimitPerMinute: 100_000 });
    t.owner = await t.h.setup();
    await enrolTotp(t.owner);
  }, 120_000);
  afterAll(() => t.h.close());

  return {
    t,
    peer,
    addPasskey,
    passkeySignIn,
    sendFile,
    accountOf,
    fresh,
    stale,
    person,
    enrolTotp,
    reset,
    started,
    card,
    signIn,
    spend,
    lookup,
    me,
    activity,
    admin,
    jobsNamed,
    document,
    askFor,
    gains,
  };
}

describe.skipIf(!testAdminUrl())(
  'a password reset an owner starts, with no mail server of the operator’s (5.29)',
  () => {
    const f = family(false);
    const { t, accountOf, fresh, stale, person, enrolTotp, reset, started, card } = f;
    const { signIn, spend, lookup, me, activity, admin, jobsNamed, document, gains } = f;
    const { askFor, sendFile, addPasskey, passkeySignIn } = f;
    let coOwner: Person;
    let coOwnerAccount = '';
    let teen: Person;
    let viewer: Person;

    beforeAll(async () => {
      teen = await person('teen', 'Tariq');
      viewer = await person('viewer', 'Accountant');
      // A second owner, with only a password.
      coOwner = await person('adult', 'Zainab');
      await fresh(t.owner);
      const promoted = await t.h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${coOwner.member_id}/role`,
        headers: t.h.as(t.owner),
        payload: { role: 'owner' },
      });
      expect(promoted.statusCode, promoted.body).toBe(200);
      coOwnerAccount = await accountOf(coOwner);
    }, 120_000);

    it('somebody with nothing private: a one-time link, shown once, for an hour — and the reset as ever when it is spent', async () => {
      const sara = await person('adult', 'Sara');
      const saraAccount = await accountOf(sara);
      // Two-step sign-in on, a passkey, a session: all as a reset finds them.
      await enrolTotp(sara);
      await admin(
        `insert into credential (account_id, kind, label) values ($1, 'passkey', 'Old')`,
        [saraAccount],
      );
      expect((await card(sara)).reset_path).toBe('handover');

      const before = Date.now();
      const made = await started(sara);
      expect(made).toEqual({
        member_id: sara.member_id,
        path: 'handover',
        stop_now: false,
        link: expect.stringMatching(
          /^http:\/\/localhost:8080\/reset#[A-Za-z0-9_-]{43}$/,
        ) as unknown,
        expires_at: expect.any(String) as unknown,
      });
      const hour = new Date(made.expires_at as string).getTime() - before;
      expect(hour).toBeGreaterThan(59 * 60_000);
      expect(hour).toBeLessThanOrEqual(60 * 60_000 + 5_000);
      // Shown once: nothing else holds it — no job, no line, no other answer.
      const secret = (made.link as string).split('#')[1] as string;
      expect(JSON.stringify(t.h.jobs)).not.toContain(secret);
      const lines = await admin<{ detail: unknown }>(
        `select detail from audit_event where household_id = $1`,
        [t.owner.household_id],
      );
      expect(JSON.stringify(lines)).not.toContain(secret);
      expect(JSON.stringify(await card(sara))).not.toContain(secret);
      // The page shows whose it is, and that an owner made it.
      const preview = await lookup(made.link as string);
      expect(preview.statusCode).toBe(200);
      expect(json<Record<string, unknown>>(preview)).toMatchObject({
        email: sara.email,
        issued_by_operator: true,
        issued_by: 'owner',
      });
      // Until it is spent, her password works.
      expect((await signIn(sara.email)).statusCode).toBe(200);

      const spent = await spend(made.link as string);
      expect(spent.statusCode, spent.body).toBe(200);
      expect(json<Record<string, unknown>>(spent)).toEqual({ email: sara.email });
      // Every session ended; her passkey gone; the old password refused.
      const after = await t.h.app.inject({ url: '/api/v1/me', headers: t.h.as(sara) });
      expect(after.statusCode).toBe(401);
      expect(
        await admin(`select id from credential where account_id = $1 and kind = 'passkey'`, [
          saraAccount,
        ]),
      ).toEqual([]);
      expect((await signIn(sara.email)).statusCode).toBe(401);
      // Two-step sign-in is still asked: the new password alone opens nothing.
      const next = await signIn(sara.email, NEW_PASSWORD);
      expect(next.statusCode).toBe(200);
      expect(json<Record<string, unknown>>(next)).toMatchObject({ mfa_required: true });
      // Her key is wrapped by the password just chosen.
      const key = await withSystem(t.h.db, sara.household_id, (trx) =>
        new ScopeKeys(new EnvKeyProvider(TEST_MASTER)).unwrapWithCredential(
          trx,
          { householdId: sara.household_id, kind: 'member', memberId: sara.member_id },
          NEW_PASSWORD,
        ),
      );
      expect(key).toBeInstanceOf(Buffer);
      // Once.
      expect((await spend(made.link as string, 'and once more again')).statusCode).toBe(404);
    });

    it('the person is told at their next sign-in, until they say they saw it', async () => {
      const omar = await person('adult', 'Omar');
      expect((await me(omar)).reset_notice).toBeNull();
      const made = await started(omar);
      expect((await spend(made.link as string)).statusCode).toBe(200);
      const back = json<Tokens>(await signIn(omar.email, NEW_PASSWORD));
      const told = (await me(back)).reset_notice;
      expect(told).toEqual({
        by: 'Owner',
        at: expect.any(String) as unknown,
        // Spent, with nothing added to the sign-in since.
        spent_at: expect.any(String) as unknown,
        passkeys_since: [],
        two_step_since: null,
        links_since: [],
      });
      // And again, until they say so.
      const again = json<Tokens>(await signIn(omar.email, NEW_PASSWORD));
      expect((await me(again)).reset_notice).toEqual(told);
      const seen = await t.h.app.inject({
        method: 'DELETE',
        url: '/api/v1/me/reset-notice',
        headers: t.h.as(again),
      });
      expect(seen.statusCode).toBe(204);
      expect((await me(again)).reset_notice).toBeNull();
      expect((await me(back)).reset_notice).toBeNull();
      // Nobody else is told of it, nor can say it was seen for them.
      expect((await me(t.owner)).reset_notice).toBeNull();
    });

    describe('path 2 is refused once the person has any one of', () => {
      for (const [what, gain] of [
        ...gains,
        [
          'an Only me document in the Trash',
          async (who: Person) => {
            const id = await document(who, { title: 'Old diary', visibility: 'private' });
            const trashed = await t.h.app.inject({
              method: 'DELETE',
              url: `/api/v1/documents/${id}`,
              headers: t.h.as(who),
            });
            expect(trashed.statusCode).toBe(204);
          },
        ],
        [
          'an Only me document removed for good, which their activity log still names',
          async (who: Person) => {
            await admin(
              `insert into document_tombstone (id, household_id, visibility, owner_member_id)
               values (gen_random_uuid(), $1, 'private', $2)`,
              [who.household_id, who.member_id],
            );
          },
        ],
        // The 5.29 review (R529-01): a request they alone review stays theirs
        // alone whatever became of it — its title, its message, who it went to.
        [
          'a request they alone review, taken back',
          async (who: Person) => {
            const made = await askFor(who);
            const taken = await t.h.app.inject({
              method: 'DELETE',
              url: `/api/v1/upload-requests/${made.request.id}`,
              headers: t.h.as(who),
            });
            expect(taken.statusCode, taken.body).toBe(204);
          },
        ],
        [
          'a request they alone review, closed once a file came, the file filed',
          async (who: Person) => {
            const made = await askFor(who, { close_after_submit: true });
            const { cookies, file } = await sendFile(made);
            const finished = await t.h.app.inject({
              method: 'POST',
              url: '/api/v1/drop/finish',
              cookies,
              payload: {},
              ...f.peer(),
            });
            expect(finished.statusCode, finished.body).toBe(200);
            // What the worker does once Finish is pressed: no scan (A42).
            await admin(`update incoming_file set scan_state = 'unscanned' where id = $1`, [file]);
            const filed = await t.h.app.inject({
              method: 'POST',
              url: `/api/v1/incoming/${file}/accept`,
              headers: t.h.as(who),
              payload: { title: 'Payslip', visibility: 'household' },
            });
            expect(filed.statusCode, filed.body).toBeLessThan(300);
            const closed = await admin<{ closed: boolean; state: string }>(
              `select r.closed_at is not null as closed, f.state from upload_request r
                 join incoming_file f on f.request_id = r.id where f.id = $1`,
              [file],
            );
            expect(closed).toEqual([{ closed: true, state: 'accepted' }]);
          },
        ],
        [
          'a request they alone review, run out but not yet removed',
          async (who: Person) => {
            const made = await askFor(who);
            await admin(
              `update upload_request set created_at = now() - interval '40 days',
                      expires_at = now() - interval '1 day' where id = $1`,
              [made.request.id],
            );
          },
        ],
        // (R529-02) an Only me identity part holding a label alone.
        [
          'an Only me identity entry with a label and nothing else',
          async (who: Person) => {
            const r = await t.h.app.inject({
              method: 'PUT',
              url: `/api/v1/members/${who.member_id}/identity`,
              headers: t.h.as(who),
              payload: {
                part: 'only_me',
                version: 0,
                fields: { custom: [{ id: 'c1', label: 'Asylum case: ref pending' }] },
              },
            });
            expect(r.statusCode, r.body).toBe(200);
            const row = await admin<{ filled: string[] }>(
              `select filled from member_identity where member_id = $1 and part = 'only_me'`,
              [who.member_id],
            );
            expect(row).toEqual([{ filled: [] }]);
          },
        ],
        // (R529-03) a deleted Only me collection: its name stays in their log alone.
        [
          'an Only me collection, deleted',
          async (who: Person) => {
            const made = await t.h.app.inject({
              method: 'POST',
              url: '/api/v1/collections',
              headers: t.h.as(who),
              payload: { name: 'Leaving him', audience: 'only_me' },
            });
            expect(made.statusCode, made.body).toBe(201);
            const gone = await t.h.app.inject({
              method: 'DELETE',
              url: `/api/v1/collections/${json<{ id: string }>(made).id}`,
              headers: t.h.as(who),
            });
            expect(gone.statusCode, gone.body).toBeLessThan(300);
          },
        ],
      ] as Array<[string, (who: Person) => Promise<void>]>) {
        it(what, async () => {
          const p = await person('adult');
          // Nothing yet: the card says a link could be handed over.
          expect((await card(p)).reset_path).toBe('handover');
          await gain(p);
          expect((await card(p)).reset_path).toBe('operator');
          const before = await admin(`select id from password_reset where account_id = $1`, [
            await accountOf(p),
          ]);
          const made = await started(p);
          // The answer is only the way: never what was found.
          expect(made).toEqual({
            member_id: p.member_id,
            path: 'operator',
            stop_now: false,
            command: `docker compose exec api node apps/api/dist/cli.mjs reset-password '${p.email}'`,
          });
          // No link was made, for anybody.
          expect(
            await admin(`select id from password_reset where account_id = $1`, [
              await accountOf(p),
            ]),
          ).toEqual(before);
        });
      }
    });

    it('path 2 comes back once a request she reviewed alone is moved to the owners (the second round, N529R-1)', async () => {
      const lina = await person('adult', 'Lina');
      const made = await askFor(lina, { close_after_submit: true });
      const filed = await sendFile(made);
      const waiting = await sendFile(made);
      const finished = await t.h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/finish',
        cookies: filed.cookies,
        payload: {},
        ...f.peer(),
      });
      expect(finished.statusCode, finished.body).toBe(200);
      await admin(`update incoming_file set scan_state = 'unscanned' where id = $1`, [filed.file]);
      const accepted = await t.h.app.inject({
        method: 'POST',
        url: `/api/v1/incoming/${filed.file}/accept`,
        headers: t.h.as(lina),
        payload: { title: 'Payslip', visibility: 'household' },
      });
      expect(accepted.statusCode, accepted.body).toBeLessThan(300);
      expect((await card(lina)).reset_path).toBe('operator');
      // Locked: what was sent for her alone moves to the owners — as the
      // worker's incoming.move does it (jobs/incoming.ts moveIncoming): the
      // request reviewed by the adults and the owners' alone, its files
      // following by its key, the waiting one rewrapped for the adults, the
      // filed one left as it was filed, its bytes gone.
      await fresh(t.owner);
      const locked = await t.h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${lina.member_id}/lock`,
        headers: t.h.as(t.owner),
        payload: {},
      });
      expect(locked.statusCode, locked.body).toBe(200);
      await admin(
        `update upload_request set review_by = 'adults', moved_to_owners_at = now() where id = $1`,
        [made.request.id],
      );
      await admin(
        `update incoming_file set owners_only = true,
                scope = case when state = 'accepted' then scope else 'adults' end,
                object_removed_at = case when state = 'accepted' then now() else object_removed_at end
          where request_id = $1`,
        [made.request.id],
      );
      const rows = await admin<{ id: string; scope: string; review_by: string }>(
        `select id, scope, review_by from incoming_file where request_id = $1 order by id`,
        [made.request.id],
      );
      expect(rows.find((r) => r.id === filed.file)).toMatchObject({
        scope: 'member',
        review_by: 'adults',
      });
      expect(rows.find((r) => r.id === waiting.file)).toMatchObject({ scope: 'adults' });
      await fresh(t.owner);
      const unlocked = await t.h.app.inject({
        method: 'DELETE',
        url: `/api/v1/members/${lina.member_id}/lock`,
        headers: t.h.as(t.owner),
      });
      expect(unlocked.statusCode).toBe(204);
      // Nothing of it is hers any more: a link may be handed over again.
      expect((await card(lina)).reset_path).toBe('handover');
    });

    describe('a hand-over link stops working if the person gains any of these before it is used', () => {
      for (const [what, gain] of gains) {
        it(what, async () => {
          const p = await person('adult');
          const made = await started(p);
          expect(made.path).toBe('handover');
          await gain(p);
          const spent = await spend(made.link as string);
          expect(spent.statusCode).toBe(404);
          // In the words of every dead link: nothing says why.
          expect(error(spent)).toMatchObject({
            code: 'reset_not_valid',
            message: 'That link is not valid any more. Ask for a new one from the sign-in page.',
          });
          // Used up, for good; nothing else changed: their password still works.
          expect((await lookup(made.link as string)).statusCode).toBe(404);
          expect((await signIn(p.email)).statusCode).toBe(200);
          expect((await signIn(p.email, NEW_PASSWORD)).statusCode).toBe(401);
        });
      }

      it('or becomes an owner', async () => {
        const p = await person('adult');
        const made = await started(p);
        await fresh(t.owner);
        const promoted = await t.h.app.inject({
          method: 'POST',
          url: `/api/v1/members/${p.member_id}/role`,
          headers: t.h.as(t.owner),
          payload: { role: 'owner' },
        });
        expect(promoted.statusCode, promoted.body).toBe(200);
        expect((await spend(made.link as string)).statusCode).toBe(404);
        expect((await signIn(p.email)).statusCode).toBe(200);
      });
    });

    it('a teen with an Only me document gets no hand-over link (A49); a teen with nothing private does', async () => {
      const yusuf = await person('teen', 'Yusuf');
      expect((await card(yusuf)).reset_path).toBe('handover');
      await document(yusuf, { title: 'My journal', visibility: 'private' });
      expect((await card(yusuf)).reset_path).toBe('operator');
      const refused = await started(yusuf);
      expect(refused.path).toBe('operator');
      expect(refused.link).toBeUndefined();
      // Another teen, with nothing of their own: a link, as for an adult.
      expect((await started(teen)).path).toBe('handover');
    });

    it('anybody else: the answer says to ask whoever runs the server, and no link exists anywhere', async () => {
      const lena = await person('adult', 'Lena');
      await document(lena, { title: 'Therapy', visibility: 'private' });
      const lenaAccount = await accountOf(lena);
      const since = t.h.jobs.length;
      const made = await started(lena);
      expect(made.path).toBe('operator');
      expect(made.command).toContain(`reset-password '${lena.email}'`);
      expect(made.link).toBeUndefined();
      expect(
        await admin(`select id from password_reset where account_id = $1`, [lenaAccount]),
      ).toEqual([]);
      // Nobody is sent a link; she is told, with none.
      const alerts = t.h.jobs.slice(since).filter((j) => j.name === 'alert.send');
      expect(alerts.some((a) => 'url' in a.data)).toBe(false);
      expect(
        alerts.find((a) => (a.data.account_ids as string[]).includes(lenaAccount))?.data,
      ).toMatchObject({ subject: 'Owner started a password reset for you', email_only: true });
      // And her password still works.
      expect((await signIn(lena.email)).statusCode).toBe(200);
    });

    it('stop_now: every session ends and the old password fails', async () => {
      const rami = await person('adult', 'Rami');
      // His phone: a session of its own, and its UnifiedPush address.
      const installation = randomUUID();
      const phone = json<Tokens>(
        await t.h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password',
          payload: { email: rami.email, password: PASSWORD },
          headers: { 'x-fdv-installation': installation },
          ...f.peer(),
        }),
      );
      const endpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
      const registered = await t.h.app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: { ...t.h.as(phone), 'x-fdv-installation': installation },
        payload: { kind: 'unified_push', endpoint, keys: { p256dh: 'k', auth: 'a' } },
      });
      expect(registered.statusCode, registered.body).toBe(201);
      const made = await started(rami, { stop_now: true });
      expect(made).toMatchObject({ path: 'handover', stop_now: true });
      for (const s of [rami, phone]) {
        const r = await t.h.app.inject({ url: '/api/v1/me', headers: t.h.as(s) });
        expect(r.statusCode).toBe(401);
        expect(error(r)).toMatchObject({ code: 'session_ended', reason: 'revoked' });
      }
      // His phone is told, once it committed.
      const told = jobsNamed('push.send').filter((d) =>
        (d.targets as Array<{ endpoint: string }>).some((x) => x.endpoint === endpoint),
      );
      expect(told.map((d) => d.message)).toEqual([{ v: 1, type: 'session_ended' }]);
      expect((await signIn(rami.email)).statusCode).toBe(401);
      expect((await card(rami)).devices).toEqual([]);
      // He chooses a new one through the link (A48): nobody was given one.
      expect((await spend(made.link as string)).statusCode).toBe(200);
      expect((await signIn(rami.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('stop_now is refused where no link can reach the person, and nothing changes (the 5.29 review)', async () => {
      const lena = await person('adult', 'Leila');
      await document(lena, { title: 'Private', visibility: 'private' });
      await fresh(t.owner);
      const since = t.h.jobs.length;
      const refused = await reset(t.owner, lena, { stop_now: true });
      expect(refused.statusCode).toBe(409);
      expect(error(refused)).toMatchObject({
        code: 'stop_now_unavailable',
        message:
          "Leila's password can't be stopped from here: no link to set a new one can reach them on this vault. Lock their sign-in to keep them out, and ask whoever runs the server for a reset.",
      });
      // Her password and her session as they were; nothing logged, nobody told.
      expect((await signIn(lena.email)).statusCode).toBe(200);
      expect((await t.h.app.inject({ url: '/api/v1/me', headers: t.h.as(lena) })).statusCode).toBe(
        200,
      );
      expect(t.h.jobs.slice(since).filter((j) => j.name === 'alert.send')).toEqual([]);
      expect(
        await admin(
          `select id from audit_event where action = 'member.reset_started' and object_id = $1`,
          [lena.member_id],
        ),
      ).toEqual([]);
      // Without stop_now, the operator's way is as before.
      expect((await started(lena)).path).toBe('operator');
    });

    describe('what whoever spends a hand-over link adds goes at the next change of the password (the 5.29 review, F529-01)', () => {
      const OWNERS = 'the password the owner chose';
      const THEIRS = 'a password of her very own';
      /** The owner spends the link, and signs in as the person with the password they chose. */
      const spentByOwner = async (who: Person) => {
        const made = await started(who);
        expect((await spend(made.link as string, OWNERS)).statusCode).toBe(200);
        return json<Tokens>(await signIn(who.email, OWNERS));
      };
      const change = (who: Tokens, current: string, next: string) =>
        t.h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password/change',
          headers: t.h.as(who),
          payload: { current_password: current, new_password: next },
        });

      it('the reviewer’s chain: the owner adds a passkey; the person changes the password; the passkey signs nobody in', async () => {
        const ada = await person('adult', 'Ada');
        const asAda = await spentByOwner(ada);
        const planted = await addPasskey(asAda, 'Owner’s laptop');
        // The planted passkey works, until…
        expect((await passkeySignIn(planted, ada.email)).statusCode).toBe(200);
        // …the person, handed the owner's password, changes it, as the notice says.
        const hers = json<Tokens>(await signIn(ada.email, OWNERS));
        expect((await change(hers, OWNERS, THEIRS)).statusCode).toBe(204);
        const refused = await passkeySignIn(planted, ada.email);
        expect(refused.statusCode).toBe(401);
        expect(error(refused).code).toBe('passkey_rejected');
        expect((await signIn(ada.email, OWNERS)).statusCode).toBe(401);
        // Whatever she keeps from now is hers: the owner holds no way in.
        await document(hers, { title: 'Counselling notes', visibility: 'private' });
        const line = await admin<{ detail: Record<string, unknown> }>(
          `select detail from audit_event where action = 'auth.password_changed'
            and actor_account_id = $1 order by id desc limit 1`,
          [await accountOf(ada)],
        );
        expect(line[0]?.detail).toMatchObject({ passkeys_removed: 1, two_step_removed: false });
      });

      it('the owner changing the password first gains nothing: every change takes away what was added since', async () => {
        const bea = await person('adult', 'Bea');
        const asBea = await spentByOwner(bea);
        // The owner changes it first: nothing added yet, so nothing goes.
        expect((await change(asBea, OWNERS, 'the owner changed it again')).statusCode).toBe(204);
        const planted = await addPasskey(asBea, 'Owner’s phone');
        expect((await passkeySignIn(planted, bea.email)).statusCode).toBe(200);
        // Then hands Bea that password; she changes it to her own.
        const hers = json<Tokens>(await signIn(bea.email, 'the owner changed it again'));
        expect((await change(hers, 'the owner changed it again', THEIRS)).statusCode).toBe(204);
        expect((await passkeySignIn(planted, bea.email)).statusCode).toBe(401);
        // Her own passkey, added after, goes at her next change too (the cost).
        const own = await addPasskey(hers, 'Bea’s phone');
        expect((await change(hers, THEIRS, 'and changed once more')).statusCode).toBe(204);
        expect((await passkeySignIn(own, bea.email)).statusCode).toBe(401);
        // What she was told before that change.
        expect((await me(hers)).handover_since).toEqual(expect.any(String));
      });

      it('two-step sign-in turned on since goes at a change, and at a reset with no change since', async () => {
        const cy = await person('adult', 'Cyra');
        const asCy = await spentByOwner(cy);
        await enrolTotp(asCy);
        expect(json<Record<string, unknown>>(await signIn(cy.email, OWNERS))).toMatchObject({
          mfa_required: true,
        });
        // A change of the password by whoever holds the session takes it away.
        expect((await change(asCy, OWNERS, 'changed by the owner')).statusCode).toBe(204);
        expect(
          json<Record<string, unknown>>(await signIn(cy.email, 'changed by the owner')),
        ).not.toHaveProperty('mfa_required');
        // Somebody else: two-step on since the spend, then a reset from the
        // command line, which she spends — with no change in between.
        const cal = await person('adult', 'Calla');
        const asCal = await spentByOwner(cal);
        await enrolTotp(asCal);
        const cli = new PasswordService(
          t.h.db,
          new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
          null,
          'http://localhost:8080',
        );
        const printed = await cli.issue(await accountOf(cal), 'operator');
        expect((await spend(cli.linkFor(printed.token), THEIRS)).statusCode).toBe(200);
        const back = await signIn(cal.email, THEIRS);
        expect(back.statusCode).toBe(200);
        expect(json<Record<string, unknown>>(back)).not.toHaveProperty('mfa_required');
      });

      it('two-step the person turns on after setting her own password stays at a later reset: a self link, and one an owner mails (the second round, N529C-02)', async () => {
        const di = await person('adult', 'Dita');
        const diAccount = await accountOf(di);
        await spentByOwner(di);
        const hers = json<Tokens>(await signIn(di.email, OWNERS));
        expect((await change(hers, OWNERS, THEIRS)).statusCode).toBe(204);
        await enrolTotp(hers);
        expect(json<Record<string, unknown>>(await signIn(di.email, THEIRS))).toMatchObject({
          mfa_required: true,
        });
        // Her own forgotten-password link, spent by whoever reads her mail.
        const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
        const self = new PasswordService(t.h.db, keys, null, 'http://localhost:8080');
        const own = await self.issue(diAccount, 'self');
        expect((await spend(self.linkFor(own.token), 'whoever read her mail')).statusCode).toBe(
          200,
        );
        expect(
          json<Record<string, unknown>>(await signIn(di.email, 'whoever read her mail')),
        ).toMatchObject({ mfa_required: true });
        // And a reset an owner starts once the operator has added mail: the
        // link by mail, spent by whoever reads it.
        const mailed: AlertRequest[] = [];
        const resets = new OwnerResetService(
          t.h.db,
          (token) => self.linkFor(token),
          true,
          async (a) => {
            mailed.push(a);
          },
        );
        const owner = {
          accountId: await accountOf(t.owner),
          sessionId: randomUUID(),
          householdId: t.owner.household_id,
          memberId: t.owner.member_id,
          role: 'owner' as const,
        };
        expect((await resets.start(owner, di.member_id, {}, {})).path).toBe('mail');
        const url = mailed.find((a) => typeof a.url === 'string')?.url as string;
        expect((await spend(url, 'the owner read it too')).statusCode).toBe(200);
        expect(
          json<Record<string, unknown>>(await signIn(di.email, 'the owner read it too')),
        ).toMatchObject({ mfa_required: true });
      });

      it('a share link made as the person since the spend ends at her change, and the notice lists it first (the second round, N529C-03)', async () => {
        const fay = await person('adult', 'Fay');
        const fayAccount = await accountOf(fay);
        const asFay = await spentByOwner(fay);
        // A household document of hers, with a file, shared as her.
        const id = await document(asFay, { title: 'Bank statements', visibility: 'household' });
        const form = new FormData();
        form.append('file', PDF, { filename: 'statement.pdf', contentType: 'application/pdf' });
        const v = await t.h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${id}/versions`,
          headers: { ...t.h.as(asFay), ...form.getHeaders(), 'idempotency-key': randomUUID() },
          payload: form.getBuffer(),
        });
        expect(v.statusCode, v.body).toBeLessThan(300);
        const shared = await t.h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${id}/share`,
          headers: t.h.as(asFay),
          payload: {},
        });
        expect(shared.statusCode, shared.body).toBe(201);
        const { link_token: token, share } = json<{
          link_token: string;
          share: { id: string };
        }>(shared);
        const preview = () =>
          t.h.app.inject({
            method: 'POST',
            url: '/api/v1/shared/preview',
            payload: { token },
            ...f.peer(),
          });
        expect((await preview()).statusCode).toBe(200);
        // She is told of it, beside what else was added.
        const hers = json<Tokens>(await signIn(fay.email, OWNERS));
        expect((await me(hers)).reset_notice?.links_since).toEqual([
          { title: 'Bank statements', made_at: expect.any(String) as unknown },
        ]);
        // Her change ends it, with a line, and counts it.
        expect((await change(hers, OWNERS, THEIRS)).statusCode).toBe(204);
        expect((await preview()).statusCode).toBe(404);
        const lines = await admin<{ action: string; detail: Record<string, unknown> }>(
          `select action, detail from audit_event
            where actor_account_id = $1 and action in ('share.revoked', 'auth.password_changed')
            order by id`,
          [fayAccount],
        );
        expect(lines).toEqual([
          {
            action: 'auth.password_changed',
            detail: expect.objectContaining({ links_removed: 1 }) as unknown,
          },
          { action: 'share.revoked', detail: { share_id: share.id } },
        ]);
        // Then she makes it Only me, as the probe did: the link opens nothing.
        const moved = await t.h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${id}/visibility`,
          headers: t.h.as(hers),
          payload: { visibility: 'private' },
        });
        expect(moved.statusCode, moved.body).toBeLessThan(300);
        expect((await preview()).statusCode).toBe(404);
        expect((await me(hers)).reset_notice?.links_since).toEqual([]);
      });

      it('a reset ends them too, whoever spends it (the second round, N529C-03)', async () => {
        const gus = await person('adult', 'Gus');
        const asGus = await spentByOwner(gus);
        const id = await document(asGus, { title: 'Tenancy', visibility: 'household' });
        const form = new FormData();
        form.append('file', PDF, { filename: 'tenancy.pdf', contentType: 'application/pdf' });
        const v = await t.h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${id}/versions`,
          headers: { ...t.h.as(asGus), ...form.getHeaders(), 'idempotency-key': randomUUID() },
          payload: form.getBuffer(),
        });
        expect(v.statusCode, v.body).toBeLessThan(300);
        const shared = await t.h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${id}/share`,
          headers: t.h.as(asGus),
          payload: {},
        });
        expect(shared.statusCode, shared.body).toBe(201);
        const token = json<{ link_token: string }>(shared).link_token;
        const cli = new PasswordService(
          t.h.db,
          new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
          null,
          'http://localhost:8080',
        );
        const printed = await cli.issue(await accountOf(gus), 'operator');
        expect((await spend(cli.linkFor(printed.token), THEIRS)).statusCode).toBe(200);
        const preview = await t.h.app.inject({
          method: 'POST',
          url: '/api/v1/shared/preview',
          payload: { token },
          ...f.peer(),
        });
        expect(preview.statusCode).toBe(404);
      });

      it('the notice lists the passkey and two-step sign-in added since, and says when it was spent', async () => {
        const dee = await person('adult', 'Deena');
        const asDee = await spentByOwner(dee);
        await addPasskey(asDee, 'Owner’s laptop');
        await enrolTotp(asDee);
        const notice = (await me(asDee)).reset_notice;
        expect(notice).toEqual({
          by: 'Owner',
          at: expect.any(String) as unknown,
          spent_at: expect.any(String) as unknown,
          passkeys_since: [{ label: 'Owner’s laptop', added_at: expect.any(String) as unknown }],
          two_step_since: expect.any(String) as unknown,
          links_since: [],
        });
        expect((await me(asDee)).handover_since).toBe(notice?.spent_at);
        // Nobody else's notice says anything of it.
        expect((await me(t.owner)).reset_notice).toBeNull();
      });

      it('the email after a hand-over link is spent says an owner was given it, and what to do (F529-04)', async () => {
        const eve = await person('adult', 'Evie');
        const evesAccount = await accountOf(eve);
        const made = await started(eve);
        const since = t.h.jobs.length;
        expect((await spend(made.link as string, OWNERS)).statusCode).toBe(200);
        const told = t.h.jobs
          .slice(since)
          .filter(
            (j) =>
              j.name === 'alert.send' && (j.data.account_ids as string[]).includes(evesAccount),
          )
          .map((j) => j.data);
        expect(told).toHaveLength(1);
        expect(told[0]?.subject).toBe('Your vault password was reset');
        expect(told[0]?.body).toBe(
          'Owner, an owner of your family vault, was given a one-time link for your sign-in, and it has been used to set a new password. Every device has been signed out and every passkey removed. If you did not choose that password yourself, set one of your own in Settings when you next sign in — that also removes any passkey or two-step sign-in added since — and talk to them.',
        );
        expect(told[0]?.body).not.toMatch(/read your email/);
      });
    });

    it('a password-only owner is refused a reset, and step-up by password is refused', async () => {
      const hana = await person('adult', 'Hana');
      const signedIn = json<Tokens>(await signIn(coOwner.email));
      const refused = await reset(signedIn, hana);
      expect(refused.statusCode).toBe(403);
      expect(error(refused)).toMatchObject({
        code: 'totp_required_for_owner',
        message: "Turn on two-step sign-in to manage other people's sign-ins.",
      });
      const s = await enrolTotp(signedIn);
      await stale(signedIn);
      expect(error(await reset(signedIn, hana))).toMatchObject({
        code: 'step_up_required',
        action: 'manage_sign_ins',
      });
      const byPassword = await t.h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: t.h.as(signedIn),
        payload: { password: PASSWORD },
      });
      expect(byPassword.statusCode).toBe(200);
      expect(error(await reset(signedIn, hana))).toMatchObject({
        code: 'step_up_required',
        action: 'manage_sign_ins',
      });
      const byCode = await t.h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: t.h.as(signedIn),
        payload: { code: codeFor(s) },
      });
      expect(byCode.statusCode).toBe(200);
      expect((await reset(signedIn, hana)).statusCode).toBe(200);
      // Nobody but an owner, in the matrix's words.
      const adult = await person('adult', 'Imran');
      for (const who of [adult, teen, viewer]) {
        await fresh(who);
        const r = await reset(who, hana);
        expect(r.statusCode).toBe(403);
        expect(error(r)).toMatchObject({
          code: 'forbidden',
          message: refusalFor('member.reset_password'),
        });
      }
      // What is sent is checked before who is asked to confirm.
      await stale(t.owner);
      expect((await reset(t.owner, hana, { stop_now: 'yes' })).statusCode).toBe(422);
      expect((await reset(t.owner, hana, { password: 'x' })).statusCode).toBe(422);
    });

    it('resetting another owner is refused, and oneself, and nobody', async () => {
      await fresh(t.owner);
      const r = await reset(t.owner, coOwner);
      expect(r.statusCode).toBe(409);
      expect(error(r)).toMatchObject({ code: 'owner_notice_required' });
      expect(error(r).message).toMatch(/^Zainab is an owner/);
      expect((await card(coOwner)).reset_path).toBeNull();
      const self = await reset(t.owner, t.owner);
      expect(self.statusCode).toBe(422);
      const added = await t.h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: t.h.as(t.owner),
        payload: { display_name: 'Baby Noor' },
      });
      for (const id of [json<{ id: string }>(added).id, randomUUID()]) {
        const none = await reset(t.owner, { member_id: id });
        expect(none.statusCode).toBe(404);
        expect(error(none).message).toBe('They have no sign-in to reset.');
      }
      expect(
        await admin(`select id from password_reset where account_id = $1`, [coOwnerAccount]),
      ).toEqual([]);
    });

    it('no reset while the person is locked, nor while their sign-in waits after a restore', async () => {
      const kamal = await person('adult', 'Kamal');
      await fresh(t.owner);
      const locked = await t.h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${kamal.member_id}/lock`,
        headers: t.h.as(t.owner),
        payload: {},
      });
      expect(locked.statusCode, locked.body).toBe(200);
      expect((await card(kamal)).reset_path).toBeNull();
      await fresh(t.owner);
      const r = await reset(t.owner, kamal);
      expect(r.statusCode).toBe(409);
      expect(error(r)).toMatchObject({ code: 'locked' });
      expect(error(r).message).toMatch(/is locked\. Unlock it first/);
      const nadia = await person('adult', 'Nadia');
      await admin(
        `update account_household set suspended_at = now(), suspend_reason = 'restored'
          where member_id = $1`,
        [nadia.member_id],
      );
      await fresh(t.owner);
      const paused = await reset(t.owner, nadia);
      expect(paused.statusCode).toBe(409);
      expect(error(paused).message).toMatch(/waiting after a restore/);
      for (const p of [kamal, nadia]) {
        expect(
          await admin(`select id from password_reset where account_id = $1`, [await accountOf(p)]),
        ).toEqual([]);
      }
    });

    it('the other owners are told, with no link', async () => {
      const gita = await person('adult', 'Gita');
      const since = t.h.jobs.length;
      const made = await started(gita);
      const toCoOwner = t.h.jobs
        .slice(since)
        .filter(
          (j) =>
            j.name === 'alert.send' && (j.data.account_ids as string[]).includes(coOwnerAccount),
        );
      expect(toCoOwner).toHaveLength(1);
      expect(toCoOwner[0]?.data).toMatchObject({
        subject: 'Owner started a password reset for Gita',
        push_type: 'owner_change',
      });
      expect(JSON.stringify(toCoOwner)).not.toContain((made.link as string).split('#')[1]);
      // The owner who started it is not told of their own doing.
      const ownerAccount = await accountOf(t.owner);
      expect(
        t.h.jobs
          .slice(since)
          .some((j) => (j.data.account_ids as string[] | undefined)?.includes(ownerAccount)),
      ).toBe(false);
    });

    it('a teen and a second adult see no line about an owner-started reset', async () => {
      const dina = await person('adult', 'Dalia');
      const other = await person('adult', 'Hamza');
      // A teen whose own password nobody reset: their own line they would see.
      const kid = await person('teen', 'Kiran');
      await started(dina, { stop_now: true });
      const about = (lines: ActivityLine[]) =>
        lines.filter((l) => /Dalia’s/.test(l.text)).map((l) => l.text);
      const seen = [
        'Owner made a one-time link to reset Dalia’s password, and stopped their password now',
      ];
      expect(about(await activity(t.owner))).toEqual(seen);
      expect(about(await activity(coOwner))).toEqual(seen);
      // The person, once she has a password again.
      const link = (await started(dina)).link as string;
      expect((await spend(link)).statusCode).toBe(200);
      const back = json<Tokens>(await signIn(dina.email, NEW_PASSWORD));
      expect(about(await activity(back))).toEqual([
        'Owner made a one-time link to reset Dalia’s password',
        ...seen,
      ]);
      for (const who of [other, kid]) {
        const lines = await activity(who);
        expect(about(lines)).toEqual([]);
        expect(lines.filter((l) => /reset/i.test(l.text)).map((l) => l.text)).toEqual([]);
      }
      // Never a link, in any line.
      const rows = await admin<{ detail: Record<string, unknown> }>(
        `select detail from audit_event where action = 'member.reset_started'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toMatch(/reset#|http/);
    });

    it('what 0052 defines keeps its rights and its search_path, pg_temp last', async () => {
      const defined = await withSystem(
        t.h.db,
        t.owner.household_id,
        async (trx) =>
          (
            await sql<{ name: string; definer: boolean; config: string[]; granted: boolean }>`
            select p.proname as name, p.prosecdef as definer, p.proconfig as config,
                   has_function_privilege('fdv_app', p.oid, 'execute') as granted
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('member_holds_private', 'password_reset_expire_exports',
                                 'member_private_gained', 'app_session', 'handover_links_end')
             order by 1`.execute(trx)
          ).rows,
      );
      const pinned = ['search_path=pg_catalog, public, pg_temp'];
      expect(defined).toEqual([
        { name: 'app_session', definer: false, config: pinned, granted: true },
        { name: 'handover_links_end', definer: true, config: pinned, granted: true },
        { name: 'member_holds_private', definer: true, config: pinned, granted: true },
        { name: 'member_private_gained', definer: true, config: pinned, granted: true },
        { name: 'password_reset_expire_exports', definer: true, config: pinned, granted: true },
      ]);
    });

    it('only an owner, or the reset being spent, asks what somebody keeps private; only that reset ends their exports, and only it or they the links made as them', async () => {
      const sami = await person('adult', 'Sami');
      const samiAccount = await accountOf(sami);
      const ownerAccount = await accountOf(t.owner);
      const as = async (
        actor: { kind: string; role?: string; account?: string; member?: string },
        text: string,
        args: unknown[],
      ) => {
        const pool = createPool(t.h.appUrl, 1);
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true),
                    set_config('app.role', $3, true), set_config('app.account_id', $4, true),
                    set_config('app.member_id', $5, true)`,
            [
              t.owner.household_id,
              actor.kind,
              actor.role ?? '',
              actor.account ?? '',
              actor.member ?? '',
            ],
          );
          return (await c.query(text, args)).rows[0] as Record<string, unknown>;
        } catch (err) {
          return (err as { code?: string }).code ?? 'error';
        } finally {
          await c.query('rollback').catch(() => undefined);
          c.release();
          await pool.end();
        }
      };
      const ask = 'select member_holds_private($1) as held';
      // An owner: yes or no.
      expect(
        await as(
          { kind: 'account', role: 'owner', account: ownerAccount, member: t.owner.member_id },
          ask,
          [samiAccount],
        ),
      ).toEqual({ held: false });
      // Anybody else signed in, a page for somebody else, a link: refused, never "no".
      for (const actor of [
        { kind: 'account', role: 'adult', account: samiAccount, member: sami.member_id },
        { kind: 'account', role: 'teen', account: await accountOf(teen), member: teen.member_id },
        { kind: 'anonymous', account: ownerAccount },
        { kind: 'anonymous' },
        { kind: 'link' },
        { kind: 'upload' },
        { kind: '' },
      ]) {
        expect(await as(actor, ask, [samiAccount]), JSON.stringify(actor)).toBe('42501');
      }
      // The page spending a reset of theirs may ask about them.
      expect(await as({ kind: 'anonymous', account: samiAccount }, ask, [samiAccount])).toEqual({
        held: false,
      });
      // Somebody of no household of the owner's: refused, not "no".
      expect(
        await as(
          { kind: 'account', role: 'owner', account: ownerAccount, member: t.owner.member_id },
          ask,
          [randomUUID()],
        ),
      ).toBe('42501');

      // Their exports, ended only by a reset of theirs spent in this very transaction.
      const expire = 'select password_reset_expire_exports($1) as n';
      expect(
        await as(
          { kind: 'account', role: 'owner', account: ownerAccount, member: t.owner.member_id },
          expire,
          [samiAccount],
        ),
      ).toBe('42501');
      expect(await as({ kind: 'anonymous', account: samiAccount }, expire, [samiAccount])).toBe(
        '42501',
      );
      // A reset of theirs spent before now is not this one.
      await admin(
        `insert into password_reset (account_id, token_hash, issued_by, expires_at, used_at)
         values ($1, $2, 'self', now() + interval '1 hour', now() - interval '1 minute')`,
        [samiAccount, Buffer.from(randomUUID())],
      );
      expect(await as({ kind: 'anonymous', account: samiAccount }, expire, [samiAccount])).toBe(
        '42501',
      );

      // The share links made as them since a hand-over (the second round,
      // N529C-03): ended by themselves signed in, or by a reset of theirs
      // spent in this very transaction; refused to an owner, to anybody
      // else, and to a page whose reset was spent before now.
      const end = 'select count(*)::int as n from handover_links_end($1)';
      for (const actor of [
        { kind: 'account', role: 'owner', account: ownerAccount, member: t.owner.member_id },
        { kind: 'account', role: 'teen', account: await accountOf(teen), member: teen.member_id },
        { kind: 'anonymous', account: samiAccount },
        { kind: 'anonymous', account: ownerAccount },
        { kind: 'link' },
        { kind: '' },
      ]) {
        expect(await as(actor, end, [samiAccount]), JSON.stringify(actor)).toBe('42501');
      }
      expect(
        await as(
          { kind: 'account', role: 'adult', account: samiAccount, member: sami.member_id },
          end,
          [samiAccount],
        ),
      ).toEqual({ n: 0 });
    });

    it('somebody signed in reaches their own reset links, and an owner those of their household, no other', async () => {
      const ali = await person('adult', 'Ali');
      const bea = await person('adult', 'Bea');
      const [aliAccount, beaAccount] = [await accountOf(ali), await accountOf(bea)];
      for (const a of [aliAccount, beaAccount]) {
        await admin(
          `insert into password_reset (account_id, token_hash, issued_by, expires_at)
           values ($1, $2, 'self', now() + interval '1 hour')`,
          [a, Buffer.from(randomUUID())],
        );
      }
      const seenBy = async (role: string, account: string, member: string) => {
        const pool = createPool(t.h.appUrl, 1);
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                    set_config('app.role', $2, true), set_config('app.account_id', $3, true),
                    set_config('app.member_id', $4, true)`,
            [t.owner.household_id, role, account, member],
          );
          const read = await c.query<{ account_id: string }>(
            `select account_id from password_reset where account_id = any($1::uuid[])`,
            [[aliAccount, beaAccount]],
          );
          const used = await c.query(
            `update password_reset set used_at = now() where account_id = $1 and used_at is null`,
            [beaAccount],
          );
          return { read: read.rows.map((r) => r.account_id).sort(), used: used.rowCount };
        } finally {
          await c.query('rollback').catch(() => undefined);
          c.release();
          await pool.end();
        }
      };
      expect(await seenBy('adult', aliAccount, ali.member_id)).toEqual({
        read: [aliAccount],
        used: 0,
      });
      expect(await seenBy('owner', await accountOf(t.owner), t.owner.member_id)).toEqual({
        read: [aliAccount, beaAccount].sort(),
        used: 1,
      });
    });

    it('a hand-over link waiting is used up by a lock', async () => {
      const una = await person('adult', 'Una');
      const made = await started(una);
      await fresh(t.owner);
      const locked = await t.h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${una.member_id}/lock`,
        headers: t.h.as(t.owner),
        payload: {},
      });
      expect(locked.statusCode).toBe(200);
      expect((await spend(made.link as string)).statusCode).toBe(404);
      expect(jobsNamed('alert.send').length).toBeGreaterThan(0);
    });

    describe('at the same moment as', () => {
      const deadlocks = async (pool: ReturnType<typeof createPool>) =>
        (
          await pool.query<{ n: number }>(
            'select deadlocks::int as n from pg_stat_database where datname = $1',
            [new URL(t.h.adminUrl).pathname.slice(1)],
          )
        ).rows[0]?.n as number;
      const waitingOn = async (pool: ReturnType<typeof createPool>, n: number) => {
        for (let i = 0; i < 200; i += 1) {
          const r = await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where datname = $1 and wait_event_type = 'Lock'`,
            [new URL(t.h.adminUrl).pathname.slice(1)],
          );
          if ((r.rows[0]?.n ?? 0) >= n) return;
          await new Promise((res) => setTimeout(res, 50));
        }
        throw new Error(`fewer than ${n} statements waiting on a lock`);
      };
      /** Runs `first`, then `second`, both queued behind the person's membership held from outside. */
      const race = async <A, B>(
        memberId: string,
        first: () => Promise<A>,
        second: () => Promise<B>,
      ) => {
        const pool = createPool(t.h.adminUrl, 3);
        const holder = await pool.connect();
        const before = await deadlocks(pool);
        try {
          await holder.query('begin');
          await holder.query(
            'select account_id from account_household where member_id = $1 for update',
            [memberId],
          );
          const a = first();
          await waitingOn(pool, 1);
          const b = second();
          await waitingOn(pool, 2);
          await holder.query('rollback');
          const both = await Promise.all([a, b]);
          await new Promise((res) => setTimeout(res, 1500));
          expect(await deadlocks(pool)).toBe(before);
          return both;
        } finally {
          await holder.query('rollback').catch(() => undefined);
          holder.release();
          await pool.end();
        }
      };
      const lock = (target: { member_id: string }) =>
        t.h.app.inject({
          method: 'POST',
          url: `/api/v1/members/${target.member_id}/lock`,
          headers: t.h.as(t.owner),
          payload: {},
        });
      const unlock = (target: { member_id: string }) =>
        t.h.app.inject({
          method: 'DELETE',
          url: `/api/v1/members/${target.member_id}/lock`,
          headers: t.h.as(t.owner),
        });

      it('a lock: whichever comes first, the other sees it', async () => {
        const ola = await person('adult', 'Ola');
        // The lock first: the reset waits, then finds her locked.
        await fresh(t.owner);
        const [locked, refused] = await race(
          ola.member_id,
          () => lock(ola),
          () => reset(t.owner, ola),
        );
        expect(locked.statusCode, locked.body).toBe(200);
        expect(refused.statusCode).toBe(409);
        expect(error(refused).code).toBe('locked');
        await fresh(t.owner);
        expect((await unlock(ola)).statusCode).toBe(204);
        // The reset first: the lock waits, then uses its link up.
        await fresh(t.owner);
        const [made, locked2] = await race(
          ola.member_id,
          () => reset(t.owner, ola),
          () => lock(ola),
        );
        expect(made.statusCode, made.body).toBe(200);
        expect(locked2.statusCode, locked2.body).toBe(200);
        expect((await spend(json<OwnerResetResult>(made).link as string)).statusCode).toBe(404);
        await fresh(t.owner);
        expect((await unlock(ola)).statusCode).toBe(204);
      });

      it('the person gaining an Only me document: the link is spent on nobody with one', async () => {
        const make = (who: Tokens) =>
          t.h.app.inject({
            method: 'POST',
            url: '/api/v1/documents',
            headers: t.h.as(who),
            payload: {
              title: 'Made at that moment',
              type_key: 'utility_bill',
              owner_member_id: who.member_id,
              visibility: 'private',
            },
          });
        const theirs = async (p: Tokens) =>
          admin(`select id from document where owner_member_id = $1 and visibility = 'private'`, [
            p.member_id,
          ]);

        // Made first: the link, spent second, finds it — used up, and nothing more.
        const pia = await person('adult', 'Pia');
        const link = (await started(pia)).link as string;
        const [madeDoc, spent] = await race(
          pia.member_id,
          () => make(pia),
          () => spend(link),
        );
        expect(madeDoc.statusCode, madeDoc.body).toBe(201);
        expect(spent.statusCode).toBe(404);
        expect((await lookup(link)).statusCode).toBe(404);
        expect((await signIn(pia.email)).statusCode).toBe(200);
        expect(await theirs(pia)).toHaveLength(1);

        // Spent first: the document, asked for by a session the reset has
        // ended, is not made — whoever holds the new password finds nothing.
        const quinn = await person('adult', 'Quinn');
        const link2 = (await started(quinn)).link as string;
        const [spent2, madeDoc2] = await race(
          quinn.member_id,
          () => spend(link2),
          () => make(quinn),
        );
        expect(spent2.statusCode, spent2.body).toBe(200);
        expect(madeDoc2.statusCode).toBe(401);
        expect(error(madeDoc2)).toMatchObject({ code: 'session_ended' });
        expect(await theirs(quinn)).toEqual([]);
        expect((await signIn(quinn.email, NEW_PASSWORD)).statusCode).toBe(200);
      });

      it('the person writing a label-only Only me identity part: the link is spent on nobody with one (R529-02)', async () => {
        const rita = await person('adult', 'Rita');
        const link = (await started(rita)).link as string;
        const write = () =>
          t.h.app.inject({
            method: 'PUT',
            url: `/api/v1/members/${rita.member_id}/identity`,
            headers: t.h.as(rita),
            payload: {
              part: 'only_me',
              version: 0,
              fields: { custom: [{ id: 'c1', label: 'Second passport (hidden)' }] },
            },
          });
        // Written first, and waited for: the link, spent second, finds it.
        const [written, spent] = await race(rita.member_id, write, () => spend(link));
        expect(written.statusCode, written.body).toBe(200);
        expect(spent.statusCode).toBe(404);
        expect((await signIn(rita.email)).statusCode).toBe(200);
      });

      it('a sign-in proven with the old password before a reset is spent opens nothing after it (R529-04)', async () => {
        const sid = await person('adult', 'Sid');
        const link = (await started(sid)).link as string;
        const [spent, signedIn] = await race(
          sid.member_id,
          () => spend(link),
          () => signIn(sid.email),
        );
        expect(spent.statusCode, spent.body).toBe(200);
        expect(signedIn.statusCode).toBe(401);
        expect(error(signedIn).code).toBe('invalid_credentials');
        const live = await admin<{ n: number }>(
          `select count(*)::int as n from session where account_id = $1 and revoked_at is null`,
          [await accountOf(sid)],
        );
        expect(live[0]?.n).toBe(0);
      });

      it('nor one proven before their password is stopped (R529-04, A48)', async () => {
        const tia = await person('adult', 'Tia');
        await fresh(t.owner);
        const [stopped, signedIn] = await race(
          tia.member_id,
          () => reset(t.owner, tia, { stop_now: true }),
          () => signIn(tia.email),
        );
        expect(stopped.statusCode, stopped.body).toBe(200);
        expect(signedIn.statusCode).toBe(401);
      });

      it('nor a passkey proven before a reset removed it (R529-04)', async () => {
        const uma = await person('adult', 'Uma');
        const device = await addPasskey(uma, 'Uma’s phone');
        const link = (await started(uma)).link as string;
        const challenge = await t.h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/passkey/challenge',
          payload: { email: uma.email },
          ...f.peer(),
        });
        const answer = device.authenticate(challenge.json());
        const [spent, signedIn] = await race(
          uma.member_id,
          () => spend(link),
          () =>
            t.h.app.inject({
              method: 'POST',
              url: '/api/v1/auth/passkey/verify',
              payload: { response: answer },
              ...f.peer(),
            }),
        );
        expect(spent.statusCode, spent.body).toBe(200);
        expect(signedIn.statusCode).toBe(401);
        expect(error(signedIn).code).toBe('passkey_rejected');
      });

      it('a password change from a session stop_now ended while it waited is refused, and the password stays stopped (F529-03)', async () => {
        const vic = await person('adult', 'Victor');
        await fresh(t.owner);
        const [stopped, changed] = await race(
          vic.member_id,
          () => reset(t.owner, vic, { stop_now: true }),
          () =>
            t.h.app.inject({
              method: 'POST',
              url: '/api/v1/auth/password/change',
              headers: t.h.as(vic),
              payload: { current_password: PASSWORD, new_password: 'the thief’s own password' },
            }),
        );
        expect(stopped.statusCode, stopped.body).toBe(200);
        expect(changed.statusCode).toBe(401);
        expect(error(changed)).toMatchObject({ code: 'session_ended', reason: 'revoked' });
        expect((await signIn(vic.email, 'the thief’s own password')).statusCode).toBe(401);
        const hash = await admin<{ none: boolean }>(
          `select password_hash is null as none from account where id = $1`,
          [await accountOf(vic)],
        );
        expect(hash).toEqual([{ none: true }]);
      });

      it('a passkey added from a session a reset ended while it waited is refused, and not kept (F529-03)', async () => {
        const wes = await person('adult', 'Wes');
        const link = (await started(wes)).link as string;
        await fresh(wes);
        const device = new SoftwareAuthenticator();
        const options = await t.h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/passkeys/challenge',
          headers: t.h.as(wes),
        });
        const response = device.register(options.json());
        const [spent, added] = await race(
          wes.member_id,
          () => spend(link),
          () =>
            t.h.app.inject({
              method: 'POST',
              url: '/api/v1/auth/passkeys',
              headers: t.h.as(wes),
              payload: { response, label: 'Too late' },
            }),
        );
        expect(spent.statusCode, spent.body).toBe(200);
        expect(added.statusCode).toBe(401);
        expect(error(added).code).toBe('session_ended');
        expect(
          await admin(`select id from credential where account_id = $1 and kind = 'passkey'`, [
            await accountOf(wes),
          ]),
        ).toEqual([]);
      });

      it('two-step sign-in turned on from a session a reset ended while it waited is refused (F529-03)', async () => {
        const xan = await person('adult', 'Xan');
        const link = (await started(xan)).link as string;
        await fresh(xan);
        const enrol = await t.h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/totp/enrol',
          headers: t.h.as(xan),
        });
        const secret = json<{ secret: string }>(enrol).secret;
        const [spent, confirmed] = await race(
          xan.member_id,
          () => spend(link),
          () =>
            t.h.app.inject({
              method: 'POST',
              url: '/api/v1/auth/totp/confirm',
              headers: t.h.as(xan),
              payload: { code: codeFor(secret) },
            }),
        );
        expect(spent.statusCode, spent.body).toBe(200);
        expect(confirmed.statusCode).toBe(401);
        expect(error(confirmed).code).toBe('session_ended');
        const on = await admin<{ on: boolean }>(
          `select totp_confirmed_at is not null as on from account where id = $1`,
          [await accountOf(xan)],
        );
        expect(on).toEqual([{ on: false }]);
      });

      describe('the person changing the password ends the owner’s session first: what it asks for after waits, then is refused (the second round, N529C-01)', () => {
        const OWNERS = 'the password the owner chose';
        const THEIRS = 'a password of her very own';
        const change = (who: Tokens, current: string, next: string) =>
          t.h.app.inject({
            method: 'POST',
            url: '/api/v1/auth/password/change',
            headers: t.h.as(who),
            payload: { current_password: current, new_password: next },
          });
        /** Spent by the owner, who signs in as her; she signs in with what she was handed. */
        const handedOver = async (name: string) => {
          const who = await person('adult', name);
          const link = (await started(who)).link as string;
          expect((await spend(link, OWNERS)).statusCode).toBe(200);
          const asOwner = json<Tokens>(await signIn(who.email, OWNERS));
          const hers = json<Tokens>(await signIn(who.email, OWNERS));
          return { who, asOwner, hers };
        };

        it('a passkey added from the owner’s session', async () => {
          const { who, asOwner, hers } = await handedOver('Anabel');
          await fresh(asOwner);
          const device = new SoftwareAuthenticator();
          const options = await t.h.app.inject({
            method: 'POST',
            url: '/api/v1/auth/passkeys/challenge',
            headers: t.h.as(asOwner),
          });
          const response = device.register(options.json());
          const [changed, added] = await race(
            who.member_id,
            () => change(hers, OWNERS, THEIRS),
            () =>
              t.h.app.inject({
                method: 'POST',
                url: '/api/v1/auth/passkeys',
                headers: t.h.as(asOwner),
                payload: { response, label: 'The owner’s' },
              }),
          );
          expect(changed.statusCode, changed.body).toBe(204);
          expect(added.statusCode).toBe(401);
          expect(error(added).code).toBe('session_ended');
          expect(
            await admin(`select id from credential where account_id = $1 and kind = 'passkey'`, [
              await accountOf(who),
            ]),
          ).toEqual([]);
          expect((await passkeySignIn(device, who.email)).statusCode).toBe(401);
        });

        it('two-step sign-in confirmed from the owner’s session', async () => {
          const { who, asOwner, hers } = await handedOver('Bettina');
          await fresh(asOwner);
          const enrol = await t.h.app.inject({
            method: 'POST',
            url: '/api/v1/auth/totp/enrol',
            headers: t.h.as(asOwner),
          });
          const secret = json<{ secret: string }>(enrol).secret;
          const [changed, confirmed] = await race(
            who.member_id,
            () => change(hers, OWNERS, THEIRS),
            () =>
              t.h.app.inject({
                method: 'POST',
                url: '/api/v1/auth/totp/confirm',
                headers: t.h.as(asOwner),
                payload: { code: codeFor(secret) },
              }),
          );
          expect(changed.statusCode, changed.body).toBe(204);
          expect(confirmed.statusCode).toBe(401);
          expect(error(confirmed).code).toBe('session_ended');
          expect(json<Record<string, unknown>>(await signIn(who.email, THEIRS))).not.toHaveProperty(
            'mfa_required',
          );
        });

        it('a change of the password from the owner’s session', async () => {
          const { who, asOwner, hers } = await handedOver('Carys');
          const [changed, theirs] = await race(
            who.member_id,
            () => change(hers, OWNERS, THEIRS),
            () => change(asOwner, OWNERS, 'the owner’s next one'),
          );
          expect(changed.statusCode, changed.body).toBe(204);
          expect(theirs.statusCode).toBe(401);
          expect(error(theirs).code).toBe('session_ended');
          expect((await signIn(who.email, THEIRS)).statusCode).toBe(200);
          expect((await signIn(who.email, 'the owner’s next one')).statusCode).toBe(401);
        });
      });

      describe('a code given after the password was proven, when the password has changed since, opens nothing (the second round, N529C-04)', () => {
        /** Somebody with two-step sign-in, part-way through signing in: the password proven. */
        const halfway = async (name: string) => {
          const who = await person('adult', name);
          const secret = await enrolTotp(who);
          const first = json<{ mfa_required: boolean; mfa_token: string }>(await signIn(who.email));
          expect(first.mfa_required).toBe(true);
          const second = () =>
            t.h.app.inject({
              method: 'POST',
              url: '/api/v1/auth/mfa',
              payload: { mfa_token: first.mfa_token, code: codeFor(secret) },
              ...f.peer(),
            });
          return { who, second };
        };

        it('after a change of the password', async () => {
          const { who, second } = await halfway('Della');
          // A session of hers already open changes it meanwhile.
          const changed = await t.h.app.inject({
            method: 'POST',
            url: '/api/v1/auth/password/change',
            headers: t.h.as(who),
            payload: { current_password: PASSWORD, new_password: 'changed meanwhile, too' },
          });
          expect(changed.statusCode, changed.body).toBe(204);
          const refused = await second();
          expect(refused.statusCode).toBe(401);
          expect(error(refused).code).toBe('invalid_credentials');
        });

        it('after a reset is spent, at the same moment', async () => {
          const { who, second } = await halfway('Elin');
          const link = (await started(who)).link as string;
          const [spent, opened] = await race(who.member_id, () => spend(link), second);
          expect(spent.statusCode, spent.body).toBe(200);
          expect(opened.statusCode).toBe(401);
          expect(error(opened).code).toBe('invalid_credentials');
        });
      });

      it('two-step sign-in started from a session a reset ended while it waited is refused, and nothing is kept (F529-03)', async () => {
        const zed = await person('adult', 'Zed');
        const link = (await started(zed)).link as string;
        await fresh(zed);
        const [spent, started2] = await race(
          zed.member_id,
          () => spend(link),
          () =>
            t.h.app.inject({
              method: 'POST',
              url: '/api/v1/auth/totp/enrol',
              headers: t.h.as(zed),
            }),
        );
        expect(spent.statusCode, spent.body).toBe(200);
        expect(started2.statusCode).toBe(401);
        expect(error(started2).code).toBe('session_ended');
        const kept = await admin<{ kept: boolean }>(
          `select totp_secret is not null as kept from account where id = $1`,
          [await accountOf(zed)],
        );
        expect(kept).toEqual([{ kept: false }]);
      });

      it('something private made by a session a lock ended while it waited says the session was suspended (F529-07)', async () => {
        const yan = await person('adult', 'Yan');
        await fresh(t.owner);
        const [locked, made] = await race(
          yan.member_id,
          () => lock(yan),
          () =>
            t.h.app.inject({
              method: 'POST',
              url: '/api/v1/documents',
              headers: t.h.as(yan),
              payload: {
                title: 'Made as the lock came',
                type_key: 'utility_bill',
                owner_member_id: yan.member_id,
                visibility: 'private',
              },
            }),
        );
        expect(locked.statusCode, locked.body).toBe(200);
        expect(made.statusCode).toBe(401);
        expect(error(made)).toMatchObject({ code: 'session_ended', reason: 'suspended' });
        await fresh(t.owner);
        expect((await unlock(yan)).statusCode).toBe(204);
      });
    });
  },
);

describe.skipIf(!testAdminUrl())(
  'a password reset an owner starts, with the operator’s mail server (5.29)',
  () => {
    const f = family(true);
    const { t, accountOf, person, started, card, signIn, spend, admin, document } = f;

    const tokenFrom = (url: string) => url.slice(url.lastIndexOf('#') + 1);

    it("path 1 mail goes only through operator mail, to the person's own address, never household mail", async () => {
      const sara = await person('adult', 'Sara');
      const saraAccount = await accountOf(sara);
      // Whatever she keeps: it goes to her, so it may.
      await document(sara, { title: 'Counselling notes', visibility: 'private' });
      expect((await card(sara)).reset_path).toBe('mail');
      const since = t.h.jobs.length;
      const made = await started(sara);
      // The answer carries no link.
      expect(made).toEqual({
        member_id: sara.member_id,
        path: 'mail',
        stop_now: false,
        expires_at: expect.any(String) as unknown,
      });
      const alerts = t.h.jobs
        .slice(since)
        .filter((j) => j.name === 'alert.send')
        .map((j) => j.data);
      const withLink = alerts.filter((a) => typeof a.url === 'string');
      // One mail carries it: to her account alone, by the operator's server
      // alone, by email alone.
      expect(withLink).toHaveLength(1);
      expect(withLink[0]).toMatchObject({
        account_ids: [saraAccount],
        via: 'operator',
        email_only: true,
        url_label: 'Set a new password',
      });
      const url = withLink[0]?.url as string;
      expect(url).toMatch(/^http:\/\/localhost:8080\/reset#[A-Za-z0-9_-]{43}$/);
      // No other job, line or answer holds it.
      const secret = tokenFrom(url);
      expect(JSON.stringify(t.h.jobs.filter((j) => j.data !== withLink[0])).includes(secret)).toBe(
        false,
      );
      const lines = await admin<{ detail: unknown }>(
        `select detail from audit_event where action = 'member.reset_started'`,
      );
      expect(JSON.stringify(lines)).not.toContain(secret);
      expect(lines.at(-1)?.detail).toEqual({ path: 'mail', stop_now: false, sessions: 0 });
      // And it works, for her.
      expect((await spend(url)).statusCode).toBe(200);
      expect((await signIn(sara.email, 'a password the owner chose')).statusCode).toBe(200);
    });

    it("every reset expires the person's exports: an owner's, their own forgot(), and the command line's", async () => {
      const exportsLive = async (account: string) =>
        (
          await admin<{ n: number }>(
            `select count(*)::int as n from export
              where requested_by = $1 and (expires_at is null or expires_at > now())`,
            [account],
          )
        )[0]?.n;
      const withExport = async () => {
        const p = await person('adult');
        const account = await accountOf(p);
        await admin(
          `insert into export (household_id, requested_by, state) values ($1, $2, 'done')`,
          [p.household_id, account],
        );
        await admin(
          `insert into export (household_id, requested_by, state, expires_at)
           values ($1, $2, 'done', now() + interval '7 days')`,
          [p.household_id, account],
        );
        expect(await exportsLive(account)).toBe(2);
        return { p, account };
      };
      const lastLinkTo = (account: string) => {
        const sent = t.h.jobs
          .filter(
            (j) =>
              j.name === 'alert.send' &&
              typeof j.data.url === 'string' &&
              (j.data.account_ids as string[]).includes(account),
          )
          .at(-1);
        return sent?.data.url as string;
      };

      // An owner's.
      const a = await withExport();
      await started(a.p);
      expect(await exportsLive(a.account)).toBe(2);
      expect((await spend(lastLinkTo(a.account))).statusCode).toBe(200);
      expect(await exportsLive(a.account)).toBe(0);

      // Their own forgotten password.
      const b = await withExport();
      const asked = await t.h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        payload: { email: b.p.email },
        remoteAddress: '10.29.250.1',
      });
      expect(asked.statusCode).toBe(202);
      expect((await spend(lastLinkTo(b.account))).statusCode).toBe(200);
      expect(await exportsLive(b.account)).toBe(0);

      // The command line's (cli.ts: issue as the operator, and print it).
      const c = await withExport();
      const cli = new PasswordService(
        t.h.db,
        new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
        null,
        'http://localhost:8080',
      );
      const printed = await cli.issue(c.account, 'operator');
      expect((await spend(cli.linkFor(printed.token))).statusCode).toBe(200);
      expect(await exportsLive(c.account)).toBe(0);
      // Each said so in its line.
      const lines = await admin<{ detail: { issued_by: string; exports: number } }>(
        `select detail from audit_event where action = 'auth.password_reset'
          and actor_account_id = any($1::uuid[]) order by id`,
        [[a.account, b.account, c.account]],
      );
      expect(lines.map((l) => l.detail)).toEqual([
        { issued_by: 'owner', exports: 2 },
        { issued_by: 'self', exports: 2 },
        { issued_by: 'operator', exports: 2 },
      ]);
    });
  },
);
