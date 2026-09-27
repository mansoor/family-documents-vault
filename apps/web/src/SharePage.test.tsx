import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { SharePage, takeLinkToken } from './screens/SharePage.js';
import { fresh, installFakeApi, PASSPORT, signedIn } from './test-api.js';

const TOKEN = 'share-secret-0123456789abcdef';

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

  it('to anybody but an owner it offers only links to their own Only me documents, and says an owner decides the rest', async () => {
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
        // Sam's own link to a household document: an owner's to decide (A55).
        { ...paused, id: 'sh-household', document_id: PASSPORT.id },
        { ...paused, id: 'sh-diary', document_id: diary.id, document_title: 'My diary' },
      ],
    });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: /After a restore.*1 link is paused/ }));
    await screen.findByText('My diary');
    expect(screen.queryByText('Mansoor’s passport')).not.toBeInTheDocument();
    expect(
      screen.getByText(/An owner decides about links to documents others can see/),
    ).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
    await screen.findByText('The link to “My diary” works again.');
    expect(state.shares.find((s) => s.id === 'sh-household')?.state).toBe('paused');
  });

  it('an owner is not told somebody else decides', async () => {
    installFakeApi(fresh({ shares: [{ ...paused }] }));
    signedIn();
    window.history.replaceState({}, '', '/settings/after-restore');
    render(<App />);
    await screen.findByText('Mansoor’s passport');
    expect(screen.queryByText(/An owner decides/)).not.toBeInTheDocument();
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
