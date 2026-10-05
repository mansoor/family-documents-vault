import {
  can,
  GUEST_DEFAULT_DAYS,
  GUEST_DESCRIPTION_MAX,
  guestAccessEnded,
  guestEndProblem,
  shareEndWords,
  zonedParts,
  type MemberAccess,
  type Role,
} from '@fdv/shared';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { dayOf, endOf, LimitsPicker, NO_LIMITS, ViewerLimits, type Limits } from './access.js';
import { api, type CreatedInvitation, type Member } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { storedRole } from './session.js';
import { BottomNav, Button, ErrorNote, Field, TopBar } from './ui.js';

/**
 * Someone outside the family (5.34, D4, A27, A28): an attorney, an
 * accountant. Most need only some papers, for a while — a link to a
 * collection, or a request to send documents — and the invitation says so
 * first. Somebody who must come back gets a sign-in as a guest: a viewer,
 * limited to what they are given, until a day within a year, never shown
 * among the family. Owners see them here apart, with their limits and end,
 * and renew them.
 */

const DAY = 24 * 60 * 60 * 1000;

/** "Monday 4 January at 23:59" on the household's clock, or nothing. */
export const accessEndWords = (iso: string, timezone: string) =>
  shareEndWords(new Date(iso), timezone);

/** What a guest's sign-in says of its end: until when, or that it has ended. */
export function guestEndLine(iso: string | null | undefined, timezone: string): string {
  if (!iso) return 'No sign-in: their invitation has not been accepted, or it was taken away.';
  return guestAccessEnded(iso)
    ? `Their access ended ${accessEndWords(iso, timezone)}. Renew it to let them back in.`
    : `Their access ends ${accessEndWords(iso, timezone)}.`;
}

/** The household's clock: what a guest's end is chosen and said on. */
function useTimezone(): string {
  const { authVersion } = useApp();
  const { data } = useLoad(
    async (t) => (await api.profile(t).catch(() => null))?.timezone ?? 'UTC',
    [authVersion],
  );
  return data ?? 'UTC';
}

/** The day a guest's access ends, chosen: a date field, from tomorrow to a year from today. */
function EndDay(props: {
  id: string;
  label: string;
  value: string;
  timezone: string;
  onChange: (day: string) => void;
}) {
  // The moment the field was first shown: from today to a year from it.
  const [now] = useState(() => Date.now());
  const today = zonedParts(new Date(now), props.timezone).date;
  const latest = zonedParts(new Date(now + 365 * DAY), props.timezone).date;
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="date"
        min={today}
        max={latest}
        value={props.value}
        required
        onChange={(e) => props.onChange(e.target.value)}
        aria-describedby={`${props.id}-note`}
      />
      <span id={`${props.id}-note`} className="muted">
        {`At the end of this day, on the family’s clock (${props.timezone}), their sign-in stops. Within a year; an owner can renew it.`}
      </span>
    </div>
  );
}

/**
 * The invitation's first question, answered no (5.34): the ways to help
 * someone outside the family, a sign-in last.
 */
export function OutsideTheFamily(props: { onSignIn: () => void }) {
  const { caps } = useApp();
  const role: Role = storedRole();
  const mayShare = caps?.features.collection_shares === true && can(role, 'document.share');
  const mayAsk = caps?.features.upload_requests === true && can(role, 'upload_request.create');
  return (
    <section className="stack outside" aria-labelledby="outside-h">
      <h3 id="outside-h" className="section-h">
        Someone outside the family
      </h3>
      <p className="muted">
        An attorney, an accountant, a carer. Most need only some papers, for a while.
      </p>
      <ul className="list">
        {mayShare && (
          <li>
            <Link to="/collections" className="rowbtn">
              <span className="doc-title">Share a collection instead</span>
              <span className="muted">
                Put what they need in a collection and send them a link. It ends by itself.
              </span>
            </Link>
          </li>
        )}
        {mayAsk && (
          <li>
            <Link to="/settings/sharing/ask" className="rowbtn">
              <span className="doc-title">Ask them to send documents</span>
              <span className="muted">
                A link they send their papers through. Nothing of the family’s is shown to them.
              </span>
            </Link>
          </li>
        )}
        <li>
          <button type="button" className="rowbtn" onClick={props.onSignIn}>
            <span className="doc-title">Give them a sign-in</span>
            <span className="muted">
              For someone who needs to come back: a guest, who sees only what you give them, until a
              day within a year. Never shown among the family.
            </span>
          </button>
        </li>
      </ul>
    </section>
  );
}

/**
 * A guest's invitation (5.34): their name, what they are to the family, the
 * address they will sign in with, the day their access ends, and what they
 * can see — always chosen (A27), Adults only documents an owner's alone (D6).
 */
export function GuestInviteForm(props: {
  owner: boolean;
  onCancel: () => void;
  onCreated: (c: CreatedInvitation) => Promise<void>;
}) {
  const { guarded } = useApp();
  const timezone = useTimezone();
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [email, setEmail] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [limits, setLimits] = useState<Limits>(NO_LIMITS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => heading.current?.focus(), []);
  // Ninety days from the moment the form opened, until somebody chooses.
  const [opened] = useState(() => Date.now());
  const chosenDay = day ?? zonedParts(new Date(opened + GUEST_DEFAULT_DAYS * DAY), timezone).date;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const end = endOf(chosenDay, timezone);
    const problem = end ? guestEndProblem(new Date(end)) : 'Choose the day their access ends.';
    if (problem || !end) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await guarded((t) =>
        api.invite(t, {
          display_name: name,
          ...(about.trim() ? { relationship: about.trim() } : {}),
          email,
          role: 'viewer',
          kind: 'guest',
          restriction: props.owner ? limits : { ...limits, include_adults_only: false },
          access_expires_at: end,
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
    <form onSubmit={(e) => void submit(e)} className="card stack" aria-labelledby="guest-h">
      <h2 id="guest-h" ref={heading} tabIndex={-1} style={{ fontSize: 18 }}>
        Give someone outside the family a sign-in
      </h2>
      <p className="muted">
        A guest sees only what you choose, until the day their access ends. They are never shown
        among the family, and own no documents here.
      </p>
      <Field id="guest-name" label="Their name" value={name} onChange={setName} />
      <Field
        id="guest-about"
        label="What they are to the family (optional)"
        value={about}
        required={false}
        onChange={setAbout}
        maxLength={GUEST_DESCRIPTION_MAX}
        placeholder="Attorney, accountant"
        hint="The activity log names them with it: “Guest — Jane Smith, attorney”."
      />
      <Field
        id="guest-email"
        label="Their email address"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="off"
        hint="This becomes their sign-in. Nothing is sent to it — you pass the invitation on yourself."
      />
      <EndDay
        id="guest-ends"
        label="Their access ends"
        value={chosenDay}
        timezone={timezone}
        onChange={setDay}
      />
      <section className="stack" aria-labelledby="guest-limits-h">
        <h3 id="guest-limits-h" className="section-h">
          What they can see
        </h3>
        <p className="muted">
          {props.owner
            ? 'Choose what they can see. A guest is always limited.'
            : 'Choose what they can see, of what you can. Only an owner can give Adults only documents.'}
        </p>
        <LimitsPicker
          idPrefix="guest-limits"
          value={limits}
          onChange={setLimits}
          memberId={null}
          owner={props.owner}
          endless
        />
      </section>
      <ErrorNote message={error} />
      <div className="row">
        <Button type="submit" disabled={busy || !email || !name}>
          {busy ? 'Making the invitation…' : 'Make the invitation'}
        </Button>
        <Button kind="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * People outside the family (Settings, owners, 5.34): each guest, what they
 * can see, and when their access ends — to renew, or to change what they
 * see (each asked with a passkey or a code, A54).
 */
export function GuestsScreen() {
  const { authVersion } = useApp();
  const timezone = useTimezone();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [guests, invitations] = await Promise.all([api.guests(t), api.invitations(t)]);
      const waiting = invitations.items.filter((i) => i.kind === 'guest' && i.state === 'pending');
      // Somebody invited and not yet signed in is listed once, as invited.
      const invited = new Set(waiting.map((i) => i.member_id));
      return {
        guests: guests.items.filter((g) => g.has_account || !invited.has(g.id)),
        waiting,
      };
    },
    [authVersion],
  );
  const [said, setSaid] = useState<string | null>(null);

  return (
    <main className="page page-top has-nav">
      <TopBar title="People outside the family" back="/settings" />
      <p className="lede">
        Guests sign in to see only what you give them, until the day their access ends. They are
        never shown among the family.
      </p>
      <ErrorNote message={error} />
      <p className="notice" role="status" aria-live="polite">
        {said ?? ''}
      </p>
      {data && data.guests.length === 0 && data.waiting.length === 0 && (
        <p className="muted">Nobody outside the family has a sign-in.</p>
      )}
      <ul className="list guests">
        {(data?.guests ?? []).map((g) => (
          <GuestRow
            key={g.id}
            guest={g}
            timezone={timezone}
            onChanged={async (words) => {
              setSaid(words);
              await reload();
            }}
          />
        ))}
      </ul>
      {(data?.waiting.length ?? 0) > 0 && (
        <section aria-labelledby="guests-waiting-h">
          <h2 id="guests-waiting-h" className="section-h">
            Invited, not yet accepted
          </h2>
          <ul className="list">
            {data?.waiting.map((i) => (
              <li key={i.id} className="stack guest">
                <strong>{i.display_name}</strong>
                <span className="muted">
                  {i.email}
                  {i.access_expires_at
                    ? ` · until ${accessEndWords(i.access_expires_at, timezone)}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Link to="/people" className="btn btn-quiet">
        Invite someone from People
      </Link>
      <BottomNav />
    </main>
  );
}

/** One guest: who, what they can see, their end; renew, or change what they see. */
function GuestRow(props: {
  guest: Member;
  timezone: string;
  onChanged: (said: string) => Promise<void>;
}) {
  const { guarded } = useApp();
  const g = props.guest;
  const [renewing, setRenewing] = useState<string | null>(null);
  const [access, setAccess] = useState<MemberAccess | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renewButton = useRef<HTMLButtonElement>(null);
  const renewField = useRef<HTMLDivElement>(null);
  const open = renewing !== null;
  useLayoutEffect(() => {
    if (open) renewField.current?.querySelector('input')?.focus();
  }, [open]);
  const signedIn = Boolean(g.access_expires_at);
  // From their end if it is still to come, from today if not: ninety days on, within a year.
  const suggested = () => {
    const from = Math.max(Date.now(), Date.parse(g.access_expires_at ?? '') || 0);
    const at = Math.min(from + GUEST_DEFAULT_DAYS * DAY, Date.now() + 365 * DAY);
    return dayOf(new Date(at).toISOString(), props.timezone);
  };

  const renew = async (e: FormEvent) => {
    e.preventDefault();
    const end = renewing ? endOf(renewing, props.timezone) : null;
    const problem = end ? guestEndProblem(new Date(end)) : 'Choose the day their access ends.';
    if (problem || !end) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((t) => api.renewGuest(t, g.id, end));
      if (!done) return;
      // Back to the button that opened it, as the field goes.
      flushSync(() => setRenewing(null));
      renewButton.current?.focus();
      await props.onChanged(
        `${g.display_name}’s access now ends ${accessEndWords(done.access_expires_at, props.timezone)}.`,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const openLimits = async () => {
    setError(null);
    try {
      const card = await guarded((t) => api.memberAccount(t, g.id));
      if (card) setAccess(card.access ?? null);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <li className="stack guest">
      <h2 className="guest-name">
        {g.display_name}
        {g.relationship ? <span className="muted">{` · ${g.relationship}`}</span> : null}
      </h2>
      <p className="muted">{g.restriction?.summary ?? 'Limited to what they are given.'}</p>
      <p className={signedIn && guestAccessEnded(g.access_expires_at) ? 'status status-warn' : ''}>
        {guestEndLine(g.access_expires_at, props.timezone)}
      </p>
      {renewing !== null ? (
        <form className="stack" onSubmit={(e) => void renew(e)}>
          <div ref={renewField}>
            <EndDay
              id={`renew-${g.id}`}
              label={`${g.display_name}’s access ends`}
              value={renewing}
              timezone={props.timezone}
              onChange={setRenewing}
            />
          </div>
          <ErrorNote message={error} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Renewing…' : 'Renew'}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                setRenewing(null);
                setError(null);
                renewButton.current?.focus();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <ErrorNote message={error} />
          {signedIn && (
            <div className="row">
              <Button ref={renewButton} kind="quiet" onClick={() => setRenewing(suggested())}>
                Renew their access
              </Button>
              {access === undefined && (
                <Button kind="quiet" onClick={() => void openLimits()}>
                  What they can see
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {access !== undefined && (
        <ViewerLimits
          member={g}
          name={g.display_name}
          access={access}
          guest
          onChanged={(now, words) => {
            setAccess(now);
            void props.onChanged(words);
          }}
        />
      )}
    </li>
  );
}
