import {
  can,
  roleChangeEffects,
  roleDescription,
  roleLabel,
  ROLES,
  type Role,
  type RoleChangeEffect,
} from '@fdv/shared';
import { useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { api, type Member, type OwnerChange, type RoleChangeResult } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ErrorNote, Pills, useSheetFocus } from '../ui.js';

/**
 * Changing what somebody is allowed to do (SHR-09, SHR-10).
 *
 * Two pieces. The notice board comes first, because a request to take
 * somebody's owner role away is the most consequential thing that can be
 * happening in a household and it must not be somewhere you have to go
 * looking. The per-person controls are behind a tap on the person, where
 * the decision belongs.
 */

export function OwnerChangeNotices(props: {
  items: OwnerChange[];
  onChanged: () => Promise<void>;
}) {
  const { guarded } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = props.items.filter((r) => r.state === 'waiting' || r.state === 'ready');
  if (live.length === 0) return null;

  const act = async (id: string, fn: (t: string) => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await guarded(fn);
      await props.onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="stack">
      {live.map((r) => (
        <div key={r.id} className="card stack" style={{ borderColor: '#b45309' }}>
          <span className="status status-warn">
            {r.about_me ? 'About your own account' : 'Waiting'}
          </span>
          <p>{r.summary}</p>
          <ErrorNote message={error} />
          <div className="row">
            {/* Refusing belongs to the person it is about, and to nobody
                else — that is the whole point of the seven days. */}
            {r.about_me && (
              <Button
                disabled={busy === r.id}
                onClick={() => void act(r.id, (t) => api.refuseOwnerChange(t, r.id))}
              >
                No, I am staying an owner
              </Button>
            )}
            {!r.about_me && r.state === 'ready' && (
              <Button
                disabled={busy === r.id}
                onClick={() => void act(r.id, (t) => api.completeOwnerChange(t, r.id))}
              >
                Carry it out
              </Button>
            )}
            {!r.about_me && (
              <Button
                kind="quiet"
                disabled={busy === r.id}
                onClick={() => void act(r.id, (t) => api.withdrawOwnerChange(t, r.id))}
              >
                Withdraw it
              </Button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * What an owner can do about one person, on that person's own page. The
 * roles to choose from sit behind a dialog that says what the change does
 * besides (5.30), so nobody is made a viewer without being told their phone
 * gives up what it keeps.
 */
export function RoleControls(props: { member: Member; onChanged: () => Promise<void> }) {
  const { guarded, session } = useApp();
  const myRole: Role = storedRole();
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);

  const isMe = props.member.id === session.info?.member_id;
  if (!props.member.has_account && props.member.sign_in_removed && can(myRole, 'member.remove')) {
    // Never to somebody who has passed away (5.25): the vault refuses it.
    if (props.member.is_deceased) return null;
    return <GiveSignInBack member={props.member} onChanged={props.onChanged} />;
  }
  if (!can(myRole, 'role.change') || !props.member.has_account || isMe) return null;

  const run = async (fn: (t: string) => Promise<{ message: string } | void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await guarded(fn);
      if (result && 'message' in result) setNote(result.message);
      await props.onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const role: Role = props.member.role ?? 'adult';
  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>What {props.member.display_name} can do</h2>
      <p>
        <strong>{roleLabel(role)}.</strong> {roleDescription(role)}
      </p>
      <ErrorNote message={error} />
      {/* What the change did: the first thing heard once the dialog has gone. */}
      <p ref={status} className="status status-ok" role="status" tabIndex={-1} hidden={!note}>
        {note}
      </p>
      <div className="row">
        <Button
          ref={opener}
          disabled={busy}
          onClick={() => {
            setNote(null);
            setError(null);
            setChanging(true);
          }}
        >
          Change what they can do
        </Button>
      </div>
      {changing && (
        <RoleDialog
          member={props.member}
          returnFocus={opener}
          onDone={async (result) => {
            flushSync(() => {
              setChanging(false);
              setNote(result.message);
            });
            status.current?.focus();
            await props.onChanged();
          }}
          onCancel={() => setChanging(false)}
        />
      )}

      {confirmRemoval ? (
        <div className="stack">
          <p>
            {props.member.display_name} will not be able to sign in. They stay in the family and
            their documents are untouched. You can give the sign-in back later, and they will use
            their own password, as before.
          </p>
          <div className="row">
            <Button
              disabled={busy}
              onClick={() => void run((t) => api.removeSignIn(t, props.member.id))}
            >
              Yes, take their sign-in away
            </Button>
            <Button kind="quiet" onClick={() => setConfirmRemoval(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button kind="quiet" onClick={() => setConfirmRemoval(true)}>
          Take away their sign-in
        </Button>
      )}
    </section>
  );
}

/** What a change of role does besides the role (5.30), as the vault does it (co-owners.ts). */
const EFFECT_LINES: Record<RoleChangeEffect, string> = {
  offline_ended: 'Their phone removes the Essentials it keeps at its next sync.',
  requests_closed:
    'Their upload requests close, and files sent for them alone to look at go to the owners.',
  exports_ended: 'Their exports stop working.',
};

/**
 * What changing somebody from one role to another does, line by line, before
 * it is done: what it takes away (`roleChangeEffects`), and what a change to
 * or from owner is. Empty when nothing would change.
 */
export function roleChangeLines(name: string, from: Role, to: Role): string[] {
  if (from === to) return [];
  if (from === 'owner') {
    return to === 'adult'
      ? [
          `Taking away an owner’s role takes seven days. ${name} is told at once and can refuse in that time, and nothing changes until then.`,
        ]
      : ['An owner can only be made an adult. Change it again afterwards if you need to.'];
  }
  const lines: string[] = [];
  if (to === 'owner') {
    lines.push(
      `${name} can change where your files are kept, who is in the family, and the emergency contacts, from now on. Every adult is told.`,
    );
  }
  lines.push(...roleChangeEffects(from, to).map((e) => EFFECT_LINES[e]));
  if (lines.length === 0) {
    lines.push(`${name} keeps their sign-in, and what their phone keeps.`);
  }
  return lines;
}

/**
 * "Change what Tess can do" (5.30): the roles, and under them what the one
 * chosen does besides — each line following the choice. Focus starts on the
 * heading, so the dialog is read from its top; Tab stays inside, and Escape
 * cancels until the change is on its way (useSheetFocus).
 */
function RoleDialog(props: {
  member: Member;
  /** Where focus goes once it has gone, if the browser remembered nowhere. */
  returnFocus: RefObject<HTMLElement | null>;
  onDone: (result: RoleChangeResult) => Promise<void>;
  onCancel: () => void;
}) {
  const { guarded } = useApp();
  const name = props.member.display_name;
  const from: Role = props.member.role ?? 'adult';
  const [role, setRole] = useState<Role>(from);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useSheetFocus(box, {
    start: heading,
    onEscape: props.onCancel,
    busy,
    returnFocus: props.returnFocus,
  });

  const lines = roleChangeLines(name, from, role);
  // An owner is only ever made an adult (co-owners.ts): anything else is refused.
  const refused = from === 'owner' && role !== 'owner' && role !== 'adult';
  const waits = from === 'owner' && role === 'adult';
  const blocked = busy || role === from || refused;

  const change = async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((t) => api.setRole(t, props.member.id, role));
      if (!done) return;
      await props.onDone(done);
    } catch (err) {
      // Said here, where it is seen; the dialog stays open for another try.
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="card stack sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-h"
        aria-busy={busy}
      >
        <h2 id="role-h" ref={heading} tabIndex={-1} style={{ fontSize: 20 }}>
          Change what {name} can do
        </h2>
        <Pills
          label="Role"
          value={role}
          options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
          onChange={setRole}
        />
        <p className="muted">{roleDescription(role)}</p>
        {lines.length > 0 && (
          <ul className="lock-effects" aria-label="What changing it does">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        <ErrorNote message={error} />
        <div className="row">
          {/* aria-disabled, not disabled: a disabled button drops the focus
              it holds, and "confirm it is you" gives it back here. */}
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={blocked}
            onClick={() => void change()}
          >
            {busy ? 'Saving…' : waits ? 'Ask for the change' : 'Change role'}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) props.onCancel();
            }}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * The way back for somebody whose sign-in was taken away: the same
 * account, with the password only they know. Not an invitation — whoever
 * made one would hold its link and code, and so a way into this person's
 * private documents.
 */
function GiveSignInBack(props: { member: Member; onChanged: () => Promise<void> }) {
  const { guarded } = useApp();
  const [role, setRole] = useState<'adult' | 'teen' | 'viewer'>('adult');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const give = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await guarded((t) => api.restoreSignIn(t, props.member.id, role));
      if (result) setNote(result.message);
      await props.onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>Give {props.member.display_name} their sign-in back</h2>
      <p className="muted">
        They sign in with the same email and password as before, and their own documents are as they
        left them. Nobody else can be given this sign-in.
      </p>
      <Pills
        label="Role"
        value={role}
        options={(['adult', 'teen', 'viewer'] as const).map((r) => ({
          value: r,
          label: roleLabel(r),
        }))}
        onChange={setRole}
      />
      <p className="muted">{roleDescription(role)}</p>
      <ErrorNote message={error} />
      {note && <p className="status status-ok">{note}</p>}
      <div className="row">
        <Button disabled={busy} onClick={() => void give()}>
          {busy ? 'Giving it back…' : 'Give it back'}
        </Button>
      </div>
    </section>
  );
}
