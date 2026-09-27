import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * A share link, the way somebody outside the family opens it (5.16):
 * `/s#<token>`. The token is in the fragment, which the browser never
 * sends; the page reads it and takes it out of the address bar; nothing is
 * opened until Open is pressed, and the PIN goes in Open's body. Open gives
 * a session cookie for the share routes alone, and the file is downloaded
 * inside it. This runs after first-run.spec.ts, on the vault it made.
 *
 * FDV_E2E_SHOTS names a folder to keep screenshots of the page in.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const SHOTS = process.env.FDV_E2E_SHOTS;

interface Made {
  token: string;
  pin: string;
  shareId: string;
  title: string;
  auth: { authorization: string };
}

/** Signed in once for the file: signing in is limited per address. */
let signedIn: Promise<string> | null = null;

async function signIn(request: APIRequestContext): Promise<string> {
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
  const res = await request.post('/api/v1/auth/password', {
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** A document with a file on it, and a link with a PIN to it, made through the API. */
async function makeLink(request: APIRequestContext): Promise<Made> {
  const auth = { authorization: `Bearer ${await (signedIn ??= signIn(request))}` };
  const title = `Tenancy agreement ${Date.now()}`;
  const doc = await request.post('/api/v1/documents', {
    headers: auth,
    data: { title, visibility: 'household' },
  });
  expect(doc.ok()).toBe(true);
  const { id } = (await doc.json()) as { id: string };
  const file = await request.post(`/api/v1/documents/${id}/versions`, {
    headers: { ...auth, 'idempotency-key': randomUUID() },
    multipart: { file: { name: 'tenancy.pdf', mimeType: 'application/pdf', buffer: PDF } },
  });
  expect(file.ok()).toBe(true);
  const shared = await request.post(`/api/v1/documents/${id}/share`, {
    headers: auth,
    data: { recipient_label: 'the letting agent', with_pin: true },
  });
  expect(shared.ok()).toBe(true);
  const made = (await shared.json()) as {
    link_token: string;
    pin: string;
    share: { id: string };
  };
  return { token: made.link_token, pin: made.pin, shareId: made.share.id, title, auth };
}

async function opens(request: APIRequestContext, made: Made): Promise<number> {
  const res = await request.get('/api/v1/shares', { headers: made.auth });
  const { items } = (await res.json()) as { items: Array<{ id: string; open_count: number }> };
  return items.find((s) => s.id === made.shareId)?.open_count ?? -1;
}

test('the token is gone from the address bar once the page has read it', async ({
  page,
  request,
}) => {
  const made = await makeLink(request);
  const sent: string[] = [];
  page.on('request', (r) => sent.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`));

  await page.goto(`/s#${made.token}`);
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
  expect(page.url()).not.toContain(made.token);
  expect(new URL(page.url()).pathname).toBe('/s');
  expect(await page.evaluate('location.hash')).toBe('');
  // The same history entry, emptied, not a second one after it: one step
  // back is the page before the link, not the link with its token.
  await page.goBack();
  expect(page.url()).not.toContain(made.token);
  expect(page.url()).toBe('about:blank');
  // The token went to the vault only in a body, never in an address.
  for (const line of sent) {
    const [, url = ''] = line.split(' ');
    expect(url).not.toContain(made.token);
  }
  expect(sent.some((l) => l.startsWith('POST') && l.includes('/api/v1/shared/preview'))).toBe(true);
});

test('a link opens only when Open is pressed, with its PIN, and the file comes inside it', async ({
  page,
  request,
}) => {
  const made = await makeLink(request);
  const unlocks: Array<string | null> = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/v1/shared/unlock')) unlocks.push(r.postData());
  });

  const response = await page.goto(`/s#${made.token}`);
  // Behind the vault's own web server (the compose stack), the page is
  // sent the public pages' headers; a development server sends none.
  if (response?.headers().server?.includes('nginx')) {
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  }

  // The preview: who sent it, and that it has a PIN, but not its title.
  await expect(page.getByRole('heading', { name: 'A shared document' })).toBeVisible();
  await expect(page.getByText(/put a PIN on it/)).toBeVisible();
  await expect(page.getByText(made.title)).toHaveCount(0);
  const open = page.getByRole('button', { name: 'Open' });
  await expect(open).toBeDisabled();
  // Loading the page opened nothing.
  expect(await opens(request, made)).toBe(0);

  await page.getByLabel(/four-digit PIN/).fill(made.pin);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-preview-with-pin.png`, fullPage: true });
  await open.click();

  const download = page.getByRole('link', { name: 'Download tenancy.pdf' });
  await expect(download).toBeVisible();
  await expect(page.getByRole('heading', { name: made.title })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-after-open.png`, fullPage: true });
  expect(unlocks).toHaveLength(1);
  expect(JSON.parse(unlocks[0] ?? '{}')).toEqual({ token: made.token, secret: made.pin });
  expect(await opens(request, made)).toBe(1);

  // The session is a cookie the page's script cannot read, for the share
  // routes alone.
  const cookie = (await page.context().cookies()).find((c) => c.name === 'fdv_share');
  expect(cookie).toMatchObject({ path: '/api/v1/shared', httpOnly: true, secure: true });
  expect(cookie?.sameSite).toBe('Strict');
  expect(await page.evaluate('document.cookie')).not.toContain('fdv_share');

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toBe('tenancy.pdf');

  // Reloaded, the page shows what is open without the token, and counts
  // nothing more.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Download tenancy.pdf' })).toBeVisible();
  expect(await opens(request, made)).toBe(1);

  // Taken back, the open page stops at its next request.
  await request.delete(`/api/v1/shares/${made.shareId}`, { headers: made.auth });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'This link cannot be opened' })).toBeVisible();
});
