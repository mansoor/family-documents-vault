import { can, type Capabilities, type Role } from '@fdv/shared';
import { Link, Outlet, useLocation } from 'react-router';
import { useApp } from './app-context.js';
import { storedRole } from './session.js';
import { useShellMode } from './shell.js';

/**
 * Settings in sections (Phase 6, the owner's ask): Your account,
 * Notifications, Household, Your data and For owners, each with an address
 * of its own. From 768 px a sub-menu, "Settings sections", down the left
 * of the Settings area, the chosen section beside it at a form's width; on
 * a phone, Settings is the list of the sections, each opening its page.
 *
 * Each section shows what that role was shown before, and nothing more: a
 * role with nothing in a section is not offered the section. The pages that
 * had addresses of their own keep them, each under its section: Family and
 * Kinds of document under Household, Where your files are kept and Where
 * email comes from under For owners.
 */
export type SectionKey = 'account' | 'notifications' | 'household' | 'data' | 'owners';

export interface SettingsSection {
  key: SectionKey;
  /** The section's own address. */
  to: string;
  label: string;
  /** What is in it, for this reader. */
  note: string;
  /** The addresses it holds: its own, and the pages under it. */
  holds: (pathname: string) => boolean;
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

/** The Household section's pages, for this reader: each where it was shown before. */
export function householdRows(role: Role, caps: Capabilities | null): SettingsRow[] {
  return [
    // Who sees the identity details on each profile (5.27, A34): an owner's.
    ...(caps?.features.member_identity && can(role, 'identity.audience')
      ? [{ to: '/settings/family', title: 'Family', note: 'Who can see identity details' }]
      : []),
    ...(caps?.features.custom_types && can(role, 'types.manage')
      ? [
          {
            to: '/settings/kinds',
            title: 'Kinds of document',
            note: 'What the family keeps, and what the card asks for each',
          },
        ]
      : []),
  ];
}

/** The For owners section's pages: an owner's. */
export const OWNER_ROWS: SettingsRow[] = [
  {
    to: '/settings/storage',
    title: 'Where your files are kept',
    note: 'Local disk, or your own S3-compatible bucket',
  },
  {
    to: '/settings/email',
    title: 'Where email comes from',
    note: 'The mail server reminders and invitations are sent through',
  },
];

/** The household's rule for Only me documents and links (5.41): read by owners and adults. */
export const readsOnlyMeRule = (role: Role) => can(role, 'document.share');

/** The sections this reader has, in order. */
export function settingsSections(
  role: Role,
  caps: Capabilities | null,
  owner: boolean,
): SettingsSection[] {
  const out: SettingsSection[] = [
    {
      key: 'account',
      to: '/settings/account',
      label: 'Your account',
      note: 'Password, two-step sign-in, passkeys, devices, shortcuts',
      holds: at('/settings/account'),
    },
    {
      key: 'notifications',
      to: '/settings/notifications',
      label: 'Notifications',
      note: 'How you hear about things',
      holds: at('/settings/notifications'),
    },
  ];
  const household = householdRows(role, caps);
  if (readsOnlyMeRule(role) || household.length > 0) {
    out.push({
      key: 'household',
      to: '/settings/household',
      label: 'Household',
      note: [
        readsOnlyMeRule(role) ? 'Only me documents' : null,
        ...household.map((r) => (r.title === 'Family' ? 'identity details' : 'kinds of document')),
      ]
        .filter(Boolean)
        .join(', ')
        .replace(/^./, (c) => c.toUpperCase()),
      holds: at('/settings/household', '/settings/family', '/settings/kinds'),
    });
  }
  // Only to whoever may export (5.35): a viewer, a guest or a teen asking
  // would be refused.
  if (can(role, 'export.request')) {
    out.push({
      key: 'data',
      to: '/settings/data',
      label: 'Your data',
      note: 'Export everything',
      holds: at('/settings/data'),
    });
  }
  if (owner) {
    out.push({
      key: 'owners',
      to: '/settings/owners',
      label: 'For owners',
      note: 'Where files are kept, where email comes from',
      holds: at('/settings/owners', '/settings/storage', '/settings/email'),
    });
  }
  return out;
}

/** This reader's sections. */
export function useSettingsSections(): SettingsSection[] {
  const { caps, session } = useApp();
  const role: Role = session.info?.role ?? storedRole();
  return settingsSections(role, caps, role === 'owner');
}

/**
 * Settings' frame (/settings/*): from 768 px the sub-menu beside the page;
 * on a phone, the page alone, its Back to Settings in its bar.
 */
export function SettingsLayout() {
  const wide = useShellMode() !== 'phone';
  return wide ? (
    <div className="settings-area">
      <SettingsNav />
      <Outlet />
    </div>
  ) : (
    <Outlet />
  );
}

/** "Settings sections": a list of links, the current one marked (not tabs). */
function SettingsNav() {
  const sections = useSettingsSections();
  const { pathname } = useLocation();
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <ul className="settings-nav-list">
        {sections.map((s) => {
          const here = s.holds(pathname);
          return (
            <li key={s.key}>
              <Link
                to={s.to}
                // The section's own page; on a page under it, the section it is in.
                aria-current={here ? (pathname === s.to ? 'page' : 'true') : undefined}
              >
                <span className="settings-nav-label">{s.label}</span>
                <span className="settings-nav-note">{s.note}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <ElsewhereNote />
      <ServerLine />
    </nav>
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
