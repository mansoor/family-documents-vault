import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BACKGROUND_HEADER, REFRESH_COOKIE_HEADER, REFRESH_COOKIE_MODE } from '@fdv/shared';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { clientAddressOf } from '../client-address.js';
import type { AuthService, Principal, RequestMeta } from './service.js';
import { DEVICE_PROOF_DAYS } from './sign-in-guard.js';
import type { TotpService } from './totp.js';
import type { PasskeyService } from './passkeys.js';
import type { CredentialInput, StepUpService } from './step-up.js';
import type { RestrictionService } from '../household/restrictions.js';
import type { TextCodeService } from '../sms/codes.js';
import {
  changeBody,
  completeBody,
  forgotBody,
  lookupBody,
  resetBody,
  type PasswordService,
  type ResetPreview,
} from './passwords.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Use at least 10 characters.').max(1024);

const setupBody = z.object({
  // The setup code (0.9.0): checked after the rest, so a form's own mistakes
  // are said first. Required by the service; absent, it is refused there.
  setup_token: z.string().max(256).optional(),
  household_name: z.string().trim().min(1).max(120),
  display_name: z.string().trim().min(1).max(120),
  email,
  password,
});
const passwordBody = z.object({
  email,
  password: z.string().min(1).max(1024),
  // 0.9.0: the proof an app kept from its last sign-in (`Tokens.device_proof`).
  device_proof: z.string().max(200).optional(),
});
/**
 * A refresh without the cookie header: a token, or (empty or left out) a
 * session that is over as far as this client goes — an old web page's,
 * whose token went to the cookie from another tab — `401 session_ended`.
 */
const refreshBody = z.object({ refresh_token: z.string().max(512).optional() });
/** A browser's (0.9.0): its token in its cookie, or — once, moving to one — in the body. */
const cookieRefreshBody = z.object({ refresh_token: z.string().min(1).max(512).optional() });

/**
 * A browser's refresh token (0.9.0): an HttpOnly cookie, sent back only to
 * /api/v1/auth — a refresh and a sign-out read it — and never to another
 * site's page (SameSite=Strict). Script on the page cannot read it, so a
 * flaw that ran script there could not carry the sign-in off.
 */
export const REFRESH_COOKIE = 'fdv_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
/**
 * A browser's proof that it signed in to an account before (0.9.0,
 * `KnownDevices`): beside the refresh token's, with the same options, so
 * that failed tries from anywhere else never make this browser wait.
 */
export const DEVICE_COOKIE = 'fdv_device';

/**
 * A forgotten password is answered after this long, whatever the address
 * (0.9.0): an address with a sign-in issues a link and queues an email,
 * one without does nothing, and the time it took must not say which.
 */
export const FORGOT_ANSWER_MS = 500;

/** Whether the request asks for its refresh token as a cookie: the web app's every request. */
export function wantsRefreshCookie(req: FastifyRequest): boolean {
  return req.headers[REFRESH_COOKIE_HEADER] === REFRESH_COOKIE_MODE;
}

/**
 * Whether a request that would spend the cookie came from the vault's own
 * page (0.9.0). The header it must carry is one no other site's page can
 * send here (the API answers no cross-origin request); and a browser's own
 * word: `Sec-Fetch-Site: same-origin`, which every current browser sends —
 * or, from one too old to, an `Origin` naming the host the request came to.
 * (Not both: a proxy in front of the vault may pass a Host of its own.)
 */
export function fromOwnPage(req: FastifyRequest): boolean {
  if (!wantsRefreshCookie(req)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (host !== req.hostname.toLowerCase()) return false;
  }
  return true;
}

/** No refresh token at all, in the body or a cookie: this client's session is over. */
const noRefreshToken = () =>
  new ApiError(401, 'session_ended', 'Please sign in again.', {
    detail: 'no refresh token',
    reason: 'expired',
  });

const notFromOwnPage = () =>
  new ApiError(403, 'cross_site_refused', "That didn't come from the vault's own page.");

/**
 * The cookie's options. Secure whenever the request reached the vault over
 * https — as the proxy in front of it says, believed only from the vault's
 * own network (FDV_TRUST_PROXY, client-address.ts) — so that it never
 * travels over plain http once it has been given over https. Over plain
 * http on the home network (port 8080) it cannot be: a browser keeps no
 * Secure cookie from an http page but localhost's. HttpOnly and
 * SameSite=Strict hold either way.
 */
function cookieOptions(req: FastifyRequest) {
  return {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: req.protocol === 'https',
  };
}

function setRefreshCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
  maxAgeSeconds: number,
): void {
  void reply.setCookie(REFRESH_COOKIE, token, { ...cookieOptions(req), maxAge: maxAgeSeconds });
}

function clearRefreshCookie(req: FastifyRequest, reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE, cookieOptions(req));
}

/** An answer that gives tokens: a sign-in's, a refresh's, an invitation accepted. */
function givesTokens(
  payload: unknown,
): payload is { refresh_token: string; refresh_expires_in: number } {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.access_token === 'string' &&
    typeof p.refresh_token === 'string' &&
    p.refresh_token !== '' &&
    typeof p.refresh_expires_in === 'number' &&
    typeof p.household_id === 'string'
  );
}

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ApiError(422, 'validation_failed', first?.message ?? 'Please check the form.', {
      detail: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a session that must set up two-step sign-in first (0.9.0: an owner,
 * or an adult where the household asks it, with neither a code from an
 * authenticator app nor a passkey) may do: say who it is, confirm it's them,
 * set up a code or a passkey, and sign out. Every other route answers it
 * `403 two_step_setup_required`.
 */
export const TWO_STEP_SETUP_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/me',
  'POST /api/v1/auth/logout',
  'GET /api/v1/auth/step-up',
  'POST /api/v1/auth/step-up',
  // A locked session's way back (0.9.0-dev.86) confirms it's them as step-up does.
  'POST /api/v1/auth/unlock',
  'POST /api/v1/auth/totp/enrol',
  'POST /api/v1/auth/totp/confirm',
  'GET /api/v1/auth/passkeys',
  'POST /api/v1/auth/passkeys/challenge',
  'POST /api/v1/auth/passkeys',
]);

/**
 * What a locked session may do (0.9.0-dev.86): say who it is (for the lock
 * screen's ways to confirm it's you), have a code texted for that, unlock,
 * lock again, and sign out. Every other route that takes a session answers
 * it `423 session_locked` — whichever it is, by default (`authenticate`), so
 * a route added later is locked too. The public routes (the capability
 * document, the health checks, a renewal, a passkey's challenge), a
 * connected app's and a link's take no session, and are not asked.
 */
export const SESSION_LOCK_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/me',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/lock',
  'POST /api/v1/auth/unlock',
  'GET /api/v1/auth/step-up',
  'POST /api/v1/auth/step-up/text',
]);

/** A credential given again, to confirm it's you or to unlock. */
const credentialBody = z.object({
  password: z.string().min(1).optional(),
  code: z.string().min(6).max(10).optional(),
  passkey: z.record(z.string(), z.unknown()).optional(),
  // 0.9.0: a code texted to their own number, an adult's or a teen's.
  text_code: z.string().min(6).max(16).optional(),
});

function credentialOf(body: z.infer<typeof credentialBody>): CredentialInput {
  return {
    ...(body.password ? { password: body.password } : {}),
    ...(body.code ? { code: body.code } : {}),
    ...(body.passkey ? { passkey: body.passkey as never } : {}),
    ...(body.text_code ? { text_code: body.text_code } : {}),
  };
}

export function metaOf(req: FastifyRequest): RequestMeta {
  // The app's installation id (0.4.11): kept only if it is a UUID.
  const installation = req.headers['x-fdv-installation'];
  const installationId =
    typeof installation === 'string' && UUID.test(installation) ? installation.toLowerCase() : null;
  // A user agent is kept to its first 512 characters: all a person needs, and all we store.
  const agent = req.headers['user-agent'];
  // A browser's proof that it signed in before (0.9.0), from its cookie; an
  // app's comes in the sign-in's body.
  const proof = wantsRefreshCookie(req) ? req.cookies[DEVICE_COOKIE] : undefined;
  // An address, never text a proxy passed on that is none (5.30).
  return {
    ip: clientAddressOf(req),
    userAgent: agent ? agent.slice(0, 512) : null,
    installationId,
    deviceProof: typeof proof === 'string' && proof.length <= 200 ? proof : null,
    // The vault's own page (0.9.0-dev.87): what it signs in is a browser's session.
    browser: wantsRefreshCookie(req) && installationId === null,
  };
}

/** Whether the page asked by itself, not because somebody did something (0.9.0-dev.87). */
export function inBackground(req: FastifyRequest): boolean {
  return req.headers[BACKGROUND_HEADER] === '1';
}

/**
 * Registers the auth decorator and routes. `app.requireAuth` is a preHandler
 * any route can use; it populates `request.principal` or fails with the
 * envelope.
 */
export function registerAuth(
  app: FastifyInstance,
  auth: AuthService,
  totp?: TotpService,
  passkeys?: PasskeyService,
  stepUp?: StepUpService,
  passwords?: PasswordService,
  restrictions?: RestrictionService,
  textCodes?: TextCodeService,
): void {
  app.decorateRequest('principal', null);

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new ApiError(401, 'unauthenticated', 'Please sign in.');
    }
    // A session that must set up two-step sign-in first (0.9.0) is let
    // through to these routes alone.
    const route = `${req.method} ${req.routeOptions.url ?? ''}`;
    req.principal = await auth.authenticate(token, {
      enrolling: TWO_STEP_SETUP_ROUTES.has(route),
      // A locked session (0.9.0-dev.86) is let through to these alone.
      whileLocked: SESSION_LOCK_ROUTES.has(route),
      // Asked by the page by itself (0.9.0-dev.87): not use. The lock
      // screen's own look at who is signed in is not use either.
      background: inBackground(req) || route === 'GET /api/v1/me',
      ip: clientAddressOf(req),
    });
  });

  const tight = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // A browser's refresh token goes in its cookie, never in what script on
  // the page can read (0.9.0): wherever tokens are given — a sign-in, a
  // refresh, an invitation accepted — to a request that asks for it.
  app.addHook('preSerialization', async (req, reply, payload) => {
    if (!wantsRefreshCookie(req) || reply.statusCode >= 300 || !givesTokens(payload)) {
      return payload;
    }
    setRefreshCookie(req, reply, payload.refresh_token, payload.refresh_expires_in);
    void reply.header('cache-control', 'no-store');
    const { device_proof: proof, ...rest } = payload as typeof payload & { device_proof?: unknown };
    // This browser is one the account knows (0.9.0): its proof, in a
    // cookie of its own beside the refresh token's, for 90 days. Signing
    // out leaves it: it is about the device, not the session.
    if (typeof proof === 'string') {
      void reply.setCookie(DEVICE_COOKIE, proof, {
        ...cookieOptions(req),
        maxAge: DEVICE_PROOF_DAYS * 24 * 60 * 60,
      });
    }
    return { ...rest, refresh_token: '' };
  });

  app.post('/api/v1/setup', tight, async (req, reply) => {
    const body = parse(setupBody, req.body);
    const tokens = await auth.setup(
      {
        setupToken: body.setup_token,
        householdName: body.household_name,
        displayName: body.display_name,
        email: body.email,
        password: body.password,
      },
      metaOf(req),
    );
    return reply.status(201).send(tokens);
  });

  app.post('/api/v1/auth/password', tight, async (req) => {
    const body = parse(passwordBody, req.body);
    const meta = metaOf(req);
    return auth.signInWithPassword(body.email, body.password, {
      ...meta,
      deviceProof: body.device_proof ?? meta.deviceProof ?? null,
    });
  });

  app.post('/api/v1/auth/mfa', tight, async (req) => {
    const body = parse(
      z.object({
        mfa_token: z.string().min(1),
        code: z.string().min(6).max(10),
        // 0.9.0 (SMS3): which code it is. Absent, as from an older client:
        // the authenticator's, or a text's when that is the only second step.
        method: z.enum(['totp', 'text']).optional(),
      }),
      req.body,
    );
    return auth.signInWithMfa(body.mfa_token, body.code, metaOf(req), body.method);
  });

  // A code texted for a sign-in's second step (0.9.0, SMS3): only after the
  // password was right (the interim token says so), and only to the
  // person's own confirmed number, within its own limits.
  app.post('/api/v1/auth/mfa/text', tight, async (req, reply) => {
    const body = parse(z.object({ mfa_token: z.string().min(1) }).strict(), req.body);
    void reply.headers({ 'cache-control': 'no-store' });
    return auth.sendSignInCode(body.mfa_token);
  });

  app.post('/api/v1/auth/refresh', tight, async (req) => {
    if (!wantsRefreshCookie(req)) {
      const body = parse(refreshBody, req.body ?? {});
      if (!body.refresh_token) throw noRefreshToken();
      return auth.refresh(body.refresh_token, metaOf(req));
    }
    // A browser (0.9.0). A token in the body is one kept from before: spent
    // once, its successor in the cookie (the hook above), and forgotten.
    const body = parse(cookieRefreshBody, req.body ?? {});
    if (body.refresh_token) return auth.refresh(body.refresh_token, metaOf(req));
    if (!fromOwnPage(req)) throw notFromOwnPage();
    const kept = req.cookies[REFRESH_COOKIE];
    if (!kept) throw noRefreshToken();
    return auth.refresh(kept, metaOf(req));
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const browser = wantsRefreshCookie(req);
    const kept = browser ? req.cookies[REFRESH_COOKIE] : undefined;
    if (req.headers.authorization !== undefined || !kept) {
      await app.requireAuth(req);
      const p = req.principal as Principal;
      await auth.revokeSession(p, p.sessionId, metaOf(req), 'logout');
    } else {
      // A browser with no access token to hand (0.9.0): the session its
      // cookie names ends, from the vault's own page only.
      if (!fromOwnPage(req)) throw notFromOwnPage();
      await auth.signOutByRefresh(kept, metaOf(req));
    }
    if (browser) clearRefreshCookie(req, reply);
    // A browser signing out forgets what it kept of this vault, including
    // what versions before 0.5.0 let it keep. Browsers act on it over https
    // and on localhost; apps ignore it.
    void reply.header('clear-site-data', '"cache"');
    return reply.status(204).send();
  });

  app.get('/api/v1/auth/sessions', { preHandler: app.requireAuth }, async (req) => {
    return { items: await auth.listSessions(req.principal as Principal) };
  });

  // Every other device of one's own signed out at once (0.9.0), once it's
  // confirmed to be them: any credential they have.
  app.post(
    '/api/v1/auth/sessions/sign-out-others',
    { preHandler: app.requireAuth },
    async (req) => {
      const p = req.principal as Principal;
      await stepUp?.require(p, 'sign_out_others');
      return auth.signOutOthers(p, metaOf(req));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/auth/sessions/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      await auth.revokeSession(req.principal as Principal, req.params.id, metaOf(req), 'revoked');
      return reply.status(204).send();
    },
  );

  app.get('/api/v1/me', { preHandler: app.requireAuth }, async (req) => {
    const p = req.principal as Principal;
    const enabled = totp ? await totp.isEnabled(p.accountId) : false;
    const passkey = passkeys ? await passkeys.has(p.accountId) : false;
    // Locked (0.9.0-dev.86): who it is and how they can confirm it's them,
    // for the lock screen, and nothing more.
    const locked = p.locked === true;
    return {
      account_id: p.accountId,
      household_id: p.householdId,
      member_id: p.memberId,
      role: p.role,
      totp_enabled: enabled,
      has_passkey: passkey,
      // SEC-03: an owner must have something beyond a password. A passkey
      // is that something — it is phishing-resistant and device-bound —
      // so it satisfies the rule as well as an authenticator app does.
      totp_required: p.role === 'owner' && !enabled && !passkey,
      // 0.9.0: this session may only set up two-step sign-in, or sign out
      // (an owner, or an adult where the household asks it, with neither).
      two_step_setup_required: p.twoStepPending !== undefined,
      // Why (0.9.0): `enrol`, none set up yet; `confirm`, one set up and not
      // given by this session — a passkey or a code (POST /auth/step-up) lets
      // it go on. Null when nothing is asked.
      two_step_reason: p.twoStepPending ?? null,
      // 5.29: an owner made a link to hand over for this sign-in, not yet
      // seen: told at every sign-in until it is.
      reset_notice: passwords && !locked ? await passwords.notice(p) : null,
      // And when such a link was last spent: every password change takes
      // away what was added to the sign-in since.
      handover_since: passwords && !locked ? await passwords.handoverSince(p) : null,
      // 5.33: what an owner has limited this viewer to, in their own words;
      // null for anybody not restricted.
      restriction: restrictions && !locked ? await restrictions.mine(p) : null,
      // 5.34: a guest from outside the family — a viewer, always limited —
      // and when their sign-in ends (A28).
      kind: p.guest ? 'guest' : 'family',
      access_expires_at: p.accessExpiresAt?.toISOString() ?? null,
      // 0.9.0-dev.86: this session is locked; POST /auth/unlock unlocks it.
      locked,
      // 0.9.0-dev.87: after how many minutes with nobody using it this
      // session locks by itself — a browser's; null for a phone's, and Off.
      auto_lock_minutes: p.autoLockMinutes ?? null,
    };
  });

  // Lock (0.9.0-dev.86): this session locked, as the vault keeps it, until a
  // credential is given again. Locked already, it stays so. `away: true`
  // (0.9.0-dev.87): the page locked itself as its time ran out, and the line
  // says so.
  app.post('/api/v1/auth/lock', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = parse(z.object({ away: z.boolean().optional() }).strict(), req.body ?? {});
    await auth.lockSession(req.principal as Principal, metaOf(req), { away: body.away === true });
    return reply.status(204).send();
  });

  // Somebody is still here (0.9.0-dev.87): a browser says so while its page
  // is used — the mouse, the keys, scrolling — at most about once a minute,
  // so reading a long document is use. Nothing else is done: being asked is
  // use, as any request not marked as the page's own is (`authenticate`).
  app.post('/api/v1/auth/still-here', { preHandler: app.requireAuth }, async (_req, reply) =>
    reply.status(204).send(),
  );

  // They have seen it (5.29). Nothing to see answers the same.
  app.delete('/api/v1/me/reset-notice', { preHandler: app.requireAuth }, async (req, reply) => {
    await passwords?.noticeSeen(req.principal as Principal);
    return reply.status(204).send();
  });

  if (stepUp) {
    // SEC-17: proving it is you again, for the handful of actions where a
    // live session is not enough.
    app.get('/api/v1/auth/step-up', { preHandler: app.requireAuth }, async (req) =>
      stepUp.freshness(req.principal as Principal),
    );

    app.post('/api/v1/auth/step-up', { preHandler: app.requireAuth }, async (req) => {
      const body = parse(credentialBody, req.body);
      return stepUp.verify(req.principal as Principal, credentialOf(body), metaOf(req));
    });

    // Unlocking a locked session (0.9.0-dev.86): a credential given again,
    // as confirming it's you takes, counted and refused as that is.
    app.post('/api/v1/auth/unlock', { preHandler: app.requireAuth }, async (req) => {
      const body = parse(credentialBody, req.body);
      return stepUp.unlock(req.principal as Principal, credentialOf(body), metaOf(req));
    });

    // A code texted to confirm it's them (SMS3): a few a minute, on top of
    // the limits a number and an account have of their own.
    app.post(
      '/api/v1/auth/step-up/text',
      { preHandler: app.requireAuth, ...tight },
      async (req, reply) => {
        void reply.headers({ 'cache-control': 'no-store' });
        return stepUp.sendTextCode(req.principal as Principal);
      },
    );
  }

  if (passkeys) {
    // Signing in. Both are public: the whole point is that they work
    // before there is a session.
    app.post('/api/v1/auth/passkey/challenge', tight, async (req) => {
      const body = parse(
        z.object({ email: z.string().trim().toLowerCase().email().optional() }).default({}),
        req.body ?? {},
      );
      return passkeys.startAuthentication(body.email);
    });

    app.post('/api/v1/auth/passkey/verify', tight, async (req) => {
      const body = parse(z.object({ response: z.record(z.string(), z.unknown()) }), req.body);
      return passkeys.finishAuthentication(body.response as never, metaOf(req));
    });

    // Managing your own passkeys, which needs a session you already have.
    const auth_ = { preHandler: app.requireAuth };

    app.get('/api/v1/auth/passkeys', auth_, async (req) => ({
      items: await passkeys.list(req.principal as Principal),
    }));

    app.post('/api/v1/auth/passkeys/challenge', auth_, async (req) => {
      await stepUp?.require(req.principal as Principal, 'change_sign_in');
      return passkeys.startRegistration(req.principal as Principal);
    });

    app.post('/api/v1/auth/passkeys', auth_, async (req, reply) => {
      await stepUp?.require(req.principal as Principal, 'change_sign_in');
      const body = parse(
        z.object({
          response: z.record(z.string(), z.unknown()),
          label: z.string().trim().max(60).nullable().optional(),
        }),
        req.body,
      );
      const created = await passkeys.finishRegistration(
        req.principal as Principal,
        body.response as never,
        body.label ?? null,
        metaOf(req),
      );
      return reply.status(201).send(created);
    });

    app.delete<{ Params: { id: string } }>(
      '/api/v1/auth/passkeys/:id',
      auth_,
      async (req, reply) => {
        await stepUp?.require(req.principal as Principal, 'change_sign_in');
        await passkeys.remove(
          req.principal as Principal,
          parse(z.string().uuid(), req.params.id),
          metaOf(req),
        );
        return reply.status(204).send();
      },
    );
  }

  if (totp) {
    app.post('/api/v1/auth/totp/enrol', { preHandler: app.requireAuth }, async (req) => {
      const p = req.principal as Principal;
      // Otherwise a borrowed session could add its own authenticator, then
      // pass every later step-up with it — and set a new password.
      await stepUp?.require(p, 'change_sign_in');
      const email = await auth.emailOf(p.accountId);
      return totp.enrol(p, email, metaOf(req));
    });
    app.post('/api/v1/auth/totp/confirm', { preHandler: app.requireAuth }, async (req, reply) => {
      await stepUp?.require(req.principal as Principal, 'change_sign_in');
      const body = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
      await totp.confirm(req.principal as Principal, body.code, metaOf(req));
      return reply.status(204).send();
    });
    app.post('/api/v1/auth/totp/disable', { preHandler: app.requireAuth }, async (req, reply) => {
      const body = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
      await totp.disable(req.principal as Principal, body.code, metaOf(req));
      return reply.status(204).send();
    });
  }

  if (textCodes) {
    // Codes by text to one's own number (0.9.0, SMS3): whether a reset and
    // a sign-in ask for one. Each person's own; changing either is changing
    // how they sign in, so confirmed it's them first.
    app.get('/api/v1/auth/text-codes', { preHandler: app.requireAuth }, async (req, reply) => {
      void reply.headers({ 'cache-control': 'no-store' });
      return textCodes.settings(req.principal as Principal);
    });
    app.put('/api/v1/auth/text-codes', { preHandler: app.requireAuth }, async (req, reply) => {
      const body = parse(
        z.object({ sign_in: z.boolean().optional(), reset: z.boolean().optional() }).strict(),
        req.body ?? {},
      );
      await stepUp?.require(req.principal as Principal, 'change_sign_in');
      void reply.headers({ 'cache-control': 'no-store' });
      return textCodes.set(req.principal as Principal, body, metaOf(req));
    });
  }

  if (!passwords) return;

  // Changing one while signed in. Not rate-limited beyond the global
  // ceiling: it already takes either the current password or a step-up.
  app.post('/api/v1/auth/password/change', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = req.principal as Principal;
    const body = parse(changeBody, req.body);
    const meta = metaOf(req);
    // A current password tried is counted per session (0.9.0), as
    // confirming it's you is, and reserved before it is checked.
    const guard = auth.guard;
    const attempt =
      guard && body.current_password
        ? await guard.begin(guard.subjectOfSession(p.sessionId))
        : null;
    try {
      await passwords.change(p, body, meta);
      if (guard && attempt) await guard.succeeded(attempt);
    } catch (err) {
      if (guard && attempt && err instanceof ApiError && err.code === 'invalid_credentials') {
        await guard.failed(attempt, p.accountId, 'password', meta, 'step_up');
      }
      throw err;
    } finally {
      if (guard && attempt) await guard.release(attempt);
    }
    return reply.status(204).send();
  });

  // And the three for somebody who cannot sign in at all.
  app.post('/api/v1/auth/password/forgot', tight, async (req, reply) => {
    const address = parse(forgotBody, req.body).email;
    // Answered after the same time whatever the address (0.9.0): the work
    // goes on beside the wait, and is not waited for beyond it.
    const answer = new Promise<void>((resolve) => setTimeout(resolve, FORGOT_ANSWER_MS));
    void passwords.forgot(address, metaOf(req)).catch((err: unknown) => {
      req.log.error({ err }, 'a forgotten password could not be answered');
    });
    await answer;
    // Always the same answer. Whether the address is known is not this
    // endpoint's news to give.
    return reply.status(202).send({
      message: 'If that address has a sign-in here, a link is on its way to it.',
    });
  });

  // A link's token in a body, never a path (5.17). A link reads
  // /reset#<token>, and no server is sent what follows the #; the page
  // reads it and posts it here. The same answers and refusals as the path
  // forms below, and the same limit.
  app.post(
    '/api/v1/password-resets/lookup',
    tight,
    async (req) =>
      passwords.preview(parse(lookupBody, req.body ?? {}).token) satisfies Promise<ResetPreview>,
  );

  app.post('/api/v1/password-resets/complete', tight, async (req, reply) => {
    const body = parse(completeBody, req.body ?? {});
    const { email } = await passwords.reset(body.token, body.password, metaOf(req), body.code);
    await auth.failuresCleared(email);
    // No session, as below.
    return reply.status(200).send({ email });
  });

  // The code that finishes a reset, texted (0.9.0, SMS3): for a live link
  // of somebody who asked for one, to their own confirmed number. The link
  // is not spent.
  app.post('/api/v1/password-resets/code', tight, async (req, reply) => {
    const { token } = parse(lookupBody, req.body ?? {});
    void reply.headers({ 'cache-control': 'no-store' });
    return passwords.sendResetCode(token);
  });

  // The path forms, which links made before 0.5.17 (/reset/<token>) were
  // looked up and spent with. They keep working — a reset link lives an
  // hour — and are listed in the capability document's `deprecations`, to
  // go in 0.9.0.
  app.get<{ Params: { token: string } }>('/api/v1/password-resets/:token', tight, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(16).max(256) }), req.params);
    return passwords.preview(token) satisfies Promise<ResetPreview>;
  });

  app.post<{ Params: { token: string } }>(
    '/api/v1/password-resets/:token',
    tight,
    async (req, reply) => {
      const { token } = parse(z.object({ token: z.string().min(16).max(256) }), req.params);
      const { email } = await passwords.reset(
        token,
        parse(resetBody, req.body).password,
        metaOf(req),
      );
      await auth.failuresCleared(email);
      // No session handed back on purpose: an account with two-step
      // sign-in must still be asked for its code, and a reset that
      // returned a session would walk straight past it.
      return reply.status(200).send({ email });
    },
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<void>;
  }
}
