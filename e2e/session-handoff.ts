import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

/**
 * A signed-in session handed from one spec to the next (5.16b). Signing in
 * is limited to 10 a minute, and the suite keeps to five sign-ins a run, so
 * two runs back to back stay within it: a spec with nothing to prove about
 * signing in takes over the session the spec before it made, instead of
 * signing in again. The session is its refresh token, as the web app keeps
 * it, and only one page ever holds it: the vault ends a session whose
 * refresh token is presented twice. It waits in the run's output folder,
 * which Playwright empties as each run starts.
 */

const file = (info: TestInfo) => join(info.project.outputDir, '.handoff', 'session.json');

/** Leaves the page's session for the next spec, as its page closes. */
export async function handOver(page: Page, info: TestInfo): Promise<void> {
  const session = await page.evaluate(() => localStorage.getItem('fdv.session')).catch(() => null);
  if (!session) return;
  mkdirSync(dirname(file(info)), { recursive: true });
  writeFileSync(file(info), session);
}

/**
 * The session the spec before left, taken over in `page`, which opens Home
 * with it: the access token its refresh gave, or null when none was left
 * or it has ended — then the spec signs in itself.
 */
export async function takeOver(page: Page, info: TestInfo): Promise<string | null> {
  let session: string;
  try {
    session = readFileSync(file(info), 'utf8');
    rmSync(file(info));
  } catch {
    return null;
  }
  await page.goto('/welcome');
  await page.evaluate((s) => localStorage.setItem('fdv.session', s), session);
  const [refreshed] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/refresh')),
    page.goto('/'),
  ]);
  if (!refreshed.ok()) return null;
  return ((await refreshed.json()) as { access_token: string }).access_token;
}
