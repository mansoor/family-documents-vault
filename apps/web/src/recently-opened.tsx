import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { api } from './api.js';
import { useApp } from './app-context.js';

/**
 * The documents somebody opened most recently (0.9.0-dev.102): Home's
 * Recent, its Opened tab. The vault remembers an open only when the page
 * says so, here, and only for an open the person started: a document
 * opened beside the list (flyout-context's open), or its own page arrived
 * at — never one fetched for a list, a search or a ⋯, nor one drawn again
 * by itself: a reload, the documents beside the list put back from this
 * tab's storage, everything drawn again after an unlock.
 */

/** Said when this page told the vault of an open: an Opened list showing is loaded again. */
export const OPENED_EVENT = 'fdv-document-opened';

/** Tells the vault the person opened this document. Failing says nothing: it is open all the same. */
export function tellOpened(
  withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T | null>,
  id: string,
): void {
  void withToken((t) => api.openedDocument(t, id)).then(
    () => window.dispatchEvent(new Event(OPENED_EVENT)),
    () => undefined,
  );
}

/** The history entries whose document was told already, in this tab: a reload or an unlock tells none again. */
const ENTRIES_KEY = 'fdv.opened-entries';
const ENTRIES_KEPT = 100;
/** A document beside the list opened as a page: told as it was opened beside the list. */
const AS_PAGE_KEY = 'fdv.opened-as-page';

function toldEntries(): string[] {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(ENTRIES_KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Kept as told: false where it was already. */
function firstTime(entry: string): boolean {
  const had = toldEntries();
  if (had.includes(entry)) return false;
  try {
    sessionStorage.setItem(ENTRIES_KEY, JSON.stringify([...had, entry].slice(-ENTRIES_KEPT)));
  } catch {
    // Not kept: told again only if this entry is drawn again.
  }
  return true;
}

/** Open as a page, of a document beside the list: its page tells nothing more. */
export function openingAsPage(id: string): void {
  try {
    sessionStorage.setItem(AS_PAGE_KEY, id);
  } catch {
    // Not kept: its page tells it again, which only keeps it first.
  }
}

/** The document last opened as a page from beside the list, once: taken away as it is read. */
function takeAsPage(): string | null {
  try {
    const id = sessionStorage.getItem(AS_PAGE_KEY);
    sessionStorage.removeItem(AS_PAGE_KEY);
    return id;
  } catch {
    return null;
  }
}

/**
 * A document's own page tells the vault it was opened, once for each time
 * the person arrives at it (each entry of the browser's history): once it
 * has loaded, never one in the Trash or a note, which Opened never lists.
 * Not again on a reload or after an unlock (the same entry); not for one
 * opened as a page from beside the list, told already; and not for one
 * just filed through Add, which the person added, not opened.
 */
export function useOpenedOnPage(
  doc: { id: string; deleted_at: string | null } | null,
  note: boolean,
  justFiled: boolean,
): void {
  const { withToken, caps } = useApp();
  const { key } = useLocation();
  const offered = caps?.features.recently_opened === true;
  const id = doc && !doc.deleted_at && !note ? doc.id : null;
  useEffect(() => {
    if (!offered || id === null) return;
    if (!firstTime(`${key}:${id}`)) return;
    const asPage = takeAsPage();
    if (justFiled || asPage === id) return;
    tellOpened(withToken, id);
  }, [offered, id, key, justFiled, withToken]);
}

/** Home's Recent: what was added, or what this person opened. */
export type RecentTab = 'added' | 'opened';

/** Where this browser remembers which of Recent's tabs a person last chose. */
const tabKey = (memberId: string | null | undefined) => `fdv.home-recent.${memberId ?? 'nobody'}`;

export function rememberedRecentTab(memberId: string | null | undefined): RecentTab {
  try {
    return window.localStorage.getItem(tabKey(memberId)) === 'opened' ? 'opened' : 'added';
  } catch {
    // A private window: Added, as it starts.
    return 'added';
  }
}

export function rememberRecentTab(memberId: string | null | undefined, tab: RecentTab): void {
  try {
    if (tab === 'opened') window.localStorage.setItem(tabKey(memberId), 'opened');
    else window.localStorage.removeItem(tabKey(memberId));
  } catch {
    // Not remembered: chosen for this visit only.
  }
}

const TABS: ReadonlyArray<{ key: RecentTab; label: string }> = [
  { key: 'added', label: 'Added' },
  { key: 'opened', label: 'Opened' },
];

/**
 * Recent's two tabs and the list under them, as tabs are to a screen
 * reader: a tab list named by the section's heading, each tab's panel
 * named by it, the arrow keys, Home and End moving between them and
 * choosing as they go, and Tab going from the chosen tab to its panel.
 */
export function RecentTabs(props: {
  /** The section's heading, which names the tabs. */
  labelledBy: string;
  current: RecentTab;
  onChoose: (tab: RecentTab) => void;
  children: ReactNode;
}) {
  const id = useId();
  const tabId = (key: RecentTab) => `${id}-tab-${key}`;
  const panelId = `${id}-panel`;
  const buttons = useRef<Partial<Record<RecentTab, HTMLButtonElement | null>>>({});
  const choose = (key: RecentTab) => {
    props.onChoose(key);
    buttons.current[key]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.key === props.current);
    const to =
      e.key === 'ArrowRight'
        ? (at + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + TABS.length) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? TABS.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    choose((TABS[to] as (typeof TABS)[number]).key);
  };
  return (
    <>
      <div
        className="tabs recent-tabs"
        role="tablist"
        aria-labelledby={props.labelledBy}
        onKeyDown={onKeyDown}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              buttons.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={tabId(t.key)}
            className="tab"
            aria-selected={props.current === t.key}
            aria-controls={panelId}
            tabIndex={props.current === t.key ? 0 : -1}
            onClick={() => choose(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(props.current)}
        className="recent-panel"
        // Reached with Tab from the chosen tab, rows or none (the APG's tabs).
        tabIndex={0}
      >
        {props.children}
      </div>
    </>
  );
}
