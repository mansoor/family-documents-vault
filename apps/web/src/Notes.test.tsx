import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { formatNote } from './notes.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';
import { Sheet } from './ui.js';

/**
 * Notes you can write, on the web (5.35, A30, A32): the Notes section of a
 * document's page — read by whoever sees it, written by whoever may change
 * it — drawn from the note's tree as elements, never as HTML; drafts kept
 * only for the family's documents, for the tab, and never past a sign-out.
 * And three small things the 5.35 survey found: Export everything offered
 * to whoever may export, the Reminders' "a few questions" leading to them,
 * and a sheet's Escape the moment an action finishes.
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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

/** The document's page, signed in as `role`. */
async function openDocument(
  state: FakeState,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
  id = 'doc-1',
) {
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', `/documents/${id}`);
  const shown = render(<App />);
  await screen.findByRole('heading', { level: 1 });
  return shown;
}
/**
 * The page again, as a reload would show it: the same vault, and the
 * session this browser keeps (its refresh token has moved on since).
 */
async function reopen(state: FakeState, id = 'doc-1') {
  installFakeApi(state);
  window.history.replaceState({}, '', `/documents/${id}`);
  const shown = render(<App />);
  await screen.findByRole('heading', { level: 1 });
  return shown;
}
const notes = () => screen.findByRole('region', { name: 'Notes' });
/** What this tab keeps for drafts of notes: every key, to be sure none is anywhere. */
const kept = () => {
  const keys: string[] = [];
  for (const store of [sessionStorage, localStorage]) {
    for (let i = 0; i < store.length; i++) keys.push(store.key(i) as string);
  }
  return keys.filter((k) => k.includes('note'));
};

describe('notes you can write, on the web (5.35)', () => {
  it('<script> in a note shows as characters', async () => {
    const note =
      '<script>window.__fdvNote = 1</script> <img src=x onerror="window.__fdvNote = 2"> **<b>bold</b>** <iframe src="https://evil.example"></iframe>';
    await openDocument(fresh({ documents: [{ ...PASSPORT, notes: note }] }));
    const section = await notes();
    expect(section).toHaveTextContent('<script>window.__fdvNote = 1</script>');
    expect(section).toHaveTextContent('<img src=x onerror="window.__fdvNote = 2">');
    expect(within(section).getByText('<b>bold</b>').tagName).toBe('STRONG');
    expect(section.querySelector('script, img, b, iframe')).toBeNull();
    expect((window as unknown as { __fdvNote?: number }).__fdvNote).toBeUndefined();
    await expectAccessible();
  });

  it('links open with noopener noreferrer', async () => {
    const note = [
      'Pay at [the council](https://council.example/pay) or mail [the office](mailto:tax@example.com).',
      'The portal: https://portal.example/login.',
      'Never [this](javascript:alert(1)) nor [that](data:text/html,<b>x</b>).',
    ].join('\n');
    await openDocument(fresh({ documents: [{ ...PASSPORT, notes: note }] }));
    const section = await notes();
    const links = within(section).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['the council', 'https://council.example/pay'],
      ['the office', 'mailto:tax@example.com'],
      ['https://portal.example/login', 'https://portal.example/login'],
    ]);
    for (const a of links) expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    // The web opens in a new tab; an email, in the mail app.
    expect(links.map((a) => a.getAttribute('target'))).toEqual(['_blank', null, '_blank']);
    // Each shown with its address, so its words cannot pass for somewhere else.
    expect(section).toHaveTextContent('the council (https://council.example/pay)');
    expect(section).toHaveTextContent('the office (mailto:tax@example.com)');
    // Anywhere else is not a link at all.
    expect(section).toHaveTextContent(
      'Never [this](javascript:alert(1)) nor [that](data:text/html,<b>x</b>).',
    );
    expect(section.querySelector('a[href^="javascript"], a[href^="data"]')).toBeNull();
  });

  it('an owner writes a note with the toolbar, the keys and a preview, and it is saved as the copy they began from', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }], timezone: 'Europe/London' });
    await openDocument(state);
    const section = await notes();
    expect(within(section).queryByText(/^edited/)).not.toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Add a note' }));
    const box = within(section).getByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(box).toHaveFocus());
    expect(section).toHaveTextContent('0 of 10,000 characters');

    fireEvent.change(box, { target: { value: 'Spare key' } });
    (box as HTMLTextAreaElement).setSelectionRange(0, 9);
    fireEvent.click(within(section).getByRole('button', { name: 'Bold' }));
    expect(box).toHaveValue('**Spare key**');
    // Ctrl+I on "Spare", and Cmd+B is bold too.
    (box as HTMLTextAreaElement).setSelectionRange(2, 7);
    fireEvent.keyDown(box, { key: 'i', ctrlKey: true });
    expect(box).toHaveValue('***Spare* key**');
    fireEvent.change(box, { target: { value: '***Spare* key**\nunder the pot\nbin day' } });
    (box as HTMLTextAreaElement).setSelectionRange(16, 37);
    fireEvent.click(within(section).getByRole('button', { name: 'Checklist' }));
    expect(box).toHaveValue('***Spare* key**\n- [ ] under the pot\n- [ ] bin day');
    expect(section).toHaveTextContent('49 of 10,000 characters');
    await expectAccessible();

    // The preview draws it as it will read.
    fireEvent.click(within(section).getByRole('button', { name: 'Preview' }));
    const preview = within(section).getByRole('region', { name: 'Preview of the note' });
    expect(within(preview).getByText('Spare').tagName).toBe('EM');
    expect(within(preview).getByText('Spare').closest('strong')).not.toBeNull();
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['☐To do: under the pot', '☐To do: bin day']);
    await expectAccessible();
    fireEvent.click(within(section).getByRole('button', { name: 'Write' }));

    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('/api/v1/documents/doc-1');
    expect(patch?.body).toEqual({ notes: '***Spare* key**\n- [ ] under the pot\n- [ ] bin day' });
    expect(patch?.headers?.['if-match']).toBe('"abc"');
    // Who, and when: on the household's clock (10:05 UTC is 11:05am in London).
    expect(section).toHaveTextContent('edited 26 Sept 2026, 11:05am by Mansoor Seikh');
    // Focus back on what opened the editor.
    await waitFor(() =>
      expect(within(section).getByRole('button', { name: 'Edit note' })).toHaveFocus(),
    );
    expect(kept()).toEqual([]);
  });

  it('a note changed meanwhile is not saved over: the editor says so, keeps the draft, and shows theirs', async () => {
    const theirs = {
      ...PASSPORT,
      notes: 'Theirs: renew in March',
      notes_updated_at: '2026-09-25T15:12:00Z',
      notes_updated_by_name: 'Sarah',
      etag: '"theirs"',
    };
    const state = fresh({
      documents: [{ ...PASSPORT, notes: 'Renew early' }],
    });
    await openDocument(state);
    const section = await notes();
    fireEvent.click(within(section).getByRole('button', { name: 'Edit note' }));
    const box = within(section).getByRole('textbox', { name: 'Notes' });
    fireEvent.change(box, { target: { value: 'Mine: renew in February' } });
    // Sarah saves first.
    Object.assign(state.documents[0] as object, theirs);

    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    const said = await within(section).findByRole('group', { name: /changed this note/ });
    expect(said).toHaveTextContent('Sarah changed this note while you were writing.');
    expect(said).toHaveTextContent('Theirs: renew in March');
    // Focus on what says so, and no plain Save left to press twice.
    await waitFor(() => expect(within(said).getByText(/changed this note/)).toHaveFocus());
    expect(within(section).queryByRole('button', { name: 'Save note' })).not.toBeInTheDocument();
    expect(box).toHaveValue('Mine: renew in February');
    expect((state.documents[0] as { notes: string }).notes).toBe('Theirs: renew in March');
    await expectAccessible();

    // Saving over theirs is a choice of its own: from the copy now there.
    fireEvent.click(within(said).getByRole('button', { name: 'Save mine over theirs' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    const patches = state.calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.headers?.['if-match'])).toEqual(['"abc"', '"theirs"']);
    expect(section).toHaveTextContent('Mine: renew in February');
  });

  it('no draft of an adults-only or Only me note is kept; a household draft is gone after sign-out', async () => {
    for (const visibility of ['adults', 'private'] as const) {
      const state = fresh({ documents: [{ ...PASSPORT, visibility, notes: null }] });
      let shown = await openDocument(state);
      const section = await notes();
      fireEvent.click(within(section).getByRole('button', { name: 'Add a note' }));
      fireEvent.change(within(section).getByRole('textbox', { name: 'Notes' }), {
        target: { value: `Not to be left behind (${visibility})` },
      });
      expect(kept(), visibility).toEqual([]);
      // Back again: nothing was kept to bring back.
      shown.unmount();
      shown = await reopen(state);
      const again = await notes();
      expect(within(again).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(again).getByRole('button', { name: 'Add a note' })).toBeInTheDocument();
      shown.unmount();
      // And one kept from before it was made Adults only or Only me is forgotten.
      sessionStorage.setItem(
        'fdv.note-draft.hh.me.doc-1',
        JSON.stringify({ text: 'From before', baseText: '', baseEtag: '"abc"', baseStamp: null }),
      );
      shown = await reopen(state);
      await notes();
      await waitFor(() => expect(kept(), visibility).toEqual([]));
      expect(screen.queryByDisplayValue('From before')).not.toBeInTheDocument();
      shown.unmount();
    }

    // The family's own: kept for the tab, and back after a reload.
    const state = fresh({ documents: [{ ...PASSPORT }] });
    const shown = await openDocument(state);
    let section = await notes();
    fireEvent.click(within(section).getByRole('button', { name: 'Add a note' }));
    fireEvent.change(within(section).getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Half-written' },
    });
    // Kept for whoever wrote it, in their household (the 5.35 review, W535-07).
    expect(kept()).toEqual(['fdv.note-draft.hh.me.doc-1']);
    shown.unmount();
    await reopen(state);
    section = await notes();
    expect(within(section).getByRole('textbox', { name: 'Notes' })).toHaveValue('Half-written');
    expect(section).toHaveTextContent('Your unsaved draft of this note is back.');
    await expectAccessible();

    // Signing out takes it away.
    fireEvent.click(screen.getByRole('link', { name: 'Home' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Settings' }));
    const signOut = await screen.findAllByRole('button', { name: 'Sign out' });
    await act(async () => {
      fireEvent.click(signOut[signOut.length - 1] as HTMLElement);
    });
    await waitFor(() => expect(kept()).toEqual([]));
  });

  it('a teen writes the note on their own documents; a viewer or a guest only reads one', async () => {
    const note = { ...PASSPORT, notes: 'Renew **early**' };
    const others = {
      ...PASSPORT,
      id: 'doc-2',
      owner_member_id: 'm-0',
      notes: 'Aisha’s note',
      latest_version_id: 'v-2',
    };
    // A teen: their own, yes.
    let shown = await openDocument(fresh({ documents: [note, others] }), 'teen');
    expect(within(await notes()).getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
    shown.unmount();
    // Somebody else's: read only.
    shown = await openDocument(fresh({ documents: [note, others] }), 'teen', 'doc-2');
    let section = await notes();
    expect(section).toHaveTextContent('Aisha’s note');
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    shown.unmount();
    // A viewer — a guest is one, on the wire — reads it, and is offered nothing.
    shown = await openDocument(fresh({ documents: [note] }), 'viewer');
    section = await notes();
    expect(within(section).getByText('early').tagName).toBe('STRONG');
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    shown.unmount();
    // With no note, a viewer has no Notes section at all.
    await openDocument(fresh({ documents: [{ ...PASSPORT }] }), 'viewer');
    await screen.findByRole('heading', { name: 'History' });
    expect(screen.queryByRole('region', { name: 'Notes' })).not.toBeInTheDocument();
  });

  it('says who last changed it and when, on the household’s clock, and when only to a viewer', async () => {
    const note = {
      ...PASSPORT,
      notes: 'Renew early',
      notes_updated_at: '2026-09-25T15:12:00Z',
      notes_updated_by_name: 'Sarah',
    };
    const shown = await openDocument(fresh({ documents: [note], timezone: 'Europe/London' }));
    expect(await notes()).toHaveTextContent('edited 25 Sept 2026, 4:12pm by Sarah');
    shown.unmount();
    await openDocument(
      fresh({
        documents: [{ ...note, notes_updated_by_name: null }],
        timezone: 'America/Los_Angeles',
      }),
      'viewer',
    );
    const section = await notes();
    expect(section).toHaveTextContent('edited 25 Sept 2026, 8:12am');
    expect(section).not.toHaveTextContent(' by ');
  });

  it('the toolbar marks what is chosen, and every line it touches', () => {
    expect(formatNote('a word here', 2, 6, 'bold')).toEqual({
      text: 'a **word** here',
      start: 4,
      end: 8,
    });
    expect(formatNote('', 0, 0, 'italic')).toEqual({ text: '*italic*', start: 1, end: 7 });
    expect(formatNote('see the rota', 4, 12, 'link')).toEqual({
      text: 'see [the rota](https://example.com)',
      start: 15,
      end: 34,
    });
    expect(formatNote('one\ntwo\nthree', 1, 6, 'numbered').text).toBe('1. one\n2. two\nthree');
    expect(formatNote('one\ntwo', 5, 5, 'list').text).toBe('one\n- two');
  });
});

describe('what the 5.35 survey found', () => {
  it('Export everything is offered only to whoever may export', async () => {
    for (const [role, offered] of [
      ['owner', true],
      ['adult', true],
      ['teen', false],
      ['viewer', false],
    ] as const) {
      const state = fresh({ documents: [{ ...PASSPORT }] });
      installFakeApi(state);
      signedIn(role);
      window.history.replaceState({}, '', '/settings');
      const shown = render(<App />);
      await screen.findByRole('heading', { name: 'Settings' });
      await screen.findByRole('heading', { name: 'Signed-in devices' });
      expect(Boolean(screen.queryByRole('heading', { name: 'Export everything' })), role).toBe(
        offered,
      );
      // And a refused list of exports is never asked for.
      expect(
        state.calls.some((c) => c.url.startsWith('/api/v1/exports')),
        role,
      ).toBe(offered);
      shown.unmount();
    }
  });

  it('the Reminders’ empty state leads to the household’s questions, for whoever may answer them', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }], profileAnswered: false });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/reminders');
    let shown = render(<App />);
    const missing = await screen.findByRole('region', { name: 'We noticed something missing' });
    const answer = within(missing).getByRole('link', { name: 'Answer the questions' });
    expect(answer).toHaveAttribute('href', '/household-questions');
    expect(within(missing).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(answer);
    expect(await screen.findByRole('heading', { name: 'A few quick questions' })).toBeVisible();
    shown.unmount();

    // A teen cannot answer them: told who can, with nowhere to go.
    installFakeApi(fresh({ documents: [{ ...PASSPORT }], profileAnswered: false }));
    signedIn('teen');
    window.history.replaceState({}, '', '/reminders');
    shown = render(<App />);
    const theirs = await screen.findByRole('region', { name: 'We noticed something missing' });
    expect(theirs).toHaveTextContent('Once an adult answers a few questions');
    expect(within(theirs).queryByRole('link')).not.toBeInTheDocument();
    shown.unmount();
  });
});

describe('a sheet, the moment its action finishes', () => {
  /** Presses Escape as the render that ends `busy` is committed, before passive effects run. */
  function EscapeAsItCommits({ when }: { when: boolean }) {
    useLayoutEffect(() => {
      if (when) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }, [when]);
    return null;
  }
  function Busy({ busy, onClose }: { busy: boolean; onClose: () => void }) {
    const opener = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={opener} type="button">
          Open
        </button>
        <Sheet label="Adding" busy={busy} returnFocus={opener} onClose={onClose}>
          <button type="button">Done</button>
        </Sheet>
        <EscapeAsItCommits when={!busy} />
      </>
    );
  }

  it('closes on an Escape pressed the moment it stops being busy, not a render later', () => {
    const onClose = vi.fn();
    const shown = render(<Busy busy onClose={onClose} />);
    // While busy, Escape keeps it open.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    // Pressed as `busy` turns false: it closes.
    shown.rerender(<Busy busy={false} onClose={onClose} />);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
