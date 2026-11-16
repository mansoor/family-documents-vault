import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharePage } from './screens/SharePage.js';
import { fresh, installFakeApi, type FakeState } from './test-api.js';

/**
 * A collection's link, opened by somebody outside the family (0.9.0, DL; the
 * owner's layout of 15 Nov 2026): Download all and Download selected at the
 * top, then its documents — a box each, a Select all, and a Download at the
 * end of each row, its name no longer the button — and below them its
 * notes, each with View, Download and a box. A link to view offers no
 * download at all.
 */

const TOKEN = 'share-secret-0123456789abcdef';

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

const ITEMS = [
  { id: 'doc-a', title: 'Payslip, August', filename: 'payslip.pdf' },
  { id: 'doc-b', title: 'Bank statement, August', filename: 'statement.pdf' },
  { id: 'doc-c', title: 'P60', filename: 'p60.pdf' },
  {
    id: 'note-a',
    title: 'Where the keys are',
    filename: 'Where the keys are.md',
    note: true,
    body: 'Under the **mat**.',
  },
];

async function opened(extra: Partial<FakeState> = {}): Promise<FakeState> {
  const state = fresh({ shareCollection: { name: 'For the broker', items: ITEMS }, ...extra });
  installFakeApi(state);
  render(<SharePage token={TOKEN} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
  await screen.findByRole('heading', { name: 'Documents', level: 2 });
  return state;
}

/** Where each link the page followed itself went: every download, asked about first. */
function followed(): string[] {
  const hrefs: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    hrefs.push(this.getAttribute('href') ?? '');
  });
  return hrefs;
}

describe('a collection’s link, to download (DL)', () => {
  it('Download all and Download selected at the top, then Documents, then Notes', async () => {
    const state = await opened();
    const hrefs = followed();
    const all = screen.getByRole('button', { name: 'Download all' });
    expect(screen.getByRole('button', { name: 'Download selected' })).toBeDisabled();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Documents', 'Notes']);
    // Download all comes before either section.
    const notes = screen.getByRole('heading', { name: 'Notes' });
    expect(all.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The documents' list has the files; the notes' list, the note.
    const docs = screen.getByRole('list', { name: 'Documents' });
    expect(within(docs).queryByText('Where the keys are')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Notes' })).getByText('Where the keys are'));
    await expectAccessible();
    // Asked first, then followed: the browser saves it as it comes.
    fireEvent.click(all);
    await waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs[0]).toMatch(/\/api\/v1\/shared\/items\/download$/);
    expect(state.shareZipChecks).toEqual(['']);
  });

  it('what the vault would refuse is said on the page, and nothing is followed', async () => {
    await opened({
      shareZipRefuse: {
        status: 403,
        code: 'downloads_used_up',
        message:
          'This link has been downloaded from as many times as it allows. Ask whoever sent it for a new one.',
      },
    });
    const hrefs = followed();
    fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    expect(
      await screen.findByText(/downloaded from as many times as it allows/, {
        selector: '[role=alert], [role=alert] *',
      }),
    ).toBeVisible();
    expect(hrefs).toEqual([]);
    // A row's own Download is asked about too.
    fireEvent.click(screen.getByRole('button', { name: 'Download Payslip, August' }));
    await waitFor(() => expect(hrefs).toEqual([]));
  });

  it('after a download, what this page has had and the downloads left are asked again', async () => {
    const state = await opened({ shareDownloadsLeft: 3 });
    followed();
    const asked = state.shareItemsAsked ?? 0;
    fireEvent.click(screen.getByRole('button', { name: 'Download Payslip, August' }));
    await waitFor(() => expect(state.shareItemsAsked ?? 0).toBeGreaterThan(asked), {
      timeout: 4000,
    });
  });

  it('more than one download holds: no Download all, and why — Download selected still', async () => {
    await opened({
      shareCollection: {
        name: 'Everything',
        items: [
          { id: 'doc-a', title: 'Scan one', filename: 'one.pdf', byte_size: 800 * 1024 ** 2 },
          { id: 'doc-b', title: 'Scan two', filename: 'two.pdf', byte_size: 800 * 1024 ** 2 },
        ],
      },
    });
    expect(screen.queryByRole('button', { name: 'Download all' })).toBeNull();
    expect(screen.getByText(/more here than one download holds/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download selected' })).toBeDisabled();
  });

  it('each row: a box, its name, and a Download of its own at the end; the name is not the button', async () => {
    await opened();
    const docs = screen.getByRole('list', { name: 'Documents' });
    const row = within(docs).getByText('Payslip, August').closest('li') as HTMLElement;
    expect(within(row).getByRole('checkbox', { name: 'Select Payslip, August' })).not.toBeChecked();
    const hrefs = followed();
    const download = within(row).getByRole('button', { name: 'Download Payslip, August' });
    expect(download).toHaveTextContent(/^Download$/);
    fireEvent.click(download);
    await waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs[0]).toMatch(/\/shared\/items\/doc-a\/content$/);
    // The name itself is text, not a link or a button.
    // (A row's Download is a real button: asked about first, then followed.)
    expect(within(row).getByText('Payslip, August').closest('a, button')).toBeNull();
    // The Download is the row's last control.
    const controls = [...row.querySelectorAll('input, a, button')];
    expect(controls[controls.length - 1]).toBe(download);
  });

  it('Select all ticks every document; Download selected gives a ZIP of only those ticked', async () => {
    await opened();
    const hrefs = followed();
    const selectAll = screen.getByRole('checkbox', { name: 'Select all documents' });
    fireEvent.click(selectAll);
    for (const title of ['Payslip, August', 'Bank statement, August', 'P60']) {
      expect(screen.getByRole('checkbox', { name: `Select ${title}` })).toBeChecked();
    }
    // A note is its own section's to tick.
    expect(screen.getByRole('checkbox', { name: 'Select Where the keys are' })).not.toBeChecked();
    // One taken out: Select all is part-way.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P60' }));
    expect((selectAll as HTMLInputElement).indeterminate).toBe(true);
    expect(selectAll).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Where the keys are' }));
    const selected = screen.getByRole('button', { name: 'Download selected (3)' });
    expect(selected).toBeEnabled();
    fireEvent.click(selected);
    await waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs[0]).toMatch(/\/api\/v1\/shared\/items\/download\?ids=doc-a,doc-b,note-a$/);
    // Untick them all: nothing to download selected.
    fireEvent.click(selectAll);
    fireEvent.click(selectAll);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Where the keys are' }));
    expect(screen.getByRole('button', { name: 'Download selected' })).toBeDisabled();
  });

  it('a note: View shows its words here, Hide puts them away; Download is a Markdown file', async () => {
    await opened();
    const notes = screen.getByRole('list', { name: 'Notes' });
    const view = within(notes).getByRole('button', { name: 'View Where the keys are' });
    expect(view).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('mat')).toBeNull();
    await act(async () => {
      fireEvent.click(view);
    });
    expect(await screen.findByText('mat')).toHaveProperty('tagName', 'STRONG');
    const hide = within(notes).getByRole('button', { name: 'Hide Where the keys are' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    const hrefs = followed();
    fireEvent.click(within(notes).getByRole('button', { name: 'Download Where the keys are' }));
    await waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs[0]).toMatch(/\/shared\/items\/note-a\/note\/download$/);
    fireEvent.click(hide);
    expect(screen.queryByText('mat')).toBeNull();
    await expectAccessible();
  });

  it('downloads used up: no box and no download for what this page has not had', async () => {
    await opened({ shareDownloadsLeft: 0 });
    expect(screen.queryByRole('button', { name: 'Download all' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Download / })).toBeNull();
  });
});

describe('a collection’s link, to view (DL)', () => {
  it('no Download all, no Download selected, no boxes and no download on any row; notes still read with View', async () => {
    await opened({ sharePermission: 'view' });
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    // Its pages are shown, as a view-only link's are.
    expect(screen.getAllByRole('list', { name: /^The pages of / }).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View Where the keys are' }));
    });
    expect(await screen.findByText('mat')).toBeVisible();
    await expectAccessible();
  });
});
