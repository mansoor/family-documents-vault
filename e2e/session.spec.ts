import { expect, test, type Request } from '@playwright/test';

/**
 * A reload is not a sign-out.
 *
 * Settings loads four panels at once, and after a reload none of them has
 * an access token. Until 0.4.3 each asked for one on its own; the vault
 * saw one refresh token presented four times, took it as stolen and ended
 * the session. This runs after first-run.spec.ts, on the vault it made.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

test('reloading Settings keeps you signed in, with one refresh', async ({ page, request }) => {
  const caps = (await (await request.get('/api/v1/capabilities')).json()) as {
    setup_required: boolean;
  };
  if (caps.setup_required) {
    await request.post('/api/v1/setup', {
      data: {
        household_name: 'The E2E family',
        display_name: 'Mansoor',
        email: EMAIL,
        password: PASSWORD,
      },
    });
  }

  // Signed in through the page, the one sign-in this file makes. Signing
  // in is limited to 10 a minute, and the suite signs in up to ten times
  // a run: once in each file, first-run.spec.ts only when it is run again.
  // So wait a minute between local runs.
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  // The sign-in page's heading is the household's name too, so wait for
  // the sign-in itself, not for a heading.
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password') && r.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // Asked for from here on: the reload's, not one /settings may still be
  // waiting for.
  const refreshes: Request[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/v1/auth/refresh')) refreshes.push(r);
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(refreshes).toHaveLength(1);
  // And it worked: one refused (429, too many a minute) would leave the
  // page offline, still showing Settings, proving nothing.
  expect((await refreshes[0]?.response())?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe('/settings');
  // And the session still works for whatever comes next.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Add a document' })).toBeVisible();
});
