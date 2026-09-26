import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The card asks for a type's details (5.10), on the real stack: a car added
 * with its registration plate and VIN is found by its VIN; a note on an
 * Only me document is sealed as it is written, so the search index never
 * has it and only its owner's private search finds it. Runs on the vault
 * first-run.spec.ts made; each run adds documents of its own.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

/**
 * Signed in through the page, once (sign-in is limited to 10 a minute, and
 * the specs before this one sign in too); the access token it was given
 * too, to ask the API what it holds.
 */
async function signIn(page: Page, request: APIRequestContext): Promise<string> {
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
  const [signedIn] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password') && r.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await expect(page).toHaveURL(/\/$/);
  return ((await signedIn.json()) as { access_token: string }).access_token;
}

/** The Add card, with a file chosen. */
async function addCard(page: Page, filename: string) {
  await page.getByRole('link', { name: 'Add a document' }).click();
  await expect(page.getByRole('heading', { name: 'Add a document' })).toBeVisible();
  await page.getByLabel('Choose a file').setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expect(page.getByRole('heading', { name: 'Is this right?' })).toBeVisible();
}

test('a car added with its plate and VIN is found by its VIN', async ({ page, request }) => {
  await signIn(page, request);
  const run = Date.now().toString(36).toUpperCase();
  const vin = `WVWZZZ1KZ${run}`;
  const title = `The Golf ${run}`;

  await addCard(page, 'car.pdf');
  await page.getByLabel('What it is').selectOption('vehicle_registration');
  // The plate is required (A9): Save waits, and says what for.
  const plate = page.getByLabel(/^Registration plate/);
  await expect(plate).toHaveAttribute('aria-required', 'true');
  await page.getByRole('button', { name: 'Save to the vault' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Still needed: Registration plate. Fill it in, or skip for now.',
  );
  await expect(plate).toBeFocused();

  await plate.fill('KX19 ZLT');
  await page.getByLabel('VIN', { exact: true }).fill(vin);
  await page.getByLabel('Name', { exact: true }).fill(title);
  await page.getByLabel('Expires').fill('Mar 2031');
  await page.getByRole('button', { name: 'Save to the vault' }).click();

  // Its page lists them in the type's own words, and it needs nothing.
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const facts = page.locator('dl.facts');
  await expect(facts.getByText('Registration plate')).toBeVisible();
  await expect(facts.getByText('KX19 ZLT')).toBeVisible();
  await expect(facts.getByText(vin)).toBeVisible();
  await expect(page.getByText('Needs a registration plate')).toHaveCount(0);

  // Found by its VIN.
  await page.getByRole('link', { name: 'Search' }).click();
  await page.getByLabel('Search everything').fill(vin);
  await expect(page.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible();
});

test('an Only me note is found only through its owner’s private search', async ({
  page,
  request,
}) => {
  const token = await signIn(page, request);
  const word = `kestrel${Date.now().toString(36)}`;
  const title = `Notes on the flat ${word.slice(-6)}`;

  await addCard(page, 'flat.pdf');
  await page.getByLabel('Name', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Only me' }).click();
  await page.getByLabel('Notes').fill(`Ask the agent about the ${word}\nbefore the lease ends`);
  await page.getByRole('button', { name: 'Save to the vault' }).click();

  // The note as it was written, its line break kept.
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const note = page
    .locator('section', { has: page.getByRole('heading', { name: 'Notes' }) })
    .locator('p');
  await expect(note).toHaveText(`Ask the agent about the ${word} before the lease ends`);
  expect(await note.innerText()).toBe(`Ask the agent about the ${word}\nbefore the lease ends`);

  // Sealed as it was written: the search index has no word of it…
  const indexed = await request.get(`/api/v1/search?q=${word}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(indexed.ok()).toBe(true);
  const first = (await indexed.json()) as {
    items: Array<{ title: string | null }>;
    sealed_pending: { count: number };
  };
  expect(first.items.map((h) => h.title)).not.toContain(title);
  expect(first.sealed_pending.count).toBeGreaterThan(0);

  // …and only the owner's own second pass finds it: once, under its heading.
  await page.getByRole('link', { name: 'Search' }).click();
  await page.getByLabel('Search everything').fill(word);
  await expect(page.getByRole('heading', { name: 'Also in your private documents' })).toBeVisible();
  const row = { name: new RegExp(`^${title}`) };
  const privateHits = page.locator('h2:has-text("Also in your private documents") + p + ul');
  await expect(privateHits.getByRole('button', row)).toBeVisible();
  await expect(page.getByRole('button', row)).toHaveCount(1);
});
