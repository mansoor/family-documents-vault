import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { whenExactly } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Removing a document for good, on the web (5.24): in the Trash, for
 * owners — at once for one they filed or that is theirs, "Ask to remove for
 * good" for anybody else's, then "Remove for good from {time}" — through the
 * app's own dialog and "confirm it's you"; and what whoever filed it is
 * told, on Home and in their Trash.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const BINNED = '2026-09-26T10:04:00Z';
/** The owner's own, filed by them, in the Trash: the vault says it may go at once. */
const MINE = { ...PASSPORT, deleted_at: BINNED, purge_at_once: true };
/** Filed by somebody else, Alex, and theirs: in the Trash. */
const THEIRS = {
  ...PASSPORT,
  id: 'doc-2',
  title: 'Alex payslip',
  owner_member_id: 'm-alex',
  filed_by_me: false,
  is_essential: false,
  deleted_at: BINNED,
  latest_version_id: 'v-2',
  etag: '"theirs"',
};

const openTrash = async (
  state: FakeState,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) => {
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/trash');
  const shown = render(<App />);
  await screen.findByRole('heading', { name: 'Trash' });
  return shown;
};
const rowOf = async (title: string) =>
  (await screen.findByText(title)).closest('li') as HTMLElement;

describe('removing a document for good, on the web (5.24)', () => {
  it('an owner removes their own at once, through the app’s dialog and confirming it’s them', async () => {
    const state = fresh({ documents: [MINE], stepUpNeeded: true });
    await openTrash(state);
    const row = await rowOf("Mansoor's passport");
    // Their own: no asking anybody first.
    expect(within(row).queryByRole('button', { name: /Ask to remove/ })).not.toBeInTheDocument();
    const remove = within(row).getByRole('button', {
      name: "Remove for good: Mansoor's passport",
    });

    // The app's own dialog, starting on Cancel; Cancel and Escape keep it.
    fireEvent.click(remove);
    let dialog = await screen.findByRole('alertdialog', { name: 'Remove for good?' });
    expect(dialog).toHaveTextContent('Nobody can bring it back.');
    expect(dialog).toHaveTextContent(
      'A backup made before now can bring back its details, never its file.',
    );
    // What it does not reach, said as it is (the review, W524-5).
    expect(dialog).toHaveTextContent(
      'Copies made elsewhere are not reached: an export made before now keeps its copy until it expires',
    );
    expect(dialog).not.toHaveTextContent('every copy');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    fireEvent.click(remove);
    await screen.findByRole('alertdialog', { name: 'Remove for good?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // Focus back where it was, though the browser remembered none (the
    // review, W524-4).
    expect(remove).toHaveFocus();
    expect(state.calls.some((c) => c.url.endsWith('/purge'))).toBe(false);

    // Confirmed: it asks who is asking, then carries on by itself.
    fireEvent.click(remove);
    dialog = await screen.findByRole('alertdialog', { name: 'Remove for good?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove for good' }));
    const asked = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(asked).toHaveTextContent('to remove a document for good');
    fireEvent.change(within(asked).getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(asked).getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('The Trash is empty.')).toBeInTheDocument();
    const news = screen.getByRole('status');
    expect(news).toHaveTextContent("“Mansoor's passport” was removed for good.");
    expect(news).toHaveFocus();
    expect(
      state.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/documents/doc-1/purge')),
    ).toHaveLength(2);
  });

  it('somebody else’s is asked about first, then waits: “Remove for good from {time}”', async () => {
    // Asked three hours ago, as the vault will say: a day from then to wait.
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const from = new Date(Date.parse(at) + 24 * 3_600_000).toISOString();
    const state = fresh({ documents: [THEIRS], purgeAskedAt: at });
    await openTrash(state);
    const row = await rowOf('Alex payslip');
    expect(
      within(row).queryByRole('button', { name: /^Remove for good: / }),
    ).not.toBeInTheDocument();
    const askButton = within(row).getByRole('button', {
      name: 'Ask to remove for good: Alex payslip',
    });
    // Escape gives focus back to the button that asked (the review, W524-4).
    fireEvent.click(askButton);
    await screen.findByRole('alertdialog', { name: 'Ask to remove for good?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(askButton).toHaveFocus();
    fireEvent.click(askButton);
    const dialog = await screen.findByRole('alertdialog', { name: 'Ask to remove for good?' });
    expect(dialog).toHaveTextContent(
      'Somebody else added “Alex payslip”. Whoever added it is told now, if they still sign in here, and so are the other owners.',
    );
    expect(dialog).toHaveTextContent('you can remove it for good 24 hours from now');
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask to remove for good' }));

    const news = await screen.findByRole('status');
    // One whole sentence, and only what is so (the review, W524-5).
    await waitFor(() =>
      expect(news.textContent).toBe(
        `You asked to remove “Alex payslip” for good. Whoever added it, if they still sign in here, and the other owners have been told. You can remove it from ${whenExactly(from)}.`,
      ),
    );
    const after = await rowOf('Alex payslip');
    await within(after).findByText(`An owner asked to remove this for good on ${whenExactly(at)}.`);
    // Not theirs to keep: no "Bring it back to keep it" for the owner.
    expect(within(after).queryByText(/Bring it back to keep it/)).not.toBeInTheDocument();
    const waiting = within(after).getByRole('button', {
      name: `Remove for good from ${whenExactly(from)}: Alex payslip`,
    });
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveTextContent(`Remove for good from ${whenExactly(from)}`);
    await expectAccessible();
  });

  it('once the day is over, an owner removes somebody else’s for good', async () => {
    const state = fresh({
      documents: [
        {
          ...THEIRS,
          purge_requested_at: '2026-09-30T09:00:00Z',
          purge_allowed_from: '2026-10-01T09:00:00Z',
        },
      ],
    });
    await openTrash(state);
    const row = await rowOf('Alex payslip');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove for good: Alex payslip' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove for good?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove for good' }));
    expect(await screen.findByText('The Trash is empty.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('“Alex payslip” was removed for good.');
  });

  it('whoever filed it is told, on Home and in their Trash, how to keep it', async () => {
    const at = '2026-10-02T09:00:00Z';
    const asked = {
      ...MINE,
      title: 'My payslip',
      purge_requested_at: at,
      purge_allowed_from: '2026-10-03T09:00:00Z',
    };
    const words = `An owner asked to remove this for good on ${whenExactly(at)}. Bring it back to keep it.`;
    // Home: the notice, which goes to the Trash.
    installFakeApi(fresh({ documents: [asked] }));
    signedIn('adult');
    const home = render(<App />);
    const notice = (
      await screen.findByText('An owner wants to remove one of your documents for good')
    ).closest('[role="status"]') as HTMLElement;
    expect(notice).toHaveTextContent('“My payslip”');
    expect(notice).toHaveTextContent(words);
    const open = within(notice).getByRole('link', { name: 'Open the Trash' });
    expect(open).toHaveAttribute('href', '/trash');
    // Seen as a link, underlined (the review, W524-6).
    expect(open).toHaveClass('quiet-link');
    await expectAccessible();
    home.unmount();

    // Their Trash: the same words, and the way to keep it — not to remove it.
    await openTrash(fresh({ documents: [asked] }), 'adult');
    const row = await rowOf('My payslip');
    expect(within(row).getByText(words)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Bring it back: My payslip' })).toBeEnabled();
    expect(within(row).queryByRole('button', { name: /for good/ })).not.toBeInTheDocument();
  });

  it('a filer who cannot bring it back is told who can (the review, W524-3)', async () => {
    const at = '2026-10-02T09:00:00Z';
    const asked = (owner: string) => ({
      ...MINE,
      title: 'My payslip',
      owner_member_id: owner,
      purge_requested_at: at,
      purge_allowed_from: '2026-10-03T09:00:00Z',
    });
    const askedOn = `An owner asked to remove this for good on ${whenExactly(at)}.`;
    const askSomebody = `${askedOn} To keep it, ask an owner or another adult to bring it back.`;
    // Made a viewer since they filed it, or a teen whose filing is now
    // somebody else's: told who can, on Home and in the Trash.
    for (const [role, owner] of [
      ['viewer', 'me'],
      ['teen', 'm-alex'],
    ] as const) {
      installFakeApi(fresh({ documents: [asked(owner)] }));
      signedIn(role);
      window.history.replaceState({}, '', '/');
      const home = render(<App />);
      const notice = (
        await screen.findByText('An owner wants to remove one of your documents for good')
      ).closest('[role="status"]') as HTMLElement;
      expect(notice, role).toHaveTextContent(askSomebody);
      home.unmount();
      const trash = await openTrash(fresh({ documents: [asked(owner)] }), role);
      const row = await rowOf('My payslip');
      expect(within(row).getByText(askSomebody), role).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: /Bring it back/ }), role).toBeNull();
      trash.unmount();
    }
    // A teen's own: theirs to bring back.
    await openTrash(fresh({ documents: [asked('me')] }), 'teen');
    const own = await rowOf('My payslip');
    expect(within(own).getByText(`${askedOn} Bring it back to keep it.`)).toBeInTheDocument();
  });

  it('an owner’s own document that somebody else filed is asked about, not removed at once (the review, M524-1)', async () => {
    await openTrash(
      fresh({
        documents: [
          {
            ...THEIRS,
            owner_member_id: 'me',
            purge_at_once: false,
            purge_requested_at: null,
            purge_allowed_from: null,
          },
        ],
      }),
    );
    const row = await rowOf('Alex payslip');
    expect(
      within(row).getByRole('button', { name: 'Ask to remove for good: Alex payslip' }),
    ).toBeEnabled();
    expect(within(row).queryByRole('button', { name: /^Remove for good/ })).toBeNull();
  });

  it('nobody but an owner is offered removing anything for good', async () => {
    for (const role of ['adult', 'teen', 'viewer'] as const) {
      const shown = await openTrash(
        fresh({ documents: [{ ...MINE }, { ...THEIRS, owner_member_id: 'me' }] }),
        role,
      );
      await screen.findByText("Mansoor's passport");
      expect(screen.queryByRole('button', { name: /for good/ }), role).not.toBeInTheDocument();
      expect(screen.getByText(/until somebody brings them back\.$/), role).toBeInTheDocument();
      shown.unmount();
    }
  });

  it('a document whose file was removed for good says so, and offers nothing to open', async () => {
    installFakeApi(fresh({ documents: [{ ...PASSPORT, file_removed: true }] }));
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    expect((await screen.findAllByText('The file was removed for good.')).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /full size/ })).not.toBeInTheDocument();
    await expectAccessible();
  });
});
