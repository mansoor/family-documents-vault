import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reopenOnNewLink, takeLinkToken } from './link-token.js';
import { DropPage } from './screens/DropPage.js';
import { DROP_REQUEST_ID, fresh, freshDrop, installFakeApi, type FakeDrop } from './test-api.js';

const TOKEN = 'drop-secret-0123456789abcdef';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  // jsdom has no isSecureContext; a test that gives it one takes it away.
  delete (window as { isSecureContext?: boolean }).isSecureContext;
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** The page at /drop, with a request as said; the state, to look at what was asked. */
function page(drop: Partial<FakeDrop> = {}, over: Parameters<typeof fresh>[0] = {}) {
  const state = fresh({ drop: freshDrop(drop), ...over });
  installFakeApi(state);
  render(<DropPage token={TOKEN} />);
  return state;
}

/** Open pressed, and the request open. */
async function opened(drop: Partial<FakeDrop> = {}) {
  const state = page(drop);
  fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
  await screen.findByRole('heading', { name: 'Tax papers for 2025' });
  return state;
}

const pdf = (name: string, bytes = 2048) =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

/** Files chosen for one of the things asked for. */
function choose(slot: string, ...files: File[]) {
  fireEvent.change(screen.getByLabelText(`Choose files for ${slot}`), { target: { files } });
}

const callsTo = (state: ReturnType<typeof fresh>, url: string) =>
  state.calls.filter((c) => c.url === url);

describe('the page a request opens (5.22)', () => {
  it('the token leaves the address bar', async () => {
    window.history.replaceState({ kept: true }, '', `/drop#${TOKEN}`);
    expect(takeLinkToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.href).toMatch(/\/drop$/);
    expect(window.location.href).not.toContain(TOKEN);
    // The same history entry, its state kept: Back does not bring it back.
    expect(window.history.state).toEqual({ kept: true });
    expect(takeLinkToken()).toBeNull();

    // And the page sends it in a body, never in an address.
    const state = page();
    await screen.findByRole('heading', { name: 'Send documents to The Seikh family' });
    expect(state.calls.map((c) => c.url)).toEqual(['/api/v1/drop/preview']);
    expect(state.calls[0]?.body).toEqual({ token: TOKEN });
    expect(state.calls.every((c) => !c.url.includes(TOKEN))).toBe(true);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('a link pasted into a tab already at /drop loads the page again, to read it', () => {
    const reload = vi.fn();
    const stop = reopenOnNewLink(reload);
    window.history.replaceState({}, '', `/drop#${TOKEN}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    stop();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('before Open: whose vault and who asked, and nothing counted or shown of the request', async () => {
    const state = page();
    const title = await screen.findByRole('heading', {
      name: 'Send documents to The Seikh family',
    });
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.getByText('Mansoor Seikh')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is opened until you press Open/)).toBeInTheDocument();
    // Not what, or why: those wait for Open.
    expect(screen.queryByText('Tax papers for 2025')).not.toBeInTheDocument();
    expect(screen.queryByText(/W-2/)).not.toBeInTheDocument();
    expect(state.drop?.opens).toBe(0);
    await expectAccessible();
  });

  it('a password and a code: the code field is always there, and Open sends both in its body', async () => {
    const state = page({ password: 'abcd-efgh-jkmn', code: '123456' });
    await screen.findByText(/Open asks for the password they gave you, and a code/);
    // A code already in the inbox is typed without sending another (W520-1).
    const code = screen.getByLabelText('The code from the email');
    expect(code).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByText('We sent a code to j•••@e•••.com.')).toBeInTheDocument();
    await waitFor(() => expect(code).toHaveFocus());
    fireEvent.change(screen.getByLabelText('The password they gave you'), {
      target: { value: 'abcd-efgh-jkmn' },
    });
    fireEvent.change(code, { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'Tax papers for 2025' });
    expect(callsTo(state, '/api/v1/drop/unlock')[0]?.body).toEqual({
      token: TOKEN,
      password: 'abcd-efgh-jkmn',
      code: '123456',
    });
    expect(sessionStorage.getItem('fdv.drop.request')).toBe(DROP_REQUEST_ID);
    expect(sessionStorage.getItem('fdv.drop.request')).not.toContain(TOKEN);
  });

  it('this browser only: the advice comes before Open', async () => {
    page({ thisDevice: true });
    expect(
      await screen.findByText(/It opens only in the first browser that opens it/),
    ).toHaveTextContent(/not a private window, or the browser inside your email app/);
  });

  it('files are chosen per slot and sent with progress; one is removed before Finish; then a note, and Finish', async () => {
    let release: () => void = () => undefined;
    const state = await opened();
    // What they asked for, and what it takes.
    expect(screen.getByText(/Everything for the 2025 return/)).toBeInTheDocument();
    expect(screen.getByTestId('drop-room')).toHaveTextContent(
      'You can send 10 more files, 200 MB in all, each up to 100 MB. PDFs and photos.',
    );
    for (const name of ['W-2', '1099', 'Anything else']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    await expectAccessible();

    // Held halfway: its progress is shown, and the page waits for it.
    state.hold = (method, path) =>
      method === 'POST' && path === '/api/v1/drop/files'
        ? new Promise<void>((r) => {
            release = r;
          })
        : undefined;
    choose('W-2', pdf('w2-2025.pdf', 4000));
    const progress = await screen.findByRole('progressbar', { name: 'Sending w2-2025.pdf' });
    await waitFor(() => expect(progress).toHaveAttribute('value', '2000'));
    expect(screen.getByText('50% of 4 KB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish' })).toBeDisabled();
    await expectAccessible();
    delete state.hold;
    release();

    const w2 = screen.getByRole('region', { name: 'W-2' });
    await within(w2).findByRole('button', { name: 'Remove w2-2025.pdf' });
    expect(await screen.findByText('Sent “w2-2025.pdf”.')).toBeInTheDocument();
    choose('1099', pdf('1099-int.pdf'), pdf('1099-div.pdf'));
    const other = screen.getByRole('region', { name: '1099' });
    // One at a time, in the order chosen: both in, each with its Remove.
    await within(other).findByRole('button', { name: 'Remove 1099-int.pdf' });
    await within(other).findByRole('button', { name: 'Remove 1099-div.pdf' });
    // Each said which request it is for, and which thing it is.
    const sent = callsTo(state, '/api/v1/drop/files');
    expect(sent.map((c) => c.body)).toEqual([
      { item_id: 'item-w2', file: 'w2-2025.pdf' },
      { item_id: 'item-1099', file: '1099-int.pdf' },
      { item_id: 'item-1099', file: '1099-div.pdf' },
    ]);
    expect(sent.every((c) => c.headers?.['x-fdv-drop-request'] === DROP_REQUEST_ID)).toBe(true);

    // One taken out again, before Finish.
    fireEvent.click(within(other).getByRole('button', { name: 'Remove 1099-div.pdf' }));
    const said = await screen.findByText('Removed “1099-div.pdf”. It will not be sent.');
    await waitFor(() => expect(said).toHaveFocus());
    expect(within(other).queryByText('1099-div.pdf')).not.toBeInTheDocument();
    const removed = state.calls.find((c) => c.method === 'DELETE');
    expect(removed?.url).toBe('/api/v1/drop/files/file-3-1099-div.pdf');
    expect(removed?.headers?.['x-fdv-drop-request']).toBe(DROP_REQUEST_ID);

    fireEvent.change(screen.getByLabelText(/A note for Mansoor Seikh/), {
      target: { value: 'The 1099-DIV comes next week.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finish and send 2 files' }));
    const done = await screen.findByRole('heading', { name: 'Sent' });
    await waitFor(() => expect(done).toHaveFocus());
    expect(
      screen.getByText('2 files went to Mansoor Seikh at The Seikh family.'),
    ).toBeInTheDocument();
    expect(state.drop?.finished).toEqual({ note: 'The 1099-DIV comes next week.', files: 2 });
    expect(callsTo(state, '/api/v1/drop/finish')[0]?.headers?.['x-fdv-drop-request']).toBe(
      DROP_REQUEST_ID,
    );
    expect(sessionStorage.getItem('fdv.drop.request')).toBeNull();
    await expectAccessible();
  });

  it('a file on its way can be stopped, and nothing of it is listed', async () => {
    const state = await opened();
    state.hold = () => new Promise<void>(() => undefined);
    choose('W-2', pdf('w2-2025.pdf'));
    await screen.findByRole('progressbar', { name: 'Sending w2-2025.pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop sending w2-2025.pdf' }));
    expect(await screen.findByText('Stopped sending “w2-2025.pdf”.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(state.drop?.files).toEqual([]);
  });

  it('plain words for a file too large, of the wrong kind, or with macros', async () => {
    const state = await opened({ maxFileBytes: 3000, accept: 'office' });
    choose('W-2', pdf('scan.pdf', 5000));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'That file is too big: one file can be 3 KB at most.',
    );
    // Said before any of it was sent.
    expect(callsTo(state, '/api/v1/drop/files')).toEqual([]);
    fireEvent.click(within(w2).getByRole('button', { name: 'Dismiss scan.pdf' }));
    expect(within(w2).queryByRole('alert')).not.toBeInTheDocument();

    choose('W-2', new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }));
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'That kind of file cannot be sent here. PDFs, photos, and Word or Excel files are fine.',
    );
    expect(within(w2).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    fireEvent.click(within(w2).getByRole('button', { name: 'Dismiss setup.exe' }));

    choose(
      '1099',
      new File(['PK'], 'figures.docm', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    const other = screen.getByRole('region', { name: '1099' });
    expect(await within(other).findByRole('alert')).toHaveTextContent(
      /Word and Excel files with macros.*can't be sent here/,
    );
    await expectAccessible();
  });

  it('the vault busy for a moment: said plainly, and the file sent again with Try again', async () => {
    const state = await opened();
    state.drop!.busy = 1;
    choose('W-2', pdf('w2-2025.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'The vault was busy for a moment, and nothing of it was kept. Try again.',
    );
    fireEvent.click(within(w2).getByRole('button', { name: 'Try again' }));
    await within(w2).findByRole('button', { name: 'Remove w2-2025.pdf' });
    expect(within(w2).queryByRole('alert')).not.toBeInTheDocument();
    expect(state.drop?.files.map((f) => f.name)).toEqual(['w2-2025.pdf']);
  });

  it('busy at Open: nothing counted, and Open can be pressed again', async () => {
    const state = page();
    await screen.findByRole('heading', { name: 'Send documents to The Seikh family' });
    state.drop!.busy = 1;
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The vault was busy for a moment, and nothing was counted. Press Open again.',
    );
    expect(state.drop?.opens).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'Tax papers for 2025' });
    expect(state.drop?.opens).toBe(1);
  });

  it('a request taken back, used up, or for another browser says so, and its card takes the focus', async () => {
    page({ valid: false });
    const dead = await screen.findByRole('heading', { name: 'This link cannot be opened' });
    await waitFor(() => expect(dead).toHaveFocus());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That link is not valid any more. Ask whoever sent it for a new one.',
    );
  });

  it('opened as many times as it allows', async () => {
    page({ usedUp: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /opened as many times as it allows, so it cannot be opened again/,
    );
  });

  it('opened in another browser already', async () => {
    page({ otherDevice: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This link has been opened in another browser already, and it only opens there. Open it in the browser you opened it in first, or ask Mansoor Seikh for a new one.',
    );
  });

  it('a wrong password says try again; the tenth locks it, and the page says so', async () => {
    const state = page({ password: 'abcd-efgh-jkmn', triesLeft: 2 });
    const password = await screen.findByLabelText('The password they gave you');
    fireEvent.change(password, { target: { value: 'wrong one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That is not right. Check what you were sent, and try again.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dead = await screen.findByRole('heading', { name: 'This link cannot be opened' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The password or code was typed wrong too many times, so this link has stopped working. Ask Mansoor Seikh for a new one.',
    );
    await waitFor(() => expect(dead).toHaveFocus());
    expect(state.drop?.opens).toBe(0);
  });

  it('past its end while open: said as the end, not as something gone wrong', async () => {
    const state = await opened({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    // The end passes, and the vault ends the session with it.
    state.drop!.expiresAt = new Date(Date.now() - 1000).toISOString();
    state.drop!.session = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    choose('W-2', pdf('w2-2025.pdf'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /This request has ended: it worked until .*Ask Mansoor Seikh for a new link/,
    );
    vi.restoreAllMocks();
  });

  it('reloaded after Open, it finds what it had open without the token', async () => {
    const state = fresh({ drop: freshDrop({ session: true, files: [] }) });
    installFakeApi(state);
    sessionStorage.setItem('fdv.drop.request', DROP_REQUEST_ID);
    render(<DropPage token={null} />);
    await screen.findByRole('heading', { name: 'Tax papers for 2025' });
    expect(state.calls.map((c) => c.url)).toEqual(['/api/v1/drop/session']);
    expect(state.calls[0]?.headers?.['x-fdv-drop-request']).toBe(DROP_REQUEST_ID);
  });

  it('with no link and nothing open, it says to open the link again', async () => {
    installFakeApi(fresh());
    render(<DropPage token={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Open the link from their message again — the whole of it/,
    );
  });

  it('over plain http Open is off and says why, so nothing is counted', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const state = page();
    expect(await screen.findByRole('note')).toHaveTextContent(/not on a secure connection/);
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(callsTo(state, '/api/v1/drop/unlock')).toEqual([]);
  });
});
