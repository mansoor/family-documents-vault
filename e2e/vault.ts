import { createHmac } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { APIRequestContext, Page, Response } from '@playwright/test';

/**
 * The setup code first-run setup asks for (0.9.0): FDV_SETUP_TOKEN, from
 * the environment or from the .env that scripts/gen-env.mjs wrote (as CI's
 * stack has it). Empty when neither has one: then the code is only in the
 * API's log, and setting up from here fails, as it should.
 */
export function setupCode(): string {
  if (process.env.FDV_SETUP_TOKEN) return process.env.FDV_SETUP_TOKEN.trim();
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return /^FDV_SETUP_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * The owner's two-step sign-in in these runs (0.9.0): an authenticator app's
 * key, set up by first-run.spec.ts and kept beside the repository for the
 * specs after it, scripts/ci-restore.sh and a later run. A passkey would not
 * do here: it lives in one browser, and some specs (and the restore drill)
 * sign in without one.
 */
const OWNER_KEY_FILE = new URL('../.e2e-owner-totp', import.meta.url);
/**
 * The time step (30 s) of the last code given, beside the key: the vault
 * takes each code once (0.9.0), so the next sign-in — another spec's, or
 * scripts/ci-restore.sh's — gives a later one.
 */
const OWNER_STEP_FILE = new URL('../.e2e-owner-totp-step', import.meta.url);

export function keepOwnerKey(secret: string): void {
  writeFileSync(OWNER_KEY_FILE, `${secret.trim()}\n`);
  // A new key's codes are counted afresh.
  rmSync(OWNER_STEP_FILE, { force: true });
}

/**
 * A code the vault has not taken yet (0.9.0): of the step after the last
 * one given, if it is no later than the next step (the vault takes a code a
 * step either side of now); otherwise waited for, 30 seconds at most.
 */
export async function freshTotpCode(secret: string): Promise<string> {
  const now = () => Math.floor(Date.now() / 30_000);
  let last: number;
  try {
    last = Number(readFileSync(OWNER_STEP_FILE, 'utf8').trim());
  } catch {
    last = -1;
  }
  const want = Math.max(now(), Number.isFinite(last) ? last + 1 : now());
  while (want > now() + 1) await new Promise((resolve) => setTimeout(resolve, 1000));
  writeFileSync(OWNER_STEP_FILE, `${want}\n`);
  return totpCode(secret, want * 30_000);
}

export function ownerKey(): string {
  if (process.env.FDV_E2E_TOTP_SECRET) return process.env.FDV_E2E_TOTP_SECRET.trim();
  return readFileSync(OWNER_KEY_FILE, 'utf8').trim();
}

/** The six-digit code an authenticator app shows now for a base32 key (RFC 6238). */
export function totpCode(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = (h[h.length - 1] as number) & 0xf;
  const n =
    (((h[o] as number) & 0x7f) << 24) |
    ((h[o + 1] as number) << 16) |
    ((h[o + 2] as number) << 8) |
    (h[o + 3] as number);
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * After the password, in the page: the second step the vault asks for, the
 * owner's code, and the access token that opens. `answer` is the password's
 * response; with no second step asked, its own token.
 */
export async function finishSignIn(page: Page, answer: Response): Promise<string> {
  const body = (await answer.json()) as { access_token?: string; mfa_required?: boolean };
  if (body.access_token) return body.access_token;
  await page.getByLabel('Code', { exact: true }).fill(await freshTotpCode(ownerKey()));
  const [done] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/mfa') && r.ok()),
    page.getByRole('button', { name: 'Continue' }).click(),
  ]);
  return ((await done.json()) as { access_token: string }).access_token;
}

/** The owner signed in through the API, password and code: the access token. */
export async function ownerToken(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const res = await request.post('/api/v1/auth/password', { data: { email, password } });
  if (!res.ok()) throw new Error(`signing in failed: ${res.status()}`);
  const body = (await res.json()) as { access_token?: string; mfa_token?: string };
  if (body.access_token) return body.access_token;
  const second = await request.post('/api/v1/auth/mfa', {
    data: { mfa_token: body.mfa_token, code: await freshTotpCode(ownerKey()) },
  });
  if (!second.ok()) throw new Error(`the second step failed: ${second.status()}`);
  return ((await second.json()) as { access_token: string }).access_token;
}
