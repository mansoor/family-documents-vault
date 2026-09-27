import { expect, test } from '@playwright/test';

/**
 * Quick actions on every document (5.4), with the keyboard alone: Tab
 * reaches the ⋯ beside a row, Enter opens its menu, the arrows move
 * through it, Escape closes it and gives focus back, and an action chosen
 * with Enter is done. It makes a document of its own on the vault
 * first-run.spec.ts made, and moves it to the Trash at the end.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

test('the ⋯ on a row works from the keyboard alone', async ({ page, request }) => {
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
  // in is limited to 10 a minute, and the suite signs in up to seven times
  // a run: once in each file, first-run.spec.ts only when it is run again.
  // So wait a minute between local runs. The access token it was given
  // makes this file's document.
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Sign in' }).press('Enter');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  const [signedIn] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password') && r.ok()),
    page.getByLabel('Password').press('Enter'),
  ]);
  await expect(page).toHaveURL(/\/$/);
  const { access_token } = (await signedIn.json()) as { access_token: string };
  const title = `Quick actions ${Date.now()}`;
  const made = await request.post('/api/v1/documents', {
    headers: { authorization: `Bearer ${access_token}` },
    data: { title, visibility: 'household' },
  });
  expect(made.ok()).toBe(true);
  // Home again, through the app, to have it among what was added recently.
  await page.getByRole('link', { name: 'Search' }).click();
  await expect(page.getByLabel('Search everything')).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);

  // The ⋯ is the next stop after the row's own button: beside it, not in it.
  // Looked for in Home's Recently added, so nothing is pressed until Home is
  // drawn: until then Search, which lists the same row, is still on screen,
  // and a focus given to its row was lost when Home replaced it. The row is
  // the one with this ⋯ inside it: a `has` locator is looked for within each
  // row, so it names the button from the page, not from the region.
  const name = `Actions for “${title}”`;
  const recent = page.getByRole('region', { name: 'Recently added' });
  const row = recent.getByRole('listitem').filter({ has: page.getByRole('button', { name }) });
  const more = row.getByRole('button', { name });
  await expect(more).toBeVisible();
  await row.getByRole('button').first().focus();
  await page.keyboard.press('Tab');
  await expect(more).toBeFocused();

  // Enter opens the menu at its first item; the arrows go round the ends.
  const menu = page.getByRole('menu', { name: `Actions for “${title}”` });
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Edit details' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Move to Trash' })).toBeFocused();

  // Escape closes it, and focus is back on the ⋯.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // Made Essential with Enter: the last three are Essential, a new version
  // and the Trash.
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Make it Essential' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(`“${title}” is Essential now.`)).toBeVisible();
  await expect(more).toBeFocused();

  // Moved to the Trash through the app's own dialog, which starts on Cancel.
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Move to Trash?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Move to Trash' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row).toHaveCount(0);
});
