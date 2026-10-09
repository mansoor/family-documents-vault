import { useEffect } from 'react';
import { matchPath, useLocation } from 'react-router';

/**
 * The window's title on every page (WCAG 2.4.2, R5): what the page is, then
 * the app's name — so a tab, the window list and a screen reader's first
 * words say where somebody is, as the sidebar's names do.
 *
 * It names the screen, never what is on it: a document's title, a person's
 * name or a file's would be kept in the browser's history and shown in its
 * list of tabs, where the vault's own screens are not.
 */
export const APP_NAME = 'Family Document Vault';

/** Each route the app has, most particular first, and what its page is called. */
const PAGES: ReadonlyArray<readonly [pattern: string, title: string]> = [
  ['/', 'Home'],
  ['/add', 'Add a document'],
  ['/add/many', 'Add many documents'],
  ['/documents', 'Documents'],
  ['/documents/:id', 'A document'],
  ['/documents/:id/read', 'A document, full size'],
  ['/documents/:id/confirm', 'Is this right?'],
  ['/search', 'Search'],
  ['/reminders', 'Needs attention'],
  ['/household-questions', 'A few quick questions'],
  ['/people', 'People'],
  ['/people/outside', 'People outside the family'],
  ['/people/:id', 'A person'],
  ['/people/:id/documents', 'A person’s documents'],
  ['/collections', 'Collections'],
  ['/collections/:id', 'A collection'],
  ['/inbox', 'Inbox: your uploads'],
  ['/inbox/sent', 'Inbox: files sent to you'],
  ['/inbox/batches/:id', 'Inbox: a batch'],
  ['/inbox/batches/:id/items/:itemId', 'Inbox: a file to check'],
  ['/inbox/:id', 'Inbox: a file sent to you'],
  ['/sharing', 'Sharing'],
  ['/sharing/ask', 'Ask for documents'],
  ['/activity', 'Activity'],
  ['/trash', 'Trash'],
  ['/after-restore', 'After a restore'],
  ['/settings', 'Settings'],
  ['/settings/notifications', 'How you hear about things'],
  ['/settings/email', 'Where email comes from'],
  ['/settings/storage', 'Where your files are kept'],
  ['/settings/household', 'Household'],
  ['/settings/family', 'Family'],
  ['/settings/kinds', 'Kinds of document'],
  ['/settings/kinds/new', 'Add a kind'],
  ['/settings/kinds/:key', 'A kind of document'],
  ['/setup', 'Set up your family’s vault'],
  ['/welcome', 'Welcome'],
  ['/sign-in', 'Sign in'],
  ['/forgot-password', 'Forgotten your password'],
  ['/reset', 'Set a new password'],
  ['/join', 'An invitation'],
  ['/shared/:token', 'A shared document'],
];

/** "Documents – Family Document Vault"; the app's name alone where a page has no name of its own. */
export function pageTitle(pathname: string): string {
  // `/settings/kinds/new` before `/settings/kinds/:key`: the first that fits.
  const page = PAGES.find(([pattern]) => matchPath(pattern, pathname) !== null)?.[1];
  return page ? `${page} – ${APP_NAME}` : APP_NAME;
}

/** Keeps the window's title to the page, as the address changes. */
export function PageTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = pageTitle(pathname);
  }, [pathname]);
  return null;
}

/** The title of a page outside the app (a share link's, a request's): set once. */
export function useFixedTitle(page: string): void {
  useEffect(() => {
    document.title = `${page} – ${APP_NAME}`;
  }, [page]);
}
