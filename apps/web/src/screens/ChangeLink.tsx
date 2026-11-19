import {
  SHARE_PASSWORD_MIN,
  SHOW_TITLE_LABEL,
  zonedParts,
  type ChangedShare,
  type ShareChangeInput,
} from '@fdv/shared';
import { useState, type ReactNode, type RefObject } from 'react';
import { api, type Share } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { endWords, familyZoneNow } from '../family-time.js';
import { Button, Check, Dialog, ErrorNote } from '../ui.js';
import {
  LinkOptions,
  readLinkOptions,
  SECRET_KEPT,
  SecretChoice,
  secretChoiceProblem,
  useLinkOptions,
  type SecretChoiceValue,
} from './Share.js';

/**
 * A link changed after it was made (0.9.0, LK; the owner's decision of 15
 * Nov 2026): the form it was made with, filled in as it is now — whom it is
 * for, when it stops, what they can do, how often it opens, its PIN or
 * password, whether its page shows the title. What it is to, and its code
 * or "this browser only", stay as they were made, and the form says so.
 *
 * Only what is changed is sent. Making it reach further — a later end, View
 * to View and download, more opens or none, its PIN or password taken away
 * or weakened, its title shown — asks to confirm it's you first (the vault
 * asks, the step-up sheet answers). A new PIN or made-up password is shown
 * here, once, as when a link is made, and can be shown again from Sharing.
 *
 * In the app's one dialog (0.9.0-dev.67), wide, from Sharing and from a
 * person's emergency page alike (`returnFocus` given); in a card in Share a
 * link's place on a document's page.
 */
export function ChangeLink(props: {
  link: Share;
  /** What the link is to, in words: "“Mansoor’s passport”". */
  target: string;
  /** Changed: what to say about it. */
  onDone: (said: string) => void;
  onCancel: () => void;
  /** A change is being saved: the panel it is in stays open. */
  onBusy?: (busy: boolean) => void;
  /** In a dialog over the page, the focus going back to this (the button that opened it) once it is closed. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const { link } = props;
  const { guarded, caps } = useApp();
  const timezone = familyZoneNow();
  // Its end as it is, on the family's clock: sent only if it is changed.
  const [startEnd] = useState(() => {
    const p = zonedParts(new Date(link.expires_at), timezone);
    return { date: p.date, time: p.time };
  });
  const options = useLinkOptions({
    label: link.recipient_label ?? '',
    end: startEnd,
    permission: link.permission ?? 'download',
    opens: link.max_opens != null ? String(link.max_opens) : '',
  });
  const asks = link.protection ?? (link.has_pin ? ['pin'] : []);
  const has = asks.includes('password') ? 'password' : asks.includes('pin') ? 'pin' : null;
  const [secret, setSecret] = useState<SecretChoiceValue>(SECRET_KEPT);
  // As its page shows it now: the vault says, a sensitive document's
  // title hidden unless it was chosen (H1a).
  const shownAtFirst = link.show_title === true;
  const [showTitle, setShowTitle] = useState(shownAtFirst);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<ChangedShare | null>(null);

  const now = new Date();
  const latest = link.latest_end ? new Date(link.latest_end) : null;
  // The longest is from when it was made (the vault holds it): no pick, nor
  // date, past it is offered.
  const maxDays = latest ? Math.max(0, (latest.getTime() - now.getTime()) / 864e5) : 0;
  const read = readLinkOptions(options.value, { timezone, maxDays, viewable: true, now });
  const endTouched =
    options.value.end !== null &&
    (options.value.end.date !== startEnd.date || options.value.end.time !== startEnd.time);
  const endProblem = !endTouched
    ? null
    : read.endProblem?.startsWith('A link can last') && latest
      ? `It can last until ${endWords(latest, timezone)} at the latest: as long as a link may from when it was made.`
      : read.endProblem;
  const passwordProblem = secretChoiceProblem(secret, SHARE_PASSWORD_MIN);
  const emergency = link.document_id === null && link.collection_id == null;

  // Only what is changed.
  const body: ShareChangeInput = {};
  const label = options.value.label.trim() || null;
  if (label !== link.recipient_label) body.recipient_label = label;
  if (endTouched && read.endAt) body.expires_at = read.endAt.toISOString();
  if (!emergency && options.value.permission !== (link.permission ?? 'download')) {
    body.permission = options.value.permission;
  }
  const typedOpens = options.value.opens.trim();
  const opens = typedOpens === '' ? null : Number(typedOpens);
  if (!read.opensProblem && opens !== (link.max_opens ?? null)) body.max_opens = opens;
  if (showTitle !== shownAtFirst) body.show_title = showTitle;
  if (secret.choice !== 'keep' && !(secret.choice === 'none' && has === null)) {
    body.secret = secret.choice;
    if (secret.choice === 'password' && secret.mode === 'typed') {
      body.password = secret.password.trim();
    }
  }
  const nothing = Object.keys(body).length === 0;
  const problem = endProblem ?? read.opensProblem ?? passwordProblem;

  // What else protects it, said where the form shows protection: each stays
  // as it was made (the owner's decision of 16 Nov 2026).
  const fixed = [
    ...((link.protection ?? []).includes('code')
      ? [
          `It ${link.second_factor === 'sms' ? 'texts' : 'emails'} a code to ${link.code_to ?? 'the one you chose'} when it is opened. To send the code somewhere else, take this link back and make a new one.`,
        ]
      : []),
    ...(link.this_device_only
      ? [
          'It opens only in the first browser that opened it. To let it open somewhere else, take this link back and make a new one.',
        ]
      : []),
  ];

  const save = async () => {
    if (nothing || problem) return;
    setBusy(true);
    props.onBusy?.(true);
    setError(null);
    try {
      const done = await guarded((t) => api.changeShare(t, link.id, body, link.version));
      if (!done) return;
      if (done.pin || done.password) setNewSecret(done);
      else props.onDone(`The link to ${props.target} is changed.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      props.onBusy?.(false);
    }
  };

  if (newSecret) {
    const changed = () => props.onDone(`The link to ${props.target} is changed.`);
    return (
      <Frame
        // Its own dialog, not the form's: the focus starts inside it again.
        key="new-secret"
        title={`The new ${newSecret.pin ? 'PIN' : 'password'}`}
        returnFocus={props.returnFocus}
        onClose={changed}
        closeLabel="Done"
        closePrimary
      >
        <NewSecretWords
          what="link"
          pin={newSecret.pin ?? null}
          password={newSecret.password ?? null}
          showAgain={newSecret.share.revealable === true}
        />
      </Frame>
    );
  }

  return (
    <Frame
      title={`Change the link to ${props.target}`}
      wide
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={props.onCancel}
      closeLabel="Cancel"
      actions={
        <Button disabled={busy || nothing || problem !== null} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save the changes'}
        </Button>
      }
    >
      <p className="muted">
        It stays the same link, to the same {link.collection_id ? 'documents' : 'document'}. Change
        what you like; anything that lets it do more asks you to confirm it’s you.
      </p>
      <ErrorNote message={error} />
      <LinkOptions
        options={options}
        read={{ ...read, endProblem }}
        timezone={timezone}
        viewable
        notViewable=""
        {...(emergency
          ? { canDo: 'They see the parts of the page you ticked. It is to view, always.' }
          : {})}
        protection={
          <SecretChoice
            idPrefix="share"
            has={has}
            pin
            value={secret}
            onChange={setSecret}
            problem={passwordProblem}
            fixed={fixed}
            maker={link.mine !== false}
          />
        }
      />
      {caps?.features.sensitive_protects === true && !emergency && (
        <Check
          id="share-change-show-title"
          checked={showTitle}
          label={SHOW_TITLE_LABEL}
          onChange={setShowTitle}
        />
      )}
      {nothing && <p className="muted">Nothing is changed yet.</p>}
    </Frame>
  );
}

/**
 * Where a change is drawn: the app's one dialog when it is over the page
 * (`returnFocus`), or a card in the panel's place, with the same title,
 * words and row of buttons.
 */
function Frame(props: {
  title: string;
  returnFocus?: RefObject<HTMLElement | null> | undefined;
  busy?: boolean;
  wide?: boolean;
  onClose: () => void;
  closeLabel: string;
  closePrimary?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (props.returnFocus) {
    return (
      <Dialog
        title={props.title}
        wide={props.wide === true}
        busy={props.busy === true}
        returnFocus={props.returnFocus}
        onClose={props.onClose}
        closeLabel={props.closeLabel}
        closePrimary={props.closePrimary === true}
        actions={props.actions}
      >
        {props.children}
      </Dialog>
    );
  }
  return (
    <div className="card stack">
      <h2 style={{ fontSize: 18 }}>{props.title}</h2>
      {props.children}
      <div className="row">
        {props.actions}
        <Button
          kind={props.closePrimary ? 'primary' : 'quiet'}
          disabled={props.busy === true}
          onClick={props.onClose}
        >
          {props.closeLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * A new PIN or made-up password, shown once here as when a link or a
 * request is made (0.9.0, LK), with Copy; it can be shown again later.
 */
export function NewSecret(props: {
  what: 'link' | 'request';
  pin: string | null;
  password: string | null;
  /** The vault keeps a copy, so Show the link shows it again; otherwise it is shown only now. */
  showAgain: boolean;
  onDone: () => void;
}) {
  return (
    <div className="card stack">
      <h2 style={{ fontSize: 18 }}>The new {props.pin ? 'PIN' : 'password'}</h2>
      <NewSecretWords {...props} />
      <Button onClick={props.onDone}>Done</Button>
    </div>
  );
}

/** What NewSecret says, under its title: in a card on a page, or in a dialog (ChangeLink). */
function NewSecretWords(props: {
  what: 'link' | 'request';
  pin: string | null;
  password: string | null;
  showAgain: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const secret = props.pin ?? props.password ?? '';
  const what = props.pin ? 'PIN' : 'password';
  return (
    <>
      <p className="muted">
        The {props.what} is changed. The old {what}, if it had one, no longer works.
      </p>
      <code
        style={{
          fontSize: props.pin ? 24 : 22,
          letterSpacing: props.pin ? 4 : 2,
          wordBreak: 'break-all',
        }}
      >
        {secret}
      </code>
      <Button
        kind="quiet"
        onClick={() =>
          void navigator.clipboard?.writeText(secret).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? 'Copied' : `Copy the ${what}`}
      </Button>
      <p className="muted">
        Tell them the new {what} some other way — a phone call, not the same message as the link.
        {props.showAgain
          ? ' You can see it again with Show the link.'
          : ' It is shown only now, so write it down.'}
      </p>
    </>
  );
}
