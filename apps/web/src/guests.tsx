import {
  can,
  GUEST_DEFAULT_DAYS,
  GUEST_DESCRIPTION_MAX,
  guestAccessEnded,
  guestEndProblem,
  guestEndWords,
  zonedParts,
  type MemberAccess,
  type Role,
} from '@fdv/shared';
import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { dayOf, endOf, LimitsPicker, NO_LIMITS, ViewerLimits, type Limits } from './access.js';
import { api, type CreatedInvitation, type Member } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { storedRole } from './session.js';
import { BottomNav, Button, ConfirmDialog, ErrorNote, Field, TopBar } from './ui.js';

/**
 * Someone outside the family (5.34, D4, A27, A28): an attorney, an
 * accountant. Most need only some papers, for a while — a link to a
 * collection, or a request to send documents — and the invitation says so
 * first. Somebody who must come back gets a sign-in as a guest: a viewer,
 * limited to what they are given, until a day within a year, never shown
 * among the family. Owners see them here apart, with their limits and end,
 * and renew them, take their sign-in away, or give it back.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * "Monday 4 January 2027 at 23:59" on the household's clock: with its year
 * (the 5.34 review, W534-05), for a guest's end may be a year away, or past.
 */
export const accessEndWords = (iso: string, timezone: string) => guestEndWords(iso, timezone);

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
 * can see, and when their access ends. And what an owner does with a
 * guest's sign-in (the 5.34 review, W534-03): renew it, change what they
 * see, sign them out everywhere, take it away, give it back with a new end,
 * correct their name and what they are to the family, and remove a guest
 * who never signed in. Each is asked as the vault asks: a passkey or a code
 * for an owner power (A54), the ordinary step-up otherwise.
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
  const status = useRef<HTMLParagraphElement>(null);
  /** Says what was done; and, unless a control stays to hold it, focus goes to what is said. */
  const sayAndReload = async (words: string, focus = true) => {
    flushSync(() => setSaid(words));
    if (focus) status.current?.focus();
    await reload();
  };
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  return (
    <main className="page page-top has-nav">
      <TopBar title="People outside the family" back="/settings" />
      <p className="lede">
        Guests sign in to see only what you give them, until the day their access ends. They are
        never shown among the family.
      </p>
      <ErrorNote message={error} />
      <p ref={status} className="notice" role="status" aria-live="polite" tabIndex={-1}>
        {said ?? ''}
      </p>
      {data && data.guests.length === 0 && data.waiting.length === 0 && (
        <p className="muted">Nobody outside the family has a sign-in.</p>
      )}
      <ul className="list guests">
        {(data?.guests ?? []).map((g) => (
          <GuestRow key={g.id} guest={g} timezone={timezone} onChanged={sayAndReload} />
        ))}
      </ul>
      {(data?.waiting.length ?? 0) > 0 && (
        <section aria-labelledby="guests-waiting-h">
          <h2 id="guests-waiting-h" className="section-h">
            Invited, not yet accepted
          </h2>
          <ul className="list guests">
            {data?.waiting.map((i) => (
              <li key={i.id} className="stack guest">
                <h3 className="guest-name">{i.display_name}</h3>
                <p className="muted">
                  {i.email}
                  {i.access_expires_at
                    ? guestAccessEnded(i.access_expires_at)
                      ? ` · their access ended ${accessEndWords(i.access_expires_at, timezone)}, before they accepted`
                      : ` · until ${accessEndWords(i.access_expires_at, timezone)}`
                    : ''}
                </p>
                <div className="row">
                  <Button
                    kind="quiet"
                    danger
                    onClick={() => setRemoving({ id: i.member_id, name: i.display_name })}
                  >
                    Cancel and remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {removing && (
        <RemoveGuest
          id={removing.id}
          name={removing.name}
          invited
          onCancel={() => setRemoving(null)}
          onDone={async (words) => {
            flushSync(() => setRemoving(null));
            await sayAndReload(words);
          }}
        />
      )}
      <Link to="/people" className="btn btn-quiet">
        Invite someone from People
      </Link>
      <BottomNav />
    </main>
  );
}

/**
 * "Remove Jane Smith?": a guest who never signed in, with their invitation
 * and what they were to be given — or an invitation not yet accepted,
 * cancelled, and the guest with it.
 */
function RemoveGuest(props: {
  id: string;
  name: string;
  invited?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onDone: (said: string) => Promise<void>;
}) {
  const { guarded } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await guarded(async (t) => {
        await api.removeGuest(t, props.id);
        return true;
      });
      if (done === null) return;
      await props.onDone(
        props.invited
          ? `${props.name}’s invitation is cancelled, and they are removed.`
          : `${props.name} is removed.`,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      title={props.invited ? `Cancel ${props.name}’s invitation?` : `Remove ${props.name}?`}
      confirmLabel={props.invited ? 'Cancel it and remove them' : 'Remove them'}
      busyLabel="Removing…"
      danger
      busy={busy}
      {...(props.returnFocus ? { returnFocus: props.returnFocus } : {})}
      onConfirm={() => void confirm()}
      onCancel={props.onCancel}
    >
      <p>
        {props.invited
          ? `The invitation stops working, and ${props.name} goes, with what they were to be given. You can invite them again whenever you like.`
          : `${props.name} never signed in. They go, with what they were to be given.`}
      </p>
      <ErrorNote message={error} />
    </ConfirmDialog>
  );
}

/** What a guest's row is doing: a day being chosen, details being changed, or a question asked first. */
type Doing = 'renew' | 'giveBack' | 'edit' | 'signOut' | 'takeAway' | 'remove' | null;

/** One guest: who, what they can see, their end, and what an owner does with their sign-in. */
function GuestRow(props: {
  guest: Member;
  timezone: string;
  onChanged: (said: string, focus?: boolean) => Promise<void>;
}) {
  const { caps, guarded } = useApp();
  const g = props.guest;
  const [doing, setDoing] = useState<Doing>(null);
  const [day, setDay] = useState('');
  const [name, setName] = useState(g.display_name);
  const [about, setAbout] = useState(g.relationship ?? '');
  const [access, setAccess] = useState<MemberAccess | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dayButton = useRef<HTMLButtonElement>(null);
  const limitsButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const signOutButton = useRef<HTMLButtonElement>(null);
  const takeAwayButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const dayField = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLDivElement>(null);
  const dated = doing === 'renew' || doing === 'giveBack';
  useLayoutEffect(() => {
    if (dated) dayField.current?.querySelector('input')?.focus();
    if (doing === 'edit') nameField.current?.querySelector('input')?.focus();
  }, [dated, doing]);
  const signedIn = g.has_account;
  const removed = !signedIn && g.sign_in_removed === true;
  const never = !signedIn && !removed;
  // From their end if it is still to come, from today if not: ninety days on, within a year.
  const suggested = () => {
    const from = Math.max(Date.now(), Date.parse(g.access_expires_at ?? '') || 0);
    const at = Math.min(from + GUEST_DEFAULT_DAYS * DAY, Date.now() + 365 * DAY);
    return dayOf(new Date(at).toISOString(), props.timezone);
  };
  /** Closes what is open, focus back to the button that opened it. */
  const closeTo = (back: RefObject<HTMLButtonElement | null>) => {
    flushSync(() => {
      setDoing(null);
      setError(null);
    });
    back.current?.focus();
  };
  /** Runs an action, asked as the vault asks: what it answered, or null (cancelled, or refused and said). */
  const run = async <T,>(fn: (t: string) => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await guarded(fn);
    } catch (err) {
      setError(describeError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitDay = async (e: FormEvent) => {
    e.preventDefault();
    const end = day ? endOf(day, props.timezone) : null;
    const problem = end ? guestEndProblem(new Date(end)) : 'Choose the day their access ends.';
    if (problem || !end) {
      setError(problem);
      return;
    }
    if (doing === 'renew') {
      const done = await run((t) => api.renewGuest(t, g.id, end));
      if (!done) return;
      // Back to the button that opened it, as the field goes.
      closeTo(dayButton);
      await props.onChanged(
        `${g.display_name}’s access now ends ${accessEndWords(done.access_expires_at, props.timezone)}.`,
        false,
      );
      return;
    }
    // Given back as a viewer's (a guest is nothing else), with its new end.
    const done = await run((t) => api.restoreSignIn(t, g.id, 'viewer', end));
    if (!done) return;
    flushSync(() => setDoing(null));
    await props.onChanged(
      `${g.display_name} can sign in again, until ${accessEndWords(end, props.timezone)}. What they can see is as it was.`,
    );
  };

  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    const done = await run((t) =>
      api.updateMember(
        t,
        g.id,
        { display_name: name.trim(), relationship: about.trim() || null },
        g.version ?? null,
      ),
    );
    if (!done) return;
    closeTo(editButton);
    await props.onChanged(`${done.display_name}’s details are saved.`, false);
  };

  /** Asked first, then done: signing out everywhere, or taking the sign-in away. */
  const confirmed = async (what: 'signOut' | 'takeAway') => {
    const done = await run(async (t) => {
      if (what === 'signOut') await api.signOutEverywhere(t, g.id);
      else await api.removeSignIn(t, g.id);
      return true;
    });
    if (done === null) return;
    flushSync(() => setDoing(null));
    await props.onChanged(
      what === 'signOut'
        ? `${g.display_name} is signed out everywhere. They can sign in again until their access ends.`
        : `${g.display_name}’s sign-in is taken away. What they can see stays, for if you give it back.`,
    );
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
        {signedIn
          ? guestEndLine(g.access_expires_at, props.timezone)
          : removed
            ? 'Their sign-in was taken away. You can give it back, with a new end.'
            : 'They never signed in: their invitation was cancelled, or ran out.'}
      </p>

      {dated ? (
        <form className="stack" onSubmit={(e) => void submitDay(e)}>
          <div ref={dayField}>
            <EndDay
              id={`ends-${g.id}`}
              label={`${g.display_name}’s access ends`}
              value={day}
              timezone={props.timezone}
              onChange={setDay}
            />
          </div>
          <ErrorNote message={error} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : doing === 'renew' ? 'Renew' : 'Give it back'}
            </Button>
            <Button kind="quiet" onClick={() => closeTo(dayButton)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : doing === 'edit' ? (
        <form className="stack" onSubmit={(e) => void saveDetails(e)}>
          <div ref={nameField}>
            <Field id={`name-${g.id}`} label="Their name" value={name} onChange={setName} />
          </div>
          <Field
            id={`about-${g.id}`}
            label="What they are to the family (optional)"
            value={about}
            required={false}
            onChange={setAbout}
            maxLength={GUEST_DESCRIPTION_MAX}
            hint="The activity log names them with it."
          />
          <ErrorNote message={error} />
          <div className="row">
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button kind="quiet" onClick={() => closeTo(editButton)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <ErrorNote message={doing === null ? error : null} />
          <div className="row guest-actions">
            {signedIn && (
              <Button
                ref={dayButton}
                kind="quiet"
                onClick={() => {
                  setDay(suggested());
                  setDoing('renew');
                }}
              >
                Renew their access
              </Button>
            )}
            {removed && (
              <Button
                ref={dayButton}
                kind="quiet"
                onClick={() => {
                  setDay(suggested());
                  setDoing('giveBack');
                }}
              >
                Give their sign-in back
              </Button>
            )}
            {signedIn && access === undefined && (
              <Button ref={limitsButton} kind="quiet" onClick={() => void openLimits()}>
                What they can see
              </Button>
            )}
            <Button
              ref={editButton}
              kind="quiet"
              onClick={() => {
                setName(g.display_name);
                setAbout(g.relationship ?? '');
                setDoing('edit');
              }}
            >
              Change their details
            </Button>
            {signedIn && caps?.features.sign_out_everywhere === true && (
              <Button ref={signOutButton} kind="quiet" onClick={() => setDoing('signOut')}>
                Sign them out everywhere
              </Button>
            )}
            {signedIn && (
              <Button ref={takeAwayButton} kind="quiet" danger onClick={() => setDoing('takeAway')}>
                Take their sign-in away
              </Button>
            )}
            {never && (
              <Button ref={removeButton} kind="quiet" danger onClick={() => setDoing('remove')}>
                Remove them
              </Button>
            )}
          </div>
        </>
      )}

      {access !== undefined && (
        <div className="stack">
          <ViewerLimits
            member={g}
            name={g.display_name}
            access={access}
            guest
            focusOnShow
            onChanged={(now, words) => {
              setAccess(now);
              void props.onChanged(words);
            }}
          />
          <Button
            kind="quiet"
            onClick={() => {
              flushSync(() => setAccess(undefined));
              limitsButton.current?.focus();
            }}
          >
            Close what they can see
          </Button>
        </div>
      )}

      {doing === 'signOut' && (
        <ConfirmDialog
          title={`Sign ${g.display_name} out everywhere?`}
          confirmLabel="Sign them out"
          busyLabel="Signing out…"
          busy={busy}
          returnFocus={signOutButton}
          onConfirm={() => void confirmed('signOut')}
          onCancel={() => setDoing(null)}
        >
          <p>{`Every device ${g.display_name} is signed in on is signed out now. They can sign in again with their own password until their access ends.`}</p>
          <ErrorNote message={error} />
        </ConfirmDialog>
      )}
      {doing === 'takeAway' && (
        <ConfirmDialog
          title={`Take ${g.display_name}’s sign-in away?`}
          confirmLabel="Take it away"
          busyLabel="Taking it away…"
          danger
          busy={busy}
          returnFocus={takeAwayButton}
          onConfirm={() => void confirmed('takeAway')}
          onCancel={() => setDoing(null)}
        >
          <p>{`${g.display_name} is signed out everywhere and cannot sign in. You can give it back later, with a new end.`}</p>
          <ErrorNote message={error} />
        </ConfirmDialog>
      )}
      {doing === 'remove' && (
        <RemoveGuest
          id={g.id}
          name={g.display_name}
          returnFocus={removeButton}
          onCancel={() => setDoing(null)}
          onDone={async (words) => {
            flushSync(() => setDoing(null));
            await props.onChanged(words);
          }}
        />
      )}
    </li>
  );
}
