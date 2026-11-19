import {
  SHARE_PASSWORD_MIN,
  SHOW_TITLE_LABEL,
  zonedParts,
  type ChangedShare,
  type ShareChangeInput,
} from '@fdv/shared';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { endWords, familyZoneNow } from '../family-time.js';
import {
  ChangeTrouble,
  changeTrouble,
  FormActions,
  FormCard,
  FormPage,
  PutRightFirst,
} from '../form-page.js';
import { Button, Check, ErrorNote } from '../ui.js';
import { linkTarget } from './LinkHandOver.js';
import {
  EndPicker,
  LinkCanDo,
  LinkOpensField,
  LinkWho,
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
 * Since 0.9.0-dev.69 (the owner's feedback of 18 Nov 2026) on a page of its
 * own, /sharing/links/{id}, laid out in cards as a request's change is, with
 * the same buttons in the same order and the same handling when the link
 * moved on meanwhile: from Sharing, a document's Share panel and a person's
 * emergency page alike (a clinician's link with `?person=` their id). It goes
 * back to the page it came from (`state.back`), saying what it did
 * (`state.said`). It was a dialog, which a long form doesn't fit.
 */

/** Where the page came from, when that is somewhere in the app: never another site. */
function backFrom(state: unknown): string | null {
  const back = (state as { back?: unknown } | null)?.back;
  return typeof back === 'string' && back.startsWith('/') && !back.startsWith('//') ? back : null;
}

/** What the link is to, as the page that opened it said it (a person's name), when it did. */
function targetFrom(state: unknown): string | null {
  const target = (state as { target?: unknown } | null)?.target;
  return typeof target === 'string' && target.trim() ? target : null;
}

export function ChangeLinkScreen() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  // A clinician's link (H4) is listed with its person's page, not Sharing's.
  const person = params.get('person');
  const location = useLocation();
  const { authVersion } = useApp();
  const [back] = useState(
    () =>
      backFrom(location.state) ?? (person ? `/people/${encodeURIComponent(person)}` : '/sharing'),
  );
  const [named] = useState(() => targetFrom(location.state));
  const { data, error, reload } = useLoad(
    async (t) => {
      const [items, profile] = await Promise.all([
        person
          ? api.emergencyLinks(t, person).then((r) => r.items as Share[])
          : api.shares(t).then((r) => r.items),
        api.profile(t).catch(() => null),
      ]);
      return {
        link: items.find((s) => s.id === id) ?? null,
        timezone: profile?.timezone ?? familyZoneNow(),
      };
    },
    [authVersion, id, person],
  );
  // Each Load it again starts the form afresh, from the link as it is now.
  const [round, setRound] = useState(0);
  if (!data) {
    return (
      <FormPage title="Change a link" back={back}>
        <ErrorNote message={error} />
      </FormPage>
    );
  }
  const link = data.link;
  if (!link || link.changeable !== true) {
    return (
      <FormPage title="Change a link" back={back}>
        <p className="lede">
          That link can’t be changed: it has ended, or it isn’t one you can change. Make a new one
          if you need to.
        </p>
        <Link to={back} className="btn btn-primary">
          Go back
        </Link>
      </FormPage>
    );
  }
  const emergency = link.document_id === null && link.collection_id == null;
  const target = emergency
    ? (named ?? 'this person’s emergency information')
    : linkTarget(link, true);
  return (
    <ChangeLinkForm
      key={round}
      link={link}
      target={target}
      timezone={data.timezone}
      back={back}
      onReload={async () => {
        await reload();
        setRound((n) => n + 1);
      }}
    />
  );
}

function ChangeLinkForm(props: {
  link: Share;
  /** What the link is to, in words: "“Mansoor’s passport”". */
  target: string;
  timezone: string;
  back: string;
  onReload: () => Promise<void>;
}) {
  const { link, timezone } = props;
  const { guarded, caps } = useApp();
  const navigate = useNavigate();
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
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<'conflict' | 'ended' | null>(null);
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

  const done = () =>
    void navigate(props.back, {
      replace: true,
      state: { said: `The link to ${props.target} is changed.` },
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (nothing || problem) return;
    setBusy(true);
    setError(null);
    setTrouble(null);
    try {
      const changed = await guarded((t) => api.changeShare(t, link.id, body, link.version));
      if (!changed) return;
      if (changed.pin || changed.password) setNewSecret(changed);
      else done();
    } catch (err) {
      const moved = changeTrouble(err);
      if (moved) setTrouble(moved);
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (newSecret) {
    return (
      <FormPage title="Change a link" back={props.back}>
        <NewSecret
          what="link"
          pin={newSecret.pin ?? null}
          password={newSecret.password ?? null}
          showAgain={newSecret.share.revealable === true}
          onDone={done}
        />
      </FormPage>
    );
  }

  return (
    <FormPage
      title="Change a link"
      back={props.back}
      lede={`The link to ${props.target}. It stays the same link, to the same ${link.collection_id ? 'documents' : emergency ? 'information' : 'document'}. Change what you like; anything that lets it do more asks you to confirm it’s you.`}
    >
      <form className="stack ask-form" onSubmit={(e) => void submit(e)} noValidate>
        <FormCard id="link-who" title="Who it is for">
          <LinkWho options={options} read={read} />
        </FormCard>

        <FormCard id="link-safe" title="Keeping it safe">
          <EndPicker
            idPrefix="share"
            timezone={timezone}
            read={{ ...read, endProblem }}
            onChange={(end) => options.set({ end })}
          />
          <LinkOpensField options={options} read={read} />
          <SecretChoice
            idPrefix="share"
            has={has}
            pin
            value={secret}
            onChange={setSecret}
            problem={passwordProblem}
            fixed={fixed}
            maker={link.mine !== false}
            showProblem={tried}
          />
          {caps?.features.sensitive_protects === true && !emergency && (
            <Check
              id="share-change-show-title"
              checked={showTitle}
              label={SHOW_TITLE_LABEL}
              onChange={setShowTitle}
            />
          )}
        </FormCard>

        <FormCard id="link-can" title="What they can do">
          <LinkCanDo
            options={options}
            viewable
            notViewable=""
            labelledBy="link-can-h"
            {...(emergency
              ? { canDo: 'They see the parts of the page you ticked. It is to view, always.' }
              : {})}
          />
        </FormCard>

        {trouble ? (
          <ChangeTrouble
            trouble={trouble}
            what="link"
            busy={busy}
            onReload={() => void props.onReload()}
          />
        ) : (
          <ErrorNote message={error} />
        )}
        <FormActions
          label="Save the changes"
          busyLabel="Saving…"
          busy={busy}
          disabled={nothing}
          cancelTo={props.back}
        />
        {nothing && <p className="muted">Nothing is changed yet.</p>}
        <PutRightFirst show={tried && problem !== null} />
      </form>
    </FormPage>
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
  const [copied, setCopied] = useState(false);
  const secret = props.pin ?? props.password ?? '';
  const what = props.pin ? 'PIN' : 'password';
  return (
    <div className="card stack">
      <h2 style={{ fontSize: 18 }}>The new {what}</h2>
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
      <Button onClick={props.onDone}>Done</Button>
    </div>
  );
}
