import { can, roleDescription, roleLabel, ROLES, type Role } from '@fdv/shared';
import { useState, type FormEvent } from 'react';
import { LimitsPicker, NO_LIMITS, type Limits } from '../access.js';
import { api, type CreatedInvitation, type Invitation, type Member } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { Button, Check, ErrorNote, Field, Pills } from '../ui.js';

/**
 * Inviting somebody (SHR-02), from the People screen.
 *
 * Two things shape this. First, the link and the code exist for exactly
 * one render — the server stores only their hashes — so the screen has to
 * say so rather than let someone close the card and come back for them.
 * Second, the roles offered are the ones this person may actually hand
 * out: an adult can give their child a sign-in without being able to
 * widen the circle of people who see the adults-only documents.
 *
 * A viewer is limited to what they are given (5.33, A27): an adult chooses
 * what a viewer they invite can see, every time; an owner may, and may let
 * one see every family document instead. The limits apply as the
 * invitation is accepted, so the viewer never sees more for a moment.
 */

export function InvitePanel(props: {
  members: Member[];
  invitations: Invitation[];
  onChanged: () => Promise<void>;
}) {
  const { session, guarded } = useApp();
  const myRole: Role = session.info?.role ?? 'viewer';
  const [inviting, setInviting] = useState<{ member?: Member } | null>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  if (!can(myRole, 'member.invite')) return null;

  const pending = props.invitations.filter((i) => i.state === 'pending');
  // Somebody whose sign-in was taken away is given it back, not invited:
  // an invitation would hand their private documents to whoever accepts it.
  // Nobody signs in as somebody who has passed away (5.25).
  const withoutSignIn = props.members.filter(
    (m) => !m.has_account && !m.sign_in_removed && !m.is_deceased,
  );

  if (created) {
    return <HandOver created={created} onDone={() => setCreated(null)} />;
  }

  if (inviting) {
    return (
      <InviteForm
        myRole={myRole}
        member={inviting.member}
        onCancel={() => setInviting(null)}
        onCreated={async (c) => {
          setInviting(null);
          setCreated(c);
          await props.onChanged();
        }}
      />
    );
  }

  return (
    <section className="stack">
      {pending.length > 0 && (
        <div className="card stack">
          <h2 style={{ fontSize: 18 }}>Waiting to be accepted</h2>
          <ul className="list">
            {pending.map((i) => (
              <li key={i.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  <strong>{i.display_name}</strong>
                  <span className="muted">
                    {' '}
                    · {roleLabel(i.role)}
                    {i.limited ? ' · limited' : ''} · {i.email}
                  </span>
                </span>
                <Button
                  kind="quiet"
                  onClick={() => {
                    void (async () => {
                      await guarded((t) => api.revokeInvitation(t, i.id));
                      await props.onChanged();
                    })();
                  }}
                >
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row">
        <Button onClick={() => setInviting({})}>Invite someone to sign in</Button>
      </div>
      {withoutSignIn.length > 0 && (
        <p className="muted">
          {withoutSignIn.map((m) => m.display_name).join(', ')}{' '}
          {withoutSignIn.length === 1 ? 'has' : 'have'} no sign-in yet. You can give one to anybody
          old enough to have their own password.
        </p>
      )}
    </section>
  );
}

function InviteForm(props: {
  myRole: Role;
  member?: Member | undefined;
  onCancel: () => void;
  onCreated: (c: CreatedInvitation) => Promise<void>;
}) {
  const { guarded, caps } = useApp();
  const [name, setName] = useState(props.member?.display_name ?? '');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('adult');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What a viewer will see (5.33): limited unless an owner says otherwise.
  const [limited, setLimited] = useState(true);
  const [limits, setLimits] = useState<Limits>(NO_LIMITS);
  const owner = props.myRole === 'owner';

  // Only the roles this person is allowed to hand out are shown; offering
  // one that will be refused is a worse answer than not offering it.
  const offerable = ROLES.filter((r) =>
    can(props.myRole, r === 'owner' || r === 'adult' ? 'member.invite_adult' : 'member.invite'),
  );
  const chosen = offerable.includes(role) ? role : (offerable[0] as Role);
  // An adult's viewer is always limited (A27); an owner's, unless they say.
  const limitsOffered = chosen === 'viewer' && caps?.features.access_restrictions === true;
  const limiting = limitsOffered && (limited || !owner);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await guarded((t) =>
        api.invite(t, {
          ...(props.member ? { member_id: props.member.id } : { display_name: name }),
          email,
          role: chosen,
          ...(limiting
            ? { restriction: owner ? limits : { ...limits, include_adults_only: false } }
            : {}),
        }),
      );
      if (created) await props.onCreated(created);
      else setBusy(false);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="card stack">
      <h2 style={{ fontSize: 18 }}>Invite someone to sign in</h2>
      {!props.member && (
        <Field id="invite-name" label="Their name" value={name} onChange={setName} />
      )}
      <Field
        id="invite-email"
        label="Their email address"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="off"
        hint="This becomes their sign-in. Nothing is sent to it — you pass the invitation on yourself."
      />
      <Pills
        label="What they can do"
        value={chosen}
        options={offerable.map((r) => ({ value: r, label: roleLabel(r) }))}
        onChange={setRole}
      />
      <p className="muted">{roleDescription(chosen)}</p>
      {limitsOffered && (
        <section className="stack" aria-labelledby="invite-limits-h">
          <h3 id="invite-limits-h" className="section-h">
            Limit what they can see
          </h3>
          {owner ? (
            <Check
              id="invite-limited"
              label="Only what I choose"
              note="Off, they see every family document but the Adults only ones."
              checked={limited}
              onChange={setLimited}
            />
          ) : (
            <p className="muted">
              Choose what they can see. Only an owner can invite a viewer who sees every family
              document.
            </p>
          )}
          {limiting && (
            <LimitsPicker
              idPrefix="invite-limits"
              value={limits}
              onChange={setLimits}
              memberId={props.member?.id ?? null}
              owner={owner}
            />
          )}
        </section>
      )}
      <ErrorNote message={error} />
      <div className="row">
        <Button type="submit" disabled={busy || !email || (!props.member && !name)}>
          {busy ? 'Making the invitation…' : 'Make the invitation'}
        </Button>
        <Button kind="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The one moment the two secrets exist outside the invitee's head. */
function HandOver(props: { created: CreatedInvitation; onDone: () => void }) {
  // The secret after the #: a browser sends it to no server, and the page
  // it opens takes it out of the address bar and that tab's history (5.17).
  // The browser's own history of pages visited keeps it: the link works
  // once, only with the code, and for seven days.
  const link = `${window.location.origin}/join#${props.created.link_token}`;
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  const copy = (what: 'link' | 'code', text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  };

  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>Send these to {props.created.invitation.display_name}</h2>
      <p className="muted">
        Send the link one way and the code another — a message and a phone call, say. Anyone who
        gets both can sign in as them.
      </p>

      <div className="field">
        <span className="field-label">The link</span>
        <code style={{ wordBreak: 'break-all' }}>{link}</code>
        <Button kind="quiet" onClick={() => copy('link', link)}>
          {copied === 'link' ? 'Copied' : 'Copy the link'}
        </Button>
      </div>

      <div className="field">
        <span className="field-label">The code</span>
        <code style={{ fontSize: 24, letterSpacing: 2 }}>{props.created.code}</code>
        <Button kind="quiet" onClick={() => copy('code', props.created.code)}>
          {copied === 'code' ? 'Copied' : 'Copy the code'}
        </Button>
      </div>

      <p className="muted">
        This is the only time they are shown. The vault keeps no copy, so if you lose them, cancel
        the invitation and make another. It stops working in seven days.
      </p>
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}
