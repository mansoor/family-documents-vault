import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * An invitation link, the way the person invited opens it (5.17):
 * `/join#<token>`. The token is in the fragment, which the browser never
 * sends; the page reads it, takes it out of the address bar and this tab's
 * history, and posts it in a body. A link made before 0.5.17,
 * `/join/<token>`, opens the same page the same way. A reset link is the
 * same code on /reset, but it comes by email, which a run does not have.
 * This runs after first-run.spec.ts, on the vault it made.
 */

const EMAIL = 'e2e-owner@example.test';
const PASSWORD = 'correct horse battery staple';

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

/** An invitation for somebody new, made through the API: its link's token and its code. */
async function invite(request: APIRequestContext): Promise<{ token: string; code: string }> {
  const auth = { authorization: `Bearer ${await (signedIn ??= signIn(request))}` };
  const at = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const res = await request.post('/api/v1/invitations', {
    headers: auth,
    // A limited viewer: since 5.34 a viewer who sees every family document
    // is an owner's decision taken with a passkey or a code, and this
    // owner signs in with a password alone.
    data: {
      display_name: `Jo ${at}`,
      email: `jo-${at}@example.test`,
      role: 'viewer',
      restriction: { include_no_person_docs: true },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const made = (await res.json()) as { link_token: string; code: string };
  return { token: made.link_token, code: made.code };
}

/** Every request the page makes, as "METHOD url body". */
function watch(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (r) => sent.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`));
  return sent;
}

/** The token went to the vault only in a body, never in an address. */
function onlyInBodies(sent: string[], token: string) {
  for (const line of sent) {
    const [, url = ''] = line.split(' ');
    expect(url).not.toContain(token);
  }
  expect(
    sent.some(
      (l) => l.startsWith('POST') && l.includes('/api/v1/invitations/lookup') && l.includes(token),
    ),
  ).toBe(true);
}

test('the token is gone from the address bar once the page has read it', async ({
  page,
  request,
}) => {
  const { token } = await invite(request);
  const sent = watch(page);

  await page.goto(`/join#${token}`);
  await expect(page.getByRole('heading', { name: 'Join The E2E family' })).toBeVisible();
  expect(page.url()).not.toContain(token);
  expect(new URL(page.url()).pathname).toBe('/join');
  expect(await page.evaluate('location.hash')).toBe('');
  // The page says where the token has gone from, and that the browser's own
  // history may still have it.
  await expect(page.getByText(/out of the address bar and this tab's history now/)).toBeVisible();
  onlyInBodies(sent, token);

  // The same history entry, emptied, not a second one after it: one step
  // back is the page before the link, not the link with its token.
  await page.goBack();
  expect(page.url()).toBe('about:blank');

  // Opened again without it — reloaded, say — the page asks for the link.
  await page.goto('/join');
  await expect(page.getByRole('heading', { name: 'Open the invitation link again' })).toBeVisible();
  // The link pasted into this same tab changes only the fragment, which
  // loads nothing by itself: the page starts again from it.
  await page.goto(`/join#${token}`);
  await expect(page.getByRole('heading', { name: 'Join The E2E family' })).toBeVisible();
  expect(page.url()).not.toContain(token);
});

test('an invitation link works from its fragment', async ({ page, request }) => {
  const { token, code } = await invite(request);
  const sent = watch(page);

  await page.goto(`/join#${token}`);
  await expect(page.getByRole('heading', { name: 'Join The E2E family' })).toBeVisible();
  await page.getByLabel('The code they gave you').fill(code);
  await page.getByLabel('Choose a password').fill('jo chose this password');
  // The address left empty: the one the invitation was sent to is kept.
  await page.getByRole('button', { name: 'Join the family vault' }).click();

  // Home, signed in as them: its heading is the household's name alone.
  await expect(page.getByRole('heading', { name: 'The E2E family', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Join / })).toHaveCount(0);
  onlyInBodies(sent, token);
  const accepted = sent.find(
    (l) => l.startsWith('POST') && l.includes('/api/v1/invitations/accept'),
  );
  expect(accepted).toContain(`"token":"${token}"`);

  // Used, it opens nothing, from the fragment or the path.
  const lookup = await request.post('/api/v1/invitations/lookup', { data: { token } });
  expect(lookup.status()).toBe(404);
});

test('an old /join/ link still works', async ({ page, request }) => {
  const { token } = await invite(request);
  const sent = watch(page);

  // The address was sent to the vault as the page was asked for — which is
  // why no link is made so any more — but from then on it is a fragment's.
  await page.goto(`/join/${token}`);
  await expect(page.getByRole('heading', { name: 'Join The E2E family' })).toBeVisible();
  expect(page.url()).not.toContain(token);
  expect(new URL(page.url()).pathname).toBe('/join');
  const apiCalls = sent.filter((l) => l.includes('/api/'));
  for (const line of apiCalls) expect(line.split(' ')[1]).not.toContain(token);
  expect(apiCalls.some((l) => l.includes('/api/v1/invitations/lookup') && l.includes(token))).toBe(
    true,
  );
});
