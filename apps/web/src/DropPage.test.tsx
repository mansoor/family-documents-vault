import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reopenOnNewLink, takeLinkToken } from './link-token.js';
import { DropPage } from './screens/DropPage.js';
import { DROP_REQUEST_ID, fresh, freshDrop, installFakeApi, type FakeDrop } from './test-api.js';

const TOKEN = 'drop-secret-0123456789abcdef';

/** The web's stylesheet, read from disk: under Vitest an import of it is empty. */
const CSS = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') : '';
})();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

/** Files chosen for one of the things asked for, as the slot's hidden chooser takes them. */
function choose(slot: string, ...files: File[]) {
  fireEvent.change(screen.getByLabelText(`File chooser for ${slot}`), { target: { files } });
}

const callsTo = (state: ReturnType<typeof fresh>, url: string) =>
  state.calls.filter((c) => c.url === url);

/** A promise and the function that settles it: a vault that answers when the test says. */
function later() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/** The page's one status line. */
const statusLine = () =>
  screen.getAllByRole('status').find((el) => el.classList.contains('notice')) as HTMLElement;

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

    // And the page sends it in a body, never in an address; then asks
    // whether this browser has the request open already, by its id.
    const state = page();
    await screen.findByRole('heading', { name: 'Send documents to The Seikh family' });
    expect(state.calls.map((c) => c.url)).toEqual(['/api/v1/drop/preview', '/api/v1/drop/session']);
    expect(state.calls[0]?.body).toEqual({ token: TOKEN });
    expect(state.calls[1]?.headers?.['x-fdv-drop-request']).toBe(DROP_REQUEST_ID);
    expect(state.calls.every((c) => !c.url.includes(TOKEN))).toBe(true);
    expect(JSON.stringify(state.calls[1])).not.toContain(TOKEN);
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

  it('a password and a code: where the code goes is said first, its field is always there, and Open sends both in its body', async () => {
    const state = page({ password: 'abcd-efgh-jkmn', code: '123456' });
    await screen.findByText(/Open asks for the password they gave you, and a code/);
    // Where it goes, masked, before any is sent (5.22 review).
    expect(within(screen.getByTestId('drop-code')).getByText('j•••@e•••.com')).toBeInTheDocument();
    // A code already in the inbox is typed without sending another (W520-1).
    const code = screen.getByLabelText('The code from the email');
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

  it('opened in another browser already: said before Open is pressed, which is not offered', async () => {
    const state = page({ thisDevice: true, code: '123456', otherDevice: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This link has been opened in another browser already, and it only opens there. Open it in the browser you opened it in first, or ask Mansoor Seikh for a new one.',
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'This link cannot be opened' })).toHaveFocus(),
    );
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.queryByText(/j•••/)).not.toBeInTheDocument();
    expect(callsTo(state, '/api/v1/drop/unlock')).toEqual([]);
    expect(callsTo(state, '/api/v1/drop/code')).toEqual([]);
  });

  it('files are chosen per slot and sent with progress; one is removed before Finish; then a note, and Finish', async () => {
    const answer = later();
    const state = await opened();
    // What they asked for, and what it takes.
    expect(screen.getByText(/Everything for the 2025 return/)).toBeInTheDocument();
    expect(screen.getByTestId('drop-room')).toHaveTextContent(
      'You can send 10 more files, 200 MB in all, each up to 100 MB. PDFs and photos.',
    );
    for (const name of ['W-2', '1099', 'Anything else']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
      // Each slot's button says which slot it is for (5.22 review).
      expect(screen.getByRole('button', { name: `Choose files for ${name}` })).toBeVisible();
    }
    await expectAccessible();

    // Held halfway: its progress is shown, and the page waits for it.
    state.hold = (method, path) =>
      method === 'POST' && path === '/api/v1/drop/files' ? answer.promise : undefined;
    choose('W-2', pdf('w2-2025.pdf', 4000));
    const progress = await screen.findByRole('progressbar', { name: 'Sending w2-2025.pdf' });
    await waitFor(() => expect(progress).toHaveAttribute('value', '2000'));
    expect(screen.getByText('50% of 4 KB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish' })).toBeDisabled();
    await expectAccessible();
    delete state.hold;
    answer.release();

    const w2 = screen.getByRole('region', { name: 'W-2' });
    await within(w2).findByRole('button', { name: 'Remove w2-2025.pdf' });
    expect(statusLine()).toHaveTextContent('Sent “w2-2025.pdf”. 1 file is ready to send.');
    expect(within(w2).getByRole('button', { name: 'Add more files for W-2' })).toBeVisible();
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
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        'Removed “1099-div.pdf”. It will not be sent. 2 files are ready to send.',
      ),
    );
    await waitFor(() => expect(statusLine()).toHaveFocus());
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

  it('a file on its way is really stopped: let go afterwards, the vault never has it', async () => {
    const answer = later();
    const state = await opened();
    state.hold = (method, path) =>
      method === 'POST' && path === '/api/v1/drop/files' ? answer.promise : undefined;
    choose('W-2', pdf('w2-2025.pdf'));
    await screen.findByRole('progressbar', { name: 'Sending w2-2025.pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop sending w2-2025.pdf' }));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        'Stopped sending “w2-2025.pdf”. Nothing of it was kept.',
      ),
    );
    // The focus goes to what was said, not to the page's start.
    await waitFor(() => expect(statusLine()).toHaveFocus());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // The vault would have answered now: it was stopped, so it never does.
    delete state.hold;
    answer.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.drop?.files).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Remove w2-2025.pdf' })).not.toBeInTheDocument();
  });

  it('every byte gone: Stop gives way to Arriving…, and the file is listed once the vault has it', async () => {
    const answer = later();
    const state = await opened();
    state.holdAnswer = () => answer.promise;
    choose('W-2', pdf('w2-2025.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByText(/Arriving… the vault is checking it/)).toBeInTheDocument();
    expect(within(w2).queryByRole('button', { name: /Stop sending/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish' })).toBeDisabled();
    delete state.holdAnswer;
    answer.release();
    await within(w2).findByRole('button', { name: 'Remove w2-2025.pdf' });
  });

  it('Stop pressed after the vault already has the file: it is listed, said so, and Finish counts it', async () => {
    const answer = later();
    const state = await opened();
    state.dropCommitFirst = true;
    state.holdAnswer = () => answer.promise;
    choose('W-2', pdf('w2-2025.pdf'));
    await screen.findByRole('progressbar', { name: 'Sending w2-2025.pdf' });
    await waitFor(() => expect(state.drop?.files).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop sending w2-2025.pdf' }));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        '“w2-2025.pdf” had already arrived, so it is listed: remove it if you do not want it sent.',
      ),
    );
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(within(w2).getByRole('button', { name: 'Remove w2-2025.pdf' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Finish and send 1 file' })).toBeEnabled();
    answer.release();
  });

  it('Finish reads what the vault has first, and says so when it is not what the page shows', async () => {
    const state = await opened();
    choose('W-2', pdf('w2-2025.pdf'));
    await screen.findByRole('button', { name: 'Remove w2-2025.pdf' });
    // Another tab of this browser sent one too, into the same session.
    state.drop?.files.push({
      id: 'file-other',
      name: 'from-the-other-tab.pdf',
      content_type: 'application/pdf',
      byte_size: 100,
      item_id: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finish and send 1 file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The vault has 2 files from this page, listed now. Look at the list, then press Finish again.',
    );
    expect(callsTo(state, '/api/v1/drop/finish')).toEqual([]);
    expect(
      screen.getByRole('button', { name: 'Remove from-the-other-tab.pdf' }),
    ).toBeInTheDocument();
    // Back on Finish, turned on again, not left on the page's start (N522W-4).
    const finish = screen.getByRole('button', { name: 'Finish and send 2 files' });
    await waitFor(() => expect(finish).toHaveFocus());
    fireEvent.click(finish);
    expect(await screen.findByText(/2 files went to Mansoor Seikh/)).toBeInTheDocument();
    expect(state.drop?.finished?.files).toBe(2);
  });

  it('the same link in a second tab carries on in the first one’s session, and strands none of its files', async () => {
    // Tab A opens it and sends a file.
    const state = await opened();
    choose('W-2', pdf('from-tab-a.pdf'));
    await screen.findByRole('button', { name: 'Remove from-tab-a.pdf' });
    expect(state.drop?.opens).toBe(1);
    // Tab B: the same link, in the same browser — a tab of its own.
    sessionStorage.clear();
    render(<DropPage token={TOKEN} />);
    const notes = await screen.findAllByText(/This link is open in this browser already/);
    expect(notes).toHaveLength(1);
    // Carried on, not opened again: no second session, A's file still there to send.
    expect(state.drop?.opens).toBe(1);
    expect(state.drop?.sessionNo).toBe(1);
    expect(callsTo(state, '/api/v1/drop/unlock')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Remove from-tab-a.pdf' })).toHaveLength(2);
    expect(sessionStorage.getItem('fdv.drop.request')).toBe(DROP_REQUEST_ID);
  });

  it('a tab on the preview when another tab opens it: Open carries on there instead of opening again', async () => {
    const state = page();
    await screen.findByRole('button', { name: 'Open' });
    // Meanwhile another tab of this browser opened it, and sent a file.
    Object.assign(state.drop as FakeDrop, { session: true, sessionNo: 1, opens: 1 });
    state.drop?.files.push({
      id: 'file-a',
      name: 'from-tab-a.pdf',
      content_type: 'application/pdf',
      byte_size: 100,
      item_id: 'item-w2',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText(/This link is open in this browser already/);
    expect(callsTo(state, '/api/v1/drop/unlock')).toEqual([]);
    expect(state.drop?.opens).toBe(1);
    expect(screen.getByRole('button', { name: 'Remove from-tab-a.pdf' })).toBeInTheDocument();
  });

  it('a reload whose session call fails for a moment keeps the request, and Try again finds it', async () => {
    for (const fail of [{ sessionDrops: 1 }, { sessionBusy: 1 }]) {
      const state = fresh({ drop: freshDrop({ session: true, ...fail }) });
      installFakeApi(state);
      sessionStorage.setItem('fdv.drop.request', DROP_REQUEST_ID);
      const { unmount } = render(<DropPage token={null} />);
      const heading = await screen.findByRole('heading', { name: 'Not reached just now' });
      expect(screen.getByRole('alert')).toHaveTextContent(/Nothing was lost/);
      await waitFor(() => expect(heading).toHaveFocus());
      // Not forgotten: a reload, or Try again, finds it.
      expect(sessionStorage.getItem('fdv.drop.request')).toBe(DROP_REQUEST_ID);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findByRole('heading', { name: 'Tax papers for 2025' });
      expect(state.drop?.opens).toBe(0);
      unmount();
    }
  });

  it('a reload whose session has ended forgets the request, and says to open the link again', async () => {
    installFakeApi(fresh({ drop: freshDrop({ session: false }) }));
    sessionStorage.setItem('fdv.drop.request', DROP_REQUEST_ID);
    render(<DropPage token={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Open the link from their message again/,
    );
    expect(sessionStorage.getItem('fdv.drop.request')).toBeNull();
  });

  it('a reload while another link’s preview shows does not land in the first request', async () => {
    // This tab had request A open; then the link to C was followed in it.
    sessionStorage.setItem('fdv.drop.request', 'a-request-this-tab-had-before');
    const state = fresh({ drop: freshDrop() });
    installFakeApi(state);
    const { unmount } = render(<DropPage token={TOKEN} />);
    await screen.findByRole('button', { name: 'Open' });
    expect(sessionStorage.getItem('fdv.drop.request')).toBeNull();
    unmount();
    // Reloaded: the token is gone, and so is A.
    render(<DropPage token={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Open the link from their message again/,
    );
    expect(state.calls.some((c) => c.headers?.['x-fdv-drop-request']?.startsWith('a-'))).toBe(
      false,
    );
  });

  it('a failed check after a file arrives keeps the file listed, and says the list may be behind', async () => {
    const state = await opened();
    (state.drop as FakeDrop).sessionDrops = 1;
    choose('W-2', pdf('w2-2025.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    await within(w2).findByRole('button', { name: 'Remove w2-2025.pdf' });
    expect(await screen.findByText(/this list may be behind/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish and send 1 file' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText(/this list may be behind/)).toBeNull());
    expect(within(w2).getByRole('button', { name: 'Remove w2-2025.pdf' })).toBeVisible();
    // The button went with the warning: the focus goes to what was said (N522W-4).
    await waitFor(() => expect(statusLine()).toHaveFocus());
    expect(statusLine()).toHaveTextContent('The list is up to date. 1 file is ready to send.');
  });

  it('a second file of the same name is heard as well as the first', async () => {
    await opened();
    choose('W-2', pdf('image.pdf'));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent('Sent “image.pdf”. 1 file is ready to send.'),
    );
    choose('1099', pdf('image.pdf'));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent('Sent “image.pdf”. 2 files are ready to send.'),
    );
  });

  it('files past the room left are said at once, and never sent', async () => {
    const state = await opened({ maxFiles: 2 });
    choose('W-2', pdf('one.pdf'), pdf('two.pdf'), pdf('three.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'This request takes 2 files, and that many have been sent.',
    );
    await within(w2).findByRole('button', { name: 'Remove two.pdf' });
    expect(callsTo(state, '/api/v1/drop/files').map((c) => c.body)).toEqual([
      { item_id: 'item-w2', file: 'one.pdf' },
      { item_id: 'item-w2', file: 'two.pdf' },
    ]);
    // Room made by removing one: Try again sends it.
    fireEvent.click(within(w2).getByRole('button', { name: 'Remove one.pdf' }));
    await waitFor(() => expect(statusLine()).toHaveTextContent(/Removed “one.pdf”/));
    fireEvent.click(within(w2).getByRole('button', { name: 'Try three.pdf again' }));
    await within(w2).findByRole('button', { name: 'Remove three.pdf' });
  });

  it('plain words for a file too large, of the wrong kind, or with macros; the focus is kept', async () => {
    const state = await opened({ maxFileBytes: 3000, accept: 'office' });
    choose('W-2', pdf('scan.pdf', 5000));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'That file is too big: one file can be 3 KB at most.',
    );
    // Said before any of it was sent, and not offered again: it would not fit.
    expect(callsTo(state, '/api/v1/drop/files')).toEqual([]);
    expect(within(w2).queryByRole('button', { name: /Try scan.pdf again/ })).toBeNull();
    fireEvent.click(within(w2).getByRole('button', { name: 'Dismiss scan.pdf' }));
    expect(within(w2).queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(statusLine()).toHaveFocus());
    expect(statusLine()).toHaveTextContent('Took “scan.pdf” off the list: it was not sent.');

    choose('W-2', new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }));
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'That kind of file cannot be sent here. PDFs, photos, and Word or Excel files are fine.',
    );
    expect(within(w2).queryByRole('button', { name: /Try setup.exe again/ })).toBeNull();
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
    (state.drop as FakeDrop).busy = 1;
    choose('W-2', pdf('w2-2025.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'The vault was busy for a moment, and nothing of it was kept. Try again.',
    );
    fireEvent.click(within(w2).getByRole('button', { name: 'Try w2-2025.pdf again' }));
    await waitFor(() => expect(statusLine()).toHaveFocus());
    await within(w2).findByRole('button', { name: 'Remove w2-2025.pdf' });
    expect(within(w2).queryByRole('alert')).not.toBeInTheDocument();
    expect(state.drop?.files.map((f) => f.name)).toEqual(['w2-2025.pdf']);
  });

  it('a file waiting its turn is taken off the list by Stop, and the focus goes to what was said', async () => {
    const answer = later();
    const state = await opened();
    state.hold = () => answer.promise;
    choose('W-2', pdf('first.pdf'), pdf('second.pdf'));
    await screen.findByText(/Waiting/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop sending second.pdf' }));
    await waitFor(() => expect(statusLine()).toHaveFocus());
    expect(statusLine()).toHaveTextContent('Took “second.pdf” off the list: it was not sent.');
    delete state.hold;
    answer.release();
    await screen.findByRole('button', { name: 'Remove first.pdf' });
    expect(state.drop?.files.map((f) => f.name)).toEqual(['first.pdf']);
  });

  it('busy at Open: nothing counted, and Open can be pressed again', async () => {
    const state = page();
    await screen.findByRole('heading', { name: 'Send documents to The Seikh family' });
    (state.drop as FakeDrop).busy = 1;
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The vault was busy for a moment, and nothing was counted. Press Open again.',
    );
    expect(state.drop?.opens).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'Tax papers for 2025' });
    expect(state.drop?.opens).toBe(1);
  });

  it('a request taken back says so, and its card takes the focus', async () => {
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

  it('a wrong password says try again, and the focus goes back to it; the tenth locks it, and the page says so', async () => {
    const state = page({ password: 'abcd-efgh-jkmn', triesLeft: 2 });
    const password = await screen.findByLabelText('The password they gave you');
    fireEvent.change(password, { target: { value: 'wrong one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That is not right. Check what you were sent, and try again.',
    );
    await waitFor(() => expect(password).toHaveFocus());
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
    (state.drop as FakeDrop).expiresAt = new Date(Date.now() - 1000).toISOString();
    (state.drop as FakeDrop).session = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    choose('W-2', pdf('w2-2025.pdf'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /This request has ended: it worked until .*Ask Mansoor Seikh for a new link/,
    );
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

  it('a session under this request’s name that is another request’s is not carried on in (N522S-2)', async () => {
    const state = await opened();
    (state.drop as FakeDrop).foreignSession = true;
    sessionStorage.clear();
    render(<DropPage token={TOKEN} />);
    // The preview, with Open: not somebody else's request's page.
    await screen.findByRole('button', { name: 'Open' });
    expect(screen.queryByText(/This link is open in this browser already/)).toBeNull();
    expect(screen.queryByText('Somebody else’s request')).toBeNull();
    expect(sessionStorage.getItem('fdv.drop.request')).toBeNull();
  });

  it('its last visit in use in this browser: a second tab still carries on (N522S-3)', async () => {
    const state = await opened();
    choose('W-2', pdf('w2-2025.pdf'));
    await screen.findByRole('button', { name: 'Remove w2-2025.pdf' });
    // That Open was the last the request allows.
    (state.drop as FakeDrop).usedUp = true;
    sessionStorage.clear();
    render(<DropPage token={TOKEN} />);
    await screen.findByText(/This link is open in this browser already/);
    expect(screen.getAllByRole('button', { name: 'Remove w2-2025.pdf' })).toHaveLength(2);
    expect(screen.queryByText(/opened as many times as it allows/)).toBeNull();
    expect(callsTo(state, '/api/v1/drop/unlock')).toHaveLength(1);
  });

  it('a file the vault kept whose answer was lost is listed, not called lost (N522W-1)', async () => {
    const state = await opened();
    state.dropAnswerLost = true;
    choose('W-2', pdf('w2-2025.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    await within(w2).findByRole('button', { name: 'Remove w2-2025.pdf' });
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        '“w2-2025.pdf” arrived after all, so it is listed. 1 file is ready to send.',
      ),
    );
    await waitFor(() => expect(statusLine()).toHaveFocus());
    expect(within(w2).queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Finish and send 1 file' })).toBeEnabled();
  });

  it('a file the vault never had, whose answer was lost, is said to be lost, and can be sent again', async () => {
    const state = await opened();
    // The connection drops before the vault has it: nothing arrives.
    state.dropConnectionLost = true;
    choose('W-2', pdf('w2-2025.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'It did not reach the vault: the connection dropped. Try again.',
    );
    expect(state.drop?.files).toEqual([]);
  });

  it('refused for want of room, the list and the room line catch up with the vault (N522W-1)', async () => {
    const state = await opened({ maxFiles: 1 });
    // Another tab of this browser sent the one file it takes, unseen here.
    state.drop?.files.push({
      id: 'file-other',
      name: 'from-the-other-tab.pdf',
      content_type: 'application/pdf',
      byte_size: 100,
      item_id: null,
    });
    choose('W-2', pdf('w2-2025.pdf'));
    const w2 = screen.getByRole('region', { name: 'W-2' });
    expect(await within(w2).findByRole('alert')).toHaveTextContent(
      'This request takes 1 files, and that many have been sent.',
    );
    await screen.findByRole('button', { name: 'Remove from-the-other-tab.pdf' });
    await waitFor(() =>
      expect(screen.getByTestId('drop-room')).toHaveTextContent(/It takes no more files/),
    );
  });

  it('after Remove, a file that fits is not refused as too big before the vault answers (N522W-2)', async () => {
    const state = await opened({ maxBytes: 3072, maxFileBytes: 3072 });
    choose('W-2', pdf('big1.pdf', 2048));
    await screen.findByRole('button', { name: 'Remove big1.pdf' });
    choose('1099', pdf('big2.pdf', 2048));
    const other = screen.getByRole('region', { name: '1099' });
    expect(await within(other).findByRole('alert')).toHaveTextContent(
      'That file would take this request past what it can take: 1 KB is left.',
    );
    // Room made, and the vault not asked again in time.
    (state.drop as FakeDrop).sessionDrops = 1;
    fireEvent.click(screen.getByRole('button', { name: 'Remove big1.pdf' }));
    await screen.findByText(/this list may be behind/);
    fireEvent.click(within(other).getByRole('button', { name: 'Try big2.pdf again' }));
    await within(other).findByRole('button', { name: 'Remove big2.pdf' });
    expect(state.drop?.files.map((f) => f.name)).toEqual(['big2.pdf']);
  });

  it('a long unbroken word in a title or a slot wraps rather than pushing the page sideways at 320 px', () => {
    // jsdom draws nothing, so the rule itself is what is checked; the e2e
    // spec measures the page at 320 px in Chromium.
    // Every rule naming the selector, together: it may be named in more than one.
    const rule = (selector: string) =>
      [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, sel]) =>
          (sel ?? '')
            .split(',')
            .map((x) => x.trim())
            .includes(selector),
        )
        .map(([, , body]) => body)
        .join(' ');
    for (const selector of [
      '.drop-page h1',
      '.drop-page h2',
      '.drop-file-name',
      // The lines that repeat a file's name, or a title (N522W-3).
      '.status-line',
      '.notice',
      '.drop-page p',
      '.share-terms li',
      '.request-row',
    ]) {
      expect(rule(selector), selector).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });
});
