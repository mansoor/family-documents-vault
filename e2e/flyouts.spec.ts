import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { finishSignIn, setupCode } from './vault.js';

/**
 * Documents beside the list (flyouts), on the real stack at 1280 × 800: a
 * row of the Documents table opens its document over the list; Esc
 * minimises it to the tray; three open, one in front at a time, switched
 * from the tray; minimised 15 minutes (the page's clock, mocked), freed —
 * its icon kept; and a reload puts the tray back, the one in front opened
 * again and the rest freed. Then two side by side (from 1,100 px; the
 * window is 1280): one chosen from the list, replaced by a list click, and
 * back to one at a time.
 *
 * Signed in once, as desktop.spec.ts is, and loaded afresh once (the
 * reload): each load renews the sign-in, ten a minute for the address the
 * whole run shares.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';
const run = Date.now().toString(36);
const TITLES = ['A', 'B', 'C'].map((x) => `Flyout ${x} ${run}`);

test.describe.configure({ mode: 'serial' });
let page: Page;
let token: string;
const made: string[] = [];

async function signIn(p: Page, request: APIRequestContext): Promise<string> {
  const caps = (await (await request.get('/api/v1/capabilities')).json()) as {
    setup_required: boolean;
  };
  if (caps.setup_required) {
    await request.post('/api/v1/setup', {
      data: {
        setup_token: setupCode(),
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
  // The specs before this one signed in from this address too: when the
  // minute's ten are spent, the vault says when to try again, and that is
  // waited out (twice at most: a minute's window clears in one).
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
    const got = await finishSignIn(p, answer);
    await expect(p).toHaveURL(/\/$/);
    return got;
  }
}

/** A page of the app, gone to from within it, as a link would: nothing loaded, nothing renewed. */
async function visit(p: Page, path: string) {
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
  // The page's own clock, to move on 15 minutes: it runs as ever until then.
  await page.clock.install();
  token = await signIn(page, request);
  for (const title of TITLES) {
    const doc = await request.post('/api/v1/documents', {
      headers: { authorization: `Bearer ${token}` },
      data: { title, visibility: 'household', sensitive: false, tags: [`fly${run}`] },
    });
    expect(doc.ok()).toBe(true);
    made.push(((await doc.json()) as { id: string }).id);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of made) {
    await request.delete(`/api/v1/documents/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }
  await page.close();
});

const tray = () => page.getByRole('navigation', { name: 'Open documents' });
const flyout = (title: string) => page.getByRole('dialog', { name: title });
const [A, B, C] = TITLES as [string, string, string];

test('three open beside the list, minimised and switched, freed after 15 minutes, back after a reload', async () => {
  // The renewals below (the clock moved past the access token's life, and
  // the reload) may be told to wait by the vault's limit on renewals,
  // which the app waits out by itself: time for that.
  test.setTimeout(240_000);
  await visit(page, `/documents?tag=fly${run}`);
  const grid = page.getByRole('grid', { name: /^Documents, sorted by/ });
  await expect(grid.locator('tbody .cell-title')).toHaveCount(3);

  // Opened over the list, which stays: the address is the list's.
  await grid.getByRole('link', { name: A }).click();
  await expect(flyout(A)).toBeVisible();
  await expect(flyout(A).getByRole('heading', { name: A, level: 2 })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/documents\\?tag=fly${run}$`));
  await expect(grid).toBeVisible();

  // Esc minimises it to the tray, the focus back on its row.
  await page.keyboard.press('Escape');
  await expect(flyout(A)).toHaveCount(0);
  await expect(grid.getByRole('link', { name: A })).toBeFocused();
  await expect(tray().getByRole('button', { name: `${A}, minimised` })).toBeVisible();

  // Two more: one in front at a time, the one before it in the tray.
  await grid.getByRole('link', { name: B }).click();
  await expect(flyout(B)).toBeVisible();
  await grid.getByRole('link', { name: C }).click();
  await expect(flyout(C)).toBeVisible();
  await expect(flyout(B)).toHaveCount(0);
  await expect(tray().getByRole('listitem')).toHaveCount(3);

  // Switched from the tray.
  await tray()
    .getByRole('button', { name: `${A}, minimised` })
    .click();
  await expect(flyout(A)).toBeVisible();
  await expect(tray().getByRole('button', { name: `${C}, minimised` })).toBeVisible();
  // Its name on hover.
  await tray()
    .getByRole('button', { name: `${B}, minimised` })
    .hover();
  await expect(page.locator('.tray-tip')).toContainText(B);

  // Fifteen minutes on: the minimised ones are freed, their icons kept,
  // nothing of them left on the page; the one in front stays. The access
  // token has run out on the page's clock too: the next call renews it,
  // with the refresh cookie, as after any 15 minutes away.
  await page.clock.fastForward('16:00');
  await expect(
    tray().getByRole('button', { name: `${B}, freed to save memory, opens again when chosen` }),
  ).toBeVisible();
  await expect(tray().getByRole('button', { name: new RegExp(`^${C}, freed`) })).toBeVisible();
  await expect(page.locator(`[data-flyout="${made[1]}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-flyout="${made[2]}"]`)).toHaveCount(0);
  await expect(flyout(A)).toBeVisible();

  // A freed one opens again when chosen (its renewal first).
  await tray()
    .getByRole('button', { name: new RegExp(`^${B}, freed`) })
    .click();
  await expect(flyout(B)).toBeVisible({ timeout: 90_000 });
  await expect(page).toHaveURL(new RegExp(`/documents\\?tag=fly${run}$`));

  // A reload: the tray back, the one in front opened again, the rest freed
  // and not named until chosen (nothing of them is read to name them).
  await page.reload();
  await expect(flyout(B)).toBeVisible({ timeout: 90_000 });
  await expect(tray().getByRole('listitem')).toHaveCount(3);
  await expect(tray().getByRole('button', { name: /^A document, freed/ })).toHaveCount(2);
  await tray()
    .getByRole('button', { name: /^A document, freed/ })
    .first()
    .click();
  await expect(flyout(A)).toBeVisible();
  await expect(tray().getByRole('button', { name: `${A}, showing` })).toBeVisible();

  // Close all: nothing beside the list, and nothing kept for the next load.
  await tray().getByRole('button', { name: 'Close all' }).click();
  await expect(tray()).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await page.evaluate<string | null>(
      `sessionStorage.getItem('fdv.flyouts.' + JSON.parse(localStorage.getItem('fdv.session')).member_id)`,
    ),
  ).toBeNull();
});

/**
 * A title in the list clicked at its start: those side by side cover the
 * list but for its first 240 px, where every title begins, whatever its
 * length. Playwright still checks that nothing covers that point.
 */
async function atItsStart(link: Locator) {
  await link.scrollIntoViewIfNeeded();
  await link.click({ position: { x: 4, y: 6 } });
}

test('two side by side: the second from the list, the one used last replaced by a list click, then one at a time', async () => {
  await visit(page, `/documents?tag=fly${run}`);
  const grid = page.getByRole('grid', { name: /^Documents, sorted by/ });
  await expect(grid.locator('tbody .cell-title')).toHaveCount(3);
  await grid.getByRole('link', { name: A }).click();
  await expect(flyout(A)).toBeVisible();

  // Side by side, the second chosen from the list.
  await flyout(A).getByRole('button', { name: 'Side by side' }).click();
  const picker = page.getByRole('dialog', { name: 'Side by side' });
  await expect(picker).toContainText('No other documents are open.');
  await picker.getByRole('button', { name: 'Choose from the list' }).click();
  await expect(flyout(A).locator('.flyout-pick')).toContainText(
    'Choose a document in the list to show beside this one.',
  );
  await atItsStart(grid.getByRole('link', { name: B }));
  await expect(flyout(A)).toBeVisible();
  await expect(flyout(B)).toBeVisible();
  await expect(flyout(B).getByRole('heading', { name: B, level: 2 })).toBeFocused();
  await expect(page.locator('.flyout-pick')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/documents\\?tag=fly${run}$`));

  // Next to each other, A at the left, of equal widths; B, used last, has the green line.
  const panes = page.locator('.flyout-side');
  await expect(panes).toHaveCount(2);
  const [left, right] = [await flyout(A).boundingBox(), await flyout(B).boundingBox()];
  expect(left && right && left.x < right.x).toBe(true);
  expect(Math.abs((left?.width ?? 0) - (right?.width ?? 1))).toBeLessThanOrEqual(1);
  expect(Math.abs((left?.x ?? 0) + (left?.width ?? 0) - (right?.x ?? 1))).toBeLessThanOrEqual(1);
  await expect(page.locator('.flyout-last')).toHaveAttribute('data-flyout', made[1] as string);
  // Its line is the theme's green (--ok).
  const [line, ok] = await page.evaluate<[string, string]>(`(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--ok)';
    document.body.append(probe);
    const green = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(document.querySelector('.flyout-last')).borderTopColor, green];
  })()`);
  expect(line).toBe(ok);

  // A document clicked in the list takes the place of the one used last.
  await atItsStart(grid.getByRole('link', { name: C }));
  await expect(flyout(C)).toBeVisible();
  await expect(flyout(B)).toHaveCount(0);
  await expect(flyout(A)).toBeVisible();
  await expect(tray().getByRole('button', { name: `${B}, minimised` })).toBeVisible();
  await expect(panes).toHaveCount(2);
  expect([
    await panes.nth(0).getAttribute('data-flyout'),
    await panes.nth(1).getAttribute('data-flyout'),
  ]).toEqual([made[0], made[2]]);
  await expect(page.locator('.flyout-last')).toHaveAttribute('data-flyout', made[2] as string);

  // One at a time: the one used last stays, the other to the tray.
  await page
    .getByRole('region', { name: 'Side by side' })
    .getByRole('button', { name: 'One at a time' })
    .click();
  await expect(flyout(C)).toBeVisible();
  await expect(flyout(A)).toHaveCount(0);
  await expect(panes).toHaveCount(0);
  await expect(tray().getByRole('button', { name: `${A}, minimised` })).toBeVisible();
  await expect(flyout(C).getByRole('button', { name: 'Side by side' })).toBeVisible();

  await tray().getByRole('button', { name: 'Close all' }).click();
  await expect(tray()).toHaveCount(0);
});
