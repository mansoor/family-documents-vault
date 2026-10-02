import { randomUUID } from 'node:crypto';
import { devices, expect, test, type APIRequestContext } from '@playwright/test';

/**
 * A share link, the way somebody outside the family opens it (5.16):
 * `/s#<token>`. The token is in the fragment, which the browser never
 * sends; the page reads it and takes it out of the address bar; nothing is
 * opened until Open is pressed, and the PIN goes in Open's body. Open gives
 * a session cookie for the share routes alone, and the file is downloaded
 * inside it. This runs after first-run.spec.ts, on the vault it made.
 *
 * Since 5.18 a link can be for viewing only — its pages, drawn by the
 * worker with whom it is for, and never the file — and opened so many
 * times.
 *
 * FDV_E2E_SHOTS names a folder to keep screenshots of the page in.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const SHOTS = process.env.FDV_E2E_SHOTS;
/** Where the vault is, as playwright.config.ts says: a second browser starts there too. */
const BASE_URL = process.env.FDV_E2E_URL ?? 'http://localhost:8080';

/** A one-page PDF the worker can draw, built by hand: a tenancy agreement's first page. */
function onePagePdf(): Buffer {
  const text = [
    'BT /F1 30 Tf 72 700 Td (TENANCY AGREEMENT) Tj ET',
    'BT /F1 14 Tf 72 650 Td (This agreement is made between the landlord and the tenant.) Tj ET',
    'BT /F1 14 Tf 72 625 Td (The rent is payable monthly in advance.) Tj ET',
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

interface Made {
  token: string;
  pin: string;
  /** A password the vault made up (5.20), when one was asked for. */
  password?: string;
  shareId: string;
  documentId: string;
  title: string;
  auth: { authorization: string };
}

/**
 * Signed in once for the file, through the API. Signing in is limited to
 * 10 a minute, and the suite signs in up to nine times a run: once in each
 * file, first-run.spec.ts only when it is run again. So wait a minute
 * between local runs.
 */
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

/**
 * A document with a file on it, and a link to it made through the API: by
 * default with a PIN; with `options`, 5.18's instead.
 */
async function makeLink(
  request: APIRequestContext,
  options: Record<string, unknown> = { with_pin: true },
  pdf: Buffer = PDF,
): Promise<Made> {
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
    multipart: { file: { name: 'tenancy.pdf', mimeType: 'application/pdf', buffer: pdf } },
  });
  expect(file.ok()).toBe(true);
  const shared = await request.post(`/api/v1/documents/${id}/share`, {
    headers: auth,
    data: { recipient_label: 'the letting agent', ...options },
  });
  expect(shared.ok(), await shared.text()).toBe(true);
  const made = (await shared.json()) as {
    link_token: string;
    pin: string;
    password?: string;
    share: { id: string };
  };
  return {
    token: made.link_token,
    pin: made.pin,
    ...(made.password ? { password: made.password } : {}),
    shareId: made.share.id,
    documentId: id,
    title,
    auth,
  };
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

test('a view-only link shows its pages, drawn with whom it is for, and never the file (5.18)', async ({
  page,
  request,
}) => {
  // The worker draws the pages: its own previews first, then the link's.
  test.setTimeout(150_000);
  const made = await makeLink(
    request,
    {
      permission: 'view',
      max_opens: 2,
      expires_at: new Date(Date.now() + 2 * 864e5).toISOString(),
    },
    onePagePdf(),
  );

  await page.goto(`/s#${made.token}`);
  await expect(page.getByText(/It can be opened twice more/)).toBeVisible();
  await expect(page.getByText(/It is not shared to download/)).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: made.title })).toBeVisible();
  await expect(page.getByText(/cannot stop screenshots/)).toBeVisible();

  // Drawn in a minute or so; the page asks again by itself meanwhile.
  const first = page.getByRole('img', { name: 'Page 1 of 1' });
  await expect(first).toBeVisible({ timeout: 120_000 });
  // And it is a picture that loaded, not a broken one.
  await expect
    .poll(
      () =>
        page.evaluate<number>(
          `(() => { const i = document.querySelector('img[alt="Page 1 of 1"]'); return i && i.complete ? i.naturalWidth : 0; })()`,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-view-only.png`, fullPage: true });

  // The file itself is refused inside the session, whatever asks for it.
  const refused = await page.evaluate(
    (url) => fetch(url).then(async (r) => ({ status: r.status, body: await r.text() })),
    `/api/v1/shared/items/${made.documentId}/content`,
  );
  expect(refused.status).toBe(403);
  expect(refused.body).toContain('view_only');
  expect(refused.body).not.toContain('%PDF');
  // Opened once; reloading, and its pages, cost nothing.
  await page.reload();
  await expect(page.getByRole('img', { name: 'Page 1 of 1' })).toBeVisible();
  expect(await opens(request, made)).toBe(1);
});

test('a link opened as many times as it allows says so (5.18)', async ({ page, request }) => {
  const made = await makeLink(request, { max_opens: 1 });
  await page.goto(`/s#${made.token}`);
  await expect(page.getByText(/It can be opened once more/)).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('link', { name: 'Download tenancy.pdf' })).toBeVisible();
  expect(await opens(request, made)).toBe(1);

  // Anybody else with the link — or the same person, arriving afresh — is told.
  await page.goto('about:blank');
  await page.goto(`/s#${made.token}`);
  await expect(page.getByRole('heading', { name: 'This link cannot be opened' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'opened as many times as it allows, so it cannot be opened again',
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-used-up.png`, fullPage: true });
  expect(await opens(request, made)).toBe(1);
  const res = await request.get('/api/v1/shares', { headers: made.auth });
  const { items } = (await res.json()) as { items: Array<{ id: string; state: string }> };
  expect(items.find((s) => s.id === made.shareId)?.state).toBe('used_up');
});

/**
 * A second factor (5.20): a password and this device only, which every
 * vault has; and an emailed code, which only a vault whose operator has set
 * FDV_SMTP_URL offers. The compose stack in CI has none, so there the code
 * is refused with its reason; FDV_E2E_MAILPIT names a Mailpit to read the
 * code from where there is one.
 */
test('a password link for this device only opens in the first browser, and no other (5.20)', async ({
  browser,
  page,
  request,
}) => {
  const made = await makeLink(request, { with_password: true, this_device_only: true });
  const password = made.password as string;
  expect(password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

  await page.goto(`/s#${made.token}`);
  await expect(page.getByText(/put a password on it/)).toBeVisible();
  await expect(page.getByText(/It opens only in the first browser that opens it/)).toBeVisible();
  await page.getByLabel('The password they gave you').fill('not the password');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('alert')).toContainText('That password is not right');
  await page.getByLabel('The password they gave you').fill(password);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('link', { name: 'Download tenancy.pdf' })).toBeVisible();
  expect(await opens(request, made)).toBe(1);
  // Which browser this is: a cookie its script cannot read, for the share routes alone.
  const device = (await page.context().cookies()).find((c) =>
    c.name.startsWith('fdv_share_device_'),
  );
  expect(device).toMatchObject({ path: '/api/v1/shared', httpOnly: true, secure: true });
  expect(device?.sameSite).toBe('Strict');

  // Another browser, with the whole link: told at once, and nothing counted.
  const elsewhere = await browser.newContext({ ...devices['Pixel 7'], baseURL: BASE_URL });
  try {
    const other = await elsewhere.newPage();
    await other.goto(`/s#${made.token}`);
    await expect(other.getByRole('heading', { name: 'This link cannot be opened' })).toBeVisible();
    await expect(other.getByRole('alert')).toContainText('opened in another browser already');
    await expect(other.getByText(made.title)).toHaveCount(0);
  } finally {
    await elsewhere.close();
  }
  expect(await opens(request, made)).toBe(1);
  // The first browser opens it again.
  await page.goto('about:blank');
  await page.goto(`/s#${made.token}`);
  await page.getByLabel('The password they gave you').fill(password);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('link', { name: 'Download tenancy.pdf' })).toBeVisible();
  expect(await opens(request, made)).toBe(2);
});

test('an emailed code goes only through operator mail, and the page asks for it with the address masked (5.20)', async ({
  page,
  request,
}) => {
  const caps = (await (await request.get('/api/v1/capabilities')).json()) as {
    features: { share_email_code?: boolean };
  };
  const to = `b520-e2e-${randomUUID()}@example.test`;
  if (!caps.features.share_email_code) {
    // No operator mail: refused, with the reason, and nothing made.
    const auth = { authorization: `Bearer ${await (signedIn ??= signIn(request))}` };
    const doc = await request.post('/api/v1/documents', {
      headers: auth,
      data: { title: `Emailed code ${Date.now()}`, visibility: 'household' },
    });
    const { id } = (await doc.json()) as { id: string };
    const refused = await request.post(`/api/v1/documents/${id}/share`, {
      headers: auth,
      data: { code_email: to },
    });
    expect(refused.status()).toBe(422);
    expect(await refused.text()).toContain('email_code_unavailable');
    return;
  }
  const made = await makeLink(request, { code_email: to });
  await page.goto(`/s#${made.token}`);
  await expect(page.getByText(/it asks for a code, which we email to you/)).toBeVisible();
  await expect(page.getByText('b•••@e•••.test')).toBeVisible();
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('status')).toContainText('We sent a code to b•••@e•••.test');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-code-sent.png`, fullPage: true });
  const mailpit = process.env.FDV_E2E_MAILPIT;
  if (!mailpit) return;
  // The code, as it arrived: no link in it, and nothing of what was shared.
  let text = '';
  await expect
    .poll(
      async () => {
        const found = (await (
          await request.get(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
        ).json()) as { messages?: Array<{ ID: string }> };
        const id = found.messages?.[0]?.ID;
        if (!id) return '';
        const full = (await (await request.get(`${mailpit}/api/v1/message/${id}`)).json()) as {
          Text: string;
          HTML: string;
        };
        text = `${full.Text}${full.HTML}`;
        return text;
      },
      { timeout: 60_000 },
    )
    .toMatch(/\d{3} \d{3}/);
  expect(text).not.toMatch(/https?:|\/s#/);
  expect(text).not.toContain(made.title);
  const code = /(\d{3}) (\d{3})/.exec(text)?.slice(1).join('') ?? '';
  await page.getByLabel('The code from the email').fill(code);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('link', { name: 'Download tenancy.pdf' })).toBeVisible();
  expect(await opens(request, made)).toBe(1);
});
