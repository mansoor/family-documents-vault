import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Reminders from any date (5.16b), on the real stack: an adult shows Due
 * date on a Council tax kind and makes it remind, 7 days before; a bill
 * filed due in 5 days is reminded at once, and Needs attention and Home say
 * "Due date: …, in 5 days". Runs on the vault first-run.spec.ts made, with a
 * kind and a document of its own, which go at the end. The adult is the
 * suite's own account, an owner: another adult would need an invitation,
 * confirmed with a password.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

/**
 * Signed in through the page, once for this file. Signing in is limited to
 * 10 a minute, and the suite signs in up to ten times a run: once in each
 * file, first-run.spec.ts only when it is run again. So wait a minute
 * between local runs. The access token too, to tidy up after this file.
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

/** A calendar day `days` from today, on the vault's calendar (UTC, its default). */
function fromToday(days: number): Date {
  const d = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * What the vault says a reminder is about, for `date`, `days` off: "Due
 * date: 2 Oct, in 5 days", with the year when it is not this one. Built
 * from the date itself, the month as the vault's shortDate writes it:
 * three letters, or four where the vault's ICU has them (September is
 * "Sept" on Node 22, "Sep" before), so either is taken.
 */
function aboutLine(word: string, date: Date, days: number): RegExp {
  const month = date.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const short = month.length > 3 ? `${month.slice(0, 3)}(?:${month.charAt(3)})?` : month;
  const year = date.getUTCFullYear();
  const said = year === fromToday(0).getUTCFullYear() ? '' : ` ${year}`;
  return new RegExp(`^${word}: ${date.getUTCDate()} ${short}${said}, in ${days} days$`);
}

// One page, signed in once, for every test here: one after the other.
test.describe.configure({ mode: 'serial' });
const run = Date.now().toString(36);
const KIND = `Council tax ${run}`;
const BILL = `Council tax, March ${run}`;
let page: Page;
let token: string;
let kindKey = '';
let billId = '';

test.beforeAll(async ({ browser, request }) => {
  page = await browser.newPage();
  token = await signIn(page, request);
});

test.afterAll(async ({ request }) => {
  // Whatever the tests left: the bill (to the Trash) and the kind (archived).
  const headers = { authorization: `Bearer ${token}` };
  if (billId) await request.delete(`/api/v1/documents/${billId}`, { headers });
  if (kindKey) await request.post(`/api/v1/document-types/${kindKey}/archive`, { headers });
  await page.close();
});

test('an adult shows Due date on a Council tax kind and makes it remind', async () => {
  await page.goto('/settings/kinds');
  await page.getByRole('link', { name: 'Add a kind' }).click();
  await page.getByLabel('Name of this kind').fill(KIND);
  await page.getByLabel('Category').selectOption('bills');

  // The built-in Due date, from the library.
  const due = page.getByRole('group', { name: 'Due date', exact: true });
  await expect(due.getByText('A date')).toBeVisible();
  await due.getByRole('checkbox', { name: 'Show' }).check();

  // Switched on, it reminds from the one date shown, 7 days before, and says so.
  const reminders = page.getByRole('region', { name: 'Reminders' });
  await reminders.getByRole('switch', { name: 'Remind us before a date' }).check();
  await expect(reminders.getByText('Reminders are on: 7 days before its due date.')).toBeVisible();
  await expect(reminders.getByLabel('The date')).toHaveValue('due_date');
  await expect(
    reminders
      .getByRole('group', { name: 'How long before' })
      .getByRole('button', { name: '7 days' }),
  ).toHaveAttribute('aria-pressed', 'true');
  // The date reminders come from is always asked for.
  const required = due.getByRole('checkbox', { name: 'Required' });
  await expect(required).toBeChecked();
  await expect(required).toBeDisabled();

  const [made] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/document-types') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Add this kind' }).click(),
  ]);
  expect(made.ok()).toBe(true);
  const kind = (await made.json()) as { key: string; remind_from: string; remind_leads: number[] };
  kindKey = kind.key;
  expect(kind).toMatchObject({ remind_from: 'due_date', remind_leads: [7] });
  await expect(page.getByText(`“${KIND}” is ready to use.`)).toBeVisible();
});

test('a bill due in 5 days is in Needs attention and on Home', async () => {
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: 'Add a document' }).click();
  await page.getByLabel('Choose a file').setInputFiles({
    name: 'council-tax.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expect(page.getByRole('heading', { name: 'Is this right?' })).toBeVisible();
  await page.getByLabel('What it is').selectOption({ label: KIND });
  await page.getByLabel('Name', { exact: true }).fill(BILL);

  // The promise, under the date it is about.
  const dueDate = page.getByLabel(/^Due date/);
  await expect(dueDate).toHaveAccessibleDescription(
    /^We'll remind you 7 days before its due date\.\s*We remind you once for this date/,
  );
  const due = fromToday(5);
  await dueDate.fill(
    due.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  );
  await page.getByRole('button', { name: 'Save to the vault' }).click();
  await expect(page.getByRole('heading', { name: BILL })).toBeVisible();
  billId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // Seven days before a date five days off is already here: it is due now,
  // and says what it is about.
  const about = aboutLine('Due date', due, 5);
  await page.getByRole('link', { name: 'Reminders' }).click();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: BILL });
  await expect(row.getByText(about)).toBeVisible();
  // A snooze never waits past the due date: a week, or a month, would, so
  // the day itself is offered instead.
  await expect(row.getByRole('button', { name: 'On the day' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'A week' })).toHaveCount(0);

  // Home's strip, the only red on it, says the same.
  await page.getByRole('link', { name: 'Home' }).click();
  const strip = page.getByRole('status').filter({ hasText: /needs? attention/ });
  await expect(
    strip.getByRole('listitem').filter({ hasText: BILL }).getByText(about),
  ).toBeVisible();
});
