import {
  ageOn,
  can,
  localToday,
  mayBeInvited,
  OWN_SIGN_IN_AGE,
  roleDescription,
  roleLabel,
  rolesForAge,
  rolesToHandOut,
  UNDER_13_NOTE,
  type Role,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LimitsPicker, NO_LIMITS, type Limits } from '../access.js';
import { api, type CreatedInvitation, type Invitation, type Member } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { GuestInviteForm, OutsideTheFamily } from '../guests.js';
import { Button, Check, ErrorNote, Field, Pills, Select } from '../ui.js';

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
 *
 * It first asks whether the person is family (5.34). Somebody outside it
 * is offered a link to a collection, or a request to send documents,
 * before a sign-in of their own as a guest.
 */

export function InvitePanel(props: {
  members: Member[];
  invitations: Invitation[];
  onChanged: () => Promise<void>;
}) {
  const { session, guarded } = useApp();
  const myRole: Role = session.info?.role ?? 'viewer';
  const [inviting, setInviting] = useState<{ member?: Member } | null>(null);
  const [created, setCreated] = useState<{ made: CreatedInvitation; email: string } | null>(null);

  if (!can(myRole, 'member.invite')) return null;

  const pending = props.invitations.filter((i) => i.state === 'pending');
  // Somebody whose sign-in was taken away is given it back, not invited:
  // an invitation would hand their private documents to whoever accepts it.
  // Nobody signs in as somebody who has passed away (5.25).
  const withoutSignIn = props.members.filter(
    (m) => !m.has_account && !m.sign_in_removed && !m.is_deceased,
  );

  if (created) {
    return (
      <HandOver created={created.made} email={created.email} onDone={() => setCreated(null)} />
    );
  }

  if (inviting) {
    return (
      <InviteForm
        myRole={myRole}
        member={inviting.member}
        members={props.members}
        invitations={props.invitations}
        onCancel={() => setInviting(null)}
        onCreated={async (c, email) => {
          setInviting(null);
          setCreated({ made: c, email });
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
                    · {i.kind === 'guest' ? 'Guest, from outside the family' : roleLabel(i.role)}
                    {i.kind !== 'guest' && i.limited ? ' · limited' : ''} · {i.email}
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

/**
 * The household's today, on its own calendar: the vault works ages out on
 * it (an invitation for an under-13 is refused, after 0.7.0), so the screens
 * do too. The browser's own day until the vault has said.
 */
export function useHouseholdToday(active = true): string {
  const { authVersion, withToken } = useApp();
  const [timezone, setTimezone] = useState<string | null>(null);
  useEffect(() => {
    // Not asked before there is a sign-in to ask with (the wizard's first board).
    if (!active) return;
    let gone = false;
    withToken((t) => api.profile(t)).then(
      (p) => {
        if (!gone && p?.timezone) setTimezone(p.timezone);
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [active, authVersion, withToken]);
  return localToday(timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** The role an invitation gives, and a viewer's limits (5.33): chosen in `RoleFields`. */
export interface RoleChoice {
  /** What this inviter may hand out to somebody of this age (`rolesForAge`). */
  offered: Role[];
  chosen: Role | null;
  setRole: (r: Role) => void;
  limited: boolean;
  setLimited: (on: boolean) => void;
  limits: Limits;
  setLimits: (v: Limits) => void;
  /** A viewer is chosen, and the vault limits viewers. */
  limitsOffered: boolean;
  /** Limits go with the invitation: always an adult's viewer (A27); an owner's, unless they say. */
  limiting: boolean;
  owner: boolean;
}

/**
 * The roles offered are the ones this person may actually hand out, and
 * that the invitee's age allows (after 0.7.0): a teen's from 13 to 17;
 * from 18 every other one the inviter may give; every one when the age is
 * not known. Offering one that will be refused is a worse answer than not
 * offering it.
 */
export function useRoleChoice(myRole: Role, age: number | null): RoleChoice {
  const { caps } = useApp();
  const [role, setRole] = useState<Role>('adult');
  // What a viewer will see (5.33): limited unless an owner says otherwise.
  const [limited, setLimited] = useState(true);
  const [limits, setLimits] = useState<Limits>(NO_LIMITS);
  const owner = myRole === 'owner';
  const offered = rolesForAge(age, rolesToHandOut(myRole));
  const chosen = offered.includes(role) ? role : (offered[0] ?? null);
  const limitsOffered = chosen === 'viewer' && caps?.features.access_restrictions === true;
  return {
    offered,
    chosen,
    setRole,
    limited,
    setLimited,
    limits,
    setLimits,
    limitsOffered,
    limiting: limitsOffered && (limited || !owner),
    owner,
  };
}

/** What an invitation's body says of the role and a viewer's limits. */
export function roleBody(c: RoleChoice): { role: Role; restriction?: Limits } {
  return {
    role: c.chosen as Role,
    ...(c.limiting
      ? { restriction: c.owner ? c.limits : { ...c.limits, include_adults_only: false } }
      : {}),
  };
}

/** What they can do, and — for a viewer — what they can see. */
export function RoleFields(props: {
  idPrefix: string;
  choice: RoleChoice;
  memberId: string | null;
  /** Its heading's level: under the card's own (3), or in a form with none (2). */
  level?: 2 | 3;
}) {
  const c = props.choice;
  if (!c.chosen) return null;
  const H = props.level === 2 ? 'h2' : 'h3';
  return (
    <>
      <Pills
        label="What they can do"
        value={c.chosen}
        options={c.offered.map((r) => ({ value: r, label: roleLabel(r) }))}
        onChange={c.setRole}
      />
      <p className="muted">{roleDescription(c.chosen)}</p>
      {c.limitsOffered && (
        <section className="stack" aria-labelledby={`${props.idPrefix}-limits-h`}>
          <H id={`${props.idPrefix}-limits-h`} className="section-h">
            Limit what they can see
          </H>
          {c.owner ? (
            <Check
              id={`${props.idPrefix}-limited`}
              label="Only what I choose"
              note="Off, they see every family document but the Adults only ones."
              checked={c.limited}
              onChange={c.setLimited}
            />
          ) : (
            <p className="muted">
              Choose what they can see. Only an owner can invite a viewer who sees every family
              document.
            </p>
          )}
          {c.limiting && (
            <LimitsPicker
              idPrefix={`${props.idPrefix}-limits`}
              value={c.limits}
              onChange={c.setLimits}
              memberId={props.memberId}
              owner={c.owner}
            />
          )}
        </section>
      )}
    </>
  );
}

/** Said under "Who is it for?": who is not listed, and why. */
export const WHO_NOTE =
  'Only family members with no sign-in and no invitation waiting are listed. Under-13s can’t have a sign-in of their own, so they are listed once they turn 13.';

export function InviteForm(props: {
  myRole: Role;
  /** The person it is for, fixed (from their page): nobody is asked who. */
  member?: Member | undefined;
  /** The family and the invitations, for "Who is it for?" (after 0.7.0). */
  members?: Member[] | undefined;
  invitations?: Invitation[] | undefined;
  onCancel: () => void;
  onCreated: (c: CreatedInvitation, email: string) => Promise<void>;
}) {
  const { guarded, caps } = useApp();
  const today = useHouseholdToday();
  const [name, setName] = useState(props.member?.display_name ?? '');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Family, or somebody outside it (5.34): asked first of somebody new.
  const asksFamily = caps?.features.guests === true && !props.member;
  const [family, setFamily] = useState<'yes' | 'no' | null>(null);
  const [guest, setGuest] = useState(false);
  // Who it is for (after 0.7.0): somebody of the family with no sign-in and
  // no invitation waiting, 13 or over or of no known age; or somebody new.
  const invitable = (props.members ?? []).filter((m) =>
    mayBeInvited(m, props.invitations ?? [], today),
  );
  const [who, setWho] = useState<string>('new');
  const fixed = props.member ?? invitable.find((m) => m.id === who) ?? null;
  // Its heading is where the reader is, as it opens.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const choice = useRoleChoice(props.myRole, fixed ? ageOn(fixed.date_of_birth, today) : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!choice.chosen) return;
    setBusy(true);
    setError(null);
    try {
      const created = await guarded((t) =>
        api.invite(t, {
          ...(fixed ? { member_id: fixed.id } : { display_name: name }),
          email,
          ...roleBody(choice),
        }),
      );
      if (created) await props.onCreated(created, email);
      else setBusy(false);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  if (guest) {
    return (
      <GuestInviteForm
        owner={choice.owner}
        onCancel={props.onCancel}
        onCreated={(c) => props.onCreated(c, '')}
      />
    );
  }

  const isFamily = !asksFamily || family === 'yes';
  return (
    <form onSubmit={(e) => void submit(e)} className="card stack" aria-labelledby="invite-h">
      <h2 id="invite-h" ref={heading} style={{ fontSize: 18 }} tabIndex={-1}>
        {props.member
          ? `Invite ${props.member.display_name} to sign up`
          : 'Invite someone to sign in'}
      </h2>
      {asksFamily && (
        <Pills
          label="Is this person family?"
          value={family}
          options={[
            { value: 'yes', label: 'Yes, family' },
            { value: 'no', label: 'No, from outside' },
          ]}
          onChange={setFamily}
        />
      )}
      {asksFamily && family === 'no' && <OutsideTheFamily onSignIn={() => setGuest(true)} />}
      {isFamily && (
        <>
          {!props.member && (
            <>
              <Select
                id="invite-who"
                label="Who is it for?"
                value={fixed ? fixed.id : 'new'}
                options={[
                  { value: 'new', label: 'Someone new' },
                  ...invitable.map((m) => ({ value: m.id, label: m.display_name })),
                ]}
                onChange={setWho}
                describedBy="invite-who-note"
              />
              <p id="invite-who-note" className="muted">
                {WHO_NOTE}
              </p>
            </>
          )}
          {!fixed && <Field id="invite-name" label="Their name" value={name} onChange={setName} />}
          <Field
            id="invite-email"
            label="Their email address"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="off"
            hint="This becomes their sign-in. Nothing is sent to it — you pass the invitation on yourself."
          />
          <RoleFields idPrefix="invite" choice={choice} memberId={fixed?.id ?? null} />
          <ErrorNote message={error} />
        </>
      )}
      <div className="row">
        {isFamily && (
          <Button type="submit" disabled={busy || !email || (!fixed && !name) || !choice.chosen}>
            {busy ? 'Making the invitation…' : 'Make the invitation'}
          </Button>
        )}
        <Button kind="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The one moment the two secrets exist outside the invitee's head. It
 * offers to email the link (after 0.7.0) from the inviter's own mail — the
 * vault sends nothing — and never the code, which goes another way.
 */
export function HandOver(props: {
  created: CreatedInvitation;
  /** The address it was made for, to email the link to; none for no offer. */
  email?: string | undefined;
  onDone: () => void;
}) {
  // The secret after the #: a browser sends it to no server, and the page
  // it opens takes it out of the address bar and that tab's history (5.17).
  // The browser's own history of pages visited keeps it: the link works
  // once, only with the code, and for seven days.
  const link = `${window.location.origin}/join#${props.created.link_token}`;
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  // Where the reader is once it is made: what to send, and to whom.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const copy = (what: 'link' | 'code', text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  };

  return (
    <section className="card stack">
      <h2 ref={heading} tabIndex={-1} style={{ fontSize: 18 }}>
        Send these to {props.created.invitation.display_name}
      </h2>
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

      {props.email && (
        <p>
          <a
            className="btn btn-quiet"
            href={mailtoLink(props.email, props.created.invitation.display_name, link)}
          >
            Email the link
          </a>{' '}
          <span className="muted">From your own email. Then tell them the code another way.</span>
        </p>
      )}

      <p className="muted">
        This is the only time they are shown. The vault keeps no copy, so if you lose them, cancel
        the invitation and make another. It stops working in seven days.
      </p>
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}

/**
 * An email of the link alone, opened in the inviter's own mail (after
 * 0.7.0): the code is not in it, so the email on its own is not a way in.
 */
export function mailtoLink(to: string, name: string, link: string): string {
  const subject = 'Your invitation to our family vault';
  const body = `Hello ${name},\n\nHere is your link to sign up to our family vault:\n\n${link}\n\nI will give you the code it asks for another way. The link stops working in seven days.\n`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * An invitation as somebody is added (after 0.7.0): People → Add someone,
 * and the first-run wizard's people. For somebody 13 or over by the date of
 * birth typed — or with none — "Invite them to sign up now", unticked;
 * ticked, their email address and the roles their age allows, and saving
 * the person makes the invitation for them too. For an under-13, a note
 * instead. Nothing for somebody who may not invite.
 */
export function useSignUpOnAdd(myRole: Role, dateOfBirth: string, today: string) {
  const age = ageOn(dateOfBirth || null, today);
  const [on, setOn] = useState(false);
  const [email, setEmail] = useState('');
  const choice = useRoleChoice(myRole, age);
  const offered = can(myRole, 'member.invite');
  const tooYoung = age !== null && age < OWN_SIGN_IN_AGE;
  return {
    age,
    on,
    setOn,
    email,
    setEmail,
    choice,
    offered,
    tooYoung,
    /** Saving the person makes an invitation too. */
    wanted: offered && !tooYoung && on && choice.chosen !== null,
    reset: () => {
      setOn(false);
      setEmail('');
    },
  };
}

export type SignUpOnAdd = ReturnType<typeof useSignUpOnAdd>;

/** Said when the person was added and the invitation's step-up was cancelled (the review, INV-4). */
export const NOT_INVITED = (name: string) =>
  `${name} was added, but no invitation was made. You can invite them from their page.`;

/** Said when the box is ticked and no address is given. */
export const EMAIL_NEEDED = 'Give their email address, or untick “Invite them to sign up now”.';

/** What the add-person forms show of it: the box and what it asks, or the under-13 note. */
export function SignUpFields(props: { idPrefix: string; signUp: SignUpOnAdd }) {
  const s = props.signUp;
  if (!s.offered) return null;
  if (s.tooYoung) {
    return (
      <p className="muted under-13-note" id={`${props.idPrefix}-under-13`}>
        {UNDER_13_NOTE}
      </p>
    );
  }
  return (
    <>
      <Check
        id={`${props.idPrefix}-invite`}
        checked={s.on}
        onChange={s.setOn}
        label="Invite them to sign up now"
        note={
          s.age === null
            ? 'A sign-in of their own, for someone 13 or over. You can invite them later instead, from their page.'
            : 'A sign-in of their own. You can invite them later instead, from their page.'
        }
      />
      {s.on && (
        <div className="stack sign-up-fields">
          <Field
            id={`${props.idPrefix}-email`}
            label="Their email address"
            type="email"
            value={s.email}
            onChange={s.setEmail}
            autoComplete="off"
            hint="This becomes their sign-in. Nothing is sent to it — you pass the invitation on yourself."
          />
          <RoleFields
            idPrefix={`${props.idPrefix}-invite`}
            choice={s.choice}
            memberId={null}
            level={2}
          />
        </div>
      )}
    </>
  );
}

/**
 * The invitation for somebody just added, as `SignUpFields` asked: made
 * with `guarded`, so a step-up is asked for as anywhere. Null when the
 * step-up was cancelled; throws what the vault refused.
 */
export function inviteAdded(
  guarded: <T>(fn: (t: string) => Promise<T>) => Promise<T | null>,
  memberId: string,
  s: SignUpOnAdd,
): Promise<CreatedInvitation | null> {
  return guarded((t) =>
    api.invite(t, { member_id: memberId, email: s.email.trim(), ...roleBody(s.choice) }),
  );
}
