import { can, roleDescription, roleLabel, ROLES, type Role } from '@fdv/shared';
import { useState } from 'react';
import { api, type Member, type OwnerChange } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ErrorNote, Pills } from '../ui.js';

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

/** What an owner can do about one person, on that person's own page. */
export function RoleControls(props: { member: Member; onChanged: () => Promise<void> }) {
  const { guarded, session } = useApp();
  const myRole: Role = storedRole();
  const [role, setRole] = useState<Role>(props.member.role ?? 'adult');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);

  const isMe = props.member.id === session.info?.member_id;
  if (!props.member.has_account && props.member.sign_in_removed && can(myRole, 'member.remove')) {
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

  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>What {props.member.display_name} can do</h2>
      <Pills
        label="Role"
        value={role}
        options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
        onChange={setRole}
      />
      <p className="muted">{roleDescription(role)}</p>
      {props.member.role === 'owner' && role !== 'owner' && (
        <p className="muted">
          Taking away an owner’s role takes seven days. {props.member.display_name} is told at once
          and can refuse in that time, and nothing changes until then.
        </p>
      )}
      <ErrorNote message={error} />
      {note && <p className="status status-ok">{note}</p>}
      <div className="row">
        <Button
          disabled={busy || role === props.member.role}
          onClick={() => void run((t) => api.setRole(t, props.member.id, role))}
        >
          {busy ? 'Saving…' : 'Change what they can do'}
        </Button>
      </div>

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
