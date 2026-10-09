import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The wide layouts (Phase 6, R5), on the real stack at 1280 × 800: the
 * shell's sidebar and `/`, the Documents table's sort and an action on
 * many, a document's two panes, and a batch of two files accepted through
 * the review queue. One file, one sign-in (signing in is limited to 10 a
 * minute, and the suite signs in once in each file), on the vault
 * first-run.spec.ts made; what it makes has this run's name on it.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';
const run = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });
let page: Page;
let token: string;

/** A PDF of its own: the vault would call the same bytes twice a duplicate. */
const pdf = (n: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${run} ${n}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

async function signIn(p: Page, request: APIRequestContext): Promise<string> {
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
  await p.goto('/welcome');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByLabel('Email').fill(EMAIL);
  await p.getByLabel('Password').fill(PASSWORD);
  const [signedIn] = await Promise.all([
    p.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password') && r.ok()),
    p.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await expect(p).toHaveURL(/\/$/);
  return ((await signedIn.json()) as { access_token: string }).access_token;
}

test.beforeAll(async ({ browser, request }) => {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  token = await signIn(page, request);
});

test.afterAll(async () => {
  await page.close();
});

test('the sidebar names each section, and / goes to the search box, every key kept', async () => {
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections).toBeVisible();
  // Wide, there is no phone bar at the bottom.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await sections.getByRole('link', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
  await expect(sections.getByRole('link', { name: 'Documents' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page).toHaveTitle('Documents – Family Document Vault');

  // `/` from the page: the search box on top, and Enter searches.
  await page.getByRole('heading', { name: 'Documents', level: 1 }).focus();
  await page.keyboard.press('/');
  const box = page.getByRole('searchbox', { name: 'Search the vault' });
  await expect(box).toBeFocused();
  await page.keyboard.type('passport');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=passport$/);
  // Typed on, as fast as keys come: none is lost (R5).
  const field = page.getByLabel('Search everything');
  await field.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(' renewal letter', { delay: 0 });
  await expect(field).toHaveValue('passport renewal letter');
  await expect(page).toHaveURL(/q=passport\+renewal\+letter$/);

  // `n`, from anywhere but a field: Add, a menu since many documents can be
  // added at once.
  await sections.getByRole('link', { name: 'Home' }).focus();
  await page.keyboard.press('n');
  await expect(page.getByRole('button', { name: 'Add' })).toBeFocused();
});

test('the Documents table sorts by a column, and moves two chosen to the Trash', async () => {
  const tag = `r5${run}`;
  for (const title of [`R5 table A ${run}`, `R5 table B ${run}`]) {
    const made = await page.request.post('/api/v1/documents', {
      headers: { authorization: `Bearer ${token}` },
      data: { title, visibility: 'household', tags: [tag] },
    });
    expect(made.ok()).toBe(true);
  }
  await page.goto(`/documents?tag=${tag}`);
  const grid = page.getByRole('grid', { name: /^Documents, sorted by Title/ });
  const titles = grid.locator('tbody .cell-title');
  await expect(titles).toHaveText([`R5 table A ${run}`, `R5 table B ${run}`]);
  // The Title column, pressed: Z to A, said on its header and kept in the address.
  await grid.getByRole('button', { name: /^Title/ }).click();
  await expect(titles).toHaveText([`R5 table B ${run}`, `R5 table A ${run}`]);
  await expect(grid.getByRole('columnheader', { name: /^Title/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await expect(page).toHaveURL(/dir=desc/);

  // Both chosen, then one action for both.
  await grid.getByRole('checkbox', { name: `Select “R5 table A ${run}”` }).check();
  await grid.getByRole('checkbox', { name: `Select “R5 table B ${run}”` }).check();
  const bar = page.getByRole('region', { name: 'What to do with the chosen documents' });
  await bar.getByRole('button', { name: 'Move to the Trash' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Move 2 documents to the Trash?' });
  await dialog.getByRole('button', { name: 'Move to the Trash' }).click();
  await expect(
    page.getByText('2 documents moved to the Trash. You can bring them back from there.'),
  ).toBeVisible();
  await expect(titles).toHaveCount(0);
});

test('a document opens in two panes: its details on the left, its pages on the right', async () => {
  await page.goto('/documents');
  await page.getByRole('link', { name: "Mansoor's passport" }).first().click();
  const details = page.getByRole('region', { name: "Details of Mansoor's passport" });
  const pages = page.getByRole('region', { name: "Pages of Mansoor's passport" });
  await expect(details).toBeVisible();
  await expect(pages).toBeVisible();
  const left = await details.boundingBox();
  const right = await pages.boundingBox();
  expect(left && right && left.x + left.width <= right.x).toBe(true);
  expect(left && right && Math.abs(left.y - right.y) < 40).toBe(true);
  await expect(page).toHaveTitle('A document – Family Document Vault');
  // Back is where it was opened from: the table.
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole('link', { name: "Mansoor's passport" }).first()).toBeFocused();
});

test('two files added at once are accepted one after the other through the queue', async () => {
  // Add, with the keyboard: n, down, Many documents.
  await page.goto('/');
  await page.getByRole('heading', { level: 1 }).focus();
  await page.keyboard.press('n');
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Add' });
  await menu.getByRole('menuitem', { name: /^Many documents/ }).click();
  await expect(page.getByRole('heading', { name: 'Add many documents', level: 1 })).toBeVisible();
  await page.getByLabel('Choose files').setInputFiles([
    { name: `r5-first-${run}.pdf`, mimeType: 'application/pdf', buffer: pdf('first') },
    { name: `r5-second-${run}.pdf`, mimeType: 'application/pdf', buffer: pdf('second') },
  ]);
  await page.getByLabel('Name this batch').fill(`R5 batch ${run}`);
  await page.getByRole('button', { name: 'Start: upload 2 files' }).click();
  await expect(page.getByText(`2 files arrived in “R5 batch ${run}”.`)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('link', { name: 'Open the batch' }).click();

  // The queue: the first file's Accept opens its card, and Accept and next
  // takes each in turn.
  await page.getByRole('link', { name: `Accept r5-first-${run}.pdf` }).click();
  for (const name of [`r5-first-${run}.pdf`, `r5-second-${run}.pdf`]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /^Accept and next/ }).click();
  }
  // Both are documents now: none of the batch waits.
  await expect(page.getByRole('link', { name: `Accept r5-first-${run}.pdf` })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Accept r5-second-${run}.pdf` })).toHaveCount(0);
});
