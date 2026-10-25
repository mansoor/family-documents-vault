import { can, type Capabilities, type Role } from '@fdv/shared';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useApp } from './app-context.js';
import { storedRole } from './session.js';
import { useShellMode } from './shell.js';
import { Splitter, useKeptWidth, type WidthBounds } from './splitter.js';

/**
 * Settings in sections (Phase 6, the owner's ask), each with an address of
 * its own, in three groups since 0.9.0 (the owner's ask of 25 Oct 2026: too
 * many at the top, some nested):
 *
 *  - You: Your account, Notifications, Your computers, Your data.
 *  - Household: Privacy, Time zone, Kinds of document, Tags — an owner
 *    changes them; everybody else reads what is theirs, as before.
 *  - Server and reading, an owner's: Storage, Email in and out, Scanner
 *    folder, Reading and the check. What was the For owners page's list,
 *    each now in the menu itself; /settings/owners opens Storage.
 *
 * From 768 px a menu, "Settings sections", down the left of the Settings
 * area, as wide as its person dragged it, and the chosen page across the
 * rest of the width; on a phone, Settings is the list of the groups, each
 * section opening its page.
 *
 * Each section shows what that role was shown before, and nothing more: a
 * role with nothing in a section is not offered the section, and a group
 * with no section of theirs is not offered at all. The pages that had
 * addresses of their own keep them: Family under Privacy, as before; Where
 * email comes from and Email in are the two parts of Email in and out, and
 * Reading and the Reading check the two parts of Reading and the check —
 * each address opens the page at its part. Household became Privacy for
 * 0.8.0 (the owner's ask of 17 Oct 2026); /settings/household still opens
 * Privacy.
 */
export type SectionKey =
  | 'account'
  | 'notifications'
  | 'computers'
  | 'data'
  | 'privacy'
  | 'timezone'
  | 'kinds'
  | 'tags'
  | 'storage'
  | 'email'
  | 'scanner'
  | 'reading';

export type GroupKey = 'you' | 'household' | 'server';

export interface SettingsSection {
  key: SectionKey;
  /** The section's own address: where its link goes. */
  to: string;
  label: string;
  /** What is in it, for this reader. */
  note: string;
  /** The addresses that are this section's page itself: its own, and a part's. */
  pages: string[];
  /** The addresses it holds: its pages, and the pages under it. */
  holds: (pathname: string) => boolean;
}

export interface SettingsGroup {
  key: GroupKey;
  label: string;
  /** An owner's alone: said beside its name. */
  owners: boolean;
  sections: SettingsSection[];
}

/** A row of a section that opens a page of its own. */
export interface SettingsRow {
  to: string;
  title: string;
  note: string;
}

const at =
  (...bases: string[]) =>
  (path: string) =>
    bases.some((b) => path === b || path.startsWith(`${b}/`));

/** A section whose page is at its own address alone, holding those under it. */
const section = (
  key: SectionKey,
  to: string,
  label: string,
  note: string,
  more: { pages?: string[]; under?: string[] } = {},
): SettingsSection => {
  const pages = more.pages ?? [to];
  return { key, to, label, note, pages, holds: at(...pages, ...(more.under ?? [])) };
};

/** The Privacy section's pages, for this reader: each where it was shown before. */
export function privacyRows(role: Role, caps: Capabilities | null): SettingsRow[] {
  // Who sees the identity details on each profile (5.27, A34): an owner's.
  return caps?.features.member_identity && can(role, 'identity.audience')
    ? [{ to: '/settings/family', title: 'Family', note: 'Who can see identity details' }]
    : [];
}

/** Whether this reader manages the kinds of document (5.12): the Kinds of document section. */
export const managesKinds = (role: Role, caps: Capabilities | null): boolean =>
  caps?.features.custom_types === true && can(role, 'types.manage');

/**
 * Whether this reader manages the household's tags (0.9.0, T1): whoever may
 * change documents — owners, adults and teens; never a viewer or a guest.
 */
export const managesTags = (role: Role, caps: Capabilities | null): boolean =>
  caps?.features.tag_management === true && can(role, 'document.edit');

/** The household's rule for Only me documents and links (5.41): read by owners and adults. */
export const readsOnlyMeRule = (role: Role) => can(role, 'document.share');

/** This reader's groups, in order, each with their sections in it; none left empty. */
export function settingsGroups(
  role: Role,
  caps: Capabilities | null,
  owner: boolean,
): SettingsGroup[] {
  const you: SettingsSection[] = [
    section(
      'account',
      '/settings/account',
      'Your account',
      'Password, two-step sign-in, passkeys, devices, shortcuts',
    ),
    section(
      'notifications',
      '/settings/notifications',
      'Notifications',
      'How you hear about things',
    ),
  ];
  // A computer that sends scans (0.8.0, D1): whoever may add documents.
  if (caps?.features.device_uploads === true && can(role, 'document.add')) {
    you.push(
      section(
        'computers',
        '/settings/computers',
        'Your computers',
        owner ? 'Send scans from a computer; the family’s computers' : 'Send scans from a computer',
      ),
    );
  }
  // Only to whoever may export (5.35): a viewer, a guest or a teen asking
  // would be refused.
  if (can(role, 'export.request')) {
    you.push(section('data', '/settings/data', 'Your data', 'Export everything'));
  }

  const household: SettingsSection[] = [];
  const privacy = privacyRows(role, caps);
  if (readsOnlyMeRule(role) || privacy.length > 0) {
    household.push(
      section(
        'privacy',
        '/settings/privacy',
        'Privacy',
        [
          readsOnlyMeRule(role) ? 'Only me documents outside the family' : null,
          privacy.length > 0 ? 'who sees identity details' : null,
        ]
          .filter(Boolean)
          .join('; ')
          .replace(/^./, (c) => c.toUpperCase()),
        // Family, who sees identity details, is a page under it, as before.
        { under: ['/settings/family'] },
      ),
    );
  }
  // The family's clock (0.9.0, TZ): everybody's times are on it, so everybody
  // reads it here; an owner changes it.
  if (caps?.features.household_timezone === true) {
    household.push(
      section(
        'timezone',
        '/settings/time-zone',
        'Time zone',
        owner
          ? 'The family’s clock: times, reminders and link ends'
          : 'The family’s clock, that every time is shown on',
      ),
    );
  }
  // Kinds of document (5.12), a section of its own since 0.8.0: whoever manages
  // them; a kind's own page (/settings/kinds/new, /settings/kinds/:key) under it.
  if (managesKinds(role, caps)) {
    household.push(
      section(
        'kinds',
        '/settings/kinds',
        'Kinds of document',
        'What the family keeps, and what the card asks for each',
      ),
    );
  }
  // Tags (0.9.0, T1), after Kinds of document: whoever may change documents.
  if (managesTags(role, caps)) {
    household.push(
      section(
        'tags',
        '/settings/tags',
        'Tags',
        'Rename, merge and delete the tags on your documents',
      ),
    );
  }

  // The server, and how the vault reads: an owner's, as For owners was.
  const server: SettingsSection[] = owner
    ? [
        section('storage', '/settings/storage', 'Storage', 'Where your files are kept'),
        section(
          'email',
          '/settings/email',
          'Email, in and out',
          'The mail server it sends through; documents emailed in',
          { pages: ['/settings/email', '/settings/email-in'] },
        ),
        // Offered to every owner, so its page can say why it is off when
        // the folder is not set up (S3).
        section(
          'scanner',
          '/settings/scanner',
          'Scanner folder',
          'Scan straight into someone’s Inbox',
        ),
        section(
          'reading',
          '/settings/reading',
          'Reading and the check',
          'The reading model, the local AI, and how well it reads',
          { pages: ['/settings/reading', '/settings/reading-check'] },
        ),
      ]
    : [];

  return (
    [
      { key: 'you', label: 'You', owners: false, sections: you },
      { key: 'household', label: 'Household', owners: false, sections: household },
      { key: 'server', label: 'Server and reading', owners: true, sections: server },
    ] satisfies SettingsGroup[]
  ).filter((g) => g.sections.length > 0);
}

/** The sections this reader has, in order, across the groups. */
export function settingsSections(
  role: Role,
  caps: Capabilities | null,
  owner: boolean,
): SettingsSection[] {
  return settingsGroups(role, caps, owner).flatMap((g) => g.sections);
}

/** This reader's groups. */
export function useSettingsGroups(): SettingsGroup[] {
  const { caps, session } = useApp();
  const role: Role = session.info?.role ?? storedRole();
  return settingsGroups(role, caps, role === 'owner');
}

/** This reader's sections. */
export function useSettingsSections(): SettingsSection[] {
  return useSettingsGroups().flatMap((g) => g.sections);
}

/** A group's name, and "· owners" beside it where it is an owner's alone. */
export function GroupName({ group }: { group: SettingsGroup }) {
  return (
    <>
      {group.label}
      {group.owners && (
        <>
          {' '}
          <span className="settings-for">· owners</span>
        </>
      )}
    </>
  );
}

/**
 * The menu's width, in pixels: as it starts, and how narrow or wide it may
 * be dragged. It starts at its narrowest on a tablet (768 to 1023 px, beside
 * the sidebar's icons), where the page has the less room; a width kept
 * wins at any size.
 */
export const MENU_WIDTH: WidthBounds = { start: 248, min: 200, max: 360, step: 16 };
export const MENU_WIDTH_MID: WidthBounds = { ...MENU_WIDTH, start: 200 };

/** Where each person's menu width is kept, on this device. */
export const menuWidthKey = (memberId: string | null) =>
  `fdv.settings.menu-width.${memberId ?? 'nobody'}`;

/**
 * Settings' frame (/settings/*): from 768 px the menu beside the page, the
 * line between them dragged (or moved with the arrow keys) to widen it;
 * on a phone, the page alone, its Back to Settings in its bar.
 */
export function SettingsLayout() {
  const mode = useShellMode();
  const wide = mode !== 'phone';
  const bounds = mode === 'mid' ? MENU_WIDTH_MID : MENU_WIDTH;
  const { session } = useApp();
  const [width, setWidth, keepWidth] = useKeptWidth(
    menuWidthKey(session.info?.member_id ?? null),
    bounds,
  );
  return wide ? (
    <div className="settings-area">
      {/* The line is in the menu's landmark, at its edge, beside the page. */}
      <nav className="settings-side" aria-label="Settings sections">
        <SettingsNav width={width} />
        <Splitter
          className="settings-resizer"
          label="Width of the Settings menu"
          controls="settings-menu"
          width={width}
          bounds={bounds}
          onWidth={setWidth}
          onDone={keepWidth}
        />
      </nav>
      <Outlet />
    </div>
  ) : (
    <Outlet />
  );
}

/** "Settings sections": the groups, each its links, the current one marked (not tabs). */
function SettingsNav({ width }: { width: number }) {
  const groups = useSettingsGroups();
  const { pathname } = useLocation();
  const menu = useRef<HTMLDivElement>(null);
  // The section marked as current, in sight in the menu: on a short window
  // an owner's menu scrolls, and a page opened from elsewhere (a link, a
  // bookmark) would leave its section out of view below.
  useEffect(() => {
    const box = menu.current;
    const here = box?.querySelector<HTMLElement>('a[aria-current]');
    if (!box || !here) return;
    const b = box.getBoundingClientRect();
    const h = here.getBoundingClientRect();
    if (h.top >= b.top && h.bottom <= b.bottom) return;
    box.scrollTop += h.top - b.top - (b.height - h.height) / 2;
  }, [pathname]);
  return (
    <div id="settings-menu" className="settings-nav" style={{ width }} ref={menu}>
      {groups.map((g) => (
        <div key={g.key} className="settings-nav-group">
          {/* Each group's list named by its heading's words: not a heading
              itself, so the page's own h1 stays its first (the menu is
              before it), as the sidebar's sections are. */}
          <p id={`settings-group-${g.key}`} className="settings-nav-h">
            <GroupName group={g} />
          </p>
          <ul className="settings-nav-list" aria-labelledby={`settings-group-${g.key}`}>
            {g.sections.map((s) => {
              const here = s.holds(pathname);
              return (
                <li key={s.key}>
                  <Link
                    to={s.to}
                    // The section's own page; on a page under it, the section it is in.
                    aria-current={here ? (s.pages.includes(pathname) ? 'page' : 'true') : undefined}
                  >
                    <SettingsIcon name={s.key} />
                    <span className="settings-nav-words">
                      <span className="settings-nav-label">{s.label}</span>
                      <span className="settings-nav-note">{s.note}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <ElsewhereNote />
      <ServerLine />
    </div>
  );
}

/** Each section's icon, drawn in strokes as the sidebar's are. */
const DRAWN: Record<SectionKey, ReactNode> = {
  account: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  notifications: (
    <>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z" />
      <path d="M10 20.5h4" />
    </>
  ),
  computers: (
    <>
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  data: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 16.5v3h15v-3" />
    </>
  ),
  privacy: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="1.5" />
      <path d="M8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3" />
    </>
  ),
  timezone: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  kinds: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
      <circle cx="16.75" cy="16.75" r="3.25" />
    </>
  ),
  tags: (
    <>
      <path d="M3.5 4.5v6.3l9.2 9.2a1.5 1.5 0 0 0 2.1 0l5.2-5.2a1.5 1.5 0 0 0 0-2.1L10.8 3.5H4.5a1 1 0 0 0-1 1z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  storage: (
    <>
      <rect x="3.5" y="4" width="17" height="7" rx="1.5" />
      <rect x="3.5" y="13" width="17" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  email: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  scanner: (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M4 12h16" />
    </>
  ),
  reading: (
    <>
      <path d="M12 6.5c-1.8-1.3-4.5-2-8-2v13c3.5 0 6.2.7 8 2 1.8-1.3 4.5-2 8-2v-13c-3.5 0-6.2.7-8 2z" />
      <path d="M12 6.5v13" />
    </>
  ),
};

/** A section's icon: beside its name, never in place of it. */
export function SettingsIcon({ name }: { name: SectionKey }) {
  return (
    <svg
      className="icon settings-icon"
      aria-hidden="true"
      width="20"
      height="20"
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

/** The rows of a section that open pages of their own. */
export function SettingsRows({ rows, label }: { rows: SettingsRow[]; label: string }) {
  if (rows.length === 0) return null;
  return (
    <ul className="list" aria-label={label}>
      {rows.map((r) => (
        <li key={r.to}>
          <Link to={r.to} className="rowbtn">
            <span className="doc-title">{r.title}</span>
            <span className="muted">{r.note}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The household's name and the vault's version, as Settings has said since the start. */
export function ServerLine() {
  const { caps } = useApp();
  return (
    <p className="muted settings-server">
      {caps?.branding.display_name} · Server {caps?.server_version}
    </p>
  );
}

/**
 * Where what Settings used to hold is now (R1), for whoever looks for it
 * here: each only where it is theirs.
 */
export function ElsewhereNote() {
  const { caps, session } = useApp();
  const role = storedRole();
  const inbox = caps?.features.upload_requests === true && can(role, 'upload_request.create');
  const sharing = can(role, 'document.share');
  const outside = caps?.features.guests === true && session.info?.role === 'owner';
  const activity = can(role, 'audit.read');
  const trash = can(role, 'document.edit');
  const lines = [
    inbox && (
      <li key="inbox">
        {/* Their own tab since I1: the Inbox opens on your uploads. */}
        <Link to="/inbox/sent">Files sent to you</Link> are in the Inbox
      </li>
    ),
    sharing && (
      <li key="sharing">
        <Link to="/sharing">Sharing</Link>: links, and asking for documents
      </li>
    ),
    outside && (
      <li key="outside">
        <Link to="/people/outside">People outside the family</Link> are under People
      </li>
    ),
    activity && trash && (
      <li key="activity">
        <Link to="/activity">Activity</Link> and <Link to="/trash">Trash</Link> have their own
        places
      </li>
    ),
    activity && !trash && (
      <li key="activity">
        <Link to="/activity">Activity</Link> has its own place
      </li>
    ),
  ].filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div className="elsewhere">
      <p>
        <strong>Settings holds settings only.</strong>
      </p>
      <ul>{lines}</ul>
    </div>
  );
}
