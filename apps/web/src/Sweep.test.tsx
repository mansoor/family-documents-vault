import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { APP_NAME, pageTitle } from './page-title.js';
import { DropPage } from './screens/DropPage.js';
import { SharePage } from './screens/SharePage.js';
import {
  AISHA,
  fresh,
  freshDrop,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeState,
} from './test-api.js';

/**
 * R5, the sweep: what falls between the iterations, found by looking at the
 * whole app as one — each held here, so it stays found.
 */

beforeEach(() => {
  localStorage.clear();
  document.title = 'Family Document Vault';
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

const source = (name: string) => {
  const file = [`src/${name}`, `apps/web/src/${name}`]
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
};

/** The window this wide, as the browser's media queries would say (jsdom has none). */
function atWidth(px: number, tall = 900) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || px >= Number(minWidth[1])) &&
          (!minHeight || tall >= Number(minHeight[1])) &&
          Boolean(minWidth || minHeight),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

/** The app at `path`, signed in as an owner. */
function at(path: string, over: Partial<FakeState> = {}): FakeState {
  const state = fresh({ members: [ME, AISHA], ...over });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** A button pressed from the keyboard: it has the focus, then it is pressed. */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

describe('every page has a title of its own (WCAG 2.4.2)', () => {
  it('every route the app has is named, never by what is on it', () => {
    // Each path App.tsx routes, its parameters filled in.
    const paths = [...source('App.tsx').matchAll(/path="([^"*]+)"/g)].map((m) =>
      (m[1] as string).replace(/:(\w+)/g, 'x-1'),
    );
    expect(paths.length).toBeGreaterThan(40);
    const unnamed = paths.filter((p) => pageTitle(p) === APP_NAME);
    // The addresses Settings had (R1) only send on to the new ones.
    const moved = [...source('App.tsx').matchAll(/\['(\/[^']+)', '\/[^']*'\]/g)].map((m) =>
      (m[1] as string).replace(/:(\w+)/g, 'x-1'),
    );
    expect(unnamed.filter((p) => !moved.includes(p))).toEqual([]);
    expect(pageTitle('/documents')).toBe(`Documents – ${APP_NAME}`);
    expect(pageTitle('/settings/kinds/new')).toBe(`Add a kind – ${APP_NAME}`);
    expect(pageTitle('/settings/kinds/passport')).toBe(`A kind of document – ${APP_NAME}`);
    expect(pageTitle('/people/outside')).toBe(`People outside the family – ${APP_NAME}`);
    expect(pageTitle('/inbox/sent')).toBe(`Inbox: files sent to you – ${APP_NAME}`);
    expect(pageTitle('/inbox/in-1')).toBe(`Inbox: a file sent to you – ${APP_NAME}`);
  });

  it('the window says where you are, and follows you from page to page', async () => {
    installFakeApi(fresh());
    signedIn('owner');
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    await waitFor(() => expect(document.title).toBe(`A document – ${APP_NAME}`));
    // A document's own name stays off the title: the browser keeps titles in its history.
    expect(document.title).not.toContain('passport');
    screen.getAllByRole('link', { name: 'Home' })[0]?.click();
    await waitFor(() => expect(document.title).toBe(`Home – ${APP_NAME}`));
  });

  it('signed out too', async () => {
    installFakeApi(fresh());
    window.history.replaceState({}, '', '/sign-in');
    render(<App />);
    await waitFor(() => expect(document.title).toBe(`Sign in – ${APP_NAME}`));
  });

  it('the page a share link opens, and a request’s, outside the app', async () => {
    installFakeApi(fresh());
    const { unmount } = render(<SharePage token="share-token-abcdefghijklmnopqrstuvwxyz" />);
    await waitFor(() => expect(document.title).toBe(`A shared document – ${APP_NAME}`));
    unmount();
    installFakeApi(fresh({ drop: freshDrop() }));
    render(<DropPage token="drop-token-abcdefghijklmnopqrstuvwxyz" />);
    await waitFor(() => expect(document.title).toBe(`Send documents – ${APP_NAME}`));
  });
});

describe('the focus is never left nowhere (R5’s keyboard paths)', () => {
  it('Welcome to Sign in, and signing in: the new page’s heading', async () => {
    installFakeApi(fresh());
    window.history.replaceState({}, '', '/welcome');
    render(<App />);
    press(await screen.findByRole('button', { name: 'Sign in' }));
    // The household's name is the sign-in page's heading.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'The Seikh family' })).toHaveFocus(),
    );
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a password' } });
    press(screen.getByRole('button', { name: 'Sign in' }));
    // Home, in the shell, whose first page it is: still its heading.
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it('signing out: the sign-in page’s heading', async () => {
    at('/settings');
    press(await screen.findByRole('button', { name: /^Your account/ }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    press(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'The Seikh family' })).toHaveFocus(),
    );
  });

  it('Add: a file chosen, the card’s heading; Choose another file, the chooser', async () => {
    at('/add');
    const chooser = await screen.findByRole('button', { name: 'Take a photo or choose a file' });
    await waitFor(() => expect(chooser).toBeEnabled());
    chooser.focus();
    const file = new File(['%PDF-1.4'], 'passport.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose a file'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Is this right?' })).toHaveFocus(),
    );
    press(screen.getByRole('button', { name: 'Choose another file' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take a photo or choose a file' })).toHaveFocus(),
    );
  });

  it('a link made on a document’s page: the form, the link, and back to Share a link', async () => {
    at('/documents/doc-1');
    press(await screen.findByRole('button', { name: 'Share a link' }));
    await waitFor(() => expect(screen.getByLabelText('Who is it for?')).toHaveFocus());
    press(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share a link' })).toHaveFocus());
    press(screen.getByRole('button', { name: 'Share a link' }));
    fireEvent.change(screen.getByLabelText('Who is it for?'), {
      target: { value: 'the visa agent' },
    });
    press(screen.getByRole('button', { name: 'Make the link' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /^The link to / })).toHaveFocus(),
    );
    press(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share a link' })).toHaveFocus());
  });

  it('who can see it: the choice, what the vault said, and back to the button', async () => {
    at('/documents/doc-1', { documents: [{ ...PASSPORT }] });
    press(await screen.findByRole('button', { name: 'Change who can see it' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Everyone in the family' })).toHaveFocus(),
    );
    press(screen.getByRole('button', { name: 'Adults only' }));
    press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change who can see it' })).toHaveFocus(),
    );
    // Only me, the first time: what has to be said, said where the focus is.
    press(screen.getByRole('button', { name: 'Change who can see it' }));
    press(await screen.findByRole('button', { name: 'Only me' }));
    press(screen.getByRole('button', { name: 'Save' }));
    const said = await screen.findByRole('alert', { name: /./ });
    await waitFor(() => expect(within(said).getByRole('heading')).toHaveFocus());
    press(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change who can see it' })).toHaveFocus(),
    );
  });
});

describe('what was done is said (R5’s consistency)', () => {
  it('moved to the Trash from its own page: Home says so, where the focus is', async () => {
    // Its own copy: the fake changes what it is given.
    at('/documents/doc-1', { documents: [{ ...PASSPORT }] });
    press(await screen.findByRole('button', { name: 'Move to the Trash' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
    press(within(dialog).getByRole('button', { name: 'Move to the Trash' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    const said = await screen.findByText(
      "“Mansoor's passport” moved to the Trash. You can bring it back from there.",
    );
    expect(said).toHaveAttribute('role', 'status');
    await waitFor(() => expect(said).toHaveFocus());
  });
});

describe('a page that could not be loaded says so, and nothing it does not know (R5)', () => {
  /** Every list the vault is asked for, refused; who is signed in, answered. */
  const failing = (_method: string, path: string) =>
    /\/(documents|reminders|counts|suggestions|audit)(\/|$|\?)/.test(path)
      ? { status: 500, code: 'internal', message: 'Something went wrong on the vault.' }
      : undefined;

  it('Home: the error, never “Everything is fine” or “Nothing filed yet”', async () => {
    at('/', { refuseWith: failing });
    expect(await screen.findByText('Something went wrong on the vault.')).toBeInTheDocument();
    expect(screen.queryByText(/Everything is fine/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing filed yet/)).not.toBeInTheDocument();
  });

  it('Home, while it loads: nothing said of what needs attention', async () => {
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    at('/', { hold: (_m, path) => (path.startsWith('/api/v1/reminders') ? held : undefined) });
    await screen.findByRole('heading', { level: 2, name: 'People' });
    expect(screen.queryByText(/Everything is fine/)).not.toBeInTheDocument();
    answer();
    expect(await screen.findByText(/Everything is fine/)).toBeInTheDocument();
  });

  it('Needs attention: the error, not a heading and nothing', async () => {
    at('/reminders', { refuseWith: failing });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on the vault.',
    );
  });

  it('the Trash and the Documents table: not “Loading” for ever', async () => {
    atWidth(1280);
    at('/trash', { refuseWith: failing });
    expect(await screen.findByText('The Trash could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Loading the Trash…')).not.toBeInTheDocument();
  });

  it('nor the Documents table’s count', async () => {
    atWidth(1280);
    at('/documents', { refuseWith: failing });
    expect(await screen.findByText('The documents could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Loading your documents…')).not.toBeInTheDocument();
  });
});

describe('back from a document to the table as it was (R5’s keyboard paths)', () => {
  it('Back on the document goes back, as the browser’s does, and the row has the focus', async () => {
    atWidth(1280);
    at('/documents?sort=title&dir=desc', {
      documents: [
        { ...PASSPORT },
        { ...PASSPORT, id: 'doc-2', title: 'Council tax bill', etag: '"c"' },
      ],
    });
    const grid = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    const row = await within(grid).findByRole('link', { name: "Mansoor's passport" });
    row.focus();
    fireEvent.click(row);
    await screen.findByRole('heading', { level: 1, name: "Mansoor's passport" });
    // The Back link names where it goes when opened afresh: Home.
    const back = screen.getByRole('link', { name: 'Back' });
    expect(back).toHaveAttribute('href', '/');
    fireEvent.click(back);
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        '/documents?sort=title&dir=desc',
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('grid', { name: /^Documents, sorted by/ })).getByRole('link', {
          name: "Mansoor's passport",
        }),
      ).toHaveFocus(),
    );
  });

  it('on a phone, the list’s row has it', async () => {
    at('/documents?sort=title&dir=desc', {
      documents: [
        { ...PASSPORT },
        { ...PASSPORT, id: 'doc-2', title: 'Council tax bill', etag: '"c"' },
      ],
    });
    const row = await screen.findByRole('button', { name: /^Mansoor's passport/ });
    press(row);
    await screen.findByRole('heading', { level: 1, name: "Mansoor's passport" });
    fireEvent.click(screen.getByRole('link', { name: 'Back' }));
    await waitFor(() => expect(window.location.search).toBe('?sort=title&dir=desc'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Mansoor's passport/ })).toHaveFocus(),
    );
  });

  it('opened afresh, Back goes Home', async () => {
    at('/documents/doc-1');
    fireEvent.click(await screen.findByRole('link', { name: 'Back' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });

  it('the reader’s Escape goes back to the document it was opened from, not to a new page of it', async () => {
    at('/documents/doc-1');
    const idx = () => (window.history.state as { idx: number }).idx;
    const opened = idx();
    fireEvent.click(await screen.findByRole('link', { name: /full size/ }));
    await screen.findByRole('toolbar', { name: 'Pages' });
    expect(idx()).toBe(opened + 1);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-1'));
    expect(idx()).toBe(opened);
  });
});

describe('single keys only while they are on (WCAG 2.1.4)', () => {
  it('the reader’s + and −: with the switch, and said as its buttons’ keys', async () => {
    at('/documents/doc-1/read');
    await screen.findByRole('img', { name: "Page 1 of Mansoor's passport" });
    expect(screen.getByRole('button', { name: 'Larger' })).toHaveAttribute(
      'aria-keyshortcuts',
      '+',
    );
    expect(screen.getByRole('button', { name: 'Smaller' })).toHaveAttribute(
      'aria-keyshortcuts',
      '-',
    );
    fireEvent.keyDown(window, { key: '+' });
    expect(screen.getByRole('img', { name: /^Page 1/ })).toHaveStyle({ width: '150%' });
    fireEvent.keyDown(window, { key: '-' });
    // Turned off in Settings, on this device: nothing, and nothing said.
    localStorage.setItem('fdv.shortcuts', 'off');
    window.dispatchEvent(new StorageEvent('storage', { key: 'fdv.shortcuts' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Larger' })).not.toHaveAttribute(
        'aria-keyshortcuts',
      ),
    );
    fireEvent.keyDown(window, { key: '+' });
    expect(screen.getByRole<HTMLImageElement>('img', { name: /^Page 1/ }).style.width).toBe('');
    // The buttons still do it.
    fireEvent.click(screen.getByRole('button', { name: 'Larger' }));
    expect(screen.getByRole('img', { name: /^Page 1/ })).toHaveStyle({ width: '150%' });
  });

  it('nor while a menu is open over the reader', async () => {
    atWidth(1280);
    at('/documents/doc-1/read');
    await screen.findByRole('img', { name: "Page 1 of Mansoor's passport" });
    fireEvent.click(screen.getByRole('button', { name: /^Your account/ }));
    await screen.findByRole('menu', { name: 'Your account' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });
});

describe('Search’s field is what was typed (R5)', () => {
  it('kept as typed, and changed by a search asked from elsewhere', async () => {
    atWidth(1280);
    at('/search?q=passport');
    const field = await screen.findByLabelText('Search everything');
    expect(field).toHaveValue('passport');
    fireEvent.change(field, { target: { value: 'passport renewal' } });
    expect(field).toHaveValue('passport renewal');
    await waitFor(() => expect(window.location.search).toBe('?q=passport+renewal'));
    // The search box on top, while Search is open: the field follows.
    const top = screen.getByRole('searchbox', { name: 'Search the vault' });
    fireEvent.change(top, { target: { value: 'will' } });
    fireEvent.submit(top.closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByLabelText('Search everything')).toHaveValue('will'));
  });
});

describe('landmarks, and a short window', () => {
  it('the search in the bar on top is a landmark with a name', async () => {
    atWidth(1280);
    at('/');
    expect(await screen.findByRole('search', { name: 'Search the vault' })).toBeInTheDocument();
  });

  it('at 400% zoom, Select’s bar is part of the list, not kept over it (2.4.11)', () => {
    const css = source('styles.css')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ');
    const short = /@media \(max-height: 500px\) \{(.*?\} )\}/.exec(css)?.[1] ?? '';
    expect(short).toMatch(/\.select-bar \{ position: static; \}/);
    // Everywhere else it stays at the top as the list scrolls.
    expect(css).toMatch(/\.select-bar \{ position: sticky; top: 0;/);
  });
});
