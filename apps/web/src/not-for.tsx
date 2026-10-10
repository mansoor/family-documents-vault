import { can, refusalFor, type Capabilities, type Role } from '@fdv/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useApp } from './app-context.js';
import { storedRole } from './session.js';
import { inboxFor } from './shell.js';
import { TopBar } from './ui.js';

/**
 * A screen typed into the address bar by somebody whose role cannot use it
 * (Phase 6, the prototype's `notFor`): its name, and a sentence saying who
 * it is for — never the screen, nor anything asked of the vault for it. The
 * vault refuses all the same; the rules stay in roles.ts, and here only
 * decide what is drawn, as the sidebar decides what is offered.
 */
export interface ScreenRule {
  /** Whether this reader may use it, as the sidebar decides whether to offer it. */
  may: (role: Role, caps: Capabilities | null) => boolean;
  /** The screen's name, as its heading says it. */
  title: string;
  /** Who it is for, in a sentence. */
  why: string;
}

const owner = (role: Role) => role === 'owner';

export const SCREEN_RULES = {
  add: {
    may: (role) => can(role, 'document.add'),
    title: 'Add a document',
    why: 'Viewers can open and download documents, but not add them.',
  },
  addMany: {
    may: (role) => can(role, 'document.add'),
    title: 'Add many documents',
    why: 'Viewers can open and download documents, but not add them.',
  },
  people: {
    may: (role) => can(role, 'family.details'),
    title: 'People',
    why: 'The family’s own details are for the family. You see the documents you are given.',
  },
  outside: {
    may: owner,
    title: 'People outside the family',
    why: 'Only an owner sees who outside the family has a sign-in.',
  },
  inbox: {
    may: (role, caps) => inboxFor(role, caps),
    title: 'Inbox',
    why: 'Only those who add documents have an Inbox.',
  },
  sent: {
    may: (role, caps) =>
      caps?.features.upload_requests === true && can(role, 'upload_request.create'),
    title: 'Inbox',
    why: refusalFor('upload_request.create'),
  },
  batches: {
    may: (role, caps) => caps?.features.batches === true && can(role, 'document.add'),
    title: 'Inbox',
    why: 'Only those who add documents have an Inbox.',
  },
  sharing: {
    may: (role) => can(role, 'document.share'),
    title: 'Sharing',
    why: 'Only an adult can share a document outside the family.',
  },
  ask: {
    may: (role) => can(role, 'upload_request.create'),
    title: 'Ask for documents',
    // As its screen said it before.
    why: 'Only an owner or an adult can ask someone to send documents.',
  },
  activity: {
    may: (role) => can(role, 'audit.read'),
    title: 'Activity',
    why: 'Viewers can open and download documents, but not see what the family has been doing.',
  },
  afterRestore: {
    may: (role) => can(role, 'document.share'),
    title: 'After a restore',
    why: 'Links a restore paused are for those who share documents: the owners, and the adults for their own.',
  },
  data: {
    may: (role) => can(role, 'export.request'),
    title: 'Your data',
    why: refusalFor('export.request'),
  },
  // Each as its page said it before.
  owners: { may: owner, title: 'For owners', why: refusalFor('storage.manage') },
  storage: { may: owner, title: 'Where your files are kept', why: refusalFor('storage.manage') },
  email: { may: owner, title: 'Where email comes from', why: refusalFor('notifications.manage') },
} satisfies Record<string, ScreenRule>;

/** "This isn't something you can open": the screen's name, and who it is for. */
export function NotFor({ rule }: { rule: Pick<ScreenRule, 'title' | 'why'> }) {
  return (
    <main className="page page-top has-nav notfor-page">
      <TopBar title={rule.title} />
      <div className="notfor">
        <p className="lede">This isn’t something you can open.</p>
        <p>{rule.why}</p>
        <Link to="/" className="btn btn-quiet">
          Go to Home
        </Link>
      </div>
    </main>
  );
}

/** The screen, for whoever may use it; anybody else, `NotFor` — and nothing of the screen is drawn. */
export function Only({ rule, children }: { rule: ScreenRule; children: ReactNode }) {
  const { caps, session } = useApp();
  const role: Role = session.info?.role ?? storedRole();
  return rule.may(role, caps) ? <>{children}</> : <NotFor rule={rule} />;
}
