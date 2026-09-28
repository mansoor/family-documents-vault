import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Collections on the web (5.15), on the real stack: a collection is made with who it
 * is for, found from Home; a search result goes into it from its ⋯, and two
 * go in at once with Select; one comes out, which asks first; the collection is
 * renamed, and deleted. Runs on the vault first-run.spec.ts made, with
 * documents and a collection of its own, which go at the end.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

/**
 * Signed in through the page, once for this file. Signing in is limited to
 * 10 a minute, and the suite signs in up to nine times a run: once in each
 * file, first-run.spec.ts only when it is run again. So wait a minute
 * between local runs. The access token it was given too, to make this
 * file's documents and to tidy up after it.
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

// One page, signed in once, for every test here: one after the other.
test.describe.configure({ mode: 'serial' });
const run = Date.now().toString(36);
const COLLECTION = `Trip ${run}`;
const PASS = `Boarding pass ${run}`;
const HOTEL = `Hotel booking ${run}`;
let page: Page;
let token: string;
let collectionId = '';
const made: string[] = [];

test.beforeAll(async ({ browser, request }) => {
  page = await browser.newPage();
  token = await signIn(page, request);
  for (const title of [PASS, HOTEL]) {
    const doc = await request.post('/api/v1/documents', {
      headers: { authorization: `Bearer ${token}` },
      data: { title, visibility: 'household' },
    });
    expect(doc.ok()).toBe(true);
    made.push(((await doc.json()) as { id: string }).id);
  }
});

test.afterAll(async ({ request }) => {
  // Whatever the tests left: the collection (if it is still there) and the documents.
  const headers = { authorization: `Bearer ${token}` };
  if (collectionId) await request.delete(`/api/v1/collections/${collectionId}`, { headers });
  for (const id of made) await request.delete(`/api/v1/documents/${id}`, { headers });
  await page.close();
});

/**
 * The search screen, with `words` in the field and their results on it.
 * Until they come it collections everything, which goes when they do: a row
 * pressed there, its sheet open, would go with it.
 */
async function search(words: string) {
  await page.getByRole('link', { name: 'Search' }).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/search?') && r.ok()),
    page.getByLabel('Search everything').fill(words),
  ]);
  await expect(page.getByText(/searched inside the pages too$/)).toBeVisible();
}

test('a collection is made from Home, and a search result goes into it from its ⋯', async () => {
  // Home is the way to the collections: a tile for each, or one to make the first.
  await page
    .getByRole('link', { name: /^(All collections|Make a collection)/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Collections', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Make a collection' }).click();
  await page.getByLabel(/^Name/).fill(COLLECTION);

  // Who it is for is asked, never assumed, and said in words: only an
  // Everyone collection may ever be granted to a viewer.
  const who = page.getByRole('group', { name: 'Who it is for required' });
  await expect(who.getByRole('button', { pressed: true })).toHaveCount(0);
  const grant = page.getByText('Viewers see a collection only when it is granted to them.');
  await who.getByRole('button', { name: 'Everyone in the family' }).click();
  await expect(grant).toBeVisible();
  await who.getByRole('button', { name: 'Teens and up' }).click();
  await expect(
    page.getByText('The same people as Everyone in the family: owners, adults and teens.'),
  ).toBeVisible();
  await expect(grant).toHaveCount(0);
  await page.getByRole('button', { name: 'Make the collection' }).click();

  await expect(page.getByRole('heading', { name: COLLECTION, level: 1 })).toBeVisible();
  await expect(page.getByText(`“${COLLECTION}” is made.`, { exact: false })).toBeFocused();
  await expect(page.getByText('0 documents')).toBeVisible();
  collectionId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(collectionId).toMatch(/^[0-9a-f-]{36}$/);

  // A search result's ⋯ offers Add to a collection, once it has the document.
  await search(PASS);
  const more = page.getByRole('button', { name: `Actions for “${PASS}”` });
  await more.click();
  await page
    .getByRole('menu', { name: `Actions for “${PASS}”` })
    .getByRole('menuitem', { name: 'Add to a collection' })
    .click();
  const sheet = page.getByRole('dialog', { name: `Add “${PASS}” to a collection` });
  await sheet.getByRole('button', { name: `Add to “${COLLECTION}”` }).click();
  await expect(sheet.getByText(`“${PASS}” is in “${COLLECTION}” now.`)).toBeFocused();
  await expect(sheet.getByText('In this collection')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();
});

test('Select in search puts two in the collection at once', async ({ request }) => {
  await search(run);
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('checkbox', { name: `Select “${PASS}”` }).check();
  await page.getByRole('checkbox', { name: `Select “${HOTEL}”` }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Add to a collection' }).click();

  const sheet = page.getByRole('dialog', { name: 'Add 2 documents to a collection' });
  await sheet.getByRole('button', { name: `Add to “${COLLECTION}”` }).click();
  await expect(sheet.getByText(`2 documents added to “${COLLECTION}”.`)).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText(`2 documents added to “${COLLECTION}”.`)).toBeVisible();

  // Both are in it, once each: the boarding pass was in it already.
  const collection = await request.get(`/api/v1/collections/${collectionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(collection.ok()).toBe(true);
  const body = (await collection.json()) as {
    item_count: number;
    items: Array<{ document: { id: string } }>;
  };
  expect(body.item_count).toBe(2);
  expect(body.items.map((i) => i.document.id)).toEqual(made);
});

test('taking one out asks first; the collection is renamed, then deleted', async () => {
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: 'All collections' }).click();
  await page.getByRole('link', { name: new RegExp(`^${COLLECTION}`) }).click();
  await expect(page.getByRole('heading', { name: COLLECTION, level: 1 })).toBeVisible();
  await expect(page.getByText('2 documents')).toBeVisible();

  // Asked first, in the app's own dialog, which starts on Cancel.
  const more = page.getByRole('button', { name: `Actions for “${PASS}”` });
  const menu = page.getByRole('menu', { name: `Actions for “${PASS}”` });
  await more.click();
  await menu.getByRole('menuitem', { name: 'Take out of this collection' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Take it out of this collection?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('2 documents')).toBeVisible();

  await more.click();
  await menu.getByRole('menuitem', { name: 'Take out of this collection' }).click();
  await dialog.getByRole('button', { name: 'Take it out' }).click();
  await expect(more).toHaveCount(0);
  await expect(page.getByText('1 document', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Actions for “${HOTEL}”` })).toBeVisible();

  // Renamed, by its maker.
  const renamed = `${COLLECTION} (Lisbon)`;
  await page.getByRole('button', { name: `Edit “${COLLECTION}”` }).click();
  await page.getByLabel(/^Name/).fill(renamed);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: renamed, level: 1 })).toBeVisible();

  // Deleted, which asks first too; the documents stay.
  await page.getByRole('button', { name: 'Delete this collection' }).click();
  const sure = page.getByRole('alertdialog', { name: 'Delete this collection?' });
  await sure.getByRole('button', { name: 'Delete the collection' }).click();
  await expect(page).toHaveURL(/\/collections$/);
  await expect(
    page.getByText(`The collection “${renamed}” is deleted. Its documents are still in the vault.`),
  ).toBeFocused();
  await expect(page.getByRole('link', { name: new RegExp(`^${COLLECTION}`) })).toHaveCount(0);
  collectionId = '';
});
