/**
 * The secret a link carries, read from the address and taken out of it.
 *
 * A share link's token (5.16), a password reset's and an invitation's
 * (5.17) are each the whole secret, so a link carries it after the `#`:
 * `/s#…`, `/reset#…`, `/join#…`. A browser sends that part to no server —
 * not the vault, not a proxy on the way. The page reads it once, before
 * anything is drawn (main.tsx), and replaces the address with one without
 * it: gone from the address bar and from this tab's history, its entry
 * replaced rather than a new one added, so Back does not bring it back.
 *
 * What no page can reach is the browser's own history of visited pages —
 * which it may sync to the person's other devices, and offer back as they
 * type — where the link was recorded as it arrived. So these links are not
 * kept safe by leaving no trace, and nothing here says they are: a share
 * link is kept shut by its PIN and its end, a reset link works once and
 * for an hour, and an invitation works once, only with a code sent another
 * way, and for days, not months.
 */

/** Replaces this tab's history entry with `path`: the same entry, and its state kept. */
function replaceAddress(path: string): void {
  window.history.replaceState(window.history.state, '', `${path}${window.location.search}`);
}

function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The token from the address's fragment, and the fragment gone from the
 * address bar and from this tab's history (5.16). The browser's own history
 * of visited pages may still hold the whole link: replaceState cannot reach
 * that. Null when there is none.
 */
export function takeLinkToken(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  replaceAddress(window.location.pathname);
  return decoded(raw);
}

/** The pages an invitation's link and a reset's open (5.17). */
export type AccountLinkPage = 'join' | 'reset';

/**
 * What this page load knows of its link: the token, until the link is
 * used; then only that it was, so a page opened again in the same load —
 * Back, say — tells the truth about it rather than asking for it again.
 * A reload knows neither.
 */
let held: { page: AccountLinkPage; token: string } | { page: AccountLinkPage; spent: true } | null =
  null;

/**
 * At start-up, before the app is drawn (main.tsx): the token of an
 * invitation's or a reset's link (5.17), kept for the page, and the address
 * left as the bare `/join` or `/reset`.
 *
 * A link since 0.5.17 carries it after the `#` (`/join#…`, `/reset#…`). A
 * link made before then carries it in the path (`/join/…`, `/reset/…`):
 * that address has been sent to the vault already, which is why new links
 * are not made so, but from here on it is treated as a fragment's — taken
 * out of the address bar and this tab's history in the same step, and
 * posted in a body. It is not sent to the old path forms, which would put
 * it in one more address a proxy on the way sees. Nor does the page load
 * again at `/reset#…` to get there, as an old share link's page does
 * (Shared.tsx, which serves another page): that would add the link, token
 * and all, to the browser's own history a second time.
 *
 * Only the address this page was opened at counts: anything held from
 * before is dropped.
 */
export function holdAccountLinkToken(): void {
  held = null;
  const at = /^\/(join|reset)(?:\/([^/]+))?\/?$/.exec(window.location.pathname);
  if (!at) return;
  const page = at[1] as AccountLinkPage;
  const inPath = at[2];
  const inFragment = window.location.hash.replace(/^#/, '');
  if (inPath !== undefined || inFragment) replaceAddress(`/${page}`);
  const raw = inFragment || inPath;
  if (raw) held = { page, token: decoded(raw) };
}

/** The token the page was opened with, or null: none, another page's, or used. */
export function heldLinkToken(page: AccountLinkPage): string | null {
  return held?.page === page && 'token' in held ? held.token : null;
}

/** Whether this page's link was used in this page load (5.17 review). */
export function linkSpent(page: AccountLinkPage): boolean {
  return held?.page === page && 'spent' in held;
}

/**
 * Once the link is used — the person has joined, or set their password —
 * the token is dropped, and only the fact that it was used is kept.
 */
export function markLinkSpent(): void {
  if (held) held = { page: held.page, spent: true };
}

/**
 * A link opened in a tab that is at its page already — `/reset` still open
 * after a reload, and the link pasted into the address bar — changes only
 * the fragment, and a browser does not load a page again for that, so
 * nothing would read the token. Then the page is loaded again, to start
 * from the link as a new tab does. Returns what stops the watching.
 */
export function reopenOnNewLink(reload: () => void = () => window.location.reload()): () => void {
  const onHashChange = () => {
    if (
      /^\/(?:s|join|reset)\/?$/.test(window.location.pathname) &&
      window.location.hash.length > 1
    ) {
      reload();
    }
  };
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}
