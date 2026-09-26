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
  const signIn = await request.post('/api/v1/auth/password', {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = (await signIn.json()) as { access_token: string };
  const title = `Quick actions ${Date.now()}`;
  const made = await request.post('/api/v1/documents', {
    headers: { authorization: `Bearer ${access_token}` },
    data: { title, visibility: 'household' },
  });
  expect(made.ok()).toBe(true);

  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Sign in' }).press('Enter');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/password') && r.ok()),
    page.getByLabel('Password').press('Enter'),
  ]);
  await expect(page).toHaveURL(/\/$/);

  // The ⋯ is the next stop after the row's own button: beside it, not in it.
  const more = page.getByRole('button', { name: `Actions for “${title}”` });
  const row = page.getByRole('listitem').filter({ has: more });
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
