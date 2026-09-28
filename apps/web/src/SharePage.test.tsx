import {
  defaultShareEnd,
  latestShareEnd,
  shareQuickPicks,
  zonedParts,
  zonedTime,
} from '@fdv/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { takeLinkToken } from './link-token.js';
import { SharePage } from './screens/SharePage.js';
import { fresh, installFakeApi, PASSPORT, signedIn } from './test-api.js';

const TOKEN = 'share-secret-0123456789abcdef';

/** The web's stylesheet, read from disk: under Vitest an import of it is empty. */
const CSS = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

/** The selectors of the stylesheet's rules that take the focus ring away. */
const RINGLESS = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /(?:^|;)\s*outline\s*:\s*(?:none|0)\s*(?:;|$)/.test(body ?? ''))
  .map(([, selector]) => (selector ?? '').trim());

/** Whether the element, focused, matches a rule that takes its focus ring away. */
const ringless = (el: Element) => RINGLESS.some((selector) => el.matches(selector));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  // jsdom has no isSecureContext; a test that gives it one takes it away.
  delete (window as { isSecureContext?: boolean }).isSecureContext;
});

/** The page as a browser shows it over plain http to a LAN address: not a secure context. */
function overPlainHttp() {
  Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
}

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/**
 * The page a share link opens (5.16): `/s#<token>`. It reads the token from
 * the fragment and takes it out of the address, shows who sent what, and
 * opens nothing until Open is pressed.
 */
describe('the page a link opens', () => {
  it("the token is read from the fragment, then taken out of the address bar and this tab's history", () => {
    window.history.replaceState({ kept: true }, '', `/s#${TOKEN}`);
    expect(takeLinkToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.href).toMatch(/\/s$/);
    expect(window.location.href).not.toContain(TOKEN);
    // The same history entry, not a new one after it.
    expect(window.history.state).toEqual({ kept: true });
    // Read once: there is nothing left to read.
    expect(takeLinkToken()).toBeNull();
  });

  it('loading the page opens nothing until Open', async () => {
    const state = fresh();
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);

    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
    expect(screen.getByText('Mansoor Seikh')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is opened until you press Open/)).toBeInTheDocument();
    // Shown, not opened: no Open was sent and nothing was counted.
    expect(state.calls.map((c) => c.url)).toEqual(['/api/v1/shared/preview']);
    expect(state.shareOpens).toBe(0);
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const download = await screen.findByRole('link', { name: 'Download tenancy.pdf' });
    expect(download).toHaveAttribute('href', '/api/v1/shared/items/doc-shared/content');
    expect(state.shareOpens).toBe(1);
    // No sign of the rest of the vault: no navigation, no sign-in.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('the PIN goes in the body of Open, and the token never in an address', async () => {
    const state = fresh({ sharePin: '4821' });
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);

    await screen.findByText(/put a PIN on it/);
    // The title waits for the PIN.
    expect(screen.getByRole('heading', { name: 'A shared document' })).toBeInTheDocument();
    expect(screen.queryByText(/tenancy/i)).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Open' });
    expect(open).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/four-digit PIN they gave you/), {
      target: { value: '0000' },
    });
    fireEvent.click(open);
    await screen.findByText(/That PIN is not right/);
    expect(state.shareOpens).toBe(0);

    fireEvent.change(screen.getByLabelText(/four-digit PIN they gave you/), {
      target: { value: '4821' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });

    const unlocks = state.calls.filter((c) => c.url === '/api/v1/shared/unlock');
    expect(unlocks.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(unlocks[1]?.body).toEqual({ token: TOKEN, secret: '4821' });
    for (const c of state.calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.url).not.toContain('4821');
    }
  });

  it('reloaded after Open, it shows what is open without the token', async () => {
    const state = fresh({ shareSession: true });
    installFakeApi(state);
    render(<SharePage token={null} />);

    await screen.findByRole('link', { name: 'Download tenancy.pdf' });
    expect(state.calls.map((c) => c.url)).toEqual(['/api/v1/shared/items']);
    expect(state.shareOpens).toBe(0);
  });

  it('with no link and nothing open, it says to open the link again', async () => {
    installFakeApi(fresh());
    render(<SharePage token={null} />);
    await screen.findByRole('heading', { name: 'This link cannot be opened' });
    expect(screen.getByText(/Open the link from their message again/)).toBeInTheDocument();
  });

  it('a link taken back says so, without saying what it was', async () => {
    installFakeApi(fresh({ shareValid: false }));
    render(<SharePage token={TOKEN} />);
    await screen.findByRole('heading', { name: 'This link cannot be opened' });
    expect(screen.getByText(/Ask whoever sent it/)).toBeInTheDocument();
    expect(screen.queryByText(/tenancy/i)).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('over plain http Open is off and says why, so nothing is counted or written down', async () => {
    overPlainHttp();
    const state = fresh();
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);

    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
    const open = screen.getByRole('button', { name: 'Open' });
    expect(open).toBeDisabled();
    const why = screen.getByText(/not on a secure connection/);
    expect(why).toHaveTextContent(/this browser could not download the document/);
    expect(why).toHaveTextContent(/nothing has been opened/);
    expect(why).toHaveTextContent(/Ask whoever sent the link for one that starts with https:\/\//);
    // Neither the button nor the form opens it: nothing counted, nothing told.
    fireEvent.click(open);
    fireEvent.submit(screen.getByTestId('share-preview'));
    await new Promise((r) => setTimeout(r, 0));
    expect(state.calls.map((c) => c.url)).toEqual(['/api/v1/shared/preview']);
    expect(state.shareOpens).toBe(0);
    await expectAccessible();
  });
});

/**
 * A link's options (5.18), at both ends: the share sheet's date and time,
 * View or View and download, and so many opens; and what the page at /s
 * does with each.
 */
describe('until a date and time, view or download, so many opens', () => {
  const openSheet = async (over: Parameters<typeof fresh>[0] = {}) => {
    const state = fresh({ timezone: 'Europe/London', ...over });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByRole('group', { name: 'Stops working' });
    return state;
  };
  const shareBody = (state: ReturnType<typeof fresh>) =>
    state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/share'))?.body as
      Record<string, unknown> | undefined;

  it('the share sheet: an end on the household clock, View, and so many opens', async () => {
    const state = await openSheet();
    // A week, unless somebody says otherwise; the picks one tap away.
    const picks = shareQuickPicks('Europe/London');
    const friday = picks.find((p) => p.key === 'friday') as { at: Date };
    expect(screen.getByRole('button', { name: 'In a week' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Friday 5 pm' }));
    expect(screen.getByRole('button', { name: 'Friday 5 pm' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Time')).toHaveValue('17:00');
    expect(screen.getByText(/^Until Friday \d+ \w+ at 17:00/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/nothing can stop a screenshot/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Can be opened'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Who is it for?'), {
      target: { value: 'the letting agent' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));

    await screen.findByText(/\/s#share-secret-0123456789abcdef$/);
    expect(shareBody(state)).toEqual({
      recipient_label: 'the letting agent',
      expires_at: friday.at.toISOString(),
      permission: 'view',
      max_opens: 5,
      with_pin: false,
    });
    // Said back: until when, what they can do, how often, and the pages.
    expect(screen.getByText(/^Until Friday \d+ \w+ at 17:00\.$/)).toBeInTheDocument();
    expect(screen.getByText(/^To view: they see its pages/)).toBeInTheDocument();
    expect(screen.getByText('It can be opened 5 times.')).toBeInTheDocument();
    expect(
      screen.getByText('The pages are still being drawn; the link works in a minute.'),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('an end in the past or under 5 minutes is refused before it is sent', async () => {
    const state = await openSheet();
    const soon = zonedParts(new Date(Date.now() + 2 * 60_000), 'Europe/London');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: soon.date } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: soon.time } });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose a time at least 5 minutes from now.',
    );
    expect(screen.getByRole('button', { name: 'Make the link' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Can be opened'), { target: { value: '0' } });
    expect(screen.getByText(/A number from 1 to 1000/)).toBeInTheDocument();
    expect(shareBody(state)).toBeUndefined();
  });

  it('under a vault limit shorter than a week, only ends it takes are offered, and the default is one (5.18 review)', async () => {
    const state = await openSheet({ shareMaxDays: 3 });
    // No "In a week": the vault would refuse it.
    expect(screen.queryByRole('button', { name: 'In a week' })).not.toBeInTheDocument();
    const offered = shareQuickPicks('Europe/London', new Date(), 3).map((p) => p.label);
    for (const label of offered) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    const latest = latestShareEnd('Europe/London', new Date(), 3);
    expect(screen.getByLabelText('Date')).toHaveAttribute('max', latest.date);
    // Its default, before anything is touched: safely inside the longest, on
    // the hour, said without a problem, and ready to be made (second review).
    const expected = defaultShareEnd('Europe/London', new Date(), 3);
    expect(screen.getByLabelText('Date')).toHaveValue(expected.date);
    expect(screen.getByLabelText('Time')).toHaveValue(expected.time);
    expect(expected.time).toMatch(/:00$/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make the link' })).toBeEnabled();
    const at = zonedTime(expected.date, expected.time, 'Europe/London') as Date;
    expect(at.getTime()).toBeLessThanOrEqual(Date.now() + 3 * 864e5 - 15 * 60_000);
    expect(at.getTime()).toBeGreaterThan(Date.now() + 3 * 864e5 - 3 * 3_600_000);

    // Made as it is, it is taken, and within the longest.
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByText(/\/s#share-secret-0123456789abcdef$/);
    const sent = Date.parse(String(shareBody(state)?.expires_at));
    expect(sent).toBe(at.getTime());
    expect(sent).toBeLessThanOrEqual(Date.now() + 3 * 864e5);
  });

  it('under a vault limit shorter than a week, a date past it is said to be too far before anything is sent (5.18 review)', async () => {
    const state = await openSheet({ shareMaxDays: 3 });
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: latestShareEnd('Europe/London', new Date(), 5).date },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('A link can last 3 days at most.');
    expect(screen.getByRole('button', { name: 'Make the link' })).toBeDisabled();
    expect(shareBody(state)).toBeUndefined();
  });

  it('a limit typed wrong is said, never taken as no limit (5.18 review)', async () => {
    const state = await openSheet();
    for (const typed of ['5e', '3x', '-2', '2.5']) {
      fireEvent.change(screen.getByLabelText('Can be opened'), { target: { value: typed } });
      expect(screen.getByLabelText('Can be opened'), typed).toHaveValue(typed);
      expect(screen.getByText(/A number from 1 to 1000/), typed).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Make the link' }), typed).toBeDisabled();
    }
    fireEvent.change(screen.getByLabelText('Can be opened'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByText(/\/s#share-secret-0123456789abcdef$/);
    expect(shareBody(state)?.max_opens).toBe(5);
  });

  it("the family's list says when a view-only link's pages could not be drawn (5.18 review)", async () => {
    const state = fresh({ timezone: 'Europe/London' });
    state.shares.push({
      id: 'sh-failed',
      document_id: 'doc-1',
      document_title: 'Mansoor’s passport',
      recipient_label: 'the embassy',
      created_by_name: 'Mansoor Seikh',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      has_pin: false,
      open_count: 0,
      last_opened_at: null,
      state: 'active',
      flow: 'v2',
      permission: 'view',
      max_opens: null,
      max_downloads: null,
      downloads_used: 0,
      pages: { state: 'failed', shown: 0, total: 2 },
      summary:
        'Shared with the embassy, not opened yet; to view only. Stops working on 30 September at 17:00.',
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    await screen.findByText(/Shared with the embassy, not opened yet/);
    expect(
      screen.getByText(/The vault could not draw the pages of this document/),
    ).toHaveTextContent(/Take it back, and share it to download instead/);
  });

  it('a Word file cannot be shared view-only', async () => {
    await openSheet({
      versionMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'View' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'View and download' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByText(/Word and Excel files can only be shared with download/),
    ).toBeInTheDocument();
  });

  it('a 42-page document: the sharer is told they will see 30', async () => {
    await openSheet({ pageCount: 42 });
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('They will see the first 30 of 42 pages.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View and download' }));
    expect(screen.queryByText(/first 30 of 42/)).not.toBeInTheDocument();
  });

  it("a view-only link shows its pages, says it can't stop screenshots, and offers no download", async () => {
    const state = fresh({ sharePermission: 'view', shareOpensLeft: 2 });
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);

    await screen.findByText(/It can be opened twice more/);
    expect(screen.getByText(/It is not shared to download/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const pages = await screen.findByRole('list', {
      name: 'The pages of Flat 3 tenancy agreement',
    });
    const images = within(pages).getAllByRole('img');
    expect(images.map((i) => i.getAttribute('src'))).toEqual([
      '/api/v1/shared/items/doc-shared/pages/1',
      '/api/v1/shared/items/doc-shared/pages/2',
    ]);
    expect(images[0]).toHaveAccessibleName('Page 1 of 2');
    expect(screen.getByText(/cannot stop screenshots/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
    expect(state.calls.some((c) => c.url.endsWith('/content'))).toBe(false);
    await expectAccessible();
  });

  it('a 42-page document: the recipient gets 30 pages and the sentence', async () => {
    installFakeApi(
      fresh({
        sharePermission: 'view',
        shareSession: true,
        sharePages: { state: 'ready', shown: 30, total: 42 },
      }),
    );
    render(<SharePage token={null} />);
    const pages = await screen.findByRole('list', { name: /The pages of/ });
    expect(within(pages).getAllByRole('img')).toHaveLength(30);
    expect(screen.getByText('Pages after 30 were not shared.')).toBeInTheDocument();
  });

  it('a link opened before its pages are drawn says so, then shows them', async () => {
    const state = fresh({
      sharePermission: 'view',
      shareSession: true,
      sharePages: { state: 'drawing', shown: 2, total: 2 },
    });
    installFakeApi(state);
    render(<SharePage token={null} />);
    await screen.findByText(/The pages are still being drawn/);
    state.sharePages = { state: 'ready', shown: 2, total: 2 };
    await screen.findByRole('list', { name: /The pages of/ }, { timeout: 8000 });
    // Asked again inside the session, which counts nothing.
    expect(state.shareOpens).toBe(0);
  });

  it('a link opened as many times as it allows says so', async () => {
    installFakeApi(fresh({ shareOpensLeft: 0 }));
    render(<SharePage token={TOKEN} />);
    await screen.findByRole('heading', { name: 'This link cannot be opened' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /opened as many times as it allows, so it cannot be opened again/,
    );
    await expectAccessible();
  });

  it('the last open used by somebody else between the preview and Open says so too', async () => {
    const state = fresh({ shareOpensLeft: 1 });
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);
    await screen.findByText(/It can be opened once more/);
    state.shareOpensLeft = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'This link cannot be opened' });
    expect(screen.getByRole('alert')).toHaveTextContent(/as many times as it allows/);
  });

  it('downloads used up: no download is offered, and why', async () => {
    installFakeApi(fresh({ shareSession: true, shareDownloadsLeft: 0 }));
    render(<SharePage token={null} />);
    await screen.findByText(/downloaded from as many times as it allows/);
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('downloads used up: what this page has downloaded, it may download again (5.18 review)', async () => {
    installFakeApi(fresh({ shareSession: true, shareDownloadsLeft: 0, shareDownloaded: true }));
    render(<SharePage token={null} />);
    const again = await screen.findByRole('link', { name: 'Download tenancy.pdf' });
    expect(again).toHaveAttribute('href', '/api/v1/shared/items/doc-shared/content');
    expect(
      screen.getByText(/What this page has downloaded already, it can download again/),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('pages that do not come are not "in a minute" for ever: the page says so, and tries again (5.18 review)', async () => {
    const state = fresh({
      sharePermission: 'view',
      shareSession: true,
      sharePages: { state: 'drawing', shown: 2, total: 2 },
    });
    installFakeApi(state);
    render(<SharePage token={null} />);
    await screen.findByText(/The pages are still being drawn/);
    // Waiting asks what is open again (which asks the worker for them) ...
    await waitFor(() => expect(state.shareItemsAsked ?? 0).toBeGreaterThan(1), {
      timeout: 6000,
    });
    // ... and, some minutes on, stops saying "in a minute".
    const later = Date.now() + 4 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      await screen.findByText(
        /The pages could not be prepared\. Ask whoever sent the link/,
        {},
        {
          timeout: 6000,
        },
      );
      expect(screen.queryByText(/They will appear here in a minute/)).not.toBeInTheDocument();
      await expectAccessible();
      // Tried again, and drawn meanwhile: they come.
      state.sharePages = { state: 'ready', shown: 2, total: 2 };
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      const pages = await screen.findByRole('list', { name: /The pages of/ }, { timeout: 8000 });
      // The line that had the focus went with the wait: the pages have it,
      // not the page's body (the third review).
      await waitFor(() => expect(document.activeElement).toBe(pages));
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  it('Try again keeps the focus on the one line that says how the wait is going, and asks at once (second review)', async () => {
    const state = fresh({
      sharePermission: 'view',
      shareSession: true,
      sharePages: { state: 'drawing', shown: 2, total: 2 },
    });
    installFakeApi(state);
    render(<SharePage token={null} />);
    const waiting = await screen.findByText(/still being drawn/);
    expect(waiting).toHaveAttribute('role', 'status');
    const later = Date.now() + 4 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      await screen.findByText(/could not be prepared/, {}, { timeout: 6000 });
      // One line, the same one, its words changed: heard as they change.
      expect(screen.getByRole('status')).toBe(waiting);
      const asked = state.shareItemsAsked ?? 0;
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      // The button is gone; the focus is on the line, not lost to the page.
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(waiting);
      expect(waiting).toHaveTextContent(/still being drawn/);
      // Asked at once, not after the next wait.
      await waitFor(() => expect(state.shareItemsAsked ?? 0).toBeGreaterThan(asked), {
        timeout: 1000,
      });
      await expectAccessible();
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  it('a session or link that is over while the pages are awaited says so, not "could not be prepared" (second review)', async () => {
    for (const [over, words] of [
      [(s: ReturnType<typeof fresh>) => (s.shareSession = false), /open too long/],
      [(s: ReturnType<typeof fresh>) => (s.shareValid = false), /not valid any more/],
    ] as const) {
      const state = fresh({
        sharePermission: 'view',
        shareSession: true,
        sharePages: { state: 'drawing', shown: 2, total: 2 },
      });
      installFakeApi(state);
      const { unmount } = render(<SharePage token={null} />);
      await screen.findByText(/still being drawn/);
      over(state);
      await screen.findByRole('heading', { name: 'This link cannot be opened' }, { timeout: 6000 });
      expect(screen.getByRole('alert')).toHaveTextContent(words);
      expect(screen.queryByText(/could not be prepared/)).not.toBeInTheDocument();
      unmount();
    }
  }, 30_000);

  it('the vault out of reach for a moment is asked again, and the pages come (second review)', async () => {
    const state = fresh({
      sharePermission: 'view',
      shareSession: true,
      sharePages: { state: 'drawing', shown: 2, total: 2 },
    });
    installFakeApi(state);
    render(<SharePage token={null} />);
    await screen.findByText(/still being drawn/);
    // The next ask finds the vault out of reach.
    state.shareItemsFailing = 1;
    await waitFor(() => expect(state.shareItemsFailing).toBe(0), { timeout: 6000 });
    expect(screen.queryByText(/could not be prepared/)).not.toBeInTheDocument();
    state.sharePages = { state: 'ready', shown: 2, total: 2 };
    const pages = await screen.findByRole('list', { name: /The pages of/ }, { timeout: 8000 });
    // Nobody pressed anything: the pages come without taking the focus.
    expect(document.activeElement).not.toBe(pages);
  }, 30_000);
});

/**
 * Pressing Open replaces the form, and focus would fall to the page's body
 * with nothing said (the 5.16 review). Each phase's heading takes it
 * instead, a dead link is an alert, and the wait is a status.
 */
describe('a screen reader hears the page change', () => {
  it('the wait is a status, the preview and what Open opens each take the focus', async () => {
    const state = fresh();
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening the link…');

    const title = await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
    await waitFor(() => expect(title).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const download = await screen.findByRole('link', { name: 'Download tenancy.pdf' });
    const opened = screen.getByRole('heading', { level: 1 });
    expect(opened).not.toBe(title);
    await waitFor(() => expect(opened).toHaveFocus());
    expect(opened.parentElement).toContainElement(download);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('the heading given the focus as the page loads draws no ring: it is not a control', async () => {
    installFakeApi(fresh());
    render(<SharePage token={TOKEN} />);
    const title = await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
    await waitFor(() => expect(title).toHaveFocus());
    // Chromium rings an element focused by script before anybody has touched
    // the page; the stylesheet takes that ring away here.
    expect(CSS.length).toBeGreaterThan(1000);
    expect(ringless(title)).toBe(true);
    // A control keeps its ring.
    const open = screen.getByRole('button', { name: 'Open' });
    open.focus();
    expect(ringless(open)).toBe(false);
  });

  it('every place the app moves the focus to for a screen reader draws no ring, and no control loses one', () => {
    const focused = (html: string) => {
      const box = document.createElement('div');
      box.innerHTML = html;
      document.body.append(box);
      const el = box.firstElementChild as HTMLElement;
      el.focus();
      expect(el).toHaveFocus();
      const ringlessNow = ringless(el);
      box.remove();
      return ringlessNow;
    };
    // A heading a row left from, a status line, the facts a dialog returns to.
    for (const html of [
      '<h1 tabindex="-1">Links</h1>',
      '<h2 tabindex="-1">Your paused links</h2>',
      '<p class="notice" role="status" tabindex="-1">Done.</p>',
      '<dl class="facts" tabindex="-1"><dt>Issued</dt><dd>2021</dd></dl>',
    ]) {
      expect(focused(html), html).toBe(true);
    }
    // A control, even one focused by script (a menu's items, say), keeps it.
    for (const html of [
      '<button class="btn" tabindex="-1">Take it back</button>',
      '<button class="menu-item" role="menuitem" tabindex="-1">Rename</button>',
      '<a href="/settings" tabindex="-1">Settings</a>',
      '<input tabindex="-1" />',
      '<h2 tabindex="0">A heading somebody tabs to</h2>',
    ]) {
      expect(focused(html), html).toBe(false);
    }
  });

  it('a dead link is an alert, and its card takes the focus', async () => {
    installFakeApi(fresh({ shareValid: false }));
    render(<SharePage token={TOKEN} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Ask whoever sent it for a new one/);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'This link cannot be opened' })).toHaveFocus(),
    );
  });

  it('a link taken back between the preview and Open: the dead card takes the focus from Open', async () => {
    const state = fresh();
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);
    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
    state.shareValid = false;
    const open = screen.getByRole('button', { name: 'Open' });
    open.focus();
    fireEvent.click(open);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid any more/);
    const dead = screen.getByRole('heading', { name: 'This link cannot be opened' });
    await waitFor(() => expect(dead).toHaveFocus());
  });
});

describe('the hand-over', () => {
  const makeLink = async () => {
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
  };
  const WARNING = /starts with http:\/\//;

  it('warns the sharer when the link would start with http:// away from this computer', async () => {
    installFakeApi(fresh({ shareLinkUrl: `http://192.168.1.20:8080/s#${TOKEN}` }));
    await makeLink();
    await screen.findByText(`http://192.168.1.20:8080/s#${TOKEN}`);
    const warning = screen.getByText(WARNING);
    expect(warning).toHaveTextContent(/will not be able to download/);
    expect(warning).toHaveTextContent(/https:\/\//);
    await expectAccessible();
  });

  it('says nothing for an https link, or one on this computer', async () => {
    installFakeApi(fresh({ shareLinkUrl: `https://share.example.com/s#${TOKEN}` }));
    await makeLink();
    await screen.findByText(`https://share.example.com/s#${TOKEN}`);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('says nothing for a link on localhost', async () => {
    // No FDV_PUBLIC_URL: the link starts with this page's own origin, http://localhost here.
    installFakeApi(fresh());
    await makeLink();
    await screen.findByText(new RegExp(`^http://localhost(:\\d+)?/s#${TOKEN}$`));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});

describe('Settings → After a restore', () => {
  const paused = {
    id: 'sh-paused',
    document_id: 'doc-1',
    document_title: 'Mansoor’s passport',
    recipient_label: 'the embassy',
    created_by_name: 'Mansoor Seikh',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 864e5).toISOString(),
    has_pin: true,
    open_count: 1,
    last_opened_at: null,
    state: 'paused',
    flow: 'v2',
    paused_at: new Date().toISOString(),
    paused_reason: 'restored',
    summary: 'Shared with the embassy, opened once. Paused after a restore.',
  };

  it('is there only after a restore, and turns a paused link back on', async () => {
    const state = fresh({ shares: [{ ...paused }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: /After a restore/ }));
    await screen.findByText('Mansoor’s passport');
    expect(screen.getByText(/every link was paused/)).toBeInTheDocument();
    expect(screen.getByText(/For the embassy · made by Mansoor Seikh/)).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
    await screen.findByText('The link to “Mansoor’s passport” works again.');
    await waitFor(() => expect(state.shares[0]?.state).toBe('active'));
    expect(await screen.findByText(/Nothing is waiting/)).toBeInTheDocument();
  });

  it('to its maker a paused link offers only Take it back, and says a link to an Only me document needs a new one', async () => {
    const diary = {
      ...PASSPORT,
      id: 'doc-diary',
      title: 'My diary',
      visibility: 'private',
      owner_member_id: 'me',
    };
    const state = fresh({
      documents: [{ ...PASSPORT }, diary],
      shares: [
        // My own link to a household document: an owner's to decide (A55).
        { ...paused, id: 'sh-household', document_id: PASSPORT.id },
        // And to my own Only me document, which no owner can see: nobody's.
        { ...paused, id: 'sh-diary', document_id: diary.id, document_title: 'My diary' },
        // Somebody else's link is not mine to see here.
        {
          ...paused,
          id: 'sh-sams',
          document_id: PASSPORT.id,
          document_title: 'Sam’s passport',
          created_by_name: 'Sam',
        },
      ],
    });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    fireEvent.click(
      await screen.findByRole('link', { name: /After a restore.*2 links you made are paused/ }),
    );
    await screen.findByText('My diary');
    expect(screen.getByText('Mansoor’s passport')).toBeInTheDocument();
    expect(screen.queryByText('Sam’s passport')).not.toBeInTheDocument();

    // Only an owner turns a link back on; its maker may only take it back.
    expect(screen.queryByRole('button', { name: 'Turn back on' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Take it back' })).toHaveLength(2);
    expect(screen.getByText(/Only an owner can turn one back on/)).toBeInTheDocument();
    const onlyMe = screen.getByText(/No owner can see your Only me documents/);
    expect(onlyMe).toHaveTextContent(/so no one can turn a link to one of them back on/);
    expect(onlyMe).toHaveTextContent(/If it is still needed, take it back and make a new link/);
    await expectAccessible();

    const diaryRow = screen.getByText('My diary').closest('li') as HTMLElement;
    fireEvent.click(within(diaryRow).getByRole('button', { name: 'Take it back' }));
    await screen.findByText('The link to “My diary” is taken back for good.');
    expect(state.shares.map((s) => s.id)).not.toContain('sh-diary');
    expect(state.shares.find((s) => s.id === 'sh-household')?.state).toBe('paused');
    expect(state.calls.some((c) => c.url.endsWith('/resume'))).toBe(false);
  });

  it('an owner is not told somebody else decides', async () => {
    installFakeApi(fresh({ shares: [{ ...paused }] }));
    signedIn();
    window.history.replaceState({}, '', '/settings/after-restore');
    render(<App />);
    await screen.findByText('Mansoor’s passport');
    expect(screen.getByRole('button', { name: 'Turn back on' })).toBeInTheDocument();
    expect(screen.queryByText(/Only an owner can/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No owner can see/)).not.toBeInTheDocument();
  });

  it('is not in Settings when nothing is paused', async () => {
    const state = fresh({ shares: [{ ...paused, state: 'active', paused_at: null }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);
    await screen.findByRole('link', { name: /How you hear about things/ });
    await waitFor(() =>
      expect(state.calls.some((c) => c.url === '/api/v1/after-restore')).toBe(true),
    );
    expect(screen.queryByRole('link', { name: /After a restore/ })).not.toBeInTheDocument();
  });
});
