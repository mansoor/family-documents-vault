import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Asking for documents (5.22), on the real stack: an owner makes a request
 * on the web — two things to send, a password the vault makes up — and the
 * hand-over gives the `/drop#` link and the password, once. In a second
 * browser, a stranger's, with no session and no cookies, the link opens a
 * page that takes the token out of the address, asks for the password, and
 * takes two files, one for each thing asked for; Finish sends them. Sharing
 * then says what the request has had, and it is taken back.
 *
 * The emailed code is not exercised: CI's stack has no operator mail
 * (FDV_SMTP_URL), so the form offers none. This runs after
 * first-run.spec.ts, on the vault it made.
 *
 * FDV_E2E_SHOTS names a folder to keep screenshots of the pages in.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';
const SHOTS = process.env.FDV_E2E_SHOTS;
/** Where the vault is, as playwright.config.ts says: the second browser starts there too. */
const BASE_URL = process.env.FDV_E2E_URL ?? 'http://localhost:8080';

const pdf = (words: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${words}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

/**
 * Signed in through the page, once for this file. Signing in is limited to
 * 10 a minute, and the suite signs in up to ten times a run: once in each
 * file, first-run.spec.ts only when it is run again. So wait a minute
 * between local runs.
 */
async function signIn(page: Page, request: APIRequestContext): Promise<void> {
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
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password') && r.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await expect(page).toHaveURL(/\/$/);
}

test('ask for documents, open the link in another browser, send two files, finish', async ({
  browser,
  request,
}) => {
  const run = Date.now().toString(36);
  const title = `Tax papers ${run}`;
  const page = await browser.newPage();
  await signIn(page, request);

  // The family's side: Sharing → Ask for documents.
  await page.goto('/settings/sharing');
  await page.getByRole('link', { name: 'Ask for documents' }).click();
  await expect(page.getByRole('heading', { name: 'What you are asking for' })).toBeVisible();
  await page.getByLabel(/^Title/).fill(title);
  await page.getByLabel('A message for them').fill('Everything for the 2025 return, please.');
  await page.getByLabel('Thing to send 1', { exact: true }).fill('W-2');
  await page.getByRole('button', { name: 'Add another' }).click();
  await page.getByLabel('Thing to send 2', { exact: true }).fill('1099');
  await page.getByLabel('Who is it for?').fill('Jane, accountant');
  await page.getByLabel(/ask for a password/).check();
  // No operator mail here: the code is offered disabled, with why.
  await expect(page.getByLabel(/email them a code/)).toBeDisabled();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-1-ask.png`, fullPage: true });
  await page.getByRole('button', { name: 'Make the link' }).click();

  // The link and the password, once.
  const handover = page.getByTestId('request-handover');
  await expect(
    handover.getByRole('heading', { name: 'The link for Jane, accountant' }),
  ).toBeVisible();
  const link = (await handover.locator('code').first().textContent()) ?? '';
  expect(link).toMatch(/\/drop#[A-Za-z0-9_-]{20,}$/);
  const password = (
    (await page.getByTestId('request-password').locator('code').textContent()) ?? ''
  ).trim();
  expect(password).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-2-handover.png`, fullPage: true });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Asking for documents' })).toBeVisible();
  await expect(page.getByText(password)).toHaveCount(0);

  // A stranger's browser: nothing of the family's, not even a cookie. The
  // link may start with the public-only site's address; the page is the
  // same wherever it is served, so it is opened here with its fragment.
  const fragment = new URL(link).hash;
  const stranger = await browser.newContext({ ...devices['Pixel 7'], baseURL: BASE_URL });
  const drop = await stranger.newPage();
  await drop.goto(`/drop${fragment}`);
  await expect(
    drop.getByRole('heading', { name: 'Send documents to The E2E family' }),
  ).toBeVisible();
  // The token is gone from the address bar before anything else happens.
  expect(drop.url()).not.toContain(fragment.slice(1));
  expect(new URL(drop.url()).pathname).toBe('/drop');
  // Before Open, nothing of what is asked for.
  await expect(drop.getByText(title)).toHaveCount(0);
  if (SHOTS) await drop.screenshot({ path: `${SHOTS}/e2e-3-drop-preview.png`, fullPage: true });

  await drop.getByLabel('The password they gave you').fill(password);
  await drop.getByRole('button', { name: 'Open' }).click();
  await expect(drop.getByRole('heading', { name: title })).toBeVisible();
  await expect(drop.getByText('Everything for the 2025 return, please.')).toBeVisible();

  // One file for each thing asked for.
  await drop.getByLabel('Choose files for W-2').setInputFiles({
    name: 'w2-2025.pdf',
    mimeType: 'application/pdf',
    buffer: pdf('W-2 2025'),
  });
  await expect(drop.getByRole('button', { name: 'Remove w2-2025.pdf' })).toBeVisible();
  await drop.getByLabel('Choose files for 1099').setInputFiles({
    name: '1099-int.pdf',
    mimeType: 'application/pdf',
    buffer: pdf('1099-INT 2025'),
  });
  await expect(drop.getByRole('button', { name: 'Remove 1099-int.pdf' })).toBeVisible();
  // A file the request does not take is refused, in plain words, and kept nowhere.
  await drop.getByLabel('Choose files for Anything else').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('just some text'),
  });
  await expect(drop.getByRole('region', { name: 'Anything else' }).getByRole('alert')).toHaveText(
    'That kind of file cannot be sent here. PDFs and photos are fine.',
  );
  await drop.getByRole('button', { name: 'Dismiss notes.txt' }).click();
  if (SHOTS) await drop.screenshot({ path: `${SHOTS}/e2e-4-drop-files.png`, fullPage: true });

  await drop.getByLabel(/A note for Mansoor/).fill('The 1099-DIV comes next week.');
  await drop.getByRole('button', { name: 'Finish and send 2 files' }).click();
  await expect(drop.getByRole('heading', { name: 'Sent' })).toBeVisible();
  await expect(drop.getByText('2 files went to Mansoor at The E2E family.')).toBeVisible();
  if (SHOTS) await drop.screenshot({ path: `${SHOTS}/e2e-5-drop-sent.png`, fullPage: true });

  // Sharing says what it has had, and it is taken back.
  await page.reload();
  const row = page
    .getByRole('list', { name: 'Requests that work now' })
    .getByRole('listitem')
    .filter({ hasText: title });
  await expect(row).toContainText('2 files received · Opened once');
  await row.getByRole('button', { name: /^Take back the request/ }).click();
  await page
    .getByRole('alertdialog', { name: 'Take this request back?' })
    .getByRole('button', { name: 'Take it back' })
    .click();
  await expect(page.getByText(/is taken back\. What was sent already stays\./)).toBeVisible();

  // The stranger's link opens nothing now.
  await drop.goto(`/drop${fragment}`);
  await expect(drop.getByRole('heading', { name: 'This link cannot be opened' })).toBeVisible();

  await stranger.close();
  await page.close();
});
