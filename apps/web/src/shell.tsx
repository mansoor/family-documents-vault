import { can, roleLabel, type Capabilities, type Role } from '@fdv/shared';
import {
  startTransition,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { api, type Member } from './api.js';
import { useApp, useLoad } from './app-context.js';
import { collectionsOffered } from './collections.js';
import { beside } from './DocActions.js';
import { PersonAvatar } from './person-avatar.js';
import { storedRole } from './session.js';
import { useSheetFocus } from './ui.js';

/**
 * The app's shell (Phase 6, R1): one layout around every signed-in screen.
 *
 *  - 1024 px and wider: a sidebar of sections, always there, and a bar on
 *    top with search (`/`), Add (`n`) and the account menu;
 *  - 768–1023 px: the same, the sidebar narrowed to its icons, each named
 *    and with its name beside it on hover or focus;
 *  - narrower: today's bottom bar, and a menu at the top left that opens a
 *    drawer with the other sections.
 *
 * Each section is shown only to whom its screen is for, by the checks the
 * screens themselves make. The screens inside keep their own layout: R2 to
 * R5 redesign them.
 */

export type ShellMode = 'wide' | 'mid' | 'phone';

const WIDE = '(min-width: 1024px)';
const MID = '(min-width: 768px)';

function readMode(): ShellMode {
  // No media queries (jsdom): the phone's layout, the one every screen had.
  if (typeof window.matchMedia !== 'function') return 'phone';
  if (window.matchMedia(WIDE).matches) return 'wide';
  if (window.matchMedia(MID).matches) return 'mid';
  return 'phone';
}

function watchMode(changed: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const lists = [WIDE, MID].map((q) => window.matchMedia(q));
  for (const l of lists) l.addEventListener('change', changed);
  return () => {
    for (const l of lists) l.removeEventListener('change', changed);
  };
}

/** Which of the three layouts the window is wide enough for, kept up as it changes. */
export function useShellMode(): ShellMode {
  return useSyncExternalStore(watchMode, readMode, () => 'phone');
}

// ------------------------------------------------------------------ icons

type IconName =
  | 'home'
  | 'documents'
  | 'people'
  | 'collections'
  | 'attention'
  | 'inbox'
  | 'sharing'
  | 'activity'
  | 'trash'
  | 'settings'
  | 'search'
  | 'plus'
  | 'menu'
  | 'close'
  | 'chevron'
  | 'signOut';

/** Each drawn in strokes, as the app's own bin is: emoji differ on every phone. */
const DRAWN: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9v11h4.5v-5.5h3V20H18V9" />
    </>
  ),
  documents: (
    <>
      <path d="M6.5 3.5h7.5l4.5 4.5v12.5h-12z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M9.5 12.5h5M9.5 16h5" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19.5c.6-3.2 2.7-5 5.5-5s4.9 1.8 5.5 5" />
      <circle cx="17" cy="9.5" r="2.3" />
      <path d="M16.5 14.6c2.2.2 3.6 1.9 4 4.9" />
    </>
  ),
  collections: <path d="M3.5 6.5h6l2 2.5h9v10.5h-17z" />,
  attention: (
    <>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z" />
      <path d="M10 20.5h4" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13.5 6 5.5h12l2.5 8v6h-17z" />
      <path d="M3.5 13.5h5l1 2.5h5l1-2.5h5" />
    </>
  ),
  sharing: (
    <>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </>
  ),
  activity: <path d="M3 12.5h4.5l2.5-6 4 12 2.5-6H21" />,
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6.5h10M18 6.5h2M4 12h3M11 12h9M4 17.5h8M16 17.5h4" />
      <circle cx="16" cy="6.5" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="14" cy="17.5" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevron: <path d="m7 10 5 5 5-5" />,
  signOut: (
    <>
      <path d="M10 4.5H5.5v15H10" />
      <path d="m14 8 4 4-4 4M18 12H9" />
    </>
  ),
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {DRAWN[name]}
    </svg>
  );
}

// ------------------------------------------------------------- sections

export interface Section {
  key: string;
  label: string;
  to: string;
  icon: IconName;
  /** What waits for this person there (the Inbox), when anything does. */
  count?: number;
  /** Whether a path is this section's, for `aria-current`. */
  owns: (path: string) => boolean;
}

const under = (base: string) => (path: string) => path === base || path.startsWith(`${base}/`);

/**
 * What the sidebar lists for this person, in its order, each where the
 * screen behind it is theirs: the same checks the screens and today's
 * Settings rows make. Settings is apart, at the bottom (`SETTINGS`).
 *
 * Documents opens today's browse view at /documents until R2 builds the
 * Documents table there; on a wide screen, where there is no Search in the
 * bar, search's results are Documents' too.
 */
export function sectionsFor(who: {
  role: Role;
  caps: Capabilities | null;
  mode: ShellMode;
  /** A viewer given collections, or one who made some before (5.33). */
  givenCollections: boolean;
  /** What waits in the Inbox for this person; null until known. */
  waiting: number | null;
}): Section[] {
  const { role, caps } = who;
  const out: Section[] = [
    { key: 'home', label: 'Home', to: '/', icon: 'home', owns: (p) => p === '/' },
    {
      key: 'documents',
      label: 'Documents',
      to: '/documents',
      icon: 'documents',
      owns: (p) => under('/documents')(p) || (who.mode !== 'phone' && p === '/search'),
    },
  ];
  // The family's own details are for the family (5.3): a viewer is given documents.
  if (can(role, 'family.details')) {
    out.push({
      key: 'people',
      label: 'People',
      to: '/people',
      icon: 'people',
      owns: under('/people'),
    });
  }
  if (collectionsOffered(caps, role) || (caps?.features.collections && who.givenCollections)) {
    out.push({
      key: 'collections',
      label: 'Collections',
      to: '/collections',
      icon: 'collections',
      owns: under('/collections'),
    });
  }
  // Reminders are for those who look after the documents: a viewer changes none.
  if (can(role, 'reminder.manage')) {
    out.push({
      key: 'attention',
      label: 'Needs attention',
      to: '/reminders',
      icon: 'attention',
      owns: (p) => p === '/reminders' || p === '/household-questions',
    });
  }
  if (caps?.features.upload_requests && can(role, 'upload_request.create')) {
    out.push({
      key: 'inbox',
      label: 'Inbox',
      to: '/inbox',
      icon: 'inbox',
      ...(who.waiting ? { count: who.waiting } : {}),
      owns: under('/inbox'),
    });
  }
  if (can(role, 'document.share')) {
    out.push({
      key: 'sharing',
      label: 'Sharing',
      to: '/sharing',
      icon: 'sharing',
      owns: under('/sharing'),
    });
  }
  if (can(role, 'audit.read')) {
    out.push({
      key: 'activity',
      label: 'Activity',
      to: '/activity',
      icon: 'activity',
      owns: under('/activity'),
    });
  }
  if (can(role, 'document.edit')) {
    out.push({ key: 'trash', label: 'Trash', to: '/trash', icon: 'trash', owns: under('/trash') });
  }
  return out;
}

export const SETTINGS: Section = {
  key: 'settings',
  label: 'Settings',
  to: '/settings',
  icon: 'settings',
  owns: under('/settings'),
};

/** What the phone's bottom bar has: Home, Search and People stay there, not in the drawer. */
const ON_THE_BAR = new Set(['home', 'people', 'attention']);

// ------------------------------------------------------------- the shell

/** Where the shell's own keys are not to fire: typing, or anything over the page. */
function busyElsewhere(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  const t = e.target;
  if (
    t instanceof HTMLElement &&
    (t.isContentEditable || t.closest('input, textarea, select, [contenteditable="true"]'))
  ) {
    return true;
  }
  return document.querySelector('[aria-modal="true"], [role="menu"]') !== null;
}

export function AppShell() {
  const { caps, session, authVersion, markAuthChanged } = useApp();
  const mode = useShellMode();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const role: Role = session.info?.role ?? storedRole();
  const canAdd = can(role, 'document.add');
  const mayReview = caps?.features.upload_requests === true && can(role, 'upload_request.create');
  const givenOnly = caps?.features.collections === true && !collectionsOffered(caps, role);

  // Who is signed in, for the account menu: the family's list names them
  // to themselves, a guest included (5.34).
  const { data: me } = useLoad(
    async (t) => {
      const people = (await api.members(t)).items;
      return people.find((m) => m.is_me) ?? null;
    },
    [authVersion],
  );
  // What waits in the Inbox, asked again on every move: filing or refusing
  // one is a move back to the Inbox. Not asked at all of anybody else.
  const { data: waiting } = useLoad(
    async (t) => (mayReview ? (await api.incoming(t)).items.length : 0),
    [authVersion, mayReview, pathname],
  );
  // A viewer's collections are only those given to them (5.33).
  const { data: given } = useLoad(
    async (t) => (givenOnly ? (await api.collections(t)).items.length > 0 : false),
    [authVersion, givenOnly],
  );

  const sections = sectionsFor({
    role,
    caps,
    mode,
    givenCollections: given === true,
    waiting: mayReview ? (waiting ?? null) : null,
  });

  const [drawer, setDrawer] = useState(false);
  const hamburger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);

  // The drawer is for this page, on a phone: a move closes it (focus then
  // goes to the new page), and so does a window grown past it.
  const [drawerAt, setDrawerAt] = useState(pathname);
  if (drawerAt !== pathname) {
    setDrawerAt(pathname);
    if (drawer) setDrawer(false);
  }
  if (drawer && mode !== 'phone') setDrawer(false);

  // A new page: focus on its heading, so a screen reader says where they
  // are, and the page from its top. Not on the first page, and not when the
  // screen put focus somewhere itself (Search's field, a status it says).
  const shown = useRef(pathname);
  useEffect(() => {
    if (shown.current === pathname) return;
    shown.current = pathname;
    const box = content.current;
    if (!box) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      box.contains(active) &&
      (active.matches('input, textarea, select') || active.getAttribute('tabindex') === '-1')
    ) {
      return;
    }
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const heading = box.querySelector<HTMLElement>('h1') ?? box.querySelector<HTMLElement>('main');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }, [pathname]);

  // `/` searches and `n` adds, as the prototype has them; never while
  // typing, and never over a sheet, a dialog or a menu.
  // Both as the shell is drawn, not after: a key pressed the moment it is
  // on the screen is heard, with what is true then (as useSheetFocus does).
  const latest = useRef({ mode, canAdd, navigate });
  useLayoutEffect(() => {
    latest.current = { mode, canAdd, navigate };
  });
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' && e.key !== 'n') return;
      if (busyElsewhere(e)) return;
      const now = latest.current;
      if (e.key === '/') {
        e.preventDefault();
        if (now.mode === 'phone' || !search.current) void now.navigate('/search');
        else {
          search.current.focus();
          search.current.select();
        }
      } else if (now.canAdd && now.mode !== 'phone') {
        e.preventDefault();
        void now.navigate('/add');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const signOut = async () => {
    await session.signOut();
    // One render for both, the sign-in page and nobody signed in: apart,
    // the gate saw nobody signed in at the old address first (a move is a
    // transition) and sent them to the welcome page instead.
    startTransition(() => {
      markAuthChanged();
      void navigate('/sign-in', { replace: true });
    });
  };

  const skip = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const target = content.current?.querySelector<HTMLElement>('main') ?? content.current;
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
  };

  const household = caps?.branding.display_name ?? 'Family Document Vault';

  const account = (
    <AccountMenu me={me ?? null} role={role} compact={mode !== 'wide'} onSignOut={signOut} />
  );
  const phone = mode === 'phone';

  // One tree at every width, the page always in the same place in it: a
  // window turned or resized across 768 px keeps what is on the page (a
  // half-filled form) rather than drawing it again from nothing.
  return (
    <div className={`shell shell-${mode}`}>
      <a className="skip-link" href="#main-content" onClick={skip}>
        Skip to main content
      </a>
      {phone ? (
        <header className="phone-bar">
          <button
            ref={hamburger}
            type="button"
            className="icon-btn"
            aria-label="Menu"
            aria-haspopup="dialog"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Icon name="menu" size={24} />
          </button>
          <Link to="/" className="phone-title">
            <span className="muted">Household</span>
            <strong>{household}</strong>
          </Link>
          {account}
        </header>
      ) : (
        <nav className="sidebar" aria-label="Sections">
          <Brand household={household} />
          <SectionList sections={sections} path={pathname} narrow={mode === 'mid'} />
          <div className="side-gap" />
          <SectionList sections={[SETTINGS]} path={pathname} narrow={mode === 'mid'} foot />
        </nav>
      )}
      <div className="shell-main">
        {!phone && (
          <header className="app-bar">
            <SearchBox field={search} />
            <span className="app-bar-gap" />
            {canAdd && <AddControl />}
            {account}
          </header>
        )}
        <div id="main-content" className="shell-content" ref={content}>
          <Outlet />
        </div>
      </div>
      {phone && <BottomBar canAdd={canAdd} sections={sections} path={pathname} />}
      {phone && drawer && (
        <Drawer
          household={household}
          sections={sections.filter((s) => s.key !== 'home' && (!canAdd || !ON_THE_BAR.has(s.key)))}
          path={pathname}
          me={me ?? null}
          role={role}
          returnFocus={hamburger}
          onClose={() => setDrawer(false)}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}

function Brand(props: { household: string; children?: ReactNode }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg
          width="19"
          height="19"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6z" />
        </svg>
      </span>
      <span className="brand-words">
        <span className="brand-name">{props.household}</span>
        <span className="brand-sub">Family Document Vault</span>
      </span>
      {props.children}
    </div>
  );
}

function SectionList(props: {
  sections: Section[];
  path: string;
  /** 768–1023 px: the icon alone, its name beside it on hover or focus. */
  narrow?: boolean;
  foot?: boolean;
  first?: RefObject<HTMLAnchorElement | null>;
  /** One was chosen (the drawer closes, even on the page it is on). */
  onPick?: () => void;
}) {
  return (
    <ul className={`side-list${props.foot ? ' side-foot' : ''}`}>
      {props.sections.map((s, i) => (
        <li key={s.key}>
          <SectionLink
            section={s}
            here={s.owns(props.path)}
            narrow={props.narrow === true}
            linkRef={i === 0 ? props.first : undefined}
            onPick={props.onPick}
          />
        </li>
      ))}
    </ul>
  );
}

function SectionLink({
  section: s,
  here,
  narrow,
  linkRef,
  onPick,
}: {
  section: Section;
  /** This page is the section's: `aria-current`. */
  here: boolean;
  narrow: boolean;
  linkRef?: RefObject<HTMLAnchorElement | null> | undefined;
  onPick?: (() => void) | undefined;
}) {
  return (
    <Link
      ref={linkRef}
      to={s.to}
      onClick={onPick}
      className="side-link"
      data-label={narrow ? s.label : undefined}
      aria-current={here ? 'page' : undefined}
    >
      <Icon name={s.icon} />
      <span className={narrow ? 'visually-hidden' : 'side-label'}>{s.label}</span>
      {s.count !== undefined && (
        <>
          <span className="side-count" aria-hidden="true">
            {s.count}
          </span>
          <span className="visually-hidden">, {s.count} waiting</span>
        </>
      )}
    </Link>
  );
}

/**
 * Search across the vault: Enter opens Search with what was typed, and `/`
 * comes here from anywhere.
 */
function SearchBox({ field }: { field: RefObject<HTMLInputElement | null> }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <form
      role="search"
      className="app-search"
      onSubmit={(e) => {
        e.preventDefault();
        const words = q.trim();
        void navigate(
          words ? `/search?${new URLSearchParams({ q: words }).toString()}` : '/search',
        );
        setQ('');
      }}
    >
      <Icon name="search" size={18} />
      <label htmlFor="app-search-q" className="visually-hidden">
        Search the vault
      </label>
      <input
        ref={field}
        id="app-search-q"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Names, numbers, or words inside a document"
        autoComplete="off"
        aria-keyshortcuts="/"
      />
      <kbd aria-hidden="true">/</kbd>
    </form>
  );
}

/**
 * Add, in the bar on top. In R1 it goes straight to Add; with bulk intake
 * (I1) it becomes a menu button here — "One document" or "Many documents" —
 * and nothing else about the bar changes.
 */
function AddControl() {
  return (
    <Link to="/add" className="btn btn-primary app-add" aria-keyshortcuts="n">
      <Icon name="plus" size={18} />
      Add
    </Link>
  );
}

/** "Owner", "Adult"; a guest is a viewer the family calls a guest (5.34). */
function roleWords(me: Member | null, role: Role): string {
  return me?.kind === 'guest' ? 'Guest' : roleLabel(role);
}

/** Your name, then Settings and Sign out (the account menu). */
function AccountMenu(props: {
  me: Member | null;
  role: Role;
  compact: boolean;
  onSignOut: () => Promise<void>;
}) {
  const [menu, setMenu] = useState<{ start: 'first' | 'last'; at: CSSProperties } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const name = props.me?.display_name ?? 'You';
  const open = (start: 'first' | 'last') => setMenu({ start, at: beside(button.current) });
  return (
    <div className="account">
      <button
        ref={button}
        type="button"
        className={props.compact ? 'icon-btn account-btn' : 'btn btn-quiet account-btn'}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-controls={menu ? id : undefined}
        aria-label={`Your account: ${name}`}
        onClick={() => (menu ? setMenu(null) : open('first'))}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          open(e.key === 'ArrowUp' ? 'last' : 'first');
        }}
      >
        {props.me ? (
          <PersonAvatar person={props.me} size={props.compact ? 34 : 30} />
        ) : (
          <span className="avatar account-blank" aria-hidden="true" />
        )}
        {!props.compact && (
          <>
            <span className="account-name">{name}</span>
            <Icon name="chevron" size={16} />
          </>
        )}
      </button>
      {menu && (
        <AccountMenuBox
          id={id}
          name={name}
          role={roleWords(props.me, props.role)}
          start={menu.start}
          at={menu.at}
          returnFocus={button}
          onClose={() => setMenu(null)}
          onSignOut={props.onSignOut}
        />
      )}
    </div>
  );
}

function AccountMenuBox(props: {
  id: string;
  name: string;
  role: string;
  start: 'first' | 'last';
  at: CSSProperties;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSignOut: () => Promise<void>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLAnchorElement>(null);
  const last = useRef<HTMLButtonElement>(null);
  useSheetFocus(box, {
    start: props.start === 'last' ? last : first,
    onEscape: props.onClose,
    returnFocus: props.returnFocus,
  });
  const [busy, setBusy] = useState(false);
  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const now = items.findIndex((item) => item === document.activeElement);
    const end = items.length - 1;
    const to = (
      {
        ArrowDown: now < end ? now + 1 : 0,
        ArrowUp: now > 0 ? now - 1 : end,
        Home: 0,
        End: end,
      } as Record<string, number>
    )[e.key];
    if (to === undefined) return;
    e.preventDefault();
    items[to]?.focus();
  };
  return (
    <div
      className="menu-layer"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={box} className="menu-box account-box" style={props.at}>
        <div className="account-head">
          <strong>{props.name}</strong>
          <span className="muted">{props.role}</span>
        </div>
        <div id={props.id} role="menu" aria-label="Your account" onKeyDown={move}>
          <Link
            ref={first}
            to="/settings"
            role="menuitem"
            className="menu-item"
            onClick={props.onClose}
          >
            <Icon name="settings" />
            Settings
          </Link>
          <button
            ref={last}
            type="button"
            role="menuitem"
            className="menu-item"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void props.onSignOut();
            }}
          >
            <Icon name="signOut" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The phone's bar at the bottom, as it was: Home, Search, Add, Needs
 * attention and People, each where it is theirs. Somebody who adds nothing
 * has Documents and their collections there instead.
 */
function BottomBar(props: { canAdd: boolean; sections: Section[]; path: string }) {
  const has = (key: string) => props.sections.find((s) => s.key === key);
  const item = (s: Pick<Section, 'key' | 'label' | 'to' | 'icon'>, current: boolean) => (
    <Link key={s.key} to={s.to} className="nav-item" aria-current={current ? 'page' : undefined}>
      <Icon name={s.icon} size={22} />
      <span>{s.label}</span>
    </Link>
  );
  const home = has('home');
  const search = { key: 'search', label: 'Search', to: '/search', icon: 'search' as const };
  const rest = props.canAdd
    ? (['attention', 'people'] as const)
    : (['documents', 'collections'] as const);
  return (
    <nav className="bottomnav" aria-label="Main">
      {home && item(home, home.owns(props.path))}
      {item(search, props.path === '/search')}
      {/* A viewer can open and download, and nothing else: an Add button
          that always refuses is worse than no Add button. */}
      {props.canAdd && (
        <Link to="/add" className="fab" aria-label="Add a document">
          <Icon name="plus" size={26} />
        </Link>
      )}
      {rest.map((key) => {
        const s = has(key);
        return s ? item(s, s.owns(props.path)) : null;
      })}
    </nav>
  );
}

/**
 * The phone's drawer: the sections the bottom bar has no room for, then
 * Settings, then who is signed in and Sign out. A modal: focus starts on
 * the first section and stays inside; Escape, the close button or a tap
 * beside it closes it, and focus goes back to the menu button.
 */
function Drawer(props: {
  household: string;
  sections: Section[];
  path: string;
  me: Member | null;
  role: Role;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSignOut: () => Promise<void>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLAnchorElement>(null);
  useSheetFocus(box, { start: first, onEscape: props.onClose, returnFocus: props.returnFocus });
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="drawer-layer"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={box} className="drawer" role="dialog" aria-modal="true" aria-label="Menu">
        <Brand household={props.household}>
          <button
            type="button"
            className="icon-btn icon-btn-plain"
            aria-label="Close the menu"
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </Brand>
        <nav aria-label="Sections">
          <SectionList
            sections={props.sections}
            path={props.path}
            first={first}
            onPick={props.onClose}
          />
          <SectionList sections={[SETTINGS]} path={props.path} onPick={props.onClose} foot />
        </nav>
        <div className="side-gap" />
        <div className="drawer-me">
          {props.me && <PersonAvatar person={props.me} size={36} />}
          <span className="drawer-me-words">
            <strong>{props.me?.display_name ?? ''}</strong>
            <span className="muted">{roleWords(props.me, props.role)}</span>
          </span>
          <button
            type="button"
            className="btn btn-quiet"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void props.onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
