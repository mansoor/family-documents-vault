import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * The wide layouts (Phase 6, R5), on the real stack at 1280 × 800: the
 * shell's sidebar and `/`, the sidebar folded and opened on hover, the
 * Documents table's sort and an action on
 * many, a collection's Add documents (Phase 6), a document's two panes,
 * a batch of two files accepted through
 * the review queue, and a 15-year-old added with an invitation to sign up
 * (after 0.7.0). One file, one sign-in (signing in is limited to 10 a
 * minute, and the suite signs in once in each file), on the vault
 * first-run.spec.ts made; what it makes has this run's name on it.
 *
 * And no page loaded afresh once signed in: a load renews the sign-in with
 * the refresh token, and the vault renews ten a minute for one address —
 * the address every spec in the run shares. The eleventh was refused (429,
 * Retry-After 34 s) in CI on 9 Oct, after the phone specs, and the app,
 * without a token, said every list could not be loaded. Moving within the
 * app (`visit`) renews nothing.
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
  // The phone specs before this one signed in from this address too: when
  // the minute's ten are spent, the vault says when to try again, and that
  // is waited out (twice at most: a minute's window clears in one).
  for (let tries = 0; ; tries++) {
    const [answer] = await Promise.all([
      p.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password')),
      p.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    if (answer.status() === 429 && tries < 2) {
      const wait = Number(answer.headers()['retry-after'] ?? '60');
      await p.waitForTimeout((Math.min(wait, 60) + 1) * 1000);
      continue;
    }
    expect(answer.ok()).toBe(true);
    await expect(p).toHaveURL(/\/$/);
    return ((await answer.json()) as { access_token: string }).access_token;
  }
}

/** A page of the app, gone to from within it, as a link would: nothing loaded, nothing renewed. */
async function visit(p: Page, path: string) {
  // An entry as the app's router makes one, numbered after this one, so
  // that its Back (one step back, R5) counts as the router does. (Written
  // as the page's own script: these specs are typed without the DOM's.)
  await p.evaluate(`(() => {
    const idx = ((history.state && history.state.idx) || 0) + 1;
    const key = Math.random().toString(36).slice(2, 10);
    history.pushState({ usr: null, key, idx }, '', ${JSON.stringify(path)});
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  })()`);
  await expect.poll(() => p.evaluate<string>('location.pathname + location.search')).toBe(path);
}

test.beforeAll(async ({ browser, request }) => {
  test.setTimeout(180_000);
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

test('the sidebar folds to its icons, opens over the page while hovered, and opens again', async () => {
  await visit(page, '/');
  const sections = page.getByRole('navigation', { name: 'Sections' });
  const content = page.locator('#main-content');
  const widthOf = async (l: Locator) => Math.round((await l.boundingBox())?.width ?? 0);
  const leftOf = async (l: Locator) => Math.round((await l.boundingBox())?.x ?? 0);
  const topOf = async (l: Locator) => Math.round((await l.boundingBox())?.y ?? 0);
  // The bar on top across the window, the household's name in it and not
  // in the sidebar, which starts under it (0.7.0).
  const bar = page.getByRole('banner');
  await expect(bar).toHaveCount(1);
  expect(await leftOf(bar)).toBe(0);
  expect(await widthOf(bar)).toBe(
    await page.evaluate<number>('document.documentElement.clientWidth'),
  );
  const brand = bar.getByRole('link', { name: /Family Document Vault$/ });
  await expect(brand).toBeVisible();
  await expect(sections.getByText('Family Document Vault')).toHaveCount(0);
  expect(await topOf(sections)).toBe(64);
  const brandAt = await brand.boundingBox();
  // As wide as the household's name, between 209 and 360 px.
  expect(brandAt?.width).toBeGreaterThanOrEqual(209);
  expect(brandAt?.width).toBeLessThanOrEqual(360);
  const open = await widthOf(sections);
  await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
  const expand = page.getByRole('button', { name: 'Expand the sidebar' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(800, 400);
  await expect.poll(() => widthOf(sections)).toBe(72);
  await expect.poll(() => leftOf(content)).toBe(72);
  const left = await leftOf(content);
  // The household's name has not moved.
  expect(await brand.boundingBox()).toEqual(brandAt);

  // Hovered, after a moment: its names, over the page, the page where it was.
  await sections.hover();
  await expect.poll(() => widthOf(sections)).toBe(open);
  expect(await leftOf(content)).toBe(left);
  expect(await brand.boundingBox()).toEqual(brandAt);
  // Away from it, after a moment: folded again.
  await page.mouse.move(800, 400);
  await expect.poll(() => widthOf(sections)).toBe(72);

  await expand.click();
  await expect(page.getByRole('button', { name: 'Collapse the sidebar' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect.poll(() => leftOf(content)).toBe(open);
  expect(await brand.boundingBox()).toEqual(brandAt);
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
  await visit(page, `/documents?tag=${tag}`);
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

test("a collection's own page finds two documents by search and adds them", async () => {
  const auth = { authorization: `Bearer ${token}` };
  const word = `picker${run}`;
  for (const title of [`Picker one ${word}`, `Picker two ${word}`]) {
    const made = await page.request.post('/api/v1/documents', {
      headers: auth,
      data: { title, visibility: 'household' },
    });
    expect(made.ok()).toBe(true);
  }
  const collection = await page.request.post('/api/v1/collections', {
    headers: auth,
    data: { name: `Picker ${run}`, audience: 'everyone' },
  });
  expect(collection.ok()).toBe(true);
  const { id } = (await collection.json()) as { id: string };

  await visit(page, `/collections/${id}`);
  await page.getByRole('button', { name: 'Add documents' }).click();
  const picker = page.getByRole('dialog', { name: `Add documents to “Picker ${run}”` });
  await picker.getByLabel('Search').fill(word);
  const grid = picker.getByRole('grid');
  await expect(grid.locator('tbody .picker-title')).toHaveCount(2);
  await grid.getByRole('checkbox', { name: `Choose “Picker one ${word}”` }).check();
  await grid.getByRole('checkbox', { name: `Choose “Picker two ${word}”` }).check();
  await expect(picker.getByText('2 chosen')).toBeVisible();
  await picker.getByRole('button', { name: `Add 2 to “Picker ${run}”` }).click();

  await expect(picker).toHaveCount(0);
  await expect(page.getByText(`2 documents added to “Picker ${run}”.`)).toBeVisible();
  const inIt = page.getByRole('region', { name: 'In this collection' });
  await expect(inIt.getByRole('button', { name: new RegExp(`^Picker one ${word}`) })).toBeVisible();
  await expect(inIt.getByRole('button', { name: new RegExp(`^Picker two ${word}`) })).toBeVisible();
});

test('a document opens in two panes: its details on the left, its pages on the right', async () => {
  await visit(page, '/documents');
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
  await visit(page, '/');
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

  // The queue: the first file's card opens from its row — Accept for a Ready
  // file, Review for any other (these two PDFs have no pages to read) — and
  // Accept and next takes each in turn.
  await page
    .getByRole('link', { name: new RegExp(`^(Accept|Review) r5-first-${run}[.]pdf$`) })
    .click();
  for (const name of [`r5-first-${run}.pdf`, `r5-second-${run}.pdf`]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /^Accept and next/ }).click();
  }
  // Both are documents now: back on the queue, said so, and none of the
  // batch waits — Done counts both.
  await expect(page).toHaveURL(/\/inbox\/batches\/[^/?]+$/);
  await expect(page.getByText(/All 2 done: 2 accepted\./)).toBeVisible();
  await expect(page.getByText('Nothing left to check in this batch.')).toBeVisible();
  const levels = page.getByRole('group', { name: 'Show' });
  await expect(levels.getByRole('button', { name: /^Done\s*2$/ })).toBeVisible();
  await expect(levels.getByRole('button', { name: /^All\s*2$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^(Accept|Review) r5-/ })).toHaveCount(0);
});

test('a 15-year-old added with “Invite them to sign up now” ticked: the link and the code, once', async () => {
  // Fifteen on any calendar: born fifteen years and a month or so ago.
  const now = new Date();
  const dob = new Date(Date.UTC(now.getUTCFullYear() - 15, now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
  const name = `Teen ${run}`;
  const email = `teen-${run}@example.test`;
  await visit(page, '/people');
  await page.getByRole('button', { name: 'Add someone' }).click();
  await page.getByLabel('Name of another family member').fill(name);
  await page.getByLabel('Date of birth').fill(dob);
  const box = page.getByRole('checkbox', { name: 'Invite them to sign up now' });
  await expect(box).not.toBeChecked();
  await box.check();
  await page.getByLabel('Their email address').fill(email);
  // At fifteen, a teen's sign-in and nothing else.
  await expect(
    page.getByRole('group', { name: 'What they can do' }).getByRole('button'),
  ).toHaveText(['Teen']);
  // The form's Add, not the bar's.
  await page
    .locator('form')
    .filter({ has: page.getByLabel('Name of another family member') })
    .getByRole('button', { name: 'Add', exact: true })
    .click();
  // Inviting asks who is asking — unless this session proved it moments ago.
  const prompt = page.getByRole('dialog', { name: 'Just checking it is you' });
  const handed = page.getByRole('heading', { name: `Send these to ${name}` });
  await expect(prompt.or(handed)).toBeVisible();
  if (await prompt.isVisible()) {
    await prompt.getByLabel('Or your password').fill(PASSWORD);
    await prompt.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(handed).toBeVisible();
  await expect(handed).toBeFocused();
  await expect(page.locator('code').filter({ hasText: '/join#' })).toHaveText(/\/join#[\w-]{40,}$/);
  await expect(page.locator('code').filter({ hasText: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Email the link' })).toHaveAttribute(
    'href',
    /^mailto:teen-/,
  );
  await page.getByRole('button', { name: 'Done' }).click();
  // Waiting to be accepted, as a teen, at the address given.
  await expect(page.getByText(`Teen · ${email}`)).toBeVisible();
});
