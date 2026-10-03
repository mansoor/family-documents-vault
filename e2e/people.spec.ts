import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A person's profile and their photo (5.17c), on the real stack: a name on
 * Home opens their documents, and back is Home; a name on People opens
 * their profile; a photo chosen there is cropped, sent, made by the worker
 * with ImageMagick, and shown on Home. Runs on the vault first-run.spec.ts
 * made, with a person of its own, whose photo goes at the end.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

/**
 * Signed in through the page, once for this file, and its token. Signing in
 * is limited to 10 a minute, and the suite signs in up to nine times a run:
 * once in each file, first-run.spec.ts only when it is run again. So wait a
 * minute between local runs. The rest of what the suite asks, from its one
 * address, is under FDV_RATE_LIMIT_PER_MINUTE, which CI raises (0.5.17).
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

/** A real PNG, 64 pixels square: red on the left, blue on the right. */
function photo(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: 64 }, (_, x) => Buffer.from(x < 32 ? [220, 40, 40] : [40, 60, 200])),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 64 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe.configure({ mode: 'serial' });
const run = Date.now().toString(36);
const FIRST = `Zara${run}`;
const NAME = `${FIRST} Khan`;
let page: Page;
let token: string;
let personId = '';

test.beforeAll(async ({ browser, request }) => {
  page = await browser.newPage();
  token = await signIn(page, request);
  const added = await request.post('/api/v1/members', {
    headers: { authorization: `Bearer ${token}` },
    data: { display_name: NAME, relationship: 'Niece' },
  });
  expect(added.ok()).toBe(true);
  personId = ((await added.json()) as { id: string }).id;
  await page.reload();
});

test.afterAll(async ({ request }) => {
  // Her photo, if it was made: the person stays, as people do.
  if (personId) {
    await request.delete(`/api/v1/members/${personId}/photo`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }
  await page.close();
});

test('Home to documents, People to a profile; add a photo and see it on Home', async () => {
  // Home: her name opens her documents, and back is Home.
  const chip = page.getByRole('link', { name: `${NAME}’s documents` });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('heading', { name: `${FIRST}’s documents`, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/people/${personId}/documents$`));
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/$/);

  // People: her name opens her profile, which says who she is.
  await page.getByRole('link', { name: 'People' }).click();
  await page.getByRole('button', { name: new RegExp(NAME) }).click();
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
  await expect(page.getByText('No sign-in')).toBeVisible();
  await expect(page.getByText('Niece')).toBeVisible();

  // A photo: chosen, the part to show moved a little, and used.
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'zara.png',
    mimeType: 'image/png',
    buffer: photo(),
  });
  const sheet = page.getByRole('dialog', { name: 'Choose the part to show' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('img.crop-photo')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await sheet.getByRole('button', { name: 'Use this photo' }).click();
  await expect(page.getByText('Getting the photo ready…')).toBeVisible();
  // The worker makes it: a few seconds, with ImageMagick.
  await expect(page.getByText('Photo updated.')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.profile-head img.avatar-photo')).toBeVisible();

  // And Home shows it, in her circle.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(chip.locator('img.avatar-photo')).toBeVisible();
});

test('Edit details changes her relationship; a change saved meanwhile is said, and shown', async () => {
  // Her profile, from People.
  await page.getByRole('link', { name: 'People' }).click();
  await page.getByRole('button', { name: new RegExp(NAME) }).click();
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
  const about = page.getByRole('region', { name: 'About' });
  await about.getByRole('button', { name: 'Edit details' }).click();
  const form = about.getByRole('form', { name: `${FIRST}’s details` });
  await form.getByLabel('Relationship (optional)').fill('Cousin');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(about.getByText('Details saved.')).toBeVisible();
  await expect(about.getByText('Cousin')).toBeVisible();

  // Opened again; meanwhile somebody else saves her as a niece.
  await about.getByRole('button', { name: 'Edit details' }).click();
  const meanwhile = await page.request.patch(`/api/v1/members/${personId}`, {
    headers: { authorization: `Bearer ${token}` },
    data: { relationship: 'Niece' },
  });
  expect(meanwhile.ok()).toBe(true);
  await form.getByLabel('Relationship (optional)').fill('Second cousin');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(about.getByRole('alert')).toContainText(
    `Someone else changed ${FIRST}’s details while you were editing.`,
  );
  await expect(form.getByLabel('Relationship (optional)')).toHaveValue('Niece');
  // Made again, on top of theirs.
  await form.getByLabel('Relationship (optional)').fill('Second cousin');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(about.getByText('Details saved.')).toBeVisible();
  await expect(about.getByText('Second cousin')).toBeVisible();
});
