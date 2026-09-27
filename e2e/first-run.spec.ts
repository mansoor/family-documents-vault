import { expect, test } from '@playwright/test';

/**
 * The Phase 1 proof, end to end, on the real stack: set up a household,
 * add a document, fill the confirm card, find it by search, download it.
 * Runs once against a fresh database; a second run signs in instead.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

test('first run to first document', async ({ page }) => {
  await page.goto('/');

  // Either the wizard (fresh database) or sign-in (re-run).
  const wizard = page.getByRole('heading', { name: /Set up your family/ });
  const welcome = page.getByRole('heading', { name: /Every important paper/ });
  await expect(wizard.or(welcome)).toBeVisible();

  if (await wizard.isVisible()) {
    await page.getByLabel(/call your family/).fill('The E2E family');
    await page.getByLabel('Your name').fill('Mansoor');
    await page.getByLabel('Your email').fill(EMAIL);
    await page.getByLabel('Choose a password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create my vault' }).click();

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
    await page.getByRole('button', { name: 'Sign in' }).click();
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
