import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ANONYMOUS, appendAudit, withScope, type Db } from '@fdv/db';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import { ApiError } from '../errors.js';

/**
 * Failed sign-ins, counted (0.9.0).
 *
 * The rate limits in front of the vault count per address: ten tries a
 * minute at signing in. Somebody with many addresses could try one
 * person's password, or the six digits of their authenticator app, without
 * end. So failures are counted per account too — a wrong password, a code
 * from an authenticator app or by text that didn't match — and after five
 * a sign-in by password or code waits a minute, then five, then fifteen,
 * never longer. The count starts again 24 hours after the first failure it
 * counts, or as soon as a try succeeds. A passkey (nothing to guess) never
 * waits.
 *
 * Whoever knows somebody's address could otherwise keep them waiting for
 * ever, one wrong try every fifteen minutes. So a device that has signed in
 * to the account before — it holds a proof the vault gave it then
 * (`KnownDevices`: a cookie in a browser, `device_proof` for an app that
 * keeps it) — is counted on its own, and is never made to wait by failures
 * from anywhere else. Confirming it's you, and changing the password, are
 * counted per session: only somebody signed in reaches them, and their
 * failures never make the person's sign-in wait.
 *
 * Every try is reserved before it is checked, in one statement: tries sent
 * at the same moment cannot pass the limit between them.
 *
 * An address with no account is counted and answered word for word as one
 * with an account is: none of this says which addresses have accounts here.
 * What is kept is an HMAC of each, never the address or an id itself.
 *
 * What the person sees: a line in their Activity for each failure (ten an
 * hour at most), and, once in an incident (it ends after 24 hours without a
 * failure), an alert after five failures — email, push to their browsers,
 * one text if they asked for alerts by text; for an owner, the other owners
 * are emailed too, once. Never about an address with no account.
 */

/** A wrong password, a code that didn't match, a passkey refused. */
export type FailedStep = 'password' | 'code' | 'passkey';

/** Failures before signing in waits. */
export const THROTTLE_AFTER = 5;
/** How long it waits, in seconds: the fifth failure, the sixth, every one after. */
export const THROTTLE_SECONDS = [60, 300, 900] as const;
/** A count starts again this long after the first failure it counts; an incident ends after this long without one. */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** A try reserved and never settled (the process stopped) is let go after this long. */
export const INFLIGHT_MS = 60 * 1000;
/** Lines written to the activity log for one account, an hour at most. */
export const AUDITED_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/** How long a wait is, in words: "a minute", "5 minutes". */
const waitWords = (seconds: number) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
};

/** Said while signing in waits: the same words whoever's address it is. */
export function signInThrottled(seconds: number): ApiError {
  return new ApiError(
    429,
    'sign_in_throttled',
    `Too many tries to sign in. Wait ${waitWords(seconds)} and try again, or sign in with a passkey if you have one.`,
    { retriable: true, retryAfter: seconds },
  );
}

export interface GuardMeta {
  ip?: string | null;
}

/** A line for the API's log: what an operator greps for (README, "Security events"). */
export type GuardLog = (fields: Record<string, unknown>, message: string) => void;

/** A try, reserved: settled once as a failure, a success, or neither. */
export interface Attempt {
  subject: Buffer | null;
  settled: boolean;
}

export class SignInGuard {
  private readonly key: Buffer;
  /** What runs after an answer is given: the activity line and the alert. */
  private readonly pending = new Set<Promise<void>>();
  private log: GuardLog;

  constructor(
    private readonly db: Db,
    signingKey: Uint8Array,
    private readonly alert: (a: AlertRequest) => Promise<void>,
    private readonly opts: {
      /** Held to (the default); the test harness, whose tests are not about it, unless one asks. */
      enabled?: boolean;
      now?: () => number;
      log?: GuardLog;
    } = {},
  ) {
    this.key = createHmac('sha256', signingKey).update('fdv sign-in failures').digest();
    this.log = opts.log ?? (() => undefined);
  }

  /** Where its lines go: the API's own log, once it has one (server.ts). */
  useLog(log: GuardLog): void {
    this.log = log;
  }

  get enabled(): boolean {
    return this.opts.enabled ?? true;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private hmac(text: string): Buffer {
    return createHmac('sha256', this.key).update(text).digest();
  }

  /** Tries at an account from a device it does not know. */
  subjectOfAccount(accountId: string): Buffer {
    return this.hmac(`account:${accountId}`);
  }

  /** Tries at an account from one device that signed in to it before. */
  subjectOfDevice(accountId: string, deviceId: string): Buffer {
    return this.hmac(`device:${accountId}:${deviceId}`);
  }

  /** Tries at an address with no account, as typed (lower-cased). */
  subjectOfEmail(email: string): Buffer {
    return this.hmac(`email:${email.trim().toLowerCase()}`);
  }

  /** Confirming it's you, or a password change, in one session. */
  subjectOfSession(sessionId: string): Buffer {
    return this.hmac(`session:${sessionId}`);
  }

  /** An account's notices: its activity lines and its alerts. */
  private noticesOf(accountId: string): Buffer {
    return this.hmac(`notices:${accountId}`);
  }

  /**
   * A try, reserved before it is checked, or `429 sign_in_throttled`:
   * while its subject waits, or while as many tries are on their way as it
   * has left before it would (one at a time, once it has waited before).
   */
  async begin(subject: Buffer): Promise<Attempt> {
    if (!this.enabled) return { subject: null, settled: true };
    const now = new Date(this.now());
    const day = new Date(now.getTime() - DAY_MS);
    const stale = new Date(now.getTime() - INFLIGHT_MS);
    const r = await sql<{ ok: number }>`
      insert into sign_in_failure as f
             (subject, failures, window_started_at, inflight, inflight_at, last_failed_at)
      values (${subject}, 0, ${now}, 1, ${now}, ${now})
      on conflict (subject) do update set
        failures = case when f.window_started_at < ${day} then 0 else f.failures end,
        second_step = case when f.window_started_at < ${day} then false else f.second_step end,
        throttled_until = case when f.window_started_at < ${day} then null
                               else f.throttled_until end,
        window_started_at = case when f.window_started_at < ${day} then ${now}
                                 else f.window_started_at end,
        inflight = case when f.inflight_at is null or f.inflight_at < ${stale} then 1
                        else f.inflight + 1 end,
        inflight_at = ${now},
        last_failed_at = greatest(f.last_failed_at, ${now})
      where f.window_started_at < ${day}
         or ((f.throttled_until is null or f.throttled_until <= ${now})
             and (case when f.inflight_at is null or f.inflight_at < ${stale} then 0
                       else f.inflight end)
                 < (case when f.failures >= ${THROTTLE_AFTER} then 1
                         else ${THROTTLE_AFTER} - f.failures end))
      returning 1 as ok`.execute(this.db);
    if (r.rows.length > 0) return { subject, settled: false };
    const row = await this.db
      .selectFrom('sign_in_failure')
      .select(['throttled_until'])
      .where('subject', '=', subject)
      .executeTakeFirst();
    const until = row?.throttled_until ? new Date(row.throttled_until).getTime() : 0;
    // Waiting, or as many tries on their way as it has left: a second.
    throw signInThrottled(Math.max(1, Math.ceil((until - now.getTime()) / 1000)));
  }

  /** The try succeeded: its subject's count starts again, and nothing waits. */
  async succeeded(attempt: Attempt): Promise<void> {
    if (attempt.settled || !attempt.subject) return;
    attempt.settled = true;
    await this.db
      .updateTable('sign_in_failure')
      .set({
        inflight: sql<number>`greatest(inflight - 1, 0)`,
        failures: 0,
        second_step: false,
        throttled_until: null,
      })
      .where('subject', '=', attempt.subject)
      .execute();
  }

  /** The try was neither (a password right, the second step still to come; an error): let go. */
  async release(attempt: Attempt): Promise<void> {
    if (attempt.settled || !attempt.subject) return;
    attempt.settled = true;
    await this.db
      .updateTable('sign_in_failure')
      .set({ inflight: sql<number>`greatest(inflight - 1, 0)` })
      .where('subject', '=', attempt.subject)
      .execute();
  }

  /** A sign-in proved some other way (a passkey), or a reset: this subject's count starts again. */
  async clear(subject: Buffer): Promise<void> {
    if (!this.enabled) return;
    await this.db
      .updateTable('sign_in_failure')
      .set({ failures: 0, second_step: false, throttled_until: null })
      .where('subject', '=', subject)
      .execute();
  }

  /**
   * The try failed. `accountId` is whose, when the address has an account;
   * null for one with none, which is counted the same and told to nobody.
   * `during` says it was confirming it's them, signed in already.
   */
  async failed(
    attempt: Attempt,
    accountId: string | null,
    step: Exclude<FailedStep, 'passkey'>,
    meta: GuardMeta,
    during: 'sign_in' | 'step_up' = 'sign_in',
  ): Promise<void> {
    if (attempt.settled || !attempt.subject) return;
    attempt.settled = true;
    const now = new Date(this.now());
    const second = step === 'code';
    // The fifth failure waits a minute, the sixth five, every one after
    // fifteen: never longer.
    const r = await sql<{ failures: number; throttled_until: Date | null }>`
      update sign_in_failure set
        inflight = greatest(inflight - 1, 0),
        window_started_at = case when failures = 0 then ${now} else window_started_at end,
        failures = failures + 1,
        second_step = second_step or ${second},
        last_failed_at = ${now},
        throttled_until = case
          when failures + 1 < ${THROTTLE_AFTER} then throttled_until
          when failures + 1 = ${THROTTLE_AFTER} then ${now}::timestamptz + interval '${sql.raw(String(THROTTLE_SECONDS[0]))} seconds'
          when failures + 1 = ${THROTTLE_AFTER + 1} then ${now}::timestamptz + interval '${sql.raw(String(THROTTLE_SECONDS[1]))} seconds'
          else ${now}::timestamptz + interval '${sql.raw(String(THROTTLE_SECONDS[2]))} seconds' end
      where subject = ${attempt.subject}
      returning failures, throttled_until`.execute(this.db);
    const failures = r.rows[0]?.failures ?? 0;
    const waits =
      failures >= THROTTLE_AFTER
        ? (THROTTLE_SECONDS[Math.min(failures - THROTTLE_AFTER, THROTTLE_SECONDS.length - 1)] ??
          null)
        : null;
    await this.prune(now);
    this.log(
      {
        event: 'sign_in_failed',
        step,
        during,
        account: accountId,
        ...(meta.ip ? { ip: meta.ip } : {}),
        ...(waits !== null ? { paused_seconds: waits } : {}),
      },
      waits !== null ? 'a sign-in failed, and signing in now waits' : 'a sign-in failed',
    );
    // An address with no account: nobody to tell, nowhere to write.
    if (!accountId) return;
    // The rest is after the answer: it takes as long whoever it was.
    this.track(this.tell(accountId, step, during, meta, now, waits));
  }

  /** A passkey refused: a line in the person's Activity, never counted towards a wait. */
  noted(accountId: string, meta: GuardMeta, during: 'sign_in' | 'step_up' = 'sign_in'): void {
    if (!this.enabled) return;
    this.track(this.tell(accountId, 'passkey', during, meta, new Date(this.now()), null));
  }

  /** Waits for what runs after the answers given so far: for a test, and for shutting down. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Rows quiet for a day go: an address tried once and never again is not kept. */
  private async prune(now: Date): Promise<void> {
    await this.db
      .deleteFrom('sign_in_failure')
      .where('last_failed_at', '<', new Date(now.getTime() - DAY_MS))
      .where((eb) => eb.or([eb('throttled_until', 'is', null), eb('throttled_until', '<', now)]))
      .where((eb) =>
        eb.or([
          eb('inflight_at', 'is', null),
          eb('inflight_at', '<', new Date(now.getTime() - INFLIGHT_MS)),
        ]),
      )
      .execute();
  }

  private track(work: Promise<void>): void {
    const p = work.catch((err: unknown) => {
      this.log(
        { event: 'sign_in_failed_unrecorded', error: String(err) },
        'a failed sign-in could not be recorded',
      );
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /**
   * The activity line, ten an hour at most; and, once in an incident, the
   * alert, after five failures however they were counted.
   */
  private async tell(
    accountId: string,
    step: FailedStep,
    during: 'sign_in' | 'step_up',
    meta: GuardMeta,
    now: Date,
    waits: number | null,
  ): Promise<void> {
    const membership = await withScope(this.db, { accountId, actor: ANONYMOUS }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['household_id', 'member_id', 'role'])
        .orderBy('joined_at', 'desc')
        .executeTakeFirst(),
    );
    if (!membership) return;
    const householdId = membership.household_id;
    const notices = this.noticesOf(accountId);
    const hour = new Date(now.getTime() - HOUR_MS);
    const quiet = new Date(now.getTime() - DAY_MS);
    // The incident: its failures (a passkey's not among them), and whether
    // it was told; a new one after a day without a failure.
    const counted = step === 'passkey' ? 0 : 1;
    const second = step === 'code';
    const incident = await sql<{
      failures: number;
      second_step: boolean;
      incident_told: boolean;
      owners_told: boolean;
    }>`
      insert into sign_in_failure as f
             (subject, failures, second_step, window_started_at, last_failed_at, audited, audited_since)
      values (${notices}, ${counted}, ${second}, ${now}, ${now}, 0, ${now})
      on conflict (subject) do update set
        failures = case when f.last_failed_at < ${quiet} then ${counted}
                        else f.failures + ${counted} end,
        second_step = case when f.last_failed_at < ${quiet} then ${second}
                           else f.second_step or ${second} end,
        incident_told = case when f.last_failed_at < ${quiet} then false else f.incident_told end,
        owners_told = case when f.last_failed_at < ${quiet} then false else f.owners_told end,
        window_started_at = case when f.last_failed_at < ${quiet} then ${now}
                                 else f.window_started_at end,
        last_failed_at = ${now}
      returning failures, second_step, incident_told, owners_told`.execute(this.db);
    const state = incident.rows[0];

    // Ten lines an hour at most: whoever keeps trying does not fill the log.
    const audit = await sql<{ ok: number }>`
      update sign_in_failure set
        audited = case when audited_since < ${hour} then 1 else audited + 1 end,
        audited_since = case when audited_since < ${hour} then ${now} else audited_since end
      where subject = ${notices} and (audited_since < ${hour} or audited < ${AUDITED_PER_HOUR})
      returning 1 as ok`.execute(this.db);
    if (audit.rows.length > 0) {
      await withScope(this.db, { householdId, actor: ANONYMOUS }, (trx) =>
        appendAudit(trx, {
          householdId,
          actorAccountId: accountId,
          action: 'auth.sign_in_failed',
          objectType: 'member',
          objectId: membership.member_id,
          // Which step, and how long signing in now waits: never what was
          // typed, nor the address.
          detail: {
            step,
            ...(during === 'step_up' ? { at: 'step_up' } : {}),
            ...(waits !== null ? { paused_minutes: Math.ceil(waits / 60) } : {}),
          },
          ip: meta.ip ?? null,
        }),
      );
    }

    if (waits !== null) {
      this.log(
        { event: 'sign_in_throttled', account: accountId, paused_seconds: waits },
        'signing in to an account waits after too many failed tries',
      );
    }
    // Once in an incident, after five failures: the person, and for an
    // owner the other owners.
    if (!state || state.failures < THROTTLE_AFTER || state.incident_told) return;
    const told = await sql<{ ok: number }>`
      update sign_in_failure set incident_told = true
      where subject = ${notices} and not incident_told
      returning 1 as ok`.execute(this.db);
    if (told.rows.length === 0) return;
    const people = await withScope(this.db, { householdId, actor: ANONYMOUS }, async (trx) => {
      const me = await trx
        .selectFrom('member')
        .select(['display_name'])
        .where('id', '=', membership.member_id)
        .executeTakeFirst();
      const owners = await trx
        .selectFrom('account_household')
        .select(['account_id'])
        .where('role', '=', 'owner')
        .where('account_id', '<>', accountId)
        .execute();
      return { name: me?.display_name ?? 'Somebody', owners: owners.map((o) => o.account_id) };
    });
    const waiting =
      waits !== null ? ` Signing in from a new device now waits ${waitWords(waits)}.` : '';
    await this.alert({
      householdId,
      accountIds: [accountId],
      subject: 'Somebody is trying to sign in to your vault',
      body: state.second_step
        ? `There have been ${state.failures} failed tries to sign in to your account, some of them with your right password but the wrong code.${waiting} If that wasn't you, somebody knows your password: change it under Settings → Your account, and sign out any device you don't know. You won't be told again about tries today; they are in your Activity.`
        : `There have been ${state.failures} failed tries to sign in to your account.${waiting} Your own devices, where you have signed in before, are not made to wait. If it wasn't you, nothing was opened; a long password you use nowhere else, and two-step sign-in, keep it so. You won't be told again about tries today; they are in your Activity.`,
      // One text an incident, with its first (and only) alert.
      text: 'sign_in_tries',
    });
    if (membership.role !== 'owner' || people.owners.length === 0 || state.owners_told) return;
    const ownersTold = await sql<{ ok: number }>`
      update sign_in_failure set owners_told = true
      where subject = ${notices} and not owners_told
      returning 1 as ok`.execute(this.db);
    if (ownersTold.rows.length === 0) return;
    await this.alert({
      householdId,
      accountIds: people.owners,
      subject: `Somebody is trying to sign in as ${people.name}`,
      body: `There have been ${state.failures} failed tries to sign in to ${people.name}'s account, an owner of your vault. ${people.name} has been told too; check with them, and see Activity.`,
      // Email and push only: the text is the person's own.
      noText: true,
    });
  }
}

/** How long a device stays known after it last signed in. */
export const DEVICE_PROOF_DAYS = 90;
const PROOF = /^kd1\.([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/**
 * The proof a device keeps that it signed in to an account before (0.9.0):
 * `kd1.<device id>.<issued at>.<HMAC over account, device id and issued
 * at>`, under a key derived for this alone. Given at every sign-in — in an
 * HttpOnly cookie to a browser, as `device_proof` to an app that keeps it —
 * and good for 90 days from then. It opens nothing: it only keeps that
 * device's own failed tries apart from everybody else's.
 */
export class KnownDevices {
  private readonly key: Buffer;

  constructor(
    signingKey: Uint8Array,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.key = createHmac('sha256', signingKey).update('fdv known-device proof').digest();
  }

  private mac(accountId: string, deviceId: string, at: string): Buffer {
    return createHmac('sha256', this.key).update(`${accountId}.${deviceId}.${at}`).digest();
  }

  /** A proof for this account: of the same device when given its id, else a new one. */
  issue(accountId: string, deviceId: string = randomBytes(16).toString('base64url')): string {
    const at = String(Math.floor(this.now() / 1000));
    return `kd1.${deviceId}.${at}.${this.mac(accountId, deviceId, at).toString('base64url')}`;
  }

  /** The device a proof names, when it is this account's and in date; null otherwise. */
  deviceOf(accountId: string, proof: string | null | undefined): string | null {
    if (!proof) return null;
    const m = PROOF.exec(proof);
    if (!m) return null;
    const [, deviceId = '', at = '', mac = ''] = m;
    const issued = Number(at) * 1000;
    const now = this.now();
    if (issued > now + 60_000 || now - issued > DEVICE_PROOF_DAYS * DAY_MS) return null;
    const want = this.mac(accountId, deviceId, at);
    const got = Buffer.from(mac, 'base64url');
    return got.length === want.length && timingSafeEqual(got, want) ? deviceId : null;
  }
}
