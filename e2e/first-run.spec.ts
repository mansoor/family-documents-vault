import { expect, test } from '@playwright/test';
import { finishSignIn, freshTotpCode, keepOwnerKey, setupCode } from './vault.js';

/**
 * The Phase 1 proof, end to end, on the real stack: set up a household,
 * add a document, fill the confirm card, find it by search, download it.
 * Runs once against a fresh database; a second run signs in instead.
 */

/**
 * A one-page PDF the worker can draw, so the document's pages are there for
 * the specs after this one (desktop's two panes) however long they take to
 * get to it: an empty PDF's pages are "could not be drawn" once the worker
 * has given up on it. Its words say nothing a reading would act on.
 */
function onePagePdf(): Buffer {
  const text = 'BT /F1 14 Tf 72 700 Td (A page for the end-to-end test.) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PDF = onePagePdf();
const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

test('first run to first document', async ({ page }) => {
  await page.goto('/');

  // Either the wizard (fresh database) or sign-in (re-run).
  const wizard = page.getByRole('heading', { name: /Set up your family/ });
  const welcome = page.getByRole('heading', { name: /Every important paper/ });
  await expect(wizard.or(welcome)).toBeVisible();

  if (await wizard.isVisible()) {
    // The setup code (0.9.0): only whoever can read the server's .env has it.
    await page.getByLabel('Setup code').fill(setupCode());
    await page.getByLabel(/call your family/).fill('The E2E family');
    await page.getByLabel('Your name').fill('Mansoor');
    await page.getByLabel('Your email').fill(EMAIL);
    await page.getByLabel('Choose a password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create my vault' }).click();

    // An owner sets up two-step sign-in before anything else (0.9.0): an
    // authenticator app here, its key kept for every later spec's sign-in
    // (and the restore drill's), which then asks for its code.
    await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
    await page.getByRole('button', { name: 'Set up two-step sign-in' }).click();
    const key = (await page.locator('code').first().textContent())?.trim() ?? '';
    expect(key).toMatch(/^[A-Z2-7]{16,}$/);
    keepOwnerKey(key);
    // Each code is taken once (0.9.0): the step it is of is kept, so the
    // next spec's sign-in gives a later one.
    await page.getByLabel('Code from the app').fill(await freshTotpCode(key));
    await page.getByRole('button', { name: 'Turn on' }).click();

    await expect(page.getByRole('heading', { name: 'A few quick questions' })).toBeVisible();
    await page.getByRole('button', { name: 'We own it' }).click();
    await page.getByRole('button', { name: '1', exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: 'Who is in the family?' })).toBeVisible();
    await page.getByLabel('Name of another family member').fill('Aisha');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Aisha')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: 'Your starting list' })).toBeVisible();
    await page.getByRole('button', { name: 'Look around first' }).click();
  } else {
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    const [signedIn] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password') && r.ok()),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    // The code from the key the first run kept (0.9.0).
    await finishSignIn(page, signedIn);
  }

  await expect(page.getByRole('heading', { name: 'The E2E family' })).toBeVisible();
  await expect(page.getByText(/Aisha/)).toBeVisible();

  // Add a document: the file input is hidden behind the button.
  await page.getByRole('link', { name: 'Add a document' }).click();
  await expect(page.getByRole('heading', { name: 'Add a document' })).toBeVisible();
  await page.getByLabel('Choose a file').setInputFiles({
    name: 'passport.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });

  // Confirm card.
  await expect(page.getByRole('heading', { name: 'Is this right?' })).toBeVisible();
  await page.getByLabel('What it is').selectOption('passport');
  await page.getByLabel('Name', { exact: true }).fill("Mansoor's passport");
  await page.getByLabel('Expires').fill('2031-03');
  await page.getByLabel('Number').fill('563914782');
  await page.getByLabel('Where the original is kept').fill('Bedroom safe, top shelf');
  await page.getByRole('button', { name: 'Save to the vault' }).click();

  // Document detail shows the facts and derived status.
  await expect(page.getByRole('heading', { name: "Mansoor's passport" })).toBeVisible();
  await expect(page.getByText('March 2031')).toBeVisible();
  await expect(page.getByText(/Valid for 4 years/)).toBeVisible();
  await expect(page.getByText('Bedroom safe, top shelf')).toBeVisible();

  // Download is byte-identical.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('passport.pdf');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).equals(PDF)).toBe(true);

  // Search finds it by number.
  await page.getByRole('link', { name: 'Search' }).click();
  await page.getByLabel('Search everything').fill('563914782');
  await expect(page.getByRole('button', { name: /Mansoor's passport/ }).first()).toBeVisible();

  // Home lists it under Identity.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('link', { name: /Identity/ })).toBeVisible();
});
